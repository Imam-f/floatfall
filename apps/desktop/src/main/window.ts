import { join } from "node:path"
import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, shell } from "electron"
import { Effect, Layer, Stream, SubscriptionRef } from "effect"
import { Channels, type Snapshot, type UiOptions, type WindowAction } from "../shared/ipc"
import { AppState } from "./services/AppState"
import { Bridge } from "./services/Bridge"
import { Controller } from "./services/Controller"
import { Settings } from "./services/Settings"
import { attachMicrophone } from "./microphone"
import { ModelSetup } from "./services/ModelSetup"
import type { ModelDownloadRequest, ModelId, SaveSettingsRequest, SettingsLink, SettingsResult } from "../shared/settings"

const createWindow = (mode: "main" | "microphone" | "settings" = "main") => {
  const microphone = mode === "microphone"
  const settings = mode === "settings"
  const win = new BrowserWindow({
    width: settings ? 700 : microphone ? 300 : 560,
    height: settings ? 740 : 380,
    minWidth: settings ? 360 : microphone ? 260 : 320,
    minHeight: settings ? 420 : microphone ? 340 : 220,
    frame: false,
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: settings,
    backgroundColor: "#0e1014",
    title: settings ? "floatfall · Settings" : microphone ? "floatfall · Singing note" : "floatfall",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The main renderer owns capture even when only the detached tuner is visible.
      backgroundThrottling: false
    }
  })
  // "floating" keeps it above normal windows (and above fullscreen-ish players on macOS).
  win.setAlwaysOnTop(true, "floating")
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.once("ready-to-show", () => win.showInactive())

  const devUrl = process.env["ELECTRON_RENDERER_URL"]
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  win.webContents.on("will-navigate", (event) => event.preventDefault())
  if (devUrl) void win.loadURL(mode === "main" ? devUrl : `${devUrl}#${mode}`)
  else void win.loadFile(join(__dirname, "../renderer/index.html"), mode === "main" ? {} : { hash: mode })
  return win
}

/**
 * Owns the floating window: creates it, forwards state streams to the
 * renderer and turns IPC messages into (forked) effects. IPC handlers stay
 * trivial - they never await or compute anything themselves.
 */
export const WindowLayer = Layer.effectDiscard(
  Effect.gen(function*() {
    const appState = yield* AppState
    const controller = yield* Controller
    const bridge = yield* Bridge
    const settings = yield* Settings
    const models = yield* ModelSetup
    const context = yield* Effect.context<never>()
    const fork = Effect.runForkWith(context)

    const win = yield* Effect.acquireRelease(
      Effect.sync(() => createWindow()),
      (w) => Effect.sync(() => !w.isDestroyed() && w.destroy())
    )

    yield* Effect.acquireRelease(
      Effect.sync(() => attachMicrophone(win, () => createWindow("microphone"))),
      (dispose) => Effect.sync(dispose)
    )

    let settingsWin: BrowserWindow | null = null
    const openSettings = () => {
      if (settingsWin && !settingsWin.isDestroyed()) {
        if (settingsWin.isMinimized()) settingsWin.restore()
        settingsWin.show()
        settingsWin.focus()
        return
      }
      settingsWin = createWindow("settings")
      settingsWin.once("closed", () => { settingsWin = null })
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => { settingsWin?.destroy(); settingsWin = null }))
    const sendSettings = (channel: string, payload?: unknown) => Effect.sync(() => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload)
    })
    yield* models.downloads.pipe(Stream.runForEach((value) => sendSettings(Channels.modelDownloads, value)), Effect.forkScoped)
    yield* settings.changes.pipe(Stream.runForEach(() => sendSettings(Channels.settingsChanged)), Effect.forkScoped)

    const send = (channel: string, payload: unknown) =>
      Effect.sync(() => {
        if (!win.isDestroyed()) win.webContents.send(channel, payload)
      })

    yield* SubscriptionRef.changes(appState.state).pipe(
      Stream.runForEach((s) => send(Channels.state, s)),
      Effect.forkScoped
    )
    yield* SubscriptionRef.changes(appState.notes).pipe(
      Stream.runForEach((n) => send(Channels.notes, n)),
      Effect.forkScoped
    )
    yield* appState.playbackStream.pipe(
      Stream.runForEach((p) => send(Channels.playback, p)),
      Effect.forkScoped
    )

    const snapshot = Effect.gen(function*() {
      return {
        state: yield* SubscriptionRef.get(appState.state),
        notes: yield* SubscriptionRef.get(appState.notes),
        playback: yield* appState.lastPlayback
      } satisfies Snapshot
    })

    const onWindow = (event: IpcMainEvent, action: WindowAction) => {
      const target = event.sender === settingsWin?.webContents ? settingsWin : event.sender === win.webContents ? win : null
      if (!target) return
      if (action === "close") target.close()
      else if (action === "minimize") target.minimize()
      else {
        if (target !== win || action !== "togglePin") return
        const pinned = !win.isAlwaysOnTop()
        win.setAlwaysOnTop(pinned, "floating")
        fork(appState.update((s) => ({ ...s, options: { ...s.options, pinned } })))
      }
    }
    const handlers: Record<string, (event: IpcMainEvent, ...args: Array<any>) => void> = {
      [Channels.setOptions]: (_, options: Partial<UiOptions>) => fork(controller.setOptions(options)),
      [Channels.transcribe]: () => fork(controller.transcribeNow),
      [Channels.cancel]: () => fork(controller.cancel),
      [Channels.seek]: (_, time: number) =>
        fork(
          SubscriptionRef.get(appState.state).pipe(
            Effect.flatMap((s) => (s.video ? bridge.seek(s.video.videoId, time) : Effect.void))
          )
        ),
      [Channels.openSettings]: openSettings,
      [Channels.openCache]: () =>
        fork(settings.cacheDir.pipe(Effect.flatMap((dir) => Effect.promise(() => shell.openPath(dir))))),
      [Channels.window]: onWindow
    }

    const result = (effect: Effect.Effect<void, unknown>) => Effect.runPromiseWith(context)(effect.pipe(
      Effect.as({ ok: true } as SettingsResult),
      Effect.catch((error) => {
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
        return Effect.succeed({ ok: false, error: cause instanceof Error ? cause.message : String(cause) } as SettingsResult)
      })
    ))
    const links: Record<SettingsLink, string> = {
      small: "https://huggingface.co/MuScriptor/muscriptor-small",
      medium: "https://huggingface.co/MuScriptor/muscriptor-medium",
      large: "https://huggingface.co/MuScriptor/muscriptor-large",
      "bs-roformer": "https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models",
      "hf-tokens": "https://huggingface.co/settings/tokens",
      uv: "https://docs.astral.sh/uv/getting-started/installation/"
    }
    const invokes: Record<string, (event: IpcMainInvokeEvent, ...args: any[]) => unknown> = {
      [Channels.settingsSnapshot]: () => Effect.runPromiseWith(context)(models.snapshot),
      [Channels.saveSettings]: (_, request: SaveSettingsRequest) => result(models.save(request)),
      [Channels.downloadModel]: (_, request: ModelDownloadRequest) => result(models.download(request)),
      [Channels.cancelModelDownload]: (_, id: ModelId) => result(models.cancel(id)),
      [Channels.settingsLink]: (_, link: SettingsLink) => result(Effect.tryPromise(async () => {
        if (!Object.hasOwn(links, link)) throw new Error("Unknown settings link.")
        await shell.openExternal(links[link])
      })),
      [Channels.openSettingsFile]: () => result(Effect.tryPromise(async () => {
        const error = await shell.openPath(settings.file)
        if (error) throw new Error(error)
      }))
    }

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        ipcMain.handle(Channels.snapshot, () => Effect.runPromiseWith(context)(snapshot))
        for (const [channel, handler] of Object.entries(invokes)) ipcMain.handle(channel, (event, ...args) => {
          if (event.sender !== settingsWin?.webContents && event.sender !== win.webContents) throw new Error("Unknown settings window.")
          return handler(event, ...args)
        })
        for (const [channel, handler] of Object.entries(handlers)) ipcMain.on(channel, handler)
      }),
      () =>
        Effect.sync(() => {
          ipcMain.removeHandler(Channels.snapshot)
          for (const channel of Object.keys(invokes)) ipcMain.removeHandler(channel)
          for (const [channel, handler] of Object.entries(handlers)) ipcMain.removeListener(channel, handler)
        })
    )

    // Keep the layer alive until the window is closed by the user.
    yield* Effect.callback<void>((resume) => {
      win.once("closed", () => resume(Effect.void))
    }).pipe(
      Effect.andThen(Effect.sync(() => process.nextTick(() => app.quit()))),
      Effect.forkScoped
    )
  })
)

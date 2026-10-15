import { join } from "node:path"
import { app, BrowserWindow, ipcMain, type IpcMainEvent, shell } from "electron"
import { Effect, Layer, Stream, SubscriptionRef } from "effect"
import { Channels, type Snapshot, type UiOptions, type WindowAction } from "../shared/ipc"
import { AppState } from "./services/AppState"
import { Bridge } from "./services/Bridge"
import { Controller } from "./services/Controller"
import { Settings } from "./services/Settings"

const createWindow = () => {
  const win = new BrowserWindow({
    width: 560,
    height: 280,
    minWidth: 320,
    minHeight: 160,
    frame: false,
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: false,
    backgroundColor: "#0e1014",
    title: "floatfall",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  // "floating" keeps it above normal windows (and above fullscreen-ish players on macOS).
  win.setAlwaysOnTop(true, "floating")
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.once("ready-to-show", () => win.showInactive())

  const devUrl = process.env["ELECTRON_RENDERER_URL"]
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, "../renderer/index.html"))
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
    const context = yield* Effect.context<never>()
    const fork = Effect.runForkWith(context)

    const win = yield* Effect.acquireRelease(
      Effect.sync(createWindow),
      (w) => Effect.sync(() => !w.isDestroyed() && w.destroy())
    )

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

    const onWindow = (_: IpcMainEvent, action: WindowAction) => {
      if (action === "close") win.close()
      else if (action === "minimize") win.minimize()
      else {
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
      [Channels.openSettings]: () => void shell.openPath(settings.file),
      [Channels.openCache]: () =>
        fork(settings.cacheDir.pipe(Effect.flatMap((dir) => Effect.promise(() => shell.openPath(dir))))),
      [Channels.window]: onWindow
    }

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        ipcMain.handle(Channels.snapshot, () => Effect.runPromiseWith(context)(snapshot))
        for (const [channel, handler] of Object.entries(handlers)) ipcMain.on(channel, handler)
      }),
      () =>
        Effect.sync(() => {
          ipcMain.removeHandler(Channels.snapshot)
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

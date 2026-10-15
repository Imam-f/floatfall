import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from "electron"
import { Channels } from "../shared/ipc"
import {
  appendPitchHistory, initialMicrophoneState, SPECTRUM_BINS, type MicrophoneOptions, type MicrophoneReport,
  type MicrophoneSnapshot, type MicrophoneState, type PitchFrame
} from "../shared/microphone"

/** One capture owner (the main renderer), with an optional independent display. */
export const attachMicrophone = (main: BrowserWindow, createFloating: () => BrowserWindow): (() => void) => {
  let state: MicrophoneState = { ...initialMicrophoneState }
  let pitch: PitchFrame | null = null
  let history: ReadonlyArray<PitchFrame> = []
  let floating: BrowserWindow | null = null
  const session = main.webContents.session
  const trusted = (event: Pick<IpcMainEvent, "sender">) =>
    event.sender === main.webContents || (!!floating && !floating.isDestroyed() && event.sender === floating.webContents)
  const send = (channel: string, payload: unknown) => {
    for (const win of [main, floating]) {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }
  const closeFloating = () => {
    const win = floating
    floating = null // Programmatic docking does not stop capture.
    if (win && !win.isDestroyed()) win.destroy()
  }
  const publish = () => {
    if (state.enabled && state.mode === "floating" && !floating) {
      const win = createFloating()
      floating = win
      const parent = main.getBounds()
      const area = screen.getDisplayMatching(parent).workArea
      win.setPosition(
        Math.round(Math.max(area.x, Math.min(parent.x + parent.width + 12, area.x + area.width - 300))),
        Math.round(Math.max(area.y, Math.min(parent.y, area.y + area.height - 380)))
      )
      win.on("closed", () => {
        if (floating !== win) return
        floating = null
        update({ enabled: false })
      })
    } else if (!state.enabled || state.mode !== "floating") closeFloating()
    send(Channels.microphoneState, state)
    send(Channels.pitch, pitch)
  }
  const update = (options: MicrophoneOptions) => {
    const enabled = typeof options.enabled === "boolean" ? options.enabled : state.enabled
    const deviceId = typeof options.deviceId === "string" && options.deviceId.length < 2048
      ? options.deviceId : state.deviceId
    const restart = options.enabled !== undefined || deviceId !== state.deviceId
    state = {
      ...state, enabled, deviceId,
      mode: options.mode === "overlay" || options.mode === "floating" ? options.mode : state.mode,
      octaveUp: typeof options.octaveUp === "boolean" ? options.octaveUp : state.octaveUp,
      spectrum: typeof options.spectrum === "boolean" ? options.spectrum : state.spectrum,
      ...(restart ? {
        captureId: state.captureId + 1, status: enabled ? "requesting" as const : "off" as const, error: null
      } : {})
    }
    if (restart) { pitch = null; history = [] }
    publish()
  }

  // Only the capture owner may request audio, and only while the user enabled it.
  session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    contents === main.webContents && state.enabled && permission === "media" && details.mediaType === "audio"
  )
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : []
    callback(contents === main.webContents && state.enabled && permission === "media" &&
      !!mediaTypes?.length && mediaTypes.every((type) => type === "audio"))
  })

  const onOptions = (event: IpcMainEvent, options: MicrophoneOptions) => {
    if (trusted(event) && options && typeof options === "object") update(options)
  }
  const onReport = (event: IpcMainEvent, report: MicrophoneReport) => {
    if (event.sender !== main.webContents || !report || !state.enabled || report.captureId !== state.captureId) return
    if (!["requesting", "listening", "error"].includes(report.status)) return
    state = {
      ...state, status: report.status,
      error: typeof report.error === "string" ? report.error.slice(0, 500) : null,
      devices: Array.isArray(report.devices) ? report.devices.filter((d) =>
        d && typeof d.deviceId === "string" && typeof d.label === "string"
      ).slice(0, 64) : state.devices
    }
    if (report.status !== "listening") pitch = null
    send(Channels.microphoneState, state)
    if (!pitch) send(Channels.pitch, null)
  }
  const onPitch = (event: IpcMainEvent, captureId: number, frame: PitchFrame | null) => {
    if (event.sender !== main.webContents || !state.enabled || state.status !== "listening" || captureId !== state.captureId) return
    if (frame && (!(frame.frequency === null || (Number.isFinite(frame.frequency) && frame.frequency >= 50 && frame.frequency <= 2000)) ||
      !Number.isFinite(frame.level) || !Number.isFinite(frame.clarity))) return
    if (frame?.spectrum !== undefined && (!Array.isArray(frame.spectrum) || frame.spectrum.length !== SPECTRUM_BINS ||
      !frame.spectrum.every((value) => Number.isInteger(value) && value >= 0 && value <= 255))) return
    pitch = frame ? { ...frame, level: Math.max(0, Math.min(1, frame.level)), at: Date.now() } : null
    if (pitch) history = appendPitchHistory(history, pitch)
    send(Channels.pitch, pitch)
  }
  const onReload = () => update({ enabled: false })
  const onCrash = () => update({ enabled: false })
  ipcMain.handle(Channels.microphoneSnapshot, (event): MicrophoneSnapshot => {
    if (!trusted(event)) throw new Error("Unknown microphone window")
    return { state, pitch, history }
  })
  ipcMain.on(Channels.microphoneOptions, onOptions)
  ipcMain.on(Channels.microphoneReport, onReport)
  ipcMain.on(Channels.reportPitch, onPitch)
  main.webContents.on("did-start-loading", onReload)
  main.webContents.on("render-process-gone", onCrash)
  return () => {
    closeFloating()
    session.setPermissionCheckHandler(null)
    session.setPermissionRequestHandler(null)
    ipcMain.removeHandler(Channels.microphoneSnapshot)
    ipcMain.removeListener(Channels.microphoneOptions, onOptions)
    ipcMain.removeListener(Channels.microphoneReport, onReport)
    ipcMain.removeListener(Channels.reportPitch, onPitch)
    main.webContents.removeListener("did-start-loading", onReload)
    main.webContents.removeListener("render-process-gone", onCrash)
  }
}

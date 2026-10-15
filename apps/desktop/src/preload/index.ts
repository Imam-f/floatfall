import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import { Channels, type FloatfallApi } from "../shared/ipc"

const subscribe = <T>(channel: string, listener: (payload: T) => void) => {
  const wrapped = (_: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api: FloatfallApi = {
  getSnapshot: () => ipcRenderer.invoke(Channels.snapshot),
  onState: (listener) => subscribe(Channels.state, listener),
  onNotes: (listener) => subscribe(Channels.notes, listener),
  onPlayback: (listener) => subscribe(Channels.playback, listener),
  setOptions: (options) => ipcRenderer.send(Channels.setOptions, options),
  transcribe: () => ipcRenderer.send(Channels.transcribe),
  cancel: () => ipcRenderer.send(Channels.cancel),
  seek: (time) => ipcRenderer.send(Channels.seek, time),
  openSettings: () => ipcRenderer.send(Channels.openSettings),
  openCache: () => ipcRenderer.send(Channels.openCache),
  window: (action) => ipcRenderer.send(Channels.window, action),
  getMicrophoneSnapshot: () => ipcRenderer.invoke(Channels.microphoneSnapshot),
  onMicrophoneState: (listener) => subscribe(Channels.microphoneState, listener),
  onPitch: (listener) => subscribe(Channels.pitch, listener),
  setMicrophoneOptions: (options) => ipcRenderer.send(Channels.microphoneOptions, options),
  reportMicrophone: (report) => ipcRenderer.send(Channels.microphoneReport, report),
  reportPitch: (captureId, frame) => ipcRenderer.send(Channels.reportPitch, captureId, frame)
}

contextBridge.exposeInMainWorld("floatfall", api)

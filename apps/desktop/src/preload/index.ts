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
  window: (action) => ipcRenderer.send(Channels.window, action)
}

contextBridge.exposeInMainWorld("floatfall", api)

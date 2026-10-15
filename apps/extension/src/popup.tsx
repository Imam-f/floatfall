import { BRIDGE_URL } from "@floatfall/protocol/lite"
import { StrictMode, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { type BridgeStatus, initialStatus, STATUS_KEY } from "./status"

// External store over chrome.storage.session; the storage listener only swaps
// a reference and notifies React.
let status: BridgeStatus = initialStatus
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

void chrome.storage.session.get(STATUS_KEY).then((items) => {
  const value = items[STATUS_KEY] as BridgeStatus | undefined
  if (value) {
    status = value
    notify()
  }
})
chrome.storage.session.onChanged.addListener((changes) => {
  const change = changes[STATUS_KEY]
  if (change?.newValue) {
    status = change.newValue as BridgeStatus
    notify()
  }
})

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const getStatus = () => status

const Popup = () => {
  const { connected, video, lastError } = useSyncExternalStore(subscribe, getStatus)
  return (
    <div className="popup">
      <div className="row">
        <span className={`dot${connected ? " ok" : ""}`} />
        <strong>{connected ? "Connected to floatfall" : "Desktop app not running"}</strong>
      </div>
      {!connected && <p className="muted">{lastError ?? `Waiting for ${BRIDGE_URL}`}</p>}
      <div className="label">Following</div>
      <div className="video">{video ? video.title : <span className="muted">No YouTube video tab</span>}</div>
      {video && <div className="muted mono">{video.videoId}</div>}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Popup />
  </StrictMode>
)

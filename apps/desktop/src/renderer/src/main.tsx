import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"

// Settings has no playback or microphone subscriptions. Load only the page
// belonging to this window so it never initializes another window's stores.
const Page = window.location.hash === "#settings"
  ? lazy(() => import("./Settings").then((module) => ({ default: module.SettingsApp })))
  : lazy(() => import("./App").then((module) => ({ default: window.location.hash === "#microphone" ? module.MicrophoneApp : module.App })))

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}><Page /></Suspense>
  </StrictMode>
)

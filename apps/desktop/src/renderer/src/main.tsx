import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App, MicrophoneApp } from "./App"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.hash === "#microphone" ? <MicrophoneApp /> : <App />}
  </StrictMode>
)

import { memo } from "react"
import type { UiState } from "../../shared/ipc"
import { PianoRoll } from "./pianoRoll/PianoRoll"
import { useNotes, useUiState } from "./store"
import { TitleBar } from "./TitleBar"
import { MicrophoneOverlay, MicrophonePanel } from "./microphone/MicrophonePanel"
import { useMicrophone } from "./microphone/useMicrophone"

const emptyMessage = (state: UiState): string | null => {
  if (!state.extensionConnected && !state.video) {
    return "Install the floatfall Chrome extension and open a YouTube video."
  }
  if (!state.video) return "Open a YouTube video (7 minutes or shorter) in Chrome."
  switch (state.job.stage) {
    case "error":
      return state.job.message
    case "done":
      return "No notes were detected."
    case "idle":
      if (!state.transcriberConfigured) {
        return "Choose a transcription model in Settings → Models."
      }
      return state.options.autoTranscribe ? null : "Press play in the title bar to transcribe this video."
    default:
      return state.job.message
  }
}

const Overlay = memo(function Overlay({ message, error }: { readonly message: string; readonly error: boolean }) {
  return <div className={`overlay${error ? " error" : ""}`}>{message}</div>
})

export const App = () => {
  useMicrophone()
  const state = useUiState()
  const { notes, videoId } = useNotes()
  const visibleNotes = videoId === state.video?.videoId ? notes : EMPTY
  const message = visibleNotes.length === 0 ? emptyMessage(state) : null

  return (
    <div className="app">
      <TitleBar state={state} />
      <main className="stage-area">
        <PianoRoll notes={visibleNotes} />
        {message && <Overlay message={message} error={state.job.stage === "error"} />}
        <MicrophoneOverlay />
      </main>
    </div>
  )
}

export const MicrophoneApp = () => <div className="microphone-app"><MicrophonePanel floating /></div>

const EMPTY: ReadonlyArray<never> = []

import { memo, type ReactNode } from "react"
import type { JobStatus, UiState } from "../../shared/ipc"
import { api } from "./store"
import { MicrophoneToggle } from "./microphone/MicrophonePanel"

const STAGE_LABEL: Record<JobStatus["stage"], string> = {
  idle: "Idle",
  queued: "Queued",
  downloading: "Downloading",
  extracting: "Extracting",
  separating: "Cleaning vocals",
  transcribing: "Transcribing",
  done: "Ready",
  error: "Error"
}

const isBusy = (stage: JobStatus["stage"]) =>
  stage === "queued" || stage === "downloading" || stage === "extracting" || stage === "separating" ||
  stage === "transcribing"

// Handlers are module-level: they only forward a tiny message to the main
// process (which does the real work) so they never need re-creation.
const close = () => api.window("close")
const minimize = () => api.window("minimize")
const togglePin = () => api.window("togglePin")
const transcribe = () => api.transcribe()
const cancel = () => api.cancel()
const openSettings = () => api.openSettings()
const openCache = () => api.openCache()

const Icon = ({ d }: { readonly d: string }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const IconButton = ({
  title,
  onClick,
  active,
  disabled,
  children
}: {
  readonly title: string
  readonly onClick: () => void
  readonly active?: boolean
  readonly disabled?: boolean
  readonly children: ReactNode
}) => (
  <button
    type="button"
    className={`icon-btn${active ? " active" : ""}`}
    title={title}
    aria-label={title}
    onClick={onClick}
    disabled={disabled}
  >
    {children}
  </button>
)

const Toggle = ({
  label,
  title,
  checked,
  warn,
  onChange
}: {
  readonly label: string
  readonly title: string
  readonly checked: boolean
  readonly warn?: boolean
  readonly onChange: (checked: boolean) => void
}) => (
  <label className={`toggle${checked ? " on" : ""}${warn ? " warn" : ""}`} title={title}>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
    {label}
  </label>
)

const setCleanVocals = (cleanVocals: boolean) => api.setOptions({ cleanVocals })
const setAuto = (autoTranscribe: boolean) => api.setOptions({ autoTranscribe })

export const TitleBar = memo(function TitleBar({ state }: { readonly state: UiState }) {
  const { job, video, options } = state
  const busy = isBusy(job.stage)
  const title = video?.title || (state.extensionConnected ? "Open a YouTube video" : "Waiting for browser extension…")
  const cached = state.processing.cache ? Object.entries(state.processing.cache).filter(([, available]) => available).map(([stage]) => stage) : []

  return (
    <header className="titlebar">
      <span
        className={`dot${state.extensionConnected ? " ok" : ""}`}
        title={state.extensionConnected ? "Extension connected" : "Extension not connected"}
      />
      <span className="title" title={video?.title}>{title}</span>
      {video && (
        <span className={`stage stage-${job.stage}`} title={job.message ?? undefined}>
          {STAGE_LABEL[job.stage]}
          {busy && job.progress !== null ? ` ${Math.round(job.progress * 100)}%` : ""}
        </span>
      )}
      <div className="spacer" />
      <div className="controls">
        {(state.processing.target === "remote" || state.processing.worker !== "off") && (
          <span className={`processing-badge${state.processing.worker === "error" ? " error" : ""}`}
            title={[state.processing.target === "remote" ? `Remote processing${cached.length ? ` · cached: ${cached.join(", ")}` : ""}` : "Local processing",
              state.processing.workerMessage].filter(Boolean).join("\n")}>
            {state.processing.target === "remote" ? "Remote" : state.processing.worker === "error" ? "Worker error" : "Worker"}
          </span>
        )}
        <MicrophoneToggle />
        <Toggle
          label="Clean vocals"
          title={state.separatorConfigured
            ? "Run vocal separation before transcription"
            : "Choose a vocal separator in Settings → Models"}
          checked={options.cleanVocals}
          warn={options.cleanVocals && !state.separatorConfigured}
          onChange={setCleanVocals}
        />
        <Toggle
          label="Auto"
          title="Automatically transcribe the active YouTube video"
          checked={options.autoTranscribe}
          onChange={setAuto}
        />
        {busy
          ? (
            <IconButton title="Cancel" onClick={cancel}>
              <Icon d="M4 4l8 8M12 4l-8 8" />
            </IconButton>
          )
          : (
            <IconButton
              title={job.stage === "error" ? "Retry" : "Transcribe"}
              onClick={transcribe}
              disabled={!video}
            >
              {job.stage === "error" ? <Icon d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3" /> : <Icon d="M5 3l8 5-8 5z" />}
            </IconButton>
          )}
        <IconButton title="Settings" onClick={openSettings}>
          <Icon d="M2 4h8M12 4h2M2 12h2M6 12h8M10 2v4M4 10v4" />
        </IconButton>
        <IconButton title="Open cache folder" onClick={openCache}>
          <Icon d="M2 4.5h4l1.5 1.5H14v6.5H2z" />
        </IconButton>
        <IconButton title={options.pinned ? "Unpin (always on top)" : "Pin on top"} onClick={togglePin} active={options.pinned}>
          <Icon d="M6 2h4l-.5 4 2.5 2H4l2.5-2zM8 8v6" />
        </IconButton>
        <IconButton title="Minimize" onClick={minimize}>
          <Icon d="M3 8h10" />
        </IconButton>
        <IconButton title="Close" onClick={close}>
          <Icon d="M4 4l8 8M12 4l-8 8" />
        </IconButton>
      </div>
      {busy && (
        <div
          className={`progress${job.progress === null ? " indeterminate" : ""}`}
          style={job.progress === null ? undefined : { width: `${job.progress * 100}%` }}
        />
      )}
    </header>
  )
})

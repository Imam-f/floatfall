import { memo } from "react"
import { noteFromFrequency } from "./pitch"
import { useMicrophoneState, usePitch } from "./store"
import { PitchHistory } from "./PitchHistory"

const api = window.floatfall
const stop = () => api.setMicrophoneOptions({ enabled: false })
const retry = () => api.setMicrophoneOptions({ enabled: true })

export const MicrophoneToggle = memo(function MicrophoneToggle() {
  const state = useMicrophoneState()
  const label = state.enabled ? "Turn off singing microphone" : "Show singing note · Turn on microphone"
  return (
    <button type="button" className={`icon-btn mic-toggle${state.enabled ? " active" : ""}`}
      title={label} aria-label={label} aria-pressed={state.enabled}
      onClick={() => api.setMicrophoneOptions({ enabled: !state.enabled })}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
        <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5" />
      </svg>
    </button>
  )
})

const PitchReadout = memo(function PitchReadout({ listening, octaveUp }: { readonly listening: boolean; readonly octaveUp: boolean }) {
  const frame = usePitch()
  const frequency = frame?.frequency ? frame.frequency * (octaveUp ? 2 : 1) : null
  const note = listening ? noteFromFrequency(frequency) : null
  const inTune = note !== null && Math.abs(note.cents) <= 10
  const level = frame && listening ? Math.max(0, Math.min(100, (20 * Math.log10(Math.max(0.001, frame.level)) + 60) / 60 * 100)) : 0
  return (
    <>
      <div className={`voice-readout${inTune ? " in-tune" : ""}`}>
        <div className="voice-note" aria-live="polite" aria-label={note ? `Current note ${note.name}${note.octave}` : "No singing note detected"}>
          {note ? <>{note.name}<span className="voice-octave">{note.octave}</span></> : "—"}
        </div>
        <div className="voice-frequency">{note && frequency ? `${frequency.toFixed(1)} Hz` : "Sing a steady note"}</div>
      </div>
      <div className="voice-tuning">
        <div className="voice-tuning-labels"><span>♭ flat</span><strong>{note ? `${note.cents > 0 ? "+" : ""}${note.cents} cents` : "cents"}</strong><span>sharp ♯</span></div>
        <div className="voice-gauge" role="meter" aria-label="Tuning offset in cents"
          aria-valuemin={-50} aria-valuemax={50} aria-valuenow={note?.cents}>
          <div className="voice-tune-zone" />
          <div className="voice-center" />
          {note && <div className={`voice-needle${inTune ? " in-tune" : ""}`} style={{ left: `${note.cents + 50}%` }} />}
        </div>
      </div>
      <div className="voice-input-level" aria-label={`Microphone level ${Math.round(level)} percent`}>
        <span style={{ width: `${level}%` }} />
      </div>
    </>
  )
})

export const MicrophonePanel = memo(function MicrophonePanel({ floating = false }: { readonly floating?: boolean }) {
  const state = useMicrophoneState()
  const status = state.status === "listening" ? "Listening" : state.status === "requesting" ? "Starting mic…" : state.status === "error" ? "Check microphone" : "Microphone off"
  return (
    <section className={`voice-panel${floating ? " voice-floating" : " voice-overlay"}`} aria-label="Live singing note">
      <header className="voice-titlebar">
        <span className={`voice-status-dot ${state.status}`} />
        <span className="voice-title">Singing note</span>
        <button type="button" className="voice-mode-btn" title={floating ? "Dock singing note over the piano roll" : "Move singing note to its own floating window"}
          onClick={() => api.setMicrophoneOptions({ mode: floating ? "overlay" : "floating" })}>
          {floating ? "Dock ↙" : "Pop out ↗"}
        </button>
        <button type="button" className="icon-btn" onClick={stop} title="Turn off microphone" aria-label="Turn off microphone">×</button>
      </header>
      <div className="voice-body">
        <div className={`voice-status-text${state.status === "error" ? " error" : ""}`}>{status}</div>
        {state.status === "error" ? (
          <div className="voice-error" role="alert"><p>{state.error}</p><button type="button" onClick={retry}>Retry microphone</button></div>
        ) : <>
          <PitchReadout listening={state.status === "listening"} octaveUp={state.octaveUp} />
          <div className="voice-history-heading">
            <span>Recent pitch <small>12 s</small></span>
            <button type="button" className={`voice-octave-btn${state.octaveUp ? " active" : ""}`}
              aria-pressed={state.octaveUp} title="Shift the displayed voice and history up one octave"
              onClick={() => api.setMicrophoneOptions({ octaveUp: !state.octaveUp })}>+1 octave</button>
          </div>
          <PitchHistory octaveUp={state.octaveUp} />
        </>}
        <label className="voice-device-label">
          <span className="sr-only">Microphone input</span>
          <select aria-label="Microphone input" value={state.deviceId} disabled={state.status === "requesting"}
            onChange={(event) => api.setMicrophoneOptions({ deviceId: event.currentTarget.value })}>
            <option value="default">System default microphone</option>
            {state.devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
            {state.deviceId !== "default" && !state.devices.some((d) => d.deviceId === state.deviceId) && <option value={state.deviceId}>Selected microphone (unavailable)</option>}
          </select>
        </label>
        <div className="voice-reference">Local input <span>·</span> A4 = 440 Hz</div>
      </div>
    </section>
  )
})

export const MicrophoneOverlay = () => {
  const state = useMicrophoneState()
  return state.enabled && state.mode === "overlay" ? <MicrophonePanel /> : null
}

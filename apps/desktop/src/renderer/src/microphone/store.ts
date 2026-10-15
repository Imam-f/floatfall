import { useSyncExternalStore } from "react"
import { appendPitchHistory, initialMicrophoneState, type MicrophoneState, type PitchFrame } from "../../../shared/microphone"

const api = window.floatfall
let state: MicrophoneState = initialMicrophoneState
let pitch: PitchFrame | null = null
let history: ReadonlyArray<PitchFrame> = []
const stateListeners = new Set<() => void>()
const pitchListeners = new Set<() => void>()
let receivedState = false
let receivedPitch = false
const notify = (listeners: Set<() => void>) => { for (const listener of listeners) listener() }

api.onMicrophoneState((next) => {
  receivedState = true
  if (next.captureId !== state.captureId || !next.enabled) {
    pitch = null
    history = []
    notify(pitchListeners)
  }
  state = next
  notify(stateListeners)
})
api.onPitch((next) => {
  receivedPitch = true
  pitch = next
  if (next) history = appendPitchHistory(history, next)
  notify(pitchListeners)
})
void api.getMicrophoneSnapshot().then((snapshot) => {
  if (!receivedState) { state = snapshot.state; notify(stateListeners) }
  if (!receivedPitch) { pitch = snapshot.pitch; notify(pitchListeners) }
  // Keep past notes even if a live frame beat the new window's snapshot.
  if (snapshot.state.captureId === state.captureId) {
    const merged = new Map([...snapshot.history, ...history].map((frame) => [frame.at, frame]))
    history = [...merged.values()].sort((a, b) => a.at - b.at).slice(-240)
    notify(pitchListeners)
  }
})

export const subscribeMicrophone = (listener: () => void) => {
  stateListeners.add(listener)
  return () => { stateListeners.delete(listener) }
}
export const subscribePitch = (listener: () => void) => {
  pitchListeners.add(listener)
  return () => { pitchListeners.delete(listener) }
}
const getState = () => state
export const readMicrophoneState = getState
export const readPitch = () => pitch
export const readPitchHistory = () => history
export const useMicrophoneState = () => useSyncExternalStore(subscribeMicrophone, getState)
export const usePitch = () => useSyncExternalStore(subscribePitch, readPitch)

import { useSyncExternalStore } from "react"
import { initialUiState, type NotesPayload, type PlaybackPayload, type UiState } from "../../shared/ipc"

/**
 * Tiny external store fed by the preload bridge.
 *
 * `state` and `notes` drive React renders through useSyncExternalStore.
 * `playback` deliberately does NOT: it changes several times per second and
 * is only consumed by the piano roll's animation loop, which reads it from
 * here on every frame. That keeps React out of the hot path.
 */

type Listener = () => void

const api = window.floatfall

let state: UiState = initialUiState
let notes: NotesPayload = { key: null, videoId: null, notes: [] }
let playback: PlaybackPayload | null = null
/** Local playhead override after the user clicks to seek, until the browser confirms. */
let seekOverride: { time: number } | null = null

const stateListeners = new Set<Listener>()
const notesListeners = new Set<Listener>()
const playbackListeners = new Set<Listener>()

const emit = (listeners: Set<Listener>) => {
  for (const listener of listeners) listener()
}

const received = { state: false, notes: false, playback: false }

api.onState((next) => {
  received.state = true
  state = next
  emit(stateListeners)
})
api.onNotes((next) => {
  received.notes = true
  notes = next
  emit(notesListeners)
})
api.onPlayback((next) => {
  received.playback = true
  playback = next
  seekOverride = null
  emit(playbackListeners)
})

// Subscribe first, then fetch the snapshot; a pushed update always wins.
void api.getSnapshot().then((snapshot) => {
  if (!received.state) {
    state = snapshot.state
    emit(stateListeners)
  }
  if (!received.notes) {
    notes = snapshot.notes
    emit(notesListeners)
  }
  if (!received.playback && snapshot.playback) {
    playback = snapshot.playback
    emit(playbackListeners)
  }
})

const subscribe = (listeners: Set<Listener>) => (listener: Listener) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const subscribeState = subscribe(stateListeners)
const subscribeNotes = subscribe(notesListeners)
export const subscribePlayback = subscribe(playbackListeners)

const getState = () => state
const getNotes = () => notes

export const useUiState = () => useSyncExternalStore(subscribeState, getState)
export const useNotes = () => useSyncExternalStore(subscribeNotes, getNotes)

/** Interpolated playback position in seconds. Cheap; safe to call every frame. */
export const currentTime = (now = Date.now()): number => {
  if (seekOverride) return seekOverride.time
  if (!playback || playback.videoId !== state.video?.videoId) return 0
  if (playback.paused) return playback.time
  return playback.time + ((now - playback.receivedAt) / 1000) * playback.rate
}

export const isPlaying = () => !!playback && !playback.paused && playback.videoId === state.video?.videoId

export const seek = (time: number) => {
  const clamped = Math.max(0, time)
  seekOverride = { time: clamped }
  emit(playbackListeners)
  api.seek(clamped)
}

export { api }

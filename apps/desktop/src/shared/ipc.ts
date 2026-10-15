import type { Note, Playback, Video } from "@floatfall/protocol"

export type Stage =
  | "idle"
  | "queued"
  | "downloading"
  | "extracting"
  | "separating"
  | "transcribing"
  | "done"
  | "error"

export interface JobStatus {
  /** Identifies the job (`videoId|vocals|mix`) so stale updates can be dropped. */
  readonly key: string | null
  readonly stage: Stage
  /** 0..1 when the current stage reports progress, otherwise null. */
  readonly progress: number | null
  readonly message: string | null
}

export interface UiOptions {
  readonly cleanVocals: boolean
  readonly autoTranscribe: boolean
  readonly pinned: boolean
}

export interface UiState {
  readonly extensionConnected: boolean
  readonly video: Video | null
  readonly job: JobStatus
  readonly options: UiOptions
  readonly separatorConfigured: boolean
  readonly transcriberConfigured: boolean
}

export interface NotesPayload {
  readonly key: string | null
  readonly videoId: string | null
  readonly notes: ReadonlyArray<Note>
}

/** `receivedAt` is `Date.now()` in the main process when the sample arrived. */
export interface PlaybackPayload extends Playback {
  readonly receivedAt: number
}

export interface Snapshot {
  readonly state: UiState
  readonly notes: NotesPayload
  readonly playback: PlaybackPayload | null
}

export type WindowAction = "close" | "minimize" | "togglePin"

export const Channels = {
  snapshot: "floatfall:snapshot",
  state: "floatfall:state",
  notes: "floatfall:notes",
  playback: "floatfall:playback",
  setOptions: "floatfall:set-options",
  transcribe: "floatfall:transcribe",
  cancel: "floatfall:cancel",
  seek: "floatfall:seek",
  openSettings: "floatfall:open-settings",
  openCache: "floatfall:open-cache",
  window: "floatfall:window"
} as const

export interface FloatfallApi {
  getSnapshot(): Promise<Snapshot>
  onState(listener: (state: UiState) => void): () => void
  onNotes(listener: (notes: NotesPayload) => void): () => void
  onPlayback(listener: (playback: PlaybackPayload) => void): () => void
  setOptions(options: Partial<Omit<UiOptions, "pinned">>): void
  transcribe(): void
  cancel(): void
  seek(time: number): void
  openSettings(): void
  openCache(): void
  window(action: WindowAction): void
}

export const initialUiState: UiState = {
  extensionConnected: false,
  video: null,
  job: { key: null, stage: "idle", progress: null, message: null },
  options: { cleanVocals: false, autoTranscribe: true, pinned: true },
  separatorConfigured: false,
  transcriberConfigured: false
}

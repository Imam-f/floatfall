import type { Video } from "@floatfall/protocol"
import { Context, Effect, Layer, PubSub, Stream, SubscriptionRef } from "effect"
import {
  initialUiState,
  type JobStatus,
  type NotesPayload,
  type PlaybackPayload,
  type UiState
} from "../../shared/ipc"

const emptyNotes: NotesPayload = { key: null, videoId: null, notes: [] }

/**
 * Single source of truth for what the floating window shows.
 *
 * State is split into three channels on purpose:
 *  - `state`    small, changes rarely (video, stage, options)
 *  - `notes`    potentially large, changes once per transcription
 *  - `playback` tiny, changes often (never stored in `state` so we do not
 *               re-send / re-render everything on every tick)
 */
export class AppState extends Context.Service<AppState, {
  readonly state: SubscriptionRef.SubscriptionRef<UiState>
  readonly notes: SubscriptionRef.SubscriptionRef<NotesPayload>
  readonly playback: PubSub.PubSub<PlaybackPayload>
  readonly lastPlayback: Effect.Effect<PlaybackPayload | null>
  readonly playbackStream: Stream.Stream<PlaybackPayload>
  update(f: (state: UiState) => UiState): Effect.Effect<void>
  setVideo(video: Video | null): Effect.Effect<void>
  /** Applies a job update only when `key` is still the current job. */
  setJob(key: string, job: Omit<JobStatus, "key">): Effect.Effect<void>
  setNotes(payload: NotesPayload): Effect.Effect<void>
  publishPlayback(playback: PlaybackPayload): Effect.Effect<void>
}>()("floatfall/main/AppState") {
  static readonly layer = Layer.effect(
    AppState,
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make(initialUiState)
      const notes = yield* SubscriptionRef.make(emptyNotes)
      const playback = yield* PubSub.sliding<PlaybackPayload>(16)
      let last: PlaybackPayload | null = null

      const update = (f: (s: UiState) => UiState) => SubscriptionRef.update(state, f)

      return AppState.of({
        state,
        notes,
        playback,
        lastPlayback: Effect.sync(() => last),
        playbackStream: Stream.fromPubSub(playback),
        update,
        setVideo: (video) =>
          update((s) => {
            if (s.video?.videoId === video?.videoId) {
              return s.video?.title === video?.title && s.video?.tabId === video?.tabId ? s : { ...s, video }
            }
            // New video: the previous job status no longer describes what is on screen.
            return { ...s, video, job: initialUiState.job }
          }),
        setJob: (key, job) => update((s) => (s.job.key === key ? { ...s, job: { ...job, key } } : s)),
        setNotes: (payload) => SubscriptionRef.set(notes, payload),
        publishPlayback: (p) =>
          Effect.suspend(() => {
            last = p
            return PubSub.publish(playback, p)
          })
      })
    })
  )
}

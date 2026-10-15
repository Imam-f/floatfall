import type { Video } from "@floatfall/protocol"
import { Context, Effect, FiberHandle, Layer, Queue, Stream, SubscriptionRef } from "effect"
import type { UiOptions } from "../../shared/ipc"
import { AppState } from "./AppState"
import { Pipeline } from "./Pipeline"
import { Settings } from "./Settings"

type Command =
  | { readonly _tag: "Auto" }
  | { readonly _tag: "Manual" }
  | { readonly _tag: "Cancel" }

/**
 * Decides *when* to run the pipeline. UI/IPC handlers only enqueue a command;
 * a single fiber processes commands in order and owns the running job, so a
 * new video (or toggling "clean vocals") interrupts the previous job.
 */
export class Controller extends Context.Service<Controller, {
  readonly transcribeNow: Effect.Effect<void>
  readonly cancel: Effect.Effect<void>
  setOptions(options: Partial<Omit<UiOptions, "pinned">>): Effect.Effect<void>
}>()("floatfall/main/Controller") {
  static readonly layer = Layer.effect(
    Controller,
    Effect.gen(function*() {
      const appState = yield* AppState
      const pipeline = yield* Pipeline
      const settings = yield* Settings
      const commands = yield* Queue.unbounded<Command>()
      const job = yield* FiberHandle.make<void, never>()

      // Mirror persisted options into UI state.
      yield* settings.changes.pipe(
        Stream.runForEach((s) =>
          appState.update((state) => ({
            ...state,
            options: { ...state.options, cleanVocals: s.cleanVocals, autoTranscribe: s.autoTranscribe },
            separatorConfigured: s.separator.command.trim() !== "",
            transcriberConfigured: s.transcriber.command.trim() !== ""
          }))
        ),
        Effect.forkScoped
      )

      // Anything that can change the desired job re-evaluates the auto rule.
      const triggers = Stream.merge(
        SubscriptionRef.changes(appState.state).pipe(
          Stream.map((s) => `${s.video?.videoId ?? ""}|${s.options.cleanVocals}|${s.options.autoTranscribe}`)
        ),
        settings.changes.pipe(
          Stream.map((s) => JSON.stringify([s.transcriber, s.separator, s.downloadFormat, s.sampleRate, s.cacheDir]))
        )
      )
      yield* triggers.pipe(
        Stream.changes,
        Stream.debounce("150 millis"),
        Stream.runForEach(() => Queue.offer(commands, { _tag: "Auto" })),
        Effect.forkScoped
      )

      /** The job currently owned by `job` (null when nothing is running). */
      let running: { readonly id: string; readonly videoId: string } | null = null

      const start = (video: Video) =>
        Effect.gen(function*() {
          const { options } = yield* SubscriptionRef.get(appState.state)
          const key = yield* pipeline.keyFor(video, options.cleanVocals)
          const current = yield* SubscriptionRef.get(appState.notes)
          if (current.key === key.id) {
            // Already on screen; just make sure the status reflects it.
            yield* appState.update((s) =>
              s.job.key === key.id
                ? s
                : { ...s, job: { key: key.id, stage: "done", progress: 1, message: `${current.notes.length} notes` } }
            )
            return
          }
          if (running?.id === key.id) return // already running this exact job
          if (current.videoId !== video.videoId) {
            yield* appState.setNotes({ key: null, videoId: video.videoId, notes: [] })
          }
          yield* appState.update((s) => ({
            ...s,
            job: { key: key.id, stage: "queued", progress: null, message: null }
          }))
          const self = { id: key.id, videoId: key.videoId }
          running = self
          yield* pipeline.transcribe(key).pipe(
            Effect.flatMap((result) =>
              appState.setNotes(result).pipe(
                Effect.andThen(
                  appState.setJob(key.id, {
                    stage: "done",
                    progress: 1,
                    message: `${result.notes.length} notes`
                  })
                )
              )
            ),
            Effect.catch((error) =>
              Effect.logWarning("Pipeline failed", error).pipe(
                Effect.andThen(appState.setJob(key.id, { stage: "error", progress: null, message: error.message }))
              )
            ),
            Effect.ensuring(Effect.sync(() => {
              if (running === self) running = null
            })),
            FiberHandle.run(job)
          )
        })

      const stop = (message: string | null) =>
        FiberHandle.clear(job).pipe(
          Effect.andThen(Effect.sync(() => {
            running = null
          })),
          Effect.andThen(
            appState.update((s) =>
              s.job.stage === "done" || s.job.stage === "idle"
                ? s
                : { ...s, job: { key: null, stage: "idle", progress: null, message } }
            )
          )
        )

      const process = Effect.fn("Controller.process")(function*(command: Command) {
        const state = yield* SubscriptionRef.get(appState.state)
        switch (command._tag) {
          case "Cancel":
            return yield* stop("Cancelled")
          case "Manual":
            return state.video ? yield* start(state.video) : undefined
          case "Auto": {
            if (!state.video) return
            if (!state.options.autoTranscribe || !state.transcriberConfigured) {
              // Never auto-start, but make sure a job for another video is not left running.
              if (running !== null && running.videoId !== state.video.videoId) {
                yield* stop(null)
              }
              return
            }
            return yield* start(state.video)
          }
        }
      })

      yield* Stream.fromQueue(commands).pipe(Stream.runForEach(process), Effect.forkScoped)

      return Controller.of({
        transcribeNow: Queue.offer(commands, { _tag: "Manual" }).pipe(Effect.asVoid),
        cancel: Queue.offer(commands, { _tag: "Cancel" }).pipe(Effect.asVoid),
        setOptions: (options) =>
          settings.update((s) => ({
            ...s,
            ...(options.cleanVocals === undefined ? {} : { cleanVocals: options.cleanVocals }),
            ...(options.autoTranscribe === undefined ? {} : { autoTranscribe: options.autoTranscribe })
          }))
      })
    })
  )
}

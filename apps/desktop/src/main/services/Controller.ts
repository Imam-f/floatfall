import type { Video } from "@floatfall/protocol"
import { Context, Effect, Fiber, Layer, Queue, Stream, SubscriptionRef } from "effect"
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
 * a single fiber processes commands in order. Jobs continue independently so
 * switching videos does not interrupt an in-progress transcription.
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

      // Mirror persisted options into UI state.
      yield* settings.changes.pipe(
        Stream.runForEach((s) =>
          appState.update((state) => ({
            ...state,
            options: { ...state.options, cleanVocals: s.cleanVocals, autoTranscribe: s.autoTranscribe },
            separatorConfigured: !!s.remote.url.trim() || s.separator.command.trim() !== "",
            transcriberConfigured: !!s.remote.url.trim() || s.transcriber.command.trim() !== "",
            processing: { ...state.processing, target: s.remote.url.trim() ? "remote" : "local", cache: null }
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
          Stream.map((s) => JSON.stringify([s.transcriber, s.separator, s.downloadFormat, s.sampleRate, s.cacheDir, s.remote]))
        )
      )
      yield* triggers.pipe(
        Stream.changes,
        Stream.debounce("150 millis"),
        Stream.runForEach(() => Queue.offer(commands, { _tag: "Auto" })),
        Effect.forkScoped
      )

      /** Active jobs keyed by their settings-sensitive cache key. */
      const running = new Map<string, { fiber?: Fiber.Fiber<void, never> }>()
      const preparing = new Set<{ fiber?: Fiber.Fiber<void, never> }>()
      let generation = 0

      const start = (video: Video, requestedGeneration: number) =>
        Effect.gen(function*() {
          const { options } = yield* SubscriptionRef.get(appState.state)
          const key = yield* pipeline.keyFor(video, options.cleanVocals)
          const latest = yield* SubscriptionRef.get(appState.state)
          if (requestedGeneration !== generation || latest.video?.videoId !== video.videoId || latest.options.cleanVocals !== options.cleanVocals) return
          yield* appState.update((s) => ({ ...s, processing: { ...s.processing, cache: key.remote?.inspection.cache ?? null } }))
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
          if (running.has(key.id)) {
            yield* appState.update((s) => ({
              ...s,
              job: { key: key.id, stage: "queued", progress: null, message: null }
            }))
            return // already running this exact job
          }
          if (current.videoId !== video.videoId) {
            yield* appState.setNotes({ key: null, videoId: video.videoId, notes: [] })
          }
          yield* appState.update((s) => ({
            ...s,
            job: { key: key.id, stage: "queued", progress: null, message: null }
          }))
          const self: { fiber?: Fiber.Fiber<void, never> } = {}
          running.set(key.id, self)
          const work = pipeline.transcribe(key).pipe(
            Effect.flatMap((result) =>
              Effect.gen(function*() {
                const state = yield* SubscriptionRef.get(appState.state)
                if (state.video?.videoId !== result.videoId || state.job.key !== key.id) return
                yield* appState.setNotes(result)
                yield* appState.setJob(key.id, {
                  stage: "done",
                  progress: 1,
                  message: `${result.notes.length} notes`
                })
              })
            ),
            Effect.catch((error) =>
              Effect.logWarning("Pipeline failed", error).pipe(
                Effect.andThen(appState.setJob(key.id, { stage: "error", progress: null, message: error.message }))
              )
            )
          )
          self.fiber = yield* work.pipe(
            Effect.ensuring(Effect.sync(() => {
              if (running.get(key.id) === self) running.delete(key.id)
            })),
            Effect.forkScoped
          )
        })

      const launch = (video: Video) => Effect.gen(function*() {
        const requestedGeneration = ++generation
        const self: { fiber?: Fiber.Fiber<void, never> } = {}
        preparing.add(self)
        yield* appState.update((s) => ({ ...s, job: { key: null, stage: "queued", progress: null, message: "Checking processing cache…" } }))
        self.fiber = yield* start(video, requestedGeneration).pipe(
          Effect.catch((error) => appState.update((s) => requestedGeneration === generation
            ? { ...s, job: { key: null, stage: "error", progress: null, message: error.message } } : s)),
          Effect.ensuring(Effect.sync(() => preparing.delete(self))),
          Effect.forkScoped
        )
      })

      const stop = (message: string | null) => Effect.suspend(() => {
        generation++
        return Effect.forEach([...preparing, ...running.values()], (entry) =>
          entry.fiber ? Fiber.interrupt(entry.fiber) : Effect.void
        ).pipe(
          Effect.andThen(Effect.sync(() => { running.clear(); preparing.clear() })),
          Effect.andThen(
            appState.update((s) =>
              s.job.stage === "done" || s.job.stage === "idle"
                ? s
                : { ...s, job: { key: null, stage: "idle", progress: null, message } }
            )
          )
        )
      })

      const process = Effect.fn("Controller.process")(function*(command: Command) {
        const state = yield* SubscriptionRef.get(appState.state)
        switch (command._tag) {
          case "Cancel":
            return yield* stop("Cancelled")
          case "Manual":
            return state.video ? yield* launch(state.video) : undefined
          case "Auto": {
            if (!state.video) return
            if (!state.options.autoTranscribe || !state.transcriberConfigured) {
              // Existing jobs continue; this only prevents starting another one.
              return
            }
            return yield* launch(state.video)
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

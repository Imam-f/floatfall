import type { Video } from "@floatfall/protocol"
import { Context, Effect, Fiber, Layer, Queue, Stream, SubscriptionRef } from "effect"
import type { Scope } from "effect/Scope"
import type { UiOptions } from "../../shared/ipc"
import { AppState } from "./AppState"
import { Pipeline, type JobKey } from "./Pipeline"
import { Settings } from "./Settings"

type Command =
  | { readonly _tag: "Auto" }
  | { readonly _tag: "Manual" }
  | { readonly _tag: "Cancel" }

/**
 * Decides *when* to run the pipeline. UI/IPC handlers only enqueue a command;
 * a single fiber processes commands in order and a FIFO queue ensures only
 * one video is processed at a time. Switching videos does not interrupt the
 * active job.
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

      type JobRequest = { readonly video: Video; readonly cleanVocals: boolean }
      type PreparedJob = { readonly request: JobRequest; readonly key: JobKey }
      const requestId = ({ video, cleanVocals }: JobRequest) => `${video.videoId}|${cleanVocals ? "vocals" : "mix"}`
      const pending: Array<PreparedJob> = []
      const queued = new Set<string>()
      const cachedJobs = new Map<string, { readonly key: JobKey; fiber?: Fiber.Fiber<void, never> }>()
      let active: { readonly request: JobRequest; readonly key: JobKey; fiber?: Fiber.Fiber<void, never> } | null = null
      let runNext: () => Effect.Effect<void, never, Scope>

      const processKey = (request: JobRequest, key: JobKey) => Effect.gen(function*() {
        const { video } = request
        yield* appState.update((s) => ({ ...s, processing: { ...s.processing, cache: key.remote?.inspection.cache ?? null } }))
        const current = yield* SubscriptionRef.get(appState.notes)
        if (current.key === key.id) {
          // Already on screen; just make sure the status reflects it.
          yield* appState.update((s) =>
            s.video?.videoId === video.videoId && s.job.key !== key.id
              ? { ...s, job: { key: key.id, stage: "done", progress: 1, message: `${current.notes.length} notes` } }
              : s
          )
          return
        }
        if (current.videoId !== video.videoId) {
          yield* appState.setNotes({ key: null, videoId: video.videoId, notes: [] })
        }
        yield* appState.update((s) => s.video?.videoId === video.videoId
          ? { ...s, job: { key: key.id, stage: "queued", progress: null, message: "Starting transcription…" } }
          : s)
        yield* pipeline.transcribe(key).pipe(
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
      })

      runNext = () => Effect.gen(function*() {
        if (active !== null || pending.length === 0) return
        const { request, key } = pending.shift()!
        queued.delete(requestId(request))
        const self: { readonly request: JobRequest; readonly key: JobKey; fiber?: Fiber.Fiber<void, never> } = { request, key }
        active = self
        self.fiber = yield* processKey(request, key).pipe(
          Effect.ensuring(Effect.sync(() => {
            if (active === self) active = null
          }).pipe(Effect.andThen(runNext()))),
          Effect.forkScoped
        )
      })

      const enqueue = (video: Video) => Effect.gen(function*() {
        const state = yield* SubscriptionRef.get(appState.state)
        const request: JobRequest = { video, cleanVocals: state.options.cleanVocals }
        const id = requestId(request)
        if (active !== null && requestId(active.request) === id) {
          if (state.video?.videoId === video.videoId) {
            yield* appState.update((s) => ({
              ...s,
              job: s.job.key === active?.key.id
                ? s.job
                : { key: active?.key.id ?? null, stage: "queued", progress: null, message: "Transcription in progress…" }
            }))
          }
          return
        }
        const cachedJob = cachedJobs.get(id)
        if (cachedJob) {
          if (state.video?.videoId === video.videoId) {
            yield* appState.update((s) => ({ ...s,
              job: s.job.key === cachedJob.key.id ? s.job : { key: cachedJob.key.id, stage: "queued", progress: null, message: "Loading cached transcription…" }
            }))
          }
          return
        }
        if (queued.has(id)) {
          if (state.video?.videoId === video.videoId) {
            yield* appState.update((s) => ({
              ...s,
              job: { key: null, stage: "queued", progress: null, message: "Waiting in transcription queue…" }
            }))
          }
          return
        }
        if (state.video?.videoId === video.videoId) {
          yield* appState.update((s) => ({
            ...s,
            job: { key: null, stage: "queued", progress: null, message: "Checking processing cache…" }
          }))
        }
        yield* Effect.gen(function*() {
          const key = yield* pipeline.keyFor(video, request.cleanVocals)
          const current = yield* SubscriptionRef.get(appState.notes)
          yield* appState.update((s) => ({ ...s, processing: { ...s.processing, cache: key.remote?.inspection.cache ?? null } }))
          if (current.key === key.id) {
            yield* appState.update((s) => s.video?.videoId === video.videoId
              ? { ...s, job: { key: key.id, stage: "done", progress: 1, message: `${current.notes.length} notes` } }
              : s)
            return
          }
          const cache = key.remote?.inspection.cache ?? (yield* pipeline.cacheFor(key))
          if (cache.notes) {
            const self: { readonly key: JobKey; fiber?: Fiber.Fiber<void, never> } = { key }
            cachedJobs.set(id, self)
            self.fiber = yield* processKey(request, key).pipe(
              Effect.ensuring(Effect.sync(() => {
                if (cachedJobs.get(id) === self) cachedJobs.delete(id)
              })),
              Effect.forkScoped
            )
            return
          }
          const prepared: PreparedJob = { request, key }
          pending.push(prepared)
          queued.add(id)
          if (state.video?.videoId === video.videoId) {
            yield* appState.update((s) => ({ ...s,
              job: { key: null, stage: "queued", progress: null, message: active ? "Waiting in transcription queue…" : "Waiting to start…" }
            }))
          }
          yield* runNext()
        }).pipe(
          Effect.catch((error) => Effect.gen(function*() {
            yield* Effect.logWarning("Could not prepare transcription", error)
            yield* appState.update((s) => s.video?.videoId === video.videoId && s.job.stage === "queued"
              ? { ...s, job: { key: null, stage: "error", progress: null, message: error.message } }
              : s)
          }))
        )
      })

      const launch = (video: Video) => enqueue(video)

      const stop = (message: string | null) => Effect.suspend(() => {
        pending.length = 0
        queued.clear()
        const current = active
        const toStop = [
          ...(current?.fiber ? [current.fiber] : []),
          ...[...cachedJobs.values()].flatMap((entry) => entry.fiber ? [entry.fiber] : [])
        ]
        return Effect.forEach(toStop, Fiber.interrupt).pipe(
          Effect.andThen(Effect.sync(() => { if (active === current) active = null })),
          Effect.andThen(Effect.sync(() => cachedJobs.clear())),
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

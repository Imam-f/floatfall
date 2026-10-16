import { watchUrl } from "@floatfall/protocol"
import { Context, Effect, Fiber, Layer, Stream } from "effect"
import { startWorkerServer } from "../workerTransport"
import type { WorkerRequest } from "../../shared/worker"
import { Pipeline } from "./Pipeline"
import { Settings } from "./Settings"
import { AppState } from "./AppState"

/** Optional server on every desktop instance; processing always stays on this machine. */
export class Worker extends Context.Service<Worker, {}>()("floatfall/main/Worker") {
  static readonly layer = Layer.effect(Worker, Effect.gen(function*() {
    const pipeline = yield* Pipeline
    const settings = yield* Settings
    const appState = yield* AppState
    const context = yield* Effect.context<never>()
    const run = Effect.runPromiseWith(context)
    let active: Fiber.Fiber<void, never> | undefined
    const localKey = (request: WorkerRequest) => pipeline.keyFor({
      videoId: request.videoId, url: watchUrl(request.videoId), title: "Remote request", tabId: -1
    }, request.cleanVocals, true)

    const serve = (config: { enabled: boolean; host: string; port: number; token: string }) => Effect.scoped(
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => startWorkerServer(config, {
            inspect: (request, signal) => run(Effect.gen(function*() {
              const key = yield* localKey(request)
              const s = yield* settings.get
              return { key: key.id, cache: yield* pipeline.cacheFor(key),
                separatorConfigured: s.separator.command.trim() !== "",
                transcriberConfigured: s.transcriber.command.trim() !== "" }
            }), { signal }),
            run: (request, progress, signal) => run(Effect.gen(function*() {
              const key = yield* localKey(request)
              if (request.expectedKey && key.id !== request.expectedKey) {
                return yield* Effect.fail(new Error("Worker model settings changed. Retry to check its cache again."))
              }
              const result = yield* pipeline.transcribeLocal(key, (value) => Effect.sync(() => progress(value)))
              return result.notes
            }), { signal })
          }),
          catch: (error) => error
        }),
        (server) => Effect.promise(() => server.close())
      ).pipe(
        Effect.tap((server) => appState.update((s) => ({ ...s, processing: { ...s.processing,
          worker: "listening", workerMessage: `Serving jobs on ${config.host}:${server.port}` } }))),
        Effect.andThen(Effect.never)
      )
    ).pipe(Effect.catch((error) => appState.update((s) => ({ ...s, processing: { ...s.processing,
      worker: "error", workerMessage: error instanceof Error ? error.message : String(error) } }))))

    yield* settings.changes.pipe(
      Stream.map((s) => s.worker),
      Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      Stream.runForEach((config) => Effect.gen(function*() {
        if (active) yield* Fiber.interrupt(active)
        yield* appState.update((s) => ({ ...s, processing: { ...s.processing, worker: "off", workerMessage: null } }))
        active = config.enabled ? yield* serve(config).pipe(Effect.forkScoped) : undefined
      })),
      Effect.forkScoped
    )
    return Worker.of({})
  }))
}

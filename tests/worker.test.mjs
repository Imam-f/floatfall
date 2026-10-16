import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { Effect, Layer, ManagedRuntime, Schema, SubscriptionRef } from "effect"
import { NodeServices } from "@effect/platform-node"

const bundle = resolve("apps/desktop/out/worker-tests/runtime.mjs")
await build({ stdin: { contents: `
  export { Pipeline } from './apps/desktop/src/main/services/Pipeline.ts';
  export { Worker } from './apps/desktop/src/main/services/Worker.ts';
  export { Controller } from './apps/desktop/src/main/services/Controller.ts';
  export { AppState } from './apps/desktop/src/main/services/AppState.ts';
  export { Settings, SettingsSchema } from './apps/desktop/src/main/services/Settings.ts';
  export { Tools, ToolError } from './apps/desktop/src/main/services/Tools.ts';
  export { startWorkerServer, requestWorker } from './apps/desktop/src/main/workerTransport.ts';
`, resolveDir: process.cwd(), loader: "ts" }, outfile: bundle, bundle: true, platform: "node", format: "esm",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  external: ["effect", "effect/*", "ws"] })
const { Pipeline, Worker, Controller, AppState, Settings, SettingsSchema, Tools, ToolError,
  startWorkerServer, requestWorker } = await import(pathToFileURL(bundle).href)
const token = "floatfall-worker-test-secret"
const video = { videoId: "abcdefghijk", url: "https://www.youtube.com/watch?v=abcdefghijk", title: "Test video", tabId: 1 }
const notes = [{ pitch: 69, start: 0, end: 1, velocity: 0.8 }]
const request = { version: 1, action: "inspect", videoId: video.videoId, cleanVocals: true }
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (check) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(10) }
  throw new Error("Timed out waiting for worker state")
}

const fixture = async (options = {}) => {
  const dir = await mkdtemp(join(tmpdir(), "floatfall-worker-"))
  const defaults = Schema.decodeUnknownSync(SettingsSchema)({})
  const state = Effect.runSync(SubscriptionRef.make({ ...defaults, cacheDir: dir,
    separator: { command: "separator", args: ["{input}", "{output}"] },
    transcriber: { command: "transcriber", args: ["{input}", "{output}"], output: "json" }, ...options }))
  const fakeSettings = {
    file: join(dir, "settings.json"), get: SubscriptionRef.get(state),
    cacheDir: SubscriptionRef.get(state).pipe(Effect.map(s => s.cacheDir)),
    changes: SubscriptionRef.changes(state), update: f => SubscriptionRef.update(state, f)
  }
  const calls = []
  let slow = false, interrupted = false
  const tools = Tools.of({ run: spec => Effect.gen(function*() {
    calls.push(spec.tool)
    if (options.forbidTools) return yield* Effect.fail(new ToolError({ tool: spec.tool, message: "Client attempted local processing" }))
    if (spec.onLine) yield* spec.onLine("50%")
    if (slow && spec.tool === "Transcription") yield* Effect.sleep("10 seconds").pipe(
      Effect.onInterrupt(() => Effect.sync(() => { interrupted = true })))
    yield* Effect.tryPromise({ try: async () => {
      if (spec.tool === "yt-dlp") {
        await writeFile(spec.args[spec.args.indexOf("-o") + 1].replace("%(ext)s", "webm"), "media")
      } else {
        await writeFile(spec.args.at(-1), spec.tool === "Transcription" ? JSON.stringify({ notes }) : "audio")
      }
    }, catch: e => new ToolError({ tool: spec.tool, message: e.message }) })
  }) })
  const layer = Layer.mergeAll(Worker.layer, Controller.layer).pipe(
    Layer.provideMerge(Pipeline.layer),
    Layer.provideMerge(AppState.layer),
    Layer.provideMerge(Layer.succeed(Settings, fakeSettings)),
    Layer.provide(Layer.succeed(Tools, tools)), Layer.provide(NodeServices.layer)
  )
  const runtime = ManagedRuntime.make(layer)
  const pipeline = await runtime.runPromise(Pipeline)
  const app = await runtime.runPromise(AppState)
  return { dir, calls, pipeline, app, runtime,
    update: f => runtime.runPromise(fakeSettings.update(f)),
    snapshot: () => runtime.runPromise(SubscriptionRef.get(app.state)),
    slow: () => { slow = true }, interrupted: () => interrupted,
    close: async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) }
  }
}

test("instances offload models, report cache stages, reuse disk notes, and stay local when serving", async () => {
  const worker = await fixture({ worker: { enabled: true, host: "127.0.0.1", port: 0, token },
    remote: { url: "ws://127.0.0.1:1", token } })
  let client
  try {
    await waitFor(async () => (await worker.snapshot()).processing.worker === "listening")
    const port = Number((await worker.snapshot()).processing.workerMessage.split(":").at(-1))
    client = await fixture({ remote: { url: `ws://127.0.0.1:${port}`, token }, forbidTools: true })
    const key = await client.runtime.runPromise(client.pipeline.keyFor(video, true))
    assert.deepEqual(key.remote.inspection.cache, { media: false, audio: false, vocals: false, notes: false })
    await client.runtime.runPromise(client.app.update(s => ({ ...s, job: { key: key.id, stage: "queued", progress: null, message: null } })))
    const result = await client.runtime.runPromise(client.pipeline.transcribe(key))
    assert.deepEqual(result.notes, notes)
    assert.deepEqual(worker.calls, ["yt-dlp", "ffmpeg", "Vocal separation", "ffmpeg", "Transcription"])
    assert.equal(client.calls.length, 0)
    assert.equal((await worker.snapshot()).job.stage, "idle", "serving a client never overwrites worker UI progress")
    const cachedKey = await client.runtime.runPromise(client.pipeline.keyFor(video, true))
    assert.deepEqual(cachedKey.remote.inspection.cache, { media: true, audio: true, vocals: true, notes: true })
    const files = await readdir(join(worker.dir, video.videoId))
    for (const file of files.filter(f => !f.startsWith("notes."))) await rm(join(worker.dir, video.videoId, file))
    await worker.runtime.runPromise(worker.pipeline.invalidateAll)
    const onlyNotes = await client.runtime.runPromise(client.pipeline.keyFor(video, true))
    assert.deepEqual(onlyNotes.remote.inspection.cache, { media: false, audio: false, vocals: false, notes: true })
    assert.deepEqual((await client.runtime.runPromise(client.pipeline.transcribe(onlyNotes))).notes, notes)
    assert.equal(worker.calls.length, 5, "disk notes require no downloader, ffmpeg, or model")
    await worker.update(s => ({ ...s, transcriber: { ...s.transcriber, args: [...s.transcriber.args, "new-model"] } }))
    const changed = await client.runtime.runPromise(client.pipeline.keyFor(video, true))
    assert.notEqual(changed.id, key.id, "worker model changes invalidate client keys")
    assert.equal(changed.remote.inspection.cache.notes, false)
    await assert.rejects(client.runtime.runPromise(client.pipeline.transcribe(key)), /settings changed/)
  } finally { await client?.close(); await worker.close() }
})

test("partial vocal caches skip downloading and separation after original audio is removed", async () => {
  const worker = await fixture()
  try {
    const key = await worker.runtime.runPromise(worker.pipeline.keyFor(video, true, true))
    await worker.runtime.runPromise(worker.pipeline.transcribeLocal(key, () => Effect.void))
    const directory = join(worker.dir, video.videoId)
    for (const file of await readdir(directory)) {
      if (!file.startsWith("vocals.")) await rm(join(directory, file))
    }
    await worker.runtime.runPromise(worker.pipeline.invalidateAll)
    const cache = await worker.runtime.runPromise(worker.pipeline.cacheFor(key))
    assert.deepEqual(cache, { media: false, audio: false, vocals: true, notes: false })
    worker.calls.length = 0
    const result = await worker.runtime.runPromise(worker.pipeline.transcribeLocal(key, () => Effect.void))
    assert.deepEqual(result.notes, notes)
    assert.deepEqual(worker.calls, ["ffmpeg", "Transcription"])
  } finally { await worker.close() }
})

test("one client's cancellation preserves shared work; the last cancellation interrupts the model", async () => {
  const worker = await fixture()
  try {
    worker.slow()
    const key = await worker.runtime.runPromise(worker.pipeline.keyFor(video, false, true))
    const first = new AbortController(), second = new AbortController()
    const progress = []
    const a = worker.runtime.runPromise(worker.pipeline.transcribeLocal(key, p => Effect.sync(() => progress.push(p.stage))), { signal: first.signal })
    const aRejected = assert.rejects(a)
    const b = worker.runtime.runPromise(worker.pipeline.transcribeLocal(key, () => Effect.void), { signal: second.signal })
    const bRejected = assert.rejects(b)
    await waitFor(() => worker.calls.includes("Transcription"))
    first.abort(); await aRejected
    assert.equal(worker.interrupted(), false, "another subscriber still needs the model")
    second.abort(); await bRejected
    await waitFor(() => worker.interrupted())
    assert.equal(worker.calls.filter(c => c === "Transcription").length, 1)
    assert.ok(progress.includes("transcribing"))
  } finally { await worker.close() }
})

test("transport authenticates, validates requests and results, propagates failures, and cancels on disconnect", async () => {
  let inspected = 0, cancelled = false
  const inspection = { key: "test-key", cache: { media: false, audio: true, vocals: false, notes: false }, separatorConfigured: true, transcriberConfigured: true }
  const server = await startWorkerServer({ host: "127.0.0.1", port: 0, token }, {
    inspect: async () => { inspected++; return inspection },
    run: async (_request, progress, signal) => {
      if (!_request.cleanVocals) throw new Error("Model unavailable")
      progress({ stage: "transcribing", progress: 0.5, message: "50%" })
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
        cancelled = true; reject(new Error("cancelled"))
      }, { once: true }))
    }
  })
  const config = { url: `ws://127.0.0.1:${server.port}`, token }
  try {
    await assert.rejects(requestWorker({ ...config, token: "wrong-token-is-long-enough" }, request, () => {}, new AbortController().signal), /Cannot connect/)
    assert.equal(inspected, 0)
    assert.deepEqual(await requestWorker(config, request, () => {}, new AbortController().signal), inspection)
    for (const invalid of [{ ...request, videoId: "../escape" }, { ...request, version: 99 }, { ...request, cleanVocals: "yes" }]) {
      await assert.rejects(requestWorker(config, invalid, () => {}, new AbortController().signal), /Invalid worker request/)
    }
    assert.equal(inspected, 1)
    await assert.rejects(requestWorker(config, { ...request, action: "run", cleanVocals: false }, () => {}, new AbortController().signal), /Model unavailable/)
    const abort = new AbortController()
    const job = requestWorker(config, { ...request, action: "run" }, () => abort.abort(), abort.signal)
    await assert.rejects(job, /cancelled/)
    await waitFor(() => cancelled)
  } finally { await server.close() }
})

test("worker settings reload without restarting the app and startup failures are visible", async () => {
  const worker = await fixture({ worker: { enabled: true, host: "127.0.0.1", port: 0, token: "short" } })
  try {
    await waitFor(async () => (await worker.snapshot()).processing.worker === "error")
    assert.match((await worker.snapshot()).processing.workerMessage, /16 characters/)
    await worker.update(s => ({ ...s, worker: { ...s.worker, token } }))
    await waitFor(async () => (await worker.snapshot()).processing.worker === "listening")
    await worker.update(s => ({ ...s, worker: { ...s.worker, enabled: false } }))
    await waitFor(async () => (await worker.snapshot()).processing.worker === "off")
  } finally { await worker.close() }
})

test("cancel interrupts a cache inspection immediately and late responses cannot start a job", async () => {
  let disconnected = false
  const server = await startWorkerServer({ host: "127.0.0.1", port: 0, token }, {
    inspect: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      disconnected = true; reject(new Error("cancelled"))
    }, { once: true })),
    run: async () => { throw new Error("Should not start a job") }
  })
  const client = await fixture({ remote: { url: `ws://127.0.0.1:${server.port}`, token }, autoTranscribe: false, forbidTools: true })
  try {
    const controller = await client.runtime.runPromise(Controller)
    await client.runtime.runPromise(client.app.setVideo(video))
    await client.runtime.runPromise(controller.transcribeNow)
    await waitFor(async () => (await client.snapshot()).job.stage === "queued")
    await delay(50)
    await client.runtime.runPromise(controller.cancel)
    await waitFor(async () => (await client.snapshot()).job.message === "Cancelled")
    await waitFor(() => disconnected)
    assert.equal(client.calls.length, 0)
  } finally { await client.close(); await server.close() }
})

test("remote errors remain visible and the controller can retry instead of dying", async () => {
  const client = await fixture({ remote: { url: "ws://127.0.0.1:1", token }, autoTranscribe: false, forbidTools: true })
  try {
    const controller = await client.runtime.runPromise(Controller)
    await client.runtime.runPromise(client.app.setVideo(video))
    await client.runtime.runPromise(controller.transcribeNow)
    await waitFor(async () => (await client.snapshot()).job.stage === "error")
    assert.match((await client.snapshot()).job.message, /Cannot connect/)
    await client.runtime.runPromise(client.app.update(s => ({ ...s, job: { ...s.job, stage: "idle" } })))
    await client.runtime.runPromise(controller.transcribeNow)
    await waitFor(async () => (await client.snapshot()).job.stage === "error")
    assert.equal(client.calls.length, 0)
  } finally { await client.close() }
})

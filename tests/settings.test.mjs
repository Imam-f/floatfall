import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { Effect, Layer, ManagedRuntime } from "effect"
import { NodeServices } from "@effect/platform-node"

const bundle = resolve("apps/desktop/out/settings-tests/runtime.mjs")
await build({ stdin: { contents: `
  export { ModelSetup } from './apps/desktop/src/main/services/ModelSetup.ts';
  export { Settings, AppPaths } from './apps/desktop/src/main/services/Settings.ts';
  export { Tools, ToolError } from './apps/desktop/src/main/services/Tools.ts';
`, resolveDir: process.cwd(), loader: "ts" }, outfile: bundle, bundle: true, platform: "node", format: "esm",
  external: ["effect", "effect/*"] })
const { ModelSetup, Settings, AppPaths, Tools, ToolError } = await import(pathToFileURL(bundle).href)
const waitFor = async (check) => {
  for (let i = 0; i < 150; i++) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error("Timed out waiting for model setup")
}
const fixture = async (run, directory) => {
  const dir = directory ?? await mkdtemp(join(tmpdir(), "floatfall-settings-"))
  const layer = ModelSetup.layer.pipe(
    Layer.provideMerge(Settings.layer),
    Layer.provide(Layer.succeed(Tools, { run })),
    Layer.provide(NodeServices.layer),
    Layer.provide(Layer.succeed(AppPaths, { userData: dir, modelScripts: resolve("models") }))
  )
  const runtime = ManagedRuntime.make(layer)
  const models = await runtime.runPromise(ModelSetup)
  const settings = await runtime.runPromise(Settings)
  return { dir, runtime, models, settings, snapshot: () => runtime.runPromise(models.snapshot),
    close: async (keep = false) => { await runtime.dispose(); if (!keep) await rm(dir, { recursive: true, force: true }) } }
}

test("settings presets survive restart, preserve other fields, and retain custom commands", async () => {
  let f = await fixture(() => Effect.void)
  try {
    const initial = (await f.snapshot()).settings
    const settings = { ...initial, remote: { ...initial.remote, url: "" }, uvPath: "C:/Tools/uv.exe", cacheDir: "C:/audio-cache", sampleRate: 16000 }
    await f.runtime.runPromise(f.models.save({ settings, transcriber: "medium", device: "cpu", separator: "bs-roformer" }))
    const saved = await f.snapshot()
    assert.deepEqual(saved.selection, { transcriber: "medium", device: "cpu", separator: "bs-roformer" })
    assert.equal(saved.settings.cacheDir, "C:/audio-cache")
    assert.equal(saved.settings.transcriber.command, "C:/Tools/uv.exe")
    assert.ok(saved.settings.transcriber.args.includes(resolve("models").replaceAll("\\", "/") + "/muscriptor_transcribe.py"))
    assert.equal(saved.settings.separator.args.at(-1), initial.ffmpegPath)
    assert.equal(JSON.parse(await readFile(saved.file, "utf8")).transcriber.output, "json")
    const dir = f.dir
    await f.close(true)
    f = await fixture(() => Effect.void, dir)
    assert.deepEqual((await f.snapshot()).selection, saved.selection)
    const custom = { command: "python", args: ["my model.py", "{input}", "{output}"], cwd: "C:/custom", output: "midi" }
    await f.runtime.runPromise(f.models.save({ settings: { ...saved.settings, transcriber: custom }, transcriber: "custom", device: "cuda", separator: "custom" }))
    assert.deepEqual((await f.snapshot()).settings.transcriber, custom)
    assert.equal((await f.snapshot()).selection.transcriber, "custom")
    const invalid = f.runtime.runPromise(f.models.save({ settings: { ...saved.settings, remote: { url: "https://example.com", token: "" } }, ...saved.selection }))
    await assert.rejects(invalid, /ws:\/\/ or wss:\/\//)
    assert.deepEqual((await f.snapshot()).settings.transcriber, custom, "invalid input never overwrites working settings")
  } finally { await f.close() }
})

test("gated downloads guide access, retry without exposing tokens, and authenticate only the child process", async () => {
  const calls = []
  let denied = true
  const token = "hf_floatfallPrivateTestToken"
  const f = await fixture((spec) => Effect.gen(function*() {
    calls.push(spec)
    if (denied) return yield* Effect.fail(new ToolError({ tool: spec.tool, message: `403 GatedRepoError ${token}` }))
    yield* spec.onLine(`50% ${token}`)
  }))
  try {
    await f.runtime.runPromise(f.models.download({ model: "small", uvPath: "uv", token }))
    await waitFor(async () => (await f.snapshot()).downloads.small?.stage === "error")
    const error = (await f.snapshot()).downloads.small
    assert.equal(error.needsAccess, true)
    assert.match(error.message, /Accept the conditions/)
    denied = false
    await f.runtime.runPromise(f.models.download({ model: "small", uvPath: "uv", token }))
    await waitFor(async () => (await f.snapshot()).downloads.small?.stage === "done")
    assert.equal(calls.length, 2)
    assert.equal(calls[1].env.FLOATFALL_HF_TOKEN, token)
    assert.equal(calls[1].args.includes(token), false)
    assert.ok(calls[1].args.includes("--download-only"))
    const snapshot = await f.snapshot()
    assert.equal(JSON.stringify(snapshot).includes(token), false)
    assert.equal((await readFile(snapshot.file, "utf8")).includes(token), false)
    assert.equal(snapshot.settings.transcriber.command, "", "downloading does not change the configured command")
  } finally { await f.close() }
})

test("downloads reject overlap, cancel their process, then allow another model", async () => {
  let interrupted = false
  const f = await fixture(() => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true }))))
  try {
    const ids = ["large", "medium"]
    const concurrent = await Promise.allSettled(ids.map((model) => f.runtime.runPromise(f.models.download({ model, uvPath: "uv" }))))
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1)
    assert.match(concurrent.find((result) => result.status === "rejected").reason.message, /already running/)
    const active = ids[concurrent.findIndex((result) => result.status === "fulfilled")]
    await waitFor(async () => (await f.snapshot()).downloads[active]?.stage === "downloading")
    await f.runtime.runPromise(f.models.cancel(active))
    assert.equal(interrupted, true)
    assert.equal((await f.snapshot()).downloads[active].stage, "cancelled")
    await f.runtime.runPromise(f.models.download({ model: "bs-roformer", uvPath: "uv" }))
    await waitFor(async () => (await f.snapshot()).downloads["bs-roformer"]?.stage === "downloading")
    await f.runtime.runPromise(f.models.cancel("bs-roformer"))
    assert.equal((await f.snapshot()).downloads["bs-roformer"].stage, "cancelled")
  } finally { await f.close() }
})

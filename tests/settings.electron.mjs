import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { app, BrowserWindow, shell } from "electron"
import { Effect, Layer, ManagedRuntime } from "effect"
import { NodeServices } from "@effect/platform-node"
import { WindowLayer } from "../apps/desktop/src/main/window.ts"
import { ModelSetup } from "../apps/desktop/src/main/services/ModelSetup.ts"
import { AppPaths, Settings } from "../apps/desktop/src/main/services/Settings.ts"
import { AppState } from "../apps/desktop/src/main/services/AppState.ts"
import { Controller } from "../apps/desktop/src/main/services/Controller.ts"
import { Bridge } from "../apps/desktop/src/main/services/Bridge.ts"
import { Tools, ToolError } from "../apps/desktop/src/main/services/Tools.ts"

const run = async () => {
const dir = process.env.FLOATFALL_SETTINGS_TEST_USER_DATA
if (!dir) throw new Error("Run this suite with tests/run-electron-test.mjs settings")
app.setPath("userData", dir)
app.on("window-all-closed", () => {})
let runtime
let downloadAttempts = 0
const links = []
shell.openExternal = async (url) => { links.push(url) }
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const evaluate = (win, code) => win.webContents.executeJavaScript(code, true)
const waitFor = async (check) => {
  for (let i = 0; i < 150; i++) { if (await check()) return; await delay(50) }
  throw new Error("Timed out waiting for Electron settings")
}
const click = (win, text) => evaluate(win, `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`)
const setField = (win, label, value) => evaluate(win, `(() => {
  const input = Array.from(document.querySelectorAll('.settings-field')).find(l => l.querySelector('span').textContent === ${JSON.stringify(label)}).querySelector('input,select,textarea');
  const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
})()`)

await app.whenReady()
let exitCode = 0
try {
  const tools = Tools.of({ run: (spec) => Effect.gen(function*() {
    downloadAttempts++
    if (downloadAttempts === 1) return yield* Effect.fail(new ToolError({ tool: spec.tool, message: "403 GatedRepoError" }))
    yield* spec.onLine("50% downloading weights")
    yield* Effect.sleep("1 second")
  }) })
  const layer = WindowLayer.pipe(
    Layer.provideMerge(ModelSetup.layer), Layer.provideMerge(Settings.layer), Layer.provideMerge(AppState.layer),
    Layer.provide(Layer.succeed(Controller, { setOptions: () => Effect.void, transcribeNow: Effect.void, cancel: Effect.void })),
    Layer.provide(Layer.succeed(Bridge, { seek: () => Effect.void })),
    Layer.provide(Layer.succeed(Tools, tools)), Layer.provide(NodeServices.layer),
    Layer.provide(Layer.succeed(AppPaths, { userData: dir, modelScripts: resolve("models") }))
  )
  runtime = ManagedRuntime.make(layer)
  await runtime.runPromise(Effect.void)
  const main = BrowserWindow.getAllWindows()[0]
  await waitFor(() => evaluate(main, `!!document.querySelector('[aria-label="Settings"]')`))
  await evaluate(main, `document.querySelector('[aria-label="Settings"]').click()`)
  await waitFor(() => BrowserWindow.getAllWindows().length === 2)
  let settings = BrowserWindow.getAllWindows().find((win) => win !== main)
  await waitFor(() => evaluate(settings, `!!document.querySelector('.settings-save') && !document.body.textContent.includes('Loading settings')`))
  await evaluate(main, `window.floatfall.openSettings()`)
  await delay(50)
  assert.equal(BrowserWindow.getAllWindows().length, 2, "settings reuses a single window")
  await click(settings, "Use local processing")
  await setField(settings, "Model", "medium")
  await setField(settings, "Compute device", "cpu")
  await click(settings, "Save changes")
  await waitFor(() => evaluate(settings, `document.body.textContent.includes('Settings saved')`))
  const saved = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"))
  assert.equal(saved.remote.url, "")
  assert.equal(saved.sampleRate, 16000)
  assert.deepEqual(saved.transcriber.args.slice(-4), ["--model", "medium", "--device", "cpu"])
  assert.ok(saved.transcriber.args.includes(resolve("models").replaceAll("\\", "/") + "/muscriptor_transcribe.py"))
  await click(settings, "Review license & request access ↗")
  assert.equal(links.at(-1), "https://huggingface.co/MuScriptor/muscriptor-medium")
  const screenshots = resolve("apps/desktop/out/test-artifacts")
  await mkdir(screenshots, { recursive: true })
  await writeFile(join(screenshots, "settings-models.png"), (await settings.webContents.capturePage()).toPNG())
  await click(settings, "Download / verify weights")
  await waitFor(() => evaluate(settings, `document.body.textContent.includes('Hugging Face access is required')`))
  await click(settings, "Review access on Hugging Face ↗")
  assert.equal(links.at(-1), "https://huggingface.co/MuScriptor/muscriptor-medium")
  await setField(settings, "Hugging Face read token (optional)", "hf_floatfallTestToken")
  await click(settings, "Retry download")
  await waitFor(() => evaluate(settings, `document.body.textContent.includes('50% downloading')`))
  assert.equal(await evaluate(settings, `document.querySelector('input[type="password"]').value`), "")
  await evaluate(settings, `document.querySelector('[aria-label="Close settings"]').click()`)
  await waitFor(() => BrowserWindow.getAllWindows().length === 1)
  assert.equal(main.isDestroyed(), false, "closing settings leaves the piano roll open")
  await evaluate(main, `window.floatfall.openSettings()`)
  await waitFor(() => BrowserWindow.getAllWindows().length === 2)
  settings = BrowserWindow.getAllWindows().find((win) => win !== main)
  await waitFor(() => evaluate(settings, `document.body.textContent.includes('Download verified')`))
  assert.equal(downloadAttempts, 2, "download continues while settings is closed")
  await click(settings, "Advanced")
  await setField(settings, "uv executable", "C:/Tools/uv.exe")
  await click(settings, "Save changes")
  await waitFor(() => evaluate(settings, `document.body.textContent.includes('Settings saved')`))
  assert.equal(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).transcriber.command, "C:/Tools/uv.exe")
  await click(settings, "Processing")
  await setField(settings, "Processing location", "remote")
  await click(settings, "Save changes")
  await waitFor(() => evaluate(settings, `document.querySelector('[role="alert"]')?.textContent.includes('16 characters')`))
  await click(settings, "Discard changes")
  await click(settings, "Models")
  await setField(settings, "Model", "small")
  const external = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"))
  await writeFile(join(dir, "settings.json"), JSON.stringify({ ...external, autoTranscribe: false }))
  await waitFor(() => evaluate(settings, `document.body.textContent.includes('Settings changed outside this window')`))
  assert.equal(await evaluate(settings, `document.querySelector('.settings-save').disabled`), true)
  await click(settings, "Reload settings")
  await waitFor(() => evaluate(settings, `document.querySelector('select')?.value === 'medium'`))
  settings.setSize(360, 560)
  await delay(200)
  assert.equal(await evaluate(settings, `document.querySelector('.settings-content').scrollWidth <= document.querySelector('.settings-content').clientWidth`), true)
  assert.equal(await evaluate(settings, `document.querySelector('.settings-footer').getBoundingClientRect().bottom <= innerHeight`), true)
  await writeFile(join(screenshots, "settings-narrow.png"), (await settings.webContents.capturePage()).toPNG())
  console.log("PASS: settings window, model presets, persistence, license links, gated download retry, background download, tool changes, validation, external-edit protection, and narrow layout")
} catch (error) { console.error(error); exitCode = 1 }
finally {
  if (runtime) await runtime.dispose()
  app.exit(exitCode)
}
}
void run().catch((error) => { console.error(error); app.exit(1) })

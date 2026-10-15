import assert from "node:assert/strict"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { app, BrowserWindow, ipcMain } from "electron"
import { attachMicrophone } from "../apps/desktop/src/main/microphone.ts"
import { Channels, initialUiState } from "../apps/desktop/src/shared/ipc.ts"

const work = mkdtempSync(join(tmpdir(), "floatfall-mic-test-"))
// The Chromium fake input prevents this test from opening the real microphone.
const audio = Buffer.alloc(44 + 48000 * 2 * 4)
audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8)
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22)
audio.writeUInt32LE(48000, 24); audio.writeUInt32LE(96000, 28)
audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write("data", 36)
audio.writeUInt32LE(audio.length - 44, 40)
for (let i = 0; i < 48000 * 4; i++) audio.writeInt16LE(Math.round(0.3 * 32767 * Math.sin(i * 2 * Math.PI * 440 / 48000)), 44 + i * 2)
const wav = join(work, "voice.wav")
writeFileSync(wav, audio)
app.setName("floatfall-microphone-test")
app.setPath("userData", join(work, "user-data"))
app.commandLine.appendSwitch("use-fake-device-for-media-stream")
app.commandLine.appendSwitch("use-file-for-fake-audio-capture", wav)
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required")
app.on("window-all-closed", () => {})
const screenshots = resolve("apps/desktop/out/test-artifacts")
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const windows = []
let dispose
let main
const evaluate = (code, win = main) => win.webContents.executeJavaScript(code, true)
const waitFor = async (code, win = main) => {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(code, win)) return
    await delay(100)
  }
  throw new Error(`Timed out: ${code}`)
}
const click = (selector, win = main) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`, win)
const create = (floating = false) => {
  const win = new BrowserWindow({
    width: floating ? 300 : 560, height: 380,
    frame: false, show: false, alwaysOnTop: true,
    webPreferences: { preload: resolve("apps/desktop/out/preload/index.js"),
      contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  })
  windows.push(win)
  void win.loadFile(resolve("apps/desktop/out/renderer/index.html"), floating ? { hash: "microphone" } : {})
  win.webContents.on("console-message", (_event, _level, message) => {
    if (message.includes("Uncaught")) console.error("Renderer:", message)
  })
  return win
}

const run = async () => {
  await app.whenReady()
  console.log("Electron microphone test: app ready")
  let exitCode = 0
  try {
    ipcMain.handle(Channels.snapshot, () => ({
      state: { ...initialUiState, extensionConnected: true,
        video: { videoId: "test", title: "Singing practice", tabId: 1 },
        job: { key: "test", stage: "done", progress: 1, message: null } },
      notes: { key: "test", videoId: "test", notes: [60, 64, 67, 69, 72, 76, 81, 84].map((pitch, start) => ({ pitch, start, end: start + 0.8, velocity: 0.8 })) },
      playback: { videoId: "test", time: 4, paused: true, rate: 1, receivedAt: Date.now() },
    }))
    main = create()
    dispose = attachMicrophone(main, () => create(true))
    await waitFor(`!!document.querySelector('.mic-toggle')`)
    console.log("Electron microphone test: renderer ready")
    assert.equal(await evaluate(`document.querySelector('.mic-toggle').getAttribute('aria-pressed')`), "false")
    await evaluate(`window.qa = { captures: 0, streams: [] }; window.originalCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async (...args) => { qa.captures++; const stream = await originalCapture(...args); qa.streams.push(stream); return stream; }; void 0`)
    await click(".mic-toggle")
    await waitFor(`document.querySelector('.voice-note')?.textContent === 'A4'`)
    console.log("Electron microphone test: live A4 detected")
    assert.equal(await evaluate(`qa.captures`), 1)
    assert.ok(Math.abs(await evaluate(`parseFloat(document.querySelector('.voice-frequency').textContent)`) - 440) < 2)
    await waitFor(`window.floatfall.getMicrophoneSnapshot().then(s => s.history.length >= 8)`)
    await click(".voice-octave-btn")
    await waitFor(`document.querySelector('.voice-note')?.textContent === 'A5'`)
    assert.ok(Math.abs(await evaluate(`parseFloat(document.querySelector('.voice-frequency').textContent)`) - 880) < 4)
    assert.equal(await evaluate(`qa.captures`), 1, "octave shift does not restart capture")
    assert.deepEqual(await evaluate(`window.floatfall.getSnapshot().then(s => s.notes.notes.map(n => n.pitch))`), [60, 64, 67, 69, 72, 76, 81, 84], "song transcription is never transposed")
    assert.equal(await evaluate(`document.querySelector('.voice-panel').scrollHeight <= document.querySelector('.voice-panel').clientHeight`), true, "overlay fits at default window size")
    await delay(150)
    await mkdir(screenshots, { recursive: true })
    await writeFile(join(screenshots, "singing-overlay.png"), (await main.webContents.capturePage()).toPNG())
    await click(".voice-mode-btn")
    const floating = windows.at(-1)
    assert.notEqual(floating, main)
    await waitFor(`document.querySelector('.voice-note')?.textContent === 'A5'`, floating)
    assert.ok(await evaluate(`window.floatfall.getMicrophoneSnapshot().then(s => s.history.length >= 8)`, floating))
    assert.equal(await evaluate(`qa.captures`), 1, "pop-out does not open another mic")
    await delay(150)
    assert.equal(await evaluate(`typeof window.qa`, floating), "undefined", "floating display is not a capture owner")
    assert.equal(floating.isAlwaysOnTop(), true)
    assert.equal(await evaluate(`document.querySelector('.voice-panel').scrollHeight <= document.querySelector('.voice-panel').clientHeight`, floating), true)
    await writeFile(join(screenshots, "singing-floating.png"), (await floating.webContents.capturePage()).toPNG())
    await click(".voice-mode-btn", floating)
    await waitFor(`!!document.querySelector('.voice-overlay')`)
    assert.equal(floating.isDestroyed(), true)
    assert.equal(await evaluate(`qa.captures`), 1, "docking preserves the original stream")
    await click(".voice-octave-btn")
    await waitFor(`document.querySelector('.voice-note')?.textContent === 'A4'`)
    await click(".mic-toggle")
    await waitFor(`qa.streams.every(s => s.getTracks().every(t => t.readyState === 'ended'))`)
    assert.equal(await evaluate(`!!document.querySelector('.voice-overlay')`), false)

    // Permission failure must be visible, and retry must recover.
    await evaluate(`navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Test permission denial', 'NotAllowedError') }; void 0`)
    await click(".mic-toggle")
    await waitFor(`document.querySelector('.voice-error')?.textContent.includes('denied')`)
    await evaluate(`navigator.mediaDevices.getUserMedia = originalCapture; void 0`)
    await click(".voice-error button")
    await waitFor(`document.querySelector('.voice-note')?.textContent === 'A4'`)
    await click(".voice-mode-btn")
    const second = windows.at(-1)
    await waitFor(`document.querySelector('.voice-note')?.textContent === 'A4'`, second)
    second.close()
    await waitFor(`document.querySelector('.mic-toggle').getAttribute('aria-pressed') === 'false'`)

    // Stop while a grant is still resolving: the late stream must be released.
    await evaluate(`window.lateStream = null; window.lateReleased = false; navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await originalCapture(...args); window.lateStream = stream; await new Promise(r => setTimeout(r, 700)); window.lateReleased = true; return stream }; void 0`)
    await click(".mic-toggle")
    await waitFor(`!!window.lateStream`)
    await click(".mic-toggle")
    await waitFor(`window.lateReleased && window.lateStream.getTracks().every(t => t.readyState === 'ended')`)
    console.log("Electron microphone integration passed: 440 Hz detection, overlay, floating/dock, close/off, permission retry, and late-grant cleanup")
    console.log(`Screenshots: ${screenshots}`)
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    dispose?.()
    ipcMain.removeHandler(Channels.snapshot)
    for (const win of windows) if (!win.isDestroyed()) win.destroy()
    await rm(work, { recursive: true, force: true }).catch(() => {})
    app.exit(exitCode)
  }
}
void run().catch((error) => { console.error(error); app.exit(1) })

import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import { build } from "esbuild"

test("one capture owner, docking, close/off, permissions, and stale-capture protection", async () => {
  class Contents extends EventEmitter {
    sent = []
    session = {
      check: null, request: null,
      setPermissionCheckHandler(handler) { this.check = handler },
      setPermissionRequestHandler(handler) { this.request = handler },
    }
    send(channel, payload) { this.sent.push([channel, payload]) }
  }
  class Window extends EventEmitter {
    webContents = new Contents()
    destroyed = false
    isDestroyed() { return this.destroyed }
    getBounds() { return { x: 100, y: 100, width: 560, height: 280 } }
    setPosition(x, y) { this.position = [x, y] }
    destroy() { this.destroyed = true; this.emit("closed") }
  }
  const handlers = new Map()
  const ipcMain = Object.assign(new EventEmitter(), {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  })
  globalThis.__floatfallElectronTest = {
    ipcMain, BrowserWindow: Window,
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }) },
  }
  const result = await build({
    entryPoints: ["apps/desktop/src/main/microphone.ts"], write: false,
    bundle: true, format: "esm", platform: "node",
    plugins: [{ name: "electron-fixture", setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "fixture" }))
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: "export const {ipcMain, BrowserWindow, screen} = globalThis.__floatfallElectronTest;", loader: "js",
      }))
    } }],
  })
  const { attachMicrophone } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`)
  const main = new Window()
  const windows = []
  const dispose = attachMicrophone(main, () => { const win = new Window(); windows.push(win); return win })
  const event = { sender: main.webContents }
  const snapshot = (sender = main.webContents) => handlers.get("floatfall:microphone-snapshot")({ sender })
  const options = (value, sender = main.webContents) => ipcMain.emit("floatfall:microphone-options", { sender }, value)
  const report = (captureId, sender = main.webContents) => ipcMain.emit("floatfall:microphone-report", { sender }, { captureId, status: "listening", error: null })
  const frame = { frequency: 440, level: 0.3, clarity: 1, at: 1 }
  try {
    assert.equal(snapshot().state.enabled, false)
    assert.equal(main.webContents.session.check(main.webContents, "media", "", { mediaType: "audio" }), false)
    options({ enabled: true })
    const capture = snapshot().state.captureId
    assert.equal(snapshot().state.status, "requesting")
    assert.equal(main.webContents.session.check(main.webContents, "media", "", { mediaType: "audio" }), true)
    assert.equal(main.webContents.session.check(main.webContents, "media", "", { mediaType: "video" }), false)
    report(capture)
    ipcMain.emit("floatfall:report-pitch", event, capture, frame)
    assert.equal(snapshot().pitch.frequency, 440)
    options({ mode: "floating" })
    assert.equal(windows.length, 1)
    const floating = windows[0]
    assert.equal(snapshot(floating.webContents).pitch.frequency, 440, "new windows get the current pitch")
    assert.equal(snapshot().state.captureId, capture, "pop-out must not restart capture")
    ipcMain.emit("floatfall:report-pitch", { sender: floating.webContents }, capture, { ...frame, frequency: 880 })
    assert.equal(snapshot().pitch.frequency, 440, "display windows cannot produce audio frames")
    options({ mode: "overlay" }, floating.webContents)
    assert.equal(floating.isDestroyed(), true)
    assert.equal(snapshot().state.enabled, true, "docking must keep the mic on")
    options({ mode: "floating" })
    windows[1].destroy()
    assert.equal(snapshot().state.enabled, false, "closing the floating window stops capture")
    assert.equal(snapshot().pitch, null)
    report(capture)
    ipcMain.emit("floatfall:report-pitch", event, capture, frame)
    assert.equal(snapshot().state.status, "off")
    assert.equal(snapshot().pitch, null, "late frames must not revive a stopped mic")
    options({ enabled: true })
    const nextCapture = snapshot().state.captureId
    report(capture)
    assert.equal(snapshot().state.status, "requesting", "late permission grants are ignored")
    report(nextCapture)
    options({ deviceId: "another-mic" })
    assert.ok(snapshot().state.captureId > nextCapture)
    assert.equal(snapshot().state.status, "requesting")
    main.webContents.emit("did-start-loading")
    assert.equal(snapshot().state.enabled, false, "reloading must not silently resume capture")
    assert.equal(windows.at(-1).isDestroyed(), true)
    options({ enabled: true }, new Contents())
    assert.equal(snapshot().state.enabled, false, "unknown senders cannot enable capture")
  } finally {
    dispose()
    delete globalThis.__floatfallElectronTest
  }
  assert.equal(handlers.size, 0)
  assert.equal(ipcMain.eventNames().length, 0)
  assert.equal(main.webContents.session.check, null)
})

import { build } from "esbuild"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const suite = process.argv[2] ?? "microphone"
if (!["microphone", "settings"].includes(suite)) throw new Error("Unknown Electron test suite")
const target = resolve(`apps/desktop/out/${suite === "settings" ? "main/" : ""}${suite}-test.cjs`)
await build({ entryPoints: [`tests/${suite}.electron.mjs`], outfile: target,
  bundle: true, platform: "node", format: "cjs", external: ["electron"] })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const settingsData = suite === "settings" ? await mkdtemp(join(tmpdir(), "floatfall-settings-electron-")) : null
if (settingsData) env.FLOATFALL_SETTINGS_TEST_USER_DATA = settingsData
const child = spawn(createRequire(import.meta.url)("electron"), [target], {
  env, stdio: "inherit", windowsHide: true,
})
child.on("error", (error) => { console.error(error); process.exitCode = 1 })
child.on("exit", async (code) => {
  process.exitCode = code ?? 1
  if (settingsData) await rm(settingsData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

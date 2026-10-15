import { build } from "esbuild"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { resolve } from "node:path"

const target = resolve("apps/desktop/out/microphone-test.cjs")
await build({ entryPoints: ["tests/microphone.electron.mjs"], outfile: target,
  bundle: true, platform: "node", format: "cjs", external: ["electron"] })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(createRequire(import.meta.url)("electron"), [target], {
  env, stdio: "inherit", windowsHide: true,
})
child.on("error", (error) => { console.error(error); process.exitCode = 1 })
child.on("exit", (code) => { process.exitCode = code ?? 1 })

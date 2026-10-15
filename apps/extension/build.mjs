import { cp, mkdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const root = dirname(fileURLToPath(import.meta.url))
const outdir = join(root, "dist")
const watch = process.argv.includes("--watch")

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
// Static files live in ./static (not the package root) so the source folder
// cannot be mistaken for the loadable extension; load ./dist instead.
await cp(join(root, "static"), outdir, { recursive: true })

const common = {
  bundle: true,
  target: "chrome116",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  logLevel: "info",
  jsx: "automatic"
}

const builds = [
  // Background service worker is declared as `type: module`.
  { ...common, entryPoints: [join(root, "src/background.ts")], outfile: join(outdir, "background.js"), format: "esm" },
  // Content scripts cannot be ES modules: emit a self-contained IIFE.
  { ...common, entryPoints: [join(root, "src/content.ts")], outfile: join(outdir, "content.js"), format: "iife" },
  { ...common, entryPoints: [join(root, "src/popup.tsx")], outfile: join(outdir, "popup.js"), format: "esm" }
]

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)))
  await Promise.all(contexts.map((ctx) => ctx.watch()))
  console.log(`Watching… load ${outdir} as an unpacked extension.`)
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)))
  console.log(`Built extension into ${outdir}`)
}

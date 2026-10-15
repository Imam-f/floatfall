import { resolve } from "node:path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "electron-vite"

// effect / @effect/* / the workspace protocol package are ESM (or raw TS),
// so they are bundled into the CommonJS main/preload output instead of being
// required at runtime.
const bundled = ["effect", "@effect/platform-node", "@effect/platform-node-shared", "@floatfall/protocol"]

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: bundled }
    }
  },
  preload: {
    build: {
      externalizeDeps: { exclude: bundled }
    }
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html")
      }
    }
  }
})

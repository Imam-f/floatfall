import type { FloatfallApi } from "../../shared/ipc"

declare global {
  interface Window {
    readonly floatfall: FloatfallApi
  }
}

export {}

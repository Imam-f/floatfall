import type { Video } from "@floatfall/protocol"

/** Status the background publishes to `chrome.storage.session` for the popup. */
export interface BridgeStatus {
  readonly connected: boolean
  readonly video: Video | null
  readonly lastError: string | null
}

export const STATUS_KEY = "floatfall.status"

export const initialStatus: BridgeStatus = { connected: false, video: null, lastError: null }

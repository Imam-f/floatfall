import type { Video } from "@floatfall/protocol"

/** Active tab's video that was ignored because it is too long / live. */
export interface Skipped {
  readonly title: string
  /** Seconds, or null for live streams. */
  readonly duration: number | null
}

/** Status the background publishes to `chrome.storage.session` for the popup. */
export interface BridgeStatus {
  readonly connected: boolean
  readonly video: Video | null
  readonly skipped: Skipped | null
  readonly lastError: string | null
}

export const STATUS_KEY = "floatfall.status"

export const initialStatus: BridgeStatus = { connected: false, video: null, skipped: null, lastError: null }

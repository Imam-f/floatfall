import type { SettingsData } from "../main/services/Settings"

export type { SettingsData }
export const modelSizes = ["small", "medium", "large"] as const
export type ModelSize = typeof modelSizes[number]
export const isModelSize = (value: string): value is ModelSize => modelSizes.some((size) => size === value)
export type ModelId = ModelSize | "bs-roformer"
export type TranscriberChoice = ModelSize | "custom" | "none"
export type SeparatorChoice = "bs-roformer" | "custom" | "none"
export type ModelDevice = "cuda" | "cpu"

export interface ModelSelection {
  readonly transcriber: TranscriberChoice
  readonly separator: SeparatorChoice
  readonly device: ModelDevice
}

export interface SaveSettingsRequest extends ModelSelection {
  readonly settings: SettingsData
}

export interface ModelDownloadRequest {
  readonly model: ModelId
  readonly uvPath: string
  /** Sent only to the download process; never written to settings.json. */
  readonly token?: string
}

export interface ModelDownload {
  readonly stage: "downloading" | "done" | "error" | "cancelled"
  readonly progress: number | null
  readonly message: string
  readonly needsAccess: boolean
}

export type ModelDownloads = Partial<Record<ModelId, ModelDownload>>
export interface SettingsSnapshot {
  readonly settings: SettingsData
  readonly selection: ModelSelection
  readonly file: string
  readonly scriptsAvailable: boolean
  readonly downloads: ModelDownloads
}

export type SettingsResult = { readonly ok: true } | { readonly ok: false; readonly error: string }
export type SettingsLink = ModelId | "hf-tokens" | "uv"

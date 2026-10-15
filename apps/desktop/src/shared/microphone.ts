export interface MicrophoneDevice {
  readonly deviceId: string
  readonly label: string
}

export interface MicrophoneState {
  readonly enabled: boolean
  readonly mode: "overlay" | "floating"
  readonly deviceId: string
  readonly octaveUp: boolean
  /** Changes on restart so late permission grants and frames can be discarded. */
  readonly captureId: number
  readonly status: "off" | "requesting" | "listening" | "error"
  readonly error: string | null
  readonly devices: ReadonlyArray<MicrophoneDevice>
}

export type MicrophoneOptions = Partial<Pick<MicrophoneState, "enabled" | "mode" | "deviceId" | "octaveUp">>

export interface MicrophoneReport {
  readonly captureId: number
  readonly status: "requesting" | "listening" | "error"
  readonly error: string | null
  readonly devices?: ReadonlyArray<MicrophoneDevice>
}

export interface PitchFrame {
  readonly frequency: number | null
  readonly clarity: number
  readonly level: number
  readonly at: number
}

export interface MicrophoneSnapshot {
  readonly state: MicrophoneState
  readonly pitch: PitchFrame | null
  readonly history: ReadonlyArray<PitchFrame>
}

export const PITCH_HISTORY_MS = 12000
export const appendPitchHistory = (history: ReadonlyArray<PitchFrame>, frame: PitchFrame): ReadonlyArray<PitchFrame> =>
  [...history.filter((point) => point.at >= frame.at - PITCH_HISTORY_MS && point.at !== frame.at), frame].slice(-240)

export const initialMicrophoneState: MicrophoneState = {
  enabled: false, mode: "overlay", deviceId: "default", octaveUp: false, captureId: 0,
  status: "off", error: null, devices: []
}

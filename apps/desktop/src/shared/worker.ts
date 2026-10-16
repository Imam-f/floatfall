import type { Note } from "@floatfall/protocol"
import type { JobStatus } from "./ipc"

export const WORKER_PORT = 47616
export const WORKER_VERSION = 1
export const validWorkerVideoId = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-]{11}$/.test(value)

export type JobProgress = Omit<JobStatus, "key">
export interface CacheAvailability {
  readonly media: boolean
  readonly audio: boolean
  readonly vocals: boolean
  readonly notes: boolean
}
export interface WorkerInspection {
  readonly key: string
  readonly cache: CacheAvailability
  readonly separatorConfigured: boolean
  readonly transcriberConfigured: boolean
}
export type WorkerRequest = {
  readonly version: number
  readonly action: "inspect" | "run"
  readonly videoId: string
  readonly cleanVocals: boolean
  readonly expectedKey?: string
}
export type WorkerResponse =
  | { readonly type: "inspection"; readonly inspection: WorkerInspection }
  | { readonly type: "progress"; readonly progress: JobProgress }
  | { readonly type: "result"; readonly notes: ReadonlyArray<Note> }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "heartbeat" }

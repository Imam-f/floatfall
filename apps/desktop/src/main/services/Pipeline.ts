import { createHash } from "node:crypto"
import { MAX_VIDEO_SECONDS, type Note, TranscriptionFile, type Video } from "@floatfall/protocol"
import { Midi } from "@tonejs/midi"
import { Cache, Context, Data, Duration, Effect, Exit, FileSystem, Layer, Path, Schema, Semaphore } from "effect"
import type { Stage } from "../../shared/ipc"
import { WORKER_VERSION, type CacheAvailability, type JobProgress, type WorkerInspection } from "../../shared/worker"
import { requestWorker } from "../workerTransport"
import { AppState } from "./AppState"
import { type CommandSpec, type SettingsData, Settings } from "./Settings"
import { fillTemplate, ToolError, Tools } from "./Tools"

export class PipelineError extends Schema.TaggedError<PipelineError>()("PipelineError", {
  stage: Schema.String,
  message: Schema.String
}) {}

/**
 * Cache key for one transcription. Structural equality (Data.Class) lets the
 * in-memory Cache dedupe concurrent requests and memoize finished ones.
 * `specHash` changes whenever the relevant tool configuration changes, so
 * editing settings.json invalidates results automatically.
 */
export class JobKey extends Data.Class<{
  readonly videoId: string
  readonly url: string
  readonly cleanVocals: boolean
  readonly specHash: string
  /** Frozen local settings so queued work cannot run under a different cache key. */
  readonly config?: string
  readonly remote?: { readonly url: string; readonly token: string; readonly inspection: WorkerInspection }
}> {
  get id() {
    return `${this.videoId}|${this.cleanVocals ? "vocals" : "mix"}|${this.specHash}`
  }
}

export interface Transcription {
  readonly key: string
  readonly videoId: string
  readonly notes: ReadonlyArray<Note>
}
type ProcessingSettings = Pick<SettingsData, "ytDlpPath" | "ffmpegPath" | "downloadFormat" | "sampleRate" | "cacheDir" | "separator" | "transcriber">

const shortHash = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 10)

const specHashOf = (spec: CommandSpec) => shortHash({ c: spec.command, a: spec.args, w: spec.cwd ?? "" })

// Separator outputs depend on the audio format as well as the model command.
const separatorHashOf = (spec: CommandSpec) =>
  shortHash({ spec: specHashOf(spec), sampleRate: 44100, channels: 2 })

const decodeTranscription = Schema.decodeUnknownEffect(Schema.fromJsonString(TranscriptionFile))

const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*%/
const YTDLP_PROGRESS = /^FFPROG\s+(\d{1,3}(?:\.\d+)?)%/

/** Sorted, sanitized notes. Sorting once here keeps the renderer's binary search valid. */
const normalizeNotes = (notes: ReadonlyArray<Note>): ReadonlyArray<Note> =>
  notes
    .filter((n) => Number.isFinite(n.pitch) && Number.isFinite(n.start) && Number.isFinite(n.end) && n.end > n.start)
    .map((n) => ({ ...n, pitch: Math.round(n.pitch) }))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)

export class Pipeline extends Context.Service<Pipeline, {
  /** Builds the cache key for a video with the current settings. */
  keyFor(video: Video, cleanVocals: boolean, localOnly?: boolean): Effect.Effect<JobKey, PipelineError>
  /** Download -> extract audio -> (separate vocals) -> transcribe. Memoized per key. */
  transcribe(key: JobKey): Effect.Effect<Transcription, PipelineError>
  /** Worker entry point: never forwards to another server or changes the local UI. */
  transcribeLocal(key: JobKey, progress: (value: JobProgress) => Effect.Effect<void>): Effect.Effect<Transcription, PipelineError>
  cacheFor(key: JobKey): Effect.Effect<CacheAvailability>
  /** Forgets in-memory results (e.g. after the cache dir was wiped). */
  readonly invalidateAll: Effect.Effect<void>
}>()("floatfall/main/Pipeline") {
  static readonly layer = Layer.effect(
    Pipeline,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tools = yield* Tools
      const settings = yield* Settings
      const appState = yield* AppState
      const listeners = new Map<string, Set<(value: JobProgress) => Effect.Effect<void>>>()
      const latestProgress = new Map<string, JobProgress>()
      const slot = yield* Semaphore.make(1)
      const configFor = (key: JobKey): Effect.Effect<ProcessingSettings> => key.config
        ? Effect.sync(() => JSON.parse(key.config!) as ProcessingSettings) : settings.get

      const fail = (stage: Stage, message: string) => new PipelineError({ stage, message })
      const fromToolError = (stage: Stage) => (error: ToolError) => fail(stage, error.message)

      /** Throttled progress reporter: avoids flooding IPC with every output line. */
      const reporter = (key: JobKey, stage: Stage) => {
        let lastAt = 0
        let lastProgress: number | null = null
        const report = (progress: number | null, message: string | null) => Effect.suspend(() => {
          const value = { stage, progress, message }
          latestProgress.set(key.id, value)
          return Effect.forEach([...(listeners.get(key.id) ?? [])], (listener) => listener(value)).pipe(Effect.asVoid)
        })
        return {
          start: (message: string | null) => report(null, message),
          line: (line: string, pattern: RegExp = PERCENT) =>
            Effect.suspend(() => {
              const now = Date.now()
              const match = pattern.exec(line)
              const progress = match?.[1] ? Math.min(1, Number(match[1]) / 100) : lastProgress
              if (now - lastAt < 150 && progress === lastProgress) return Effect.void
              lastAt = now
              lastProgress = progress
              return report(progress, line.length > 140 ? `${line.slice(0, 140)}…` : line)
            })
        }
      }

      const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false))

      /** Runs `produce(partialPath)` then atomically renames to `target`. Skips if `target` exists. */
      const cached = <E>(target: string, produce: (partial: string) => Effect.Effect<void, E>) =>
        Effect.gen(function*() {
          if (yield* exists(target)) return target
          const ext = path.extname(target)
          const partial = `${target.slice(0, -ext.length)}.partial${ext}`
          yield* fs.remove(partial, { force: true }).pipe(Effect.ignore)
          yield* produce(partial)
          if (!(yield* exists(partial))) {
            return yield* Effect.fail(fail("error", `Expected output was not written: ${partial}`))
          }
          yield* fs.rename(partial, target).pipe(Effect.mapError((e) => fail("error", e.message)))
          return target
        })

      const findMedia = (dir: string) =>
        fs.readDirectory(dir).pipe(
          Effect.map((files) =>
            files.find((f) => f.startsWith("media.") && !/\.(part|ytdl|temp|tmp)$/.test(f) && !f.includes(".part-"))
          ),
          Effect.orElseSucceed(() => undefined)
        )

      const download = Effect.fn("Pipeline.download")(function*(key: JobKey, dir: string) {
        const existing = yield* findMedia(dir)
        if (existing) return path.join(dir, existing)
        const s = yield* configFor(key)
        const r = reporter(key, "downloading")
        yield* r.start("Downloading (low quality)…")
        yield* tools.run({
          tool: "yt-dlp",
          command: s.ytDlpPath,
          args: [
            "--no-playlist",
            "--newline",
            // Safety net in case something other than the extension sends a long video.
            "--match-filter",
            `duration <= ${MAX_VIDEO_SECONDS} & !is_live`,
            "-f",
            s.downloadFormat,
            "--progress-template",
            "download:FFPROG %(progress._percent_str)s",
            "-o",
            path.join(dir, "media.%(ext)s"),
            key.url
          ],
          onLine: (line) => r.line(line, YTDLP_PROGRESS)
        }).pipe(Effect.mapError(fromToolError("downloading")))
        const media = yield* findMedia(dir)
        if (!media) {
          return yield* fail(
            "downloading",
            `No file downloaded. Videos longer than ${MAX_VIDEO_SECONDS / 60} minutes and live streams are skipped.`
          )
        }
        return path.join(dir, media)
      })

      const extractAudio = Effect.fn("Pipeline.extractAudio")(function*(
        key: JobKey, dir: string, media: string, sampleRate: number, channels: number, filename: string
      ) {
        const s = yield* configFor(key)
        const r = reporter(key, "extracting")
        return yield* cached(path.join(dir, filename), (partial) =>
          r.start("Extracting audio…").pipe(
            Effect.andThen(
              tools.run({
                tool: "ffmpeg",
                command: s.ffmpegPath,
                args: ["-hide_banner", "-y", "-i", media, "-vn", "-ac", String(channels), "-ar", String(sampleRate), partial]
              })
            ),
            Effect.mapError(fromToolError("extracting"))
          ))
      })

      const runModel = (
        key: JobKey,
        stage: Stage,
        label: string,
        spec: CommandSpec,
        input: string,
        target: string
      ) =>
        Effect.gen(function*() {
          if (yield* exists(target)) return target
          if (spec.command.trim() === "") {
            return yield* fail(stage, `${label} is not configured. Set "${stage === "separating" ? "separator" : "transcriber"}.command" in settings.json.`)
          }
          const s = yield* configFor(key)
          const r = reporter(key, stage)
          return yield* cached(target, (partial) =>
            r.start(`${label}…`).pipe(
              Effect.andThen(
                tools.run({
                  tool: label,
                  command: spec.command,
                  args: fillTemplate(spec.args, {
                    input,
                    output: partial,
                    outputDir: path.dirname(partial),
                    videoId: key.videoId,
                    sampleRate: String(s.sampleRate)
                  }),
                  cwd: spec.cwd,
                  onLine: (line) => r.line(line)
                })
              ),
              Effect.mapError(fromToolError(stage))
            ))
        })

      const parseNotes = Effect.fn("Pipeline.parseNotes")(function*(file: string, format: "json" | "midi") {
        if (format === "json") {
          const text = yield* fs.readFileString(file).pipe(Effect.mapError((e) => fail("transcribing", e.message)))
          const decoded = yield* decodeTranscription(text).pipe(
            Effect.mapError((e) => fail("transcribing", `Transcriber output is not valid notes JSON: ${e.message}`))
          )
          return normalizeNotes(Array.isArray(decoded) ? decoded : (decoded as { notes: ReadonlyArray<Note> }).notes)
        }
        const bytes = yield* fs.readFile(file).pipe(Effect.mapError((e) => fail("transcribing", e.message)))
        const midi = yield* Effect.try({
          try: () => new Midi(bytes),
          catch: (e) => fail("transcribing", `Invalid MIDI output: ${String(e)}`)
        })
        return normalizeNotes(
          midi.tracks.flatMap((track) =>
            track.notes.map((n) => ({ pitch: n.midi, start: n.time, end: n.time + n.duration, velocity: n.velocity }))
          )
        )
      })

      const lookup = Effect.fn("Pipeline.lookup")(function*(key: JobKey) {
        const s = yield* configFor(key)
        const dir = path.join(s.cacheDir, key.videoId)
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError((e) => fail("downloading", e.message)))

        const ext = s.transcriber.output === "midi" ? "mid" : "json"
        const notesTarget = path.join(dir, `notes.${key.cleanVocals ? "vocals" : "mix"}.${key.specHash}.${ext}`)
        if (yield* exists(notesTarget)) {
          return { key: key.id, videoId: key.videoId, notes: yield* parseNotes(notesTarget, s.transcriber.output) }
        }
        const audioFilename = key.cleanVocals ? "audio.stereo.44100.wav" : `audio.${s.sampleRate}.wav`
        const vocalsTarget = path.join(dir, `vocals.${separatorHashOf(s.separator)}.wav`)
        const preparedVocals = path.join(dir, `audio.vocals.${separatorHashOf(s.separator)}.${s.sampleRate}.wav`)
        let audio = path.join(dir, audioFilename)
        const hasVocals = key.cleanVocals && (yield* exists(vocalsTarget))
        const hasPreparedVocals = key.cleanVocals && (yield* exists(preparedVocals))
        if (!hasVocals && !hasPreparedVocals && !(yield* exists(audio))) {
          const media = yield* download(key, dir)
          audio = yield* extractAudio(key, dir, media, key.cleanVocals ? 44100 : s.sampleRate,
            key.cleanVocals ? 2 : 1, audioFilename)
        }

        if (hasPreparedVocals) {
          audio = preparedVocals
        } else if (key.cleanVocals) {
          audio = hasVocals ? vocalsTarget : yield* runModel(
            key,
            "separating",
            "Vocal separation",
            s.separator,
            audio,
            vocalsTarget
          )
          // Preserve stereo detail during separation; only then prepare model input.
          audio = yield* extractAudio(
            key, dir, audio, s.sampleRate, 1,
            `audio.vocals.${separatorHashOf(s.separator)}.${s.sampleRate}.wav`
          )
        }

        const notesFile = yield* runModel(
          key,
          "transcribing",
          "Transcription",
          s.transcriber,
          audio,
          notesTarget
        )
        const notes = yield* parseNotes(notesFile, s.transcriber.output)
        return { key: key.id, videoId: key.videoId, notes } satisfies Transcription
      })

      // A completed notes file is a cache hit, so it can be returned without
      // taking the single-work semaphore used for downloads and transcription.
      const readCachedNotes = Effect.fn("Pipeline.readCachedNotes")(function*(key: JobKey) {
        const s = yield* configFor(key)
        const dir = path.join(s.cacheDir, key.videoId)
        const ext = s.transcriber.output === "midi" ? "mid" : "json"
        const notesFile = path.join(dir, `notes.${key.cleanVocals ? "vocals" : "mix"}.${key.specHash}.${ext}`)
        if (!(yield* exists(notesFile))) return undefined
        return {
          key: key.id,
          videoId: key.videoId,
          notes: yield* parseNotes(notesFile, s.transcriber.output)
        } satisfies Transcription
      })

      // In-memory memo on top of the on-disk cache. Cache hits bypass the slot;
      // only work that may need processing waits for the single-work semaphore.
      const cache = yield* Cache.makeWith((key: JobKey) => readCachedNotes(key).pipe(
        Effect.flatMap((cached) => cached ? Effect.succeed(cached) : slot.withPermit(lookup(key))),
        Effect.ensuring(Effect.sync(() => latestProgress.delete(key.id)))
      ), {
        capacity: 32,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
      })

      const keyFor = (video: Video, cleanVocals: boolean, localOnly = false): Effect.Effect<JobKey, PipelineError> =>
        Effect.gen(function*() {
          const s = yield* settings.get
          if (!localOnly && s.remote.url.trim()) {
            const inspection = (yield* Effect.tryPromise({
              try: (signal) => requestWorker(s.remote, { version: WORKER_VERSION, action: "inspect", videoId: video.videoId, cleanVocals }, () => {}, signal),
              catch: (error) => fail("queued", error instanceof Error ? error.message : String(error))
            })) as WorkerInspection
            return new JobKey({ videoId: video.videoId, url: video.url, cleanVocals,
              specHash: shortHash({ remote: s.remote.url, key: inspection.key }),
              remote: { ...s.remote, inspection } })
          }
          return new JobKey({
            videoId: video.videoId,
            url: video.url,
            cleanVocals,
            config: JSON.stringify({ ytDlpPath: s.ytDlpPath, ffmpegPath: s.ffmpegPath,
              downloadFormat: s.downloadFormat, sampleRate: s.sampleRate, cacheDir: yield* settings.cacheDir,
              separator: s.separator, transcriber: s.transcriber }),
            specHash: shortHash({
              t: specHashOf(s.transcriber),
              o: s.transcriber.output,
              s: cleanVocals ? separatorHashOf(s.separator) : null,
              f: s.downloadFormat,
              r: s.sampleRate
            })
          })
        })

      const transcribeLocal = (key: JobKey, progress: (value: JobProgress) => Effect.Effect<void>) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const subscribers = listeners.get(key.id) ?? new Set()
            subscribers.add(progress); listeners.set(key.id, subscribers)
          }),
          () => Effect.gen(function*() {
            yield* progress(latestProgress.get(key.id) ?? { stage: "queued", progress: null, message: "Waiting for local worker…" })
            return yield* Cache.get(cache, key)
          }),
          () => Effect.sync(() => {
            const subscribers = listeners.get(key.id)
            subscribers?.delete(progress)
            if (!subscribers?.size) listeners.delete(key.id)
          })
        )

      return Pipeline.of({
        keyFor,
        transcribeLocal,
        cacheFor: (key) => Effect.gen(function*() {
          const s = yield* configFor(key)
          const dir = path.join(s.cacheDir, key.videoId)
          const ext = s.transcriber.output === "midi" ? "mid" : "json"
          return {
            media: !!(yield* findMedia(dir)),
            audio: yield* exists(path.join(dir, key.cleanVocals ? "audio.stereo.44100.wav" : `audio.${s.sampleRate}.wav`)),
            vocals: key.cleanVocals && ((yield* exists(path.join(dir, `vocals.${separatorHashOf(s.separator)}.wav`))) ||
              (yield* exists(path.join(dir, `audio.vocals.${separatorHashOf(s.separator)}.${s.sampleRate}.wav`)))),
            notes: yield* exists(path.join(dir, `notes.${key.cleanVocals ? "vocals" : "mix"}.${key.specHash}.${ext}`))
          }
        }),
        transcribe: (key) => {
          if (!key.remote) return transcribeLocal(key, (value) => appState.setJob(key.id, value))
          const remote = key.remote
          return Effect.gen(function*() {
            yield* appState.setJob(key.id, { stage: "queued", progress: null,
              message: remote.inspection.cache.notes ? "Loading cached notes from worker…" : remote.inspection.cache.vocals
                ? "Worker will reuse cached vocals…" : remote.inspection.cache.audio ? "Worker will reuse cached audio…" : "Sending job to worker…" })
            const context = yield* Effect.context<never>()
            const fork = Effect.runForkWith(context)
            const notes = (yield* Effect.tryPromise({
              try: (signal) => requestWorker(remote, { version: WORKER_VERSION, action: "run", videoId: key.videoId,
                cleanVocals: key.cleanVocals, expectedKey: remote.inspection.key },
              (value) => fork(appState.setJob(key.id, { ...value, message: value.message ? `Worker: ${value.message}` : "Remote worker" })), signal),
              catch: (error) => fail("transcribing", error instanceof Error ? error.message : String(error))
            })) as ReadonlyArray<Note>
            return { key: key.id, videoId: key.videoId, notes }
          })
        },
        invalidateAll: Cache.invalidateAll(cache)
      })
    })
  )
}

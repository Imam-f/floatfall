import { createHash } from "node:crypto"
import { MAX_VIDEO_SECONDS, type Note, TranscriptionFile, type Video } from "@floatfall/protocol"
import { Midi } from "@tonejs/midi"
import { Cache, Context, Data, Duration, Effect, Exit, FileSystem, Layer, Path, Schema } from "effect"
import type { Stage } from "../../shared/ipc"
import { AppState } from "./AppState"
import { type CommandSpec, Settings } from "./Settings"
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

const shortHash = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 10)

const specHashOf = (spec: CommandSpec) => shortHash({ c: spec.command, a: spec.args, w: spec.cwd ?? "" })

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
  keyFor(video: Video, cleanVocals: boolean): Effect.Effect<JobKey>
  /** Download -> extract audio -> (separate vocals) -> transcribe. Memoized per key. */
  transcribe(key: JobKey): Effect.Effect<Transcription, PipelineError>
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

      const fail = (stage: Stage, message: string) => new PipelineError({ stage, message })
      const fromToolError = (stage: Stage) => (error: ToolError) => fail(stage, error.message)

      /** Throttled progress reporter: avoids flooding IPC with every output line. */
      const reporter = (key: JobKey, stage: Stage) => {
        let lastAt = 0
        let lastProgress: number | null = null
        const report = (progress: number | null, message: string | null) =>
          appState.setJob(key.id, { stage, progress, message })
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
        const s = yield* settings.get
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

      const extractAudio = Effect.fn("Pipeline.extractAudio")(function*(key: JobKey, dir: string, media: string) {
        const s = yield* settings.get
        const r = reporter(key, "extracting")
        return yield* cached(path.join(dir, `audio.${s.sampleRate}.wav`), (partial) =>
          r.start("Extracting audio…").pipe(
            Effect.andThen(
              tools.run({
                tool: "ffmpeg",
                command: s.ffmpegPath,
                args: ["-hide_banner", "-y", "-i", media, "-vn", "-ac", "1", "-ar", String(s.sampleRate), partial]
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
          if (spec.command.trim() === "") {
            return yield* fail(stage, `${label} is not configured. Set "${stage === "separating" ? "separator" : "transcriber"}.command" in settings.json.`)
          }
          const s = yield* settings.get
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
        const s = yield* settings.get
        const dir = path.join(yield* settings.cacheDir, key.videoId)
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError((e) => fail("downloading", e.message)))

        const media = yield* download(key, dir)
        let audio = yield* extractAudio(key, dir, media)

        if (key.cleanVocals) {
          audio = yield* runModel(
            key,
            "separating",
            "Vocal separation",
            s.separator,
            audio,
            path.join(dir, `vocals.${specHashOf(s.separator)}.wav`)
          )
        }

        const ext = s.transcriber.output === "midi" ? "mid" : "json"
        const notesFile = yield* runModel(
          key,
          "transcribing",
          "Transcription",
          s.transcriber,
          audio,
          path.join(dir, `notes.${key.cleanVocals ? "vocals" : "mix"}.${key.specHash}.${ext}`)
        )
        const notes = yield* parseNotes(notesFile, s.transcriber.output)
        return { key: key.id, videoId: key.videoId, notes } satisfies Transcription
      })

      // In-memory memo on top of the on-disk cache: switching back to a tab is
      // instant, concurrent requests for the same key share one run, and the
      // run is interrupted once nobody is waiting for it anymore.
      const cache = yield* Cache.makeWith(lookup, {
        capacity: 32,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
      })

      return Pipeline.of({
        keyFor: (video, cleanVocals) =>
          settings.get.pipe(
            Effect.map((s) =>
              new JobKey({
                videoId: video.videoId,
                url: video.url,
                cleanVocals,
                specHash: shortHash({
                  t: specHashOf(s.transcriber),
                  o: s.transcriber.output,
                  s: cleanVocals ? specHashOf(s.separator) : null,
                  f: s.downloadFormat,
                  r: s.sampleRate
                })
              })
            )
          ),
        transcribe: (key) => Cache.get(cache, key),
        invalidateAll: Cache.invalidateAll(cache)
      })
    })
  )
}

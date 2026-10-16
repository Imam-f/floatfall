import { Context, Effect, FileSystem, Layer, Path, Schema, Stream, SubscriptionRef } from "effect"
import { WORKER_PORT } from "../../shared/worker"

const DEFAULT_REMOTE_URL = `ws://192.168.2.6:${WORKER_PORT}`

/**
 * Paths provided by Electron (`app.getPath`). Kept as a service so the Effect
 * code never touches the `electron` module directly.
 */
export class AppPaths extends Context.Service<AppPaths, {
  readonly userData: string
}>()("floatfall/main/AppPaths") {}

/**
 * External command wrapper. `args` support placeholders:
 *   {input}      absolute path of the audio file to process
 *   {output}     absolute path of the file the tool must write
 *   {outputDir}  directory of {output}
 *   {videoId}    YouTube id
 *   {sampleRate} configured sample rate
 * An empty `command` means "not configured".
 */
export const CommandSpec = Schema.Struct({
  command: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(["{input}", "{output}"]))),
  cwd: Schema.optionalKey(Schema.String)
})
export type CommandSpec = typeof CommandSpec.Type

export const TranscriberSpec = Schema.Struct({
  ...CommandSpec.fields,
  /** Format the transcriber writes to `{output}`. */
  output: Schema.Literals(["json", "midi"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("json" as const)))
})
export type TranscriberSpec = typeof TranscriberSpec.Type

const RemoteSettings = Schema.Struct({
  url: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_REMOTE_URL))),
  token: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("")))
})
const WorkerSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  host: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("127.0.0.1"))),
  port: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(WORKER_PORT))),
  token: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("")))
})

export const SettingsSchema = Schema.Struct({
  ytDlpPath: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("yt-dlp"))),
  ffmpegPath: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("ffmpeg"))),
  /** yt-dlp `-f` selector. Defaults to the smallest file that still has audio. */
  downloadFormat: Schema.String.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("worst[acodec!=none]/worstaudio/worst"))
  ),
  sampleRate: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(44100))),
  /** Empty = `<userData>/cache`. */
  cacheDir: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  cleanVocals: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  autoTranscribe: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  remote: RemoteSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ url: DEFAULT_REMOTE_URL, token: "" }))),
  worker: WorkerSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ enabled: false, host: "127.0.0.1", port: WORKER_PORT, token: "" }))),
  separator: CommandSpec.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({ command: "", args: ["{input}", "{output}"] }))
  ),
  transcriber: TranscriberSpec.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({ command: "", args: ["{input}", "{output}"], output: "json" as const }))
  )
})
export type SettingsData = typeof SettingsSchema.Type

const SettingsJson = Schema.fromJsonString(SettingsSchema)
const decodeSettings = Schema.decodeUnknownEffect(SettingsJson)
const encodeSettings = Schema.encodeSync(SettingsSchema)
const defaults = Schema.decodeUnknownSync(SettingsSchema)({})

export class Settings extends Context.Service<Settings, {
  readonly file: string
  readonly cacheDir: Effect.Effect<string>
  readonly get: Effect.Effect<SettingsData>
  readonly changes: Stream.Stream<SettingsData>
  update(f: (settings: SettingsData) => SettingsData): Effect.Effect<void>
}>()("floatfall/main/Settings") {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { userData } = yield* AppPaths
      const file = path.join(userData, "settings.json")

      const write = (settings: SettingsData) =>
        fs.makeDirectory(userData, { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(file, JSON.stringify(encodeSettings(settings), null, 2) + "\n")),
          Effect.catch((error) => Effect.logError("Failed to write settings", error))
        )

      const read = fs.readFileString(file).pipe(
        Effect.flatMap((text) => decodeSettings(text)),
        Effect.tapError((error) => Effect.logWarning(`Invalid settings at ${file}, keeping previous values`, error)),
        Effect.option
      )

      if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
        yield* write(defaults)
      }
      const initial = yield* read
      const ref = yield* SubscriptionRef.make(initial._tag === "Some" ? initial.value : defaults)

      // Reload when the user edits settings.json by hand. Watch the directory
      // because editors often replace the file instead of writing in place.
      yield* fs.watch(userData).pipe(
        Stream.filter((event) => path.basename(event.path) === "settings.json"),
        Stream.debounce("200 millis"),
        Stream.runForEach(() =>
          read.pipe(Effect.flatMap((next) => next._tag === "Some" ? SubscriptionRef.set(ref, next.value) : Effect.void))
        ),
        Effect.catch((error) => Effect.logWarning("Settings watcher stopped", error)),
        Effect.forkScoped
      )

      const get = SubscriptionRef.get(ref)

      return Settings.of({
        file,
        get,
        cacheDir: get.pipe(Effect.map((s) => s.cacheDir.trim() || path.join(userData, "cache"))),
        changes: SubscriptionRef.changes(ref),
        update: (f) =>
          SubscriptionRef.updateAndGet(ref, f).pipe(Effect.flatMap(write))
      })
    })
  )
}

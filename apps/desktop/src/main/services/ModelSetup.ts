import { Context, Effect, Fiber, FileSystem, Layer, Path, Schema, Stream, SubscriptionRef } from "effect"
import { isModelSize, modelSizes, type ModelDownloadRequest, type ModelDownloads, type ModelId, type ModelSelection, type SaveSettingsRequest, type SettingsSnapshot } from "../../shared/settings"
import { AppPaths, Settings, SettingsSchema, type SettingsData } from "./Settings"
import { Tools } from "./Tools"

const SelectionSchema = Schema.Struct({
  settings: SettingsSchema,
  transcriber: Schema.Literals(["small", "medium", "large", "custom", "none"]),
  separator: Schema.Literals(["bs-roformer", "custom", "none"]),
  device: Schema.Literals(["cuda", "cpu"])
})
const DownloadSchema = Schema.Struct({
  model: Schema.Literals(["small", "medium", "large", "bs-roformer"]),
  uvPath: Schema.String,
  token: Schema.optionalKey(Schema.String)
})

export const applyModelSelection = (s: SettingsData, choice: ModelSelection, scripts: string): SettingsData => ({
  ...s,
  ...(choice.transcriber === "custom" ? {} : {
    transcriber: choice.transcriber === "none" ? { command: "", args: ["{input}", "{output}"], output: "json" } : {
      command: s.uvPath,
      args: ["run", "--locked", "--script", `${scripts}/muscriptor_transcribe.py`, "{input}", "{output}", "--model", choice.transcriber, "--device", choice.device],
      output: "json"
    }
  }),
  ...(choice.separator === "custom" ? {} : {
    separator: choice.separator === "none" ? { command: "", args: ["{input}", "{output}"] } : {
      command: s.uvPath,
      args: ["run", "--locked", "--script", `${scripts}/separate_vocals.py`, "{input}", "{output}", "--ffmpeg", s.ffmpegPath]
    }
  })
})

export const modelSelection = (s: SettingsData, scripts: string): ModelSelection => {
  // Only recognize exact presets. Extra flags and custom commands stay custom.
  const same = (a: SettingsData["separator"], b: SettingsData["separator"]) =>
    !a.cwd && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args)
  let transcriber: ModelSelection["transcriber"] = s.transcriber.command ? "custom" : "none"
  let device: ModelSelection["device"] = "cuda"
  for (const size of modelSizes) for (const candidate of ["cuda", "cpu"] as const) {
    const preset = applyModelSelection(s, { transcriber: size, separator: "none", device: candidate }, scripts)
    if (s.transcriber.output === "json" && same(s.transcriber, preset.transcriber)) {
      transcriber = size
      device = candidate
    }
  }
  const preset = applyModelSelection(s, { transcriber: "none", separator: "bs-roformer", device }, scripts)
  return { transcriber, device, separator: !s.separator.command ? "none" : same(s.separator, preset.separator) ? "bs-roformer" : "custom" }
}

export const validateSettings = (s: SettingsData) => {
  if (!s.uvPath.trim() || !s.ytDlpPath.trim() || !s.ffmpegPath.trim()) throw new Error("Tool paths must not be empty.")
  if (s.sampleRate < 8000 || s.sampleRate > 192000) throw new Error("Sample rate must be between 8,000 and 192,000 Hz.")
  if (!s.downloadFormat.trim()) throw new Error("Download format must not be empty.")
  if (s.remote.url.trim()) {
    let url: URL
    try { url = new URL(s.remote.url) } catch { throw new Error("Enter a valid ws:// or wss:// remote worker address.") }
    if (!["ws:", "wss:"].includes(url.protocol) || !url.hostname) throw new Error("Remote worker address must start with ws:// or wss://.")
    if (s.remote.token.length < 16) throw new Error("The remote worker token must contain at least 16 characters.")
  }
  if (!Number.isInteger(s.worker.port) || s.worker.port < 1 || s.worker.port > 65535) throw new Error("Worker port must be between 1 and 65535.")
  if (s.worker.enabled && (!s.worker.host.trim() || s.worker.token.length < 16)) throw new Error("An enabled worker needs a listen address and a token of at least 16 characters.")
}

export class ModelSetup extends Context.Service<ModelSetup, {
  readonly snapshot: Effect.Effect<SettingsSnapshot>
  readonly downloads: Stream.Stream<ModelDownloads>
  save(request: SaveSettingsRequest): Effect.Effect<void, Error>
  download(request: ModelDownloadRequest): Effect.Effect<void, Error>
  cancel(model: ModelId): Effect.Effect<void>
}>()("floatfall/main/ModelSetup") {
  static readonly layer = Layer.effect(ModelSetup, Effect.gen(function*() {
    const settings = yield* Settings
    const tools = yield* Tools
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { modelScripts } = yield* AppPaths
    const scripts = modelScripts.replaceAll("\\", "/")
    const scope = yield* Effect.scope
    const downloads = yield* SubscriptionRef.make<ModelDownloads>({})
    type ActiveDownload = { id: ModelId; fiber?: Fiber.Fiber<void, never> }
    let active: ActiveDownload | null = null
    const scriptsAvailable = Effect.forEach(["muscriptor_transcribe.py", "separate_vocals.py"], (name) =>
      fs.exists(path.join(modelScripts, name)).pipe(Effect.orElseSucceed(() => false))
    ).pipe(Effect.map((found) => found.every(Boolean)))

    const save = (request: SaveSettingsRequest) => Effect.gen(function*() {
      const decoded = yield* Schema.decodeUnknownEffect(SelectionSchema)(request).pipe(Effect.mapError(() => new Error("Invalid settings. Check the field values and command arguments.")))
      const next = applyModelSelection(decoded.settings, decoded, scripts)
      yield* Effect.try({ try: () => validateSettings(next), catch: (error) => error instanceof Error ? error : new Error(String(error)) })
      if ((isModelSize(decoded.transcriber) || decoded.separator === "bs-roformer") && !(yield* scriptsAvailable)) {
        return yield* Effect.fail(new Error("Bundled model scripts are missing. Restore the models folder or use a custom command."))
      }
      yield* settings.save(next)
    })

    const download = (request: ModelDownloadRequest) => Effect.gen(function*() {
      const decoded = yield* Schema.decodeUnknownEffect(DownloadSchema)(request).pipe(Effect.mapError(() => new Error("Invalid model download request.")))
      if (!decoded.uvPath.trim()) return yield* Effect.fail(new Error("Set the uv executable path first."))
      if (!(yield* scriptsAvailable)) return yield* Effect.fail(new Error("Bundled model scripts are missing."))
      if (active) return yield* Effect.fail(new Error("A model download is already running. Wait for it or cancel it first."))
      const id = decoded.model
      const token = decoded.token?.trim()
      const redact = (line: string) => (token ? line.replaceAll(token, "[redacted]") : line).replace(/hf_[A-Za-z0-9]+/g, "[redacted]")
      const update = (value: ModelDownloads[ModelId]) => SubscriptionRef.update(downloads, (all) => ({ ...all, [id]: value }))
      const self: ActiveDownload = { id }
      // Reserve synchronously before forking, so concurrent IPC requests cannot both start.
      active = self
      const run = Effect.gen(function*() {
        yield* update({ stage: "downloading", progress: null, message: "Preparing Python dependencies with uv. First setup can take several minutes…", needsAccess: false })
        const separator = id === "bs-roformer"
        yield* tools.run({
          tool: `${separator ? "BS-RoFormer" : `MuScriptor ${id}`} download`,
          command: decoded.uvPath,
          args: ["run", "--locked", "--script", path.join(modelScripts, separator ? "separate_vocals.py" : "muscriptor_transcribe.py"), "--download-only", ...(separator ? [] : ["--model", id])],
          env: { PYTHONUNBUFFERED: "1", ...(token && !separator ? { FLOATFALL_HF_TOKEN: token } : {}) },
          onLine: (line) => {
            const message = redact(line).slice(-1600)
            const percent = message.match(/(?:^|\s)(\d{1,3})(?:\.\d+)?%/)
            return update({ stage: "downloading", progress: percent ? Math.min(1, Number(percent[1]) / 100) : null, message, needsAccess: false })
          }
        })
        yield* update({ stage: "done", progress: 1, message: "Download verified. Weights are cached locally and ready for use.", needsAccess: false })
      }).pipe(
        Effect.catch((error) => {
          const message = redact(error.message)
          const needsAccess = /auth-required|GatedRepo|401|403|accept the licen[cs]e|access.*(denied|restricted)/i.test(message)
          return update({ stage: "error", progress: null, message: needsAccess
            ? "Hugging Face access is required. Accept the conditions for this model, then use a read token from the same account and retry."
            : message, needsAccess })
        }),
        Effect.onInterrupt(() => update({ stage: "cancelled", progress: null, message: "Download cancelled. Completed cached files can be reused on retry.", needsAccess: false })),
        Effect.ensuring(Effect.sync(() => { if (active === self) active = null }))
      )
      self.fiber = yield* run.pipe(Effect.forkIn(scope))
    })

    return ModelSetup.of({
      snapshot: Effect.gen(function*() {
        const current = yield* settings.get
        return { settings: current, selection: modelSelection(current, scripts), file: settings.file,
          scriptsAvailable: yield* scriptsAvailable, downloads: yield* SubscriptionRef.get(downloads) }
      }),
      downloads: SubscriptionRef.changes(downloads),
      save,
      download,
      cancel: (id) => Effect.suspend(() => active?.id === id && active.fiber ? Fiber.interrupt(active.fiber).pipe(Effect.asVoid) : Effect.void)
    })
  }))
}

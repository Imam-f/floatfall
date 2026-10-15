import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  tool: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export interface RunOptions {
  /** Short name used in errors/logs, e.g. "yt-dlp". */
  readonly tool: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string | undefined
  /** Called for each stdout/stderr line. Must be cheap. */
  readonly onLine?: ((line: string) => Effect.Effect<void>) | undefined
}

const TAIL = 15

/** Thin Effect wrapper around child processes: line streaming, tail capture, interruption-safe. */
export class Tools extends Context.Service<Tools, {
  run(options: RunOptions): Effect.Effect<void, ToolError>
}>()("floatfall/main/Tools") {
  static readonly layer = Layer.effect(
    Tools,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const run = Effect.fn("Tools.run")(function*(options: RunOptions) {
        const tail: Array<string> = []
        const toError = (message: string, cause?: unknown) =>
          new ToolError({
            tool: options.tool,
            message: tail.length > 0 ? `${message}\n${tail.join("\n")}` : message,
            ...(cause === undefined ? {} : { cause })
          })

        yield* Effect.logDebug(`[${options.tool}] ${options.command} ${options.args.join(" ")}`)

        // The handle lives in this scope: if the fiber is interrupted (user
        // cancels, app quits) the process is killed.
        const exitCode = yield* Effect.scoped(
          Effect.gen(function*() {
            const handle = yield* spawner.spawn(
              ChildProcess.make(options.command, options.args, {
                cwd: options.cwd,
                windowsHide: true,
                forceKillAfter: "3 seconds"
              })
            )
            yield* handle.all.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) => {
                if (line.trim().length === 0) return Effect.void
                tail.push(line)
                if (tail.length > TAIL) tail.shift()
                return options.onLine ? options.onLine(line) : Effect.void
              })
            )
            return yield* handle.exitCode
          })
        ).pipe(
          Effect.mapError((cause) =>
            toError(`Failed to run "${options.command}". Is it installed and on PATH? (${cause.message})`, cause)
          )
        )

        if (exitCode !== 0) {
          return yield* toError(`${options.tool} exited with code ${exitCode}`)
        }
      })

      return Tools.of({ run })
    })
  )
}

/** Replaces `{name}` placeholders in every argument. */
export const fillTemplate = (args: ReadonlyArray<string>, vars: Record<string, string>) =>
  args.map((arg) => arg.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match))

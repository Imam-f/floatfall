import {
  BRIDGE_PORT,
  type ClientMessage,
  ClientMessageJson,
  PROTOCOL_VERSION,
  type ServerMessage,
  ServerMessageJson
} from "@floatfall/protocol"
import { Context, Effect, Exit, Layer, Queue, Schema, Stream } from "effect"
import { type WebSocket, WebSocketServer } from "ws"
import { AppState } from "./AppState"

const decodeClient = Schema.decodeUnknownExit(ClientMessageJson)
const encodeServer = Schema.encodeSync(ServerMessageJson)

type Inbound = { readonly socket: WebSocket; readonly message: ClientMessage; readonly receivedAt: number }

/**
 * Local WebSocket server the Chrome extension connects to.
 *
 * Socket callbacks only decode + enqueue (cheap, synchronous). All real work
 * happens in a background fiber that drains the queue.
 */
export class Bridge extends Context.Service<Bridge, {
  seek(videoId: string, time: number): Effect.Effect<void>
}>()("floatfall/main/Bridge") {
  static readonly layer = Layer.effect(
    Bridge,
    Effect.gen(function*() {
      const appState = yield* AppState
      const inbox = yield* Queue.unbounded<Inbound>()
      const clients = new Set<WebSocket>()

      const setConnected = Effect.suspend(() =>
        appState.update((s) =>
          s.extensionConnected === clients.size > 0 ? s : { ...s, extensionConnected: clients.size > 0 }
        )
      )
      const connectionChanges = yield* Queue.sliding<void>(1)

      const send = (socket: WebSocket, message: ServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(encodeServer(message))
      }

      yield* Effect.acquireRelease(
        Effect.callback<WebSocketServer, Error>((resume) => {
          const server = new WebSocketServer({
            host: "127.0.0.1",
            port: BRIDGE_PORT,
            // Only accept browser extensions (and non-browser local tools without Origin).
            verifyClient: ({ origin }: { origin?: string }) =>
              !origin || origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")
          })
          server.once("listening", () => resume(Effect.succeed(server)))
          server.once("error", (error) => resume(Effect.fail(error)))
          server.on("connection", (socket) => {
            clients.add(socket)
            Queue.offerUnsafe(connectionChanges, undefined)
            socket.on("message", (data) => {
              const exit = decodeClient(data.toString())
              if (Exit.isSuccess(exit)) Queue.offerUnsafe(inbox, { socket, message: exit.value, receivedAt: Date.now() })
            })
            socket.on("close", () => {
              clients.delete(socket)
              Queue.offerUnsafe(connectionChanges, undefined)
            })
            socket.on("error", () => socket.terminate())
          })
        }),
        (server) =>
          Effect.callback<void>((resume) => {
            for (const client of clients) client.terminate()
            server.close(() => resume(Effect.void))
          })
      ).pipe(
        Effect.tap(() => Effect.logInfo(`Bridge listening on ws://127.0.0.1:${BRIDGE_PORT}`)),
        Effect.catch((error) => Effect.logError(`Bridge failed to start on port ${BRIDGE_PORT}`, error))
      )

      yield* Stream.fromQueue(connectionChanges).pipe(Stream.runForEach(() => setConnected), Effect.forkScoped)

      const handle = ({ socket, message, receivedAt }: Inbound) => {
        switch (message._tag) {
          case "Hello":
            return Effect.sync(() => send(socket, { _tag: "Welcome", version: PROTOCOL_VERSION }))
          case "Ping":
            return Effect.sync(() => send(socket, { _tag: "Pong" }))
          case "ActiveVideo":
            return appState.setVideo(message.video)
          case "Playback":
            return appState.publishPlayback({ ...message.playback, receivedAt })
        }
      }

      yield* Stream.fromQueue(inbox).pipe(Stream.runForEach(handle), Effect.forkScoped)

      return Bridge.of({
        seek: (videoId, time) =>
          Effect.sync(() => {
            for (const client of clients) send(client, { _tag: "Seek", videoId, time })
          })
      })
    })
  )
}

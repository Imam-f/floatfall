import { timingSafeEqual } from "node:crypto"
import type { AddressInfo } from "node:net"
import { WebSocket, WebSocketServer } from "ws"
import type { Note } from "@floatfall/protocol"
import { WORKER_VERSION, validWorkerVideoId, type JobProgress, type WorkerInspection,
  type WorkerRequest, type WorkerResponse } from "../shared/worker"

interface RemoteConfig { readonly url: string; readonly token: string }
interface ServerConfig { readonly host: string; readonly port: number; readonly token: string }
interface WorkerHandlers {
  inspect(request: WorkerRequest, signal: AbortSignal): Promise<WorkerInspection>
  run(request: WorkerRequest, progress: (value: JobProgress) => void, signal: AbortSignal): Promise<ReadonlyArray<Note>>
}

const send = (socket: WebSocket, value: WorkerResponse) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)
const secureEqual = (actual: string, expected: string) => {
  const a = Buffer.from(actual), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
const validRequest = (value: unknown): value is WorkerRequest => {
  if (!value || typeof value !== "object") return false
  const r = value as WorkerRequest
  return r.version === WORKER_VERSION && (r.action === "inspect" || r.action === "run") &&
    validWorkerVideoId(r.videoId) && typeof r.cleanVocals === "boolean" &&
    (r.expectedKey === undefined || (typeof r.expectedKey === "string" && r.expectedKey.length <= 200))
}
const validNotes = (notes: unknown): notes is ReadonlyArray<Note> => Array.isArray(notes) && notes.length <= 50000 &&
  notes.every((n) => n && Number.isInteger(n.pitch) && n.pitch >= 0 && n.pitch <= 127 &&
    Number.isFinite(n.start) && n.start >= 0 && Number.isFinite(n.end) && n.end > n.start &&
    (n.velocity === undefined || (Number.isFinite(n.velocity) && n.velocity >= 0 && n.velocity <= 1)))
const validProgress = (p: JobProgress) => p &&
  ["queued", "downloading", "extracting", "separating", "transcribing", "done", "error", "idle"].includes(p.stage) &&
  (p.progress === null || (Number.isFinite(p.progress) && p.progress >= 0 && p.progress <= 1)) &&
  (p.message === null || (typeof p.message === "string" && p.message.length <= 2000))
const validInspection = (i: WorkerInspection) => i && typeof i.key === "string" && i.key.length <= 200 &&
  i.cache && [i.cache.media, i.cache.audio, i.cache.vocals, i.cache.notes, i.separatorConfigured, i.transcriberConfigured]
    .every((value) => typeof value === "boolean")

/** One authenticated request per connection. Closing it cancels that client's work. */
export const startWorkerServer = async (config: ServerConfig, handlers: WorkerHandlers) => {
  if (config.token.length < 16) throw new Error("Worker token must contain at least 16 characters.")
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error("Invalid worker port.")
  const jobs = new Set<Promise<void>>()
  const controllers = new Set<AbortController>()
  const server = new WebSocketServer({
    host: config.host, port: config.port, maxPayload: 8192,
    verifyClient: ({ req, origin }, done) => {
      const authorized = !origin && secureEqual(req.headers.authorization ?? "", `Bearer ${config.token}`)
      done(authorized && server.clients.size < 16, authorized ? 503 : 401, authorized ? "Worker is full" : "Unauthorized")
    }
  })
  server.on("connection", (socket) => {
    const controller = new AbortController()
    controllers.add(controller)
    const deadline = setTimeout(() => socket.terminate(), 10000)
    let alive = true
    socket.on("pong", () => { alive = true })
    const heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return }
      alive = false; socket.ping(); send(socket, { type: "heartbeat" })
    }, 10000)
    const lifetime = setTimeout(() => socket.terminate(), 2 * 60 * 60 * 1000)
    let requested = false
    socket.on("error", () => socket.terminate())
    socket.on("close", () => {
      clearTimeout(deadline); clearTimeout(lifetime); clearInterval(heartbeat)
      controller.abort(); controllers.delete(controller)
    })
    socket.on("message", (data) => {
      if (requested) { socket.close(1008, "One request per connection"); return }
      requested = true
      clearTimeout(deadline)
      let request: unknown
      try { request = JSON.parse(data.toString()) } catch { /* rejected below */ }
      if (!validRequest(request)) {
        send(socket, { type: "error", message: "Invalid worker request or incompatible protocol version." })
        socket.close(); return
      }
      const parsed = request
      const work = (async () => {
        try {
          if (parsed.action === "inspect") {
            send(socket, { type: "inspection", inspection: await handlers.inspect(parsed, controller.signal) })
          } else {
            send(socket, { type: "progress", progress: { stage: "queued", progress: null, message: "Waiting for worker…" } })
            const notes = await handlers.run(parsed, (progress) => send(socket, { type: "progress", progress }), controller.signal)
            if (!validNotes(notes)) throw new Error("Worker produced invalid or too many notes.")
            send(socket, { type: "result", notes })
          }
        } catch (error) {
          if (!controller.signal.aborted) send(socket, { type: "error", message: messageOf(error).slice(0, 2000) })
        } finally { socket.close() }
      })()
      jobs.add(work)
      void work.finally(() => jobs.delete(work))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve)
    server.once("error", reject)
  }).catch((error) => { server.close(); throw error })
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const controller of controllers) controller.abort()
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await Promise.allSettled([...jobs])
    }
  }
}

/** Bounded, validated messages; never includes the credential in a URL or error. */
export const requestWorker = (config: RemoteConfig, request: WorkerRequest,
  onProgress: (value: JobProgress) => void, signal: AbortSignal): Promise<WorkerInspection | ReadonlyArray<Note>> =>
  new Promise((resolve, reject) => {
    let url: URL
    try {
      url = new URL(config.url)
      if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error()
    } catch { reject(new Error("Remote worker URL must be ws://host:port or wss://host:port, without credentials or query parameters.")); return }
    if (config.token.length < 16) { reject(new Error("Set remote.token to the worker's token (at least 16 characters).")); return }
    if (signal.aborted) { reject(new Error("Remote job cancelled.")); return }
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${config.token}` },
      handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024 })
    let settled = false
    let idle: ReturnType<typeof setTimeout>
    const lifetime = setTimeout(() => finish(new Error("Remote worker job exceeded two hours.")), 2 * 60 * 60 * 1000)
    const finish = (error?: Error, value?: WorkerInspection | ReadonlyArray<Note>) => {
      if (settled) return
      settled = true
      clearTimeout(idle); clearTimeout(lifetime)
      signal.removeEventListener("abort", abort)
      socket.terminate()
      if (error) reject(error); else resolve(value!)
    }
    const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => finish(new Error("Remote worker stopped responding.")), 30000) }
    const abort = () => finish(new Error("Remote job cancelled."))
    signal.addEventListener("abort", abort, { once: true })
    resetIdle()
    socket.on("open", () => socket.send(JSON.stringify(request)))
    socket.on("error", () => finish(new Error("Cannot connect to remote worker. Check its address, token, and network connection.")))
    socket.on("close", () => finish(new Error("Remote worker disconnected before returning a result.")))
    socket.on("message", (data) => {
      if (settled) return
      resetIdle()
      try {
        const message = JSON.parse(data.toString()) as WorkerResponse
        switch (message.type) {
          case "heartbeat": return
          case "error":
            if (typeof message.message !== "string") break
            finish(new Error(message.message.slice(0, 2000))); return
          case "progress":
            if (!validProgress(message.progress)) break
            onProgress(message.progress); return
          case "inspection":
            if (request.action !== "inspect" || !validInspection(message.inspection)) break
            finish(undefined, message.inspection); return
          case "result":
            if (request.action !== "run" || !validNotes(message.notes)) break
            finish(undefined, [...message.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch)); return
        }
      } catch { /* invalid messages fail below */ }
      finish(new Error("Remote worker returned an invalid response."))
    })
  })

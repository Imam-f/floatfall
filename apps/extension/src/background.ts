import {
  BRIDGE_URL,
  cleanTabTitle,
  type ClientMessage,
  ClientMessageJson,
  ContentMessage,
  parseVideoId,
  PROTOCOL_VERSION,
  type ServerMessage,
  ServerMessageJson,
  type Video,
  watchUrl
} from "@floatfall/protocol"
import { Effect, Exit, Fiber, Queue, Schema, Stream, SubscriptionRef } from "effect"
import { type BridgeStatus, initialStatus, STATUS_KEY } from "./status"

const encodeClient = Schema.encodeSync(ClientMessageJson)
const decodeServer = Schema.decodeUnknownExit(ServerMessageJson)
const decodeContent = Schema.decodeUnknownExit(ContentMessage)

// ---------------------------------------------------------------------------
// Event plumbing
//
// MV3 requires listeners to be registered synchronously at the top level.
// Every listener below does O(1) work: it drops a signal/message into a queue.
// Tab querying, socket I/O, etc. happen in Effect fibers that drain the queues.
// ---------------------------------------------------------------------------

type Signal = "tabs" | "wake"
const signals = Effect.runSync(Queue.sliding<Signal>(1))
const contentInbox = Effect.runSync(Queue.sliding<{ tabId: number; message: ContentMessage }>(32))
const serverInbox = Effect.runSync(Queue.sliding<ServerMessage>(32))

const poke = (signal: Signal = "tabs") => {
  Queue.offerUnsafe(signals, signal)
}

chrome.tabs.onActivated.addListener(() => poke())
chrome.tabs.onRemoved.addListener(() => poke())
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.url !== undefined || change.title !== undefined || change.audible !== undefined || change.status === "complete") {
    poke()
  }
})
chrome.windows.onFocusChanged.addListener(() => poke())
chrome.runtime.onStartup.addListener(() => poke("wake"))
chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create("floatfall-keepalive", { periodInMinutes: 0.5 })
  poke("wake")
})
chrome.alarms.onAlarm.addListener(() => poke("wake"))
chrome.runtime.onMessage.addListener((raw, sender) => {
  const tabId = sender.tab?.id
  if (tabId === undefined) return
  const exit = decodeContent(raw)
  if (Exit.isSuccess(exit)) Queue.offerUnsafe(contentInbox, { tabId, message: exit.value })
})

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const isVideoTab = (tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & { id: number; url: string } =>
  tab.id !== undefined && parseVideoId(tab.url) !== null

const toVideo = (tab: chrome.tabs.Tab & { id: number; url: string }, titles: Map<number, string>): Video => {
  const videoId = parseVideoId(tab.url)!
  return {
    videoId,
    url: watchUrl(videoId),
    tabId: tab.id,
    title: titles.get(tab.id) || cleanTabTitle(tab.title) || videoId
  }
}

const sameVideo = (a: Video | null, b: Video | null) =>
  a?.videoId === b?.videoId && a?.tabId === b?.tabId && a?.title === b?.title

const program = Effect.gen(function*() {
  const current = yield* SubscriptionRef.make<Video | null>(null)
  const status = yield* SubscriptionRef.make<BridgeStatus>(initialStatus)
  /** Titles reported by content scripts (more reliable than tab.title during SPA navigation). */
  const titles = new Map<number, string>()
  let socket: WebSocket | null = null

  const send = (message: ClientMessage) =>
    Effect.sync(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(encodeClient(message))
    })

  /**
   * Picks the YouTube tab to follow:
   *  1. the active tab of the focused window, if it is a video
   *  2. the previously followed tab, if it still shows a video
   *  3. an audible video tab, else the most recently used video tab
   */
  const pickVideo = Effect.gen(function*() {
    const [focused, all] = yield* Effect.promise(() =>
      Promise.all([
        chrome.tabs.query({ active: true, lastFocusedWindow: true }),
        chrome.tabs.query({ url: ["*://*.youtube.com/*", "*://youtu.be/*"] })
      ])
    )
    const videoTabs = all.filter(isVideoTab)
    const active = focused.find(isVideoTab)
    if (active) return toVideo(active, titles)
    const previous = yield* SubscriptionRef.get(current)
    const stillOpen = previous && videoTabs.find((t) => t.id === previous.tabId)
    if (stillOpen) return toVideo(stillOpen, titles)
    const fallback = videoTabs.find((t) => t.audible) ??
      [...videoTabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]
    return fallback ? toVideo(fallback, titles) : null
  })

  const refresh = pickVideo.pipe(
    Effect.flatMap((video) =>
      SubscriptionRef.modify(current, (prev) => [!sameVideo(prev, video), sameVideo(prev, video) ? prev : video])
    ),
    Effect.catchCause(() => Effect.void)
  )

  // Tab signals -> recompute (debounced so bursts of tab events cost one query).
  yield* Stream.fromQueue(signals).pipe(
    Stream.debounce("120 millis"),
    Stream.runForEach(() => refresh),
    Effect.forkChild
  )

  // Current video -> desktop + popup status.
  yield* SubscriptionRef.changes(current).pipe(
    Stream.runForEach((video) =>
      send({ _tag: "ActiveVideo", video }).pipe(
        Effect.andThen(SubscriptionRef.update(status, (s) => ({ ...s, video })))
      )
    ),
    Effect.forkChild
  )

  yield* SubscriptionRef.changes(status).pipe(
    Stream.runForEach((s) => Effect.promise(() => chrome.storage.session.set({ [STATUS_KEY]: s }))),
    Effect.forkChild
  )

  // Content scripts -> desktop (only the followed tab is forwarded).
  yield* Stream.fromQueue(contentInbox).pipe(
    Stream.runForEach(({ tabId, message }) =>
      Effect.gen(function*() {
        const video = yield* SubscriptionRef.get(current)
        if (message._tag === "Title") {
          titles.set(tabId, message.title)
          if (video?.tabId === tabId && video.videoId === message.videoId && video.title !== message.title) {
            yield* SubscriptionRef.set(current, { ...video, title: message.title })
          }
          return
        }
        if (video?.tabId !== tabId || video.videoId !== message.playback.videoId) return
        yield* send({ _tag: "Playback", playback: message.playback })
      })
    ),
    Effect.forkChild
  )

  // Desktop -> content script (seek requests from the piano roll).
  yield* Stream.fromQueue(serverInbox).pipe(
    Stream.runForEach((message) =>
      Effect.gen(function*() {
        if (message._tag !== "Seek") return
        const video = yield* SubscriptionRef.get(current)
        if (!video || video.videoId !== message.videoId) return
        yield* Effect.promise(() =>
          chrome.tabs.sendMessage(video.tabId, { _tag: "Seek", videoId: message.videoId, time: message.time })
            .catch(() => undefined)
        )
      })
    ),
    Effect.forkChild
  )

  // One connection attempt; completes when the socket closes.
  const connectOnce = Effect.callback<boolean>((resume) => {
    let opened = false
    const ws = new WebSocket(BRIDGE_URL)
    ws.onopen = () => {
      opened = true
      socket = ws
      const video = SubscriptionRef.getUnsafe(current)
      ws.send(encodeClient({ _tag: "Hello", version: PROTOCOL_VERSION }))
      ws.send(encodeClient({ _tag: "ActiveVideo", video }))
      Effect.runFork(SubscriptionRef.update(status, (s) => ({ ...s, connected: true, lastError: null })))
    }
    ws.onmessage = (event) => {
      const exit = decodeServer(String(event.data))
      if (Exit.isSuccess(exit)) Queue.offerUnsafe(serverInbox, exit.value)
    }
    ws.onclose = () => {
      if (socket === ws) socket = null
      resume(Effect.succeed(opened))
    }
    return Effect.sync(() => ws.close())
  })

  // Reconnect forever with capped backoff. While connected, a ping every 20s
  // keeps the MV3 service worker alive (Chrome >= 116).
  yield* Effect.gen(function*() {
    let delay = 1000
    while (true) {
      const keepAlive = yield* Effect.forkChild(
        Effect.sleep("20 seconds").pipe(Effect.andThen(send({ _tag: "Ping" })), Effect.forever)
      )
      const wasOpen = yield* connectOnce
      yield* Fiber.interrupt(keepAlive)
      yield* SubscriptionRef.update(status, (s) => ({
        ...s,
        connected: false,
        lastError: "Desktop app not reachable on " + BRIDGE_URL
      }))
      delay = wasOpen ? 1000 : Math.min(delay * 2, 15000)
      yield* Effect.sleep(delay)
    }
  }).pipe(Effect.forkChild)

  poke("wake")
  return yield* Effect.never
})

Effect.runFork(program)

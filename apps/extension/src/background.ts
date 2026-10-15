import {
  BRIDGE_URL,
  cleanTabTitle,
  type ClientMessage,
  ClientMessageJson,
  ContentMessage,
  isEligibleDuration,
  parseVideoId,
  PROTOCOL_VERSION,
  type ServerMessage,
  ServerMessageJson,
  type Video,
  watchUrl
} from "@floatfall/protocol"
import { Effect, Exit, Fiber, Queue, Schema, Stream, SubscriptionRef } from "effect"
import { type BridgeStatus, initialStatus, type Skipped, STATUS_KEY } from "./status"

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
const installs = Effect.runSync(Queue.sliding<void>(1))
chrome.runtime.onInstalled.addListener(() => {
  Queue.offerUnsafe(installs, undefined)
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

type VideoTab = chrome.tabs.Tab & { id: number; url: string }

const isVideoTab = (tab: chrome.tabs.Tab): tab is VideoTab => tab.id !== undefined && parseVideoId(tab.url) !== null

/** Duration of the main video per tab, as reported by the content script. */
type DurationEntry = { readonly videoId: string; readonly duration: number | null }
const DURATIONS_KEY = "floatfall.durations"

const toVideo = (tab: VideoTab, titles: Map<number, string>): Video => {
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

  // Durations survive service-worker restarts via storage.session (content
  // scripts only re-report when the duration changes).
  const durations = new Map<number, DurationEntry>(
    yield* Effect.promise(() =>
      chrome.storage.session.get(DURATIONS_KEY).then((items) =>
        Object.entries((items[DURATIONS_KEY] ?? {}) as Record<string, DurationEntry>).map(
          ([tabId, entry]) => [Number(tabId), entry] as const
        )
      )
    )
  )
  const persistDurations = Effect.promise(() =>
    chrome.storage.session.set({ [DURATIONS_KEY]: Object.fromEntries(durations) }).catch(() => undefined)
  )

  /** Known duration of the video currently shown in `tab`, if reported. */
  const durationOf = (tab: VideoTab): number | null | undefined => {
    const entry = durations.get(tab.id)
    return entry && entry.videoId === parseVideoId(tab.url) ? entry.duration : undefined
  }
  const isEligible = (tab: VideoTab) => isEligibleDuration(durationOf(tab))

  const send = (message: ClientMessage) =>
    Effect.sync(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(encodeClient(message))
    })

  /**
   * Picks the YouTube tab to follow. Only videos up to MAX_VIDEO_SECONDS are
   * eligible (unknown duration, live streams and longer videos are ignored):
   *  1. the active tab of the focused window, if it is an eligible video
   *  2. the previously followed tab, if it still shows an eligible video
   *  3. an audible eligible tab, else the most recently used eligible tab
   */
  const pickVideo = Effect.gen(function*() {
    const [focused, all] = yield* Effect.promise(() =>
      Promise.all([
        chrome.tabs.query({ active: true, lastFocusedWindow: true }),
        chrome.tabs.query({ url: ["*://*.youtube.com/*", "*://youtu.be/*"] })
      ])
    )
    const videoTabs = all.filter(isVideoTab)

    // Forget tabs that are gone.
    const open = new Set(videoTabs.map((t) => t.id))
    let pruned = false
    for (const tabId of durations.keys()) {
      if (!open.has(tabId)) pruned = durations.delete(tabId) || pruned
    }
    if (pruned) yield* persistDurations

    const activeTab = focused.find(isVideoTab)
    const activeDuration = activeTab ? durationOf(activeTab) : undefined
    const skipped: Skipped | null = activeTab && activeDuration !== undefined && !isEligibleDuration(activeDuration)
      ? { title: titles.get(activeTab.id) || cleanTabTitle(activeTab.title), duration: activeDuration }
      : null

    const eligible = videoTabs.filter(isEligible)
    const pick = (): VideoTab | undefined => {
      if (activeTab && isEligible(activeTab)) return activeTab
      const previous = SubscriptionRef.getUnsafe(current)
      const stillOpen = previous && eligible.find((t) => t.id === previous.tabId)
      if (stillOpen) return stillOpen
      return eligible.find((t) => t.audible) ??
        [...eligible].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]
    }
    const tab = pick()
    return { video: tab ? toVideo(tab, titles) : null, skipped }
  })

  const refresh = pickVideo.pipe(
    Effect.flatMap(({ video, skipped }) =>
      SubscriptionRef.update(current, (prev) => (sameVideo(prev, video) ? prev : video)).pipe(
        Effect.andThen(
          SubscriptionRef.update(status, (s) =>
            s.skipped?.title === skipped?.title && s.skipped?.duration === skipped?.duration ? s : { ...s, skipped }
          )
        )
      )
    ),
    Effect.catchCause(() => Effect.void)
  )

  // After install/update: keep-alive alarm + inject the content script into
  // YouTube tabs that were already open (they need it to report durations).
  yield* Stream.fromQueue(installs).pipe(
    Stream.runForEach(() =>
      Effect.promise(async () => {
        await chrome.alarms.create("floatfall-keepalive", { periodInMinutes: 0.5 })
        const tabs = await chrome.tabs.query({ url: ["*://*.youtube.com/*"] })
        await Promise.all(
          tabs.map((tab) =>
            tab.id === undefined || tab.discarded
              ? undefined
              : chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => undefined)
          )
        )
      })
    ),
    Effect.forkChild
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
        if (message._tag === "Duration") {
          const prev = durations.get(tabId)
          if (prev?.videoId === message.videoId && prev.duration === message.duration) return
          durations.set(tabId, { videoId: message.videoId, duration: message.duration })
          yield* persistDurations
          poke() // eligibility may have changed
          return
        }
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

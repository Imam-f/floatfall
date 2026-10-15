// Runs on youtube.com pages. Deliberately dependency-free (no Effect runtime)
// because it is injected into every YouTube tab; it only reports playback
// state and applies seeks. All listeners do constant-time work.

import { cleanTabTitle, parseVideoId } from "@floatfall/protocol/lite"
import type { BackgroundToContent, ContentMessage } from "@floatfall/protocol"

const DRIFT_SYNC_MS = 1000

let alive = true
let video: HTMLVideoElement | null = null
let driftTimer: ReturnType<typeof setInterval> | undefined

declare global {
  // Lets a freshly injected copy detect a still-working previous copy.
  var __floatfallContentAlive: (() => boolean) | undefined
}

const post = (message: ContentMessage) => {
  if (!alive) return
  try {
    void chrome.runtime.sendMessage(message).catch(() => undefined)
  } catch {
    // Extension was reloaded/updated: this script is orphaned, go quiet.
    teardown()
  }
}

const currentVideoId = () => parseVideoId(location.href)

const reportPlayback = () => {
  const id = currentVideoId()
  if (!video || !id) return
  post({
    _tag: "Playback",
    playback: {
      videoId: id,
      time: video.currentTime,
      rate: video.playbackRate,
      paused: video.paused || video.ended || video.readyState < 2
    }
  })
}

const reportTitle = () => {
  const id = currentVideoId()
  if (!id) return
  const heading = document.querySelector("h1.ytd-watch-metadata, h1.title")?.textContent?.trim()
  const title = heading || cleanTabTitle(document.title)
  if (title) post({ _tag: "Title", videoId: id, title })
}

/** True while YouTube is playing a pre/mid-roll ad in the main player. */
const adShowing = () => !!document.querySelector("#movie_player.ad-showing, .html5-video-player.ad-showing")

let lastDuration: { videoId: string; duration: number | null } | null = null

const reportDuration = () => {
  const id = currentVideoId()
  // During ads the <video> element reports the ad's duration; wait for the real one.
  if (!video || !id || adShowing()) return
  const raw = video.duration
  if (Number.isNaN(raw)) return // metadata not loaded yet
  const duration = Number.isFinite(raw) ? raw : null // Infinity => live stream
  if (lastDuration?.videoId === id && lastDuration.duration === duration) return
  lastDuration = { videoId: id, duration }
  post({ _tag: "Duration", videoId: id, duration })
}

const updateDriftTimer = () => {
  const playing = !!video && !video.paused
  if (playing && driftTimer === undefined) {
    driftTimer = setInterval(() => {
      // Also catches the real duration once an ad finishes (deduped, cheap).
      reportDuration()
      reportPlayback()
    }, DRIFT_SYNC_MS)
  }
  if (!playing && driftTimer !== undefined) {
    clearInterval(driftTimer)
    driftTimer = undefined
  }
}

const onMediaEvent = () => {
  reportDuration()
  reportPlayback()
  updateDriftTimer()
}

const EVENTS = [
  "play",
  "playing",
  "pause",
  "seeked",
  "ratechange",
  "waiting",
  "ended",
  "loadedmetadata",
  "durationchange"
] as const

function detach() {
  if (video) for (const event of EVENTS) video.removeEventListener(event, onMediaEvent)
  video = null
  if (driftTimer !== undefined) clearInterval(driftTimer)
  driftTimer = undefined
}

const attach = () => {
  const next = document.querySelector<HTMLVideoElement>("video.html5-main-video") ??
    document.querySelector<HTMLVideoElement>("#movie_player video, video")
  if (next === video) return
  detach()
  video = next
  if (!video) return
  for (const event of EVENTS) video.addEventListener(event, onMediaEvent)
  onMediaEvent()
}

const onNavigate = () => {
  lastDuration = null
  attach()
  reportPlayback()
  // The title DOM settles shortly after SPA navigation.
  setTimeout(reportTitle, 800)
}

// The player element may appear after document_idle.
const observer = new MutationObserver(() => {
  if (!video || !video.isConnected) attach()
})

const onSeek = (raw: BackgroundToContent) => {
  if (raw?._tag !== "Seek" || typeof raw.time !== "number" || raw.videoId !== currentVideoId() || !video) return
  video.currentTime = Math.max(0, Math.min(raw.time, Number.isFinite(video.duration) ? video.duration : raw.time))
}

function teardown() {
  alive = false
  detach()
  observer.disconnect()
  document.removeEventListener("yt-navigate-finish", onNavigate)
  window.removeEventListener("pageshow", onNavigate)
}

// The background re-injects this script into open tabs after an extension
// install/reload. Skip if a working copy is already running here.
if (!globalThis.__floatfallContentAlive?.()) {
  globalThis.__floatfallContentAlive = () => {
    // An orphaned copy loses its runtime id.
    if (alive && !chrome.runtime?.id) teardown()
    return alive
  }
  document.addEventListener("yt-navigate-finish", onNavigate)
  window.addEventListener("pageshow", onNavigate)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  chrome.runtime.onMessage.addListener(onSeek)
  onNavigate()
}

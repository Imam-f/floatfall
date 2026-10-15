// Dependency-free constants and helpers (no `effect` import) so tiny bundles
// like the content script and popup can use them without pulling in the
// schema runtime.

/** Default port of the desktop app's local bridge (WebSocket). */
export const BRIDGE_PORT = 47615
export const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`
export const PROTOCOL_VERSION = 1

const VIDEO_ID = /^[\w-]{11}$/

/** Extracts the video id from any of the usual YouTube URL shapes. */
export const parseVideoId = (rawUrl: string | undefined): string | null => {
  if (!rawUrl) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "")
  let id: string | null = null
  if (host === "youtu.be") {
    id = url.pathname.slice(1).split("/")[0] ?? null
  } else if (host === "youtube.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v")
    else {
      const match = /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(url.pathname)
      id = match?.[1] ?? null
    }
  }
  return id && VIDEO_ID.test(id) ? id : null
}

export const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`

export const cleanTabTitle = (title: string | undefined) =>
  (title ?? "").replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube( Music)?$/, "").trim()

import type { Note } from "@floatfall/protocol"

export const KEYBOARD_WIDTH = 34
/** Fraction of the width where the playhead sits while following playback. */
export const PLAYHEAD_RATIO = 0.3

const BLACK = new Set([1, 3, 6, 8, 10])
export const isBlackKey = (pitch: number) => BLACK.has(((pitch % 12) + 12) % 12)

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
export const pitchName = (pitch: number) => `${NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`

/**
 * Everything derived from the note list alone. Computed once per transcription
 * (memoized by the caller) so the per-frame draw only does lookups.
 */
export interface NoteIndex {
  readonly notes: ReadonlyArray<Note>
  /** `starts[i] === notes[i].start`, typed array for a fast binary search. */
  readonly starts: Float64Array
  /** Longest note; lets the search start early enough to catch long notes. */
  readonly maxDuration: number
  readonly minPitch: number
  readonly maxPitch: number
  readonly duration: number
}

export const buildNoteIndex = (notes: ReadonlyArray<Note>): NoteIndex => {
  const starts = new Float64Array(notes.length)
  let maxDuration = 0
  let lo = Infinity
  let hi = -Infinity
  let end = 0
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]!
    starts[i] = n.start
    maxDuration = Math.max(maxDuration, n.end - n.start)
    lo = Math.min(lo, n.pitch)
    hi = Math.max(hi, n.pitch)
    end = Math.max(end, n.end)
  }
  if (notes.length === 0) {
    // Default view: C3..C6
    lo = 48
    hi = 84
  }
  // Pad and enforce at least two octaves so a sparse melody is still readable.
  lo -= 2
  hi += 2
  const missing = 24 - (hi - lo + 1)
  if (missing > 0) {
    lo -= Math.floor(missing / 2)
    hi += Math.ceil(missing / 2)
  }
  return { notes, starts, maxDuration, minPitch: lo, maxPitch: hi, duration: end }
}

/** First index whose start >= t. */
export const lowerBound = (starts: Float64Array, t: number) => {
  let lo = 0
  let hi = starts.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (starts[mid]! < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

export const noteHue = (pitch: number) => (((pitch % 12) + 12) % 12) * 30

export interface Viewport {
  readonly width: number
  readonly height: number
  readonly dpr: number
}

/**
 * Static background (keyboard + lane shading + octave lines) for a given size
 * and pitch range. Pre-rendered into an offscreen canvas and blitted per frame.
 */
export const renderBackground = (view: Viewport, minPitch: number, maxPitch: number): HTMLCanvasElement => {
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(view.width * view.dpr))
  canvas.height = Math.max(1, Math.round(view.height * view.dpr))
  const ctx = canvas.getContext("2d")!
  ctx.scale(view.dpr, view.dpr)

  const rows = maxPitch - minPitch + 1
  const rowH = view.height / rows

  ctx.fillStyle = "#12151b"
  ctx.fillRect(0, 0, view.width, view.height)

  for (let pitch = minPitch; pitch <= maxPitch; pitch++) {
    const y = (maxPitch - pitch) * rowH
    const black = isBlackKey(pitch)
    // lanes
    ctx.fillStyle = black ? "#0e1116" : "#151922"
    ctx.fillRect(KEYBOARD_WIDTH, y, view.width - KEYBOARD_WIDTH, rowH)
    // keys
    ctx.fillStyle = black ? "#22262e" : "#d9dde4"
    ctx.fillRect(0, y, KEYBOARD_WIDTH - 1, rowH)
    if (pitch % 12 === 0) {
      ctx.fillStyle = "#2b3140"
      ctx.fillRect(KEYBOARD_WIDTH, y + rowH - 1, view.width - KEYBOARD_WIDTH, 1)
      if (rowH >= 7) {
        ctx.fillStyle = "#59606d"
        ctx.font = `${Math.min(10, rowH)}px system-ui, sans-serif`
        ctx.textBaseline = "bottom"
        ctx.fillText(pitchName(pitch), 2, y + rowH)
      }
    } else if (!black && !isBlackKey(pitch + 1)) {
      // E-F and B-C boundaries
      ctx.fillStyle = "#9aa0aa"
      ctx.fillRect(0, y, KEYBOARD_WIDTH - 1, 0.5)
    }
  }
  ctx.fillStyle = "#000"
  ctx.fillRect(KEYBOARD_WIDTH - 1, 0, 1, view.height)
  return canvas
}

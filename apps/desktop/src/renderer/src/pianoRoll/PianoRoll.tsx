import type { Note } from "@floatfall/protocol"
import { memo, type PointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { currentTime, isPlaying, seek, subscribePlayback } from "../store"
import { readMicrophoneState, readPitch, readPitchHistory, subscribeMicrophone, subscribePitch } from "../microphone/store"
import { noteFromFrequency } from "../microphone/pitch"
import {
  buildNoteIndex,
  KEYBOARD_WIDTH,
  lowerBound,
  type NoteIndex,
  noteHue,
  PLAYHEAD_RATIO,
  renderBackground,
  type Viewport
} from "./geometry"

const MIN_PPS = 15
const MAX_PPS = 800

interface FrameInputs {
  index: NoteIndex
  background: HTMLCanvasElement | null
  view: Viewport | null
}

interface Camera {
  /** Pixels per second. */
  pps: number
  /** Manual pan offset in seconds (only while paused). */
  pan: number
}

const playheadX = (view: Viewport) => KEYBOARD_WIDTH + (view.width - KEYBOARD_WIDTH) * PLAYHEAD_RATIO

/** Pure draw of one frame. Only walks notes that are on screen. */
const drawFrame = (ctx: CanvasRenderingContext2D, inputs: FrameInputs, camera: Camera, time: number) => {
  const { index, background, view } = inputs
  if (!view || !background) return
  const { width, height, dpr } = view
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(background, 0, 0)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const rows = index.maxPitch - index.minPitch + 1
  const rowH = height / rows
  const px = playheadX(view)
  const viewTime = time + camera.pan
  const t0 = viewTime - (px - KEYBOARD_WIDTH) / camera.pps
  const t1 = viewTime + (width - px) / camera.pps
  const xOf = (t: number) => px + (t - viewTime) * camera.pps

  ctx.save()
  ctx.beginPath()
  ctx.rect(KEYBOARD_WIDTH, 0, width - KEYBOARD_WIDTH, height)
  ctx.clip()

  // second grid (every 1s, stronger every 5s), thinned when zoomed out
  const step = camera.pps < 40 ? 5 : 1
  for (let s = Math.ceil(t0 / step) * step; s <= t1; s += step) {
    if (s < 0) continue
    ctx.fillStyle = s % 5 === 0 ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.04)"
    ctx.fillRect(Math.round(xOf(s)), 0, 1, height)
  }

  const active: Array<Note> = []
  const { notes, starts } = index
  const radius = Math.min(3, rowH / 3)
  for (let i = lowerBound(starts, t0 - index.maxDuration); i < notes.length && starts[i]! <= t1; i++) {
    const n = notes[i]!
    if (n.end < t0 || n.pitch < index.minPitch || n.pitch > index.maxPitch) continue
    const isActive = n.start <= time && time < n.end
    if (isActive) active.push(n)
    const x = xOf(n.start)
    const w = Math.max(2, (n.end - n.start) * camera.pps - 1)
    const y = (index.maxPitch - n.pitch) * rowH + 0.5
    const h = Math.max(2, rowH - 1)
    const vel = n.velocity ?? 0.8
    const hue = noteHue(n.pitch)
    ctx.fillStyle = isActive
      ? `hsl(${hue} 95% 70%)`
      : n.end < time
      ? `hsla(${hue} 55% 50% / ${0.35 + vel * 0.3})`
      : `hsla(${hue} 75% 58% / ${0.55 + vel * 0.45})`
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, radius)
    ctx.fill()
  }
  ctx.restore()

  // highlight sounding keys on the keyboard
  for (const n of active) {
    const y = (index.maxPitch - n.pitch) * rowH
    ctx.fillStyle = `hsl(${noteHue(n.pitch)} 95% 62%)`
    ctx.fillRect(0, y, KEYBOARD_WIDTH - 1, rowH)
  }

  // playhead
  ctx.fillStyle = camera.pan === 0 ? "#ff5a5f" : "rgba(255,90,95,0.45)"
  ctx.fillRect(Math.round(xOf(time)) - 1, 0, 2, height)

  const frame = readPitch()
  const shift = readMicrophoneState().octaveUp ? 2 : 1
  const shiftedNote = (frequency: number | null) => noteFromFrequency(frequency ? frequency * shift : null)
  const now = Date.now()
  // Only the microphone trail is shifted. Song notes above keep their recorded pitches.
  ctx.save()
  ctx.beginPath(); ctx.rect(KEYBOARD_WIDTH, 0, width - KEYBOARD_WIDTH, height); ctx.clip()
  ctx.strokeStyle = "#67e8c4"; ctx.lineWidth = 2.5; ctx.beginPath()
  let previous: number | null = null
  for (const point of readPitchHistory()) {
    const note = shiftedNote(point.frequency)
    if (!note || now - point.at > 12000) { previous = null; continue }
    const x = xOf(time) - (now - point.at) / 1000 * camera.pps
    const y = (index.maxPitch - note.midi + 0.5) * rowH
    if (previous === null || point.at - previous > 250) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
    previous = point.at
  }
  ctx.stroke(); ctx.restore()
  const voice = frame && now - frame.at < 400 ? shiftedNote(frame.frequency) : null
  if (voice && voice.midi >= index.minPitch - 0.5 && voice.midi <= index.maxPitch + 0.5) {
    const y = (index.maxPitch - voice.midi + 0.5) * rowH
    ctx.save()
    ctx.strokeStyle = "#67e8c4"
    ctx.lineWidth = 2
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.moveTo(KEYBOARD_WIDTH, y)
    ctx.lineTo(width, y)
    ctx.stroke()
    ctx.fillStyle = "#67e8c4"
    ctx.beginPath()
    ctx.arc(px, y, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

export const PianoRoll = memo(function PianoRoll({ notes }: { readonly notes: ReadonlyArray<Note> }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [view, setView] = useState<Viewport | null>(null)

  // Heavy-ish derived data: recomputed only when its inputs change.
  const index = useMemo(() => buildNoteIndex(notes), [notes])
  const background = useMemo(
    () => (view ? renderBackground(view, index.minPitch, index.maxPitch) : null),
    [view, index.minPitch, index.maxPitch]
  )

  const inputs = useRef<FrameInputs>({ index, background, view })
  const camera = useRef<Camera>({ pps: 120, pan: 0 })
  const dirty = useRef(true)

  useLayoutEffect(() => {
    inputs.current = { index, background, view }
    dirty.current = true
  }, [index, background, view])

  // Track size. The observer callback only stores numbers; the background
  // bitmap is rebuilt by useMemo above, outside of the callback.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      const dpr = window.devicePixelRatio || 1
      setView((prev) =>
        prev && prev.width === width && prev.height === height && prev.dpr === dpr ? prev : { width, height, dpr }
      )
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !view) return
    canvas.width = Math.round(view.width * view.dpr)
    canvas.height = Math.round(view.height * view.dpr)
    dirty.current = true
  }, [view])

  // Single animation loop for the lifetime of the component. It redraws only
  // while playing or after something marked the frame dirty.
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!ctx) return
    const unsubscribe = subscribePlayback(() => {
      if (isPlaying()) camera.current.pan = 0
      dirty.current = true
    })
    const unsubscribePitch = subscribePitch(() => { dirty.current = true })
    const unsubscribeMicrophone = subscribeMicrophone(() => { dirty.current = true })
    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      if (document.hidden) return
      if (!dirty.current && !isPlaying()) return
      dirty.current = false
      drawFrame(ctx, inputs.current, camera.current, currentTime())
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      unsubscribe()
      unsubscribePitch()
      unsubscribeMicrophone()
    }
  }, [])

  // Native non-passive wheel listener so we can preventDefault. Handler just
  // mutates the camera and flags a redraw.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const cam = camera.current
      const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      if (horizontal && !isPlaying()) {
        cam.pan += (event.shiftKey ? event.deltaY : event.deltaX) / cam.pps
      } else if (!horizontal) {
        cam.pps = Math.min(MAX_PPS, Math.max(MIN_PPS, cam.pps * Math.exp(-event.deltaY * 0.0015)))
      }
      dirty.current = true
    }
    canvas.addEventListener("wheel", onWheel, { passive: false })
    return () => canvas.removeEventListener("wheel", onWheel)
  }, [])

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const v = inputs.current.view
    if (!v || event.button !== 0) return
    const x = event.nativeEvent.offsetX
    if (x < KEYBOARD_WIDTH) return
    const cam = camera.current
    const target = currentTime() + cam.pan + (x - playheadX(v)) / cam.pps
    cam.pan = 0
    seek(target)
  }

  const onDoubleClick = () => {
    camera.current.pan = 0
    dirty.current = true
  }

  return (
    <div ref={containerRef} className="roll">
      <canvas
        ref={canvasRef}
        className="roll-canvas"
        style={view ? { width: view.width, height: view.height } : undefined}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        title="Click to seek · Wheel to zoom · Shift+wheel to scroll (paused)"
      />
    </div>
  )
})

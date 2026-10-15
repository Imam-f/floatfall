import { memo, useEffect, useRef } from "react"
import { PITCH_HISTORY_MS } from "../../../shared/microphone"
import { noteFromFrequency } from "./pitch"
import { readPitchHistory, usePitch } from "./store"

/** Bounded rolling history; gaps represent silence or uncertain pitch. */
export const PitchHistory = memo(function PitchHistory({ octaveUp }: { readonly octaveUp: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frame = usePitch()
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const draw = () => {
      const width = canvas.clientWidth, height = canvas.clientHeight
      if (!width || !height) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr)
      ctx.scale(dpr, dpr); ctx.clearRect(0, 0, width, height)
      const now = Date.now()
      const points = readPitchHistory().filter((p) => now - p.at <= PITCH_HISTORY_MS)
        .map((p) => ({ at: p.at, note: noteFromFrequency(p.frequency ? p.frequency * (octaveUp ? 2 : 1) : null) }))
      const pitches = points.flatMap((p) => p.note ? [p.note.midi] : [])
      const center = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : (octaveUp ? 81 : 69)
      const lo = Math.floor(Math.min(center - 6, ...pitches.map((p) => p - 2)))
      const hi = Math.ceil(Math.max(center + 6, ...pitches.map((p) => p + 2)))
      const left = 27, right = width - 4, top = 7, bottom = height - 14
      const y = (midi: number) => bottom - (midi - lo) / (hi - lo) * (bottom - top)
      const x = (at: number) => right - (now - at) / PITCH_HISTORY_MS * (right - left)
      ctx.font = "9px system-ui, sans-serif"; ctx.textBaseline = "middle"
      for (let midi = lo; midi <= hi; midi++) {
        ctx.strokeStyle = midi % 12 === 0 ? "#40594b" : "#24382f"
        ctx.beginPath(); ctx.moveTo(left, y(midi)); ctx.lineTo(right, y(midi)); ctx.stroke()
      }
      for (const midi of [lo, Math.round((lo + hi) / 2), hi]) {
        const note = noteFromFrequency(440 * 2 ** ((midi - 69) / 12))!
        ctx.fillStyle = "#8baa99"; ctx.fillText(`${note.name}${note.octave}`, 0, y(midi))
      }
      ctx.fillStyle = "#789382"; ctx.textBaseline = "bottom"; ctx.fillText("−12s", left, height)
      ctx.textAlign = "right"; ctx.fillText("now", right, height); ctx.textAlign = "left"
      ctx.lineWidth = 1.7; ctx.strokeStyle = "#67e8c4"; ctx.beginPath()
      let previous: number | null = null
      for (const point of points) {
        if (!point.note) { previous = null; continue }
        const px = x(point.at), py = y(point.note.midi)
        if (previous === null || point.at - previous > 250) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
        previous = point.at
      }
      ctx.stroke()
      const latest = points.at(-1)
      if (latest?.note) {
        ctx.fillStyle = "#a3ffe0"; ctx.beginPath(); ctx.arc(x(latest.at), y(latest.note.midi), 2.5, 0, Math.PI * 2); ctx.fill()
      }
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [frame, octaveUp])
  return <canvas ref={canvasRef} className="voice-history-canvas" role="img" aria-label="Singing pitch history for the last 12 seconds" />
})

import { memo, useEffect, useRef } from "react"
import { PITCH_HISTORY_MS, SPECTRUM_BINS, type PitchFrame } from "../../../shared/microphone"
import { readPitchHistory } from "./store"

// Dark violet through electric blue and mint to a warm, bright core.
const STOPS = [[0, 7, 14, 22], [0.18, 29, 20, 68], [0.4, 51, 60, 164],
  [0.62, 31, 181, 207], [0.8, 103, 232, 196], [1, 255, 240, 170]]
const COLORS = Array.from({ length: 256 }, (_, value) => {
  const intensity = value / 255
  const index = Math.min(STOPS.length - 2, STOPS.findIndex((stop) => stop[0]! >= intensity) - 1)
  const a = STOPS[Math.max(0, index)]!, b = STOPS[Math.max(0, index) + 1]!
  const mix = Math.max(0, (intensity - a[0]!) / (b[0]! - a[0]!))
  return [1, 2, 3].map((channel) => Math.round(a[channel]! + (b[channel]! - a[channel]!) * mix))
})
const COLUMNS = 240

/** Actual microphone FFT history; keeps harmonics and unpitched sound visible. */
export const Spectrogram = memo(function Spectrogram({ octaveUp }: { readonly octaveUp: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const field = document.createElement("canvas")
    field.width = COLUMNS; field.height = SPECTRUM_BINS
    const fieldCtx = field.getContext("2d")
    if (!fieldCtx) return
    let previous: ReadonlyArray<PitchFrame> | undefined
    let fieldEnd = 0
    let animation = 0
    let lastDraw = 0
    const draw = (time: number) => {
      animation = requestAnimationFrame(draw)
      if (time - lastDraw < 1000 / 30) return
      lastDraw = time
      const width = canvas.clientWidth, height = canvas.clientHeight
      if (!width || !height) return
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      const history = readPitchHistory()
      const now = Date.now()
      if (history !== previous) {
        previous = history
        fieldEnd = history.at(-1)?.at ?? now
        const pixels = fieldCtx.createImageData(COLUMNS, SPECTRUM_BINS)
        for (let offset = 0; offset < pixels.data.length; offset += 4) {
          pixels.data[offset] = 7; pixels.data[offset + 1] = 14
          pixels.data[offset + 2] = 22; pixels.data[offset + 3] = 255
        }
        for (let i = 0; i < history.length; i++) {
          const point = history[i]!
          if (!point.spectrum) continue
          // A frame covers its sample interval. Missing audio leaves a dark gap.
          const start = Math.max(0, Math.floor((point.at - fieldEnd + PITCH_HISTORY_MS - 60) / PITCH_HISTORY_MS * COLUMNS))
          const end = Math.min(COLUMNS, Math.ceil((Math.min(history[i + 1]?.at ?? point.at, point.at + 90) - fieldEnd + PITCH_HISTORY_MS) / PITCH_HISTORY_MS * COLUMNS))
          for (let band = 0; band < SPECTRUM_BINS; band++) {
            const color = COLORS[point.spectrum[band] ?? 0]!
            for (let column = start; column < end; column++) {
              const offset = ((SPECTRUM_BINS - 1 - band) * COLUMNS + column) * 4
              pixels.data[offset] = color[0]!
              pixels.data[offset + 1] = color[1]!
              pixels.data[offset + 2] = color[2]!
            }
          }
        }
        fieldCtx.putImageData(pixels, 0, 0)
      }
      const left = 25, top = 5, plotWidth = width - left - 3, plotHeight = height - top - 15
      const shift = Math.max(0, now - fieldEnd) / PITCH_HISTORY_MS * plotWidth
      ctx.save()
      ctx.beginPath(); ctx.rect(left, top, plotWidth, plotHeight); ctx.clip()
      ctx.fillStyle = "#070e16"; ctx.fillRect(left, top, plotWidth, plotHeight)
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(field, left - shift, top, plotWidth, plotHeight)
      ctx.globalCompositeOperation = "screen"
      ctx.globalAlpha = 0.45; ctx.filter = "blur(3px)"
      ctx.drawImage(field, left - shift, top, plotWidth, plotHeight)
      ctx.restore()
      ctx.font = "9px system-ui, sans-serif"; ctx.textBaseline = "middle"
      for (let octave = 0; octave <= 6; octave++) {
        const y = top + plotHeight * (1 - octave / 6)
        ctx.strokeStyle = "#b1e4d610"; ctx.lineWidth = 0.5
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + plotWidth, y); ctx.stroke()
        if (octave % 2 === 0) {
          ctx.fillStyle = "#829e9f"; ctx.fillText(`A${octave + 1 + (octaveUp ? 1 : 0)}`, 1, y)
        }
      }
      ctx.fillStyle = "#789392"; ctx.textBaseline = "bottom"
      ctx.fillText("−12s", left, height)
      ctx.textAlign = "right"; ctx.fillText("now", left + plotWidth, height); ctx.textAlign = "left"
    }
    animation = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animation)
  }, [octaveUp])
  return <canvas ref={canvasRef} className="voice-history-canvas voice-spectrum-canvas" role="img"
    aria-label="Glowing voice spectrogram for the last 12 seconds. Time runs left to right, pitch increases upward, and brighter colors indicate louder sound." />
})

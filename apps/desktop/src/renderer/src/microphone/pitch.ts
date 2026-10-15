import { PitchDetector } from "pitchy"
import type { PitchFrame } from "../../../shared/microphone"

export const PITCH_BUFFER_SIZE = 4096
const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"]

export const noteFromFrequency = (frequency: number | null) => {
  if (frequency === null || !Number.isFinite(frequency) || frequency <= 0) return null
  const midi = 69 + 12 * Math.log2(frequency / 440)
  const nearest = Math.round(midi)
  return {
    midi, name: NAMES[((nearest % 12) + 12) % 12]!, octave: Math.floor(nearest / 12) - 1,
    cents: Math.round((midi - nearest) * 100)
  }
}

/** Reuses FFT buffers and rejects silence, noise, and pitches outside singing range. */
export class VoicePitchTracker {
  private readonly detector = PitchDetector.forFloat32Array(PITCH_BUFFER_SIZE)
  private readonly recent: number[] = []

  detect(input: Float32Array, sampleRate: number, at = Date.now()): PitchFrame {
    let mean = 0
    for (const value of input) mean += value
    mean /= input.length
    let energy = 0
    for (let i = 0; i < input.length; i++) {
      input[i] = input[i]! - mean
      energy += input[i]! * input[i]!
    }
    const level = Math.sqrt(energy / input.length)
    const [frequency, clarity] = level >= 0.0032 ? this.detector.findPitch(input, sampleRate) : [0, 0]
    if (!Number.isFinite(frequency) || frequency < 50 || frequency > 2000 || clarity < 0.9) {
      this.recent.length = 0
      return { frequency: null, clarity: Number.isFinite(clarity) ? clarity : 0, level, at }
    }
    this.recent.push(frequency)
    if (this.recent.length > 3) this.recent.shift()
    const sorted = [...this.recent].sort((a, b) => a - b)
    return { frequency: sorted[Math.floor(sorted.length / 2)]!, clarity, level, at }
  }
}

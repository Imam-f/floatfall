import { SPECTRUM_BINS, SPECTRUM_MIN_HZ, SPECTRUM_MAX_HZ } from "../../../shared/microphone"

/** Preserve harmonic peaks while compressing the FFT onto a musical frequency scale. */
export const sampleSpectrum = (fft: Uint8Array, sampleRate: number, fftSize: number): number[] => {
  const hzPerBin = sampleRate / fftSize
  const ratio = SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ
  return Array.from({ length: SPECTRUM_BINS }, (_, band) => {
    const low = SPECTRUM_MIN_HZ * ratio ** (band / SPECTRUM_BINS)
    const high = SPECTRUM_MIN_HZ * ratio ** ((band + 1) / SPECTRUM_BINS)
    const first = Math.max(1, Math.round(low / hzPerBin))
    const last = Math.min(fft.length - 1, Math.max(first, Math.round(high / hzPerBin)))
    let peak = 0
    for (let bin = first; bin <= last; bin++) peak = Math.max(peak, fft[bin]!)
    return peak
  })
}

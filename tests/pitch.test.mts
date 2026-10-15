import assert from "node:assert/strict"
import { test } from "node:test"
import { noteFromFrequency, PITCH_BUFFER_SIZE, VoicePitchTracker } from "../apps/desktop/src/renderer/src/microphone/pitch.ts"
import { appendPitchHistory } from "../apps/desktop/src/shared/microphone.ts"

const tone = (frequency: number, sampleRate: number, harmonics = [0.3]) =>
  Float32Array.from({ length: PITCH_BUFFER_SIZE }, (_, i) => harmonics.reduce((sum, amplitude, harmonic) =>
    sum + amplitude * Math.sin(2 * Math.PI * frequency * (harmonic + 1) * i / sampleRate), 0))

test("recognizes bass through soprano notes at common microphone sample rates", () => {
  for (const sampleRate of [44100, 48000]) {
    for (const frequency of [65.4064, 82.4069, 110, 220, 440, 523.2511, 880, 1046.5023]) {
      const result = new VoicePitchTracker().detect(tone(frequency, sampleRate), sampleRate)
      assert.notEqual(result.frequency, null, `${frequency} Hz at ${sampleRate}`)
      assert.ok(Math.abs(1200 * Math.log2(result.frequency! / frequency)) < 2, `pitch accuracy at ${frequency} Hz`)
    }
  }
})

test("tracks the fundamental when harmonics are louder than it", () => {
  const result = new VoicePitchTracker().detect(tone(220, 48000, [0.08, 0.4, 0.25]), 48000)
  assert.ok(result.frequency !== null && Math.abs(result.frequency - 220) < 1)
})

test("rejects silence, DC offsets, quiet input, noise, and out-of-range tones", () => {
  const tracker = new VoicePitchTracker()
  let seed = 7123
  const noise = Float32Array.from({ length: PITCH_BUFFER_SIZE }, () => {
    seed = (1664525 * seed + 1013904223) >>> 0
    return ((seed / 2 ** 32) * 2 - 1) * 0.2
  })
  for (const input of [new Float32Array(PITCH_BUFFER_SIZE), new Float32Array(PITCH_BUFFER_SIZE).fill(0.2),
    tone(440, 48000, [0.001]), noise, tone(30, 48000), tone(2500, 48000)]) {
    assert.equal(tracker.detect(input, 48000).frequency, null)
  }
})

test("smooths one-frame jumps but releases the note immediately on silence", () => {
  const tracker = new VoicePitchTracker()
  for (let i = 0; i < 3; i++) tracker.detect(tone(440, 48000), 48000)
  assert.ok(Math.abs(tracker.detect(tone(660, 48000), 48000).frequency! - 440) < 1)
  assert.ok(Math.abs(tracker.detect(tone(660, 48000), 48000).frequency! - 660) < 1)
  assert.equal(tracker.detect(new Float32Array(PITCH_BUFFER_SIZE), 48000).frequency, null)
  assert.ok(Math.abs(tracker.detect(tone(220, 48000), 48000).frequency! - 220) < 1)
})

test("converts frequency to note, octave and signed cents", () => {
  assert.deepEqual(noteFromFrequency(440), { midi: 69, name: "A", octave: 4, cents: 0 })
  assert.equal(noteFromFrequency(440 * 2 ** (18 / 1200))!.cents, 18)
  assert.equal(noteFromFrequency(440 * 2 ** (-22 / 1200))!.cents, -22)
  assert.equal(noteFromFrequency(261.625565)!.name, "C")
  assert.equal(noteFromFrequency(261.625565)!.octave, 4)
  for (const frequency of [null, NaN, Infinity, 0, -440]) assert.equal(noteFromFrequency(frequency), null)
})

test("pitch history is bounded, expires old samples, preserves gaps and deduplicates docking updates", () => {
  let history = [] as ReturnType<typeof appendPitchHistory>
  for (let at = 0; at <= 20000; at += 60) {
    history = appendPitchHistory(history, { at, frequency: at === 19980 ? null : 440, clarity: 1, level: 0.1 })
  }
  assert.ok(history.length <= 240)
  assert.ok(history[0]!.at >= 19980 - 12000)
  assert.equal(history.at(-1)!.frequency, null)
  const length = history.length
  history = appendPitchHistory(history, history.at(-1)!)
  assert.equal(history.length, length)
})

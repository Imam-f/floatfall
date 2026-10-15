// Placeholder transcriber used to test the pipeline before a real model is
// plugged in. Contract (same for the real one):
//   argv: <input.wav> <output.json>
//   write: { "notes": [{ "pitch": <midi>, "start": <sec>, "end": <sec>, "velocity"?: 0..1 }] }
//   print progress lines containing "NN%" to stdout (optional).
import { readFileSync, statSync, writeFileSync } from "node:fs"

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error("usage: fake-transcriber.mjs <input.wav> <output.json>")
  process.exit(2)
}

// Estimate duration from a 16-bit PCM WAV header (good enough for a stub).
const header = readFileSync(input).subarray(0, 44)
const byteRate = header.readUInt32LE(28) || 88200
const duration = Math.max(1, (statSync(input).size - 44) / byteRate)

const scale = [60, 62, 64, 65, 67, 69, 71, 72]
const notes = []
for (let t = 0, i = 0; t < duration; t += 0.5, i++) {
  notes.push({ pitch: scale[i % scale.length], start: t, end: t + 0.4, velocity: 0.7 })
  if (i % 40 === 0) console.log(`${Math.round((t / duration) * 100)}%`)
}
writeFileSync(output, JSON.stringify({ notes }))
console.log("100%")

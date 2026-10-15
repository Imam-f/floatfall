// Placeholder vocal separator. Contract (same for the real one):
//   argv: <input.wav> <output.wav>
//   write: the isolated vocal track to <output.wav>
//   print progress lines containing "NN%" to stdout (optional).
import { copyFileSync } from "node:fs"

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error("usage: passthrough-separator.mjs <input.wav> <output.wav>")
  process.exit(2)
}
copyFileSync(input, output)
console.log("100%")

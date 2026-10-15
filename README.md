<img src="assets/icon.svg" width="64" height="64" alt="">

# floatfall

A Chrome extension and an Electron app that work together. The extension finds the YouTube video you are watching. The desktop app then:

1. downloads a low-quality copy with `yt-dlp`,
2. extracts mono WAV audio with `ffmpeg`,
3. optionally cleans the vocals with **your** separator command,
4. transcribes the melody with **your** transcription command,
5. shows the notes as a piano roll in a small frameless window that stays on top of other windows. The roll follows the YouTube playhead. Click the roll to seek the video.

The separator and the transcription model are wrappers only. You add the real models later in `settings.json`.

```
apps/extension   Chrome MV3 extension (Effect background worker, tiny content script, React popup)
apps/desktop     Electron app (Effect services in main, React + canvas renderer)
packages/protocol  Shared Effect Schemas for the WebSocket protocol and note format
examples/        Stub separator/transcriber scripts for testing the pipeline
```

## Setup

Requirements: Node 22+, plus `yt-dlp` and `ffmpeg` on your PATH (or set absolute paths in settings).

```powershell
npm.cmd install
npm.cmd run build:extension   # -> apps/extension/dist
npm.cmd run dev               # starts the desktop app (Electron downloads itself on first run)
```

To load the extension, open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and select `apps/extension/dist`.

The extension connects to `ws://127.0.0.1:47615`. The green dot in the window title bar shows that it is connected.

## Plugging in models

Click the settings icon in the title bar to open `settings.json`. It lives in Electron's `userData` folder. The app reloads the file when you save it.

```jsonc
{
  "ytDlpPath": "yt-dlp",
  "ffmpegPath": "ffmpeg",
  "downloadFormat": "worst[acodec!=none]/worstaudio/worst", // yt-dlp -f selector
  "sampleRate": 44100,
  "cacheDir": "",              // empty = <userData>/cache
  "cleanVocals": false,        // also toggled from the window
  "autoTranscribe": true,      // also toggled from the window
  "separator": {
    "command": "python",
    "args": ["C:/models/separate.py", "{input}", "{output}"]
  },
  "transcriber": {
    "command": "python",
    "args": ["C:/models/melody.py", "--in", "{input}", "--out", "{output}"],
    "output": "json"           // or "midi"
  }
}
```

You can use these placeholders in `args`: `{input}`, `{output}`, `{outputDir}`, `{videoId}`, `{sampleRate}`.

Your separator and transcriber commands must follow these rules:

- **Separator:** read the mono WAV at `{input}` and write the vocal stem as a WAV to `{output}`.
- **Transcriber:** read the WAV at `{input}` and write the notes to `{output}`:
  - JSON format: `{"notes":[{"pitch":60,"start":1.25,"end":1.5,"velocity":0.8}]}` or a bare array. `pitch` is a MIDI note number and times are in seconds.
  - MIDI format: a standard `.mid` file.
- **Progress (optional):** print lines that contain `NN%` and the title bar shows a progress bar. A non-zero exit code shows the last lines of the tool's output in the window.

To test the plumbing without a real model, use the stubs in `examples/`:

```jsonc
"separator":   { "command": "node", "args": ["<repo>/examples/passthrough-separator.mjs", "{input}", "{output}"] },
"transcriber": { "command": "node", "args": ["<repo>/examples/fake-transcriber.mjs", "{input}", "{output}"] }
```

## Caching

- **On disk:** each stage writes into `<cache>/<videoId>/`. Each tool first writes a `*.partial.*` file, which is renamed only when the tool succeeds, so a cancelled run never leaves a broken result behind. Separator and transcriber output files are named with a hash of their command settings. Changing a command in settings re-runs only the stages that it affects.
- **In memory:** an Effect `Cache` sits on top of the disk cache. Switching back to a tab you already transcribed shows its notes instantly. Two requests for the same video share one run. A run is interrupted, and its child process killed, once nothing is waiting for it.

## Design notes

- **Event handlers stay light.** Chrome listeners, WebSocket callbacks, IPC handlers and React handlers only push a value onto an Effect `Queue` or send one IPC message. All work that does not change the UI runs in Effect fibers: tab selection, socket I/O, downloading and model runs. Switching videos interrupts the running job through a `FiberHandle`.
- **Updates go over three IPC channels:** state (small, rarely changes), notes (large, sent once per transcription) and playback (frequent). Playback never causes a React render: the animation loop reads it each frame and works out the playhead position between updates.
- **Expensive work in the renderer is memoized.** The note index (sorted note start times and pitch range) is computed with `useMemo`. The keyboard and lane background is drawn once per size or pitch range into an offscreen canvas. Each frame binary-searches for the notes that are on screen. Components use `memo`.

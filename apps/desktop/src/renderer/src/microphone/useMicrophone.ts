import { useEffect } from "react"
import type { MicrophoneDevice } from "../../../shared/microphone"
import { PITCH_BUFFER_SIZE, VoicePitchTracker } from "./pitch"
import { useMicrophoneState } from "./store"
import { sampleSpectrum } from "./spectrum"

const explainError = (error: unknown): string => {
  const name = error instanceof DOMException ? error.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was denied. Allow microphone access in your system privacy settings, then retry."
  }
  if (name === "NotFoundError") return "No microphone found. Connect a microphone, then retry."
  if (name === "NotReadableError") return "Cannot open the microphone. Check whether another app is using it."
  if (name === "OverconstrainedError") return "This microphone is unavailable. Select another input."
  return error instanceof Error ? error.message : "Could not start the microphone. Try again."
}

/** Mounted only in the main window. Docking never creates a second audio stream. */
export const useMicrophone = () => {
  const { enabled, deviceId, captureId } = useMicrophoneState()
  useEffect(() => {
    if (!enabled) return
    const api = window.floatfall
    let disposed = false
    let stopped = false
    let stream: MediaStream | undefined
    let context: AudioContext | undefined
    let source: MediaStreamAudioSourceNode | undefined
    let analyser: AnalyserNode | undefined
    let timer: number | undefined

    const stop = () => {
      stopped = true
      window.clearInterval(timer)
      for (const track of stream?.getTracks() ?? []) { track.onended = null; track.stop() }
      source?.disconnect()
      analyser?.disconnect()
      if (context && context.state !== "closed") void context.close().catch(() => {})
    }
    const fail = (error: unknown) => {
      if (disposed || stopped) return
      api.reportMicrophone({ captureId, status: "error", error: explainError(error) })
      api.reportPitch(captureId, null)
      stop()
    }
    const devices = async (): Promise<MicrophoneDevice[]> => {
      const inputs = await navigator.mediaDevices.enumerateDevices()
      return inputs.filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
        .map((d, index) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${index + 1}` }))
    }
    const refreshDevices = () => {
      void devices().then((inputs) => {
        if (!disposed && !stopped) api.reportMicrophone({ captureId, status: "listening", error: null, devices: inputs })
      }).catch(() => {})
    }

    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable in this window.")
        api.reportMicrophone({ captureId, status: "requesting", error: null })
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(deviceId === "default" ? {} : { deviceId: { exact: deviceId } }),
            channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false
          },
          video: false
        })
        if (disposed) { for (const track of stream.getTracks()) track.stop(); return }
        context = new AudioContext({ latencyHint: "interactive" })
        analyser = context.createAnalyser()
        analyser.fftSize = PITCH_BUFFER_SIZE
        analyser.minDecibels = -90
        analyser.maxDecibels = -20
        analyser.smoothingTimeConstant = 0.35
        source = context.createMediaStreamSource(stream)
        source.connect(analyser) // Deliberately no speaker connection or mic monitoring.
        await context.resume()
        if (disposed || stopped) { stop(); return }
        for (const track of stream.getAudioTracks()) {
          track.onended = () => fail(new Error("Microphone disconnected. Check your input and retry."))
        }
        const inputs = await devices().catch(() => [])
        if (disposed || stopped) return
        api.reportMicrophone({ captureId, status: "listening", error: null, devices: inputs })
        const tracker = new VoicePitchTracker()
        const input = new Float32Array(PITCH_BUFFER_SIZE)
        const fft = new Uint8Array(analyser.frequencyBinCount)
        timer = window.setInterval(() => {
          if (disposed || stopped || !context || !analyser) return
          if (context.state !== "running") { fail(new Error("Microphone audio was interrupted. Retry to resume.")); return }
          try {
            analyser.getFloatTimeDomainData(input)
            analyser.getByteFrequencyData(fft)
            api.reportPitch(captureId, {
              ...tracker.detect(input, context.sampleRate),
              spectrum: sampleSpectrum(fft, context.sampleRate, analyser.fftSize)
            })
          } catch (error) { fail(error) }
        }, 60)
      } catch (error) { fail(error) }
    }
    void start()
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices)
    return () => {
      disposed = true
      navigator.mediaDevices?.removeEventListener("devicechange", refreshDevices)
      stop()
    }
  }, [enabled, deviceId, captureId])
}

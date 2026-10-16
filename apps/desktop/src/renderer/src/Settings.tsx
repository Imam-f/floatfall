import { useEffect, useRef, useState, type ReactNode } from "react"
import { isModelSize, type ModelDownloads, type ModelId, type ModelSelection, type SettingsData, type SettingsLink, type SettingsSnapshot } from "../../shared/settings"

const api = window.floatfall
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) =>
  <label className="settings-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>

export const SettingsApp = () => {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [draft, setDraft] = useState<SettingsData | null>(null)
  const [selection, setSelection] = useState<ModelSelection>({ transcriber: "none", separator: "none", device: "cuda" })
  const [downloads, setDownloads] = useState<ModelDownloads>({})
  const [tab, setTab] = useState<"models" | "processing" | "advanced">("models")
  const [token, setToken] = useState("")
  const [args, setArgs] = useState({ transcriber: "[]", separator: "[]" })
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [externalChange, setExternalChange] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")

  const load = async () => {
    try {
      const next = await api.getSettings()
      setSnapshot(next)
      setDownloads(next.downloads)
      setDraft(next.settings)
      setSelection(next.selection)
      setArgs({ transcriber: JSON.stringify(next.settings.transcriber.args, null, 2), separator: JSON.stringify(next.settings.separator.args, null, 2) })
      dirtyRef.current = false
      setDirty(false)
      setExternalChange(false)
      setError("")
    } catch (error) { setError(errorMessage(error)) }
  }

  useEffect(() => {
    let live = true
    let downloadsReceived = false
    const unsubscribeDownloads = api.onModelDownloads((value) => {
      downloadsReceived = true
      setDownloads(value)
    })
    const unsubscribeSettings = api.onSettingsChanged(() => {
      if (dirtyRef.current) setExternalChange(true)
      else void load()
    })
    void api.getSettings().then((next) => {
      if (!live) return
      setSnapshot(next)
      setDraft(next.settings)
      setSelection(next.selection)
      setArgs({ transcriber: JSON.stringify(next.settings.transcriber.args, null, 2), separator: JSON.stringify(next.settings.separator.args, null, 2) })
      if (!downloadsReceived) setDownloads(next.downloads)
    }).catch((error) => { if (live) setError(errorMessage(error)) })
    return () => { live = false; unsubscribeDownloads(); unsubscribeSettings() }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        document.querySelector<HTMLButtonElement>(".settings-save")?.click()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const changed = () => { dirtyRef.current = true; setDirty(true); setMessage(""); setError("") }
  const update = (patch: Partial<SettingsData>) => { setDraft((s) => s ? { ...s, ...patch } : s); changed() }
  const choose = (patch: Partial<ModelSelection>) => { setSelection((s) => ({ ...s, ...patch })); changed() }
  const openLink = async (link: SettingsLink) => {
    try { const result = await api.openSettingsLink(link); if (!result.ok) setError(result.error) }
    catch (error) { setError(errorMessage(error)) }
  }
  const download = async (model: ModelId) => {
    if (!draft) return
    setError("")
    try {
      const result = await api.downloadModel({ model, uvPath: draft.uvPath, ...(token.trim() && model !== "bs-roformer" ? { token: token.trim() } : {}) })
      if (!result.ok) setError(result.error)
      else setToken("")
    } catch (error) { setError(errorMessage(error)) }
  }
  const save = async () => {
    if (!draft || saving) return
    setSaving(true)
    setError("")
    setMessage("")
    try {
      if (externalChange) throw new Error("Settings changed outside this window. Reload them before saving your changes.")
      const next = { ...draft }
      for (const tool of ["transcriber", "separator"] as const) if (selection[tool] === "custom") {
        let parsed: unknown
        try { parsed = JSON.parse(args[tool]) } catch { throw new Error(`${tool} arguments must be a JSON array of strings. Open Advanced to edit them.`) }
        if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string")) throw new Error(`${tool} arguments must be a JSON array of strings.`)
        if (!next[tool].command.trim()) throw new Error(`Enter a custom ${tool} command in Advanced, or choose None.`)
        if (tool === "transcriber") next.transcriber = { ...next.transcriber, args: parsed }
        else next.separator = { ...next.separator, args: parsed }
      }
      const result = await api.saveSettings({ settings: next, ...selection })
      if (!result.ok) throw new Error(result.error)
      await load()
      setMessage("Settings saved. Changes apply to new jobs.")
    } catch (error) { setError(errorMessage(error)) }
    finally { setSaving(false) }
  }

  const downloading = Object.values(downloads).some((value) => value?.stage === "downloading")
  const downloadStatus = (id: ModelId) => {
    const status = downloads[id]
    if (!status) return null
    return <div className={`model-download-status ${status.stage}`} role="status" aria-live="polite">
      <span>{status.stage === "done" ? "✓ " : status.stage === "error" ? "! " : ""}{status.message}</span>
      {status.stage === "downloading" && <>
        <progress aria-label={`${id} download progress`} {...(status.progress === null ? {} : { value: status.progress, max: 1 })} />
        <button type="button" onClick={() => void api.cancelModelDownload(id).then((result) => { if (!result.ok) setError(result.error) }).catch((error) => setError(errorMessage(error)))}>Cancel download</button>
      </>}
      {status.needsAccess && <button type="button" onClick={() => void openLink(id)}>Review access on Hugging Face ↗</button>}
    </div>
  }

  return <div className="settings-app">
    <header className="settings-titlebar"><span>floatfall <span className="settings-title-separator">/</span> Settings</span>
      <button type="button" aria-label="Close settings" onClick={() => api.window("close")}>×</button>
    </header>
    <nav className="settings-tabs" aria-label="Settings sections">
      {(["models", "processing", "advanced"] as const).map((name) => <button type="button" key={name} aria-current={tab === name ? "page" : undefined} onClick={() => setTab(name)}>{name.charAt(0).toUpperCase() + name.slice(1)}</button>)}
    </nav>
    <main className="settings-content">
      {!draft || !snapshot ? <p role="status">{error || "Loading settings…"}</p> : <>
        {externalChange && <div className="settings-notice">Settings changed outside this window. <button type="button" onClick={() => void load()}>Reload settings</button><small>Reloading discards your unsaved edits.</small></div>}
        {tab === "models" && <>
          <div className="settings-intro"><h1>Your models, on your machine.</h1><p>Choose a transcription model and prepare its weights before your first video.</p></div>
          {!snapshot.scriptsAvailable && <div className="settings-notice">The bundled models folder is missing. Restore it to use the included models, or configure a custom command in Advanced.</div>}
          {draft.remote.url.trim() && <div className="settings-notice">Videos currently use a remote worker. These models configure this computer, including jobs it serves as a worker.
            <div className="settings-actions"><button type="button" onClick={() => update({ remote: { ...draft.remote, url: "" } })}>Use local processing</button><button type="button" onClick={() => setTab("processing")}>Worker settings →</button></div></div>}
          <section className="settings-card">
            <div className="settings-card-heading"><div><h2>Melody transcription</h2><p>MuScriptor · singing voice → notes</p></div><span className="settings-chip">{snapshot.settings.transcriber.command ? "Configured" : "Setup needed"}</span></div>
            <div className="settings-grid">
              <Field label="Model"><select value={selection.transcriber} onChange={(e) => { choose({ transcriber: e.target.value as ModelSelection["transcriber"] }); if (isModelSize(e.target.value)) update({ sampleRate: 16000 }) }}>
                <option value="none">None / not configured</option><option value="small">MuScriptor small · fastest</option><option value="medium">MuScriptor medium · balanced</option><option value="large">MuScriptor large · best quality</option><option value="custom">Custom command</option>
              </select></Field>
              <Field label="Compute device" hint="CUDA requires an NVIDIA GPU. CPU is slower."><select disabled={selection.transcriber === "custom" || selection.transcriber === "none"} value={selection.device} onChange={(e) => choose({ device: e.target.value as ModelSelection["device"] })}><option value="cuda">NVIDIA GPU (CUDA)</option><option value="cpu">CPU</option></select></Field>
            </div>
            {selection.transcriber === "custom" && <p>Edit your transcription command in <button type="button" className="settings-inline-link" onClick={() => setTab("advanced")}>Advanced →</button></p>}
            {isModelSize(selection.transcriber) && <>
              <div className="model-access"><h3>1. Approve access on Hugging Face</h3><p>Sign in and accept the conditions for the selected model. Weights use CC BY-NC 4.0; review the model’s terms and use audio you have rights to transcribe.</p>
                <button type="button" onClick={() => void openLink(selection.transcriber as ModelId)}>Review license & request access ↗</button>
                <h3>2. Authenticate this computer</h3><Field label="Hugging Face read token (optional)" hint="Already signed in with hf auth login or HF_TOKEN? Leave this blank. A supplied token is saved by Hugging Face in its local credential cache, never in floatfall settings."><input type="password" autoComplete="off" spellCheck={false} placeholder="hf_…" value={token} onChange={(e) => setToken(e.target.value)} /></Field>
                <button type="button" className="settings-inline-link" onClick={() => void openLink("hf-tokens")}>Create a read token ↗</button>
                <h3>3. Download the selected model</h3><p>First setup installs Python dependencies and may download several GB. No GPU is needed to download. Existing cached files are reused.</p>
                <button type="button" className="settings-primary" disabled={downloading || !snapshot.scriptsAvailable || saving} onClick={() => void download(selection.transcriber as ModelId)}>{downloads[selection.transcriber as ModelId]?.stage === "error" ? "Retry download" : "Download / verify weights"}</button>
              </div>
              {downloadStatus(selection.transcriber as ModelId)}
            </>}
          </section>
          <section className="settings-card"><div className="settings-card-heading"><div><h2>Vocal isolation</h2><p>Optional · separate singing from the backing track</p></div></div>
            <Field label="Separator"><select value={selection.separator} onChange={(e) => choose({ separator: e.target.value as ModelSelection["separator"] })}><option value="none">None / not configured</option><option value="bs-roformer">BS-RoFormer · ViperX 1297</option><option value="custom">Custom command</option></select></Field>
            {selection.separator === "bs-roformer" && <><p>Uses an NVIDIA GPU for separation. Downloading weights does not require a GPU.</p><div className="settings-actions"><button type="button" disabled={downloading || !snapshot.scriptsAvailable || saving} onClick={() => void download("bs-roformer")}>Download / verify separator</button><button type="button" onClick={() => void openLink("bs-roformer")}>Model source ↗</button></div>{downloadStatus("bs-roformer")}</>}
            {selection.separator === "custom" && <p>Edit the separator command in <button type="button" className="settings-inline-link" onClick={() => setTab("advanced")}>Advanced →</button></p>}
            <label className="settings-check"><input type="checkbox" checked={draft.cleanVocals} onChange={(e) => update({ cleanVocals: e.target.checked })} />Clean vocals before transcription</label>
            {draft.cleanVocals && selection.separator === "none" && <p className="settings-warning">Choose a separator to use vocal cleaning.</p>}
          </section>
          {Object.entries(downloads).filter(([id, status]) => status?.stage === "downloading" && id !== selection.transcriber && id !== selection.separator).map(([id]) => <section className="settings-card" key={id}><h2>{id} download</h2>{downloadStatus(id as ModelId)}</section>)}
        </>}
        {tab === "processing" && <>
          <div className="settings-intro"><h1>Where processing happens.</h1><p>Run models locally, connect to another computer, or serve as a worker.</p></div>
          <section className="settings-card"><h2>Video processing</h2>
            <Field label="Processing location"><select value={draft.remote.url.trim() ? "remote" : "local"} onChange={(e) => update({ remote: { ...draft.remote, url: e.target.value === "local" ? "" : "ws://192.168.2.6:47616" } })}><option value="local">This computer</option><option value="remote">Remote worker</option></select></Field>
            {draft.remote.url.trim() && <><Field label="Remote worker address"><input value={draft.remote.url} placeholder="ws://192.168.2.6:47616" onChange={(e) => update({ remote: { ...draft.remote, url: e.target.value } })} /></Field><Field label="Shared token" hint="Must match the worker’s token; at least 16 characters."><input type="password" autoComplete="off" value={draft.remote.token} onChange={(e) => update({ remote: { ...draft.remote, token: e.target.value } })} /></Field><p>The remote computer uses its own models and tools. Configure model access on that computer.</p></>}
            <label className="settings-check"><input type="checkbox" checked={draft.autoTranscribe} onChange={(e) => update({ autoTranscribe: e.target.checked })} />Automatically transcribe the active video</label>
          </section>
          <section className="settings-card"><h2>Serve as a worker</h2><p>Let another floatfall instance use this computer’s models.</p><label className="settings-check"><input type="checkbox" checked={draft.worker.enabled} onChange={(e) => update({ worker: { ...draft.worker, enabled: e.target.checked } })} />Enable worker server</label>
            {draft.worker.enabled && <><div className="settings-grid"><Field label="Listen address" hint="Use 0.0.0.0 for LAN connections."><input value={draft.worker.host} onChange={(e) => update({ worker: { ...draft.worker, host: e.target.value } })} /></Field><Field label="Port"><input type="number" min={1} max={65535} value={draft.worker.port} onChange={(e) => update({ worker: { ...draft.worker, port: Number(e.target.value) } })} /></Field></div><Field label="Worker shared token" hint="At least 16 characters. Share this token with your clients."><input type="password" autoComplete="off" value={draft.worker.token} onChange={(e) => update({ worker: { ...draft.worker, token: e.target.value } })} /></Field><p>Use ws:// on a trusted LAN or VPN; use a TLS proxy for wss:// on other networks.</p></>}
          </section>
        </>}
        {tab === "advanced" && <>
          <div className="settings-intro"><h1>Tools & custom commands.</h1><p>Executable names use PATH. You can also enter an absolute path.</p></div>
          <section className="settings-card"><h2>Local tools</h2>
            <Field label="uv executable" hint="Required for the included model scripts. Downloads use this path immediately."><input value={draft.uvPath} onChange={(e) => update({ uvPath: e.target.value })} /></Field><button type="button" className="settings-inline-link" onClick={() => void openLink("uv")}>Install uv ↗</button>
            <div className="settings-grid"><Field label="yt-dlp executable"><input value={draft.ytDlpPath} onChange={(e) => update({ ytDlpPath: e.target.value })} /></Field><Field label="FFmpeg executable"><input value={draft.ffmpegPath} onChange={(e) => update({ ffmpegPath: e.target.value })} /></Field></div>
            <Field label="Cache directory" hint="Leave blank to use the default app cache. Model weights use their own shared caches."><input value={draft.cacheDir} placeholder="Default app cache" onChange={(e) => update({ cacheDir: e.target.value })} /></Field>
            <div className="settings-grid"><Field label="Transcription sample rate (Hz)"><input type="number" min={8000} max={192000} value={draft.sampleRate} onChange={(e) => update({ sampleRate: Number(e.target.value) })} /></Field><Field label="yt-dlp format selector"><input value={draft.downloadFormat} onChange={(e) => update({ downloadFormat: e.target.value })} /></Field></div>
          </section>
          {(["transcriber", "separator"] as const).map((tool) => <section className="settings-card" key={tool}><h2>Custom {tool}</h2><p>{selection[tool] === "custom" ? "This command will be used after saving." : "Choose Custom command in Models to use these fields. A model preset replaces them when saved."}</p>
            <fieldset disabled={selection[tool] !== "custom"}><Field label={`${tool} executable`}><input value={draft[tool].command} onChange={(e) => update({ [tool]: { ...draft[tool], command: e.target.value } })} /></Field>
              <Field label={`${tool} arguments (JSON array)`} hint="Placeholders: {input}, {output}, {outputDir}, {videoId}, {sampleRate}."><textarea rows={5} spellCheck={false} value={args[tool]} onChange={(e) => { setArgs((s) => ({ ...s, [tool]: e.target.value })); changed() }} /></Field>
              <Field label={`${tool} working directory`}><input value={draft[tool].cwd ?? ""} onChange={(e) => update({ [tool]: { ...draft[tool], cwd: e.target.value } })} /></Field>
              {tool === "transcriber" && <Field label="Transcriber output"><select value={draft.transcriber.output} onChange={(e) => update({ transcriber: { ...draft.transcriber, output: e.target.value as "json" | "midi" } })}><option value="json">JSON notes</option><option value="midi">MIDI</option></select></Field>}
            </fieldset>
          </section>)}
          <section className="settings-card"><h2>Settings file</h2><p className="settings-file-path">{snapshot.file}</p><p>Manual edits reload automatically. Save or discard your edits here before changing the file.</p><button type="button" onClick={() => void api.openSettingsFile().then((result) => { if (!result.ok) setError(result.error) }).catch((error) => setError(errorMessage(error)))}>Open settings.json ↗</button></section>
        </>}
      </>}
    </main>
    <footer className="settings-footer"><div className="settings-feedback">{error ? <span role="alert" className="settings-error">{error}</span> : <span role="status">{message || (dirty ? "Unsaved changes" : "Downloads keep running when this window closes.")}</span>}</div>
      <div className="settings-actions"><button type="button" disabled={!dirty || saving} onClick={() => void load()}>Discard changes</button><button type="button" className="settings-primary settings-save" disabled={!draft || !dirty || saving || externalChange} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</button></div>
    </footer>
  </div>
}

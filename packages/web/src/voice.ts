import { Dictation, describeMicError, recognitionFactory } from './dictation.ts'
import { encodeWav, hasSound, resample, WHISPER_RATE } from './wav.ts'
import { api, DAEMON, TOKEN } from './ws-client.ts'

/**
 * The desktop microphone: one recording at a time, into a terminal prompt or
 * a card's reply box, never sent on its own — the words go in to be read and
 * fixed first.
 *
 * Two engines. Local Whisper when it is installed and switched on in
 * Settings: the page records, the daemon transcribes on this machine
 * (whisper.ts), with tring's ticket numbers and branch names as a hint. Else
 * the browser's own speech recognition, as on the phone (Chrome sends the
 * audio to Google, Edge to Microsoft). With neither, there is no button.
 */

export type Engine = 'whisper' | 'browser'

export interface VoiceTarget {
  /** Where the finished words go. */
  insert: (text: string) => void
  /** The button that started it, which shows the recording state. */
  button?: HTMLElement | null
}

export type VoiceState = 'idle' | 'listening' | 'transcribing'

export interface VoiceCallbacks {
  onState: (state: VoiceState, target: VoiceTarget | null) => void
  /** The words so far, while the browser's recognizer listens. */
  onHeard: (text: string) => void
  onError: (message: string) => void
}

/** Recording stops by itself after this: a prompt, not a meeting. */
const MAX_MS = 5 * 60_000

class Recorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: ScriptProcessorNode | null = null
  private chunks: Float32Array[] = []

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    // Asked for at 16 kHz; a browser that cannot is resampled at the end.
    try { this.ctx = new AudioContext({ sampleRate: WHISPER_RATE }) } catch { this.ctx = new AudioContext() }
    const source = this.ctx.createMediaStreamSource(this.stream)
    this.node = this.ctx.createScriptProcessor(4096, 1, 1)
    this.node.onaudioprocess = (e) => { this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))) }
    source.connect(this.node)
    // A processor only runs connected to the output; it writes nothing to it.
    this.node.connect(this.ctx.destination)
  }

  /** The recording as 16 kHz samples, and everything let go. */
  async stop(): Promise<Float32Array> {
    const rate = this.ctx?.sampleRate ?? WHISPER_RATE
    this.node?.disconnect()
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    await this.ctx?.close().catch(() => {})
    const all = new Float32Array(this.chunks.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const c of this.chunks) { all.set(c, at); at += c.length }
    this.chunks = []
    this.ctx = null
    this.stream = null
    this.node = null
    return resample(all, rate, WHISPER_RATE)
  }
}

export class Voice {
  private target: VoiceTarget | null = null
  private state: VoiceState = 'idle'
  private recorder: Recorder | null = null
  private dictation: Dictation | null = null
  private limit: ReturnType<typeof setTimeout> | null = null
  private engineCache: { at: number; engine: Engine | null } | null = null
  private readonly makeRecognition = recognitionFactory(window)

  constructor(private readonly cb: VoiceCallbacks) {}

  get busy(): boolean {
    return this.state !== 'idle'
  }

  isFor(target: VoiceTarget): boolean {
    return this.target === target
  }

  /** Which engine a click would use now. Checked again after a while, since Settings can change it. */
  async engine(): Promise<Engine | null> {
    if (this.engineCache && Date.now() - this.engineCache.at < 15_000) return this.engineCache.engine
    let engine: Engine | null = this.makeRecognition ? 'browser' : null
    try {
      const st = await api<{ enabled: boolean }>('/api/voice')
      if (st.enabled) engine = 'whisper'
    } catch { /* no daemon support: the browser's */ }
    this.engineCache = { at: Date.now(), engine }
    return engine
  }

  /** Settings changed the engine. */
  forget(): void {
    this.engineCache = null
  }

  /** Start for `target`, or stop if it is already recording there (or anywhere). */
  async toggle(target: VoiceTarget): Promise<void> {
    if (this.state === 'transcribing') return
    if (this.state === 'listening') { await this.stop(); return }
    const engine = await this.engine()
    if (!engine) {
      this.cb.onError('voice input needs Chrome or Edge, or local Whisper (Settings)')
      return
    }
    this.target = target
    if (engine === 'browser') this.startBrowser(target)
    else await this.startWhisper()
  }

  /** Stops and throws away what was heard: the words have nowhere to go. */
  cancel(): void {
    if (this.limit) clearTimeout(this.limit)
    this.dictation?.cancel()
    this.dictation = null
    if (this.recorder) void this.recorder.stop()
    this.recorder = null
    this.set('idle')
  }

  private set(state: VoiceState): void {
    this.state = state
    this.cb.onState(state, state === 'idle' ? null : this.target)
    if (state === 'idle') this.target = null
  }

  private startBrowser(target: VoiceTarget): void {
    this.dictation = new Dictation(this.makeRecognition!, {
      onListening: (on) => { if (!on && this.dictation) { this.dictation = null; this.set('idle') } },
      onHeard: (text) => this.cb.onHeard(text),
      onText: (text) => target.insert(text),
      onError: (m) => this.cb.onError(m),
    }, navigator.language || 'en-ZA')
    this.dictation.toggle()
    if (this.dictation?.listening) this.set('listening')
    else { this.dictation = null; this.target = null }
  }

  private async startWhisper(): Promise<void> {
    const rec = new Recorder()
    try {
      await rec.start()
    } catch (err) {
      this.target = null
      this.cb.onError(describeMicError((err as DOMException).name ?? 'Error'))
      return
    }
    this.recorder = rec
    this.set('listening')
    this.limit = setTimeout(() => { void this.stop() }, MAX_MS)
  }

  private async stop(): Promise<void> {
    if (this.limit) clearTimeout(this.limit)
    this.limit = null
    if (this.dictation) { this.dictation.toggle(); return } // ends through onListening(false)
    const rec = this.recorder
    const target = this.target
    if (!rec || !target) { this.set('idle'); return }
    this.recorder = null
    const samples = await rec.stop()
    if (!hasSound(samples)) {
      this.cb.onError('no speech heard — click the mic and talk')
      this.set('idle')
      return
    }
    this.set('transcribing')
    try {
      const res = await fetch(`${DAEMON}/api/voice/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
        body: encodeWav(samples),
      })
      const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string }
      if (!res.ok) throw new Error(body.error ?? `transcription failed (${res.status})`)
      if (body.text) target.insert(body.text)
      else this.cb.onError('no words recognised — try again, a little closer to the mic')
    } catch (err) {
      this.cb.onError(`local Whisper: ${(err as Error).message}`)
    } finally {
      this.set('idle')
    }
  }
}

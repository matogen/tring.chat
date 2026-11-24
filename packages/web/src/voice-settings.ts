import { api, apiPost } from './ws-client.ts'

/**
 * "Voice input" in Settings, on a desktop: which engine the microphone uses,
 * and local Whisper as an option — the model recommended for this PC, its
 * download, and a switch once it is installed. A phone keeps its own
 * dictation and is not offered this.
 */

interface Status {
  hardware: { cpu: string; cores: number; ramGB: number; gpu: { name: string; vramGB: number } | null }
  recommendation: { model: string; modelLabel: string; downloadMB: number; reason: string; speed: string; manual: string | null; build: { name: string; gpu: boolean } | null }
  installed: boolean
  enabled: boolean
  model: string | null
  installing: { step: string; doneMB: number; totalMB: number } | null
  error: string | null
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const browserEngine = (): string => {
  const has = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window
  if (!has) return 'none in this browser — use Chrome or Edge, or local Whisper below'
  return /Edg\//.test(navigator.userAgent)
    ? 'the browser\'s speech recognition (Edge sends the audio to Microsoft)'
    : 'the browser\'s speech recognition (Chrome sends the audio to Google)'
}

/** `onChange`: the engine may have changed, so the microphone should look again. */
export function voiceSection(onChange: () => void): HTMLElement {
  const box = el('div', 'notify voice-settings')
  const state = el('p', 'hint notify-state')
  const body = el('div', 'notify-body')
  box.append(el('div', 'notify-title', 'Voice input'), state, body)
  let poll: ReturnType<typeof setInterval> | null = null

  const paint = async (): Promise<void> => {
    // The dialog closed: the install carries on in the daemon, unwatched.
    if (poll && !box.isConnected) { clearInterval(poll); poll = null; return }
    let st: Status
    try {
      st = await api<Status>('/api/voice')
    } catch {
      state.textContent = `The microphone uses ${browserEngine()}.`
      body.replaceChildren()
      return
    }
    body.replaceChildren()
    const rec = st.recommendation

    if (st.installing) {
      const p = st.installing
      state.textContent = `Installing local Whisper: ${p.step}${p.totalMB ? ` — ${p.doneMB} of ${p.totalMB} MB` : '…'}`
      const bar = el('div', 'meter')
      const fill = el('i')
      fill.style.width = p.totalMB ? `${Math.min(100, (p.doneMB / p.totalMB) * 100)}%` : '5%'
      bar.append(fill)
      body.append(bar)
      poll ??= setInterval(() => { void paint() }, 1000)
      return
    }
    if (poll) { clearInterval(poll); poll = null; onChange() }

    if (st.installed) {
      state.textContent = st.enabled
        ? `The microphone uses local Whisper (${st.model}). The audio stays on this PC.`
        : `The microphone uses ${browserEngine()}. Local Whisper is installed but off.`
      const row = el('label', 'field toggle notify-choice')
      const cb = el('input')
      cb.type = 'checkbox'
      cb.checked = st.enabled
      cb.onchange = () => {
        void apiPost('/api/voice/enable', { enabled: cb.checked }).then(() => { onChange(); return paint() })
      }
      row.append(cb, el('span', undefined, 'Use local Whisper for the microphone'))
      body.append(row)
    } else {
      state.textContent = `The microphone uses ${browserEngine()}.`
      const check = el('button', 'btn', 'Recommend a local Whisper model for this PC')
      check.type = 'button'
      check.onclick = () => {
        const hw = st.hardware
        const lines = el('div', 'voice-rec')
        lines.append(
          el('p', 'hint', `This PC: ${hw.gpu ? `${hw.gpu.name} (${hw.gpu.vramGB} GB), ` : 'no NVIDIA GPU, '}${hw.cpu}, ${hw.cores} threads, ${hw.ramGB} GB RAM.`),
          el('p', 'voice-pick', `Recommended: ${rec.modelLabel}${rec.build ? (rec.build.gpu ? ', on the GPU' : ', on the CPU') : ''}.`),
          el('p', 'hint', `${rec.reason} Speed: ${rec.speed}. Download: about ${rec.downloadMB >= 1024 ? `${(rec.downloadMB / 1024).toFixed(1)} GB` : `${rec.downloadMB} MB`}, checked against its publisher's checksum. The audio never leaves this PC.`),
        )
        if (rec.manual) {
          lines.append(el('p', 'hint', rec.manual))
        }
        const install = el('button', 'btn primary', rec.manual ? 'Download the model' : 'Install local Whisper')
        install.type = 'button'
        install.onclick = () => {
          install.disabled = true
          void apiPost('/api/voice/install', { model: rec.model }).then(() => paint(), (err: Error) => {
            state.textContent = `Could not start the install: ${err.message}`
            install.disabled = false
          })
        }
        lines.append(install)
        body.replaceChildren(lines)
      }
      body.append(check)
    }
    if (st.error) body.append(el('p', 'hint voice-error', `Last install failed: ${st.error}`))
  }

  void paint()
  box.append(el('p', 'hint', 'Click the microphone (or Ctrl+Space, then v) to talk; the words go into the box to edit, never sent on their own.'))
  return box
}

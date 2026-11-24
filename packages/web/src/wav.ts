/**
 * Recorded speech as the WAV whisper.cpp reads without help: 16 kHz, mono,
 * 16-bit PCM. Done in the page so the daemon needs no ffmpeg to convert the
 * browser's own formats (WebM/Opus) first.
 */

export const WHISPER_RATE = 16_000

/** Linear resampling: plenty for speech, and the recognizer's own input is 16 kHz. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input
  const ratio = from / to
  const out = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio
    const j = Math.floor(at)
    const frac = at - j
    const a = input[j] ?? 0
    const b = input[Math.min(j + 1, input.length - 1)] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

/** Float samples (-1..1) to a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, rate = WHISPER_RATE): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(44 + samples.length * 2))
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, s: string): void => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i) }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return bytes
}

/** Whether a recording has any speech worth sending: not silence, not a click. */
export function hasSound(samples: Float32Array, threshold = 0.01): boolean {
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!))
  return samples.length > WHISPER_RATE / 4 && peak > threshold
}

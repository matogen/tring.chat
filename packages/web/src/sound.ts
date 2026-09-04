/**
 * The "tring" — a short two-strike bell when a session finishes.
 *
 * Synthesised with the Web Audio API rather than shipped as a file: it is a
 * few sine partials, so an asset would cost a network request, a decode and a
 * licence question to produce something less tweakable.
 */

const STORAGE_KEY = 'tring.sound'

let ctx: AudioContext | null = null
let enabled = read()

function read(): boolean {
  try {
    // Default on: the sound is the product's namesake, and it is one click off.
    return localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function isEnabled(): boolean {
  return enabled
}

export function setEnabled(next: boolean): void {
  enabled = next
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off')
  } catch {
    // Private windows and blocked storage still get the setting for this session.
  }
  if (next) void prime()
}

/**
 * Browsers refuse to start audio without a user gesture, so the context is
 * created lazily and resumed on the first interaction that reaches it.
 */
async function prime(): Promise<AudioContext | null> {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') await ctx.resume()
    return ctx
  } catch {
    return null
  }
}

document.addEventListener('pointerdown', () => void prime(), { once: true })

function strike(ac: AudioContext, at: number, freq: number, gain: number, decay: number): void {
  const osc = ac.createOscillator()
  const amp = ac.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, at)
  amp.gain.setValueAtTime(0, at)
  amp.gain.linearRampToValueAtTime(gain, at + 0.004)
  // Exponential, not linear: a bell's decay is what makes it read as a bell.
  amp.gain.exponentialRampToValueAtTime(0.0001, at + decay)
  osc.connect(amp).connect(ac.destination)
  osc.start(at)
  osc.stop(at + decay)
}

/** Two quick strikes, the way a bicycle bell actually sounds. */
export function tring(): void {
  if (!enabled) return
  void prime().then((ac) => {
    if (!ac) return
    const now = ac.currentTime
    for (const offset of [0, 0.085]) {
      strike(ac, now + offset, 1568, 0.13, 0.55) // G6
      strike(ac, now + offset, 2349, 0.05, 0.4) // D7, adds the shimmer
    }
  })
}

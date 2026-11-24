/**
 * Talking to the terminal on a phone (spec §5.11).
 *
 * The browser's speech recognition turns speech into text: Chrome on Android
 * through Google's service, Safari on iOS through Siri's dictation. Firefox
 * has none, and every browser refuses the microphone to an http origin, so
 * the mic button only shows where the API exists and says why when it fails.
 *
 * One tap starts listening and a second tap stops, rather than holding the
 * button down. On a touch screen only the finger lifting counts as the user
 * asking for something, so a recognizer started as the finger goes down is
 * refused by Safari, and holding a button while dictating a long prompt is
 * hard work anyway.
 *
 * What was heard goes into the prompt as a paste and is never submitted, so it
 * can be read and fixed before Enter. As a paste, a leading "!" or "/" stays
 * text, where typing it would switch Claude Code's mode.
 */

/** The slice of `SpeechRecognition` this uses, so a test can hand in a fake. */
export interface Recognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
}

/** One entry of `SpeechRecognitionResultList`: its best guess, and whether it is settled. */
export interface RecognitionResult {
  readonly isFinal: boolean
  readonly [index: number]: { readonly transcript: string }
}

/** The browser's recognizer, under whichever name it ships, or null if it has none. */
export function recognitionFactory(win: object): (() => Recognition) | null {
  const w = win as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  return Ctor ? () => new Ctor() : null
}

/**
 * Adds a piece of speech to what came before it. Chrome on Android sends each
 * new piece with everything before it included, where desktop Chrome sends
 * only the new words, so a piece that already starts with the earlier text
 * replaces that text instead of repeating it.
 */
export function extend(before: string, next: string): string {
  if (!before) return next
  if (!next) return before
  if (next.toLowerCase().startsWith(before.toLowerCase())) return next
  return `${before} ${next}`
}

/** Everything heard so far: the settled words, then the guess still being made. */
export function transcript(results: ArrayLike<RecognitionResult>): string {
  let settled = ''
  let guess = ''
  for (const r of Array.from(results)) {
    const text = r[0]?.transcript.trim() ?? ''
    if (r.isFinal) settled = extend(settled, text)
    else guess = extend(guess, text)
  }
  return extend(settled, guess)
}

/** What a recognizer's error code means for the person holding the phone, or null to say nothing. */
export function describeError(code: string): string | null {
  switch (code) {
    case 'aborted': return null
    case 'no-speech': return 'no speech heard — tap the mic and talk'
    case 'not-allowed':
      return 'the microphone was refused — voice input needs https and microphone permission'
    case 'service-not-allowed': return 'speech recognition is turned off on this device'
    case 'audio-capture': return 'no microphone available'
    case 'network': return 'speech recognition needs a network connection'
    case 'language-not-supported': return 'speech recognition does not support this language'
    default: return `speech recognition failed (${code})`
  }
}

/**
 * What getUserMedia's refusal means, for the local Whisper recorder (the
 * browser's own recognizer reports through describeError above).
 */
export function describeMicError(name: string): string {
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'the microphone was refused — allow it for this site (the icon in the address bar), then try again'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'no microphone found — plug one in or pick one in the system sound settings'
    case 'NotReadableError':
    case 'AbortError':
      return 'the microphone is in use by another app, or the system blocked it'
    default:
      return `the microphone could not start (${name})`
  }
}

export interface DictationCallbacks {
  /** The mic turned on or off; the button shows which. */
  onListening: (on: boolean) => void
  /** Everything heard so far, to show while still listening. */
  onHeard: (text: string) => void
  /** The finished words, once listening stops. Not called if nothing was heard. */
  onText: (text: string) => void
  onError: (message: string) => void
}

export class Dictation {
  private rec: Recognition | null = null

  constructor(
    private readonly make: () => Recognition,
    private readonly cb: DictationCallbacks,
    private readonly lang: string,
  ) {}

  get listening(): boolean {
    return this.rec !== null
  }

  toggle(): void {
    if (this.rec) this.rec.stop()
    else this.start()
  }

  /** Stops listening and throws away what was heard, for when the words have nowhere to go. */
  cancel(): void {
    const rec = this.rec
    if (!rec) return
    this.rec = null
    rec.abort()
    this.cb.onListening(false)
  }

  private start(): void {
    const rec = this.make()
    rec.lang = this.lang
    // Keep listening through the pauses of a long prompt until the second
    // tap, and show the words as they come, not only at the end.
    rec.continuous = true
    rec.interimResults = true

    let heard = ''
    rec.addEventListener('result', (e) => {
      heard = transcript((e as unknown as { results: ArrayLike<RecognitionResult> }).results)
      this.cb.onHeard(heard)
    })
    rec.addEventListener('error', (e) => {
      const message = describeError((e as unknown as { error: string }).error)
      if (message) this.cb.onError(message)
    })
    rec.addEventListener('end', () => {
      // A cancelled recognizer still ends. Its words were thrown away.
      if (this.rec !== rec) return
      this.rec = null
      this.cb.onListening(false)
      // Whatever was on screen when it stopped, guesses included: the words
      // that are inserted are the ones that were shown.
      if (heard) this.cb.onText(heard)
    })

    try {
      rec.start()
    } catch (err) {
      this.cb.onError(`speech recognition failed (${(err as Error).message})`)
      return
    }
    this.rec = rec
    this.cb.onListening(true)
    this.cb.onHeard('')
  }
}

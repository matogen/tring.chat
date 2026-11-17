import { describe, expect, it, vi } from 'vitest'
import {
  describeError, Dictation, extend, recognitionFactory, transcript,
  type DictationCallbacks, type Recognition, type RecognitionResult,
} from '../src/dictation.ts'

const result = (text: string, isFinal: boolean): RecognitionResult => ({ isFinal, 0: { transcript: text } })

class FakeRecognition extends EventTarget implements Recognition {
  lang = ''
  continuous = false
  interimResults = false
  started = false
  start = vi.fn(() => { this.started = true })
  stop = vi.fn()
  abort = vi.fn()

  hear(...results: RecognitionResult[]): void {
    this.dispatchEvent(Object.assign(new Event('result'), { results }))
  }
  fail(error: string): void {
    this.dispatchEvent(Object.assign(new Event('error'), { error }))
  }
  end(): void {
    this.dispatchEvent(new Event('end'))
  }
}

function setup() {
  const recs: FakeRecognition[] = []
  const cb = {
    onListening: vi.fn(), onHeard: vi.fn(), onText: vi.fn(), onError: vi.fn(),
  } satisfies DictationCallbacks
  const d = new Dictation(() => { const r = new FakeRecognition(); recs.push(r); return r }, cb, 'en-GB')
  return { d, cb, recs }
}

describe('recognitionFactory', () => {
  it('finds the standard name and the webkit one, and nothing where neither exists', () => {
    class Rec extends FakeRecognition {}
    expect(recognitionFactory({ SpeechRecognition: Rec })?.()).toBeInstanceOf(Rec)
    expect(recognitionFactory({ webkitSpeechRecognition: Rec })?.()).toBeInstanceOf(Rec)
    expect(recognitionFactory({})).toBeNull()
  })
})

describe('transcript', () => {
  it('joins settled pieces with the guess still being made', () => {
    expect(transcript([result('fix the', true), result(' failing test', false)]))
      .toBe('fix the failing test')
  })

  it('does not repeat words when each piece carries the ones before it (Chrome on Android)', () => {
    expect(transcript([result('fix the', true), result('fix the failing test', true)]))
      .toBe('fix the failing test')
    expect(extend('Fix the', 'fix the test')).toBe('fix the test')
  })

  it('skips empty pieces', () => {
    expect(transcript([result('  ', true), result('hello', true)])).toBe('hello')
  })
})

describe('describeError', () => {
  it('stays quiet when listening was stopped on purpose', () => {
    expect(describeError('aborted')).toBeNull()
  })

  it('names https and permission when the microphone is refused', () => {
    expect(describeError('not-allowed')).toMatch(/https.*permission/)
  })

  it('still says something for a code it does not know', () => {
    expect(describeError('bad-grammar')).toBe('speech recognition failed (bad-grammar)')
  })
})

describe('Dictation', () => {
  it('listens continuously, with guesses, in the given language', () => {
    const { d, cb, recs } = setup()
    d.toggle()
    expect(recs[0]).toMatchObject({ lang: 'en-GB', continuous: true, interimResults: true, started: true })
    expect(d.listening).toBe(true)
    expect(cb.onListening).toHaveBeenCalledWith(true)
  })

  it('shows words as they come and hands them over once the second tap ends it', () => {
    const { d, cb, recs } = setup()
    d.toggle()
    recs[0]!.hear(result('run the', true), result('tests', false))
    expect(cb.onHeard).toHaveBeenLastCalledWith('run the tests')

    d.toggle()
    expect(recs[0]!.stop).toHaveBeenCalled()
    expect(cb.onText).not.toHaveBeenCalled()

    recs[0]!.end()
    expect(cb.onText).toHaveBeenCalledWith('run the tests')
    expect(cb.onListening).toHaveBeenLastCalledWith(false)
    expect(d.listening).toBe(false)
  })

  it('hands over nothing when nothing was heard', () => {
    const { d, cb, recs } = setup()
    d.toggle()
    recs[0]!.fail('no-speech')
    recs[0]!.end()
    expect(cb.onError).toHaveBeenCalledWith(expect.stringMatching(/no speech/))
    expect(cb.onText).not.toHaveBeenCalled()
    expect(cb.onListening).toHaveBeenLastCalledWith(false)
  })

  it('throws the words away when cancelled', () => {
    const { d, cb, recs } = setup()
    d.toggle()
    recs[0]!.hear(result('half a thought', false))
    d.cancel()
    expect(recs[0]!.abort).toHaveBeenCalled()
    recs[0]!.fail('aborted')
    recs[0]!.end()
    expect(cb.onText).not.toHaveBeenCalled()
    expect(cb.onError).not.toHaveBeenCalled()
    expect(d.listening).toBe(false)
  })

  it('starts afresh each time, with nothing left over from the last one', () => {
    const { d, cb, recs } = setup()
    d.toggle()
    recs[0]!.hear(result('first', true))
    d.toggle()
    recs[0]!.end()
    d.toggle()
    recs[1]!.hear(result('second', true))
    d.toggle()
    recs[1]!.end()
    expect(cb.onText).toHaveBeenLastCalledWith('second')
  })

  it('reports a recognizer that will not start, and stays off', () => {
    const { d, cb } = setup()
    const broken = new Dictation(() => {
      const r = new FakeRecognition()
      r.start = vi.fn(() => { throw new Error('already started') })
      return r
    }, cb, 'en')
    broken.toggle()
    expect(broken.listening).toBe(false)
    expect(cb.onError).toHaveBeenCalledWith('speech recognition failed (already started)')
    expect(cb.onListening).not.toHaveBeenCalled()
    expect(d.listening).toBe(false)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachImeReset, type TextBox } from '../src/ime-reset.ts'

/**
 * Just enough of xterm's textarea handling: a keydown from a phone keyboard
 * (keyCode 229) notes the textarea, and in a `setTimeout(0)` sends whatever
 * changed, as CompositionHelper._handleAnyTextareaChanges does. A
 * composition sends the text after its start in the same kind of timeout.
 */
function fakeTerminal() {
  const box = Object.assign(new EventTarget(), { value: '' }) as TextBox
  const sent: string[] = []
  const listeners: (() => void)[] = []
  const send = (d: string): void => {
    sent.push(d)
    for (const l of listeners) l()
  }
  // xterm's listeners go on the textarea first, as they do in the app.
  box.addEventListener('keydown', () => {
    const old = box.value
    setTimeout(() => {
      const now = box.value
      const diff = now.replace(old, '')
      if (now.length > old.length) send(diff)
      else if (now.length < old.length) send('\x7f')
      else if (now !== old) send(now)
    }, 0)
  })
  let start = 0
  box.addEventListener('compositionstart', () => { start = box.value.length })
  box.addEventListener('compositionend', () => {
    const from = start
    setTimeout(() => { const t = box.value.substring(from); if (t) send(t) }, 0)
  })
  attachImeReset(box, (fn) => { listeners.push(fn) })

  /** The keyboard sets the textarea to `value` the way a phone does: keydown 229, then the edit. */
  const key = (value: string): void => {
    box.dispatchEvent(new Event('keydown'))
    box.value = value
    box.dispatchEvent(new Event('input'))
  }
  const compose = (word: string): void => {
    box.dispatchEvent(new Event('compositionstart'))
    for (let i = 1; i <= word.length; i++) {
      box.value = box.value.slice(0, box.value.length - (i - 1)) + word.slice(0, i)
      box.dispatchEvent(new Event('input'))
    }
    box.dispatchEvent(new Event('compositionend'))
  }
  return { box, sent, key, compose }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('attachImeReset', () => {
  it('empties the textarea once what it held has been sent', () => {
    const t = fakeTerminal()
    t.key('a')
    vi.runAllTimers()
    expect(t.sent).toEqual(['a'])
    expect(t.box.value).toBe('')
  })

  it('leaves a composition alone until it has been sent', () => {
    const t = fakeTerminal()
    t.box.dispatchEvent(new Event('compositionstart'))
    t.box.value = 'hel'
    vi.runAllTimers()
    expect(t.box.value).toBe('hel')
    t.box.value = 'hello'
    t.box.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(t.sent).toEqual(['hello'])
    expect(t.box.value).toBe('')
  })

  it('does not lose a key that lands while an empty is queued', () => {
    const t = fakeTerminal()
    t.key('a')
    vi.advanceTimersToNextTimer() // xterm sends 'a', which queues the empty
    t.key('ab') // the next key, before the empty has run
    vi.runAllTimers()
    expect(t.sent).toEqual(['a', 'b'])
    expect(t.box.value).toBe('')
  })

  it('leaves nothing already sent for the keyboard to rewrite', () => {
    const t = fakeTerminal()
    t.compose('hello')
    vi.runAllTimers()
    t.key(' ')
    vi.runAllTimers()
    t.compose('wrold')
    vi.runAllTimers()
    expect(t.sent).toEqual(['hello', ' ', 'wrold'])
    // Without the reset the textarea would hold 'hello wrold', and an
    // autocorrect to 'hello world' (same length) made xterm send it all again.
    expect(t.box.value).toBe('')
  })
})

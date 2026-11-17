/**
 * Typing on a phone keyboard sometimes sent extra words, or the whole line again.
 *
 * xterm takes keystrokes through a hidden textarea and only empties it on
 * Enter or Ctrl+C, so everything typed on the current line stays in there. A
 * desktop keyboard never sees that text. A phone keyboard such as Gboard does:
 * it reads the textarea as the text you are editing, and autocorrect, a tapped
 * suggestion or a backspace into the previous word rewrites text that was sent
 * to the PTY long ago. xterm cannot tell what the keyboard did. It compares the
 * textarea before and after the key, and when the old text is no longer a
 * prefix of the new one it sends all of the new text, which is your whole line
 * typed a second time. A composition that the keyboard reopens over an earlier
 * word goes wrong in the same way.
 *
 * So the textarea is emptied once its contents have reached the PTY. The
 * keyboard then has nothing old to rewrite. The timing matters. xterm reads the
 * textarea in a `setTimeout(0)` after a keydown or compositionend, and emptying
 * it before that read would lose the keystroke, or turn it into a backspace.
 * So the textarea is never emptied during a composition, and if a key or an
 * edit lands while an empty is queued, the empty waits for the next turn.
 * Timers with the same delay run in order, so xterm's pending read goes first.
 */

/** The slice of xterm's textarea this touches, so a test can hand in a fake. */
export interface TextBox extends EventTarget {
  value: string
}

export function attachImeReset(box: TextBox, onData: (listener: () => void) => void): void {
  let composing = false
  // A key or an edit has landed since the empty was queued, so xterm may
  // still have a read of the textarea of its own queued.
  let busy = false
  let queued = false

  const queue = (): void => {
    if (queued) return
    queued = true
    setTimeout(empty, 0)
  }
  const empty = (): void => {
    queued = false
    if (composing) return // compositionend queues the next try
    if (busy) {
      busy = false
      queue()
      return
    }
    if (box.value !== '') box.value = ''
  }
  const touched = (): void => { busy = true }

  box.addEventListener('keydown', touched)
  box.addEventListener('input', touched)
  box.addEventListener('compositionstart', () => { composing = true })
  box.addEventListener('compositionend', () => {
    composing = false
    busy = true
    queue()
  })
  onData(queue)
}

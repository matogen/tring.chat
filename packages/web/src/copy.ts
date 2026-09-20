/**
 * Copying text out of the terminal on a phone (spec §5.11).
 *
 * xterm draws the screen on a canvas, so there is no text on the page for a
 * long-press to select, and its own selection is a mouse affair with no touch
 * handling at all. Claude Code then turns mouse tracking on, which takes even
 * the mouse. On a phone nothing on the screen can be copied. So the switcher
 * bar carries a copy button that opens a sheet: the links on screen, each with
 * its own Copy button — the case that matters most is a login URL a CLI has
 * just printed — and the screen itself as plain text, which the phone knows
 * how to select from.
 */

/** The slice of xterm's `IBufferLine` this reads, so a test can hand in a fake. */
export interface BufferLineLike {
  readonly isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

/** The slice of xterm's `IBuffer` this reads. */
export interface BufferLike {
  readonly length: number
  readonly viewportY: number
  getLine(y: number): BufferLineLike | undefined
}

/**
 * The rows `from` (inclusive) to `to` (exclusive) as the lines a program
 * wrote, not the rows the terminal wrapped them into: a URL that ran past the
 * right edge comes back whole. A logical line that straddles either bound is
 * completed rather than cut, so the first and last lines are whole too.
 */
export function logicalLines(buffer: BufferLike, from: number, to: number): string[] {
  let start = Math.max(0, from)
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--
  let end = Math.min(buffer.length, to)
  while (end < buffer.length && buffer.getLine(end)?.isWrapped) end++

  const lines: string[] = []
  let current: string | null = null
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    // A wrapped row keeps its trailing spaces: they may be the middle of the
    // line. Only the end of a logical line is trimmed.
    const text = line.translateToString(false)
    if (line.isWrapped && current !== null) current += text
    else {
      if (current !== null) lines.push(current.trimEnd())
      current = text
    }
  }
  if (current !== null) lines.push(current.trimEnd())
  return lines
}

/** What is on screen right now, as text, without the blank rows under the prompt. */
export function screenText(buffer: BufferLike, rows: number): string {
  const lines = logicalLines(buffer, buffer.viewportY, buffer.viewportY + rows)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g
/** Punctuation that ends a sentence around a link, not the link. */
const TRAILING = /[.,;:!?)\]}'"]+$/

/** The links in some text, in order of appearance, each once. */
export function linksIn(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.match(URL_RE) ?? []) {
    const url = raw.replace(TRAILING, '')
    if (url.length > 'https://'.length) seen.add(url)
  }
  return [...seen]
}

/** How far up the scrollback the sheet looks for links. */
export const LINK_LOOKBACK = 300

/**
 * The links in the last `lookback` rows, the most recent first: the one just
 * printed is the one wanted, and it goes at the top where a thumb is.
 */
export function recentLinks(buffer: BufferLike, lookback: number = LINK_LOOKBACK): string[] {
  const lines = logicalLines(buffer, buffer.length - lookback, buffer.length)
  return linksIn(lines.reverse().join('\n'))
}

/**
 * Puts text on the clipboard. The async API needs a secure origin, which an
 * http daemon on a LAN is not; there the old selection-and-copy still works
 * from inside a tap.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* refused: fall through to the selection route */
  }
  const box = document.createElement('textarea')
  box.value = text
  box.setAttribute('readonly', '')
  box.style.position = 'fixed'
  box.style.opacity = '0'
  document.body.append(box)
  box.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  box.remove()
  return ok
}

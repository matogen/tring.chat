/**
 * Validation for input arriving from a page and landing in CDP (spec §4.7).
 *
 * The pane normalises events before sending them, but the daemon cannot assume
 * the sender is the pane: this crosses a socket, and `Input.dispatchKeyEvent`
 * is not a place to forward unexamined objects from the network. Pure, so the
 * rules are testable without a browser.
 */

import type { BrowserInputEvent } from './protocol.ts'

/** Clamp rather than reject: a coordinate a pixel outside a resizing viewport
 *  is a race, not an attack, and dropping it loses a click the user made. */
const clamp = (n: number, max: number): number => Math.min(Math.max(n, 0), max)

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * Wheel deltas are bounded because a single event carrying a huge delta scrolls
 * a page to an arbitrary position in one dispatch.
 */
const MAX_DELTA = 10_000
/** Longer than any key's `text`, which is one character or a short sequence. */
const MAX_TEXT = 8
const MAX_KEY = 32

/**
 * Returns a safe event, or null if it cannot be made safe.
 *
 * Never returns the object it was given: the result is rebuilt field by field,
 * so anything the sender added that this does not know about cannot reach CDP.
 */
export function sanitizeInput(
  raw: unknown,
  viewport: { width: number; height: number },
): BrowserInputEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>

  if (e['kind'] === 'mouse') {
    if (!finite(e['x']) || !finite(e['y'])) return null
    const action = e['action']
    if (action !== 'move' && action !== 'down' && action !== 'up') return null
    const button = e['button']
    const clicks = finite(e['clicks']) ? clamp(Math.round(e['clicks']), 3) : undefined
    return {
      kind: 'mouse',
      action,
      x: clamp(e['x'], viewport.width),
      y: clamp(e['y'], viewport.height),
      ...(button === 'left' || button === 'middle' || button === 'right' ? { button } : {}),
      ...(clicks !== undefined ? { clicks } : {}),
    }
  }

  if (e['kind'] === 'wheel') {
    if (!finite(e['x']) || !finite(e['y']) || !finite(e['dx']) || !finite(e['dy'])) return null
    return {
      kind: 'wheel',
      x: clamp(e['x'], viewport.width),
      y: clamp(e['y'], viewport.height),
      dx: Math.max(-MAX_DELTA, Math.min(MAX_DELTA, e['dx'])),
      dy: Math.max(-MAX_DELTA, Math.min(MAX_DELTA, e['dy'])),
    }
  }

  if (e['kind'] === 'key') {
    const action = e['action']
    if (action !== 'down' && action !== 'up') return null
    const key = e['key']
    const code = e['code']
    if (typeof key !== 'string' || typeof code !== 'string') return null
    if (key.length > MAX_KEY || code.length > MAX_KEY) return null
    const text = typeof e['text'] === 'string' && e['text'].length <= MAX_TEXT
      ? e['text']
      : undefined
    return {
      kind: 'key',
      action,
      key,
      code,
      ...(text ? { text } : {}),
      ...(e['ctrl'] === true ? { ctrl: true } : {}),
      ...(e['alt'] === true ? { alt: true } : {}),
      ...(e['shift'] === true ? { shift: true } : {}),
      ...(e['meta'] === true ? { meta: true } : {}),
    }
  }

  return null
}

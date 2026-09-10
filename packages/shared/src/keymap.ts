/**
 * Single source of truth for keys (spec §5.5, §8).
 *
 * Everything matches on `KeyboardEvent.code`, not `key`, so bindings are
 * keyboard-layout independent — Digit1 is Digit1 on AZERTY too.
 */

export const SLOT_COUNT = 16

export interface Chord {
  code: string
  ctrl?: boolean
  shift?: boolean
}

/** Configurable: an input method or window manager may claim Ctrl+Space. */
export const PREFIX: Chord = { code: 'Space', ctrl: true }

export interface SlotBinding extends Chord {
  slot: number
  legend: string
}

function build(): SlotBinding[] {
  const out: SlotBinding[] = []
  // Slots 1–10: bare digits, 0 standing in for 10.
  for (let slot = 1; slot <= 10; slot++) {
    const digit = slot === 10 ? 0 : slot
    out.push({ slot, code: `Digit${digit}`, legend: String(digit) })
  }
  // Slots 11–16: Ctrl+digit where the browser allows it, Shift+digit always.
  for (let slot = 11; slot <= SLOT_COUNT; slot++) {
    const digit = slot - 10
    out.push({ slot, code: `Digit${digit}`, ctrl: true, legend: `Ctrl+${digit}` })
    out.push({ slot, code: `Digit${digit}`, shift: true, legend: `Shift+${digit}` })
  }
  return out
}

export const SLOT_BINDINGS: readonly SlotBinding[] = build()

/** Picker actions (spec §5.5). `p` is the only key projects add. */
export const PICKER_ACTIONS = {
  KeyN: 'next-done',
  KeyP: 'projects',
  KeyC: 'new-session',
  KeyR: 'rename',
  KeyX: 'kill',
  KeyM: 'mark-seen',
  Escape: 'close',
} as const

export type PickerAction = (typeof PICKER_ACTIONS)[keyof typeof PICKER_ACTIONS]

export interface KeyEventLike {
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

function matches(chord: Chord, e: KeyEventLike): boolean {
  return (
    e.code === chord.code &&
    e.ctrlKey === Boolean(chord.ctrl) &&
    e.shiftKey === Boolean(chord.shift) &&
    !e.altKey &&
    !e.metaKey
  )
}

export function isPrefix(e: KeyEventLike): boolean {
  return matches(PREFIX, e)
}

export function slotForEvent(e: KeyEventLike): number | null {
  for (const b of SLOT_BINDINGS) if (matches(b, e)) return b.slot
  return null
}

export function actionForEvent(e: KeyEventLike): PickerAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  return PICKER_ACTIONS[e.code as keyof typeof PICKER_ACTIONS] ?? null
}

/**
 * What Ctrl+Enter and Shift+Enter send instead of a bare CR.
 *
 * A terminal has no modifier bits for Enter — every variant is `\r` on the
 * wire — so a CLI cannot tell "newline" from "submit" without help. ESC+CR is
 * the sequence a native terminal is configured to send for those chords, and
 * what agent CLIs read as "break the line, do not run it". Here the emulator
 * is ours, so the mapping lives in the page rather than in a terminal profile.
 */
export const NEWLINE_SEQ = '\x1b\r'

export function isNewlineKey(e: KeyEventLike): boolean {
  if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return false
  // Alt+Enter already arrives as ESC+CR from xterm itself; leave it alone.
  return (e.ctrlKey || e.shiftKey) && !e.altKey && !e.metaKey
}

/** Both forms are printed on tiles 11–16, since only one may reach the page. */
export function legendForSlot(slot: number): string {
  return SLOT_BINDINGS.filter((b) => b.slot === slot)
    .map((b) => b.legend)
    .join(' / ')
}

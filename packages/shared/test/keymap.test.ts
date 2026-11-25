import { describe, it, expect } from 'vitest'
import {
  SLOT_COUNT, slotForEvent, actionForEvent, isPrefix, legendForSlot, SLOT_BINDINGS,
  isNewlineKey, NEWLINE_SEQ, isPasteKey,
} from '../src/keymap.ts'

const ev = (code: string, mods: Partial<Record<'ctrlKey'|'shiftKey'|'altKey'|'metaKey', boolean>> = {}) =>
  ({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods })

describe('keymap', () => {
  it('maps bare digits to slots 1-9 and 0 to slot 10', () => {
    for (let s = 1; s <= 9; s++) expect(slotForEvent(ev(`Digit${s}`))).toBe(s)
    expect(slotForEvent(ev('Digit0'))).toBe(10)
  })

  it('maps both Ctrl+digit and Shift+digit to slots 11-20, 0 standing in for 10', () => {
    for (let s = 11; s <= 20; s++) {
      const d = (s - 10) % 10
      expect(slotForEvent(ev(`Digit${d}`, { ctrlKey: true }))).toBe(s)
      expect(slotForEvent(ev(`Digit${d}`, { shiftKey: true }))).toBe(s)
    }
  })

  it('does not confuse Ctrl+1 with plain 1', () => {
    expect(slotForEvent(ev('Digit1'))).toBe(1)
    expect(slotForEvent(ev('Digit1', { ctrlKey: true }))).toBe(11)
  })

  it('maps Alt+1 to Alt+4 to slots 21-24', () => {
    for (let s = 21; s <= 24; s++) expect(slotForEvent(ev(`Digit${s - 20}`, { altKey: true }))).toBe(s)
  })

  it('prints both legends on slots 11-20 so either can be used', () => {
    expect(legendForSlot(1)).toBe('1')
    expect(legendForSlot(11)).toBe('Ctrl+1 / Shift+1')
    expect(legendForSlot(17)).toBe('Ctrl+7 / Shift+7')
    expect(legendForSlot(20)).toBe('Ctrl+0 / Shift+0')
    expect(legendForSlot(21)).toBe('Alt+1')
  })

  it('covers all 24 slots and nothing else', () => {
    expect(SLOT_COUNT).toBe(24)
    const slots = new Set(SLOT_BINDINGS.map((b) => b.slot))
    expect(slots.size).toBe(SLOT_COUNT)
    expect(Math.min(...slots)).toBe(1)
    expect(Math.max(...slots)).toBe(SLOT_COUNT)
  })

  it('ignores Meta, Alt past 4, and Ctrl+Alt (AltGr on Windows types characters)', () => {
    expect(slotForEvent(ev('Digit1', { metaKey: true }))).toBeNull()
    expect(slotForEvent(ev('Digit5', { altKey: true }))).toBeNull()
    expect(slotForEvent(ev('Digit0', { altKey: true }))).toBeNull()
    expect(slotForEvent(ev('Digit1', { altKey: true, ctrlKey: true }))).toBeNull()
    expect(slotForEvent(ev('Digit1', { altKey: true, shiftKey: true }))).toBeNull()
  })

  it('sends ESC+CR for Ctrl+Enter and Shift+Enter, plain CR for Enter', () => {
    expect(NEWLINE_SEQ).toBe('\x1b\r')
    expect(isNewlineKey(ev('Enter', { ctrlKey: true }))).toBe(true)
    expect(isNewlineKey(ev('Enter', { shiftKey: true }))).toBe(true)
    expect(isNewlineKey(ev('NumpadEnter', { ctrlKey: true }))).toBe(true)
    // Bare Enter still submits, and Alt+Enter is already ESC+CR from xterm.
    expect(isNewlineKey(ev('Enter'))).toBe(false)
    expect(isNewlineKey(ev('Enter', { altKey: true }))).toBe(false)
    expect(isNewlineKey(ev('Enter', { ctrlKey: true, metaKey: true }))).toBe(false)
    expect(isNewlineKey(ev('KeyR', { ctrlKey: true }))).toBe(false)
  })

  it('treats Ctrl+V as paste everywhere but a Mac', () => {
    expect(isPasteKey(ev('KeyV', { ctrlKey: true }), false)).toBe(true)
    // On a Mac Cmd+V pastes and Ctrl+V stays ^V.
    expect(isPasteKey(ev('KeyV', { ctrlKey: true }), true)).toBe(false)
    // Ctrl+Shift+V already reaches the browser as a paste.
    expect(isPasteKey(ev('KeyV', { ctrlKey: true, shiftKey: true }), false)).toBe(false)
    expect(isPasteKey(ev('KeyV'), false)).toBe(false)
    expect(isPasteKey(ev('KeyC', { ctrlKey: true }), false)).toBe(false)
  })

  it('recognises the prefix and picker actions', () => {
    expect(isPrefix(ev('Space', { ctrlKey: true }))).toBe(true)
    expect(isPrefix(ev('Space'))).toBe(false)
    expect(actionForEvent(ev('KeyP'))).toBe('projects')
    expect(actionForEvent(ev('KeyN'))).toBe('next-done')
    expect(actionForEvent(ev('Escape'))).toBe('close')
    expect(actionForEvent(ev('KeyP', { ctrlKey: true }))).toBeNull()
  })
})

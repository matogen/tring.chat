import { describe, it, expect } from 'vitest'
import {
  SLOT_COUNT, slotForEvent, actionForEvent, isPrefix, legendForSlot, SLOT_BINDINGS,
} from '../src/keymap.ts'

const ev = (code: string, mods: Partial<Record<'ctrlKey'|'shiftKey'|'altKey'|'metaKey', boolean>> = {}) =>
  ({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods })

describe('keymap', () => {
  it('maps bare digits to slots 1-9 and 0 to slot 10', () => {
    for (let s = 1; s <= 9; s++) expect(slotForEvent(ev(`Digit${s}`))).toBe(s)
    expect(slotForEvent(ev('Digit0'))).toBe(10)
  })

  it('maps both Ctrl+digit and Shift+digit to slots 11-16', () => {
    for (let s = 11; s <= SLOT_COUNT; s++) {
      const d = s - 10
      expect(slotForEvent(ev(`Digit${d}`, { ctrlKey: true }))).toBe(s)
      expect(slotForEvent(ev(`Digit${d}`, { shiftKey: true }))).toBe(s)
    }
  })

  it('does not confuse Ctrl+1 with plain 1', () => {
    expect(slotForEvent(ev('Digit1'))).toBe(1)
    expect(slotForEvent(ev('Digit1', { ctrlKey: true }))).toBe(11)
  })

  it('prints both legends on slots 11-16 so either can be used', () => {
    expect(legendForSlot(1)).toBe('1')
    expect(legendForSlot(11)).toBe('Ctrl+1 / Shift+1')
  })

  it('covers all 16 slots and nothing else', () => {
    const slots = new Set(SLOT_BINDINGS.map((b) => b.slot))
    expect(slots.size).toBe(SLOT_COUNT)
    expect(Math.min(...slots)).toBe(1)
    expect(Math.max(...slots)).toBe(SLOT_COUNT)
  })

  it('ignores Alt and Meta combinations', () => {
    expect(slotForEvent(ev('Digit1', { altKey: true }))).toBeNull()
    expect(slotForEvent(ev('Digit1', { metaKey: true }))).toBeNull()
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

describe('the browser binding', () => {
  const key = (code: string) => ({
    code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
  })

  it('binds b to attach or detach a browser', () => {
    expect(actionForEvent(key('KeyB'))).toBe('browser')
  })

  /** It shares the picker with n/p/c/r/x/m, so it must not have taken one. */
  it('leaves every existing action alone', () => {
    expect(actionForEvent(key('KeyN'))).toBe('next-done')
    expect(actionForEvent(key('KeyP'))).toBe('projects')
    expect(actionForEvent(key('KeyC'))).toBe('new-session')
    expect(actionForEvent(key('KeyR'))).toBe('rename')
    expect(actionForEvent(key('KeyX'))).toBe('kill')
    expect(actionForEvent(key('KeyM'))).toBe('mark-seen')
    expect(actionForEvent(key('Escape'))).toBe('close')
  })

  it('is not a slot key', () => {
    expect(slotForEvent(key('KeyB'))).toBeNull()
  })
})

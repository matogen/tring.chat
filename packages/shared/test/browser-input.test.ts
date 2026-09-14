import { describe, it, expect } from 'vitest'
import { sanitizeInput } from '../src/browser-input.ts'

const viewport = { width: 1280, height: 800 }
const clean = (raw: unknown) => sanitizeInput(raw, viewport)

describe('sanitizeInput', () => {
  it('refuses anything that is not an event', () => {
    for (const raw of [null, undefined, 42, 'click', [], {}, { kind: 'drag' }]) {
      expect(clean(raw), JSON.stringify(raw)).toBeNull()
    }
  })

  /**
   * The result is rebuilt field by field, so a property the sender invented
   * cannot ride along into a CDP dispatch.
   */
  it('drops fields it does not know about', () => {
    const out = clean({
      kind: 'mouse', action: 'down', x: 10, y: 20,
      __proto__: { polluted: true }, interceptedBy: 'evil', modifiers: 255,
    })
    expect(out).toEqual({ kind: 'mouse', action: 'down', x: 10, y: 20 })
    expect(out).not.toHaveProperty('interceptedBy')
    expect(out).not.toHaveProperty('modifiers')
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  describe('mouse', () => {
    it('passes an ordinary click through', () => {
      expect(clean({ kind: 'mouse', action: 'down', x: 100, y: 50, button: 'left', clicks: 1 }))
        .toEqual({ kind: 'mouse', action: 'down', x: 100, y: 50, button: 'left', clicks: 1 })
    })

    it('refuses an unknown action', () => {
      expect(clean({ kind: 'mouse', action: 'teleport', x: 1, y: 1 })).toBeNull()
    })

    it('refuses non-finite coordinates rather than passing NaN to CDP', () => {
      expect(clean({ kind: 'mouse', action: 'down', x: Number.NaN, y: 1 })).toBeNull()
      expect(clean({ kind: 'mouse', action: 'down', x: 1, y: Number.POSITIVE_INFINITY })).toBeNull()
      expect(clean({ kind: 'mouse', action: 'down', x: '10', y: 1 })).toBeNull()
    })

    /**
     * Clamped, not rejected: a coordinate a pixel outside a viewport that is
     * mid-resize is a race, and dropping it loses a click the user made.
     */
    it('clamps a coordinate outside the viewport', () => {
      expect(clean({ kind: 'mouse', action: 'down', x: 99999, y: -50 }))
        .toMatchObject({ x: 1280, y: 0 })
    })

    it('ignores a button it does not recognise', () => {
      expect(clean({ kind: 'mouse', action: 'down', x: 1, y: 1, button: 'thumb' }))
        .not.toHaveProperty('button')
    })

    it('caps the click count', () => {
      expect(clean({ kind: 'mouse', action: 'down', x: 1, y: 1, clicks: 9000 }))
        .toMatchObject({ clicks: 3 })
    })
  })

  describe('wheel', () => {
    it('passes an ordinary scroll through', () => {
      expect(clean({ kind: 'wheel', x: 10, y: 10, dx: 0, dy: 120 }))
        .toEqual({ kind: 'wheel', x: 10, y: 10, dx: 0, dy: 120 })
    })

    /** One event with an enormous delta scrolls a page anywhere in one dispatch. */
    it('bounds the delta', () => {
      expect(clean({ kind: 'wheel', x: 0, y: 0, dx: 1e12, dy: -1e12 }))
        .toMatchObject({ dx: 10_000, dy: -10_000 })
    })

    it('refuses a non-finite delta', () => {
      expect(clean({ kind: 'wheel', x: 0, y: 0, dx: 0, dy: Number.NaN })).toBeNull()
    })
  })

  describe('key', () => {
    it('passes a printable keystroke through', () => {
      expect(clean({ kind: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a' }))
        .toEqual({ kind: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a' })
    })

    it('keeps only the modifiers that were set', () => {
      expect(clean({ kind: 'key', action: 'down', key: 'c', code: 'KeyC', ctrl: true }))
        .toEqual({ kind: 'key', action: 'down', key: 'c', code: 'KeyC', ctrl: true })
    })

    it('treats a truthy non-true modifier as absent', () => {
      expect(clean({ kind: 'key', action: 'down', key: 'c', code: 'KeyC', ctrl: 'yes' }))
        .not.toHaveProperty('ctrl')
    })

    it('refuses a missing or non-string key or code', () => {
      expect(clean({ kind: 'key', action: 'down', code: 'KeyA' })).toBeNull()
      expect(clean({ kind: 'key', action: 'down', key: 'a' })).toBeNull()
      expect(clean({ kind: 'key', action: 'down', key: 1, code: 'KeyA' })).toBeNull()
    })

    /** `text` is one character or a short sequence; a novel is not a keystroke. */
    it('drops an over-long text payload but keeps the key', () => {
      const out = clean({
        kind: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'x'.repeat(5000),
      })
      expect(out).toMatchObject({ kind: 'key', key: 'a' })
      expect(out).not.toHaveProperty('text')
    })

    it('refuses an over-long key name', () => {
      expect(clean({ kind: 'key', action: 'down', key: 'x'.repeat(500), code: 'KeyA' }))
        .toBeNull()
    })
  })
})

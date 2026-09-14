import { describe, it, expect } from 'vitest'
import {
  clampRatio, DEFAULT_RATIO, halves, loadRatio, ratioForPointer, saveRatio, SNAP,
} from '../src/split.ts'

const store = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    raw: data,
  }
}

describe('clampRatio', () => {
  it('leaves an ordinary split alone', () => {
    expect(clampRatio(0.5)).toBe(0.5)
    expect(clampRatio(0.3)).toBe(0.3)
  })

  /**
   * Either half must be collapsible by dragging, because sessions differ: one
   * is a shell that occasionally checks a page, another is a page with a shell
   * attached (spec §5.13).
   */
  it('snaps a nearly-closed half fully shut', () => {
    expect(clampRatio(SNAP / 2)).toBe(0)
    expect(clampRatio(1 - SNAP / 2)).toBe(1)
  })

  it('falls back to the default rather than propagating a bad number', () => {
    expect(clampRatio(Number.NaN)).toBe(DEFAULT_RATIO)
    expect(clampRatio(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RATIO)
  })
})

describe('ratioForPointer', () => {
  it('maps a pointer position to its fraction of the cell', () => {
    expect(ratioForPointer(250, 1000)).toBeCloseTo(0.25)
  })

  it('snaps at the edges, so a drag to the end closes a half', () => {
    expect(ratioForPointer(0, 1000)).toBe(0)
    expect(ratioForPointer(1000, 1000)).toBe(1)
  })

  it('survives a zero-width cell during layout', () => {
    expect(ratioForPointer(10, 0)).toBe(DEFAULT_RATIO)
  })
})

describe('halves', () => {
  it('splits the cell between the two panes', () => {
    expect(halves(0.5)).toEqual({ term: '50%', browser: '50%' })
    expect(halves(0.25)).toEqual({ term: '25%', browser: '75%' })
  })

  /**
   * A collapsed half stays in the DOM at 0%, with the divider still there. A
   * half that was removed could not be dragged back open.
   */
  it('expresses a collapsed half as a real zero', () => {
    expect(halves(0)).toEqual({ term: '0%', browser: '100%' })
    expect(halves(1)).toEqual({ term: '100%', browser: '0%' })
  })

  it('always accounts for the whole cell', () => {
    for (const r of [0, 0.17, 0.333, 0.5, 0.81, 1]) {
      const { term, browser } = halves(r)
      expect(parseFloat(term) + parseFloat(browser)).toBeCloseTo(100, 5)
    }
  })
})

describe('remembering a split', () => {
  it('defaults when the session has never been split', () => {
    expect(loadRatio('s1', store())).toBe(DEFAULT_RATIO)
  })

  it('round-trips per session', () => {
    const s = store()
    saveRatio('s1', 0.3, s)
    saveRatio('s2', 0.7, s)
    expect(loadRatio('s1', s)).toBe(0.3)
    expect(loadRatio('s2', s)).toBe(0.7)
  })

  it('survives corrupt storage rather than throwing at boot', () => {
    const s = store({ 'tring.split': 'not json' })
    expect(loadRatio('s1', s)).toBe(DEFAULT_RATIO)
  })

  it('clamps what it reads, so a hand-edited value cannot wedge a half open', () => {
    const s = store({ 'tring.split': JSON.stringify({ s1: 42 }) })
    expect(loadRatio('s1', s)).toBe(1)
  })
})

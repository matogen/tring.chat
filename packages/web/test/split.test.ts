import { describe, it, expect } from 'vitest'
import {
  clampRatio, DEFAULT_RATIO, halves, letterbox, loadRatio, ratioForPointer, saveRatio,
  SNAP, toPagePoint,
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

describe('letterbox', () => {
  it('fills exactly when the aspect ratios match', () => {
    expect(letterbox({ width: 640, height: 400 }, { width: 1280, height: 800 }))
      .toEqual({ x: 0, y: 0, width: 640, height: 400 })
  })

  it('bars the sides when the canvas is wider than the page', () => {
    const box = letterbox({ width: 1000, height: 400 }, { width: 1280, height: 800 })
    expect(box).toEqual({ x: 180, y: 0, width: 640, height: 400 })
  })

  it('bars the top and bottom when the canvas is taller', () => {
    const box = letterbox({ width: 640, height: 800 }, { width: 1280, height: 800 })
    expect(box).toEqual({ x: 0, y: 200, width: 640, height: 400 })
  })

  it('survives a frame it has not received yet', () => {
    expect(letterbox({ width: 100, height: 50 }, { width: 0, height: 0 }))
      .toEqual({ x: 0, y: 0, width: 100, height: 50 })
  })
})

describe('toPagePoint', () => {
  const canvas = { width: 1000, height: 400 }
  const frame = { width: 1280, height: 800 }
  const viewport = { width: 1280, height: 800 }
  // Drawn at x=180, 640 wide, 400 tall.

  it('maps the centre of the frame to the centre of the page', () => {
    expect(toPagePoint({ x: 500, y: 200 }, canvas, frame, viewport))
      .toEqual({ x: 640, y: 400 })
  })

  it('maps the frame corners to the page corners', () => {
    expect(toPagePoint({ x: 180, y: 0 }, canvas, frame, viewport)).toEqual({ x: 0, y: 0 })
    expect(toPagePoint({ x: 820, y: 400 }, canvas, frame, viewport))
      .toEqual({ x: 1280, y: 800 })
  })

  it('scales through a frame smaller than the page', () => {
    // A thumbnail-sized screencast of the same 1280x800 page.
    const small = { width: 320, height: 200 }
    expect(toPagePoint({ x: 500, y: 200 }, canvas, small, viewport))
      .toEqual({ x: 640, y: 400 })
  })

  /**
   * A click on a bar is a click on nothing. Clamping it to the nearest edge is
   * how you dismiss a dialog you meant to read.
   */
  it('refuses a point in the letterbox bars rather than clamping it', () => {
    expect(toPagePoint({ x: 10, y: 200 }, canvas, frame, viewport)).toBeNull()
    expect(toPagePoint({ x: 990, y: 200 }, canvas, frame, viewport)).toBeNull()
    const tall = { width: 640, height: 800 }
    expect(toPagePoint({ x: 320, y: 10 }, tall, frame, viewport)).toBeNull()
  })

  it('refuses everything before the first frame arrives', () => {
    expect(toPagePoint({ x: 5, y: 5 }, canvas, { width: 0, height: 0 }, viewport))
      .not.toBeNull()
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

import { describe, it, expect } from 'vitest'
import { layoutFor, RING_SIZES } from '../src/ring-layout.ts'

/** `grid-area: r / c / rEnd / cEnd` — end lines are exclusive. */
function focusArea(focus: string) {
  const [r, c, rEnd, cEnd] = focus.split('/').map((p) => Number(p.trim()))
  return { r: r!, c: c!, rEnd: rEnd!, cEnd: cEnd! }
}

describe('ring layout', () => {
  it.each(RING_SIZES)('gives %i slots one cell each, numbered 1..n', (size) => {
    const { cells } = layoutFor(size)
    expect([...cells.keys()].sort((a, b) => a - b)).toEqual(
      [...Array(size)].map((_, i) => i + 1),
    )
  })

  it.each(RING_SIZES)('never puts two of the %i slots in the same cell', (size) => {
    const { cells } = layoutFor(size)
    const seen = new Set([...cells.values()].map((c) => `${c.row},${c.col}`))
    expect(seen.size).toBe(size)
  })

  it.each(RING_SIZES)('keeps all %i slots inside the grid and clear of the focus', (size) => {
    const { cols, rows, focus, cells } = layoutFor(size)
    const f = focusArea(focus)
    for (const [slot, { row, col }] of cells) {
      expect(row, `slot ${slot} row`).toBeGreaterThanOrEqual(1)
      expect(row, `slot ${slot} row`).toBeLessThanOrEqual(rows)
      expect(col, `slot ${slot} col`).toBeGreaterThanOrEqual(1)
      expect(col, `slot ${slot} col`).toBeLessThanOrEqual(cols)
      const under = row >= f.r && row < f.rEnd && col >= f.c && col < f.cEnd
      expect(under, `slot ${slot} sits under the focus terminal`).toBe(false)
    }
  })

  it('numbers clockwise from the top-left corner', () => {
    // Slot 1 is always top-left, and the next slot is always to its right.
    for (const size of RING_SIZES) {
      const { cells } = layoutFor(size)
      expect(cells.get(1)).toEqual({ row: 1, col: 1 })
      expect(cells.get(2)).toEqual({ row: 1, col: 2 })
    }
  })

  it('keeps the 16-slot ring exactly as it is today', () => {
    const { cols, rows, focus, cells } = layoutFor(16)
    expect({ cols, rows, focus }).toEqual({ cols: 5, rows: 5, focus: '2 / 2 / 5 / 5' })
    expect(cells.get(5)).toEqual({ row: 1, col: 5 })   // end of the top row
    expect(cells.get(9)).toEqual({ row: 5, col: 5 })   // bottom-right corner
    expect(cells.get(13)).toEqual({ row: 5, col: 1 })  // bottom-left corner
    expect(cells.get(16)).toEqual({ row: 2, col: 1 })  // last cell up the left side
  })

  it('lays 4 and 8 out as bands so the focus terminal gets the full width', () => {
    const four = layoutFor(4)
    expect({ cols: four.cols, rows: four.rows, focus: four.focus })
      .toEqual({ cols: 2, rows: 3, focus: '2 / 1 / 3 / 3' })
    expect(four.cells.get(3)).toEqual({ row: 3, col: 2 })
    expect(four.cells.get(4)).toEqual({ row: 3, col: 1 })

    const eight = layoutFor(8)
    expect({ cols: eight.cols, rows: eight.rows, focus: eight.focus })
      .toEqual({ cols: 4, rows: 3, focus: '2 / 1 / 3 / 5' })
    expect(eight.cells.get(5)).toEqual({ row: 3, col: 4 })
    expect(eight.cells.get(8)).toEqual({ row: 3, col: 1 })
  })
})

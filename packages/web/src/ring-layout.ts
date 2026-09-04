/**
 * Ring size, its grid geometry, and where each slot sits (spec §5.2).
 *
 * Two families, both numbered clockwise from the top-left:
 *
 *   Rings (12, 16) — the perimeter of an N×N grid with the focus terminal
 *   filling the inner (N-2)×(N-2). This is the original 5×5 layout, generalised.
 *
 *   Bands (4, 8) — a top row and a bottom row with the focus terminal spanning
 *   the full width between them. Below twelve slots a ring's side columns cost
 *   the centre more width than the tiles are worth, and fewer terminals is
 *   precisely when you want a bigger centre.
 *
 *      4 slots            8 slots            16 slots
 *   ┌────┬────┐      ┌──┬──┬──┬──┐      ┌──┬──┬──┬──┬──┐
 *   │ 1  │ 2  │      │1 │2 │3 │4 │      │1 │2 │3 │4 │5 │
 *   ├────┴────┤      ├──┴──┴──┴──┤      ├──┼──┴──┴──┼──┤
 *   │  focus  │      │   focus   │      │16│ focus  │6 │
 *   ├────┬────┤      ├──┬──┬──┬──┤      │…      …    …│
 *   │ 4  │ 3  │      │8 │7 │6 │5 │      └──┴──┴──┴──┴──┘
 *   └────┴────┘      └──┴──┴──┴──┘
 */

export const RING_SIZES = [4, 8, 12, 16] as const
export type RingSize = (typeof RING_SIZES)[number]

export const DEFAULT_RING_SIZE: RingSize = 16

export interface Cell {
  row: number
  col: number
}

export interface RingLayout {
  cols: number
  rows: number
  /** `grid-template-rows`; bands hand the middle row the height. */
  rowTemplate: string
  /** `grid-area` for the focus cell. */
  focus: string
  cells: Map<number, Cell>
}

export function layoutFor(size: RingSize): RingLayout {
  return size < 12 ? band(size / 2) : ring(size / 4 + 1)
}

/** `half` tiles along the top, `half` along the bottom, focus between. */
function band(half: number): RingLayout {
  const cells = new Map<number, Cell>()
  for (let col = 1; col <= half; col++) cells.set(col, { row: 1, col })
  for (let i = 0; i < half; i++) cells.set(half + 1 + i, { row: 3, col: half - i })
  return {
    cols: half,
    rows: 3,
    rowTemplate: '1fr 3fr 1fr',
    focus: `2 / 1 / 3 / ${half + 1}`,
    cells,
  }
}

/** The perimeter of an n×n grid, focus filling the inner (n-2)×(n-2). */
function ring(n: number): RingLayout {
  const walk: Cell[] = []
  for (let col = 1; col <= n; col++) walk.push({ row: 1, col })
  for (let row = 2; row <= n - 1; row++) walk.push({ row, col: n })
  for (let col = n; col >= 1; col--) walk.push({ row: n, col })
  for (let row = n - 1; row >= 2; row--) walk.push({ row, col: 1 })
  return {
    cols: n,
    rows: n,
    rowTemplate: `repeat(${n}, 1fr)`,
    focus: `2 / 2 / ${n} / ${n}`,
    cells: new Map(walk.map((c, i) => [i + 1, c])),
  }
}

/* ---------- the chosen size ---------- */

const STORAGE_KEY = 'tring.ring'

let current: RingSize = read()

function read(): RingSize {
  try {
    const n = Number(localStorage.getItem(STORAGE_KEY))
    return isRingSize(n) ? n : DEFAULT_RING_SIZE
  } catch {
    // Private windows and blocked storage still get the default.
    return DEFAULT_RING_SIZE
  }
}

export function isRingSize(n: number): n is RingSize {
  return (RING_SIZES as readonly number[]).includes(n)
}

export function ringSize(): RingSize {
  return current
}

/**
 * Purely a display choice, so it lives per browser rather than on the wire —
 * the daemon's slots are unchanged and every `create` names its slot explicitly.
 */
export function setRingSize(next: RingSize): void {
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, String(next))
  } catch {
    // Setting still applies for this session.
  }
}

/* ---------- applying it ---------- */

export function applyRing(ring: HTMLElement, focus: HTMLElement, size: RingSize): void {
  const l = layoutFor(size)
  ring.style.gridTemplateColumns = `repeat(${l.cols}, 1fr)`
  ring.style.gridTemplateRows = l.rowTemplate
  focus.style.gridArea = l.focus
}

export function placeInGrid(el: HTMLElement, slot: number, size: RingSize): void {
  const cell = layoutFor(size).cells.get(slot)
  if (!cell) return
  el.style.gridRow = String(cell.row)
  el.style.gridColumn = String(cell.col)
}

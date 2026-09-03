/**
 * Slot -> 5x5 grid cell, numbered clockwise from top-left (spec §5.2).
 *
 *   1  2  3  4  5
 *  16  [       ]  6
 *  15  [ focus ]  7
 *  14  [       ]  8
 *  13 12 11 10  9
 */
export const SLOT_COUNT = 16

function build(): Map<number, { row: number; col: number }> {
  const cells: { row: number; col: number }[] = []
  for (let col = 1; col <= 5; col++) cells.push({ row: 1, col })       // 1-5
  for (let row = 2; row <= 4; row++) cells.push({ row, col: 5 })       // 6-8
  for (let col = 5; col >= 1; col--) cells.push({ row: 5, col })       // 9-13
  for (let row = 4; row >= 2; row--) cells.push({ row, col: 1 })       // 14-16
  return new Map(cells.map((c, i) => [i + 1, c]))
}

export const SLOT_CELLS = build()

export function placeInGrid(el: HTMLElement, slot: number): void {
  const cell = SLOT_CELLS.get(slot)
  if (!cell) return
  el.style.gridRow = String(cell.row)
  el.style.gridColumn = String(cell.col)
}

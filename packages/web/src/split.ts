/**
 * The terminal/page divider of the focus cell (spec §5.13).
 *
 * Pure, and separate from the DOM for the same reason `ring-layout.ts` is: the
 * geometry is where the fiddly rules live, and they are worth testing without a
 * browser.
 */

const KEY = 'tring.split'

/** Fraction of the cell given to the terminal half. */
export type Ratio = number

export const DEFAULT_RATIO = 0.5
/**
 * Below this a half is not worth rendering, so it snaps shut.
 *
 * Collapsing must stay reachable by dragging, because sessions differ: one is a
 * shell that occasionally checks a page, another is a page with a shell
 * attached. Forcing a middle ground on both is what a fixed split would do.
 */
export const SNAP = 0.08

export function clampRatio(raw: number): Ratio {
  if (!Number.isFinite(raw)) return DEFAULT_RATIO
  if (raw < SNAP) return 0
  if (raw > 1 - SNAP) return 1
  return raw
}

/** Where a pointer at `x` inside a cell `width` wide puts the divider. */
export function ratioForPointer(x: number, width: number): Ratio {
  if (width <= 0) return DEFAULT_RATIO
  return clampRatio(x / width)
}

/**
 * CSS `flex-basis` percentages for the two halves.
 *
 * Returned as a pair rather than one number so a collapsed half is expressed as
 * a real zero — `0%` with the divider still present, so it can be dragged back
 * open. A half that was removed from the DOM could not be.
 */
export function halves(ratio: Ratio): { term: string; browser: string } {
  const t = Math.round(clampRatio(ratio) * 1000) / 10
  return { term: `${t}%`, browser: `${Math.round((100 - t) * 10) / 10}%` }
}

export interface Box { width: number; height: number }

/**
 * Where a frame lands inside a canvas, and the scale it was drawn at.
 *
 * A screencast is scaled to fit the size the viewer asked for and keeps the
 * page's aspect ratio, so it is letterboxed: there are bars, and a click in one
 * means nothing. This is the one piece of geometry both the painting and the
 * input mapping have to agree on, so they share it.
 */
export function letterbox(canvas: Box, frame: Box): {
  x: number; y: number; width: number; height: number
} {
  if (frame.width <= 0 || frame.height <= 0) {
    return { x: 0, y: 0, width: canvas.width, height: canvas.height }
  }
  const scale = Math.min(canvas.width / frame.width, canvas.height / frame.height)
  const width = frame.width * scale
  const height = frame.height * scale
  return { x: (canvas.width - width) / 2, y: (canvas.height - height) / 2, width, height }
}

/**
 * Canvas coordinates to page coordinates, or null in the letterbox bars.
 *
 * Null rather than a clamped edge coordinate: a click on a bar is not a click
 * near the edge of the page, it is a click on nothing, and turning it into one
 * at the boundary is how you dismiss a dialog you meant to read.
 */
export function toPagePoint(
  point: { x: number; y: number }, canvas: Box, frame: Box, viewport: Box,
): { x: number; y: number } | null {
  const box = letterbox(canvas, frame)
  if (box.width <= 0 || box.height <= 0) return null
  const dx = point.x - box.x
  const dy = point.y - box.y
  if (dx < 0 || dy < 0 || dx > box.width || dy > box.height) return null
  return {
    x: (dx / box.width) * viewport.width,
    y: (dy / box.height) * viewport.height,
  }
}

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** Remembered per session: the right split for a tile is a property of its work. */
export function loadRatio(sessionId: string, store: Store = localStorage): Ratio {
  try {
    const all = JSON.parse(store.getItem(KEY) ?? '{}') as Record<string, number>
    const found = all[sessionId]
    return found === undefined ? DEFAULT_RATIO : clampRatio(found)
  } catch {
    return DEFAULT_RATIO
  }
}

export function saveRatio(sessionId: string, ratio: Ratio, store: Store = localStorage): void {
  try {
    const all = JSON.parse(store.getItem(KEY) ?? '{}') as Record<string, number>
    all[sessionId] = clampRatio(ratio)
    store.setItem(KEY, JSON.stringify(all))
  } catch {
    // Storage full or disabled; the split just does not persist.
  }
}

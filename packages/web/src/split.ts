/**
 * How the focus cell is shared between the orchestrator agent's terminal and
 * the column of cards beside it (or, on a phone, the band above it).
 *
 * Both sides keep a minimum: cards narrower than a button row are useless,
 * and a terminal squeezed under ~40 columns makes Claude Code wrap every line.
 * When the cell is too small for both, the cards keep theirs and the
 * terminal gives way — the cards are the part that needs answering.
 */

/** Side by side. */
export const MIN_CARDS_WIDTH = 240
export const MIN_TERMINAL_WIDTH = 320
/** Stacked on a phone. */
export const MIN_CARDS_HEIGHT = 90
export const MIN_TERMINAL_HEIGHT = 160
/** The handle and its margins, which neither side gets. */
export const HANDLE_SPACE = 11

/** The cards' size along the split, given where the drag puts it and how much room there is. */
export function clampSplit(wanted: number, total: number, minCards: number, minTerminal: number): number {
  const most = Math.max(minCards, total - minTerminal - HANDLE_SPACE)
  return Math.round(Math.min(Math.max(wanted, minCards), most))
}

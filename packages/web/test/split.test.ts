import { describe, expect, it } from 'vitest'
import {
  clampSplit, HANDLE_SPACE, MIN_CARDS_HEIGHT, MIN_CARDS_WIDTH, MIN_TERMINAL_HEIGHT, MIN_TERMINAL_WIDTH,
} from '../src/split.ts'

describe('clampSplit', () => {
  const side = (wanted: number, total: number): number => clampSplit(wanted, total, MIN_CARDS_WIDTH, MIN_TERMINAL_WIDTH)

  it('gives the cards what the drag asks for when both sides fit', () => {
    expect(side(500, 1500)).toBe(500)
  })
  it('never squeezes the terminal under its minimum', () => {
    // Dragged nearly to the far edge: the terminal keeps 320px.
    expect(side(1400, 1500)).toBe(1500 - MIN_TERMINAL_WIDTH - HANDLE_SPACE)
  })
  it('never squeezes the cards under theirs', () => {
    expect(side(50, 1500)).toBe(MIN_CARDS_WIDTH)
  })
  it('lets the terminal give way when the cell is too small for both', () => {
    expect(side(500, 400)).toBe(MIN_CARDS_WIDTH)
  })
  it('works the same way stacked, in heights', () => {
    expect(clampSplit(600, 700, MIN_CARDS_HEIGHT, MIN_TERMINAL_HEIGHT)).toBe(700 - MIN_TERMINAL_HEIGHT - HANDLE_SPACE)
    expect(clampSplit(10, 700, MIN_CARDS_HEIGHT, MIN_TERMINAL_HEIGHT)).toBe(MIN_CARDS_HEIGHT)
  })
})

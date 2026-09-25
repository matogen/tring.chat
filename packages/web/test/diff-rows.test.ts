import { describe, it, expect } from 'vitest'
import { clampWidth, MIN_WIDTH, patchRows } from '../src/diff-rows.ts'

describe('patchRows', () => {
  it('numbers old and new lines independently across hunks', () => {
    const rows = patchRows([
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '@@ -10,2 +10,3 @@',
      ' j',
      '+k',
      ' l',
    ].join('\n'))
    expect(rows).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { kind: 'ctx', old: 1, new: 1, text: 'a' },
      { kind: 'del', old: 2, new: null, text: 'b' },
      { kind: 'add', old: null, new: 2, text: 'B' },
      { kind: 'ctx', old: 3, new: 3, text: 'c' },
      { kind: 'hunk', text: '@@ -10,2 +10,3 @@' },
      { kind: 'ctx', old: 10, new: 10, text: 'j' },
      { kind: 'add', old: null, new: 11, text: 'k' },
      { kind: 'ctx', old: 11, new: 12, text: 'l' },
    ])
  })

  it('starts a new file at line 1 and skips the no-newline marker', () => {
    expect(patchRows('@@ -0,0 +1,2 @@\n+x\n+y\n\\ No newline at end of file')).toEqual([
      { kind: 'hunk', text: '@@ -0,0 +1,2 @@' },
      { kind: 'add', old: null, new: 1, text: 'x' },
      { kind: 'add', old: null, new: 2, text: 'y' },
    ])
  })

  it('returns nothing for an empty patch', () => {
    expect(patchRows('')).toEqual([])
  })
})

describe('clampWidth', () => {
  it('keeps a width inside 240px and 75% of the cell', () => {
    expect(clampWidth(500, 1000)).toBe(500)
    expect(clampWidth(100, 1000)).toBe(MIN_WIDTH)
    expect(clampWidth(900, 1000)).toBe(750)
  })

  it('never goes below the minimum, even in a narrow cell', () => {
    expect(clampWidth(500, 200)).toBe(MIN_WIDTH)
  })
})

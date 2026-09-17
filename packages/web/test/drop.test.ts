import { describe, it, expect } from 'vitest'
import { pathForPrompt } from '../src/drop.ts'

describe('pathForPrompt', () => {
  it('leaves an ordinary path bare, which is what Claude Code reads', () => {
    expect(pathForPrompt('/home/dev/.config/tring/uploads/a1b2.png'))
      .toBe('/home/dev/.config/tring/uploads/a1b2.png')
  })

  it('quotes a path with a space, which a home directory can supply', () => {
    expect(pathForPrompt('C:\\Users\\Some Name\\.config\\tring\\uploads\\a1b2.png'))
      .toBe('"C:\\Users\\Some Name\\.config\\tring\\uploads\\a1b2.png"')
  })

  it('quotes on any whitespace, not only a plain space', () => {
    expect(pathForPrompt('/tmp/two\twords/a.png')).toBe('"/tmp/two\twords/a.png"')
  })
})

import { describe, expect, it } from 'vitest'

// drop.ts reaches the daemon through ws-client, which reads `location` and
// `localStorage` as it loads. The suite runs in node, so they are supplied
// before the import rather than by pulling in a whole DOM for one function.
Object.assign(globalThis, {
  location: { search: '', origin: 'http://127.0.0.1:7331' },
  localStorage: { getItem: () => null, setItem: () => {} },
})
const { quote } = await import('../src/drop.ts')

describe('quote', () => {
  it('leaves an ordinary path alone', () => {
    expect(quote('/tmp/tring-drops/m1-notes.md')).toBe('/tmp/tring-drops/m1-notes.md')
  })

  it('wraps a path with spaces so it stays one argument', () => {
    expect(quote('/tmp/my file.png')).toBe("'/tmp/my file.png'")
  })

  it('survives an apostrophe in the name', () => {
    expect(quote("/tmp/ruan's shot.png")).toBe("'/tmp/ruan'\\''s shot.png'")
  })
})

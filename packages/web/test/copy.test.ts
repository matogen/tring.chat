import { describe, expect, it } from 'vitest'
import { linksIn, logicalLines, recentLinks, screenText, type BufferLike } from '../src/copy.ts'

/** Rows as xterm holds them: a leading `+` marks a row wrapped from the one above. */
function buffer(rows: string[], viewportY = 0): BufferLike {
  return {
    length: rows.length,
    viewportY,
    getLine: (y) => {
      const r = rows[y]
      if (r === undefined) return undefined
      const wrapped = r.startsWith('+')
      const text = wrapped ? r.slice(1) : r
      return { isWrapped: wrapped, translateToString: (trim) => (trim ? text.trimEnd() : text) }
    },
  }
}

describe('logicalLines', () => {
  it('joins the rows a long line was wrapped into', () => {
    const b = buffer(['$ echo https://exa', '+mple.com/a', 'done'])
    expect(logicalLines(b, 0, 3)).toEqual(['$ echo https://example.com/a', 'done'])
  })

  it('keeps the spaces inside a wrapped line and trims only its end', () => {
    const b = buffer(['one two   ', '+three   '])
    expect(logicalLines(b, 0, 2)).toEqual(['one two   three'])
  })

  it('completes a line that straddles the range instead of cutting it', () => {
    const b = buffer(['https://a.example/', '+very/long', '+/path', 'x'])
    expect(logicalLines(b, 1, 2)).toEqual(['https://a.example/very/long/path'])
  })

  it('tolerates a range past either end of the buffer', () => {
    expect(logicalLines(buffer(['a']), -5, 9)).toEqual(['a'])
  })
})

describe('screenText', () => {
  it('is the viewport only, without the blank rows under the prompt', () => {
    const b = buffer(['old', 'Go to https://x.test/login', '$ ', '', ''], 1)
    expect(screenText(b, 4)).toBe('Go to https://x.test/login\n$')
  })
})

describe('linksIn', () => {
  it('finds each link once and drops the punctuation around it', () => {
    const out = linksIn('see https://a.test/x?y=1. Or (https://b.test/), https://a.test/x?y=1 again')
    expect(out).toEqual(['https://a.test/x?y=1', 'https://b.test/'])
  })

  it('finds nothing in text without a scheme', () => {
    expect(linksIn('example.com and http:// alone')).toEqual([])
  })
})

describe('recentLinks', () => {
  it('lists the most recent link first and looks no further back than asked', () => {
    const b = buffer(['https://old.test/', 'https://mid.test/', 'text', 'https://new.test/'])
    expect(recentLinks(b, 3)).toEqual(['https://new.test/', 'https://mid.test/'])
  })
})

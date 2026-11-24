import { describe, it, expect } from 'vitest'
import { parseInline, parseMarkdown, safeHref } from '../src/markdown.ts'

describe('parseInline', () => {
  it('reads bold, italics, code and strikethrough', () => {
    expect(parseInline('a **b** *c* `d` ~~e~~')).toEqual([
      { t: 'text', text: 'a ' },
      { t: 'strong', children: [{ t: 'text', text: 'b' }] },
      { t: 'text', text: ' ' },
      { t: 'em', children: [{ t: 'text', text: 'c' }] },
      { t: 'text', text: ' ' },
      { t: 'code', text: 'd' },
      { t: 'text', text: ' ' },
      { t: 'del', children: [{ t: 'text', text: 'e' }] },
    ])
  })

  it('nests italics inside bold', () => {
    expect(parseInline('**a *b***')).toEqual([
      { t: 'strong', children: [{ t: 'text', text: 'a ' }, { t: 'em', children: [{ t: 'text', text: 'b' }] }] },
    ])
  })

  it('leaves snake_case, arithmetic and unclosed markers alone', () => {
    expect(parseInline('snake_case_name')).toEqual([{ t: 'text', text: 'snake_case_name' }])
    expect(parseInline('2 * 3 * 4')).toEqual([{ t: 'text', text: '2 * 3 * 4' }])
    expect(parseInline('**open')).toEqual([{ t: 'text', text: '**open' }])
  })

  it('does not read markers inside code', () => {
    expect(parseInline('`**x**`')).toEqual([{ t: 'code', text: '**x**' }])
  })

  it('reads links and bare URLs', () => {
    expect(parseInline('see [docs](https://x.dev/a) or https://y.dev/b.')).toEqual([
      { t: 'text', text: 'see ' },
      { t: 'link', href: 'https://x.dev/a', children: [{ t: 'text', text: 'docs' }] },
      { t: 'text', text: ' or ' },
      { t: 'link', href: 'https://y.dev/b', children: [{ t: 'text', text: 'https://y.dev/b' }] },
      { t: 'text', text: '.' },
    ])
  })

  it('keeps escaped characters literal', () => {
    expect(parseInline('\\*not em\\*')).toEqual([{ t: 'text', text: '*not em*' }])
  })
})

describe('parseMarkdown', () => {
  it('splits headings, paragraphs, lists and code', () => {
    const blocks = parseMarkdown('## Done\n\nFixed it.\nAll green.\n\n- one\n- two\n\n```ts\nconst a = 1\n```')
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'para', 'list', 'code'])
    expect(blocks[1]).toEqual({ t: 'para', children: [{ t: 'text', text: 'Fixed it.\nAll green.' }] })
    expect(blocks[3]).toEqual({ t: 'code', lang: 'ts', text: 'const a = 1' })
  })

  it('reads ordered lists from their first number, with nesting', () => {
    const [list] = parseMarkdown('3. a\n4. b\n   - c')
    expect(list).toMatchObject({ t: 'list', ordered: true, start: 3 })
    expect(list!.t === 'list' && list!.items.map((i) => i.depth)).toEqual([0, 0, 1])
  })

  it('reads a table', () => {
    const [table] = parseMarkdown('| File | Lines |\n|---|---:|\n| `a.ts` | 3 |')
    expect(table).toEqual({
      t: 'table',
      head: [[{ t: 'text', text: 'File' }], [{ t: 'text', text: 'Lines' }]],
      rows: [[[{ t: 'code', text: 'a.ts' }], [{ t: 'text', text: '3' }]]],
    })
  })

  it('ends a paragraph where a list starts', () => {
    expect(parseMarkdown('Changes:\n- a').map((b) => b.t)).toEqual(['para', 'list'])
  })

  it('keeps an unclosed fence as code to the end', () => {
    expect(parseMarkdown('```\nx')).toEqual([{ t: 'code', lang: '', text: 'x' }])
  })
})

describe('safeHref', () => {
  it('allows only http and https', () => {
    expect(safeHref('https://a.dev/')).toBe('https://a.dev/')
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('data:text/html,x')).toBeNull()
    expect(safeHref('relative/path')).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'
import { snapshot } from '../src/snapshot.ts'

const term = () => new Terminal({ cols: 20, rows: 3, allowProposedApi: true })
const write = (t: Terminal, s: string) => new Promise<void>((r) => t.write(s, r))

describe('snapshot', () => {
  it('collapses plain text into a single run and trims trailing blanks', async () => {
    const t = term()
    await write(t, 'hello')
    const s = snapshot(t)
    expect(s.cols).toBe(20)
    expect(s.rows).toHaveLength(3)
    expect(s.rows[0]).toEqual([{ text: 'hello', fg: -1, bg: -1, bold: false }])
    expect(s.rows[1]).toEqual([])
  })

  it('splits runs on a colour change', async () => {
    const t = term()
    await write(t, 'ab\x1b[31mcd\x1b[0mef')
    const s = snapshot(t)
    expect(s.rows[0]).toEqual([
      { text: 'ab', fg: -1, bg: -1, bold: false },
      { text: 'cd', fg: 1, bg: -1, bold: false },
      { text: 'ef', fg: -1, bg: -1, bold: false },
    ])
  })

  it('records bold and background separately from foreground', async () => {
    const t = term()
    await write(t, '\x1b[1mB\x1b[0m\x1b[42mG\x1b[0m')
    const s = snapshot(t)
    expect(s.rows[0]?.[0]).toEqual({ text: 'B', fg: -1, bg: -1, bold: true })
    expect(s.rows[0]?.[1]).toEqual({ text: 'G', fg: -1, bg: 2, bold: false })
  })

  it('keeps interior spaces but drops the unused tail of a row', async () => {
    const t = term()
    await write(t, 'a b')
    expect(snapshot(t).rows[0]).toEqual([{ text: 'a b', fg: -1, bg: -1, bold: false }])
  })

  it('follows the viewport as content scrolls past the last row', async () => {
    const t = term()
    await write(t, 'one\r\ntwo\r\nthree\r\nfour')
    const s = snapshot(t)
    expect(s.rows.map((r) => r[0]?.text ?? '')).toEqual(['two', 'three', 'four'])
  })
})

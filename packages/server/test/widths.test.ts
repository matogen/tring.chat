import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { useModernWidths } from '../src/widths.ts'

const write = (t: Terminal, s: string) => new Promise<void>((r) => t.write(s, r))
const line = (t: Terminal, y: number) => t.buffer.active.getLine(y)?.translateToString(true)

describe('useModernWidths', () => {
  it('gives an emoji the two columns a TUI counts for it', async () => {
    const t = new Terminal({ cols: 20, rows: 2, allowProposedApi: true })
    useModernWidths(t)
    await write(t, '📎X')
    expect(t.buffer.active.cursorX).toBe(3)
  })

  // What Claude Code's renderer does on every frame: move to the cell it
  // means to change and write only that. It counts 📎 as two columns. A
  // terminal counting it as one puts the new word one cell to the right, and
  // the old text left behind reads as stray letters.
  it('lands a redraw on the cell the program aimed at, after an emoji', async () => {
    const draw = async (t: Terminal) => {
      await write(t, 'Attach (📎) old text')
      await write(t, '\x1b[1;13Hnew') // column 13 = 1 + width of 'Attach (📎) '
      return line(t, 0)
    }
    const modern = new Terminal({ cols: 40, rows: 2, allowProposedApi: true })
    useModernWidths(modern)
    expect(await draw(modern)).toBe('Attach (📎) new text')

    // The bug this fixes: xterm's built-in Unicode 6 table.
    const old = new Terminal({ cols: 40, rows: 2, allowProposedApi: true })
    expect(await draw(old)).toBe('Attach (📎) onewtext')
  })
})

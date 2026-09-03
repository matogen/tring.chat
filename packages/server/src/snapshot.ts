import type { Terminal } from '@xterm/headless'
import type { ScreenSnapshot, SnapshotCell } from '@tring/shared/protocol'

/**
 * Visible rows of a headless terminal as run-length cells (spec §4.1).
 *
 * Runs, not per-cell records: a terminal screen is mostly long stretches of
 * one colour, so this is what keeps 16 thumbnails at 4fps cheap enough to be
 * uninteresting. Trailing blank runs are dropped for the same reason — most
 * rows end in unused columns.
 */
export function snapshot(term: Terminal): ScreenSnapshot {
  const buf = term.buffer.active
  const rows: SnapshotCell[][] = []

  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y)
    const out: SnapshotCell[] = []

    if (line) {
      let run: SnapshotCell | null = null
      for (let x = 0; x < term.cols; x++) {
        const cell = line.getCell(x)
        if (!cell) break
        // Width 0 is the trailing half of a wide glyph; its chars live on the
        // first half, so emitting it would duplicate the character.
        if (cell.getWidth() === 0) continue

        const text = cell.getChars() || ' '
        const fg = cell.isFgDefault() ? -1 : cell.getFgColor()
        const bg = cell.isBgDefault() ? -1 : cell.getBgColor()
        const bold = cell.isBold() !== 0

        if (run && run.fg === fg && run.bg === bg && run.bold === bold) {
          run.text += text
        } else {
          run = { text, fg, bg, bold }
          out.push(run)
        }
      }

      // Unused columns are blank cells with default attributes, and they merge
      // into whatever run precedes them — so the tail has to be trimmed from
      // inside the last run, not just popped off as whole runs. A styled run
      // keeps its spaces: a trailing background colour is visible.
      while (out.length > 0) {
        const last = out[out.length - 1]!
        if (last.fg !== -1 || last.bg !== -1 || last.bold) break
        last.text = last.text.replace(/\s+$/, '')
        if (last.text !== '') break
        out.pop()
      }
    }

    rows.push(out)
  }

  return { cols: term.cols, rows }
}

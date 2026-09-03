import type { ScreenSnapshot } from '@tring/shared/protocol'
import { cssColor } from './xterm-theme.ts'

const BG = '#071411'
const FG = '#dceee7'

/**
 * One 2D canvas per slot (spec §5.3). Plain 2D, not WebGL: Chrome allows only
 * about 16 WebGL contexts per page and the focus terminal needs one of them.
 * Nothing is drawn between snapshots, so 16 busy sessions cost at most 64
 * small repaints a second.
 */
export class Thumbnail {
  private readonly ctx: CanvasRenderingContext2D | null
  private last: ScreenSnapshot | null = null

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })
  }

  paint(shot: ScreenSnapshot = this.last!): void {
    if (!this.ctx || !shot) return
    this.last = shot

    const dpr = window.devicePixelRatio || 1
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (w === 0 || h === 0) return

    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr)
      this.canvas.height = Math.round(h * dpr)
    }

    const ctx = this.ctx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = BG
    ctx.fillRect(0, 0, w, h)

    // Size the glyphs so a full-width row exactly spans the tile.
    const cw = w / Math.max(shot.cols, 1)
    const fontPx = Math.max(cw / 0.6, 1)
    const rowH = h / Math.max(shot.rows.length, 1)
    ctx.textBaseline = 'top'
    ctx.font = `${fontPx}px ${getComputedStyle(document.body).getPropertyValue('--mono')}`

    for (let y = 0; y < shot.rows.length; y++) {
      const row = shot.rows[y]
      if (!row) continue
      let x = 0
      for (const run of row) {
        const width = run.text.length * cw
        if (run.bg >= 0) {
          ctx.fillStyle = cssColor(run.bg, BG)
          ctx.fillRect(x, y * rowH, width, rowH)
        }
        if (run.text.trim() !== '') {
          ctx.fillStyle = cssColor(run.fg, FG)
          ctx.fillText(run.text, x, y * rowH)
        }
        x += width
      }
    }
  }

  /** Repaint at a new size after a layout change, without new data. */
  refresh(): void {
    if (this.last) this.paint(this.last)
  }
}

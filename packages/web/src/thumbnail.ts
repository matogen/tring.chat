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
  private page: ImageBitmap | null = null
  private decoding = false
  /** True once a browser is attached, which is what splits the tile. */
  private split = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })
  }

  /**
   * A tile with a page attached draws **both halves in fixed positions** — the
   * same split as the focus cell, same orientation.
   *
   * The tempting alternative, showing whichever half is currently active, was
   * rejected: you do not *read* a thumbnail, you recognise it, and a tile whose
   * content swaps underneath you costs more in recognition than it gains in
   * detail. A rendered page is distinguishable from a terminal at 100px on
   * shape and colour alone, which is exactly the size at which following the
   * activity would be indistinguishable from the tile having been replaced.
   */
  setSplit(on: boolean): void {
    if (this.split === on) return
    this.split = on
    if (!on) {
      this.page?.close()
      this.page = null
    }
    this.refresh()
  }

  paint(shot: ScreenSnapshot = this.last!): void {
    if (!this.ctx || !shot) return
    this.last = shot
    this.draw()
  }

  /** One JPEG screencast frame for the page half (spec §4.7). */
  paintFrame(jpeg: Uint8Array): void {
    if (this.decoding) return
    this.decoding = true
    const copy = new Uint8Array(jpeg)
    void createImageBitmap(new Blob([copy], { type: 'image/jpeg' }))
      .then((bitmap) => {
        this.page?.close()
        this.page = bitmap
        this.split = true
        this.draw()
      })
      .catch(() => {
        // A malformed frame leaves the previous one up.
      })
      .finally(() => { this.decoding = false })
  }

  /** Repaint at a new size after a layout change, without new data. */
  refresh(): void {
    this.draw()
  }

  private draw(): void {
    if (!this.ctx) return
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

    const termW = this.split ? Math.round(w / 2) : w
    if (this.last) this.drawScreen(ctx, this.last, termW, h)
    if (!this.split) return

    ctx.fillStyle = '#0b0b0d'
    ctx.fillRect(termW, 0, w - termW, h)
    if (this.page) {
      const pw = w - termW
      const scale = Math.min(pw / this.page.width, h / this.page.height)
      const dw = this.page.width * scale
      const dh = this.page.height * scale
      ctx.drawImage(this.page, termW + (pw - dw) / 2, (h - dh) / 2, dw, dh)
    }
    // A hairline, so the two halves read as one tile split rather than two
    // tiles that happen to be adjacent.
    ctx.fillStyle = 'rgba(110,240,195,.2)'
    ctx.fillRect(termW, 0, 1, h)
  }

  private drawScreen(
    ctx: CanvasRenderingContext2D, shot: ScreenSnapshot, w: number, h: number,
  ): void {
    // Size the glyphs so a full-width row exactly spans the half.
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
}

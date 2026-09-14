import type { BrowserInfo } from '@tring/shared/protocol'

/**
 * The page half of a split focus cell (spec §5.13).
 *
 * A thin client: it paints JPEG frames the daemon sends and, from stage 4,
 * forwards normalised input back. It does not run the page, hold a DOM, or know
 * a URL it was not told — which is what keeps this working over Tailscale and
 * on a phone, where a headed browser on the daemon's machine would not.
 */
export class BrowserPane {
  readonly root: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly urlEl: HTMLElement
  private readonly stateEl: HTMLElement
  private readonly blockedEl: HTMLElement

  /** One decode in flight at a time; see paintFrame. */
  private decoding = false
  private last: ImageBitmap | null = null

  onNavigate: ((to: 'back' | 'forward' | 'reload') => void) | null = null

  constructor() {
    this.root = el('div', 'browser-pane')

    const head = el('div', 'browser-head')
    for (const [action, glyph, label] of [
      ['back', '←', 'Back'],
      ['forward', '→', 'Forward'],
      ['reload', '↻', 'Reload'],
    ] as const) {
      const b = el('button', 'browser-nav') as HTMLButtonElement
      b.type = 'button'
      b.textContent = glyph
      b.title = label
      b.onclick = () => this.onNavigate?.(action)
      head.append(b)
    }
    this.urlEl = el('span', 'browser-url')
    this.stateEl = el('span', 'browser-control')
    head.append(this.urlEl, this.stateEl)

    this.blockedEl = el('div', 'browser-blocked')
    this.blockedEl.hidden = true

    this.canvas = document.createElement('canvas')
    this.ctx = this.canvas.getContext('2d', { alpha: false })
    const stage = el('div', 'browser-stage')
    stage.append(this.canvas)

    this.root.append(head, this.blockedEl, stage)
  }

  /** The size the daemon should screencast at, in CSS pixels. */
  size(): { width: number; height: number } {
    return {
      width: Math.max(1, Math.round(this.canvas.clientWidth)),
      height: Math.max(1, Math.round(this.canvas.clientHeight)),
    }
  }

  update(info: BrowserInfo | null): void {
    if (!info) return
    this.urlEl.textContent = info.title || info.url
    this.urlEl.title = info.url
    // Words, never an icon alone: two parties can act on this page, and "who is
    // holding it right now" has to be answerable from across the room (§5.13).
    const human = info.control === 'human'
    this.stateEl.textContent = human ? "You're driving" : 'Agent driving'
    this.stateEl.classList.toggle('human', human)
    this.root.classList.toggle('human-control', human)
    this.root.classList.toggle('loading', info.loading)
    this.blockedEl.hidden = !info.blockedOn
    if (info.blockedOn) this.blockedEl.textContent = info.blockedOn
  }

  /**
   * Paint one screencast frame.
   *
   * Frames are dropped while a decode is in flight rather than queued. The
   * daemon acks each frame before asking for the next, so a slow client already
   * throttles the producer; queueing here would defeat that and grow memory
   * behind a tab nobody is looking at.
   */
  paintFrame(jpeg: Uint8Array): void {
    if (this.decoding || !this.ctx) return
    this.decoding = true
    const copy = new Uint8Array(jpeg)
    void createImageBitmap(new Blob([copy], { type: 'image/jpeg' }))
      .then((bitmap) => {
        this.last?.close()
        this.last = bitmap
        this.draw()
      })
      .catch(() => {
        // A truncated or malformed frame is not worth a broken pane.
      })
      .finally(() => { this.decoding = false })
  }

  /** Repaint at a new size after a layout change, without new data. */
  refresh(): void {
    this.draw()
  }

  private draw(): void {
    const bitmap = this.last
    if (!this.ctx || !bitmap) return
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
    ctx.fillStyle = '#0b0b0d'
    ctx.fillRect(0, 0, w, h)
    // Letterboxed rather than stretched: the page has its own aspect ratio and
    // squashing it makes text unreadable at exactly the moment you are reading.
    const scale = Math.min(w / bitmap.width, h / bitmap.height)
    const dw = bitmap.width * scale
    const dh = bitmap.height * scale
    ctx.drawImage(bitmap, (w - dw) / 2, (h - dh) / 2, dw, dh)
  }

  dispose(): void {
    this.last?.close()
    this.last = null
    this.root.remove()
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  n.className = cls
  return n
}

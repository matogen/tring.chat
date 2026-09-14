import type { BrowserInfo, BrowserInputEvent } from '@tring/shared/protocol'
import { letterbox, toPagePoint } from './split.ts'

/**
 * Mouse moves are sampled rather than sent on every pixel.
 *
 * Hover matters — menus open on it — so they cannot be dropped entirely, but a
 * move event per pixel is a socket write per pixel for something the page
 * mostly ignores.
 */
const MOVE_MS = 40

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
  private viewport = { width: 1280, height: 800 }
  private lastMove = 0
  private readonly release: HTMLButtonElement

  onNavigate: ((to: 'back' | 'forward' | 'reload') => void) | null = null
  onInput: ((event: BrowserInputEvent) => void) | null = null
  onRelease: (() => void) | null = null

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
    // Handing control back is the button. Taking it is not: touching the page
    // grabs it, because taking control should be as fast as reaching for it
    // (spec §4.7).
    this.release = el('button', 'browser-release') as HTMLButtonElement
    this.release.type = 'button'
    this.release.textContent = 'Give back'
    this.release.title = 'Return control to the agent'
    this.release.hidden = true
    this.release.onclick = () => this.onRelease?.()
    head.append(this.urlEl, this.stateEl, this.release)

    this.blockedEl = el('div', 'browser-blocked')
    this.blockedEl.hidden = true

    this.canvas = document.createElement('canvas')
    this.ctx = this.canvas.getContext('2d', { alpha: false })
    const stage = el('div', 'browser-stage')
    // Focusable so it can receive keys at all. Keys reach the page only while
    // the pane holds focus, which is also what keeps them out of the xterm.
    stage.tabIndex = 0
    stage.append(this.canvas)
    this.bindInput(stage)

    this.root.append(head, this.blockedEl, stage)
  }

  /* ---------- input (spec §4.7) ---------- */

  private bindInput(stage: HTMLElement): void {
    const point = (ev: PointerEvent | WheelEvent): { x: number; y: number } | null => {
      const rect = this.canvas.getBoundingClientRect()
      return toPagePoint(
        { x: ev.clientX - rect.left, y: ev.clientY - rect.top },
        { width: rect.width, height: rect.height },
        { width: this.last?.width ?? 0, height: this.last?.height ?? 0 },
        this.viewport,
      )
    }

    stage.addEventListener('pointerdown', (ev) => {
      stage.focus()
      const p = point(ev)
      if (!p) return
      ev.preventDefault()
      stage.setPointerCapture(ev.pointerId)
      this.send({ kind: 'mouse', action: 'down', x: p.x, y: p.y, button: button(ev), clicks: ev.detail || 1 })
    })
    stage.addEventListener('pointerup', (ev) => {
      const p = point(ev)
      if (!p) return
      this.send({ kind: 'mouse', action: 'up', x: p.x, y: p.y, button: button(ev), clicks: ev.detail || 1 })
    })
    stage.addEventListener('pointermove', (ev) => {
      const now = Date.now()
      if (now - this.lastMove < MOVE_MS) return
      const p = point(ev)
      if (!p) return
      this.lastMove = now
      this.send({ kind: 'mouse', action: 'move', x: p.x, y: p.y })
    })
    stage.addEventListener('wheel', (ev) => {
      const p = point(ev)
      if (!p) return
      ev.preventDefault()
      this.send({ kind: 'wheel', x: p.x, y: p.y, dx: ev.deltaX, dy: ev.deltaY })
    }, { passive: false })
    // Right-click belongs to the page, not to the tile's rename dialog.
    stage.addEventListener('contextmenu', (ev) => ev.preventDefault())

    stage.addEventListener('keydown', (ev) => this.key(ev, 'down'))
    stage.addEventListener('keyup', (ev) => this.key(ev, 'up'))
  }

  private key(ev: KeyboardEvent, action: 'down' | 'up'): void {
    // Tab would walk out of the pane and Backspace would navigate the outer
    // page; both belong to the page being driven.
    ev.preventDefault()
    // A single printable character is text; everything else is a bare key. CDP
    // needs the distinction to produce a keypress at all.
    const text = action === 'down' && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey
      ? ev.key
      : undefined
    this.send({
      kind: 'key',
      action,
      key: ev.key,
      code: ev.code,
      ...(text ? { text } : {}),
      ...(ev.ctrlKey ? { ctrl: true } : {}),
      ...(ev.altKey ? { alt: true } : {}),
      ...(ev.shiftKey ? { shift: true } : {}),
      ...(ev.metaKey ? { meta: true } : {}),
    })
  }

  private send(event: BrowserInputEvent): void {
    this.onInput?.(event)
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
    this.viewport = info.viewport
    // Words, never an icon alone: two parties can act on this page, and "who is
    // holding it right now" has to be answerable from across the room (§5.13).
    const human = info.control === 'human'
    this.stateEl.textContent = human ? "You're driving" : 'Agent driving'
    this.stateEl.classList.toggle('human', human)
    this.release.hidden = !human
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
    // The same box maps input back to page coordinates, so both come from one
    // function rather than two that must be kept in step.
    const box = letterbox({ width: w, height: h }, bitmap)
    ctx.drawImage(bitmap, box.x, box.y, box.width, box.height)
  }

  dispose(): void {
    this.last?.close()
    this.last = null
    this.root.remove()
  }
}

function button(ev: PointerEvent): 'left' | 'middle' | 'right' {
  if (ev.button === 1) return 'middle'
  if (ev.button === 2) return 'right'
  return 'left'
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  n.className = cls
  return n
}

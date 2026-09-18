import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { xtermTheme } from './xterm-theme.ts'

/** RIS. xterm maps ESC c to a full reset, and it travels in the write queue. */
const RESET = '\x1bc'

/** The single real terminal (spec §5.4). Thumbnails are canvases, not this. */
export class FocusTerminal {
  readonly term: Terminal
  private readonly fit = new FitAddon()

  onInput: ((data: string) => void) | null = null
  /** Return true to let the key reach the PTY, false to swallow it. */
  shouldSendKey: ((e: KeyboardEvent) => boolean) | null = null

  constructor(container: HTMLElement) {
    this.term = new Terminal({
      theme: xtermTheme,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    })
    this.term.loadAddon(this.fit)
    this.term.open(container)

    // WebGL is the only context we spend; if it is unavailable the canvas
    // renderer is still correct, just slower.
    try {
      this.term.loadAddon(new WebglAddon())
    } catch {
      /* fall back silently */
    }

    this.term.onData((d) => this.onInput?.(d))
    this.term.attachCustomKeyEventHandler((e) => this.shouldSendKey?.(e) ?? true)
    this.bindTouchScroll(container)
    this.fitNow()
  }

  /**
   * xterm scrolls the normal buffer under a finger by itself, but it drops
   * every touch the moment a program turns mouse tracking on (Claude Code
   * runs with `?1003h`), and in the alternate screen there is no scrollback
   * for it to move anyway. So on a phone the one terminal you can read does
   * not scroll. A wheel, on the other hand, xterm already routes correctly in
   * all three states: a wheel report to a mouse-tracking program, arrow keys
   * in the alternate screen, the viewport otherwise. Rather than reimplement
   * that, a swipe is turned into one synthetic wheel event per row of travel
   * and handed to the element xterm listens on. The normal-buffer case is
   * left to xterm, whose own touch handling is pixel-exact there.
   */
  private bindTouchScroll(container: HTMLElement): void {
    let lastY = 0
    let carry = 0
    container.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) return
        lastY = e.touches[0]!.clientY
        carry = 0
      },
      { capture: true, passive: true },
    )
    container.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length !== 1) return
        if (!this.wantsWheel()) return
        // Capture phase, ahead of xterm's own listener on a descendant: it
        // must not also see this touch, and the browser must not turn it into
        // a pull-to-refresh or an emulated click.
        e.preventDefault()
        e.stopPropagation()
        const t = e.touches[0]!
        // A finger moving up drags the content up, which is a wheel *down*.
        carry += (lastY - t.clientY) / this.rowHeight()
        lastY = t.clientY
        const lines = Math.trunc(carry)
        if (lines === 0) return
        carry -= lines
        const screen = container.querySelector('.xterm-screen')
        if (!screen) return
        const init: WheelEventInit = {
          deltaY: Math.sign(lines),
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: t.clientX,
          clientY: t.clientY,
          bubbles: true,
          cancelable: true,
        }
        for (let i = 0; i < Math.abs(lines); i++) screen.dispatchEvent(new WheelEvent('wheel', init))
      },
      { capture: true, passive: false },
    )
  }

  /** True when xterm would ignore the touch and needs it as a wheel instead. */
  private wantsWheel(): boolean {
    return this.term.modes.mouseTrackingMode !== 'none' || this.term.buffer.active.type === 'alternate'
  }

  private rowHeight(): number {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen')
    const h = screen && this.term.rows > 0 ? screen.clientHeight / this.term.rows : 0
    // Before the first fit the screen has no height; a font-sized fallback
    // keeps a swipe from dividing by zero.
    return h > 0 ? h : 16
  }

  /**
   * xterm's `write` is queued and parsed asynchronously, but `reset()` is
   * synchronous and jumps that queue — so output that had already been buffered
   * from the session you just left flushes *after* the reset and paints itself
   * back over the new one. Sending RIS (`ESC c`) through the same queue keeps
   * the order: everything pending is parsed, then the screen is reset, then
   * this replay lands. One write, so nothing can interleave.
   */
  replay(ansi: string): void {
    this.term.write(RESET + ansi)
  }

  write(data: Uint8Array): void {
    this.term.write(data)
  }

  clear(): void {
    this.term.write(RESET)
  }

  focus(): void {
    this.term.focus()
  }

  fitNow(): { cols: number; rows: number } {
    try {
      this.fit.fit()
    } catch {
      /* container not laid out yet */
    }
    return { cols: this.term.cols, rows: this.term.rows }
  }
}

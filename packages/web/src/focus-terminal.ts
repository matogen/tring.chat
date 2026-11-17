import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { isNewlineKey, isPasteKey, NEWLINE_SEQ } from '@tring/shared/keymap'
import { xtermTheme } from './xterm-theme.ts'
import { attachImeReset } from './ime-reset.ts'

/** RIS. xterm maps ESC c to a full reset, and it travels in the write queue. */
const RESET = '\x1bc'

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)

/** The single real terminal (spec §5.4). Thumbnails are canvases, not this. */
export class FocusTerminal {
  readonly term: Terminal
  private readonly fit = new FitAddon()

  onInput: ((data: string) => void) | null = null
  /** Return true to let the key reach the PTY, false to swallow it. */
  shouldSendKey: ((e: KeyboardEvent) => boolean) | null = null
  /** A mouse selection just finished; the text it covers. */
  onSelect: ((text: string) => void) | null = null

  constructor(container: HTMLElement) {
    this.term = new Terminal({
      theme: xtermTheme,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      // Shift+drag selects past mouse tracking elsewhere; this is the Mac's.
      macOptionClickForcesSelection: true,
      scrollback: 5000,
    })
    this.term.loadAddon(this.fit)
    // An emoji is two columns to Claude Code and one in xterm's own table, so
    // its redraws landed one cell off and scattered stray letters. The daemon
    // loads the same table; see widths.ts there.
    this.term.loadAddon(new Unicode11Addon())
    this.term.unicode.activeVersion = '11'
    this.term.open(container)

    this.loadWebgl()

    this.term.onData((d) => this.onInput?.(d))
    if (this.term.textarea) attachImeReset(this.term.textarea, (fn) => this.term.onData(fn))
    this.term.attachCustomKeyEventHandler((e) => {
      if (this.shouldSendKey?.(e) === false) return false
      // Returning false without preventDefault leaves the keystroke to the
      // browser, which fires the paste event xterm and paste.ts read.
      if (e.type === 'keydown' && isPasteKey(e, IS_MAC)) return false
      if (e.type === 'keydown' && isNewlineKey(e)) {
        e.preventDefault()
        this.onInput?.(NEWLINE_SEQ)
        return false
      }
      return true
    })
    this.bindTouchScroll(container)
    this.bindCopyOnSelect(container)
    this.fitNow()
  }

  /**
   * WebGL is the only GPU context we use. If it is unavailable, xterm's DOM
   * renderer still draws correctly, only more slowly.
   *
   * The browser can take the context away at any time: a GPU driver reset,
   * waking from sleep, or Chrome restarting its GPU process. The addon then
   * waits a few seconds for the context to come back, and if it does not, it
   * stops drawing and fires onContextLoss. Nothing else happens, so the
   * terminal looked frozen. Input still reached the PTY and output still
   * arrived, but the screen never changed again until a reload. The addon
   * leaves the response to the app, so the dead one is dropped here and
   * a new one is tried. If the GPU keeps losing contexts, the DOM renderer
   * takes over for good.
   */
  private webglLosses = 0
  private loadWebgl(): void {
    let addon: WebglAddon
    try {
      addon = new WebglAddon()
      this.term.loadAddon(addon)
    } catch {
      return
    }
    addon.onContextLoss(() => {
      addon.dispose()
      if (++this.webglLosses < 3) this.loadWebgl()
      this.term.refresh(0, this.term.rows - 1)
    })
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

  /**
   * Highlighting copies, as in every Linux terminal. Copied on mouseup rather
   * than on each selection change, which fires for every cell of a drag.
   * While Claude Code tracks the mouse a plain drag is its, not a selection;
   * Shift+drag (Option+drag on a Mac) selects regardless.
   */
  private bindCopyOnSelect(container: HTMLElement): void {
    container.addEventListener('mouseup', () => {
      // xterm settles a double- or triple-click selection after the mouseup.
      queueMicrotask(() => {
        const text = this.term.getSelection()
        if (text) this.onSelect?.(text)
      })
    })
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

  /**
   * Text the user did not type — a dropped image's path.
   *
   * `paste` rather than a write: it wraps the text for an app that asked for
   * bracketed paste, which is how Claude Code tells a path arriving whole from
   * someone typing one character at a time.
   */
  paste(text: string): void {
    this.term.paste(text)
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

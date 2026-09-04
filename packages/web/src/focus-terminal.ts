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
    this.fitNow()
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

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { xtermTheme } from './xterm-theme.ts'

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

  replay(ansi: string): void {
    this.term.reset()
    this.term.write(ansi)
  }

  write(data: Uint8Array): void {
    this.term.write(data)
  }

  clear(): void {
    this.term.reset()
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

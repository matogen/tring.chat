import { createRequire } from 'node:module'
import type { Terminal } from '@xterm/headless'
import type { Unicode11Addon as Unicode11AddonT } from '@xterm/addon-unicode11'

// A CJS bundle like the other xterm packages; see the note in session.ts.
const require = createRequire(import.meta.url)
const { Unicode11Addon } = require('@xterm/addon-unicode11') as { Unicode11Addon: typeof Unicode11AddonT }

/**
 * Counts character widths the way the programs inside the terminal do.
 *
 * xterm's built-in table is Unicode 6, where an emoji such as 📎 or ✅ is one
 * column wide. Claude Code and every other Ink or modern TUI counts it as
 * two. Such a program redraws by moving the cursor to the cell it means to
 * change and writing only that, so after an emoji every move landed one cell
 * off and left stray letters all over the screen. Unicode 11's table agrees
 * with them.
 *
 * The browser's terminal loads the same table (focus-terminal.ts). The
 * daemon's copy is what a refocus or a reconnect replays, so the two must
 * agree with each other as well as with the program.
 */
export function useModernWidths(term: Terminal): void {
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
}

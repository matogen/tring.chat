import type { ITheme } from '@xterm/xterm'

/**
 * Surfaces branded, ANSI 0-15 left at xterm's defaults (spec §5.1).
 *
 * The ANSI palette is an API, not decoration: `ls` colour-codes file types by
 * it and `git diff` uses red and green. Tinting it to match the brand would
 * make a red diff line arguable and could collide ANSI green (success) with
 * mint (agent done) — the one distinction this app exists to make.
 */
export const xtermTheme: ITheme = {
  background: '#040c0a',
  foreground: '#dceee7',
  cursor: '#3ee9a4',
  cursorAccent: '#040c0a',
  selectionBackground: 'rgba(15, 174, 124, 0.35)',
}

/** xterm's default 16, used to paint thumbnails consistently with the centre. */
const ANSI16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
]

const CUBE = [0, 95, 135, 175, 215, 255]

/** Maps a snapshot cell colour to CSS. -1 means "use the surface default". */
export function cssColor(n: number, fallback: string): string {
  if (n < 0) return fallback
  if (n < 16) return ANSI16[n] ?? fallback
  if (n < 232) {
    const i = n - 16
    const r = CUBE[Math.floor(i / 36) % 6]!
    const g = CUBE[Math.floor(i / 6) % 6]!
    const b = CUBE[i % 6]!
    return `rgb(${r},${g},${b})`
  }
  if (n < 256) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v},${v},${v})`
  }
  // Beyond the palette the daemon handed us a packed 24-bit true colour.
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`
}

/**
 * A prompt typed into an agent's terminal, the way a person pasting it would.
 *
 * Sent as a bracketed paste so a multi-line prompt arrives as one prompt
 * rather than as several Enters, then Enter on its own a beat later: some
 * TUIs drop a CR that lands in the same read as the paste's end marker.
 */
export const PASTE_SETTLE_MS = 60

/**
 * The text with anything that could act as a keystroke rather than as text
 * taken out: paste markers (which would end the paste early and let the rest
 * run as keys) and control characters other than newline and tab.
 */
export function cleanPrompt(text: string): string {
  return String(text ?? '')
    .replace(/\x1b\[20[01]~/g, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trimEnd()
}

export function typePrompt(target: { write(data: string): void }, text: string): void {
  target.write(`\x1b[200~${text}\x1b[201~`)
  setTimeout(() => target.write('\r'), PASTE_SETTLE_MS).unref?.()
}

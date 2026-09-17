/**
 * What a piece of terminal input could have set going.
 *
 * The status tracker reads work off the byte stream, and cannot otherwise tell
 * an agent starting to think from a full-screen app redrawing itself. Knowing
 * that the last thing the user sent was a wheel notch or an arrow key settles
 * it: neither can start anything, so whatever is printed next is the app
 * repainting for us (spec §4.2, and see ECHO_MS in status.ts).
 */

export type InputKind = 'command' | 'navigation'

/**
 * One navigation sequence.
 *
 * The mouse forms are the ones xterm can emit, because which one an app gets
 * depends on the DEC modes it asked for: SGR and SGR-pixels (`?1006`/`?1016`)
 * for anything modern, urxvt (`?1015`), and the original three-byte report.
 * The key forms cover both the normal and the application-cursor encodings —
 * a wheel notch arrives as an arrow key, not a mouse report, whenever the app
 * is on the alternate screen and has asked for no mouse tracking at all.
 */
const NAVIGATION = new RegExp('^(?:' + [
  '\\x1b\\[<\\d+;\\d+;\\d+[Mm]', // SGR, SGR-pixels
  '\\x1b\\[\\d+;\\d+;\\d+M', // urxvt
  '\\x1b\\[M[\\s\\S]{3}', // X10, UTF-8
  '\\x1b\\[[\\d;]*[ABCDHF]', // arrows, home, end — with or without modifiers
  '\\x1bO[ABCDHF]', // the same in application cursor mode
  '\\x1b\\[[145678]~', // home, end, page up, page down
  '\\x1b\\[[IO]', // focus in, focus out — the terminal answering, not the user
].join('|') + ')')

/**
 * Anything not recognised is a command: the cost of being wrong that way is a
 * tile that turns amber when it always did, and the cost of the other way is a
 * tile that never reports the work it was built to report.
 */
export function inputKind(data: string): InputKind {
  if (!data) return 'command'
  // A single wheel notch on the alternate screen is several arrow sequences in
  // one write, so it is the whole string that has to be navigation, not a
  // prefix of it.
  let rest = data
  while (rest.length > 0) {
    const match = NAVIGATION.exec(rest)
    if (!match) return 'command'
    rest = rest.slice(match[0].length)
  }
  return 'navigation'
}

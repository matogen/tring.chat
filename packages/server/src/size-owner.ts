/**
 * Whose screen each session's PTY is sized for.
 *
 * A PTY has one size, and every browser watching the session sees what the
 * program drew for that size. Before this, the last client to send a size won
 * outright: open a tile on the phone and the PC's terminal, still 200 columns
 * wide, went on receiving redraws laid out for 45 — garbled until the PC
 * window was resized.
 *
 * Now the size follows the device in use. A client owns a session's size once
 * it focuses it, types into it, or claims it (its window regains focus, a
 * click on its terminal, a window resize). Every other client watching is told
 * the PTY's size and draws at exactly that size — narrower or clipped, never
 * garbled — until it claims the size back. A passive resize (a panel opening,
 * a card arriving) from a client that does not own the size is recorded but
 * changes nothing: it must not steal the size from the device in use.
 *
 * The trade-off against tmux's "smallest client wins": that never needs a
 * claim, but a PC would sit at phone width for as long as a phone was
 * connected. Here each device gets its own size while it is being used, at the
 * cost of a redraw when you switch devices.
 */
export class SizeOwners<C> {
  private readonly owners = new Map<string, C>()

  owner(sessionId: string): C | undefined {
    return this.owners.get(sessionId)
  }

  /** Makes `client` the owner. True when it was not already. */
  claim(sessionId: string, client: C): boolean {
    if (this.owners.get(sessionId) === client) return false
    this.owners.set(sessionId, client)
    return true
  }

  /** A resize nobody asked to win: only the owner's, or one for an unowned session, applies. */
  mayResize(sessionId: string, client: C): boolean {
    const o = this.owners.get(sessionId)
    return o === undefined || o === client
  }

  /** The client looked away from the session or went away: it owns nothing there any more. */
  release(client: C, sessionId?: string): void {
    for (const [id, o] of this.owners) {
      if (o === client && (sessionId === undefined || id === sessionId)) this.owners.delete(id)
    }
  }
}

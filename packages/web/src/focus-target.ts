import type { SessionInfo } from '@tring/shared/protocol'

/** Which session the centre terminal is showing, and the slot it sits in. */
export interface FocusTarget {
  id: string
  slot: number
}

/**
 * Where the focus belongs after a fresh `state`, given where it was.
 *
 * A session id does not survive everything the session does. A respawn kills
 * the PTY and forks a new one with a new id into the same slot, and so does a
 * daemon restart. A client that remembers only the id is then pointed at
 * something that no longer exists — and nothing about that looks broken from
 * the outside: the tile keeps painting, because thumbnails are addressed per
 * project, while the centre terminal never receives another byte and every
 * keystroke is dropped by the daemon as an unknown id. The terminal is frozen
 * with a live session sitting directly behind it.
 *
 * The slot is the part that survives, so the slot is what the focus follows.
 */
export function followFocus(
  current: FocusTarget | null,
  sessions: readonly SessionInfo[],
): FocusTarget | null {
  if (!current) return null
  if (sessions.some((s) => s.id === current.id)) return current
  const heir = sessions.find((s) => s.slot === current.slot)
  // No heir means the slot really is empty — killed, or its project deleted —
  // and the centre should go blank rather than keep a dead session's pixels.
  return heir ? { id: heir.id, slot: heir.slot } : null
}

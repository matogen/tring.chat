/**
 * Session activity state machine (spec §4.2).
 *
 * Pure and clock-injected: every method takes `now` in milliseconds, so tests
 * drive time directly instead of faking timers. One instance per session; it
 * runs for every session in every project, active or not, because it only
 * reads the byte stream the daemon is already consuming.
 */

import type { InputKind } from './input.ts'

export type SessionStatus = 'idle' | 'busy' | 'done' | 'exited'

/** Output must continue this long to count as sustained. */
export const SUSTAINED_MS = 1500
/** ...or this many bytes must arrive inside one burst. */
export const SUSTAINED_BYTES = 2048
/** A burst is broken by a gap longer than this. */
export const BURST_GAP_MS = SUSTAINED_MS
export const DEFAULT_IDLE_MS = 3000

/**
 * How long output keeps being read as the repaint a navigation key asked for.
 *
 * A full-screen app redraws whenever you move around inside it, and one redraw
 * of a coloured Claude Code screen clears SUSTAINED_BYTES on its own, in a
 * single chunk. As bytes that is indistinguishable from an agent starting
 * work, so scrolling turned the tile amber and then, seconds later, green.
 *
 * Only navigation opens this window (see input.ts): a command you actually ran
 * still goes busy on the output it produces, immediately, as it always did.
 */
export const ECHO_MS = 300

/**
 * How long a session must have been working before falling quiet is treated as
 * news worth announcing.
 *
 * Idle detection cannot distinguish "the app finished answering" from "the app
 * finished starting up" — both are output followed by silence. Claude Code
 * renders its interface for a few seconds and then waits, which is real work to
 * a byte stream and nothing at all to a human. An explicit signal (a Stop hook,
 * OSC 133;D, a bell) bypasses this entirely, because those mean exactly one
 * thing.
 */
export const NOTABLE_BUSY_MS = 10_000

export class ActivityTracker {
  status: SessionStatus = 'idle'
  since: number
  exitCode: number | null = null
  /**
   * Whether the current `done` is worth interrupting someone for. True when an
   * explicit signal said so, or when the session had been working long enough
   * that falling quiet is meaningful.
   */
  notable = false

  private readonly idleMs: number
  private busyStartedAt: number | null = null
  private burstStart: number | null = null
  private burstBytes = 0
  private lastOutput: number | null = null
  private lastNavigation: number | null = null

  constructor(now: number, idleMs: number = DEFAULT_IDLE_MS) {
    this.since = now
    this.idleMs = idleMs
  }

  /** PTY produced `bytes` of output. */
  output(bytes: number, now: number): void {
    if (this.status === 'exited') return

    // A gap longer than BURST_GAP_MS means the previous burst ended; output
    // that resumes after a pause is a new burst, not a continuing one.
    if (this.lastOutput !== null && now - this.lastOutput > BURST_GAP_MS) {
      this.resetBurst()
    }
    this.lastOutput = now

    // busy stays busy; done stays green until acknowledged (spec §4.2).
    if (this.status !== 'idle') return

    // Output right behind a navigation key is the repaint it asked for, not
    // the session working (see ECHO_MS). Dropped from the burst rather than
    // merely ending it, because one repaint is over the threshold by itself.
    if (this.lastNavigation !== null && now - this.lastNavigation <= ECHO_MS) {
      this.resetBurst()
      return
    }

    if (this.burstStart === null) this.burstStart = now
    this.burstBytes += bytes
    if (now - this.burstStart >= SUSTAINED_MS || this.burstBytes >= SUSTAINED_BYTES) {
      this.transition('busy', now)
    }
  }

  /**
   * The user drove this session: a keystroke, a paste, a mouse report from a
   * wheel. Only the focused session receives input.
   */
  input(now: number, kind: InputKind = 'command'): void {
    // Keeps echo from accumulating toward the sustained-output threshold.
    this.resetBurst()
    // Navigation cannot have started anything, so what the app prints next is
    // it redrawing itself. A command can, so it closes the window again —
    // scrolling and then pressing enter must still report the work.
    this.lastNavigation = kind === 'navigation' ? now : null
    if (this.status === 'done') this.transition('idle', now)
  }

  /** OSC 133;C — a command started. */
  commandStart(now: number): void {
    if (this.status === 'idle') this.transition('busy', now)
  }

  /** OSC 133;D — a command ended. */
  commandEnd(now: number): void {
    this.finish(now)
  }

  /** BEL (0x07). */
  bell(now: number): void {
    this.finish(now)
  }

  /** POST /api/sessions/:id/done, e.g. the Claude Code Stop hook. */
  hook(now: number): void {
    this.finish(now)
  }

  /** Explicit "mark seen" from the picker. */
  ack(now: number): void {
    if (this.status === 'done') this.transition('idle', now)
  }

  exit(code: number, now: number): void {
    this.exitCode = code
    this.transition('exited', now)
  }

  /** Called on a timer; detects the quiet period that ends a busy session. */
  tick(now: number): void {
    if (this.status !== 'busy') return
    if (this.lastOutput === null) return
    if (now - this.lastOutput < this.idleMs) return
    // Inferred, not declared: trust it only after sustained work.
    this.notable =
      this.busyStartedAt !== null && now - this.busyStartedAt >= NOTABLE_BUSY_MS
    this.transition('done', now)
  }

  /**
   * `done` is only ever entered from `busy` (spec §4.2): if nothing happened,
   * there is nothing to report. This means an explicit signal that arrives
   * while idle — a Stop hook after a reply too short to register as sustained
   * output, or OSC 133;D after `echo hi` — is deliberately ignored. Those are
   * the cases where a green tile would be noise, not news.
   */
  private finish(now: number): void {
    if (this.status !== 'busy') return
    // An explicit signal is unambiguous: something finished and said so.
    this.notable = true
    this.transition('done', now)
  }

  private transition(status: SessionStatus, now: number): void {
    if (this.status === status) return
    if (status === 'busy') this.busyStartedAt = now
    if (status === 'idle' || status === 'busy') this.notable = false
    this.status = status
    this.since = now
    this.resetBurst()
  }

  private resetBurst(): void {
    this.burstStart = null
    this.burstBytes = 0
  }
}

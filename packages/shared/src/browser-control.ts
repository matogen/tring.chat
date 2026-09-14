/**
 * Who is driving an attached page (spec §4.7).
 *
 * Pure and clock-injected like ActivityTracker, so the handover rules are
 * tested without a browser. One instance per attached browser.
 *
 * The problem this exists for: a human and an agent can both dispatch into the
 * same page, and simultaneous input corrupts form state and moves the DOM under
 * whichever of them is mid-action. So control is single-valued, explicit, and
 * always rendered.
 */

import type { BrowserControlHolder } from './protocol.ts'

export type { BrowserControlHolder }

/** What a requesting agent action should do right now. */
export type ActionVerdict = 'run' | 'parked'

export class BrowserControl {
  holder: BrowserControlHolder = 'agent'
  since: number

  /** FIFO, so a parked agent resumes in the order it asked. */
  private queue: string[] = []

  constructor(now: number) {
    this.since = now
  }

  get parked(): number {
    return this.queue.length
  }

  /**
   * The human touched the page.
   *
   * Grabbing is implicit — any input takes the wheel — because taking control
   * should be as fast as reaching for it, not a button to find first. Returns
   * whether this changed anything, so a stream of mouse-moves does not restamp
   * `since` on every event.
   */
  grab(now: number): boolean {
    if (this.holder === 'human') return false
    this.holder = 'human'
    this.since = now
    return true
  }

  /**
   * The human handed it back, explicitly.
   *
   * There is no timeout counterpart and there must not be one: returning
   * control on a timer while someone is halfway through a login form is exactly
   * the wrong behaviour, and the moments a human holds the wheel longest are
   * the moments it matters most that it stays held.
   *
   * Returns the parked actions, oldest first, for the caller to resume.
   */
  release(now: number): string[] {
    if (this.holder === 'agent') return []
    this.holder = 'agent'
    this.since = now
    const resumed = this.queue
    this.queue = []
    return resumed
  }

  /**
   * An agent action wants to act on the page.
   *
   * Parked, not refused. An erroring tool call makes an agent retry-loop
   * against a wall, burning tokens and filling its context with failures; a
   * blocked one makes it wait, which is what a person in the same position
   * would do.
   *
   * `readOnly` actions always run: reading the page cannot collide with a human
   * typing into it, and refusing them would leave an agent that has just been
   * handed control unable to see what it was handed.
   */
  request(actionId: string, opts: { readOnly?: boolean } = {}): ActionVerdict {
    if (opts.readOnly) return 'run'
    if (this.holder === 'agent') return 'run'
    // Asking twice while parked must not queue twice; the caller is awaiting
    // one resumption, and resuming it twice would replay the action.
    if (!this.queue.includes(actionId)) this.queue.push(actionId)
    return 'parked'
  }

  /** The agent gave up on a parked action — a tool timeout, or a killed session. */
  abandon(actionId: string): void {
    const i = this.queue.indexOf(actionId)
    if (i >= 0) this.queue.splice(i, 1)
  }
}

/**
 * Turns "parked" into something an agent can await (spec §4.8).
 *
 * Separate from BrowserControl, and from the page, because this is the piece
 * that hangs an agent forever if it is wrong: a resume that misses its waiter
 * is a tool call that never returns. Timeout is injected so the wait is
 * testable in milliseconds.
 */
export class ActionGate {
  private readonly waiters = new Map<string, (granted: boolean) => void>()

  constructor(
    private readonly control: BrowserControl,
    private readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get waiting(): number {
    return this.waiters.size
  }

  /**
   * Resolves true when the action may proceed, false when the wait expired.
   *
   * False is not an error: it means "the human still has this", which the agent
   * can report and retry. The bound exists only so a request cannot hang
   * forever, not to express a policy.
   */
  async wait(actionId: string, opts: { readOnly?: boolean } = {}): Promise<boolean> {
    if (this.control.request(actionId, opts) === 'run') return true
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.control.abandon(actionId)
        this.waiters.delete(actionId)
        resolve(false)
      }, this.timeoutMs)
      // Never keep a process alive for a page nobody is waiting on.
      timer.unref?.()
      this.waiters.set(actionId, (granted) => {
        clearTimeout(timer)
        resolve(granted)
      })
    })
  }

  /** Hand the wheel back and wake everything the control released. */
  release(): string[] {
    const resumed = this.control.release(this.now())
    for (const id of resumed) {
      const waiter = this.waiters.get(id)
      this.waiters.delete(id)
      waiter?.(true)
    }
    return resumed
  }

  /** Wake everything without granting — the page is going away. */
  abandonAll(): void {
    for (const [id, waiter] of this.waiters) {
      this.control.abandon(id)
      waiter(false)
    }
    this.waiters.clear()
  }
}

import type { HookPayload } from './inbox.ts'

/**
 * Whether a Stop is the agent handing the turn back to you, and so worth a
 * "finished, waiting for you" card, or only a pause in work it will carry on
 * with by itself.
 *
 * Claude Code fires Stop at the end of every turn, and a turn ends far more
 * often than the work does: when the agent has a shell running in the
 * background, a Monitor watching a log, a subagent out, or a wakeup or /loop
 * scheduled, it ends its turn and is woken again when that reports, and each
 * of those turns ends with another Stop. Since 2.1 the Stop payload says so
 * itself: `background_tasks` lists the work still in flight and
 * `session_crons` the wakeups, for exactly this ("lets hooks distinguish
 * 'session is done' from 'session is paused waiting for background work to
 * wake it'"). That is the signal used here, ahead of anything read from the
 * message.
 *
 * - Nothing pending: a hand-back. Carded after a short settle, so a queued
 *   prompt the agent picks up straight away, or another Stop hook sending it
 *   back to work, cancels the card before it shows (see Inbox.replySoon).
 * - The message asks you something: a hand-back whatever is pending. An agent
 *   that leaves a dev server running and asks "Want me to add tests?" is
 *   waiting for you, not for the server.
 * - A wakeup, Monitor, subagent or workflow pending: not a hand-back. Each of
 *   those wakes the agent by design, and the Stop after that decides.
 * - Only background shells pending: those wake the agent when they exit, and
 *   one that never does (a dev server, a watcher) would hold the card
 *   forever. So unless the agent says it is waiting for them ("Waiting for
 *   the eval to finish", "I'll come back when the build is done"), the card
 *   comes after a few quiet minutes instead of never.
 *
 * Not `stop_hook_active`: it says this Stop follows one another hook already
 * blocked, which is often the last one. Whether a hook blocks this one is not
 * in the payload; the settle delay is what catches that.
 */

/** A hand-back shows this long after the Stop, unless the agent does anything first. */
export const SETTLE_MS = 3_000
/** Only background shells pending, and nothing said about waiting for them. */
export const SHELL_GRACE_MS = 5 * 60_000

/** One entry of the Stop payload's `background_tasks`. */
export interface BackgroundTask {
  id?: string
  /** 'shell', 'subagent', 'monitor', 'workflow', … */
  type?: string
  status?: string
  description?: string
  command?: string
}

/** One entry of the Stop payload's `session_crons`: CronCreate, ScheduleWakeup, /loop. */
export interface SessionCron {
  id?: string
  schedule?: string
  recurring?: boolean
  prompt?: string
}

/** Statuses that are over: a task the payload still lists with one of these will not wake anyone. */
const OVER = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'done', 'error'])

function pending(payload: HookPayload): { tasks: BackgroundTask[]; crons: SessionCron[] } {
  const tasks = Array.isArray(payload.background_tasks) ? payload.background_tasks : []
  const crons = Array.isArray(payload.session_crons) ? payload.session_crons : []
  return {
    tasks: tasks.filter((t) => t && typeof t === 'object' && !OVER.has(String(t.status ?? '').toLowerCase())),
    crons: crons.filter((c) => c && typeof c === 'object'),
  }
}

/** Markdown out, for reading the last lines. */
const plain = (s: string): string => s.replace(/\*\*|__|`/g, '').trim()

/** Words that put it to you, in the last few lines. "Let me know" counts: it is waiting for you. */
const ASKING = /\b(?:let me know|tell me|waiting (?:for|on) (?:you|your)|your call|up to you|which (?:one|do you|would you|should)|should I|shall I|do you want|would you like|want me to|pick one|choose)\b/i

/** The message asks you something: a question at its end, a ❓ round or ➡️ recommendation, or words that put it to you. */
export function asksUser(message: string): boolean {
  const lines = message.split(/\r?\n/).map(plain).filter(Boolean)
  if (lines.some((l) => /^(?:❓|➡️|➡)/.test(l))) return true
  const tail = lines.slice(-4)
  return tail.some((l) => /\?\s*(?:\([^)]*\))?[)"'”’]*\s*$/.test(l)) || tail.some((l) => ASKING.test(l))
}

/**
 * The agent says it is waiting for its own background work, not for you:
 * "Waiting for the eval to finish", "I'll come back automatically when…",
 * "I'll report back once the build is done".
 */
const WAITING = new RegExp([
  String.raw`\bwait(?:ing)? (?:for|on|until) (?!you\b|your\b)`,
  String.raw`\b(?:I'll|I will|I'm going to|will)\s+(?:\w+\s+){0,3}?(?:come back|check back|report back|get back|be back|follow up|pick (?:it|this|that) up|continue|carry on|resume|be (?:notified|woken|pinged)|wake)\b`,
  String.raw`\bonce (?:it|they|that|this|the [\w-]+)(?: [\w-]+)? (?:finish(?:es)?|completes?|is done|are done|exits?|returns?)\b`,
  String.raw`\bwhen (?:it|they|that|this|the [\w-]+)(?: [\w-]+)? (?:finish(?:es)?|completes?|is done|are done|exits?|returns?|lands)\b`,
  String.raw`\bautomatically\b`,
  String.raw`\bin the background\b.*\b(?:watch|wait|monitor|poll)`,
].join('|'), 'i')

export function waitingOnItself(message: string): boolean {
  return WAITING.test(message.replace(/[’‘]/g, "'"))
}

/**
 * How long after this Stop its reply card should show, if nothing happens in
 * the meantime; null for no card at all (the agent will be woken, and the
 * Stop after that decides).
 */
export function handBackDelay(payload: HookPayload, message: string): number | null {
  if (!message.trim()) return null
  if (asksUser(message)) return SETTLE_MS
  const { tasks, crons } = pending(payload)
  if (!tasks.length && !crons.length) return SETTLE_MS
  if (crons.length || tasks.some((t) => (t.type ?? 'shell') !== 'shell')) return null
  return waitingOnItself(message) ? null : SHELL_GRACE_MS
}

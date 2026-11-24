import { randomUUID } from 'node:crypto'
import type {
  InboxDecision, InboxItem, InboxQuestion,
} from '@tring/shared/protocol'

/**
 * The orchestrator inbox: one card per thing an agent is waiting on.
 *
 * Permission and question cards are each tied to a hook request that is held
 * open until the card is settled — by an answer here, by the auto-answerer,
 * or by the request going away because the prompt was answered in the
 * terminal instead. That tie is the whole defence against a stale card:
 * Claude Code has no "prompt resolved" event, so the only reliable sign that
 * a prompt is over is that the hook asking about it has hung up.
 *
 * Pure apart from the id source: no HTTP, no sockets, no PTYs.
 */

export interface Settlement {
  decision: InboxDecision
  answers?: Record<string, string>
  message?: string
}

type Settle = (s: Settlement) => void

interface Entry {
  item: InboxItem
  /** Null for a reply card: nothing is waiting on it but the user. */
  settle: Settle | null
}

/** The fields a hook event carries that the inbox reads. Everything is optional. */
export interface HookPayload {
  hook_event_name?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  last_assistant_message?: string
  notification_type?: string
  message?: string
  session_id?: string
  /** Where Claude Code records the conversation; sent with every event. */
  transcript_path?: string
  cwd?: string
  /** SessionStart: startup | resume | clear | compact. */
  source?: string
  /** SessionEnd: clear | logout | prompt_input_exit | other … */
  reason?: string
}

export class Inbox {
  private readonly entries = new Map<string, Entry>()
  onChange: (() => void) | null = null

  constructor(
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  list(): InboxItem[] {
    return [...this.entries.values()]
      .map((e) => e.item)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): InboxItem | undefined {
    return this.entries.get(id)?.item
  }

  /** A card someone is waiting on. `settle` is called exactly once. */
  open(fields: Omit<InboxItem, 'id' | 'createdAt'>, settle: Settle | null): InboxItem {
    const item: InboxItem = { ...fields, id: this.newId(), createdAt: this.now() }
    this.entries.set(item.id, { item, settle })
    this.onChange?.()
    return item
  }

  /** A finished session's last word. One per session: a newer one replaces it. */
  reply(sessionId: string, message: string): InboxItem {
    this.drop((i) => i.sessionId === sessionId && i.kind === 'reply')
    return this.open({ sessionId, kind: 'reply', message }, null)
  }

  /** Settles and removes a card. False when it is already gone. */
  answer(id: string, s: Settlement): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.entries.delete(id)
    entry.settle?.(s)
    this.onChange?.()
    return true
  }

  /**
   * Removes every card matching `pred`, handing each waiting hook back to the
   * terminal. Used for the hook that hung up, the session that exited, and
   * the events that prove a card is stale.
   */
  drop(pred: (item: InboxItem) => boolean): number {
    let n = 0
    for (const [id, entry] of this.entries) {
      if (!pred(entry.item)) continue
      this.entries.delete(id)
      entry.settle?.({ decision: 'terminal' })
      n++
    }
    if (n) this.onChange?.()
    return n
  }

  dropSession(sessionId: string, kind?: InboxItem['kind']): number {
    return this.drop((i) => i.sessionId === sessionId && (!kind || i.kind === kind))
  }
}

/** AskUserQuestion's input, checked rather than trusted. */
export function questionsOf(input: unknown): InboxQuestion[] | null {
  const qs = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(qs) || qs.length === 0) return null
  const out: InboxQuestion[] = []
  for (const q of qs as Array<Record<string, unknown>>) {
    if (typeof q?.['question'] !== 'string' || !Array.isArray(q['options'])) return null
    out.push({
      question: q['question'],
      ...(typeof q['header'] === 'string' ? { header: q['header'] } : {}),
      multiSelect: q['multiSelect'] === true,
      options: (q['options'] as Array<Record<string, unknown>>)
        .filter((o) => typeof o?.['label'] === 'string')
        .map((o) => ({
          label: o['label'] as string,
          ...(typeof o['description'] === 'string' ? { description: o['description'] } : {}),
        })),
    })
  }
  return out
}

/** Stable text for comparing two tool inputs; key order does not matter. */
export function sameInput(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>)
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([k, w]) => [k, norm(w)]))
      : Array.isArray(v) ? v.map(norm) : v
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

/**
 * What the hook prints back to Claude Code, or null for "say nothing", which
 * lets Claude carry on to its own terminal prompt.
 *
 * Shapes are from the Claude Code hooks reference. A question is answered by
 * allowing the AskUserQuestion call with its input plus an `answers` map.
 */
export function hookOutput(
  event: string,
  input: Record<string, unknown> | undefined,
  s: Settlement,
): Record<string, unknown> | null {
  if (s.decision === 'terminal') return null
  if (event === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: s.decision === 'allow'
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: s.message?.trim() || 'Denied from the tring inbox.' },
      },
    }
  }
  if (event === 'PreToolUse') {
    if (s.decision === 'deny') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: s.message?.trim() || 'Declined from the tring inbox.',
        },
      }
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...(input ?? {}), answers: s.answers ?? {} },
      },
    }
  }
  return null
}

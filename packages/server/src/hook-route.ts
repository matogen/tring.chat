import type { InboxItem } from '@tring/shared/protocol'
import { hookOutput, questionsOf, sameInput, type HookPayload, type Inbox } from './inbox.ts'

/** The slice of a Session this needs, so tests can pass a stub. */
export interface HookSession {
  id: string
  /** Marks a busy session done — the explicit signal the Stop hook always sent. */
  hook(): void
  /** Records (or, with null, forgets) the Claude conversation running here. */
  setClaude(conv: { id: string; cwd: string } | null): void
}

/**
 * SessionEnd reasons that mean the user ended the conversation. Anything else
 * — `other` is what a signal gives — is left alone: stopping tring or the
 * machine signals Claude too, and that is exactly the conversation a restart
 * should reopen.
 */
const USER_ENDED = new Set(['prompt_input_exit', 'logout', 'clear'])

export interface HookRequest {
  inbox: Inbox
  session: HookSession
  event: string
  payload: HookPayload
  /** Aborts when the hook process hangs up, i.e. the prompt ended elsewhere. */
  signal: AbortSignal
  /** Called once per new permission card; may settle it through the inbox. */
  onPermission?: (item: InboxItem) => void
}

/**
 * One Claude Code hook event, turned into inbox state and a reply for the hook.
 *
 * Resolves to the JSON the hook should print, or null to print nothing and
 * let Claude Code carry on as if no hook were installed. Every path that is
 * unsure lands on null: the worst case is then the prompt the user would have
 * seen without tring, never a decision nobody made.
 */
export function routeHook(req: HookRequest): Promise<Record<string, unknown> | null> {
  const { inbox, session, event, payload } = req
  const tool = payload.tool_name
  const input = payload.tool_input

  switch (event) {
    case 'PermissionRequest':
      // AskUserQuestion is carded from PreToolUse, where it can be answered.
      if (!tool || tool === 'AskUserQuestion') return Promise.resolve(null)
      return hold(req, { sessionId: session.id, kind: 'permission', tool, input: input ?? {} })

    case 'PreToolUse': {
      if (tool !== 'AskUserQuestion') return Promise.resolve(null)
      const questions = questionsOf(input)
      if (!questions) return Promise.resolve(null)
      return hold(req, { sessionId: session.id, kind: 'question', tool, input: input ?? {}, questions })
    }

    case 'Stop': {
      session.hook()
      const said = payload.last_assistant_message?.trim()
      if (said) inbox.reply(session.id, said)
      return Promise.resolve(null)
    }

    case 'Notification':
      session.hook()
      return Promise.resolve(null)

    // New, resumed, after /clear or a compaction: whichever, it is now the
    // conversation this tile would reopen.
    case 'SessionStart':
      if (payload.session_id) session.setClaude({ id: payload.session_id, cwd: payload.cwd ?? '' })
      return Promise.resolve(null)

    case 'SessionEnd':
      if (payload.reason && USER_ENDED.has(payload.reason)) session.setClaude(null)
      return Promise.resolve(null)

    // The user typed into this session's own terminal: whatever its cards
    // were asking has been dealt with there.
    case 'UserPromptSubmit':
      inbox.dropSession(session.id)
      return Promise.resolve(null)

    // The tool ran (or failed), so its permission prompt is over. Matched on
    // the tool and its input, not just the session: agents run tools in
    // parallel, and another tool finishing says nothing about this one.
    case 'PostToolUse':
    case 'PostToolUseFailure':
      inbox.drop((i) =>
        i.sessionId === session.id && i.kind === 'permission' &&
        i.tool === tool && sameInput(i.input, input))
      return Promise.resolve(null)
  }
  return Promise.resolve(null)
}

function hold(
  req: HookRequest,
  fields: Omit<InboxItem, 'id' | 'createdAt'>,
): Promise<Record<string, unknown> | null> {
  const { inbox, signal, event, payload } = req
  return new Promise((resolve) => {
    let id: string | null = null
    const onAbort = (): void => { if (id) inbox.drop((i) => i.id === id) }
    const item = inbox.open(fields, (s) => {
      signal.removeEventListener('abort', onAbort)
      resolve(hookOutput(event, payload.tool_input, s))
    })
    id = item.id
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    if (item.kind === 'permission') req.onPermission?.(item)
  })
}

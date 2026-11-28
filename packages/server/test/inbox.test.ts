import { describe, it, expect, vi } from 'vitest'
import { hookOutput, Inbox, questionsOf, sameInput, type Settlement } from '../src/inbox.ts'
import { routeHook, type HookSession } from '../src/hook-route.ts'
import type { InboxItem } from '@tring/shared/protocol'

const mkInbox = () => {
  let n = 0
  let t = 1000
  return new Inbox(() => t++, () => `i${++n}`)
}

const session = (id = 's1'): HookSession & { hooks: number; conv: { id: string; cwd: string } | null | undefined } => {
  const s = { id, hooks: 0, conv: undefined as { id: string; cwd: string } | null | undefined, hook() { s.hooks++ }, setClaude(c: { id: string; cwd: string } | null) { s.conv = c } }
  return s
}

const ask = {
  questions: [{
    question: 'Which DB?', header: 'DB', multiSelect: false,
    options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }],
  }],
}

describe('Inbox', () => {
  it('lists oldest first and settles a card exactly once', () => {
    const inbox = mkInbox()
    const settled: Settlement[] = []
    const a = inbox.open({ sessionId: 's1', kind: 'permission', tool: 'Bash' }, (s) => settled.push(s))
    inbox.open({ sessionId: 's2', kind: 'permission', tool: 'Edit' }, null)
    expect(inbox.list().map((i) => i.tool)).toEqual(['Bash', 'Edit'])

    expect(inbox.answer(a.id, { decision: 'allow' })).toBe(true)
    expect(inbox.answer(a.id, { decision: 'deny' })).toBe(false)
    expect(settled).toEqual([{ decision: 'allow' }])
    expect(inbox.list()).toHaveLength(1)
  })

  it('hands dropped cards back to the terminal', () => {
    const inbox = mkInbox()
    const settle = vi.fn()
    inbox.open({ sessionId: 's1', kind: 'question' }, settle)
    inbox.open({ sessionId: 's2', kind: 'question' }, null)
    expect(inbox.dropSession('s1')).toBe(1)
    expect(settle).toHaveBeenCalledWith({ decision: 'terminal' })
    expect(inbox.list().map((i) => i.sessionId)).toEqual(['s2'])
  })

  it('keeps one reply card per session', () => {
    const inbox = mkInbox()
    inbox.reply('s1', 'first')
    inbox.reply('s1', 'second')
    expect(inbox.list().map((i) => i.message)).toEqual(['second'])
  })

  it('reports every change', () => {
    const inbox = mkInbox()
    const changes = vi.fn()
    inbox.onChange = changes
    const a = inbox.open({ sessionId: 's1', kind: 'permission' }, null)
    inbox.answer(a.id, { decision: 'allow' })
    inbox.dropSession('nobody')
    expect(changes).toHaveBeenCalledTimes(2)
  })
})

describe('Inbox after a restart', () => {
  const saved = (id: string, sessionId: string): InboxItem =>
    ({ id, sessionId, kind: 'reply', createdAt: 10, message: 'Done.' })

  it('restores cards under their old ids, once, without announcing them as new', () => {
    const inbox = mkInbox()
    const changes = vi.fn()
    const added = vi.fn()
    inbox.onChange = changes
    inbox.onAdded = added
    inbox.restore([saved('c1', 's1'), saved('c2', 's2')])
    inbox.restore([saved('c1', 's1')])
    expect(inbox.list().map((i) => i.id)).toEqual(['c1', 'c2'])
    expect(changes).toHaveBeenCalledTimes(1)
    expect(added).not.toHaveBeenCalled()
  })

  it('keeps a restored card while its tile repaints the reopened conversation', () => {
    const inbox = mkInbox()
    inbox.restore([saved('c1', 's1')])
    inbox.reply('s2', 'live one')
    expect(inbox.working('s1')).toBe(0)
    expect(inbox.working('s2')).toBe(1)
    expect(inbox.list().map((i) => i.id)).toEqual(['c1'])
  })

  it('ends a restored card the ways every card ends: a prompt, a newer reply, a dismissal', async () => {
    vi.useFakeTimers()
    const inbox = mkInbox()
    inbox.restore([saved('c1', 's1'), saved('c2', 's2'), saved('c3', 's3')])
    await routeHook({ inbox, session: session('s1'), event: 'UserPromptSubmit', payload: {}, signal: new AbortController().signal })
    await routeHook({ inbox, session: session('s2'), event: 'Stop', payload: { last_assistant_message: 'newer' }, signal: new AbortController().signal })
    vi.runAllTimers()
    vi.useRealTimers()
    expect(inbox.answer('c3', { decision: 'terminal' })).toBe(true)
    expect(inbox.list().map((i) => [i.sessionId, i.message])).toEqual([['s2', 'newer']])
  })
})

describe('questionsOf', () => {
  it('reads AskUserQuestion input', () => {
    expect(questionsOf(ask)).toEqual([{
      question: 'Which DB?', header: 'DB', multiSelect: false,
      options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }],
    }])
  })
  it('refuses input it cannot show faithfully', () => {
    expect(questionsOf({})).toBeNull()
    expect(questionsOf({ questions: [] })).toBeNull()
    expect(questionsOf({ questions: [{ question: 1, options: [] }] })).toBeNull()
  })
})

describe('sameInput', () => {
  it('ignores key order', () => {
    expect(sameInput({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true)
    expect(sameInput({ command: 'ls' }, { command: 'ls -la' })).toBe(false)
  })
})

describe('hookOutput', () => {
  it('allows and denies a permission request', () => {
    expect(hookOutput('PermissionRequest', {}, { decision: 'allow' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
    expect(hookOutput('PermissionRequest', {}, { decision: 'deny', message: 'not that' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'not that' },
      },
    })
  })
  it('answers a question by allowing it with the answers added', () => {
    expect(hookOutput('PreToolUse', ask, { decision: 'allow', answers: { 'Which DB?': 'SQLite' } })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...ask, answers: { 'Which DB?': 'SQLite' } },
      },
    })
  })
  it('says nothing when the prompt goes back to the terminal', () => {
    expect(hookOutput('PermissionRequest', {}, { decision: 'terminal' })).toBeNull()
    expect(hookOutput('PreToolUse', ask, { decision: 'terminal' })).toBeNull()
  })
})

describe('routeHook', () => {
  const run = (inbox: Inbox, s: HookSession, event: string, payload: object, signal = new AbortController().signal) =>
    routeHook({ inbox, session: s, event, payload, signal })

  it('records the conversation a tile runs from SessionStart', async () => {
    const s = session()
    expect(await run(mkInbox(), s, 'SessionStart', { session_id: 'abc', cwd: '/repo', source: 'startup' })).toBeNull()
    expect(s.conv).toEqual({ id: 'abc', cwd: '/repo' })
  })

  it('forgets it only when the user ended the conversation', async () => {
    for (const reason of ['prompt_input_exit', 'logout', 'clear']) {
      const s = session()
      s.conv = { id: 'abc', cwd: '/repo' }
      await run(mkInbox(), s, 'SessionEnd', { reason })
      expect(s.conv, reason).toBeNull()
    }
    // A signal (tring or the machine stopping) is `other`: keep it to reopen.
    for (const reason of ['other', undefined]) {
      const s = session()
      s.conv = { id: 'abc', cwd: '/repo' }
      await run(mkInbox(), s, 'SessionEnd', { reason })
      expect(s.conv, String(reason)).toEqual({ id: 'abc', cwd: '/repo' })
    }
  })

  it('holds a permission request until it is answered', async () => {
    const inbox = mkInbox()
    const pending = run(inbox, session(), 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } })
    const [card] = inbox.list()
    expect(card).toMatchObject({ kind: 'permission', tool: 'Bash', input: { command: 'ls' } })
    inbox.answer(card!.id, { decision: 'allow' })
    expect(await pending).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
  })

  it('drops the card when the hook hangs up', async () => {
    const inbox = mkInbox()
    const gone = new AbortController()
    const pending = run(inbox, session(), 'PermissionRequest', { tool_name: 'Bash', tool_input: {} }, gone.signal)
    gone.abort()
    expect(await pending).toBeNull()
    expect(inbox.list()).toEqual([])
  })

  it('cards AskUserQuestion from PreToolUse only', async () => {
    const inbox = mkInbox()
    expect(await run(inbox, session(), 'PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: ask })).toBeNull()
    expect(await run(inbox, session(), 'PreToolUse', { tool_name: 'Bash', tool_input: {} })).toBeNull()
    expect(inbox.list()).toEqual([])

    const pending = run(inbox, session(), 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ask })
    const [card] = inbox.list()
    expect(card!.questions![0]!.question).toBe('Which DB?')
    inbox.answer(card!.id, { decision: 'allow', answers: { 'Which DB?': 'Postgres' } })
    expect(await pending).toMatchObject({
      hookSpecificOutput: { updatedInput: { answers: { 'Which DB?': 'Postgres' } } },
    })
  })

  it('turns the tile green and leaves a reply card on Stop, once it has settled', async () => {
    vi.useFakeTimers()
    const inbox = mkInbox()
    const s = session()
    await run(inbox, s, 'Stop', { last_assistant_message: 'All tests pass.' })
    expect(s.hooks).toBe(1)
    vi.runAllTimers()
    vi.useRealTimers()
    expect(inbox.list()).toMatchObject([{ kind: 'reply', message: 'All tests pass.' }])
    await run(inbox, s, 'Notification', { notification_type: 'idle_prompt' })
    expect(s.hooks).toBe(2)
  })

  it('clears a permission card when that same tool has run', async () => {
    const inbox = mkInbox()
    const s = session()
    const a = run(inbox, s, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } })
    void run(inbox, s, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'pwd' } })
    await run(inbox, s, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(await a).toBeNull()
    expect(inbox.list().map((i) => i.input)).toEqual([{ command: 'pwd' }])
  })

  it('clears every card for a session the user typed into', async () => {
    const inbox = mkInbox()
    const s = session()
    void run(inbox, s, 'PermissionRequest', { tool_name: 'Bash', tool_input: {} })
    inbox.reply('s1', 'done')
    inbox.reply('s2', 'other')
    await run(inbox, s, 'UserPromptSubmit', { prompt: 'next' })
    expect(inbox.list().map((i) => i.sessionId)).toEqual(['s2'])
  })
})

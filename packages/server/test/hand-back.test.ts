import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asksUser, handBackDelay, SETTLE_MS, SHELL_GRACE_MS, waitingOnItself } from '../src/hand-back.ts'
import { Inbox, type HookPayload } from '../src/inbox.ts'
import { routeHook, type HookSession } from '../src/hook-route.ts'
import type { InboxItem } from '@tring/shared/protocol'

/** What Claude Code 2.1 sends with every hook event. */
const BASE = {
  session_id: '6f1c2a9e-3b7d-4e0a-9c55-2d8e1f4b7a10',
  transcript_path: 'C:\\Users\\dev\\.claude\\projects\\C--repo\\6f1c2a9e-3b7d-4e0a-9c55-2d8e1f4b7a10.jsonl',
  cwd: 'C:\\repo',
  permission_mode: 'auto',
}

/** A Stop as Claude Code sends it: nothing in flight unless the test says so. */
const stop = (message: string, extra: Partial<HookPayload> = {}): HookPayload => ({
  ...BASE, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: message,
  background_tasks: [], session_crons: [], ...extra,
})

const shell = (command: string, description = command) =>
  ({ id: 'b7q2k9x1', type: 'shell', status: 'running', description, command })
const monitor = { id: 'm3v8d0p4', type: 'monitor', status: 'running', description: 'Watch the dispatch screen for non-200s' }
const subagent = { id: 'a9f1c7e2', type: 'subagent', status: 'running', description: 'Review the diff', agent_type: 'Explore' }
const wakeup = { id: 'c41d7e09', schedule: '27 11 28 11 *', recurring: false, prompt: 'Check whether the eval run has finished.' }
const loop = { id: 'c88a2b10', schedule: '*/10 * * * *', recurring: true, prompt: '/babysit-prs' }

let inbox: Inbox
let added: InboxItem[]
const s: HookSession = { id: 's1', hook() {}, setClaude() {} }
const fire = (event: string, payload: HookPayload): Promise<unknown> =>
  routeHook({ inbox, session: s, event, payload: { ...BASE, hook_event_name: event, ...payload }, signal: new AbortController().signal })
const replies = (): string[] => inbox.list().filter((i) => i.kind === 'reply').map((i) => i.message!)

beforeEach(() => {
  vi.useFakeTimers()
  let n = 0
  inbox = new Inbox(() => Date.now(), () => `i${++n}`)
  added = []
  inbox.onAdded = (i) => added.push(i)
})
afterEach(() => { vi.useRealTimers() })

describe('a real hand-back', () => {
  it('shows one card, after a short settle', async () => {
    await fire('Stop', stop('Done. All 42 tests pass and the branch is committed, not pushed.'))
    expect(replies()).toEqual([])
    vi.advanceTimersByTime(SETTLE_MS)
    expect(replies()).toEqual(['Done. All 42 tests pass and the branch is committed, not pushed.'])
    expect(added).toHaveLength(1)
  })

  it('replaces the tile\'s card instead of stacking a second one', async () => {
    await fire('Stop', stop('First answer.'))
    vi.advanceTimersByTime(SETTLE_MS)
    await fire('Stop', stop('Second answer.'))
    vi.advanceTimersByTime(SETTLE_MS)
    expect(replies()).toEqual(['Second answer.'])
  })

  it('a Notification ("Claude is waiting for your input") after it adds no second card', async () => {
    await fire('Stop', stop('Done.'))
    vi.advanceTimersByTime(SETTLE_MS)
    await fire('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })
    vi.advanceTimersByTime(60_000)
    expect(replies()).toEqual(['Done.'])
    expect(added).toHaveLength(1)
  })
})

describe('a turn that ends while the work goes on', () => {
  it('a background shell it says it is waiting for: no card, however long it takes', async () => {
    await fire('Stop', stop('Started the eval in the background. Waiting for the eval to finish before I compare the scores.', {
      background_tasks: [shell('npm run eval -- --suite full', 'Run the full eval suite')],
    }))
    vi.advanceTimersByTime(SHELL_GRACE_MS * 10)
    expect(replies()).toEqual([])
    expect(added).toEqual([])
  })

  it('a ScheduleWakeup: "I\'ll come back automatically when…"', async () => {
    await fire('Stop', stop("The deploy is rolling out. I'll come back automatically when it has had ten minutes.", { session_crons: [wakeup] }))
    vi.advanceTimersByTime(SHELL_GRACE_MS * 10)
    expect(replies()).toEqual([])
  })

  it('a /loop iteration, which ends a turn every time', async () => {
    await fire('Stop', stop('PR #41: CI green, no new comments.', { session_crons: [loop] }))
    vi.advanceTimersByTime(SHELL_GRACE_MS * 10)
    expect(replies()).toEqual([])
  })

  it('each Monitor event re-invokes the agent and ends a turn; only the last, with the Monitor gone, is a card', async () => {
    await fire('Stop', stop('Watching the dispatch screen now.', { background_tasks: [monitor] }))
    // Monitor event: 11:51:02 dispatch screen: 200. The agent wakes, says so, and stops again.
    await fire('Stop', stop('11:51:02 dispatch screen: 200. Still healthy.', { background_tasks: [monitor] }))
    await fire('Stop', stop('11:56:02 dispatch screen: 200.', { background_tasks: [monitor] }))
    vi.advanceTimersByTime(SHELL_GRACE_MS * 10)
    expect(replies()).toEqual([])
    await fire('Stop', stop('The dispatch screen stayed at 200 for the whole hour, so I stopped the Monitor. The fix holds.'))
    vi.advanceTimersByTime(SETTLE_MS)
    expect(replies()).toEqual(['The dispatch screen stayed at 200 for the whole hour, so I stopped the Monitor. The fix holds.'])
    expect(added).toHaveLength(1)
  })

  it('a background subagent out', async () => {
    await fire('Stop', stop('I sent a reviewer over the diff.', { background_tasks: [subagent] }))
    vi.advanceTimersByTime(SHELL_GRACE_MS * 10)
    expect(replies()).toEqual([])
  })

  it('a background-task notification turn: held while more is pending, a card once nothing is', async () => {
    const build = shell('npm run build', 'Build')
    const test = shell('npm test', 'Tests')
    await fire('Stop', stop("Build and tests are running. I'll report back once they finish.", { background_tasks: [build, test] }))
    // <task-notification> build completed: the agent wakes, notes it, and stops with the tests still going.
    await fire('Stop', stop('The build passed; waiting on the tests.', { background_tasks: [test] }))
    vi.advanceTimersByTime(SHELL_GRACE_MS * 2)
    expect(replies()).toEqual([])
    await fire('Stop', stop('Build and all tests pass.'))
    vi.advanceTimersByTime(SETTLE_MS)
    expect(replies()).toEqual(['Build and all tests pass.'])
  })

  it('takes away the card of an earlier hand-back once the agent is at work again', async () => {
    await fire('Stop', stop('Done for now.'))
    vi.advanceTimersByTime(SETTLE_MS)
    await fire('Stop', stop('Picked it up again; waiting for the migration to finish.', { background_tasks: [shell('npm run migrate')] }))
    expect(replies()).toEqual([])
  })

  it('a SubagentStop from a subagent inside the tile', async () => {
    await fire('SubagentStop', {
      stop_hook_active: false, agent_id: 'a9f1c7e2', agent_type: 'Explore',
      last_assistant_message: 'Found 3 call sites of parseChoices.',
    } as HookPayload)
    vi.advanceTimersByTime(SHELL_GRACE_MS)
    expect(replies()).toEqual([])
  })
})

describe('a turn that ends but is picked up again at once', () => {
  it('a queued prompt: the next UserPromptSubmit lands inside the settle, so no card', async () => {
    await fire('Stop', stop('Fixed the first one.'))
    vi.advanceTimersByTime(200)
    await fire('UserPromptSubmit', { prompt: 'now the second one' })
    vi.advanceTimersByTime(SETTLE_MS * 10)
    expect(replies()).toEqual([])
    expect(added).toEqual([])
  })

  it('another Stop hook sends it back to work: its next tool call cancels the card', async () => {
    await fire('Stop', stop('Done.'))
    await fire('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run lint' } })
    vi.advanceTimersByTime(SETTLE_MS * 10)
    expect(replies()).toEqual([])
    await fire('Stop', stop('Done, and lint is clean.', { stop_hook_active: true }))
    vi.advanceTimersByTime(SETTLE_MS)
    expect(replies()).toEqual(['Done, and lint is clean.'])
  })

  it('a tile that goes away while its card settles never gets one', async () => {
    await fire('Stop', stop('The dev server is up.', { background_tasks: [shell('npm run dev')] }))
    expect(inbox.settlingSessions()).toEqual(['s1'])
    inbox.dropSession('s1')
    vi.advanceTimersByTime(SHELL_GRACE_MS)
    expect(replies()).toEqual([])
  })

  it('the screen looking busy during the settle does not eat the card; once shown, busy ends it as before', async () => {
    await fire('Stop', stop('Done.'))
    inbox.working('s1')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(replies()).toEqual(['Done.'])
    inbox.working('s1')
    expect(replies()).toEqual([])
  })

  it("a prompt the orchestrator sent: the agent's acknowledgement while its work runs on is not a card", async () => {
    await fire('UserPromptSubmit', { prompt: 'Rerun the integration suite against staging and tell me what fails.' })
    await fire('Stop', stop("On it. The suite is running in the background; I'll report back when it finishes.", {
      background_tasks: [shell('npm run test:integration -- --env staging', 'Integration suite on staging')],
    }))
    vi.advanceTimersByTime(SHELL_GRACE_MS * 10)
    expect(replies()).toEqual([])
    await fire('Stop', stop('2 of 118 failed: auth-refresh and export-csv. Both time out on staging only.'))
    vi.advanceTimersByTime(SETTLE_MS)
    expect(replies()).toEqual(['2 of 118 failed: auth-refresh and export-csv. Both time out on staging only.'])
  })
})

describe('asking you, even with work in flight', () => {
  it('a question at the end is a card, a dev server running or not', async () => {
    await fire('Stop', stop('The dev server is up at http://localhost:5173.\n\nWant me to add the Playwright tests next?', {
      background_tasks: [shell('npm run dev', 'Vite dev server')],
    }))
    vi.advanceTimersByTime(SETTLE_MS)
    expect(replies()).toHaveLength(1)
  })

  it('a dev server it is not waiting for, and nothing asked: a card after a few quiet minutes, not never', async () => {
    await fire('Stop', stop('The dev server is up at http://localhost:5173 with the new layout.', {
      background_tasks: [shell('npm run dev', 'Vite dev server')],
    }))
    vi.advanceTimersByTime(SHELL_GRACE_MS - 1)
    expect(replies()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(replies()).toHaveLength(1)
  })

  it('a permission prompt and an AskUserQuestion show at once, and end a reply still settling', async () => {
    await fire('Stop', stop('Done with the first part.'))
    void fire('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push' } })
    void fire('PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] },
    })
    expect(inbox.list().map((i) => i.kind)).toEqual(['permission', 'question'])
    vi.advanceTimersByTime(SETTLE_MS * 10)
    expect(replies()).toEqual([])
  })
})

describe('handBackDelay', () => {
  it('reads the payload ahead of the words', () => {
    expect(handBackDelay(stop('Done.'), 'Done.')).toBe(SETTLE_MS)
    expect(handBackDelay(stop('x', { background_tasks: [monitor] }), 'Done.')).toBeNull()
    expect(handBackDelay(stop('x', { session_crons: [wakeup] }), 'Done.')).toBeNull()
    expect(handBackDelay(stop('x', { background_tasks: [shell('npm run dev')] }), 'Server up.')).toBe(SHELL_GRACE_MS)
    expect(handBackDelay(stop('x', { background_tasks: [shell('npm run dev')] }), 'Waiting for the build.')).toBeNull()
    expect(handBackDelay(stop('x', { background_tasks: [monitor] }), 'Should I keep watching it?')).toBe(SETTLE_MS)
    // A task the payload lists as over wakes nobody.
    expect(handBackDelay(stop('x', { background_tasks: [{ ...monitor, status: 'completed' }] }), 'Done.')).toBe(SETTLE_MS)
    // An older Claude Code, without the fields: as before, a card.
    const old = { ...BASE, hook_event_name: 'Stop', last_assistant_message: 'Done.' }
    expect(handBackDelay(old, 'Done.')).toBe(SETTLE_MS)
    expect(handBackDelay(stop(''), '')).toBeNull()
  })

  it('asksUser', () => {
    expect(asksUser('Pushed.\n\nShould I open the PR?')).toBe(true)
    expect(asksUser('❓ **Q1 – Default schedule.**\n- (a) Daily\n- (b) Hourly\n➡️ (a).')).toBe(true)
    expect(asksUser('Pick one:\na) Ship it\nb) Wait')).toBe(true)
    expect(asksUser('All done. Let me know if you want the README updated too.')).toBe(true)
    expect(asksUser('Why did it fail? A missing env var. Fixed and committed.')).toBe(false)
    expect(asksUser('11:51:02 dispatch screen: 200.')).toBe(false)
    expect(asksUser('The plan is in PLAN.md. I am waiting for your go-ahead.')).toBe(true)
  })

  it('waitingOnItself', () => {
    expect(waitingOnItself('Waiting for the eval to finish.')).toBe(true)
    expect(waitingOnItself("I'll come back automatically when the deploy is done.")).toBe(true)
    expect(waitingOnItself('I’ll report back once the build finishes.')).toBe(true)
    expect(waitingOnItself('I will check back in 10 minutes.')).toBe(true)
    expect(waitingOnItself('I am waiting for your go-ahead.')).toBe(false)
    expect(waitingOnItself('The dev server is up at http://localhost:5173.')).toBe(false)
  })
})

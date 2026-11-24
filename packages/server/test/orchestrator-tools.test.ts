import { describe, it, expect, beforeEach } from 'vitest'
import type { InboxItem, ProjectInfo, SessionStatus } from '@tring/shared/protocol'
import { OrchestratorTools, ToolError, TOOLS, type ToolDeps, type ToolSession } from '../src/orchestrator-tools.ts'
import { cleanPrompt } from '../src/type-prompt.ts'

interface Stub extends ToolSession {
  typed: string[]
}

function stub(over: Partial<ToolSession> & { id: string; slot: number; projectId: string }): Stub {
  const s: Stub = {
    name: null, title: null, cwd: '/repo', command: null, claude: null,
    lastMessage: null, stoppedAt: 0, promptedAt: 0,
    tracker: { status: 'idle' as SessionStatus },
    recentText: (n: number) => `line count ${n}`,
    write: () => {},
    prompted() { this.promptedAt = clock.t },
    typed: [],
    ...over,
  }
  return s
}

const clock = { t: 1000 }
let sessions: Stub[]
let inbox: InboxItem[]
let created: Array<{ projectId: string | undefined; cwd?: string; command?: string | null; name?: string | null }>
let tools: OrchestratorTools

const projects = (): ProjectInfo[] => [
  { id: 'p1', name: 'tring.chat', root: '/repo', sessions: sessions.filter((s) => s.projectId === 'p1').map(info) },
  { id: 'p2', name: 'Other', root: '/other', sessions: sessions.filter((s) => s.projectId === 'p2').map(info) },
]
const info = (s: Stub) => ({
  id: s.id, projectId: s.projectId, slot: s.slot, name: s.name, title: s.title, cwd: s.cwd,
  command: s.command, color: null, status: s.tracker.status, since: 0, exitCode: null,
})

function deps(over: Partial<ToolDeps> = {}): ToolDeps {
  return {
    pm: {
      list: projects,
      activeProjectId: 'p1',
      findSession: (id) => sessions.find((s) => s.id === id),
      findProject: (ref) => projects().find((p) => p.id === ref || p.name.toLowerCase() === ref.toLowerCase()),
      create: (projectId, spec) => {
        created.push({ projectId, ...spec })
        const s = stub({ id: `new${created.length}`, slot: 9, projectId: projectId ?? 'p1', cwd: spec.cwd ?? '/repo', name: spec.name ?? null })
        sessions.push(s)
        return s
      },
    },
    inbox: { list: () => inbox },
    branch: async (cwd) => (cwd === '/repo' ? 'main' : null),
    diff: async (cwd) => ({ cwd, files: [{ path: 'a.ts', added: 2, removed: 1, patch: '@@ -1 +1 @@\n-x\n+y' }], truncated: false }),
    // path.resolve gives C:\repo\... on Windows and /repo/... elsewhere.
    isDir: async (p) => /^([A-Z]:)?[\\/]repo([\\/]|$)/i.test(p),
    sleep: async (ms) => { clock.t += ms },
    now: () => clock.t,
    type: (s, text) => { (s as Stub).typed.push(text) },
    ...over,
  }
}

beforeEach(() => {
  clock.t = 1000
  inbox = []
  created = []
  sessions = [
    stub({ id: 'a', slot: 1, projectId: 'p1', name: 'api', claude: { id: 'c1', cwd: '/repo' }, lastMessage: 'Tests pass.' }),
    stub({ id: 'b', slot: 2, projectId: 'p1' }),
    stub({ id: 'c', slot: 3, projectId: 'p2', cwd: '/other', claude: { id: 'c2', cwd: '/other' } }),
  ]
  tools = new OrchestratorTools(deps())
})

describe('the tool list', () => {
  it('has a schema for every tool the daemon answers', async () => {
    for (const t of TOOLS) {
      expect(t.inputSchema['type']).toBe('object')
      // An unknown name is a ToolError; every listed one must get past that.
      await tools.call(t.name, { session: 'a', sessions: ['a'], text: 'x' }).catch((err) => {
        expect((err as Error).message).not.toMatch(/unknown tool/)
      })
    }
  })
})

describe('resolve', () => {
  it('takes an id, project/slot, or a bare slot in the viewed project', () => {
    expect(tools.resolve('c').id).toBe('c')
    expect(tools.resolve('Other/3').id).toBe('c')
    expect(tools.resolve('tring.chat/2').id).toBe('b')
    expect(tools.resolve('2').id).toBe('b')
  })
  it('says what is wrong with a bad ref', () => {
    expect(() => tools.resolve('tring.chat/7')).toThrow(/slot 7 in tring.chat is empty/)
    expect(() => tools.resolve('nope/1')).toThrow(/no project nope/)
    expect(() => tools.resolve('')).toThrow(ToolError)
  })
})

describe('list_sessions', () => {
  it('reports branch, agent, waiting cards and the last message', async () => {
    inbox = [{ id: 'i', sessionId: 'a', kind: 'permission', createdAt: 0, tool: 'Bash', input: { command: 'npm test' } }]
    const out = JSON.parse(await tools.call('list_sessions', {})) as { projects: Array<{ project: string; viewing: boolean; sessions: Array<Record<string, unknown>> }> }
    expect(out.projects.map((p) => [p.project, p.viewing])).toEqual([['tring.chat', true], ['Other', false]])
    const a = out.projects[0]!.sessions[0]!
    expect(a).toMatchObject({ ref: 'tring.chat/1', branch: 'main', agent: 'claude', lastMessage: 'Tests pass.' })
    expect(a['waitingOnUser']).toEqual(['permission for Bash: npm test'])
    expect(out.projects[0]!.sessions[1]).toMatchObject({ agent: null })
  })
  it('narrows to one project', async () => {
    const out = JSON.parse(await tools.call('list_sessions', { project: 'other' })) as { projects: unknown[] }
    expect(out.projects).toHaveLength(1)
  })
})

describe('send_prompt', () => {
  it('types into a Claude tile and records the prompt', async () => {
    const msg = await tools.call('send_prompt', { session: 'a', text: 'run the tests\x1b[201~' })
    expect(sessions[0]!.typed).toEqual(['run the tests'])
    expect(sessions[0]!.promptedAt).toBe(1000)
    expect(msg).toMatch(/Sent to tring.chat\/1 \(api\)/)
  })
  it('never types into a plain shell', async () => {
    await expect(tools.call('send_prompt', { session: 'b', text: 'rm -rf /' })).rejects.toThrow(/not running Claude Code/)
    expect(sessions[1]!.typed).toEqual([])
  })
  it('never types into a tile holding a permission prompt or question', async () => {
    inbox = [{ id: 'i', sessionId: 'a', kind: 'question', createdAt: 0, questions: [{ question: 'Which?', options: [] }] }]
    await expect(tools.call('send_prompt', { session: 'a', text: '1' })).rejects.toThrow(/waiting on the user/)
    expect(sessions[0]!.typed).toEqual([])
  })
  it('does type into a tile whose only card is a finished reply', async () => {
    inbox = [{ id: 'i', sessionId: 'a', kind: 'reply', createdAt: 0, message: 'done' }]
    await tools.call('send_prompt', { session: 'a', text: 'next' })
    expect(sessions[0]!.typed).toEqual(['next'])
  })
  it('refuses an exited tile', async () => {
    sessions[0]!.tracker.status = 'exited'
    await expect(tools.call('send_prompt', { session: 'a', text: 'x' })).rejects.toThrow(/exited/)
  })
})

describe('create_session', () => {
  it('starts claude in the project root without a prompt', async () => {
    const msg = await tools.call('create_session', { project: 'tring.chat', name: 'docs' })
    expect(created).toEqual([{ projectId: 'p1', cwd: '/repo', command: 'claude', name: 'docs' }])
    expect(msg).toMatch(/Started tring.chat\/9 \(docs\)/)
  })
  it('resolves cwd against the root and refuses one that is not a directory', async () => {
    await tools.call('create_session', { cwd: 'packages/web' })
    expect(created[0]!.cwd).toMatch(/[\\/]repo[\\/]packages[\\/]web$/)
    await expect(tools.call('create_session', { cwd: '/nowhere' })).rejects.toThrow(/not a directory/)
  })
  it('sends the first prompt once Claude reports it started and has settled', async () => {
    const t = new OrchestratorTools(deps({
      sleep: async (ms) => {
        clock.t += ms
        const s = sessions.find((x) => x.id === 'new1')
        if (s && clock.t > 3000) s.claude = { id: 'c9', cwd: '/repo' }
      },
    }))
    const msg = await t.call('create_session', { prompt: 'write the docs' })
    expect(msg).toMatch(/First prompt sent/)
    expect(sessions.find((x) => x.id === 'new1')!.typed).toEqual(['write the docs'])
  })
  it('says so instead of typing blind when Claude never reports in', async () => {
    const msg = await tools.call('create_session', { prompt: 'x' })
    expect(msg).toMatch(/NOT sent/)
    expect(sessions.find((x) => x.id === 'new1')!.typed).toEqual([])
  })
})

describe('wait_for', () => {
  it('waits for a prompted tile to stop, then returns what it said', async () => {
    const a = sessions[0]!
    a.promptedAt = clock.t
    a.tracker.status = 'busy'
    const t = new OrchestratorTools(deps({
      sleep: async (ms) => {
        clock.t += ms
        if (clock.t >= 4000) { a.tracker.status = 'done'; a.lastMessage = 'All 12 tests pass.'; a.stoppedAt = clock.t }
      },
    }))
    const out = await t.call('wait_for', { sessions: ['a'] })
    expect(out).toBe('## tring.chat/1 (api) — finished\nAll 12 tests pass.')
  })
  it('returns early for a tile that needs the user', async () => {
    sessions[0]!.tracker.status = 'busy'
    inbox = [{ id: 'i', sessionId: 'a', kind: 'permission', createdAt: 0, tool: 'Bash', input: { command: 'git push' } }]
    expect(await tools.call('wait_for', { sessions: ['a'] })).toMatch(/needs-user — waiting on the user: permission for Bash: git push/)
  })
  it('times out and says which are still working', async () => {
    sessions[0]!.tracker.status = 'busy'
    const out = await tools.call('wait_for', { sessions: ['a'], timeout_seconds: 5 })
    expect(out).toMatch(/^Timed out after 5s/)
    expect(out).toMatch(/still working/)
  })
  it('does not show an old message as the answer to a newer prompt', async () => {
    const a = sessions[0]!
    a.stoppedAt = 500
    a.promptedAt = 900 // prompted after it last stopped, and no Stop since
    clock.t = 900 + 20_000 // past the grace, so it counts as finished
    expect(await tools.call('wait_for', { sessions: ['a'] })).toBe('## tring.chat/1 (api) — finished')
  })
})

describe('session_changes and read_session', () => {
  it('lists files and patches', async () => {
    const out = await tools.call('session_changes', { session: 'a' })
    expect(out).toMatch(/1 changed file\(s\) in \/repo\na.ts {2}\+2 -1/)
    expect(out).toMatch(/--- a.ts\n@@ -1 \+1 @@/)
  })
  it('caps the lines read', async () => {
    expect(await tools.call('read_session', { session: 'a', lines: 10_000 })).toMatch(/line count 400$/)
  })
})

describe('cleanPrompt', () => {
  it('drops paste markers and control characters, keeps newlines and tabs', () => {
    expect(cleanPrompt('a\x1b[201~\x03b\r\nc\td  ')).toBe('ab\nc\td')
  })
})

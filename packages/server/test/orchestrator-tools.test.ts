import { describe, it, expect, beforeEach } from 'vitest'
import type { InboxItem, ProjectInfo, SessionStatus } from '@tring/shared/protocol'
import { OrchestratorTools, ToolError, TOOLS, type ToolDeps, type ToolSession } from '../src/orchestrator-tools.ts'
import { cleanPrompt } from '../src/type-prompt.ts'
import type { GitOps, GitPlace, Worktree } from '../src/git-worktrees.ts'
import type { Transcript } from '../src/transcript.ts'

/** Conversations by transcript file; a tile points at one through `transcript`. */
let talks: Record<string, Transcript>

interface Stub extends ToolSession {
  typed: string[]
}

/**
 * One repository at /repo (main worktree on `main`) with a linked worktree at
 * /wt/feat-a on `feat/a`; /other is not a repository. Paths are compared
 * without a drive letter so the same test reads the same on Windows.
 */
const bare = (p: string): string => p.replace(/\\/g, '/').replace(/^[A-Z]:/i, '')
let trees: Worktree[]
let branches: Set<string>
let added: Array<{ path: string; branch: string; create: boolean; base?: string }>
const wt = (path: string, branch: string): Worktree =>
  ({ path, branch, head: 'abc', bare: false, detached: false, locked: false, prunable: false })
const fakeGit: GitOps = {
  async place(dir) {
    const d = bare(dir)
    const tree = [...trees].reverse().find((w) => d === bare(w.path) || d.startsWith(`${bare(w.path)}/`))
    if (!tree) return null
    return { root: tree.path, commonDir: '/repo/.git', linked: bare(tree.path) !== '/repo', branch: tree.branch, detached: false } satisfies GitPlace
  },
  async worktrees() { return trees },
  async branchExists(_dir, b) { return branches.has(b) },
  async checkBranch(_dir, b) { return /\s|^-/.test(b) ? `"${b}" is not a valid branch name` : null },
  async addWorktree(_dir, spec) {
    added.push(spec)
    trees.push(wt(spec.path, spec.branch))
    branches.add(spec.branch)
    return null
  },
}

function stub(over: Partial<ToolSession> & { id: string; slot: number; projectId: string }): Stub {
  const s: Stub = {
    name: null, title: null, cwd: '/repo', agentCwd: null, transcript: null, command: null, claude: null,
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
    git: fakeGit,
    transcripts: {
      read: async (f) => talks[f] ?? null,
      find: async (id) => (talks[`/t/${id}.jsonl`] ? `/t/${id}.jsonl` : null),
    },
    diff: async (cwd) => ({ cwd, files: [{ path: 'a.ts', added: 2, removed: 1, patch: '@@ -1 +1 @@\n-x\n+y' }], truncated: false }),
    // Existing directories: the repo and its worktrees. path.resolve gives
    // C:\repo\... on Windows and /repo/... elsewhere, hence `bare`.
    isDir: async (p) => /^\/(repo|other|wt\/feat-a)(\/|$)/.test(bare(p)),
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
  trees = [wt('/repo', 'main'), wt('/wt/feat-a', 'feat/a')]
  branches = new Set(['main', 'feat/a', 'feat/old'])
  added = []
  talks = {}
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
    expect(a).toMatchObject({
      ref: 'tring.chat/1', agent: 'claude', lastMessage: 'Tests pass.',
      git: { repo: 'repo', branch: 'main', worktree: '/repo', linkedWorktree: false },
    })
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

describe('worktrees', () => {
  type Listed = { projects: Array<{ sessions: Array<Record<string, unknown>> }> }
  const listed = async (t = tools): Promise<Listed> => JSON.parse(await t.call('list_sessions', {})) as Listed

  it('places a tile where its agent is working, not where its shell started', async () => {
    sessions[0]!.agentCwd = '/wt/feat-a/src'
    const a = (await listed()).projects[0]!.sessions[0]!
    expect(a).toMatchObject({
      cwd: '/repo', agentCwd: '/wt/feat-a/src',
      git: { repo: 'repo', branch: 'feat/a', worktree: '/wt/feat-a', linkedWorktree: true },
    })
  })

  it('flags tiles that share a worktree, and stops once they do not', async () => {
    let [a, b] = (await listed()).projects[0]!.sessions
    expect(a!['sameWorktreeAs']).toEqual(['tring.chat/2'])
    expect(b!['sameWorktreeAs']).toEqual(['tring.chat/1'])
    sessions[0]!.agentCwd = '/wt/feat-a'
    ;[a, b] = (await listed()).projects[0]!.sessions
    expect(a!['sameWorktreeAs']).toBeUndefined()
    expect(b!['sameWorktreeAs']).toBeUndefined()
  })

  it('lists every worktree of the repository with the tiles in it', async () => {
    sessions[0]!.agentCwd = '/wt/feat-a'
    const out = JSON.parse(await tools.call('list_worktrees', {})) as { repos: Array<{ repo: string; projects: string[]; worktrees: unknown[] }> }
    expect(out.repos).toHaveLength(1)
    expect(out.repos[0]).toMatchObject({ repo: 'repo', projects: ['tring.chat'] })
    expect(out.repos[0]!.worktrees).toEqual([
      { path: '/repo', branch: 'main', main: true, tiles: ['tring.chat/2 idle'] },
      { path: '/wt/feat-a', branch: 'feat/a', main: false, tiles: ['tring.chat/1 idle claude'] },
    ])
  })

  it('reuses the worktree that already has the branch checked out', async () => {
    const msg = await tools.call('create_session', { branch: 'feat/a' })
    expect(added).toEqual([])
    expect(created[0]).toMatchObject({ cwd: '/wt/feat-a', name: 'feat/a', command: 'claude' })
    expect(msg).toMatch(/Reused the existing worktree \/wt\/feat-a/)
    expect(msg).not.toMatch(/Warning/)
  })

  it('warns when the reused worktree already has a tile in it', async () => {
    sessions[0]!.agentCwd = '/wt/feat-a'
    expect(await tools.call('create_session', { branch: 'feat/a' })).toMatch(/Warning: tring.chat\/1 is already in that worktree/)
  })

  it('checks an existing branch out into a new worktree beside the others', async () => {
    const msg = await tools.call('create_session', { branch: 'feat/old' })
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ branch: 'feat/old', create: false })
    expect(bare(added[0]!.path)).toBe('/wt/feat-old')
    expect(bare(created[0]!.cwd!)).toBe('/wt/feat-old')
    expect(msg).toMatch(/checked out the existing branch feat\/old/)
  })

  it('creates a new branch from a base', async () => {
    const msg = await tools.call('create_session', { branch: 'feat/CHV-12-login', base: 'main', prompt: '' })
    expect(added[0]).toMatchObject({ branch: 'feat/CHV-12-login', create: true, base: 'main' })
    expect(bare(added[0]!.path)).toBe('/wt/feat-CHV-12-login')
    expect(msg).toMatch(/created feat\/CHV-12-login from main/)
  })

  it('honours an explicit worktree_path and refuses one that exists', async () => {
    await tools.call('create_session', { branch: 'feat/x', worktree_path: '/elsewhere/x' })
    expect(bare(added[0]!.path)).toBe('/elsewhere/x')
    await expect(tools.call('create_session', { branch: 'feat/y', worktree_path: '/wt/feat-a' })).rejects.toThrow(/already exists/)
  })

  it('refuses bad branch names and option-like bases before running git', async () => {
    await expect(tools.call('create_session', { branch: 'has space' })).rejects.toThrow(/not a valid branch/)
    await expect(tools.call('create_session', { branch: 'feat/z', base: '--upload-pack=x' })).rejects.toThrow(/not a usable base/)
    expect(added).toEqual([])
    expect(created).toEqual([])
  })

  it('refuses a branch outside a repository', async () => {
    await expect(tools.call('create_session', { project: 'Other', branch: 'feat/q' })).rejects.toThrow(/not inside a git repository/)
  })

  it('warns when another agent is busy in the same worktree', async () => {
    sessions[1]!.claude = { id: 'c3', cwd: '/repo' }
    sessions[1]!.tracker.status = 'busy'
    expect(await tools.call('send_prompt', { session: 'a', text: 'go' })).toMatch(/Warning: tring.chat\/2 is also working in/)
    sessions[0]!.agentCwd = '/wt/feat-a'
    expect(await tools.call('send_prompt', { session: 'a', text: 'go' })).not.toMatch(/Warning/)
  })

  it('reads changes from the worktree the agent is in', async () => {
    sessions[0]!.agentCwd = '/wt/feat-a'
    expect(await tools.call('session_changes', { session: 'a' })).toMatch(/in \/wt\/feat-a/)
  })
})

describe('knowing what each tile is working on', () => {
  const talk = (title: string, turns: Transcript['turns']): Transcript => ({ title, turns, partial: false })

  beforeEach(() => {
    // Tile a has been on the reporting box, though its last message is about
    // something else and its screen is clear; tile c has been on login.
    sessions[0]!.transcript = '/t/a.jsonl'
    sessions[0]!.lastMessage = 'Committed. Anything else?'
    talks['/t/a.jsonl'] = talk('Reporting box export', [
      { role: 'user', text: 'Add a CSV export button to the reporting box', at: '2026-11-24T08:00:00Z' },
      { role: 'assistant', text: 'Added the button to ReportBox.', at: null, files: ['/repo/src/ReportBox.tsx'] },
      { role: 'user', text: 'Commit it', at: '2026-11-24T09:00:00Z' },
      { role: 'assistant', text: 'Committed. Anything else?', at: null },
    ])
    // Tile c's transcript is found by its conversation id: no hook has named it yet.
    talks['/t/c2.jsonl'] = talk('Login redirect fix', [
      { role: 'user', text: 'Fix the login redirect loop', at: null },
      { role: 'assistant', text: 'Fixed the redirect in auth middleware.', at: null, files: ['/other/auth.ts'] },
    ])
  })

  it('lists what each tile was asked and what Claude titled it', async () => {
    const out = JSON.parse(await tools.call('list_sessions', {})) as { projects: Array<{ sessions: Array<Record<string, unknown>> }> }
    expect(out.projects[0]!.sessions[0]!['conversation']).toEqual({
      title: 'Reporting box export',
      firstPrompt: 'Add a CSV export button to the reporting box',
      recentPrompts: ['Add a CSV export button to the reporting box', 'Commit it'],
    })
    expect(out.projects[1]!.sessions[0]!['conversation']).toMatchObject({ title: 'Login redirect fix' })
    expect(out.projects[0]!.sessions[1]!['conversation']).toBeUndefined()
  })

  it('routes a request by topic to the tile that has been doing it', async () => {
    const out = await tools.call('find_work', { query: 'Change the colour for the reporting box to green' })
    expect(out).toMatch(/^Best match: tring.chat\/1 \(api\)/)
    expect(out).toMatch(/matched [^)]*title/)
    expect(out).toMatch(/matched [^)]*prompt/)
    expect(out).not.toMatch(/Other\/3/)
    expect(await tools.call('find_work', { query: 'the login redirect' })).toMatch(/^Best match: Other\/3/)
  })

  it('does not call a word in passing a match', async () => {
    // Found in the live test: "payments page" landed on the tile whose agent
    // had written "the login page".
    talks['/t/c2.jsonl']!.turns.push({ role: 'assistant', text: 'It sends you back to the login page.', at: null })
    const out = await tools.call('find_work', { query: 'payments page' })
    expect(out).toMatch(/^No tile clearly matches "payments page"/)
    expect(out).toMatch(/Only passing mentions:\n- Other\/3/)
  })

  it('matches files the agent edited', async () => {
    expect(await tools.call('find_work', { query: 'ReportBox.tsx' })).toMatch(/^Best match: tring.chat\/1[^\n]*\n\n[^\n]*matched [^)]*edited/)
  })

  it('says when tiles tie, and when nothing matches, instead of picking one', async () => {
    talks['/t/c2.jsonl'] = talk('Reporting box export', [{ role: 'user', text: 'Add a CSV export button to the reporting box', at: null }])
    sessions[0]!.lastMessage = null
    talks['/t/a.jsonl'] = talk('Reporting box export', [{ role: 'user', text: 'Add a CSV export button to the reporting box', at: null }])
    expect(await tools.call('find_work', { query: 'reporting box' })).toMatch(/^Two or more tiles match about equally: ask the user/)
    expect(await tools.call('find_work', { query: 'kubernetes ingress' })).toMatch(/^No tile clearly matches/)
    await expect(tools.call('find_work', { query: 'the and for' })).rejects.toThrow(/say what the work is about/)
  })

  it('reads a tile\'s conversation, or only the turns about something', async () => {
    const all = await tools.call('session_history', { session: 'a' })
    expect(all).toMatch(/^tring.chat\/1 \(api\) — "Reporting box export": 4 of 4 turn\(s\)/)
    expect(all).toMatch(/\[PROMPT 2026-11-24 08:00\]\nAdd a CSV export button/)
    expect(all).toMatch(/\(edited: \/repo\/src\/ReportBox.tsx\)/)
    const some = await tools.call('session_history', { session: 'a', search: 'commit' })
    expect(some).toMatch(/2 of 2 matching turn/)
    expect(await tools.call('session_history', { session: 'b' })).toMatch(/not running Claude Code/)
  })

  it('stems words so "reporting" finds "reports"', async () => {
    const { words } = await import('../src/orchestrator-tools.ts')
    expect(words('Change the colour for the reporting box to green')).toEqual(['colour', 'report', 'box', 'green'])
  })
})

describe('cleanPrompt', () => {
  it('drops paste markers and control characters, keeps newlines and tabs', () => {
    expect(cleanPrompt('a\x1b[201~\x03b\r\nc\td  ')).toBe('ab\nc\td')
  })
})

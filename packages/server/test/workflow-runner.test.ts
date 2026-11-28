import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ProjectInfo, SessionStatus } from '@tring/shared/protocol'
import { DEFAULT_WORKFLOW, type Plan, type PlannedPr } from '@tring/shared/workflow'
import { ToolError } from '../src/orchestrator-tools.ts'
import type { Forge } from '../src/workflow/forge.ts'
import type { StackGit } from '../src/workflow/git.ts'
import { WorkflowRunner, type RunnerSession } from '../src/workflow/runner.ts'
import { TicketStore } from '../src/workflow/tickets.ts'
import { cardsFor } from '../src/workflow/engine.ts'
import { advice } from './workflow-advice.ts'

const ROOT = path.resolve('/src/api')

interface FakeSession extends RunnerSession { typed: string[]; name: string; command: string; cwd: string }

/** Tiles that do nothing: what was typed into them is all a test reads. */
function fakePm() {
  const projects: Array<{ id: string; name: string; root: string; active: boolean; sessions: FakeSession[] }> = []
  let n = 0
  return {
    projects,
    list: (): ProjectInfo[] => projects.map((p) => ({
      id: p.id, name: p.name, root: p.root,
      sessions: p.sessions.map((s) => ({
        id: s.id, projectId: p.id, slot: s.slot, name: s.name, title: null, cwd: s.cwd, command: s.command, color: null,
        status: s.tracker.status, since: 0, exitCode: null,
      })),
    })),
    createProject(name: string, root: string, activate: boolean): string {
      const id = `p${projects.length + 1}`
      projects.push({ id, name, root, active: activate, sessions: [] })
      return id
    },
    create(projectId: string, spec: { cwd: string; command: string; name: string; claudeArgs: string }): FakeSession | null {
      const p = projects.find((x) => x.id === projectId)!
      let slot = 1
      while (p.sessions.some((s) => s.slot === slot)) slot++
      const s: FakeSession = {
        id: `s${++n}`, projectId, slot, name: spec.name, command: spec.command, cwd: spec.cwd, typed: [],
        claude: { id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, cwd: spec.cwd },
        tracker: { status: 'idle' as SessionStatus },
        write() {}, prompted() {},
      }
      p.sessions.push(s)
      return s
    },
    findSession: (id: string) => projects.flatMap((p) => p.sessions).find((s) => s.id === id),
    kill(id: string) { for (const p of projects) p.sessions = p.sessions.filter((s) => s.id !== id) },
    deleteProject(id: string) { projects.splice(projects.findIndex((p) => p.id === id), 1) },
  }
}

function fakeGit(over: Partial<Record<keyof StackGit, unknown>> = {}): StackGit {
  let wt = 0
  return {
    isRepo: async () => true,
    baseBranch: async () => 'develop',
    branchPrefix: async () => 'feat/',
    createWorktree: async () => ({ path: path.resolve(`/wt/${++wt}`), baseSha: 'base0' }),
    check: async () => ({ head: 'a1', clean: true }),
    heads: async (_repo: string, branches: string[]) => new Map(branches.map((b) => [b, null])),
    diffChanged: async () => false,
    fetchBase: async () => ({ commits: 0, error: null }),
    conflicts: async () => false,
    isMerged: async () => true,
    originUrl: async () => 'git@bitbucket.org:matogen/api.git',
    integrate: async () => ({ sha: 'm1', base: 'b0', worktree: path.resolve('/wt/integration') }),
    removeWorktree: async () => null,
    deleteBranch: async () => null,
    ...over,
  } as unknown as StackGit
}

const planned = (over: Partial<PlannedPr> & Pick<PlannedPr, 'index'>): PlannedPr => ({
  repo: 'api', below: null, title: `PR ${over.index}`, scope: 'small', owns: [`pr${over.index}/**`], uses: [],
  tests: { add: ['t.test.ts'], run: ['npm test'] }, acceptance: ['works'], ...over,
})

const plan: Plan = {
  version: 1, summary: 'two PRs', shared: [], deployOrder: null, addRepos: [], docs: { none: 'internal' }, advice: advice(),
  interfaces: [{ name: 'Table', owner: 1, contract: 'orders(id)' }],
  prs: [
    planned({ index: 1, title: 'Table', owns: ['db/**'] }),
    planned({ index: 2, below: 1, title: 'API', owns: ['src/routes/**'], uses: ['Table'] }),
  ],
}

async function rig(git = fakeGit(), forge?: Partial<Pick<Forge, 'pr' | 'open' | 'retarget'>>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-runner-'))
  const store = new TicketStore(path.join(dir, 'tickets.json'), path.join(dir, 'tickets'))
  let now = 1_000_000
  const pm = fakePm()
  const settings = { ...DEFAULT_WORKFLOW, multiPr: true }
  const runner = new WorkflowRunner({
    store, settings: { get: () => settings }, git, pm, inbox: { list: () => [] }, quotaHigh: () => false,
    tileDir: path.join(dir, 'tiles'), url: 'http://127.0.0.1:7331', mcpScript: '/opt/tring/tring-mcp.js', node: '/usr/bin/node',
    now: () => now,
    type: (s, text) => { (s as FakeSession).typed.push(text) },
    ...(forge ? { forge: forge as Pick<Forge, 'pr' | 'open' | 'retarget'> } : {}),
  })
  await runner.load()
  const r = {
    dir, store, pm, runner, settings,
    advance(ms: number) { now += ms },
    tile: (name: string) => pm.projects.flatMap((p) => p.sessions).find((s) => s.name === name),
    /** Two pumps 2 s apart: an idle agent gets what is queued for it. */
    async flush() { await runner.pump(); now += 2000; await runner.pump() },
    /** A tile's tools, called with its own token (read from the file its MCP config names, once it is there). */
    as(name: string) {
      return async (tool: string, args: Record<string, unknown> = {}) => {
        const s = r.tile(name)
        if (!s) throw new Error(`no tile ${name}`)
        const end = Date.now() + 5000
        while (!tokens.has(s.id) && Date.now() < end) await new Promise((res) => setTimeout(res, 10))
        const who = runner.authorize(tokenOf(s))
        if (!who) throw new Error(`no token for ${name}`)
        return runner.call(who, tool, args)
      }
    },
    ticket: () => store.list()[0]!,
  }
  const tokens = new Map<string, string>()
  const tokenOf = (s: FakeSession): string => tokens.get(s.id)!
  // The token a tile was given is in the file its MCP config names.
  const orig = pm.create.bind(pm)
  pm.create = (projectId, spec) => {
    const s = orig(projectId, spec)!
    const file = /--mcp-config "([^"]+)"/.exec(spec.claudeArgs)![1]!
    void readFile(file, 'utf8').then((raw) => {
      const args = JSON.parse(raw).mcpServers['tring-stack'].args as string[]
      return readFile(args[args.indexOf('--token-file') + 1]!, 'utf8')
    }).then((tok) => tokens.set(s.id, tok.trim()))
    return s
  }
  return r
}

async function started() {
  const r = await rig()
  await r.runner.startTicket({ key: 'CHV-9', title: 'Orders', text: 'show orders', source: 'goby', repos: [{ path: ROOT }] })
  await new Promise((res) => setTimeout(res, 50))
  return r
}

async function approved() {
  const r = await started()
  await r.as('CHV-9 planner')('submit_plan', { plan })
  const card = cardsFor(r.ticket()).find((c) => c.kind === 'plan')!
  await r.runner.act(r.ticket().id, card.id, 'approve')
  await new Promise((res) => setTimeout(res, 50))
  return r
}

describe('WorkflowRunner: start_ticket', () => {
  it('opens a tab for the ticket without moving the user, and starts a read-only planner in it', async () => {
    const r = await started()
    expect(r.pm.projects).toEqual([expect.objectContaining({ name: 'CHV-9 Orders', root: ROOT, active: false })])
    const planner = r.tile('CHV-9 planner')!
    expect(planner.slot).toBe(1)
    expect(planner.command).toMatch(/^claude --permission-mode auto --settings "[^"]+settings\.json" --mcp-config "[^"]+mcp\.json"$/)
    const settings = JSON.parse(await readFile(/--settings "([^"]+)"/.exec(planner.command)![1]!, 'utf8'))
    expect(settings.permissions.deny).toEqual(['Edit', 'Write', 'NotebookEdit'])
    expect(settings.hooks.PreToolUse[0]).toMatchObject({ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell' })
    await r.flush()
    expect(planner.typed[0]).toMatch(/You are the planner for ticket CHV-9/)
    expect(planner.typed[0]).toContain('show orders')
    expect(planner.typed[0]).toMatch(/Independent PRs.*Stacked PRs.*Single PR/s)
    expect(planner.typed[0]).toMatch(/The user's default is Auto: recommend what fits best/)
  })

  it('starts each role on the model and effort Settings give it, and on the Claude Code default otherwise', async () => {
    const r = await rig()
    r.settings.models = { ...r.settings.models, planner: { model: 'opus', effort: 'xhigh' }, coder: { model: 'sonnet', effort: null } }
    await r.runner.startTicket({ key: 'CHV-9', title: 'Orders', text: 'x', source: 'goby', repos: [{ path: ROOT }] })
    await new Promise((res) => setTimeout(res, 50))
    expect(r.tile('CHV-9 planner')!.command).toMatch(/^claude --permission-mode auto --model opus --effort xhigh --settings /)
    await r.as('CHV-9 planner')('submit_plan', { plan })
    await r.runner.ticketAction({ ticket: 'CHV-9', action: 'approve' })
    expect(r.tile('CHV-9-1')!.command).toMatch(/^claude --permission-mode auto --model sonnet --settings /)
    expect(r.tile('CHV-9-1')!.command).not.toContain('--effort')
  })

  it('refuses a path that is not a repository, and a ticket that already has a tab', async () => {
    const r = await rig(fakeGit({ isRepo: async () => false }))
    await expect(r.runner.startTicket({ title: 'x', text: 'y', source: 'pasted', repos: [{ path: '/nope' }] })).rejects.toThrow(/not a git repository/)
    const ok = await started()
    await expect(ok.runner.startTicket({ key: 'CHV-9', title: 'again', text: 'y', source: 'goby', repos: [{ path: ROOT }] }))
      .rejects.toThrow(/already has a ticket tab/)
  })

  it('waits for an idle agent before typing, and never types into a busy one', async () => {
    const r = await rig()
    await r.runner.startTicket({ key: 'CHV-9', title: 'Orders', text: 'x', source: 'goby', repos: [{ path: ROOT }] })
    const planner = r.tile('CHV-9 planner')!
    planner.tracker.status = 'busy'
    await r.flush()
    expect(planner.typed).toEqual([])
    planner.tracker.status = 'idle'
    await r.flush()
    expect(planner.typed).toHaveLength(1)
  })
})

describe('WorkflowRunner: the tiles\' tools', () => {
  it('gives each role its own tools and refuses the others', async () => {
    const r = await started()
    const who = r.runner.authorize('not-a-token')
    expect(who).toBeNull()
    const planner = r.as('CHV-9 planner')
    await expect(planner('submit_review', { findings: [], tests_passed: true, evidence: 'x' })).rejects.toThrow(/a planner has no submit_review/)
  })

  it('sends a bad plan\'s problems back to the planner, and a good one to the user', async () => {
    const r = await started()
    const planner = r.as('CHV-9 planner')
    await expect(planner('submit_plan', { plan: { ...plan, prs: [] } })).rejects.toThrow(/1 to 16 PRs/)
    expect(await planner('submit_plan', { plan })).toMatch(/user approves it/)
    expect(r.ticket().phase).toBe('awaiting-approval')
  })

  it('on approval closes the planner and opens the first coder in its new worktree, named like the repo\'s branches', async () => {
    const r = await approved()
    expect(r.tile('CHV-9 planner')).toBeUndefined()
    const coder = r.tile('CHV-9-1')!
    expect(coder.cwd).toBe(path.resolve('/wt/1'))
    expect(r.ticket().prs[0]).toMatchObject({ branch: 'feat/CHV-9-1-table', status: 'coding', coder: { slot: coder.slot } })
    await r.flush()
    expect(coder.typed[0]).toMatch(/You are the coder for CHV-9-1/)
    expect(coder.typed[0]).toContain('db/**')
    expect(coder.typed[0]).toMatch(/Start now/)
  })

  it('checks a report against git, and starts a fresh reviewer for passing work', async () => {
    const r = await approved()
    const coder = r.as('CHV-9-1')
    // The fake git says HEAD is a1: a report on zz is refused, with why.
    await expect(coder('report', { kind: 'tests_passing', sha: 'zz', evidence: 'ok' })).rejects.toThrow(/HEAD is a1/)
    expect(r.ticket().prs[0]!.status).toBe('coding')
    expect(await coder('report', { kind: 'tests_passing', sha: 'a1', evidence: '12 passed' })).toMatch(/in-review/)
    const reviewer = r.tile('CHV-9-1 review')!
    expect(reviewer.cwd).toBe(path.resolve('/wt/1'))
    await r.flush()
    expect(reviewer.typed[0]).toMatch(/fresh reviewer/)
    expect(reviewer.typed[0]).toContain('git diff base0..a1')
  })
})

describe('WorkflowRunner: the gates', () => {
  it('lets a coder edit only the files its PR owns, inside its worktree', async () => {
    const r = await approved()
    const coder = r.tile('CHV-9-1')!
    const edit = (file: string) => r.runner.gate(coder.id, 'Edit', { file_path: file })
    expect(edit(path.resolve('/wt/1/db/orders.sql'))).toMatchObject({ decision: 'allow' })
    expect(edit(path.resolve('/wt/1/src/routes/orders.ts'))).toEqual({ decision: 'deny', reason: expect.stringMatching(/belongs to CHV-9-2.*request_change/) })
    expect(edit(path.resolve('/wt/1/README.md'))).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/not owned by any PR/) })
    expect(edit(path.resolve('/src/api/db/orders.sql'))).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/outside your worktree/) })
  })

  it('holds a push until the user lets that PR push, and never lets anyone merge', async () => {
    const r = await approved()
    const coder = r.tile('CHV-9-1')!
    expect(r.runner.gate(coder.id, 'Bash', { command: 'git push -u origin HEAD' })).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/Pushing is held/) })
    expect(r.runner.gate(coder.id, 'Bash', { command: 'gh pr create --draft' })).toMatchObject({ decision: 'deny' })
    expect(r.runner.gate(coder.id, 'Bash', { command: 'gh pr merge 12' })).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/never merges/) })
    expect(r.runner.gate(coder.id, 'Bash', { command: 'npm test' })).toBeNull()
    await r.store.update(r.ticket().id, (t) => { t.prs[0]!.pushAllowed = true })
    expect(r.runner.gate(coder.id, 'Bash', { command: 'git push -u origin HEAD' })).toBeNull()
    // Opening and retargeting PRs is tring's job, with its own token.
    expect(r.runner.gate(coder.id, 'Bash', { command: 'gh pr create --draft --base develop' })).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/open_pr/) })
    expect(r.runner.gate(coder.id, 'Bash', { command: 'gh pr edit 12 --base develop' })).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/open_pr/) })
  })

  it('keeps reviewers read-only, and has no say over tiles that are not the workflow\'s', async () => {
    const r = await approved()
    await r.as('CHV-9-1')('report', { kind: 'tests_passing', sha: 'a1', evidence: 'ok' })
    const reviewer = r.tile('CHV-9-1 review')!
    expect(r.runner.gate(reviewer.id, 'Write', { file_path: path.resolve('/wt/1/db/x.sql') })).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/read-only/) })
    expect(r.runner.gate(reviewer.id, 'Bash', { command: 'git push' })).toMatchObject({ decision: 'deny' })
    const coder = r.tile('CHV-9-1')!
    expect(r.runner.gate(coder.id, 'Edit', { file_path: path.resolve('/wt/1/db/x.sql') })).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/being reviewed/) })
    expect(r.runner.gate('someone-else', 'Edit', { file_path: '/x' })).toBeNull()
  })

  it('says which ticket a tile belongs to, for the orchestrator\'s send_prompt refusal', async () => {
    const r = await approved()
    expect(r.runner.ticketOf(r.tile('CHV-9-1')!.id)).toBe('CHV-9')
    expect(r.runner.ticketOf('someone-else')).toBeNull()
  })
})

describe('WorkflowRunner: the orchestrator\'s ticket tools', () => {
  it('lists tickets and does what a card button does when the user says it', async () => {
    const r = await started()
    await r.as('CHV-9 planner')('submit_plan', { plan })
    expect(r.runner.listTickets()).toMatch(/CHV-9 Orders — awaiting-approval; 1 card\(s\) waiting/)
    expect(r.runner.ticketStatus('chv-9')).toMatch(/Plan v1: two PRs/)
    await expect(r.runner.ticketAction({ ticket: 'CHV-9', action: 'push', pr: 1 })).rejects.toThrow(/nothing to push/)
    expect(await r.runner.ticketAction({ ticket: 'CHV-9', action: 'approve' })).toMatch(/Done: approve/)
    expect(r.ticket().phase).toBe('building')
    expect(await r.runner.ticketAction({ ticket: 'CHV-9', action: 'tell', pr: 1, text: 'use snake_case' })).toMatch(/Passed to CHV-9-1/)
    await r.flush()
    expect(r.tile('CHV-9-1')!.typed.join('\n')).toContain('The user says: use snake_case')
  })

  it('answers a ticket it does not know with the ones it does', () => {
    return rig().then((r) => expect(() => r.runner.ticketStatus('CHV-1')).toThrow(ToolError))
  })
})

describe('WorkflowRunner: cards', () => {
  it('turns each ticket\'s cards into inbox items, and shows none for a ticket cleaned up', async () => {
    const r = await started()
    await r.as('CHV-9 planner')('submit_plan', { plan })
    const items = r.runner.cardItems()
    expect(items.map((i) => [i.kind, i.id.split(':').slice(1).join(':')])).toEqual([['feature', 'feature'], ['workflow', 'plan:v1']])
    expect(items[1]).toMatchObject({ ticketId: r.ticket().id, sessionId: '', title: expect.stringMatching(/Plan for CHV-9/) })
    expect(items[1]!.actions!.map((a) => a.id)).toEqual(['approve', 'revise', 'cancel', 'agents'])
    await r.store.update(r.ticket().id, (t) => { t.archived = true })
    expect(r.runner.cardItems()).toEqual([])
  })
})

describe('WorkflowRunner: after the push', () => {
  /** PR 1 pushed (as if its coder had reported it). */
  async function pushed(r: Awaited<ReturnType<typeof rig>>) {
    await r.runner.startTicket({ key: 'CHV-9', title: 'Orders', text: 'x', source: 'goby', repos: [{ path: ROOT }] })
    await new Promise((res) => setTimeout(res, 50))
    await r.as('CHV-9 planner')('submit_plan', { plan: { ...plan, prs: [plan.prs[0]], interfaces: [] } })
    await r.runner.ticketAction({ ticket: 'CHV-9', action: 'approve' })
    await r.store.update(r.ticket().id, (t) => { t.prs[0]!.status = 'pushed'; t.prs[0]!.prUrl = 'https://github.com/o/r/pull/7' })
  }

  it('follows the PR on the forge: its CI onto the checklist, and its merge into the stack', async () => {
    let state: 'open' | 'merged' = 'open'
    const r = await rig(fakeGit(), { pr: async () => ({ state, ci: 'green' }) })
    await pushed(r)
    await r.runner.readForge(r.ticket())
    expect(r.ticket().ci).toEqual({ 1: 'green' })
    state = 'merged'
    await r.runner.readForge(r.ticket())
    expect(r.ticket()).toMatchObject({ phase: 'done', prs: [expect.objectContaining({ status: 'merged' })] })
  })

  /** PR 1 cleared to push: the user clicked Push, and its coder is pushing. */
  async function pushing(r: Awaited<ReturnType<typeof rig>>, over: Partial<import('@tring/shared/workflow').StackPr> = {}) {
    await r.runner.startTicket({ key: 'CHV-9', title: 'Orders', text: 'x', source: 'goby', repos: [{ path: ROOT }] })
    await new Promise((res) => setTimeout(res, 50))
    await r.as('CHV-9 planner')('submit_plan', { plan: { ...plan, prs: [plan.prs[0]], interfaces: [] } })
    await r.runner.ticketAction({ ticket: 'CHV-9', action: 'approve' })
    await new Promise((res) => setTimeout(res, 50))
    await r.store.update(r.ticket().id, (t) => Object.assign(t.prs[0]!, { status: 'review-clean', work: 'pushing', pushAllowed: true, ...over }))
  }
  const BB_PR = 'https://bitbucket.org/matogen/api/pull-requests/42'

  it('opens the PR itself once the coder has pushed, against the branch below', async () => {
    const opened: unknown[] = []
    const r = await rig(fakeGit(), { open: async (o) => { opened.push(o); return { url: BB_PR } } })
    await pushing(r)
    expect(await r.as('CHV-9-1')('open_pr', { title: 'Orders table', body: 'Part 1 of a stack.' })).toMatch(BB_PR)
    expect(opened).toEqual([{ origin: 'git@bitbucket.org:matogen/api.git', head: r.ticket().prs[0]!.branch, base: 'develop', title: 'Orders table', body: 'Part 1 of a stack.' }])
    expect(r.ticket().prs[0]).toMatchObject({ status: 'pushed', prUrl: BB_PR, pushAllowed: false })
  })

  it('without a token, records the push and hands the user the link to open the PR', async () => {
    const link = 'https://bitbucket.org/matogen/api/pull-requests/new?source=x&dest=develop'
    const r = await rig(fakeGit(), { open: async () => ({ error: 'no Bitbucket token: …', link }) })
    await pushing(r)
    expect(await r.as('CHV-9-1')('open_pr', { title: 'T', body: 'B' })).toMatch(/no Bitbucket token.*opens it by hand/s)
    expect(r.ticket().prs[0]).toMatchObject({ status: 'pushed', prUrl: link })
    expect(r.ticket().log.at(-1)!.text).toMatch(/by hand/)
  })

  it('opens nothing before the user has said push', async () => {
    const r = await rig(fakeGit(), { open: async () => { throw new Error('must not open') } })
    await pushing(r, { work: 'idle', pushAllowed: false })
    await expect(r.as('CHV-9-1')('open_pr', { title: 'T', body: 'B' })).rejects.toThrow(/not asked you to push/)
  })

  it('after a restack, points the PR it already has at the branch below instead of opening another', async () => {
    const retargeted: unknown[] = []
    const r = await rig(fakeGit(), {
      open: async () => { throw new Error('must not open') },
      retarget: async (url, base) => { retargeted.push([url, base]); return null },
    })
    await pushing(r, { status: 'pushed', prUrl: BB_PR, flags: { needsRestack: false, baseFailing: false, blocked: null, interfaceReady: true, failing: false, repush: true } })
    expect(await r.as('CHV-9-1')('open_pr', { title: 'T', body: 'B' })).toMatch(BB_PR)
    expect(retargeted).toEqual([[BB_PR, 'develop']])
    expect(r.ticket().prs[0]).toMatchObject({ status: 'pushed', prUrl: BB_PR, flags: expect.objectContaining({ repush: false }) })
  })

  it('without the forge, counts a PR merged once its branch is in the base on origin', async () => {
    let merged = false
    const r = await rig(fakeGit({ isMerged: async () => merged }), { pr: async () => null })
    await pushed(r)
    await r.runner.readForge(r.ticket())
    expect(r.ticket().prs[0]!.status).toBe('pushed')
    merged = true
    await r.runner.readForge(r.ticket())
    expect(r.ticket()).toMatchObject({ phase: 'done', prs: [expect.objectContaining({ status: 'merged' })] })
  })

  it('offers to clean up only what is safe, and removes only what was ticked', async () => {
    const removed: string[] = []
    const r = await rig(fakeGit({
      check: async (wt: string) => ({ head: 'a1', clean: !wt.endsWith('2') }),
      removeWorktree: async (_repo: string, wt: string) => { removed.push(wt); return null },
      deleteBranch: async (_repo: string, b: string) => { removed.push(b); return null },
    }), { pr: async () => ({ state: 'merged', ci: 'green' }) })
    await pushed(r)
    await r.runner.readForge(r.ticket())
    const items = await r.runner.cleanupPlan(r.ticket().id)
    expect(items.map((i) => [i.id, i.safe])).toEqual([['tab', true], ['worktree:1', true], ['branch:1', true]])
    await r.runner.cleanup(r.ticket().id, ['worktree:1'])
    expect(removed).toEqual([path.resolve('/wt/1')])
    expect(r.ticket().archived).toBe(true)
    expect(r.pm.projects).toHaveLength(1)
    expect(r.runner.ticketViews()).toEqual([])
  })

  it('ticks nothing for a cancelled ticket', async () => {
    const r = await started()
    await r.as('CHV-9 planner')('submit_plan', { plan })
    await r.runner.ticketAction({ ticket: 'CHV-9', action: 'cancel' })
    const items = await r.runner.cleanupPlan(r.ticket().id)
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => !i.safe)).toBe(true)
  })

  it('describes each ticket for its tab badge and stack rail', async () => {
    const r = await approved()
    const [v] = r.runner.ticketViews()
    expect(v).toMatchObject({ localKey: 'CHV-9', projectId: 'p1', phase: 'building', done: 0, total: 2, strategy: 'stacked' })
    expect(v!.repos[0]).toMatchObject({ integration: null, combined: null })
    expect(v!.repos[0]!.prs.map((p) => [p.key, p.on, p.status, p.queued])).toEqual([
      ['CHV-9-1', 'develop', 'coding', false],
      ['CHV-9-2', 'CHV-9-1', 'planned', true],
    ])
  })
})

describe('WorkflowRunner: the integration check', () => {
  /** One unit, review-clean at a1: the next step is the api repo's integration check. */
  async function clean(git = fakeGit()) {
    const r = await rig(git)
    await r.runner.startTicket({ key: 'CHV-9', title: 'Orders', text: 'x', source: 'goby', repos: [{ path: ROOT }] })
    await new Promise((res) => setTimeout(res, 50))
    await r.as('CHV-9 planner')('submit_plan', { plan: { ...plan, prs: [plan.prs[0]], interfaces: [] } })
    await r.runner.ticketAction({ ticket: 'CHV-9', action: 'approve' })
    await r.store.update(r.ticket().id, (t) => Object.assign(t.prs[0]!, { status: 'review-clean', work: 'idle', headSha: 'a1' }))
    await r.runner.run(r.ticket().id, { type: 'tick' })
    await new Promise((res) => setTimeout(res, 50))
    return r
  }

  it('merges the units onto the base and opens a read-only integrator tile on the result', async () => {
    const asked: unknown[] = []
    const r = await clean(fakeGit({ integrate: async (...a: unknown[]) => { asked.push(a); return { sha: 'm1', base: 'b0', worktree: path.resolve('/wt/integration') } } }))
    expect(asked).toEqual([[ROOT, { base: 'develop', tips: [{ unit: 1, branch: 'a1' }], name: 'tring-CHV-9-api-integration' }]])
    const tile = r.tile('CHV-9 api integration')!
    expect(tile.cwd).toBe(path.resolve('/wt/integration'))
    const settings = JSON.parse(await readFile(/--settings "([^"]+)"/.exec(tile.command)![1]!, 'utf8'))
    expect(settings.permissions).toEqual({ allow: ['Bash(npm test)'], deny: ['Edit', 'Write', 'NotebookEdit'] })
    await r.flush()
    expect(tile.typed[0]).toMatch(/integration check of ticket CHV-9 in api/)
    expect(tile.typed[0]).toContain('m1')
    expect(tile.typed[0]).toContain('- npm test')
    expect(r.runner.gate(tile.id, 'Edit', { file_path: path.resolve('/wt/integration/x.ts') })).toMatchObject({ decision: 'deny' })
    expect(r.runner.gate(tile.id, 'Bash', { command: 'git push' })).toMatchObject({ decision: 'deny' })
    expect(r.ticket().integration['api']).toMatchObject({ status: 'running', sha: 'm1', base: 'b0' })
  })

  it('takes the integrator\'s verdict for that merge only', async () => {
    const r = await clean()
    const integrator = r.as('CHV-9 api integration')
    await expect(integrator('report_integration', { sha: 'old', passed: true, evidence: 'ok' })).rejects.toThrow(/checking m1/)
    expect(await integrator('report_integration', {
      sha: 'm1', passed: false, evidence: 'npm test: 2 failed', failures: [{ test: 'orders.e2e', unit: 1 }],
    })).toMatch(/Recorded/)
    expect(r.ticket().integration['api']).toMatchObject({ status: 'failing', evidence: expect.stringMatching(/2 failed[\s\S]*orders\.e2e \(CHV-9-1\)/) })
  })

  it('lets the orchestrator send a failure to a PR, run the check again, or accept it', async () => {
    const r = await clean()
    await r.as('CHV-9 api integration')('report_integration', { sha: 'm1', passed: false, evidence: '1 failed' })
    await expect(r.runner.ticketAction({ ticket: 'CHV-9', action: 'accept', repo: 'api' })).rejects.toThrow(/needs a reason/)
    expect(await r.runner.ticketAction({ ticket: 'CHV-9', action: 'route', pr: 1 })).toMatch(/Done: route CHV-9-1/)
    expect(r.ticket().prs[0]!.review!.findings.at(-1)).toMatchObject({ id: '1.i1', resolution: 'fix-requested' })
  })

  it('offers tring\'s integration worktree to Clean up, and removes it when ticked', async () => {
    const removed: string[] = []
    const r = await clean(fakeGit({ removeWorktree: async (_repo: string, wt: string) => { removed.push(wt); return null } }))
    await r.store.update(r.ticket().id, (t) => { t.phase = 'done' })
    const items = await r.runner.cleanupPlan(r.ticket().id)
    expect(items.find((i) => i.id === 'integration:api')).toMatchObject({ safe: true, label: expect.stringContaining(path.resolve('/wt/integration')) })
    await r.runner.cleanup(r.ticket().id, ['integration:api'])
    expect(removed).toEqual([path.resolve('/wt/integration')])
  })

  it('reports a conflict without opening a tile, and a merge it could not make as a failure', async () => {
    const r = await clean(fakeGit({ integrate: async () => ({ conflict: { units: [1], files: ['package-lock.json'] } }) }))
    expect(r.ticket().integration['api']).toMatchObject({ status: 'conflict', conflict: { units: [1], files: ['package-lock.json'] } })
    expect(r.tile('CHV-9 api integration')).toBeUndefined()
    const broken = await clean(fakeGit({ integrate: async () => { throw new Error('develop does not exist') } }))
    expect(broken.ticket().integration['api']).toMatchObject({ status: 'failing', evidence: expect.stringMatching(/could not run it: develop does not exist/) })
  })
})

describe('WorkflowRunner: independent PRs and a final combined PR', () => {
  const BB_FINAL = 'https://bitbucket.org/matogen/api/pull-requests/50'
  async function approvedAs(strategy: string, combined: boolean, git = fakeGit(), forge?: Partial<Pick<Forge, 'pr' | 'open' | 'retarget'>>) {
    const r = await rig(git, forge)
    await r.runner.startTicket({ key: 'CHV-9', title: 'Orders', text: 'x', source: 'goby', repos: [{ path: ROOT }] })
    await new Promise((res) => setTimeout(res, 50))
    await r.as('CHV-9 planner')('submit_plan', { plan: { ...plan, prs: [plan.prs[0]], interfaces: [], advice: advice('independent') } })
    await r.runner.ticketAction({ ticket: 'CHV-9', action: 'approve', strategy, combined })
    await new Promise((res) => setTimeout(res, 50))
    return r
  }

  it('approves as the strategy the orchestrator was told, with a final PR named like the repo\'s branches', async () => {
    const r = await approvedAs('independent', true)
    expect(r.ticket()).toMatchObject({ strategy: 'independent', combinedPr: true })
    expect(r.ticket().combined['api']).toMatchObject({ branch: 'feat/CHV-9-orders', base: 'develop', status: 'local', onOrigin: false })
  })

  it('pushes the feature branch first, then lets the unit push against it', async () => {
    const pushed: unknown[] = []
    const r = await approvedAs('independent', true, fakeGit({ pushBranch: async (...a: unknown[]) => { pushed.push(a); return null } }))
    await r.store.update(r.ticket().id, (t) => {
      Object.assign(t.prs[0]!, { status: 'review-clean', work: 'idle', headSha: 'a1' })
      t.integration['api'] = { status: 'passing', base: 'b0', tips: { 1: 'a1' }, sha: 'm1', conflict: null, evidence: 'ok' }
    })
    await r.runner.ticketAction({ ticket: 'CHV-9', action: 'push', pr: 1 })
    expect(pushed).toEqual([[ROOT, 'origin/develop', 'feat/CHV-9-orders']])
    expect(r.ticket().combined['api']!.onOrigin).toBe(true)
    await r.flush()
    expect(r.tile('CHV-9-1')!.typed.join('\n')).toContain('`feat/CHV-9-orders`')
  })

  it('opens the final PR once every unit is merged into the feature branch, and follows it to done', async () => {
    const opened: unknown[] = []
    let state: 'open' | 'merged' = 'open'
    const r = await approvedAs('independent', true, fakeGit(), {
      open: async (o) => { opened.push(o); return { url: BB_FINAL } },
      pr: async (url) => (url === BB_FINAL ? { state, ci: 'green' } : { state: 'merged', ci: 'green' }),
    })
    await r.store.update(r.ticket().id, (t) => {
      Object.assign(t.prs[0]!, { status: 'merged', work: 'idle', headSha: 'a1' })
      t.combined['api']!.onOrigin = true
    })
    expect(await r.runner.ticketAction({ ticket: 'CHV-9', action: 'open-final', repo: 'api' })).toMatch(/Done/)
    expect(opened).toEqual([expect.objectContaining({ head: 'feat/CHV-9-orders', base: 'develop', title: 'CHV-9 Orders' })])
    expect(r.ticket().combined['api']).toMatchObject({ status: 'pushed', prUrl: BB_FINAL })
    await r.runner.readForge(r.ticket())
    expect(r.ticket().phase).not.toBe('done')
    state = 'merged'
    await r.runner.readForge(r.ticket())
    expect(r.ticket()).toMatchObject({ phase: 'done', combined: { api: { status: 'merged' } } })
  })
})

describe('WorkflowRunner: a single PR of agent commits', () => {
  /** One unit, review-clean at a1, approved as a single PR: the next step is its assembly. */
  async function clean(git = fakeGit(), forge?: Partial<Pick<Forge, 'pr' | 'open' | 'retarget'>>) {
    const r = await rig(git, forge)
    await r.runner.startTicket({ key: 'CHV-9', title: 'Orders', text: 'x', source: 'goby', repos: [{ path: ROOT }] })
    await new Promise((res) => setTimeout(res, 50))
    await r.as('CHV-9 planner')('submit_plan', { plan: { ...plan, prs: [plan.prs[0]], interfaces: [] } })
    await r.runner.ticketAction({ ticket: 'CHV-9', action: 'approve', strategy: 'single' })
    await r.store.update(r.ticket().id, (t) => Object.assign(t.prs[0]!, { status: 'review-clean', work: 'idle', headSha: 'a1', baseSha: 'b0' }))
    await r.runner.run(r.ticket().id, { type: 'tick' })
    await new Promise((res) => setTimeout(res, 50))
    return r
  }
  const assembledGit = (over: Partial<Record<keyof StackGit, unknown>> = {}) => fakeGit({
    assemble: async () => ({ sha: 's1', base: 'b0', worktree: path.resolve('/wt/integration'), commits: [{ unit: 1, sha: 's1', verified: false }] }),
    ...over,
  })

  it('assembles the units into commits and has the integrator check the ones that differ from what was reviewed', async () => {
    const asked: unknown[] = []
    const r = await clean(assembledGit({ assemble: async (...a: unknown[]) => { asked.push(a); return { sha: 's1', base: 'b0', worktree: path.resolve('/wt/integration'), commits: [{ unit: 1, sha: 's1', verified: false }] } } }))
    expect(asked).toEqual([[ROOT, {
      base: 'develop', name: 'tring-CHV-9-api-integration',
      units: [{ unit: 1, from: 'b0', head: 'a1', message: 'Table\n\nsmall\n\nCHV-9-1' }],
    }]])
    expect(r.ticket().combined['api']!.commits).toEqual([{ unit: 1, sha: 's1', verified: false }])
    await r.flush()
    const brief = r.tile('CHV-9 api integration')!.typed[0]!
    expect(brief).toMatch(/one commit per unit/)
    expect(brief).toMatch(/s1.*CHV-9-1.*check it out and run its tests/s)
  })

  it('pushes the assembled branch on the user\'s Push and opens its one PR', async () => {
    const pushed: unknown[] = []
    const opened: unknown[] = []
    const r = await clean(assembledGit({ pushBranch: async (...a: unknown[]) => { pushed.push(a); return null } }), {
      open: async (o) => { opened.push(o); return { url: 'https://bitbucket.org/matogen/api/pull-requests/7' } },
    })
    await r.as('CHV-9 api integration')('report_integration', { sha: 's1', passed: true, evidence: 'all pass' })
    expect(await r.runner.ticketAction({ ticket: 'CHV-9', action: 'push-single', repo: 'api' })).toMatch(/Done/)
    expect(pushed).toEqual([[ROOT, 's1', 'feat/CHV-9-orders', null]])
    expect(opened).toEqual([expect.objectContaining({ head: 'feat/CHV-9-orders', base: 'develop', title: 'CHV-9 Orders' })])
    expect(r.ticket().combined['api']).toMatchObject({ status: 'pushed', pushedSha: 's1', prUrl: 'https://bitbucket.org/matogen/api/pull-requests/7' })
    expect(r.ticket().prs[0]).toMatchObject({ status: 'pushed', prUrl: 'https://bitbucket.org/matogen/api/pull-requests/7' })
  })
})

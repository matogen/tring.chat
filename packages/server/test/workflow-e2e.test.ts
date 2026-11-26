import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProjectInfo, SessionStatus } from '@tring/shared/protocol'
import { DEFAULT_WORKFLOW, type Plan, type PlannedPr, type Strategy } from '@tring/shared/workflow'
import { StackGit } from '../src/workflow/git.ts'
import { WorkflowRunner, type RunnerSession } from '../src/workflow/runner.ts'
import { TicketStore } from '../src/workflow/tickets.ts'
import { advice } from './workflow-advice.ts'

/**
 * End to end, without Claude or a terminal: the real runner, engine and git
 * (a bare origin and a clone), and scripted agents that do what the briefs
 * and jobs typed into their tiles ask — commit in their own worktree, report
 * through the tring-stack tools, push when told — one ticket per strategy,
 * from plan to merged.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=agent@test', ...args], { cwd, encoding: 'utf8' }).trim()

const tmp = mkdtempSync(path.join(os.tmpdir(), 'tring-e2e-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** A bare origin with develop, and the user's clone of it. */
function repo(name: string): { root: string; origin: string } {
  const origin = path.join(tmp, `${name}.git`)
  git(tmp, 'init', '-q', '--bare', origin)
  const root = path.join(tmp, name)
  git(tmp, 'clone', '-q', origin, root)
  git(root, 'checkout', '-qb', 'develop')
  writeFileSync(path.join(root, 'README.md'), 'app\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  git(root, 'push', '-q', '-u', 'origin', 'develop')
  return { root, origin }
}

const unit = (over: Partial<PlannedPr> & Pick<PlannedPr, 'index' | 'title'>): PlannedPr => ({
  repo: '', below: null, scope: `${over.title}.`, owns: [], uses: [], tests: { add: ['t.test.ts'], run: ['node -e 0'] },
  acceptance: ['works'], ...over,
})

function planFor(strategy: Strategy, repoId: string): Plan {
  const stacked = strategy !== 'independent'
  return {
    version: 1, summary: 'Orders', shared: [], deployOrder: null, addRepos: [], docs: { none: 'internal' },
    advice: advice(strategy),
    interfaces: stacked ? [{ name: 'Table', owner: 1, contract: 'orders(id)' }] : [],
    prs: [
      unit({ index: 1, repo: repoId, title: 'Orders table', owns: ['db/**'] }),
      unit({ index: 2, repo: repoId, title: stacked ? 'Orders API' : 'Audit log', owns: [stacked ? 'src/**' : 'audit/**'],
        below: stacked ? 1 : null, uses: stacked ? ['Table'] : [] }),
    ],
  }
}

interface Tile extends RunnerSession { name: string; cwd: string; command: string }

async function rig(strategy: Strategy) {
  const { root, origin } = repo(`app-${strategy}`)
  const dir = mkdtempSync(path.join(tmp, 'conf-'))
  const store = new TicketStore(path.join(dir, 'tickets.json'), path.join(dir, 'tickets'))
  let now = 1_000_000
  const projects: Array<{ id: string; name: string; root: string; sessions: Tile[] }> = []
  const tokens = new Map<string, string>()
  const pending = new Set<Promise<unknown>>()
  const errors: string[] = []
  const opened: Array<{ head: string; base: string }> = []
  let n = 0
  const pm = {
    list: (): ProjectInfo[] => projects.map((p) => ({
      id: p.id, name: p.name, root: p.root,
      sessions: p.sessions.map((s) => ({
        id: s.id, projectId: p.id, slot: s.slot, name: s.name, title: null, cwd: s.cwd, command: s.command, color: null,
        status: s.tracker.status, since: 0, exitCode: null,
      })),
    })),
    createProject(name: string, r: string): string {
      const id = `p${projects.length + 1}`
      projects.push({ id, name, root: r, sessions: [] })
      return id
    },
    create(projectId: string, spec: { cwd: string; command: string; name: string; claudeArgs: string }): Tile {
      const p = projects.find((x) => x.id === projectId)!
      let slot = 1
      while (p.sessions.some((s) => s.slot === slot)) slot++
      const s: Tile = {
        id: `s${++n}`, projectId, slot, name: spec.name, cwd: spec.cwd, command: spec.command,
        claude: { id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, cwd: spec.cwd },
        tracker: { status: 'idle' as SessionStatus }, write() {}, prompted() {},
      }
      const mcp = JSON.parse(readFileSync(/--mcp-config "([^"]+)"/.exec(spec.claudeArgs)![1]!, 'utf8'))
      const args = mcp.mcpServers['tring-stack'].args as string[]
      tokens.set(s.id, readFileSync(args[args.indexOf('--token-file') + 1]!, 'utf8').trim())
      p.sessions.push(s)
      return s
    },
    findSession: (id: string) => projects.flatMap((p) => p.sessions).find((s) => s.id === id),
    kill(id: string) { for (const p of projects) p.sessions = p.sessions.filter((s) => s.id !== id) },
    deleteProject() {},
  }
  const settings = { ...DEFAULT_WORKFLOW, multiPr: true, maxAgents: 6 }
  const runner: WorkflowRunner = new WorkflowRunner({
    store, settings: { get: () => settings }, git: new StackGit(), pm, inbox: { list: () => [] }, quotaHigh: () => false,
    tileDir: path.join(dir, 'tiles'), url: 'http://127.0.0.1:0', mcpScript: '/opt/tring/tring-mcp.js', node: process.execPath,
    now: () => now,
    // The scripted agents: each reads what was typed into its tile and acts on it, as Claude would.
    type: (s, text) => {
      const p = act(s as Tile, text).catch((err: Error) => { errors.push(`${(s as Tile).name}: ${err.message}`) })
      pending.add(p)
      void p.finally(() => pending.delete(p))
    },
    forge: {
      pr: async () => null,
      open: async (o) => { opened.push({ head: o.head, base: o.base }); return { url: `https://forge.test/pr/${opened.length}` } },
      retarget: async () => null,
    },
  })
  const call = (s: Tile, tool: string, args: Record<string, unknown> = {}): Promise<string> =>
    runner.call(runner.authorize(tokens.get(s.id)!)!, tool, args)

  async function act(s: Tile, text: string): Promise<void> {
    await new Promise((res) => setImmediate(res))
    if (/You are the planner/.test(text)) {
      await call(s, 'submit_plan', { plan: planFor(strategy, path.basename(root)) })
    } else if (/You are a fresh reviewer/.test(text)) {
      await call(s, 'submit_review', { findings: [], tests_passed: true, evidence: 'node -e 0: ok' })
    } else if (/integration check of ticket/.test(text)) {
      const sha = /Your worktree is at ([0-9a-f]{40})/.exec(text)![1]!
      await call(s, 'report_integration', { sha, passed: true, evidence: 'node -e 0: ok' })
    } else if (/The user says push/.test(text)) {
      git(s.cwd, 'push', '-q', '-u', 'origin', 'HEAD')
      await call(s, 'open_pr', { title: s.name, body: 'Part of a stack.' })
    } else if (/Start now/.test(text)) {
      // Write a file the unit owns, commit it, report the interface and the tests on that commit.
      const index = Number(/-(\d+)$/.exec(s.name)![1])
      const owned = planFor(strategy, '').prs[index - 1]!.owns[0]!.replace('/**', '')
      mkdirSync(path.join(s.cwd, owned), { recursive: true })
      writeFileSync(path.join(s.cwd, owned, `unit${index}.txt`), `unit ${index}\n`)
      git(s.cwd, 'add', '.')
      git(s.cwd, 'commit', '-qm', `unit ${index}`)
      await call(s, 'report', { kind: 'interface_ready' })
      await call(s, 'report', { kind: 'tests_passing', sha: git(s.cwd, 'rev-parse', 'HEAD'), evidence: 'node -e 0: ok' })
    }
  }

  /** Runs the runner's clock, letting idle agents get what is queued for them, until `done` or it gives up. */
  async function until(what: string, done: () => boolean): Promise<void> {
    for (let i = 0; i < 300 && !done(); i++) {
      await runner.pump()
      now += 2100
      await runner.pump()
      while (pending.size) await Promise.all([...pending])
      if (errors.length) throw new Error(errors.join('\n'))
    }
    if (!done()) throw new Error(`never got to: ${what}\n${JSON.stringify(store.list()[0], null, 1).slice(0, 3000)}`)
  }
  const ticket = () => store.list()[0]!
  return { runner, store, root, origin, opened, errors, until, ticket, settings }
}

describe('the multi-PR workflow end to end, with scripted agents and real git', { timeout: 30_000 }, () => {
  it('lands a stack: the API on the table, tested together, pushed bottom up, merged', async () => {
    const r = await rig('stacked')
    await r.runner.startTicket({ key: 'CHV-9', title: 'Orders', text: 'Show orders.', source: 'pasted', repos: [{ path: r.root }] })
    await r.until('the plan', () => r.ticket().phase === 'awaiting-approval')
    await r.runner.ticketAction({ ticket: 'CHV-9', action: 'approve', strategy: 'stacked' })
    await r.until('tested together', () => r.ticket().integration[path.basename(r.root)]?.status === 'passing')
    await r.runner.ticketAction({ ticket: 'CHV-9', action: 'push-stack', pr: 1 })
    await r.until('both pushed', () => r.ticket().prs.every((p) => p.status === 'pushed'))
    expect(r.opened.map((o) => o.base)).toEqual(['develop', r.ticket().prs[0]!.branch])
    expect(git(r.origin, 'branch', '--list').split('\n').length).toBe(3)
    await r.runner.ticketAction({ ticket: 'CHV-9', action: 'merged', pr: 1 })
    await r.runner.ticketAction({ ticket: 'CHV-9', action: 'merged', pr: 2 })
    expect(r.ticket().phase).toBe('done')
  })

  it('lands independent PRs: each off develop, tested together, pushed and merged in any order', async () => {
    const r = await rig('independent')
    await r.runner.startTicket({ key: 'CHV-10', title: 'Orders', text: 'Show orders.', source: 'pasted', repos: [{ path: r.root }] })
    await r.until('the plan', () => r.ticket().phase === 'awaiting-approval')
    await r.runner.ticketAction({ ticket: 'CHV-10', action: 'approve', strategy: 'independent' })
    await r.until('tested together', () => r.ticket().integration[path.basename(r.root)]?.status === 'passing')
    expect(Object.keys(r.ticket().integration[path.basename(r.root)]!.tips)).toEqual(['1', '2'])
    await r.runner.ticketAction({ ticket: 'CHV-10', action: 'push', pr: 2 })
    await r.until('unit 2 pushed', () => r.ticket().prs[1]!.status === 'pushed')
    await r.runner.ticketAction({ ticket: 'CHV-10', action: 'push', pr: 1 })
    await r.until('unit 1 pushed', () => r.ticket().prs[0]!.status === 'pushed')
    expect(r.opened.map((o) => o.base)).toEqual(['develop', 'develop'])
    await r.runner.ticketAction({ ticket: 'CHV-10', action: 'merged', pr: 2 })
    await r.runner.ticketAction({ ticket: 'CHV-10', action: 'merged', pr: 1 })
    expect(r.ticket().phase).toBe('done')
  })

  it('lands a single PR: one commit per unit, assembled by tring, pushed by tring, one PR', async () => {
    const r = await rig('single')
    const id = path.basename(r.root)
    await r.runner.startTicket({ key: 'CHV-11', title: 'Orders', text: 'Show orders.', source: 'pasted', repos: [{ path: r.root }] })
    await r.until('the plan', () => r.ticket().phase === 'awaiting-approval')
    await r.runner.ticketAction({ ticket: 'CHV-11', action: 'approve', strategy: 'single' })
    await r.until('assembled and tested', () => r.ticket().integration[id]?.status === 'passing')
    const combined = r.ticket().combined[id]!
    expect(combined.commits.map((c) => [c.unit, c.verified])).toEqual([[1, true], [2, true]])
    await r.runner.ticketAction({ ticket: 'CHV-11', action: 'push-single', repo: id })
    expect(r.ticket().combined[id]).toMatchObject({ status: 'pushed', prUrl: 'https://forge.test/pr/1' })
    expect(r.opened).toEqual([{ head: combined.branch, base: 'develop' }])
    // On origin: the PR's branch is develop plus one commit per unit, titled with it; the units' own branches stay local.
    expect(git(r.origin, 'log', '--format=%s', `develop..${combined.branch}`).split('\n')).toEqual(['Orders API', 'Orders table'])
    expect(git(r.origin, 'branch', '--list', 'tring/*')).toBe('')
    await r.runner.ticketAction({ ticket: 'CHV-11', action: 'merged-final', repo: id })
    expect(r.ticket().phase).toBe('done')
    expect(r.errors).toEqual([])
  })
})

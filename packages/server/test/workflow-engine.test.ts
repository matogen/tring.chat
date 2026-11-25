import { describe, it, expect } from 'vitest'
import type { Plan, PlannedPr, Ticket } from '@tring/shared/workflow'
import { advice } from './workflow-advice.ts'
import {
  cardsFor, checklist, prOf, step, STUCK_MS, type Command, type EngineEnv, type EngineEvent, type StepResult,
} from '../src/workflow/engine.ts'

const repos = [
  { id: 'api', root: '/src/api', baseBranch: 'develop' },
  { id: 'web', root: '/src/web', baseBranch: 'develop' },
]

const planned = (over: Partial<PlannedPr> & Pick<PlannedPr, 'index'>): PlannedPr => ({
  repo: 'api', below: null, title: `PR ${over.index}`, scope: 'small', owns: [`pr${over.index}/**`], uses: [],
  tests: { add: ['t.test.ts'], run: ['npm test'] }, acceptance: ['works'], ...over,
})

/** Schema -> API in `api`; a page in `web` that codes against the API. */
const ordersPlan = (): Plan => ({
  version: 1, summary: 'orders', shared: [], deployOrder: null, addRepos: [], docs: { none: 'internal' }, advice: advice(),
  prs: [
    planned({ index: 1, title: 'Orders table', owns: ['db/**'] }),
    planned({ index: 2, below: 1, title: 'Orders API', owns: ['src/routes/**'], uses: ['OrdersTable'] }),
    planned({ index: 3, repo: 'web', title: 'Orders page', owns: ['src/orders/**'], uses: ['OrdersApi'] }),
  ],
  interfaces: [
    { name: 'OrdersTable', owner: 1, contract: 'orders(id, total)' },
    { name: 'OrdersApi', owner: 2, contract: 'GET /orders' },
  ],
})

function ticket(maxAgents: number): Ticket {
  return {
    id: 't1', key: 'CHV-1', localKey: 'CHV-1', title: 'Orders', text: 'show orders', source: 'pasted', repos,
    projectId: 'p1', phase: 'planning', plan: null, prs: [], maxAgents, log: [], createdAt: 0,
    amendments: [], baseMoved: {}, planErrors: [],
    strategy: null, combinedPr: false, integrationCheck: true, integration: {}, combined: {}, followUps: [],
  }
}

interface RigOptions { review?: boolean; restack?: 'offer' | 'auto'; maxAgents?: number; plan?: Plan; integration?: boolean }

function rig(o: RigOptions = {}) {
  let now = 1_000
  let t = ticket(o.maxAgents ?? 4)
  let quotaHigh = false
  const env = (): EngineEnv => ({
    now, quotaHigh,
    settings: { requireFreshReview: o.review ?? true, autoRestack: o.restack ?? 'offer', integrationCheck: o.integration ?? true },
    repoIdForPath: (p) => p.split('/').pop()!,
  })
  const branchHead = (branch: string): string => {
    const owner = t.prs.find((p) => p.branch === branch)
    return owner?.headSha ?? `base:${branch}`
  }
  const r = {
    get t() { return t },
    set quota(high: boolean) { quotaHigh = high },
    advance(ms: number) { now += ms },
    send(e: EngineEvent): StepResult {
      const res = step(t, e, env())
      t = res.ticket
      // The git layer answers each new worktree with where it is and what it sits on.
      for (const c of res.commands) {
        if (c.do === 'createWorktree') {
          t = step(t, { type: 'worktree', pr: c.pr, path: `/wt/${c.pr}`, baseSha: branchHead(c.from) }, env()).ticket
        }
      }
      return res
    },
    card(kind: string, pr?: number) {
      return cardsFor(t).find((c) => c.kind === kind && (pr === undefined || c.prIndex === pr))
    },
    click(kind: string, action: string, opts: { pr?: number; text?: string; value?: number } = {}): StepResult {
      const c = r.card(kind, opts.pr)
      if (!c) throw new Error(`no ${kind} card${opts.pr ? ` for PR ${opts.pr}` : ''}`)
      return r.send({ type: 'action', cardId: c.id, action, ...(opts.text ? { text: opts.text } : {}), ...(opts.value !== undefined ? { value: opts.value } : {}) })
    },
    pr: (i: number) => prOf(t, i)!,
    approve(plan = o.plan ?? ordersPlan()): StepResult {
      r.send({ type: 'start' })
      r.send({ type: 'planSubmitted', plan })
      return r.click('plan', 'approve')
    },
    pass(i: number, sha: string): StepResult {
      return r.send({ type: 'report', pr: i, kind: 'tests_passing', sha, evidence: '12 passed', git: { head: sha, clean: true } })
    },
    /** A finding without a `proof` key gets one: the reviewer showed it. */
    review(i: number, findings: Array<{ severity: 'high' | 'medium' | 'low' | 'nit'; file?: string; summary: string; proof?: string | null; preExisting?: boolean }> = [], testsPassed = true): StepResult {
      const p = r.pr(i)
      return r.send({
        type: 'review', pr: i, testsPassed, evidence: testsPassed ? 'ok' : '1 failed',
        range: { base: p.baseSha ?? '', head: p.headSha ?? '' },
        findings: findings.map((f) => ({
          severity: f.severity, file: f.file ?? null, line: null, summary: f.summary,
          proof: 'proof' in f ? f.proof ?? null : 'npm test: 1 failed', preExisting: f.preExisting ?? false,
        })),
      })
    },
    /** The runner's side of a running integration check: merged as m-<repo>, then the integrator's verdict. */
    integrate(repo: string, status: 'passing' | 'failing' = 'passing', evidence = 'all 40 pass'): StepResult {
      if (t.integration[repo]?.status !== 'running') throw new Error(`no integration check running in ${repo}`)
      r.send({ type: 'integration', repo, result: { status: 'merged', sha: `m-${repo}`, base: 'b0' } })
      return r.send({ type: 'integration', repo, result: { status, sha: `m-${repo}`, evidence } })
    },
    /** Interface, tests, a clean review: the PR is review-clean at `sha`. */
    clean(i: number, sha: string) {
      r.send({ type: 'report', pr: i, kind: 'interface_ready' })
      r.pass(i, sha)
      if (r.pr(i).reviewing) r.review(i)
    },
  }
  return r
}

const kinds = (cs: Command[]): string[] => cs.map((c) => c.do)
const jobs = (cs: Command[]) => cs.flatMap((c) => (c.do === 'work' ? [{ pr: c.pr, job: c.job.kind }] : []))

describe('stack engine: planning', () => {
  it('starts with the planner', () => {
    const r = rig()
    expect(kinds(r.send({ type: 'start' }).commands)).toEqual(['startPlanner'])
  })

  it('sends a bad plan back to the planner with every problem, and shows the user nothing', () => {
    const r = rig()
    r.send({ type: 'start' })
    const res = r.send({ type: 'planSubmitted', plan: { ...ordersPlan(), prs: [] } })
    expect(res.commands).toEqual([{ do: 'notePlanner', note: { kind: 'planErrors', errors: [expect.stringMatching(/1 to 16 PRs/)] } }])
    expect(r.t.phase).toBe('planning')
    expect(r.card('plan')).toBeUndefined()
  })

  it('puts a good plan on a card to approve, change or cancel, with the agents slider', () => {
    const r = rig()
    r.send({ type: 'start' })
    r.send({ type: 'planSubmitted', plan: ordersPlan() })
    expect(r.t.phase).toBe('awaiting-approval')
    expect(r.card('plan')!.actions.map((a) => a.id)).toEqual(['approve', 'revise', 'cancel', 'agents'])
    expect(r.card('plan')!.body).toContain('CHV-1-2 Orders API')
  })

  it('shows the planner\'s recommended strategy and its reasons on the plan card', () => {
    const r = rig()
    r.send({ type: 'start' })
    r.send({ type: 'planSubmitted', plan: ordersPlan() })
    const body = r.card('plan')!.body
    expect(body).toMatch(/Recommended: stacked PRs/)
    expect(body).toContain('coupling: the API reads the table')
    expect(body).toContain('Single PR: One PR with two commits, table then API.')
  })

  it('asks the planner for changes in the user\'s words, which a change needs', () => {
    const r = rig()
    r.send({ type: 'start' })
    r.send({ type: 'planSubmitted', plan: ordersPlan() })
    expect(r.click('plan', 'revise').notice).toMatch(/needs a reason/)
    const res = r.click('plan', 'revise', { text: 'split the API in two' })
    expect(res.commands).toEqual([{ do: 'notePlanner', note: { kind: 'revise', text: 'split the API in two' } }])
    expect(r.t.phase).toBe('planning')
    r.send({ type: 'planSubmitted', plan: ordersPlan() })
    expect(r.card('plan')!.id).toMatch(/:plan:v2$/)
  })

  it('on approval closes the planner and starts only the PRs nothing holds back', () => {
    const r = rig()
    const res = r.approve()
    expect(r.t.phase).toBe('building')
    expect(res.commands).toEqual([
      { do: 'closePlanner' },
      { do: 'createWorktree', pr: 1, repo: 'api', branch: 'feature/CHV-1-1-orders-table', from: 'origin/develop' },
      { do: 'work', pr: 1, job: { kind: 'code' }, newTile: true },
    ])
    expect([r.pr(1).status, r.pr(2).status, r.pr(3).status]).toEqual(['coding', 'planned', 'planned'])
    expect(r.pr(1)).toMatchObject({ worktree: '/wt/1', baseSha: 'base:origin/develop' })
  })

  it('refuses a button that is no longer current, without changing anything', () => {
    const r = rig()
    r.send({ type: 'start' })
    r.send({ type: 'planSubmitted', plan: ordersPlan() })
    const card = r.card('plan')!
    r.send({ type: 'action', cardId: card.id, action: 'approve' })
    const before = r.t
    const again = r.send({ type: 'action', cardId: card.id, action: 'approve' })
    expect(again.notice).toMatch(/no longer current/)
    expect(again.commands).toEqual([])
    expect(r.t).toBe(before)
  })
})

describe('stack engine: who starts when', () => {
  it('starts a PR once the PRs it waits on have their interfaces, branched from the one below', () => {
    const r = rig()
    r.approve()
    const second = r.send({ type: 'report', pr: 1, kind: 'interface_ready' })
    expect(second.commands).toContainEqual({ do: 'createWorktree', pr: 2, repo: 'api', branch: 'feature/CHV-1-2-orders-api', from: 'feature/CHV-1-1-orders-table' })
    expect(r.pr(3).status).toBe('planned')
    const third = r.send({ type: 'report', pr: 2, kind: 'interface_ready' })
    expect(jobs(third.commands)).toEqual([{ pr: 3, job: 'code' }])
    expect(third.commands).toContainEqual(expect.objectContaining({ do: 'createWorktree', pr: 3, from: 'origin/develop' }))
  })

  it('runs no more agents than the ticket allows, and starts the next as one finishes', () => {
    const plan = { ...ordersPlan(), interfaces: [], prs: [1, 2, 3, 4, 5, 6].map((i) => planned({ index: i })) }
    const r = rig({ review: false, plan })
    expect(jobs(r.approve().commands).map((j) => j.pr)).toEqual([1, 2, 3, 4])
    expect(jobs(r.pass(2, 'a2').commands)).toEqual([{ pr: 5, job: 'code' }])
  })

  it('puts a waiting reviewer before a new coder', () => {
    const plan = { ...ordersPlan(), interfaces: [], prs: [1, 2, 3, 4, 5].map((i) => planned({ index: i })) }
    const r = rig({ plan })
    r.approve()
    const res = r.pass(1, 'a1')
    expect(kinds(res.commands)).toEqual(['review'])
    expect(r.pr(5).status).toBe('planned')
  })

  it('starts no new agent while usage is over the quota guard, and catches up after', () => {
    const r = rig()
    r.quota = true
    expect(jobs(r.approve().commands)).toEqual([])
    r.quota = false
    expect(jobs(r.send({ type: 'tick' }).commands)).toEqual([{ pr: 1, job: 'code' }])
  })

  it('takes the agents slider from 4 to 16, on the feature card', () => {
    const r = rig()
    r.approve()
    r.click('feature', 'agents', { value: 30 })
    expect(r.t.maxAgents).toBe(16)
    r.click('feature', 'agents', { value: 1 })
    expect(r.t.maxAgents).toBe(4)
  })

  it('starts nothing for a paused PR until it is resumed', () => {
    const r = rig()
    r.approve()
    r.send({ type: 'blocked', pr: 1, reason: 'need a decision' })
    r.click('blocked', 'pause', { pr: 1 })
    expect(r.pr(1).paused).toBe(true)
    r.click('feature', 'resume:1')
    expect(r.pr(1).paused).toBe(false)
  })
})

describe('stack engine: tests and the fresh review gate', () => {
  it('refuses a report on a dirty worktree or on a commit that is not HEAD', () => {
    const r = rig()
    r.approve()
    const dirty = r.send({ type: 'report', pr: 1, kind: 'tests_passing', sha: 'a1', evidence: 'ok', git: { head: 'a1', clean: false } })
    expect(dirty.commands).toEqual([{ do: 'note', pr: 1, note: { kind: 'rejected', why: expect.stringMatching(/uncommitted/) } }])
    const stale = r.send({ type: 'report', pr: 1, kind: 'tests_passing', sha: 'a1', evidence: 'ok', git: { head: 'b2', clean: true } })
    expect(stale.commands[0]).toMatchObject({ note: { kind: 'rejected', why: expect.stringMatching(/HEAD is b2/) } })
    expect(r.pr(1).status).toBe('coding')
  })

  it('sends passing work to a fresh reviewer, on exactly the range it sits on', () => {
    const r = rig()
    r.approve()
    const res = r.pass(1, 'a1')
    expect(res.commands).toContainEqual({ do: 'review', pr: 1, round: 1, range: { base: 'base:origin/develop', head: 'a1' }, recheck: [] })
    // Passing tests make PR 1's interface available, so PR 2 starts on it too.
    expect(jobs(res.commands)).toEqual([{ pr: 2, job: 'code' }])
    expect(r.pr(1)).toMatchObject({ status: 'in-review', reviewing: true, work: 'idle' })
  })

  it('holds the PR on high and medium findings only, each a card of its own', () => {
    const r = rig()
    r.approve()
    r.pass(1, 'a1')
    r.review(1, [{ severity: 'high', file: 'db/x.sql', summary: 'no index' }, { severity: 'nit', summary: 'naming' }])
    expect(r.pr(1).status).toBe('in-review')
    const findings = cardsFor(r.t).filter((c) => c.kind === 'finding')
    expect(findings.map((c) => c.body)).toEqual(['no index\n\nProof: npm test: 1 failed'])
    expect(findings[0]!.actions.map((a) => a.id)).toEqual(['fix', 'skip'])
    expect(r.card('review', 1)!.actions.map((a) => a.id)).toEqual(['fix-all'])
    expect(r.card('push', 1)).toBeUndefined()
  })

  it('holds the PR only on a finding the reviewer showed, and never on one already on the base', () => {
    const r = rig()
    r.approve()
    r.pass(1, 'a1')
    r.review(1, [
      { severity: 'high', summary: 'might race', proof: null },
      { severity: 'medium', file: 'db/legacy.sql', summary: 'the old index is missing', preExisting: true },
    ])
    expect(r.pr(1).status).toBe('review-clean')
    expect(r.pr(1).review!.findings.map((f) => [f.summary, f.holds])).toEqual([['might race', false], ['the old index is missing', false]])
    expect(r.t.followUps).toEqual([{ pr: 1, summary: 'db/legacy.sql: the old index is missing' }])
    expect(r.card('feature')!.body).toMatch(/Follow-ups[\s\S]*CHV-1-1: db\/legacy.sql: the old index is missing/)
  })

  it('needs a reason to skip, and is clean once every held finding is skipped', () => {
    const r = rig()
    r.approve()
    r.pass(1, 'a1')
    r.review(1, [{ severity: 'medium', summary: 'magic number' }])
    expect(r.click('finding', 'skip', { pr: 1 }).notice).toMatch(/needs a reason/)
    r.click('finding', 'skip', { pr: 1, text: 'it is the spec value' })
    expect(r.pr(1).status).toBe('review-clean')
  })

  it('sends Fix to the coder, then has a new reviewer re-check what was fixed', () => {
    const r = rig()
    r.approve()
    r.pass(1, 'a1')
    r.review(1, [{ severity: 'high', summary: 'no index' }])
    const fix = r.click('finding', 'fix', { pr: 1 })
    expect(fix.commands).toEqual([{ do: 'work', pr: 1, newTile: true, job: { kind: 'fix', findings: [expect.objectContaining({ summary: 'no index', resolution: 'fix-requested' })] } }])
    const id = r.pr(1).review!.findings[0]!.id
    r.send({ type: 'headMoved', pr: 1, sha: 'a2' })
    const recheck = r.send({ type: 'resolveFinding', pr: 1, finding: id, outcome: 'fixed', note: 'added the index' })
    expect(recheck.commands).toEqual([{ do: 'review', pr: 1, round: 2, range: { base: 'base:origin/develop', head: 'a2' }, recheck: [expect.objectContaining({ id, resolution: 'fixed' })] }])
    r.review(1)
    expect(r.pr(1).status).toBe('review-clean')
    expect(r.pr(1).review!.findings[0]!.resolution).toBe('verified')
  })

  it('lets the coder decline a finding with its reason, for the next reviewer to weigh', () => {
    const r = rig()
    r.approve()
    r.pass(1, 'a1')
    r.review(1, [{ severity: 'medium', summary: 'unused import' }])
    r.click('finding', 'fix', { pr: 1 })
    const id = r.pr(1).review!.findings[0]!.id
    const res = r.send({ type: 'resolveFinding', pr: 1, finding: id, outcome: 'declined', note: 'it is used by the generated code' })
    expect(res.commands[0]).toMatchObject({ do: 'review', recheck: [{ resolution: { declined: 'it is used by the generated code' } }] })
  })

  it('counts the reviewer\'s own failing test run as a high finding', () => {
    const r = rig()
    r.approve()
    r.pass(1, 'a1')
    r.review(1, [], false)
    expect(r.pr(1).review!.findings).toEqual([expect.objectContaining({ severity: 'high', holds: true, summary: expect.stringMatching(/tests fail/) })])
  })

  it('goes straight to review-clean when fresh reviews are switched off', () => {
    const r = rig({ review: false })
    r.approve()
    const res = r.pass(1, 'a1')
    expect(kinds(res.commands)).not.toContain('review')
    expect(r.pr(1).status).toBe('review-clean')
  })

  it('calls a PR stuck after three review rounds that each bring new held findings', () => {
    const r = rig()
    r.approve()
    r.pass(1, 'a1')
    for (let round = 1; round <= 3; round++) {
      r.review(1, [{ severity: 'high', summary: `problem ${round}` }])
      if (round < 3) {
        r.click('review', 'fix-all', { pr: 1 })
        const f = r.pr(1).review!.findings.find((x) => x.resolution === 'fix-requested')!
        r.send({ type: 'resolveFinding', pr: 1, finding: f.id, outcome: 'fixed', note: 'done' })
      }
    }
    expect(r.card('blocked', 1)!.body).toMatch(/3 review rounds/)
  })

  it('routes a finding in another PR\'s file to that PR, holding both until it is fixed', () => {
    const r = rig()
    r.approve()
    r.clean(1, 'a1')
    r.pass(2, 'b1')
    r.review(2, [{ severity: 'high', file: 'db/orders.sql', summary: 'the API needs a total column' }])
    const f = r.pr(2).review!.findings[0]!
    expect(f.routedTo).toBe(1)
    expect(jobs(r.click('finding', 'fix', { pr: 2 }).commands)).toEqual([{ pr: 1, job: 'fix' }])
    expect(r.send({ type: 'resolveFinding', pr: 2, finding: f.id, outcome: 'fixed', note: 'x' }).notice).toMatch(/is for PR 1/)
    const res = r.send({ type: 'resolveFinding', pr: 1, finding: f.id, outcome: 'fixed', note: 'added total' })
    expect(res.commands).toContainEqual(expect.objectContaining({ do: 'review', pr: 2, round: 2 }))
  })
})

describe('stack engine: restacks', () => {
  function stacked(o: RigOptions = {}) {
    const r = rig(o)
    r.approve()
    r.send({ type: 'report', pr: 1, kind: 'interface_ready' })
    return r
  }

  it('flags the PR above when the one below moves, tells it, and offers the restack', () => {
    const r = stacked()
    const base = r.pr(2).baseSha!
    const res = r.send({ type: 'headMoved', pr: 1, sha: 'a9' })
    expect(res.commands).toEqual([{ do: 'note', pr: 2, note: { kind: 'lowerMoved', lower: 1, from: base, to: 'a9' } }])
    expect(r.pr(2).flags.needsRestack).toBe(true)
    expect(r.card('restack', 2)!.actions.map((a) => a.id)).toEqual(['restack', 'later'])
  })

  it('rebases onto the new head from the old one, and records where it now sits', () => {
    const r = stacked()
    const old = r.pr(2).baseSha!
    r.send({ type: 'headMoved', pr: 1, sha: 'a9' })
    r.send({ type: 'blocked', pr: 2, reason: 'x' })
    r.click('blocked', 'nudge', { pr: 2 })
    const res = r.click('restack', 'restack', { pr: 2 })
    expect(res.commands).toContainEqual({ do: 'work', pr: 2, newTile: true, job: { kind: 'restack', onto: 'feature/CHV-1-1-orders-table', from: old, retarget: null } })
    r.send({ type: 'report', pr: 2, kind: 'restacked', sha: 'b9', evidence: 'ok', git: { head: 'b9', clean: true, diffChanged: false } })
    expect(r.pr(2)).toMatchObject({ baseSha: 'a9', headSha: 'b9', restack: null, flags: expect.objectContaining({ needsRestack: false }) })
  })

  it('carries an approved restack up the lane, one PR at a time', () => {
    const plan = ordersPlan()
    plan.prs.push(planned({ index: 4, below: 2, title: 'Orders export', owns: ['src/export/**'] }))
    const r = stacked({ plan })
    r.send({ type: 'report', pr: 2, kind: 'interface_ready' })
    r.send({ type: 'headMoved', pr: 1, sha: 'a9' })
    r.send({ type: 'blocked', pr: 2, reason: 'x' }); r.click('blocked', 'nudge', { pr: 2 })
    r.click('restack', 'restack', { pr: 2 })
    const up = r.send({ type: 'report', pr: 2, kind: 'restacked', sha: 'b9', evidence: 'ok', git: { head: 'b9', clean: true } })
    expect(r.pr(4).restack).toMatchObject({ approved: true })
    expect(r.card('restack', 4)).toBeUndefined()
    expect(up.commands).toContainEqual(expect.objectContaining({ do: 'note', pr: 4, note: expect.objectContaining({ kind: 'lowerMoved' }) }))
  })

  it('restacks without asking when the setting says so', () => {
    const r = stacked({ restack: 'auto' })
    r.send({ type: 'blocked', pr: 2, reason: 'x' }); r.click('blocked', 'nudge', { pr: 2 })
    const res = r.send({ type: 'headMoved', pr: 1, sha: 'a9' })
    expect(jobs(res.commands)).toEqual([{ pr: 2, job: 'restack' }])
    expect(r.card('restack', 2)).toBeUndefined()
  })

  it('keeps a review across a restack that left the PR\'s own diff alone, and drops it otherwise', () => {
    for (const changed of [false, true]) {
      const r = stacked({ restack: 'auto' })
      r.clean(2, 'b1')
      expect(r.pr(2).status).toBe('review-clean')
      r.send({ type: 'headMoved', pr: 1, sha: 'a9' })
      r.send({ type: 'report', pr: 2, kind: 'restacked', sha: 'b9', evidence: 'ok', git: { head: 'b9', clean: true, diffChanged: changed } })
      expect(r.pr(2).status).toBe(changed ? 'in-review' : 'review-clean')
    }
  })

  it('hides a restack put off until the PR below moves again', () => {
    const r = stacked()
    r.send({ type: 'headMoved', pr: 1, sha: 'a9' })
    r.click('restack', 'later', { pr: 2 })
    expect(r.card('restack', 2)).toBeUndefined()
    r.send({ type: 'headMoved', pr: 1, sha: 'a10' })
    expect(r.card('restack', 2)).toBeDefined()
  })
})

describe('stack engine: when things go wrong', () => {
  it('holds everything waiting on a failing PR at review, and lets it go once it passes', () => {
    const r = rig()
    r.approve()
    r.send({ type: 'report', pr: 1, kind: 'interface_ready' })
    r.send({ type: 'report', pr: 1, kind: 'tests_failing', evidence: '2 failed' })
    expect(r.pr(2).flags.baseFailing).toBe(true)
    expect(kinds(r.pass(2, 'b1').commands)).not.toContain('review')
    const res = r.pass(1, 'a1')
    expect(r.pr(2).flags.baseFailing).toBe(false)
    expect(res.commands.filter((c) => c.do === 'review').map((c) => (c as { pr: number }).pr)).toEqual([1, 2])
  })

  it('puts a blocked PR on a card: nudge it, give it a fresh context, or pause it', () => {
    const r = rig()
    r.approve()
    r.send({ type: 'blocked', pr: 1, reason: 'conflict in src/app.ts, which PR 2 owns' })
    expect(r.card('blocked', 1)!.body).toMatch(/conflict/)
    expect(r.click('blocked', 'nudge', { pr: 1 }).commands).toContainEqual({ do: 'note', pr: 1, note: { kind: 'nudge' } })
    r.send({ type: 'blocked', pr: 1, reason: 'again' })
    expect(r.click('blocked', 'fresh', { pr: 1 }).commands).toContainEqual({ do: 'freshCoder', pr: 1 })
  })

  it('calls a working agent stuck after ten quiet minutes, and not before', () => {
    const r = rig()
    r.approve()
    r.advance(STUCK_MS - 1000)
    r.send({ type: 'tick' })
    expect(r.card('blocked', 1)).toBeUndefined()
    r.send({ type: 'activity', pr: 1 })
    r.advance(STUCK_MS + 1000)
    r.send({ type: 'tick' })
    expect(r.card('blocked', 1)!.body).toMatch(/no activity/)
  })
})

describe('stack engine: lanes, pushes and merges', () => {
  /** PR 1 and 2 review-clean; PR 3 waits on PR 2's interface and is clean too. */
  function allClean(o: RigOptions = {}) {
    const r = rig(o)
    r.approve()
    r.clean(1, 'a1')
    r.clean(2, 'b1')
    r.clean(3, 'c1')
    return r
  }

  it('tests each repo\'s units together once every one is clean: its base with each lane\'s top merged in', () => {
    const r = rig()
    r.approve()
    r.clean(1, 'a1')
    r.clean(2, 'b1')
    // api is clean through its top (PR 2); web's only unit is still being written.
    expect(r.t.integration['api']).toMatchObject({ status: 'running', tips: { 2: 'b1' } })
    expect(r.t.integration['web']).toBeUndefined()
    r.send({ type: 'report', pr: 3, kind: 'interface_ready' })
    r.pass(3, 'c1')
    expect(kinds(r.review(3).commands)).toContain('integrate')
    expect(r.t.integration['web']).toMatchObject({ status: 'running', tips: { 3: 'c1' } })
    expect(r.t.phase).toBe('integrating')
    expect(r.card('push', 1)).toBeUndefined()
  })

  it('sends the integrate command with each tip\'s branch and head, and counts the integrator as an agent', () => {
    const r = rig({ maxAgents: 4 })
    r.approve()
    r.clean(1, 'a1')
    const res = (() => { r.send({ type: 'report', pr: 2, kind: 'interface_ready' }); r.pass(2, 'b1'); return r.review(2) })()
    expect(res.commands).toContainEqual({ do: 'integrate', repo: 'api', tips: [{ unit: 2, branch: 'feature/CHV-1-2-orders-api', sha: 'b1' }] })
  })

  it('takes the integrator\'s verdict only for the merge it was given', () => {
    const r = allClean()
    r.send({ type: 'integration', repo: 'api', result: { status: 'merged', sha: 'm1', base: 'b0' } })
    expect(r.send({ type: 'integration', repo: 'api', result: { status: 'passing', sha: 'old', evidence: 'ok' } }).notice).toMatch(/not old/)
    r.send({ type: 'integration', repo: 'api', result: { status: 'passing', sha: 'm1', evidence: 'ok' } })
    expect(r.t.integration['api']!.status).toBe('passing')
    expect(r.card('push', 1)).toBeDefined()
  })

  it('on a failure, sends it to the unit the user picks, whose fix is reviewed and tested together again', () => {
    const r = allClean()
    r.integrate('api', 'failing', 'orders.e2e: 2 failed')
    const card = r.card('integration')!
    expect(card.body).toContain('orders.e2e: 2 failed')
    expect(card.actions.map((a) => a.id)).toEqual(['route:1', 'route:2', 'retry', 'accept'])
    expect(r.card('push', 1)).toBeUndefined()
    const res = r.click('integration', 'route:2')
    expect(jobs(res.commands)).toEqual([{ pr: 2, job: 'fix' }])
    expect(r.pr(2).status).toBe('in-review')
    expect(r.t.integration['api']!.status).toBe('waiting')
    r.send({ type: 'resolveFinding', pr: 2, finding: '2.i1', outcome: 'fixed', note: 'fixed the join' })
    r.pass(2, 'b2')
    r.review(2)
    expect(r.t.integration['api']).toMatchObject({ status: 'running', tips: { 2: 'b2' } })
  })

  it('runs a check again, or accepts a failure with a reason', () => {
    const r = allClean()
    r.integrate('api', 'failing')
    expect(kinds(r.click('integration', 'retry').commands)).toContain('integrate')
    r.integrate('api', 'failing')
    expect(r.click('integration', 'accept').notice).toMatch(/needs a reason/)
    r.click('integration', 'accept', { text: 'flaky e2e, tracked in CHV-10' })
    expect(r.t.integration['api']).toMatchObject({ status: 'passing', evidence: expect.stringMatching(/flaky e2e/) })
    expect(r.card('push', 1)).toBeDefined()
  })

  it('names a conflict between units, and runs it again on request', () => {
    const r = allClean()
    r.send({ type: 'integration', repo: 'api', result: { status: 'conflict', units: [1, 2], files: ['package-lock.json'] } })
    const card = r.card('integration')!
    expect(card.title).toMatch(/CHV-1-1 and CHV-1-2 conflict/)
    expect(card.body).toContain('package-lock.json')
    expect(kinds(r.click('integration', 'retry').commands)).toContain('integrate')
  })

  it('tests again when the base moves, and after any head moves', () => {
    const r = allClean()
    r.integrate('api')
    expect(kinds(r.send({ type: 'baseMoved', repo: 'api', commits: 2, conflict: false }).commands)).toContain('integrate')
    r.integrate('api')
    r.send({ type: 'headMoved', pr: 2, sha: 'b9' })
    expect(r.card('push', 1)).toBeUndefined()
  })

  it('pushes without it when the integration check is off', () => {
    const r = allClean({ integration: false })
    expect(r.t.integration).toEqual({})
    expect(r.card('push', 1)).toBeDefined()
    expect(checklist(r.t)).not.toHaveProperty('tested together')
  })

  it('offers a push bottom up once the lane passes, and lets exactly that push through', () => {
    const r = allClean()
    r.integrate('api')
    expect(r.card('push', 1)).toBeDefined()
    expect(r.card('push', 2)).toBeUndefined()
    const push = r.click('push', 'push', { pr: 1 })
    expect(push.commands).toContainEqual({ do: 'work', pr: 1, newTile: true, job: { kind: 'push', base: 'develop' } })
    expect(r.pr(1).pushAllowed).toBe(true)
    const pushed = r.send({ type: 'report', pr: 1, kind: 'pushed', url: 'https://github.com/o/r/pull/1' })
    expect(pushed.commands).toContainEqual({ do: 'closeCoder', pr: 1 })
    expect(r.pr(1)).toMatchObject({ status: 'pushed', pushAllowed: false, prUrl: 'https://github.com/o/r/pull/1' })
    expect(r.card('push', 2)).toBeDefined()
  })

  it('pushes a whole lane in order from the feature card', () => {
    const r = allClean()
    r.integrate('api')
    const res = r.click('feature', 'push-stack:1')
    expect(jobs(res.commands)).toEqual([{ pr: 1, job: 'push' }])
    const next = r.send({ type: 'report', pr: 1, kind: 'pushed', url: 'u1' })
    expect(next.commands).toContainEqual({ do: 'work', pr: 2, newTile: true, job: { kind: 'push', base: 'feature/CHV-1-1-orders-table' } })
  })

  it('will not push a lane that would conflict with its moved base, and offers to update it', () => {
    const r = allClean()
    r.integrate('api')
    r.send({ type: 'baseMoved', repo: 'api', commits: 3, conflict: true })
    expect(r.card('push', 1)).toBeUndefined()
    const res = r.click('feature', 'update:api')
    expect(res.commands).toContainEqual(expect.objectContaining({ do: 'work', pr: 1, job: expect.objectContaining({ kind: 'restack', onto: 'origin/develop' }) }))
  })

  it('after a merge restacks the PR above onto the base and retargets its PR; all merged is done', () => {
    const r = allClean({ restack: 'auto' })
    r.integrate('api')
    r.click('feature', 'push-stack:1')
    r.send({ type: 'report', pr: 1, kind: 'pushed', url: 'u1' })
    r.send({ type: 'report', pr: 2, kind: 'pushed', url: 'u2' })
    const merged = r.click('feature', 'merged:1')
    expect(merged.commands).toContainEqual({ do: 'work', pr: 2, newTile: true, job: { kind: 'restack', onto: 'origin/develop', from: 'a1', retarget: 'develop' } })
    r.send({ type: 'merged', pr: 2 })
    expect(r.t.phase).not.toBe('done')
    r.send({ type: 'merged', pr: 3 })
    expect(r.t.phase).toBe('done')
  })

  it('asks before pushing a pushed PR\'s restacked branch, then pushes it to the same PR', () => {
    const r = allClean({ restack: 'auto' })
    r.integrate('api')
    r.click('feature', 'push-stack:1')
    r.send({ type: 'report', pr: 1, kind: 'pushed', url: 'u1' })
    r.send({ type: 'report', pr: 2, kind: 'pushed', url: 'u2' })
    r.click('feature', 'merged:1')
    expect(r.card('push', 2)).toBeUndefined()
    r.send({ type: 'report', pr: 2, kind: 'restacked', sha: 'b2', evidence: 'ok', git: { head: 'b2', clean: true, diffChanged: false } })
    // The rebased branch is tested on the new base before it may be pushed.
    expect(r.card('push', 2)).toBeUndefined()
    r.integrate('api')
    const card = r.card('push', 2)!
    expect(card.title).toMatch(/rebased branch/)
    const push = r.click('push', 'push', { pr: 2 })
    expect(push.commands).toContainEqual({ do: 'work', pr: 2, newTile: true, job: { kind: 'push', base: 'develop' } })
    r.send({ type: 'report', pr: 2, kind: 'pushed', url: 'u2' })
    expect(r.pr(2)).toMatchObject({ status: 'pushed', prUrl: 'u2', pushAllowed: false, flags: expect.objectContaining({ repush: false }) })
    expect(r.card('push', 2)).toBeUndefined()
  })

  it('logs a PR left to open by hand as such', () => {
    const r = allClean()
    r.integrate('api')
    r.click('push', 'push', { pr: 1 })
    r.send({ type: 'report', pr: 1, kind: 'pushed', url: 'https://bitbucket.org/w/r/pull-requests/new?source=x', byHand: true })
    expect(r.t.log.at(-1)!.text).toMatch(/open its PR by hand/)
  })

  it('changes an interface only when the user agrees, and tells every PR that uses it', () => {
    const r = rig()
    r.approve()
    r.send({ type: 'amendInterface', pr: 1, name: 'OrdersTable', contract: 'orders(id, total, currency)', why: 'multi-currency' })
    const res = r.click('amendment', 'approve', { pr: 1 })
    expect(r.t.plan!.interfaces[0]!.contract).toBe('orders(id, total, currency)')
    expect(r.t.plan!.version).toBe(2)
    expect(res.commands).toContainEqual({ do: 'note', pr: 2, note: { kind: 'interfaceChanged', name: 'OrdersTable', contract: 'orders(id, total, currency)' } })
  })

  it('ticks the checklist as the stack gets there', () => {
    const r = allClean()
    expect(checklist(r.t)).toEqual({
      'tests written': true, 'tests passing': true, 'review clean': true, 'docs updated': true, 'tested together': null, 'CI green': null,
    })
  })

  it('stops everything on cancel, and takes no events after', () => {
    const r = rig()
    r.approve()
    expect(r.click('feature', 'cancel').commands).toEqual([{ do: 'closeAll' }])
    expect(r.t.phase).toBe('abandoned')
    expect(r.send({ type: 'report', pr: 1, kind: 'interface_ready' }).notice).toMatch(/abandoned/)
  })
})

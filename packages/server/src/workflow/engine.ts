import {
  clampAgents, type Finding, type FindingSeverity, type PlannedPr, type PrStatus, type StackPr, type Ticket,
  type TicketRepo, type WorkflowSettings,
} from '@tring/shared/workflow'
import { matches, validatePlan } from './plan.ts'

/**
 * The stack engine: every rule of the multi-PR workflow, as a pure function.
 *
 *   step(ticket, event, env) -> { ticket, commands, notice }
 *
 * Events are what happened — a plan submitted, a coder's report, a review, a
 * card action, a branch head that moved, the clock. Commands are what should
 * happen next, for the tile layer to carry out: start a coder in a new
 * worktree, prompt it, start a fresh reviewer, close a tile. The engine runs
 * nothing, reads no git and touches no file, so every gate here is a plain
 * function of its inputs (and tested as one).
 *
 * The cards a ticket shows are derived from it (cardsFor), never stored: an
 * action is valid exactly when the cards the ticket shows now still offer it,
 * so a button pressed on a phone after the same thing was done on the desktop
 * is refused instead of acting twice.
 */

/* ---------- inputs ---------- */

/** What git said about a worktree when an agent reported, checked by the caller (pure git, no LLM). */
export interface GitCheck {
  head: string
  clean: boolean
  /** restacked only: whether the PR's own diff changed (git range-diff). */
  diffChanged?: boolean
}

export interface ReviewFinding {
  severity: FindingSeverity
  file: string | null
  line: number | null
  summary: string
}

export type EngineEvent =
  | { type: 'start' }
  | { type: 'planSubmitted'; plan: unknown; addedRepos?: TicketRepo[] }
  | { type: 'action'; cardId: string; action: string; text?: string; value?: number }
  | { type: 'worktree'; pr: number; path: string; baseSha: string }
  | { type: 'report'; pr: number; kind: 'interface_ready' }
  | { type: 'report'; pr: number; kind: 'tests_passing' | 'restacked' | 'lane_passing'; sha: string; evidence: string; git: GitCheck }
  | { type: 'report'; pr: number; kind: 'tests_failing' | 'lane_failing'; evidence: string }
  /** byHand: tring could not open the PR, and url is the link for the user to open it. */
  | { type: 'report'; pr: number; kind: 'pushed'; url: string; byHand?: boolean }
  | { type: 'blocked'; pr: number; reason: string }
  | { type: 'resolveFinding'; pr: number; finding: string; outcome: 'fixed' | 'declined'; note: string }
  | { type: 'review'; pr: number; findings: ReviewFinding[]; testsPassed: boolean; evidence: string; range: { base: string; head: string } }
  | { type: 'requestChange'; from: number; to: number; what: string }
  | { type: 'amendInterface'; pr: number; name: string; contract: string; why: string }
  | { type: 'tell'; pr: number; text: string }
  | { type: 'headMoved'; pr: number; sha: string }
  | { type: 'baseMoved'; repo: string; commits: number; conflict: boolean }
  | { type: 'merged'; pr: number }
  | { type: 'tileClosed'; role: 'coder'; pr: number }
  | { type: 'activity'; pr: number }
  | { type: 'tick' }

export interface EngineEnv {
  now: number
  settings: Pick<WorkflowSettings, 'requireFreshReview' | 'autoRestack'>
  /** Claude usage is past 90 %: no new agent starts. */
  quotaHigh: boolean
  repoIdForPath: (path: string) => string
  /** The branch for a PR, named like the repo's own; a default otherwise. */
  branchFor?: (t: Ticket, p: PlannedPr) => string
}

/* ---------- outputs ---------- */

/** One piece of work for a PR's coder: the tile layer opens (or reopens) its tile and prompts it. */
export type Job =
  | { kind: 'code' }
  | { kind: 'fix'; findings: Finding[] }
  /** Rebase onto `onto` from `from` (the old base), run its tests, report restacked; retarget its PR when `retarget`. */
  | { kind: 'restack'; onto: string; from: string; retarget: string | null }
  | { kind: 'checkLane'; prs: number[] }
  | { kind: 'push'; base: string }

/** A message for an agent that is not a piece of work: delivered when it is next idle. */
export type Note =
  | { kind: 'planErrors'; errors: string[] }
  | { kind: 'revise'; text: string }
  | { kind: 'rejected'; why: string }
  | { kind: 'lowerMoved'; lower: number; from: string; to: string }
  | { kind: 'nudge' }
  | { kind: 'tell'; text: string }
  | { kind: 'changeRequest'; from: number; what: string }
  | { kind: 'interfaceChanged'; name: string; contract: string }
  | { kind: 'amendRejected'; name: string }

export type Command =
  | { do: 'startPlanner' }
  | { do: 'closePlanner' }
  | { do: 'notePlanner'; note: Note }
  /** Before a PR's first work: its worktree, branched from `from` as it is now. */
  | { do: 'createWorktree'; pr: number; repo: string; branch: string; from: string }
  | { do: 'work'; pr: number; job: Job; newTile: boolean }
  | { do: 'note'; pr: number; note: Note }
  /** A fresh reviewer tile; `recheck` lists what the last round's coder fixed or declined. */
  | { do: 'review'; pr: number; round: number; range: { base: string; head: string }; recheck: Finding[] }
  | { do: 'closeCoder'; pr: number }
  /** The coder's tile again, with a fresh conversation and its brief. */
  | { do: 'freshCoder'; pr: number }
  | { do: 'closeAll' }

export interface StepResult {
  ticket: Ticket
  commands: Command[]
  /** Why the event changed nothing, for whoever sent it. */
  notice: string | null
}

/** Busy with no hooks or reports for this long counts as stuck. */
export const STUCK_MS = 10 * 60_000
/** Review rounds in a row that each bring new held findings before the PR counts as stuck. */
export const MAX_HELD_ROUNDS = 3

const RANK: Record<PrStatus, number> = {
  planned: 0, coding: 1, 'tests-passing': 2, 'in-review': 3, 'review-clean': 4, pushed: 5, merged: 6,
}
const atLeast = (pr: StackPr, s: PrStatus): boolean => RANK[pr.status] >= RANK[s]

/* ---------- the step ---------- */

export function step(ticket: Ticket, event: EngineEvent, env: EngineEnv): StepResult {
  const t = structuredClone(ticket)
  const out: Command[] = []
  const notice = apply(t, event, env, out)
  if (notice === null) {
    settle(t)
    schedule(t, env, out)
  }
  return { ticket: notice === null ? t : ticket, commands: notice === null ? out : [], notice }
}

/** Mutates `t` for one event and adds commands; a string means "refused, nothing changed". */
function apply(t: Ticket, e: EngineEvent, env: EngineEnv, out: Command[]): string | null {
  if ((t.phase === 'abandoned' || t.phase === 'done') && e.type !== 'tick') {
    return e.type === 'action' && e.action === 'cleanup' ? 'clean up from its dialog' : `the ticket is ${t.phase}`
  }
  switch (e.type) {
    case 'start':
      if (t.phase !== 'planning' || t.plan) return 'the ticket has already started'
      log(t, env, null, 'tring', 'started the planner')
      out.push({ do: 'startPlanner' })
      return null

    case 'planSubmitted': {
      if (t.phase !== 'planning') return 'the plan is already submitted; wait for the user'
      const repos = [...t.repos, ...(e.addedRepos ?? []).filter((r) => !t.repos.some((x) => x.id === r.id))]
      const r = validatePlan(e.plan, { repos, repoIdForPath: env.repoIdForPath })
      if (!r.ok) {
        t.planErrors = r.errors
        out.push({ do: 'notePlanner', note: { kind: 'planErrors', errors: r.errors } })
        log(t, env, null, 'planner', `submitted a plan with ${r.errors.length} problem(s)`)
        return null
      }
      t.repos = repos
      t.plan = { ...r.plan, version: (t.plan?.version ?? 0) + 1 }
      t.planErrors = []
      t.phase = 'awaiting-approval'
      log(t, env, null, 'planner', `submitted plan v${t.plan.version}: ${t.plan.prs.length} PR(s)`)
      return null
    }

    case 'action':
      return act(t, e, env, out)

    case 'worktree': {
      const pr = prOf(t, e.pr)
      if (!pr) return `no PR ${e.pr}`
      pr.worktree = e.path
      pr.baseSha = e.baseSha
      pr.headSha = e.baseSha
      return null
    }

    case 'report': return report(t, e, env, out)

    case 'blocked': {
      const pr = prOf(t, e.pr)
      if (!pr) return `no PR ${e.pr}`
      pr.flags.blocked = e.reason
      pr.work = 'idle'
      pr.lastActivity = env.now
      log(t, env, pr.index, 'coder', `blocked: ${e.reason}`)
      return null
    }

    case 'resolveFinding': {
      const owner = prOf(t, e.pr)
      const found = findFinding(t, e.finding)
      if (!owner || !found) return `no finding ${e.finding}`
      const { f, pr } = found
      if ((f.routedTo ?? pr.index) !== owner.index) return `finding ${e.finding} is for PR ${f.routedTo ?? pr.index}`
      if (f.resolution !== 'fix-requested') return `finding ${e.finding} was not sent for fixing`
      f.resolution = e.outcome === 'fixed' ? 'fixed' : { declined: e.note.trim() || 'no reason given' }
      owner.lastActivity = env.now
      log(t, env, owner.index, 'coder', `${e.outcome} ${f.id}: ${e.note}`)
      if (!fixRequestsFor(t, owner.index).length && owner.work === 'fixing') owner.work = 'idle'
      return null
    }

    case 'review': return review(t, e, env, out)

    case 'requestChange': {
      if (!prOf(t, e.to) || !prOf(t, e.from)) return 'no such PR'
      log(t, env, e.to, 'coder', `PR ${e.from} asks: ${e.what}`)
      out.push({ do: 'note', pr: e.to, note: { kind: 'changeRequest', from: e.from, what: e.what } })
      return null
    }

    case 'amendInterface': {
      const i = t.plan?.interfaces.find((x) => x.name === e.name)
      if (!i) return `no interface ${e.name}`
      if (i.owner !== e.pr) return `PR ${e.pr} does not own ${e.name}`
      t.amendments.push({ id: `${e.name}#${t.amendments.length + 1}`, pr: e.pr, name: e.name, contract: e.contract, why: e.why })
      log(t, env, e.pr, 'coder', `asks to change ${e.name}: ${e.why}`)
      return null
    }

    case 'tell': {
      if (!prOf(t, e.pr)) return `no PR ${e.pr}`
      log(t, env, e.pr, 'user', `told: ${e.text}`)
      out.push({ do: 'note', pr: e.pr, note: { kind: 'tell', text: e.text } })
      return null
    }

    case 'headMoved': {
      const pr = prOf(t, e.pr)
      if (!pr) return `no PR ${e.pr}`
      if (pr.headSha === e.sha) return 'unchanged'
      moved(t, pr, e.sha, false, env, out)
      return null
    }

    case 'baseMoved':
      t.baseMoved[e.repo] = { commits: e.commits, conflict: e.conflict }
      return null

    case 'merged': {
      const pr = prOf(t, e.pr)
      if (!pr) return `no PR ${e.pr}`
      if (pr.status === 'merged') return 'already merged'
      pr.status = 'merged'
      pr.work = 'idle'
      log(t, env, pr.index, 'user', 'merged')
      if (pr.coder) out.push({ do: 'closeCoder', pr: pr.index })
      for (const c of childrenOf(t, pr.index)) {
        if (c.status === 'merged' || !c.worktree) continue
        c.restack = { from: pr.headSha ?? c.baseSha ?? '', approved: env.settings.autoRestack === 'auto', deferred: false }
      }
      if (t.prs.every((p) => p.status === 'merged')) {
        t.phase = 'done'
        out.push({ do: 'closeAll' })
      }
      return null
    }

    case 'tileClosed': {
      const pr = prOf(t, e.pr)
      if (!pr) return `no PR ${e.pr}`
      pr.coder = null
      if (pr.work !== 'idle') pr.work = 'idle'
      return null
    }

    case 'activity': {
      const pr = prOf(t, e.pr)
      if (!pr) return `no PR ${e.pr}`
      pr.lastActivity = env.now
      return null
    }

    case 'tick':
      for (const pr of t.prs) {
        const busy = pr.work !== 'idle' || pr.reviewing
        if (busy && !pr.flags.blocked && env.now - pr.lastActivity > STUCK_MS) {
          pr.flags.blocked = `no activity for ${Math.round(STUCK_MS / 60_000)} minutes`
          log(t, env, pr.index, 'tring', pr.flags.blocked)
        }
      }
      return null
  }
}

function report(t: Ticket, e: Extract<EngineEvent, { type: 'report' }>, env: EngineEnv, out: Command[]): string | null {
  const pr = prOf(t, e.pr)
  if (!pr) return `no PR ${e.pr}`
  pr.lastActivity = env.now

  const verified = (r: { sha: string; git: GitCheck }): string | null => {
    if (!r.git.clean) return 'the worktree has uncommitted changes: commit them, run the tests again and report on that commit'
    if (r.git.head !== r.sha) return `you reported on ${r.sha.slice(0, 8)}, but HEAD is ${r.git.head.slice(0, 8)}: run the tests on HEAD and report that`
    return null
  }
  const reject = (why: string): null => {
    out.push({ do: 'note', pr: pr.index, note: { kind: 'rejected', why } })
    log(t, env, pr.index, 'tring', `rejected a report: ${why}`)
    return null
  }

  switch (e.kind) {
    case 'interface_ready':
      pr.flags.interfaceReady = true
      log(t, env, pr.index, 'coder', 'interface ready')
      return null

    case 'tests_passing': {
      const why = verified(e)
      if (why) return reject(why)
      pr.headSha = e.git.head
      pr.flags.failing = false
      if (pr.work === 'coding') pr.work = 'idle'
      if (pr.status === 'planned' || pr.status === 'coding') {
        pr.status = env.settings.requireFreshReview ? 'tests-passing' : 'review-clean'
      }
      log(t, env, pr.index, 'coder', `tests pass on ${e.sha.slice(0, 8)}: ${e.evidence}`)
      return null
    }

    case 'tests_failing':
    case 'lane_failing':
      pr.flags.failing = e.kind === 'tests_failing'
      if (e.kind === 'lane_failing') pr.flags.blocked = `the whole lane's tests fail: ${e.evidence}`
      if (e.kind === 'tests_failing' && atLeast(pr, 'tests-passing') && pr.status !== 'pushed' && pr.status !== 'merged') {
        pr.status = 'coding'
        pr.work = 'coding'
        pr.review = null
      }
      if (pr.work === 'checking-lane') pr.work = 'idle'
      log(t, env, pr.index, 'coder', `${e.kind === 'lane_failing' ? 'lane' : 'tests'} failing: ${e.evidence}`)
      return null

    case 'restacked': {
      if (pr.work !== 'restacking' || !pr.restack) return 'no restack was asked for'
      const why = verified(e)
      if (why) return reject(why)
      const parent = parentOf(t, pr)
      pr.baseSha = parent ? parent.headSha : null
      pr.restack = null
      pr.work = 'idle'
      if (e.git.diffChanged && atLeast(pr, 'tests-passing') && !atLeast(pr, 'pushed')) {
        // Its own change is different now, so its review no longer holds.
        pr.status = env.settings.requireFreshReview ? 'tests-passing' : 'review-clean'
        pr.review = null
      }
      log(t, env, pr.index, 'coder', `restacked to ${e.git.head.slice(0, 8)}${e.git.diffChanged ? ' (its diff changed)' : ''}: ${e.evidence}`)
      if (pr.status === 'pushed' && pr.headSha !== e.git.head) pr.flags.repush = true
      if (pr.headSha !== e.git.head) moved(t, pr, e.git.head, true, env, out)
      return null
    }

    case 'lane_passing': {
      if (pr.work !== 'checking-lane') return 'no lane check was asked for'
      const why = verified(e)
      if (why) return reject(why)
      if (pr.headSha !== e.git.head) return reject('the lane moved while it was checked; check it again')
      t.laneChecks[pr.index] = e.git.head
      pr.work = 'idle'
      log(t, env, pr.index, 'coder', `the whole lane passes on ${e.sha.slice(0, 8)}: ${e.evidence}`)
      return null
    }

    case 'pushed':
      if (pr.work !== 'pushing') return 'no push was asked for'
      pr.status = 'pushed'
      pr.prUrl = e.url
      pr.pushAllowed = false
      pr.work = 'idle'
      pr.flags.repush = false
      log(t, env, pr.index, 'coder', e.byHand ? `pushed; tring could not open its PR, so open its PR by hand: ${e.url}` : `pushed: ${e.url}`)
      out.push({ do: 'closeCoder', pr: pr.index })
      return null
  }
}

function review(t: Ticket, e: Extract<EngineEvent, { type: 'review' }>, env: EngineEnv, _out: Command[]): string | null {
  const pr = prOf(t, e.pr)
  if (!pr) return `no PR ${e.pr}`
  if (!pr.reviewing) return 'no review was asked for'
  pr.reviewing = false
  pr.lastActivity = env.now
  const round = (pr.review?.round ?? 0) + 1
  // What the last round's coder fixed or declined and this round did not raise again stands.
  const kept = (pr.review?.findings ?? []).map((f) => {
    const r = f.resolution
    return r === 'fixed' || (typeof r === 'object' && 'declined' in r) ? { ...f, resolution: 'verified' as const } : f
  })
  const fresh: Finding[] = e.findings.map((f, n) => ({
    id: `${pr.index}.${round}.${n + 1}`,
    severity: f.severity,
    file: f.file,
    line: f.line,
    summary: f.summary,
    holds: f.severity === 'high' || f.severity === 'medium',
    resolution: 'open',
    routedTo: ownerOf(t, pr, f.file),
  }))
  if (!e.testsPassed) {
    fresh.push({
      id: `${pr.index}.${round}.tests`, severity: 'high', file: null, line: null,
      summary: `The PR's tests fail when the reviewer runs them: ${e.evidence}`, holds: true, resolution: 'open', routedTo: null,
    })
  }
  pr.review = { round, reviewer: null, range: e.range, findings: [...kept, ...fresh] }
  const held = fresh.filter((f) => f.holds)
  pr.heldRounds = held.length ? pr.heldRounds + 1 : 0
  pr.status = held.length ? 'in-review' : 'review-clean'
  if (pr.heldRounds >= MAX_HELD_ROUNDS) {
    pr.flags.blocked = `${MAX_HELD_ROUNDS} review rounds in a row brought new held findings`
  }
  log(t, env, pr.index, 'reviewer', `round ${round}: ${held.length} held, ${fresh.length - held.length} advisory finding(s)`)
  return null
}

/** A head moved: the PRs on it need a restack. `cascade`: it moved because the user's restack reached it. */
function moved(t: Ticket, pr: StackPr, sha: string, cascade: boolean, env: EngineEnv, out: Command[]): void {
  const from = pr.headSha
  pr.headSha = sha
  for (const c of childrenOf(t, pr.index)) {
    if (c.status === 'merged' || !c.worktree || !c.baseSha || c.baseSha === sha) continue
    const approved = cascade || env.settings.autoRestack === 'auto' || !!c.restack?.approved
    c.restack = { from: c.restack?.from ?? c.baseSha, approved, deferred: false }
    if (from) out.push({ do: 'note', pr: c.index, note: { kind: 'lowerMoved', lower: pr.index, from, to: sha } })
  }
}

/* ---------- card actions ---------- */

function act(t: Ticket, e: Extract<EngineEvent, { type: 'action' }>, env: EngineEnv, out: Command[]): string | null {
  const card = cardsFor(t).find((c) => c.id === e.cardId)
  const action = card?.actions.find((a) => a.id === e.action)
  if (!card || !action) return 'that card or button is no longer current'
  if (action.needsText && !e.text?.trim()) return `${action.label} needs a reason`
  const text = e.text?.trim() ?? ''
  const pr = card.prIndex !== undefined ? prOf(t, card.prIndex) : undefined
  const [verb, arg] = e.action.split(':') as [string, string | undefined]
  const argPr = arg !== undefined ? prOf(t, Number(arg)) : undefined

  switch (verb) {
    case 'approve':
      if (card.kind === 'amendment') return amend(t, card.amendment!, true, env, out)
      return approvePlan(t, env, out)
    case 'reject':
      return amend(t, card.amendment!, false, env, out)
    case 'revise':
      t.phase = 'planning'
      log(t, env, null, 'user', `asked for changes to the plan: ${text}`)
      out.push({ do: 'notePlanner', note: { kind: 'revise', text } })
      return null
    case 'cancel':
      t.phase = 'abandoned'
      log(t, env, null, 'user', 'cancelled the ticket')
      out.push({ do: 'closeAll' })
      return null
    case 'agents':
      if (typeof e.value !== 'number' || !Number.isFinite(e.value)) return 'say how many agents'
      t.maxAgents = clampAgents(e.value)
      log(t, env, null, 'user', `set agents to ${t.maxAgents}`)
      return null
    case 'fix': {
      const f = findFinding(t, card.findingId!)!.f
      f.resolution = 'fix-requested'
      log(t, env, pr!.index, 'user', `fix ${f.id}`)
      return null
    }
    case 'skip': {
      const f = findFinding(t, card.findingId!)!.f
      f.resolution = { skipped: text }
      log(t, env, pr!.index, 'user', `skipped ${f.id}: ${text}`)
      return null
    }
    case 'fix-all':
      for (const f of openHeld(pr!)) f.resolution = 'fix-requested'
      log(t, env, pr!.index, 'user', 'fix all held findings')
      return null
    case 'restack':
      pr!.restack!.approved = true
      log(t, env, pr!.index, 'user', 'restack')
      return null
    case 'later':
      pr!.restack!.deferred = true
      return null
    case 'nudge':
      pr!.flags.blocked = null
      pr!.heldRounds = 0
      pr!.lastActivity = env.now
      out.push({ do: 'note', pr: pr!.index, note: { kind: 'nudge' } })
      return null
    case 'fresh':
      pr!.flags.blocked = null
      pr!.heldRounds = 0
      pr!.lastActivity = env.now
      out.push({ do: 'freshCoder', pr: pr!.index })
      return null
    case 'pause':
      pr!.flags.blocked = null
      pr!.paused = true
      return null
    case 'resume':
      argPr!.paused = false
      argPr!.lastActivity = env.now
      return null
    case 'push':
      pr!.pushAllowed = true
      log(t, env, pr!.index, 'user', 'push and open the PR')
      return null
    case 'push-stack':
      for (const p of lanePrs(t, Number(arg))) if (!atLeast(p, 'pushed') || p.flags.repush) p.pushAllowed = true
      log(t, env, null, 'user', `push the stack from PR ${arg}`)
      return null
    case 'merged':
      return apply(t, { type: 'merged', pr: Number(arg) }, env, out)
    case 'update': {
      const repo = arg!
      for (const root of t.prs.filter((p) => plannedOf(t, p)?.repo === repo && parentOf(t, p) === null)) {
        if (root.status === 'merged' || !root.worktree || !root.baseSha) continue
        root.restack = { from: root.baseSha, approved: true, deferred: false }
      }
      t.baseMoved[repo] = { commits: 0, conflict: false }
      log(t, env, null, 'user', `update the lanes in ${repo} from their base`)
      return null
    }
  }
  return `unknown action ${e.action}`
}

function approvePlan(t: Ticket, env: EngineEnv, out: Command[]): string | null {
  const plan = t.plan!
  t.phase = 'building'
  t.prs = plan.prs.map((p) => ({
    index: p.index,
    branch: env.branchFor?.(t, p) ?? defaultBranch(t, p),
    worktree: null,
    status: 'planned',
    work: 'idle',
    reviewing: false,
    paused: false,
    restack: null,
    pushAllowed: false,
    lastActivity: env.now,
    heldRounds: 0,
    coder: null,
    coderConversation: null,
    flags: { needsRestack: false, baseFailing: false, blocked: null, interfaceReady: false, failing: false },
    baseSha: null,
    headSha: null,
    review: null,
    prUrl: null,
  }))
  log(t, env, null, 'user', `approved plan v${plan.version}`)
  out.push({ do: 'closePlanner' })
  return null
}

function amend(t: Ticket, id: string, yes: boolean, env: EngineEnv, out: Command[]): string | null {
  const a = t.amendments.find((x) => x.id === id)!
  t.amendments = t.amendments.filter((x) => x.id !== id)
  if (!yes) {
    out.push({ do: 'note', pr: a.pr, note: { kind: 'amendRejected', name: a.name } })
    log(t, env, a.pr, 'user', `kept ${a.name} as planned`)
    return null
  }
  const i = t.plan!.interfaces.find((x) => x.name === a.name)!
  i.contract = a.contract
  t.plan!.version++
  log(t, env, a.pr, 'user', `changed ${a.name}: ${a.contract}`)
  for (const user of t.plan!.prs.filter((p) => p.uses.includes(a.name))) {
    out.push({ do: 'note', pr: user.index, note: { kind: 'interfaceChanged', name: a.name, contract: a.contract } })
  }
  return null
}

/* ---------- after every event ---------- */

/** Derived flags, recomputed so they can never drift from what they are derived from. */
function settle(t: Ticket): void {
  const failing = new Set(t.prs.filter((p) => p.flags.failing).map((p) => p.index))
  for (const pr of t.prs) {
    pr.flags.needsRestack = !!pr.restack
    pr.flags.baseFailing = upstream(t, pr.index).some((i) => failing.has(i))
  }
  if (t.phase === 'building' && t.prs.length && t.prs.every((p) => atLeast(p, 'review-clean'))) t.phase = 'integrating'
  else if (t.phase === 'integrating' && t.prs.some((p) => !atLeast(p, 'review-clean'))) t.phase = 'building'
}

/** How many of this ticket's agents are working now. */
export function working(t: Ticket): number {
  return t.prs.filter((p) => p.work !== 'idle').length + t.prs.filter((p) => p.reviewing).length
}

/**
 * Starts what may start, within the ticket's agents and the quota: reviews
 * first (finished work is not held up), then restacks, fixes, lane checks and
 * pushes, then new coders — lowest in the stack first throughout.
 */
function schedule(t: Ticket, env: EngineEnv, out: Command[]): void {
  if (t.phase !== 'building' && t.phase !== 'integrating') return
  let room = t.maxAgents - working(t)
  const order = [...t.prs].sort((a, b) => depth(t, a) - depth(t, b) || a.index - b.index)
  const ready = (p: StackPr): boolean => !p.paused && !p.flags.blocked && p.status !== 'merged'
  const take = (newTile: boolean): boolean => {
    if (room <= 0 || (newTile && env.quotaHigh)) return false
    room--
    return true
  }
  const work = (p: StackPr, w: StackPr['work'], job: Job): void => {
    p.work = w
    p.lastActivity = env.now
    out.push({ do: 'work', pr: p.index, job, newTile: !p.coder })
  }

  // Reviews: a first review, or a re-check once every held finding is settled.
  for (const p of order) {
    if (!ready(p) || p.reviewing || p.work !== 'idle' || p.flags.baseFailing || !env.settings.requireFreshReview) continue
    const first = p.status === 'tests-passing'
    const recheck = p.status === 'in-review' && !!p.review && openHeld(p).length === 0 && !fixRequestsFor(t, p.index).length &&
      !routedOpen(t, p.index)
    if (!first && !recheck) continue
    const toCheck = p.review?.findings.filter((f) => f.resolution === 'fixed' || (typeof f.resolution === 'object' && 'declined' in f.resolution)) ?? []
    if (recheck && !toCheck.length) {
      // Every held finding was skipped by the user: nothing left to check.
      p.status = 'review-clean'
      continue
    }
    if (!take(true)) continue
    p.reviewing = true
    p.status = 'in-review'
    p.lastActivity = env.now
    out.push({
      do: 'review', pr: p.index, round: (p.review?.round ?? 0) + 1,
      range: { base: p.baseSha ?? '', head: p.headSha ?? '' }, recheck: toCheck,
    })
  }

  // Restacks, lowest first, never above one still waiting on its own.
  for (const p of order) {
    if (!ready(p) || p.work !== 'idle' || p.reviewing || !p.restack?.approved) continue
    const parent = parentOf(t, p)
    if (parent && (parent.restack || parent.work === 'restacking')) continue
    if (!take(!p.coder)) continue
    const repo = repoOf(t, p)!
    const onto = parent ? parent.branch : `origin/${repo.baseBranch}`
    const retarget = parent ? null : (p.prUrl ? repo.baseBranch : null)
    work(p, 'restacking', { kind: 'restack', onto, from: p.restack.from, retarget })
  }

  // Fixes the user asked for, including findings routed to this PR from another.
  for (const p of order) {
    if (!ready(p) || p.work !== 'idle' || p.reviewing) continue
    const fixes = fixRequestsFor(t, p.index).filter((f) => f.resolution === 'fix-requested')
    if (!fixes.length) continue
    if (!take(!p.coder)) continue
    work(p, 'fixing', { kind: 'fix', findings: fixes })
  }

  // A lane whose every PR is review-clean is tested whole, at its top.
  for (const leaf of order.filter((p) => !childrenOf(t, p.index).some((c) => c.status !== 'merged'))) {
    if (!ready(leaf) || leaf.work !== 'idle' || leaf.reviewing || !leaf.headSha) continue
    const lane = lanePrs(t, leaf.index, true)
    if (!lane.every((p) => atLeast(p, 'review-clean'))) continue
    if (lane.some((p) => p.restack || p.work !== 'idle')) continue
    if (t.laneChecks[leaf.index] === leaf.headSha || lane.every((p) => atLeast(p, 'pushed'))) continue
    if (!take(!leaf.coder)) continue
    work(leaf, 'checking-lane', { kind: 'checkLane', prs: lane.filter((p) => p.status !== 'merged').map((p) => p.index) })
  }

  // Pushes the user allowed, bottom up.
  for (const p of order) {
    if (!ready(p) || !p.pushAllowed || p.work !== 'idle' || !pushable(t, p)) continue
    if (!take(!p.coder)) continue
    const parent = parentOf(t, p)
    work(p, 'pushing', { kind: 'push', base: parent ? parent.branch : repoOf(t, p)!.baseBranch })
  }

  // New coders, once what they wait on has its interface.
  for (const p of order) {
    if (!ready(p) || p.status !== 'planned' || p.work !== 'idle') continue
    if (!waitsOn(t, p.index).every((i) => interfaceAvailable(prOf(t, i)!))) continue
    if (!take(true)) continue
    const parent = parentOf(t, p)
    p.status = 'coding'
    if (!p.worktree) {
      out.push({
        do: 'createWorktree', pr: p.index, repo: repoOf(t, p)!.id, branch: p.branch,
        from: parent ? parent.branch : `origin/${repoOf(t, p)!.baseBranch}`,
      })
    }
    work(p, 'coding', { kind: 'code' })
  }
}

/* ---------- cards ---------- */

export interface CardAction {
  id: string
  label: string
  primary?: boolean
  needsText?: boolean
  needsValue?: { min: number; max: number; value: number }
}

export interface CardSpec {
  id: string
  kind: 'plan' | 'finding' | 'review' | 'restack' | 'blocked' | 'push' | 'amendment' | 'feature'
  prIndex?: number
  findingId?: string
  amendment?: string
  title: string
  body: string
  actions: CardAction[]
}

/** Every card the ticket shows now, feature card first. */
export function cardsFor(t: Ticket): CardSpec[] {
  const cards: CardSpec[] = [featureCard(t)]
  if (t.phase === 'abandoned' || t.phase === 'done') return cards
  const agents = (): CardAction => ({ id: 'agents', label: 'Agents', needsValue: { min: 4, max: 16, value: t.maxAgents } })

  if (t.phase === 'awaiting-approval' && t.plan) {
    cards.push({
      id: `${t.id}:plan:v${t.plan.version}`, kind: 'plan', title: `Plan for ${t.localKey}: ${t.plan.prs.length} PR(s)`,
      body: planBody(t),
      actions: [
        { id: 'approve', label: 'Approve', primary: true },
        { id: 'revise', label: 'Change…', needsText: true },
        { id: 'cancel', label: 'Cancel ticket' },
        agents(),
      ],
    })
  }

  for (const a of t.amendments) {
    cards.push({
      id: `${t.id}:amend:${a.id}`, kind: 'amendment', prIndex: a.pr, amendment: a.id,
      title: `${t.localKey}-${a.pr} wants to change ${a.name}`, body: `${a.why}\n\nNew contract: ${a.contract}`,
      actions: [{ id: 'approve', label: 'Change it', primary: true }, { id: 'reject', label: 'Keep the plan' }],
    })
  }

  for (const pr of t.prs) {
    const key = `${t.localKey}-${pr.index}`
    const title = plannedOf(t, pr)?.title ?? ''
    if (pr.flags.blocked) {
      cards.push({
        id: `${t.id}:blocked:${pr.index}`, kind: 'blocked', prIndex: pr.index, title: `${key} ${title} is stuck`,
        body: pr.flags.blocked,
        actions: [
          { id: 'nudge', label: 'Nudge', primary: true }, { id: 'fresh', label: 'Fresh context' }, { id: 'pause', label: 'Pause PR' },
        ],
      })
    }
    if (pr.restack && !pr.restack.approved && !pr.restack.deferred) {
      const parent = parentOf(t, pr)
      cards.push({
        id: `${t.id}:restack:${pr.index}`, kind: 'restack', prIndex: pr.index, title: `Restack ${key} ${title}`,
        body: parent ? `${t.localKey}-${parent.index} moved. Rebase this PR and the ones above it onto it, bottom up?`
          : `What it sat on was merged. Rebase it onto ${repoOf(t, pr)?.baseBranch}?`,
        actions: [{ id: 'restack', label: 'Restack now', primary: true }, { id: 'later', label: 'Later' }],
      })
    }
    const held = openHeld(pr)
    if (pr.review && held.length) {
      cards.push({
        id: `${t.id}:review:${pr.index}:r${pr.review.round}`, kind: 'review', prIndex: pr.index,
        title: `Review of ${key}: ${held.length} finding(s) hold it`, body: `Round ${pr.review.round}. Fix or skip each one.`,
        actions: [{ id: 'fix-all', label: 'Fix all held', primary: true }],
      })
      for (const f of held) {
        cards.push({
          id: `${t.id}:finding:${f.id}`, kind: 'finding', prIndex: pr.index, findingId: f.id,
          title: `${key} [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : ''}`.trim(),
          body: f.summary + (f.routedTo !== null ? `\n\n(${t.localKey}-${f.routedTo} owns that file: it will fix it.)` : ''),
          actions: [{ id: 'fix', label: 'Fix', primary: true }, { id: 'skip', label: 'Skip with reason…', needsText: true }],
        })
      }
    }
    if (pushable(t, pr) && !pr.pushAllowed && pr.work === 'idle') {
      cards.push(pr.flags.repush
        ? {
          id: `${t.id}:push:${pr.index}`, kind: 'push', prIndex: pr.index, title: `${key} ${title}: push the rebased branch`,
          body: `Restacked${pr.prUrl ? ` (${pr.prUrl})` : ''} and its tests pass. Pushing updates its PR with --force-with-lease and points it at the branch below.`,
          actions: [{ id: 'push', label: 'Push', primary: true }],
        }
        : {
          id: `${t.id}:push:${pr.index}`, kind: 'push', prIndex: pr.index, title: `${key} ${title} is ready to push`,
          body: 'Reviewed, and its whole lane passes. Pushing opens a draft PR against the branch below.',
          actions: [{ id: 'push', label: 'Push & open PR', primary: true }],
        })
    }
  }
  return cards
}

function featureCard(t: Ticket): CardSpec {
  const actions: CardAction[] = []
  // Finished or cancelled: what is left is tidying up, chosen in a dialog (never automatic).
  if (t.phase === 'done' || t.phase === 'abandoned') actions.push({ id: 'cleanup', label: 'Clean up…' })
  if (t.phase !== 'done' && t.phase !== 'abandoned') {
    actions.push({ id: 'agents', label: 'Agents', needsValue: { min: 4, max: 16, value: t.maxAgents } })
    for (const root of t.prs.filter((p) => parentOf(t, p) === null && p.status !== 'merged')) {
      const lane = lanePrs(t, root.index)
      if (lane.some((p) => !atLeast(p, 'pushed')) && lane.every((p) => atLeast(p, 'review-clean')) && pushable(t, root)) {
        actions.push({ id: `push-stack:${root.index}`, label: `Push stack from ${t.localKey}-${root.index}` })
      }
    }
    for (const p of t.prs) {
      if (p.status === 'pushed') actions.push({ id: `merged:${p.index}`, label: `Mark ${t.localKey}-${p.index} merged` })
      if (p.paused) actions.push({ id: `resume:${p.index}`, label: `Resume ${t.localKey}-${p.index}` })
    }
    for (const [repo, m] of Object.entries(t.baseMoved)) {
      if (m.commits > 0) actions.push({ id: `update:${repo}`, label: `Update ${repo} lanes (${m.commits} new on base)` })
    }
    actions.push({ id: 'cancel', label: 'Cancel ticket' })
  }
  const c = checklist(t)
  const body = [
    `${t.phase} · ${Math.round(progress(t) * 100)} %`,
    ...Object.entries(c).map(([k, v]) => `${v === true ? '✅' : v === false ? '⬜' : '❔'} ${k}`),
    ...t.prs.map((p) => `- ${t.localKey}-${p.index} ${plannedOf(t, p)?.title ?? ''}: ${p.status}${p.flags.needsRestack ? ' ⟳' : ''}` +
      `${p.flags.blocked ? ' ⚠' : ''}${p.paused ? ' ⏸' : ''}`),
  ].join('\n')
  return { id: `${t.id}:feature`, kind: 'feature', title: `${t.localKey} ${t.title}`, body, actions }
}

function planBody(t: Ticket): string {
  const p = t.plan!
  const added = p.addRepos.map((r) => `- ➕ ${r.path}: ${r.why}`)
  return [
    p.summary,
    '',
    `Repos: ${t.repos.map((r) => `${r.id} (${r.baseBranch})`).join(', ')}`,
    ...added,
    '',
    ...p.prs.map((x) => `**${t.localKey}-${x.index} ${x.title}** (${x.repo}${x.below !== null ? `, on ${t.localKey}-${x.below}` : ''})\n` +
      `${x.scope}\nOwns: ${x.owns.join(', ')}\nTests: ${x.tests.run.join('; ')}${x.uses.length ? `\nUses: ${x.uses.join(', ')}` : ''}`),
    ...(p.interfaces.length ? ['', 'Interfaces:', ...p.interfaces.map((i) => `- ${i.name} (${t.localKey}-${i.owner}): ${i.contract}`)] : []),
  ].join('\n')
}

/** The feature card's done checklist: true, false, or null when tring cannot know yet. */
export function checklist(t: Ticket): Record<string, boolean | null> {
  const all = (f: (p: StackPr) => boolean): boolean => t.prs.length > 0 && t.prs.every(f)
  const docs = t.plan?.docs
  return {
    'tests written': all((p) => atLeast(p, 'tests-passing')),
    'tests passing': all((p) => atLeast(p, 'tests-passing') && !p.flags.failing),
    'review clean': all((p) => atLeast(p, 'review-clean')),
    'docs updated': !docs ? false : 'none' in docs ? true : docs.files.every((f) => {
      const owner = t.plan!.prs.find((p) => p.repo === f.repo && p.owns.some((g) => matches(g, f.path)))
      const pr = owner && prOf(t, owner.index)
      return !!pr && atLeast(pr, 'review-clean')
    }),
    'CI green': ci(t),
  }
}

/** Green when every pushed PR's CI is; red when any is; unknown until the forge says. */
function ci(t: Ticket): boolean | null {
  const pushed = t.prs.filter((p) => atLeast(p, 'pushed'))
  const states = pushed.map((p) => t.ci?.[p.index])
  if (states.some((s) => s === 'red')) return false
  return pushed.length > 0 && pushed.length === t.prs.length && states.every((s) => s === 'green') ? true : null
}

/** 0..1: how far along the stack is, each PR counted by its status. */
export function progress(t: Ticket): number {
  if (!t.prs.length) return 0
  return t.prs.reduce((n, p) => n + RANK[p.status], 0) / (t.prs.length * RANK.merged)
}

/* ---------- the shape of the stack ---------- */

export const prOf = (t: Ticket, i: number): StackPr | undefined => t.prs.find((p) => p.index === i)
const plannedOf = (t: Ticket, p: StackPr): PlannedPr | undefined => t.plan?.prs.find((x) => x.index === p.index)
const repoOf = (t: Ticket, p: StackPr): TicketRepo | undefined => t.repos.find((r) => r.id === plannedOf(t, p)?.repo)

/** The PR it sits on now: its `below`, unless that is merged (then the base branch: null). */
export function parentOf(t: Ticket, p: StackPr): StackPr | null {
  const below = plannedOf(t, p)?.below
  const parent = below != null ? prOf(t, below) : undefined
  return parent && parent.status !== 'merged' ? parent : null
}

export const childrenOf = (t: Ticket, i: number): StackPr[] =>
  t.prs.filter((p) => plannedOf(t, p)?.below === i)

/** What a PR waits on before it may start: the PR below it and the owners of the interfaces it uses. */
function waitsOn(t: Ticket, i: number): number[] {
  const p = t.plan?.prs.find((x) => x.index === i)
  if (!p) return []
  const owners = p.uses.map((u) => t.plan!.interfaces.find((x) => x.name === u)?.owner).filter((o): o is number => o !== undefined && o !== i)
  return [...new Set([...(p.below !== null ? [p.below] : []), ...owners])]
}

/** Everything a PR waits on, transitively. */
function upstream(t: Ticket, i: number, seen = new Set<number>()): number[] {
  for (const w of waitsOn(t, i)) {
    if (seen.has(w)) continue
    seen.add(w)
    upstream(t, w, seen)
  }
  return [...seen]
}

const interfaceAvailable = (p: StackPr): boolean => p.flags.interfaceReady || atLeast(p, 'tests-passing')

function depth(t: Ticket, p: StackPr): number {
  let d = 0
  for (let at = parentOf(t, p); at; at = parentOf(t, at)) d++
  return d
}

/**
 * The PRs of a lane: from `from` down to its root, and with `whole` false up
 * through every PR above it as well. With `whole`, `from` is a lane's top.
 */
function lanePrs(t: Ticket, from: number, whole = false): StackPr[] {
  const start = prOf(t, from)
  if (!start) return []
  if (whole) {
    const out: StackPr[] = []
    for (let at: StackPr | null = start; at; at = parentOf(t, at)) out.unshift(at)
    return out
  }
  const out: StackPr[] = []
  const walk = (p: StackPr): void => {
    out.push(p)
    for (const c of childrenOf(t, p.index)) walk(c)
  }
  walk(start)
  return out
}

/** The tops of every lane through `p`. */
function leavesOver(t: Ticket, p: StackPr): StackPr[] {
  const kids = childrenOf(t, p.index).filter((c) => c.status !== 'merged')
  return kids.length ? kids.flatMap((c) => leavesOver(t, c)) : [p]
}

/** Reviewed, every lane through it tested whole (or pushed and since restacked), what it sits on pushed, and no conflict with a moved base. */
function pushable(t: Ticket, p: StackPr): boolean {
  if (p.restack || p.flags.blocked) return false
  // A pushed PR's rebased branch: its restack report carried its tests.
  if (p.status === 'pushed' && !p.flags.repush) return false
  if (p.status !== 'review-clean' && p.status !== 'pushed') return false
  if (p.status === 'review-clean' && !leavesOver(t, p).every((leaf) => leaf.headSha && t.laneChecks[leaf.index] === leaf.headSha)) return false
  const parent = parentOf(t, p)
  if (parent && !atLeast(parent, 'pushed')) return false
  const repo = plannedOf(t, p)?.repo
  return !(repo && t.baseMoved[repo]?.conflict)
}

/** The PR that owns `file`, when it is not `pr` itself: findings there go to it. */
function ownerOf(t: Ticket, pr: StackPr, file: string | null): number | null {
  if (!file || !t.plan) return null
  const me = plannedOf(t, pr)
  if (!me || me.owns.some((g) => matches(g, file))) return null
  const other = t.plan.prs.find((x) => x.repo === me.repo && x.index !== me.index && x.owns.some((g) => matches(g, file)))
  return other?.index ?? null
}

const openHeld = (p: StackPr): Finding[] => (p.review?.findings ?? []).filter((f) => f.holds && f.resolution === 'open')

/** Findings sent for fixing that this PR is to fix: its own, and those routed to it. */
function fixRequestsFor(t: Ticket, i: number): Finding[] {
  return t.prs.flatMap((p) => (p.review?.findings ?? [])
    .filter((f) => f.resolution === 'fix-requested' && (f.routedTo ?? p.index) === i))
}

/** Whether a finding of `i`'s is still with another PR to fix. */
function routedOpen(t: Ticket, i: number): boolean {
  return (prOf(t, i)?.review?.findings ?? []).some((f) => f.routedTo !== null && f.resolution === 'fix-requested')
}

function findFinding(t: Ticket, id: string): { f: Finding; pr: StackPr } | undefined {
  for (const pr of t.prs) {
    const f = pr.review?.findings.find((x) => x.id === id)
    if (f) return { f, pr }
  }
  return undefined
}

function defaultBranch(t: Ticket, p: PlannedPr): string {
  const slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pr'
  return `feature/${t.localKey}-${p.index}-${slug}`
}

function log(t: Ticket, env: EngineEnv, pr: number | null, who: Ticket['log'][number]['who'], text: string): void {
  t.log.push({ at: env.now, pr, who, text })
}

/**
 * The multi-PR workflow: one ticket, one tab, small reviewed units of work
 * landed as independent PRs, a stack, or one PR of ordered commits
 * (docs/superpowers/specs/2026-11-25-multi-pr-workflow-design.md,
 * 2026-11-25-adaptive-strategies-design.md).
 */

/** How a ticket's units land: a PR each off the base, a PR each on the one below, or one PR of a commit each. */
export type Strategy = 'independent' | 'stacked' | 'single'
export const STRATEGIES: readonly Strategy[] = ['independent', 'stacked', 'single']
export const STRATEGY_NAMES: Readonly<Record<Strategy, string>> = { independent: 'Independent PRs', stacked: 'Stacked PRs', single: 'Single PR' }
/** The name mid-sentence: independent PRs, stacked PRs, a single PR. */
export const strategyPhrase = (s: Strategy): string => s === 'single' ? 'a single PR' : STRATEGY_NAMES[s].replace(/^\w/, (c) => c.toLowerCase())

/** Claude Code's --effort levels. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The agents a ticket runs, each started on its own model and effort. */
export type AgentRole = 'planner' | 'coder' | 'reviewer' | 'integrator'
export const AGENT_ROLES: readonly AgentRole[] = ['planner', 'coder', 'reviewer', 'integrator']

/** A role's model and effort; null for either is Claude Code's own default. */
export interface RoleModel { model: string | null; effort: Effort | null }

/**
 * A model name as `claude --model` takes it: an alias (opus, sonnet…) or a
 * full name (claude-opus-5-5, opus[1m]). It is typed into a shell, so nothing
 * else gets through: no spaces, quotes or shell characters.
 */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,79}$/

/** Settings → Workflow. Daemon-side, since the orchestrator and the stack engine read it. */
export interface WorkflowSettings {
  /** The switch. Off, nothing of the workflow runs or shows. */
  multiPr: boolean
  /** A fresh reviewer tile reviews every PR before it may push. */
  requireFreshReview: boolean
  /** When a lower PR moves: offer to restack the PRs above it, or do it. */
  autoRestack: 'offer' | 'auto'
  /** How many agents a new ticket may run at once; each ticket can change its own. */
  maxAgents: number
  /** Later: a soft cap on changed lines per PR. */
  maxPrLines: number | null
  /** Later: coders write failing tests before code. */
  testFirst: boolean
  /** Each repo's units merged onto its base and tested together before anything is pushed. */
  integrationCheck: boolean
  /** Which strategy the plan card pre-selects; 'auto' is the planner's pick. The user still chooses every time. */
  defaultStrategy: 'auto' | Strategy
  /** Independent PRs land through a feature branch and one final PR into the base. */
  combinedPr: boolean
  /** Each agent role's model and effort. */
  models: Record<AgentRole, RoleModel>
}

export const MIN_AGENTS = 4
export const MAX_AGENTS = 16

const DEFAULT_MODELS = (): Record<AgentRole, RoleModel> =>
  Object.fromEntries(AGENT_ROLES.map((r) => [r, { model: null, effort: null }])) as Record<AgentRole, RoleModel>

export const DEFAULT_WORKFLOW: Readonly<WorkflowSettings> = Object.freeze({
  multiPr: false,
  requireFreshReview: true,
  autoRestack: 'offer',
  maxAgents: MIN_AGENTS,
  maxPrLines: null,
  testFirst: false,
  integrationCheck: true,
  defaultStrategy: 'auto',
  combinedPr: false,
  models: DEFAULT_MODELS(),
})

/** Whole agents, within the slider's range. */
export function clampAgents(n: number): number {
  return Math.min(MAX_AGENTS, Math.max(MIN_AGENTS, Math.round(n)))
}

/**
 * `patch` applied over `base`, field by field: a value of the wrong kind
 * leaves that field as it was, and keys that are not settings are dropped.
 * Used for a POST from the browser and for a file read back from disk alike.
 */
export function mergeWorkflow(base: WorkflowSettings, patch: unknown): WorkflowSettings {
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch as Record<string, unknown> : {}
  const bool = (k: 'multiPr' | 'requireFreshReview' | 'testFirst' | 'integrationCheck' | 'combinedPr'): boolean =>
    typeof p[k] === 'boolean' ? p[k] as boolean : base[k]
  const lines = p['maxPrLines']
  return {
    multiPr: bool('multiPr'),
    requireFreshReview: bool('requireFreshReview'),
    autoRestack: p['autoRestack'] === 'offer' || p['autoRestack'] === 'auto' ? p['autoRestack'] : base.autoRestack,
    maxAgents: typeof p['maxAgents'] === 'number' && Number.isFinite(p['maxAgents'])
      ? clampAgents(p['maxAgents'])
      : base.maxAgents,
    maxPrLines: lines === null ? null
      : typeof lines === 'number' && Number.isFinite(lines) && lines > 0 ? Math.round(lines)
      : base.maxPrLines,
    testFirst: bool('testFirst'),
    integrationCheck: bool('integrationCheck'),
    defaultStrategy: p['defaultStrategy'] === 'auto' || STRATEGIES.includes(p['defaultStrategy'] as Strategy)
      ? p['defaultStrategy'] as WorkflowSettings['defaultStrategy']
      : base.defaultStrategy,
    combinedPr: bool('combinedPr'),
    models: mergeModels(base.models ?? DEFAULT_MODELS(), p['models']),
  }
}

/** Role by role, field by field: a model that is not a model name, or an unknown effort, counts as unset. */
function mergeModels(base: Record<AgentRole, RoleModel>, patch: unknown): Record<AgentRole, RoleModel> {
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch as Record<string, unknown> : {}
  const out = {} as Record<AgentRole, RoleModel>
  for (const role of AGENT_ROLES) {
    const was = base[role] ?? { model: null, effort: null }
    const r = p[role] && typeof p[role] === 'object' ? p[role] as Record<string, unknown> : {}
    const model = !('model' in r) ? was.model
      : typeof r['model'] === 'string' && MODEL_NAME.test(r['model']) ? r['model'] : null
    const effort = !('effort' in r) ? was.effort
      : EFFORTS.includes(r['effort'] as Effort) ? r['effort'] as Effort : null
    out[role] = { model, effort }
  }
  return out
}

/* ---------- tickets, plans and stacks ---------- */

/** A repository a ticket works in: a local clone, never a remote. */
export interface TicketRepo {
  /** Short and unique within the ticket: the repository's name, e.g. "cypherview.telemetry.store". */
  id: string
  /** The clone's main checkout. */
  root: string
  /** What a PR with `below: null` branches from, e.g. develop. */
  baseBranch: string
}

export interface PlannedPr {
  /** Unique across the ticket; also the n in its local ticket's key, `<KEY>-n`. */
  index: number
  /** A TicketRepo id. */
  repo: string
  /** The PR it branches from (same repo only), or null for the repo's base branch. */
  below: number | null
  title: string
  scope: string
  /** Globs in its repo, relative to the repo root; no other PR of that repo may cover the same file. */
  owns: string[]
  /** Interface names it codes against, possibly owned in another repo. */
  uses: string[]
  tests: { add: string[]; run: string[] }
  acceptance: string[]
}

export interface PlanInterface {
  name: string
  /** The PR that provides it. */
  owner: number
  /** What users of it code against, in words or signatures. */
  contract: string
}

/** A file more than one PR needs: only `owner` edits it; the others ask it to (request_change). */
export interface SharedFile {
  repo: string
  path: string
  owner: number
  why: string
}

export interface Plan {
  /** Bumps on every revision and amendment. */
  version: number
  summary: string
  prs: PlannedPr[]
  shared: SharedFile[]
  interfaces: PlanInterface[]
  /** Repo ids, when the change must ship in an order; null when it need not. */
  deployOrder: string[] | null
  /** Repositories the planner needs beyond the ones the ticket started with. */
  addRepos: Array<{ path: string; base: string | null; why: string }>
  /** The docs the ticket should change, or why it changes none. */
  docs: { files: Array<{ repo: string; path: string }> } | { none: string }
  /** The planner's recommended strategy and why. Absent only on plans made before strategies. */
  advice?: StrategyAdvice
}

/** What the planner weighs to recommend a strategy. */
export type StrategyFactor = 'coupling' | 'overlap' | 'size' | 'repos' | 'review' | 'shipping'
export const STRATEGY_FACTORS: readonly StrategyFactor[] = ['coupling', 'overlap', 'size', 'repos', 'review', 'shipping']

export interface StrategyAdvice {
  recommended: Strategy
  /** One line per factor, and the strategy it points to, if any. */
  factors: Array<{ factor: StrategyFactor; note: string; favours: Strategy | null }>
  /** What each strategy would mean for this ticket, for the plan card's picker. */
  means: Record<Strategy, string>
}

/** What a screen needs of a ticket for its tab badge and stack rail (state message). */
export interface TicketView {
  id: string
  localKey: string
  title: string
  projectId: string | null
  phase: TicketPhase
  /** PRs reviewed or further, of all. */
  done: number
  total: number
  /** One row per repo, its PRs bottom up. */
  repos: Array<{
    id: string
    baseBranch: string
    prs: Array<{
      index: number
      key: string
      title: string
      status: PrStatus
      /** What it sits on: another PR's key, or the base branch. */
      on: string
      branch: string
      prUrl: string | null
      work: PrWork
      reviewing: boolean
      queued: boolean
      needsRestack: boolean
      blocked: string | null
      paused: boolean
      /** The coder's tile, when it is open. */
      slot: number | null
    }>
  }>
}

export const MIN_PRS = 1
export const MAX_PRS = 16

export type PrStatus = 'planned' | 'coding' | 'tests-passing' | 'in-review' | 'review-clean' | 'pushed' | 'merged'

export type FindingSeverity = 'high' | 'medium' | 'low' | 'nit'

export type FindingResolution =
  | 'open' | 'fix-requested' | 'fixed' | 'verified'
  /** The user's call, with a reason. */
  | { skipped: string }
  /** The coder's call after looking: not really an issue, with a reason. */
  | { declined: string }

export interface Finding {
  id: string
  severity: FindingSeverity
  file: string | null
  line: number | null
  summary: string
  /** High and medium findings hold the PR; low and nit are advisory. */
  holds: boolean
  resolution: FindingResolution
  /** The file belongs to another PR: that PR fixes it, and both are held until it does. */
  routedTo: number | null
  /** How the reviewer showed it: a failing command and its output, or the changed line. A high or medium finding holds only with one. */
  proof?: string | null
  /** Already on the base before this unit: never holds; listed as a follow-up. */
  preExisting?: boolean
}

/** Where a tile is, in terms that survive a restart (as card-store.ts keeps them). */
export interface TileAt {
  projectId: string
  slot: number
  claudeId: string | null
}

export interface Review {
  round: number
  reviewer: TileAt | null
  range: { base: string; head: string }
  findings: Finding[]
}

/** What a PR's coder is doing for the engine right now; anything but idle and queued is an agent at work. */
export type PrWork = 'idle' | 'coding' | 'fixing' | 'restacking' | 'pushing'

export interface StackPr {
  index: number
  branch: string
  worktree: string | null
  status: PrStatus
  work: PrWork
  /** A fresh reviewer is reviewing it now. */
  reviewing: boolean
  /** Held by the user: nothing new is started for it. */
  paused: boolean
  /** The PR below moved: rebase onto its new head from `from` (its old head) once approved. */
  restack: { from: string; approved: boolean; deferred: boolean } | null
  /** The user clicked Push: its push hook lets one push through. */
  pushAllowed: boolean
  /** The last hook or report from its agents, for spotting a stuck one. */
  lastActivity: number
  /** Review rounds in a row that each brought new held findings. */
  heldRounds: number
  coder: TileAt | null
  /** Kept after the coder's tile closes, for `claude --resume`. */
  coderConversation: string | null
  flags: {
    needsRestack: boolean
    baseFailing: boolean
    blocked: string | null
    interfaceReady: boolean
    /** Its own tests are red. Everything waiting on it gets baseFailing. */
    failing: boolean
    /** Pushed, then restacked: the rebased branch waits for the user's push. */
    repush?: boolean
  }
  /** The head of `below` (or of the base branch) this PR sits on. */
  baseSha: string | null
  headSha: string | null
  review: Review | null
  prUrl: string | null
}

export type TicketPhase = 'planning' | 'awaiting-approval' | 'building' | 'integrating' | 'done' | 'abandoned'

/** One line of a local ticket's work log: an agent's report or a person's card action. */
export interface WorkLogEntry {
  at: number
  /** The PR it is about; null for the ticket as a whole. */
  pr: number | null
  who: 'planner' | 'coder' | 'reviewer' | 'integrator' | 'user' | 'tring'
  text: string
}

export interface Ticket {
  id: string
  /** The tracker's key, e.g. "CHV-3193"; null for a ticket started from an idea. */
  key: string | null
  /** What its local tickets are keyed from: `key`, or a minted TRING-<n>. */
  localKey: string
  title: string
  text: string
  /** Where the text came from: "goby", "pasted"… Informational; tring knows no tracker. */
  source: string
  repos: TicketRepo[]
  /** The ticket tab. */
  projectId: string | null
  phase: TicketPhase
  plan: Plan | null
  /** One per planned PR once the plan is approved; empty before. */
  prs: StackPr[]
  /** This ticket's agents slider. */
  maxAgents: number
  log: WorkLogEntry[]
  createdAt: number
  /** Interface changes a lower PR asked for, waiting for the user. */
  amendments: Array<{ id: string; pr: number; name: string; contract: string; why: string }>
  /** How far each repo's base branch moved on its remote since the lanes were based on it. */
  baseMoved: Record<string, { commits: number; conflict: boolean; units?: number[] }>
  /** The planner's last errors, while it is revising. */
  planErrors: string[]
  /** Cleaned up: kept for the record (Recent tickets), no longer on any card. */
  archived?: boolean
  /** Each pushed PR's CI, where the forge says (GitHub through gh). */
  ci?: Record<number, 'green' | 'red' | 'pending'>
  /** How its units land, chosen by the user on the plan card; null until the plan is approved. */
  strategy: Strategy | null
  /** Independent PRs through a feature branch and one final PR. */
  combinedPr: boolean
  /** Whether pushes wait for the integration check: Settings at the time the plan was approved. */
  integrationCheck: boolean
  /** Each repo's integration check, by repo id. */
  integration: Record<string, Integration>
  /** One PR per repo made of the units' commits (single), or independent's final PR, by repo id. */
  combined: Record<string, CombinedPr>
  /** Problems a review found that were already on the base: listed, never holding a PR. */
  followUps: Array<{ pr: number; summary: string }>
}

/** A repo's units merged onto its base and tested together. */
export interface Integration {
  status: 'waiting' | 'conflict' | 'running' | 'passing' | 'failing'
  /** The base commit it used. */
  base: string | null
  /** Unit -> the head it used. */
  tips: Record<number, string>
  /** The merge (or assembled head) that was tested. */
  sha: string | null
  /** tring's own checkout of it, detached: offered by Clean up. */
  worktree?: string | null
  conflict: { units: number[]; files: string[] } | null
  evidence: string | null
}

/** The one PR several units land in. */
export interface CombinedPr {
  branch: string
  base: string
  units: number[]
  /** In order: each unit's commit, verified when its tree is the one its unit was reviewed and tested on. */
  commits: Array<{ unit: number; sha: string; verified: boolean }>
  status: 'local' | 'pushed' | 'merged'
  /** Its branch exists on origin (independent PRs target it); while being pushed there, 'pushing'. */
  onOrigin: boolean | 'pushing'
  prUrl: string | null
}

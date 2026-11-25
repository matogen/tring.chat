/**
 * The multi-PR workflow: one ticket, one tab, a stack of small reviewed PRs
 * (docs/superpowers/specs/2026-11-25-multi-pr-workflow-design.md).
 */

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
  /** Later: cross-repo end-to-end checks before pushing. */
  integrationCheck: boolean
}

export const MIN_AGENTS = 4
export const MAX_AGENTS = 16

export const DEFAULT_WORKFLOW: Readonly<WorkflowSettings> = Object.freeze({
  multiPr: false,
  requireFreshReview: true,
  autoRestack: 'offer',
  maxAgents: MIN_AGENTS,
  maxPrLines: null,
  testFirst: false,
  integrationCheck: false,
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
  const bool = (k: 'multiPr' | 'requireFreshReview' | 'testFirst' | 'integrationCheck'): boolean =>
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
  }
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
export type PrWork = 'idle' | 'coding' | 'fixing' | 'restacking' | 'checking-lane' | 'pushing'

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
  who: 'planner' | 'coder' | 'reviewer' | 'user' | 'tring'
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
  /** Lane checks that passed: the lane's top PR -> its head when its whole lane passed there. */
  laneChecks: Record<number, string>
  /** Interface changes a lower PR asked for, waiting for the user. */
  amendments: Array<{ id: string; pr: number; name: string; contract: string; why: string }>
  /** How far each repo's base branch moved on its remote since the lanes were based on it. */
  baseMoved: Record<string, { commits: number; conflict: boolean }>
  /** The planner's last errors, while it is revising. */
  planErrors: string[]
}

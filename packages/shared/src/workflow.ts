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

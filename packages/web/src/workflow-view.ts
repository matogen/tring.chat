import type { InboxItem } from '@tring/shared/protocol'
import {
  AGENT_ROLES, EFFORTS, MAX_AGENTS, MIN_AGENTS, STRATEGY_NAMES, type AgentRole, type PrStatus, type RoleModel, type TicketView, type WorkflowSettings,
} from '@tring/shared/workflow'

/** What Settings → Workflow shows: pure, so it is tested without a page (workflow-settings.ts draws it). */

type Key = keyof WorkflowSettings

export interface WorkflowControl {
  key: Key
  kind: 'toggle' | 'choice' | 'slider' | 'model'
  label: string
  hint: string
  value: boolean | string | number | RoleModel | null
  options?: Array<{ value: string; label: string }>
  /** kind 'model': the role, and the efforts offered beside the models. */
  role?: AgentRole
  efforts?: Array<{ value: string; label: string }>
  min?: number
  max?: number
  /** Designed for, not built yet: shown greyed so the shape of the feature is visible. */
  later: boolean
  disabled: boolean
}

/** What the section shows for `s`. Off, only the switch: nothing else of the workflow is in sight. */
export function workflowControls(s: WorkflowSettings): WorkflowControl[] {
  const now = (c: Omit<WorkflowControl, 'later' | 'disabled'>): WorkflowControl => ({ ...c, later: false, disabled: false })
  const later = (c: Omit<WorkflowControl, 'later' | 'disabled'>): WorkflowControl => ({ ...c, later: true, disabled: true })
  const out: WorkflowControl[] = [now({
    key: 'multiPr', kind: 'toggle', value: s.multiPr, label: 'Multi-PR workflow',
    hint: '"Work on ticket X" opens a tab of agents that plan the ticket as small stacked PRs, ' +
      'build and test each in its own worktree, and have a fresh agent review each before it may push.',
  })]
  if (!s.multiPr) return out
  out.push(
    now({
      key: 'defaultStrategy', kind: 'choice', value: s.defaultStrategy, label: 'Default strategy',
      hint: 'Which strategy the plan card pre-selects. You still choose on every plan.',
      options: [
        { value: 'auto', label: 'Auto (planner decides)' }, { value: 'independent', label: 'Independent' },
        { value: 'stacked', label: 'Stacked' }, { value: 'single', label: 'Single PR' },
      ],
    }),
    now({
      key: 'combinedPr', kind: 'toggle', value: s.combinedPr, label: 'Final combined PR for independent PRs',
      hint: 'Independent PRs merge into a feature branch, and one final PR takes it into the base.',
    }),
    now({
      key: 'requireFreshReview', kind: 'toggle', value: s.requireFreshReview, label: 'Require a fresh review',
      hint: 'A new reviewer tile with a clean context reviews every PR before it may push.',
    }),
    now({
      key: 'autoRestack', kind: 'choice', value: s.autoRestack, label: 'When a lower PR changes',
      hint: 'The PRs above it need rebasing onto it, one at a time, bottom up.',
      options: [{ value: 'offer', label: 'Offer to restack' }, { value: 'auto', label: 'Restack automatically' }],
    }),
    now({
      key: 'maxAgents', kind: 'slider', value: s.maxAgents, min: MIN_AGENTS, max: MAX_AGENTS,
      label: 'Agents per ticket',
      hint: 'How many agents a new ticket may run at once. Each ticket can change its own on its cards.',
    }),
    now({
      key: 'integrationCheck', kind: 'toggle', value: s.integrationCheck, label: 'Integration check',
      hint: 'Each repo\'s units merged onto its base and tested together before anything is pushed.',
    }),
    ...AGENT_ROLES.map((role) => now({
      key: 'models', kind: 'model', role, value: s.models[role], label: ROLE_LABEL[role],
      hint: ROLE_HINT[role], options: MODEL_OPTIONS, efforts: EFFORT_OPTIONS,
    })),
    later({ key: 'maxPrLines', kind: 'slider', value: s.maxPrLines, label: 'Max PR size', hint: 'Coming later.' }),
    later({ key: 'testFirst', kind: 'toggle', value: s.testFirst, label: 'Test-first', hint: 'Coming later.' }),
  )
  return out
}

const ROLE_LABEL: Record<AgentRole, string> = {
  planner: 'Planner', coder: 'Coders', reviewer: 'Reviewers', integrator: 'Integration checks',
}
const ROLE_HINT: Record<AgentRole, string> = {
  planner: 'Splits the ticket and recommends a strategy. Worth the strongest model.',
  coder: 'Writes each unit and its tests.',
  reviewer: 'Reviews each unit fresh. A different model from the coders catches different things.',
  integrator: 'Runs the tests of a repo\'s units together. A lighter model does.',
}
/** '' is Claude Code's own default; the rest are `claude --model` aliases. */
const MODEL_OPTIONS = [
  { value: '', label: 'Default' }, { value: 'fable', label: 'Fable' }, { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' }, { value: 'haiku', label: 'Haiku' },
]
const EFFORT_OPTIONS = [{ value: '', label: 'Default effort' }, ...EFFORTS.map((e) => ({ value: e, label: e }))]


/* ---------- the multi-PR workflow's cards ---------- */

export interface WorkflowButton {
  id: string
  label: string
  primary: boolean
  /** What it asks for before it is sent: nothing, words, or a number. */
  input: 'none' | 'text' | 'value'
  min?: number
  max?: number
  value?: number
}

export interface WorkflowCardView {
  /** The ticket's own status card: kept at the top. */
  pinned: boolean
  heading: string
  /** Markdown. */
  body: string
  /** A choice made above the buttons and sent with one of them: the plan card's strategy picker. */
  picker: PickerView | null
  buttons: WorkflowButton[]
}

export interface PickerView {
  /** The button the pick goes with. */
  action: string
  choices: Array<{ value: string; label: string; note: string; misfit: string | null; name: string }>
  selected: string
  option: { id: string; label: string; for: string; checked: boolean } | null
}

/** What the picker's button says: Approve plan, or Re-plan as … for a pick the plan does not fit. */
export function pickerLabel(p: PickerView, selected: string): string {
  const c = p.choices.find((x) => x.value === selected)
  return c?.misfit ? `Re-plan as ${c.name}` : 'Approve plan'
}

/** What is sent with the button: the pick, and `:<option>` when its checkbox is ticked and goes with that pick. */
export function pickerValue(p: PickerView, selected: string, optionChecked: boolean): string {
  return p.option && optionChecked && p.option.for === selected ? `${selected}:${p.option.id}` : selected
}

const phrase = (label: string): string => label === 'Single PR' ? 'a single PR' : label.replace(/^\w/, (c) => c.toLowerCase())

export function workflowCard(item: InboxItem): WorkflowCardView {
  const pick = (item.actions ?? []).find((a) => a.choices?.length)
  return {
    pinned: item.kind === 'feature',
    heading: item.title ?? 'Ticket',
    body: item.message ?? '',
    picker: pick ? {
      action: pick.id,
      choices: pick.choices!.map((c) => ({
        value: c.value, note: c.note ?? '', misfit: c.misfit ?? null, name: phrase(c.label),
        label: `${c.label}${c.recommended ? ' ★ recommended' : ''}${c.misfit ? ' (re-plans)' : ''}`,
      })),
      selected: pick.selected ?? pick.choices![0]!.value,
      option: pick.option ?? null,
    } : null,
    buttons: (item.actions ?? []).map((a): WorkflowButton => a.needsValue
      ? { id: a.id, label: a.label, primary: !!a.primary, input: 'value', min: a.needsValue.min, max: a.needsValue.max, value: a.needsValue.value }
      : { id: a.id, label: a.label, primary: !!a.primary, input: a.needsText ? 'text' : 'none' }),
  }
}

/** Feature cards first, each ticket's progress at a glance; everything else in its own order. */
export function orderCards(items: InboxItem[]): InboxItem[] {
  return [...items.filter((i) => i.kind === 'feature'), ...items.filter((i) => i.kind !== 'feature')]
}

/** What a card shows; a card whose signature changed is drawn again. */
export function cardSignature(item: InboxItem): string {
  return JSON.stringify([item.kind, item.title ?? null, item.message ?? null, item.actions ?? null])
}

/* ---------- the stack rail and tab badges ---------- */

/** "2/5" on a ticket's tab: PRs reviewed or further, of all; its phase until it has a plan. */
export function tabBadges(tickets: TicketView[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of tickets) if (t.projectId) out[t.projectId] = t.total ? `${t.done}/${t.total}` : t.phase.replace('-', ' ')
  return out
}

export interface RailChip {
  key: string
  title: string
  /** What the user reads on the chip: its status, or what it is doing. */
  label: string
  status: PrStatus
  /** What holds it, in words. */
  marks: string[]
  /** What it sits on. */
  on: string
  /** The coder's tile, to focus on a click. */
  slot: number | null
  prUrl: string | null
  /** It sits on the chip before it (a stack): drawn joined to it. */
  joined: boolean
  /** In a single PR: its commit is exactly what was reviewed and tested; null before it is assembled. */
  verified: boolean | null
}

/**
 * A repo's row of the work view: a stack (units joined bottom up), units
 * side by side on the base (independent), or one PR of a commit per unit
 * (single), then its integration check and any final or single PR.
 */
export interface WorkRow {
  repo: string
  base: string
  shape: 'stack' | 'side' | 'single'
  chips: RailChip[]
  integration: { state: 'waiting' | 'running' | 'passing' | 'failing' | 'conflict'; label: string } | null
  combined: { branch: string; label: string; prUrl: string | null } | null
}

const INTEGRATION_LABEL = {
  waiting: 'to test together', running: 'testing together', passing: 'tested together', failing: 'fails together', conflict: 'units conflict',
} as const

const COMBINED_LABEL = { local: 'not pushed yet', pushed: 'open', merged: 'merged' } as const

/** The work view's heading: the ticket, how it lands, and where it is. */
export function workTitle(t: TicketView): string {
  const name = t.strategy ? STRATEGY_NAMES[t.strategy].replace(/^\w/, (c) => c.toLowerCase()) : null
  return [t.localKey, ...(name ? [name] : []), t.phase.replace('-', ' ')].join(' · ')
}

const STATUS_LABEL: Record<PrStatus, string> = {
  planned: 'planned', coding: 'coding', 'tests-passing': 'tests passing', 'in-review': 'in review',
  'review-clean': 'review clean', pushed: 'pushed', merged: 'merged',
}

/** One row per repo that has units, each a chip, bottom up as the plan has them. */
export function workRows(t: TicketView): WorkRow[] {
  return t.repos.filter((r) => r.prs.length).map((r) => ({
    repo: r.id,
    base: r.baseBranch,
    shape: t.strategy === 'single' ? 'single' : t.strategy === 'independent' ? 'side' : 'stack',
    integration: r.integration ? { state: r.integration.status, label: INTEGRATION_LABEL[r.integration.status] } : null,
    combined: r.combined ? {
      branch: r.combined.branch, prUrl: r.combined.prUrl,
      label: t.strategy === 'single' ? COMBINED_LABEL[r.combined.status] === 'open' ? 'PR open' : COMBINED_LABEL[r.combined.status]
        : `final PR ${COMBINED_LABEL[r.combined.status]}`,
    } : null,
    chips: r.prs.map((p, n): RailChip => ({
      key: p.key, title: p.title, status: p.status, on: p.on, slot: p.slot, prUrl: p.prUrl,
      joined: t.strategy !== 'independent' && n > 0 && r.prs[n - 1]!.key === p.on,
      verified: r.combined?.commits.find((c) => c.unit === p.index)?.verified ?? null,
      label: p.reviewing ? 'being reviewed' : p.queued ? 'queued'
        : p.work === 'restacking' ? 'restacking'
        : p.work === 'pushing' ? 'pushing' : p.work === 'fixing' ? 'fixing' : STATUS_LABEL[p.status],
      marks: [
        ...(p.needsRestack ? ['needs restack'] : []),
        ...(p.blocked ? [`stuck: ${p.blocked}`] : []),
        ...(p.paused ? ['paused'] : []),
      ],
    })),
  }))
}

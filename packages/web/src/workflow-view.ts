import type { InboxItem } from '@tring/shared/protocol'
import { MAX_AGENTS, MIN_AGENTS, type PrStatus, type TicketView, type WorkflowSettings } from '@tring/shared/workflow'

/** What Settings → Workflow shows: pure, so it is tested without a page (workflow-settings.ts draws it). */

type Key = keyof WorkflowSettings

export interface WorkflowControl {
  key: Key
  kind: 'toggle' | 'choice' | 'slider'
  label: string
  hint: string
  value: boolean | string | number | null
  options?: Array<{ value: string; label: string }>
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
    later({ key: 'maxPrLines', kind: 'slider', value: s.maxPrLines, label: 'Max PR size', hint: 'Coming later.' }),
    later({ key: 'testFirst', kind: 'toggle', value: s.testFirst, label: 'Test-first', hint: 'Coming later.' }),
    later({ key: 'integrationCheck', kind: 'toggle', value: s.integrationCheck, label: 'Integration check', hint: 'Coming later.' }),
  )
  return out
}


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
  buttons: WorkflowButton[]
}

export function workflowCard(item: InboxItem): WorkflowCardView {
  return {
    pinned: item.kind === 'feature',
    heading: item.title ?? 'Ticket',
    body: item.message ?? '',
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
}

export interface RailRow {
  repo: string
  base: string
  chips: RailChip[]
}

const STATUS_LABEL: Record<PrStatus, string> = {
  planned: 'planned', coding: 'coding', 'tests-passing': 'tests passing', 'in-review': 'in review',
  'review-clean': 'review clean', pushed: 'pushed', merged: 'merged',
}

/** One row per repo that has PRs, each PR a chip, bottom up as the plan has them. */
export function railRows(t: TicketView): RailRow[] {
  return t.repos.filter((r) => r.prs.length).map((r) => ({
    repo: r.id,
    base: r.baseBranch,
    chips: r.prs.map((p): RailChip => ({
      key: p.key, title: p.title, status: p.status, on: p.on, slot: p.slot, prUrl: p.prUrl,
      label: p.reviewing ? 'being reviewed' : p.queued ? 'queued'
        : p.work === 'restacking' ? 'restacking' : p.work === 'checking-lane' ? 'testing the lane'
        : p.work === 'pushing' ? 'pushing' : p.work === 'fixing' ? 'fixing' : STATUS_LABEL[p.status],
      marks: [
        ...(p.needsRestack ? ['needs restack'] : []),
        ...(p.blocked ? [`stuck: ${p.blocked}`] : []),
        ...(p.paused ? ['paused'] : []),
      ],
    })),
  }))
}

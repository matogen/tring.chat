import { describe, it, expect } from 'vitest'
import { DEFAULT_WORKFLOW } from '@tring/shared/workflow'
import { pickerLabel, pickerValue, workflowControls } from '../src/workflow-view.ts'

const on = { ...DEFAULT_WORKFLOW, multiPr: true }

describe('Settings → Workflow', () => {
  it('shows only the switch while the workflow is off', () => {
    const controls = workflowControls(DEFAULT_WORKFLOW)
    expect(controls.map((c) => c.key)).toEqual(['multiPr'])
    expect(controls[0]).toMatchObject({ kind: 'toggle', value: false, disabled: false, label: 'Multi-PR workflow' })
  })

  it('shows its options once it is on, the later ones greyed', () => {
    const controls = workflowControls(on)
    expect(controls.map((c) => c.key)).toEqual([
      'multiPr', 'defaultStrategy', 'combinedPr', 'requireFreshReview', 'autoRestack', 'maxAgents', 'integrationCheck',
      'models', 'models', 'models', 'models', 'maxPrLines', 'testFirst',
    ])
    const later = controls.filter((c) => c.later).map((c) => c.key)
    expect(later).toEqual(['maxPrLines', 'testFirst'])
    for (const c of controls) expect(c.disabled).toBe(c.later)
  })

  it('offers the agents slider from 4 to 16 at its current value', () => {
    const slider = workflowControls({ ...on, maxAgents: 9 }).find((c) => c.key === 'maxAgents')!
    expect(slider).toMatchObject({ kind: 'slider', min: 4, max: 16, value: 9 })
  })

  it('offers a model and an effort for each agent role, the Claude Code default first', () => {
    const models = workflowControls({ ...on, models: { ...on.models, reviewer: { model: 'opus', effort: 'xhigh' } } })
      .filter((c) => c.key === 'models')
    expect(models.map((c) => [c.role, c.label])).toEqual([
      ['planner', 'Planner'], ['coder', 'Coders'], ['reviewer', 'Reviewers'], ['integrator', 'Integration checks'],
    ])
    expect(models[2]).toMatchObject({ kind: 'model', value: { model: 'opus', effort: 'xhigh' } })
    expect(models[0]!.options!.map((o) => o.value)).toEqual(['', 'fable', 'opus', 'sonnet', 'haiku'])
    expect(models[0]!.efforts!.map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('offers restacking as a choice between offering and doing it', () => {
    const choice = workflowControls({ ...on, autoRestack: 'auto' }).find((c) => c.key === 'autoRestack')!
    expect(choice).toMatchObject({ kind: 'choice', value: 'auto' })
    expect(choice.options?.map((o) => o.value)).toEqual(['offer', 'auto'])
  })
})

import type { InboxItem } from '@tring/shared/protocol'
import { cardSignature, orderCards, workflowCard } from '../src/workflow-view.ts'

const item = (over: Partial<InboxItem>): InboxItem => ({ id: 'x', sessionId: '', kind: 'workflow', createdAt: 0, ...over })

describe('the plan card\'s strategy picker', () => {
  const plan = {
    id: 't1:plan:v1', sessionId: '', kind: 'workflow' as const, createdAt: 0, ticketId: 't1', title: 'Plan', message: 'x',
    actions: [
      {
        id: 'approve', label: 'Approve plan', primary: true, selected: 'stacked',
        choices: [
          { value: 'independent', label: 'Independent PRs', note: 'needs a re-plan', misfit: 'PR 2 sits on PR 1.' },
          { value: 'stacked', label: 'Stacked PRs', recommended: true, note: 'two PRs', misfit: null },
          { value: 'single', label: 'Single PR', note: 'one PR', misfit: null },
        ],
        option: { id: 'combined', label: 'Final combined PR', for: 'independent', checked: false },
      },
      { id: 'revise', label: 'Change…', needsText: true },
    ],
  }

  it('shows the picker above the buttons, the recommendation marked, the pre-selected one picked', () => {
    const v = workflowCard(plan)
    expect(v.picker).toMatchObject({ action: 'approve', selected: 'stacked' })
    expect(v.picker!.choices.map((c) => c.label)).toEqual(['Independent PRs (re-plans)', 'Stacked PRs ★ recommended', 'Single PR'])
    expect(v.buttons.map((b) => b.id)).toEqual(['approve', 'revise'])
  })

  it('says Approve plan, or Re-plan as … for a pick the plan does not fit', () => {
    const p = workflowCard(plan).picker!
    expect(pickerLabel(p, 'stacked')).toBe('Approve plan')
    expect(pickerLabel(p, 'independent')).toBe('Re-plan as independent PRs')
  })

  it('sends the pick, with the final PR only for independent PRs', () => {
    const p = workflowCard(plan).picker!
    expect(pickerValue(p, 'stacked', true)).toBe('stacked')
    expect(pickerValue(p, 'independent', false)).toBe('independent')
    expect(pickerValue(p, 'independent', true)).toBe('independent:combined')
  })
})

describe('workflow cards', () => {
  it('puts each ticket\'s feature card first, and leaves every other card where it was', () => {
    const order = orderCards([
      item({ id: 'perm', kind: 'permission', createdAt: 1 }),
      item({ id: 'plan', createdAt: 2 }),
      item({ id: 'feat', kind: 'feature', createdAt: 3 }),
      item({ id: 'reply', kind: 'reply', createdAt: 4 }),
    ])
    expect(order.map((i) => i.id)).toEqual(['feat', 'perm', 'plan', 'reply'])
  })

  it('turns actions into buttons that say what they need first', () => {
    const v = workflowCard(item({
      title: 'Plan for CHV-9: 3 PR(s)', message: '**CHV-9-1** table',
      actions: [
        { id: 'approve', label: 'Approve', primary: true },
        { id: 'revise', label: 'Change…', needsText: true },
        { id: 'agents', label: 'Agents', needsValue: { min: 4, max: 16, value: 6 } },
      ],
    }))
    expect(v).toEqual({
      pinned: false, heading: 'Plan for CHV-9: 3 PR(s)', body: '**CHV-9-1** table', picker: null,
      buttons: [
        { id: 'approve', label: 'Approve', primary: true, input: 'none' },
        { id: 'revise', label: 'Change…', primary: false, input: 'text' },
        { id: 'agents', label: 'Agents', primary: false, input: 'value', min: 4, max: 16, value: 6 },
      ],
    })
    expect(workflowCard(item({ kind: 'feature', title: 'CHV-9 Orders' })).pinned).toBe(true)
  })

  it('changes its signature when what the card shows changes, and only then', () => {
    const a = item({ title: 't', message: 'building · 10 %', actions: [] })
    expect(cardSignature(a)).toBe(cardSignature({ ...a, createdAt: 99 }))
    expect(cardSignature(a)).not.toBe(cardSignature({ ...a, message: 'building · 20 %' }))
    expect(cardSignature(a)).not.toBe(cardSignature({ ...a, actions: [{ id: 'push', label: 'Push' }] }))
  })
})

import type { TicketView } from '@tring/shared/workflow'
import { railRows, tabBadges } from '../src/workflow-view.ts'

const pr = (over: Partial<TicketView['repos'][number]['prs'][number]> & { index: number }): TicketView['repos'][number]['prs'][number] => ({
  key: `CHV-9-${over.index}`, title: `PR ${over.index}`, status: 'planned', on: 'develop', branch: 'b', prUrl: null, work: 'idle',
  reviewing: false, queued: false, needsRestack: false, blocked: null, paused: false, slot: null, ...over,
})
const view = (prs: TicketView['repos'][number]['prs']): TicketView => ({
  id: 't1', localKey: 'CHV-9', title: 'Orders', projectId: 'p1', phase: 'building', done: 1, total: 3,
  repos: [{ id: 'api', baseBranch: 'develop', prs }, { id: 'web', baseBranch: 'develop', prs: [] }],
})

describe('the stack rail and tab badge', () => {
  it('badges a ticket\'s tab with how many PRs are reviewed of all', () => {
    expect(tabBadges([view([])])).toEqual({ p1: '1/3' })
    expect(tabBadges([{ ...view([]), total: 0, phase: 'planning' }])).toEqual({ p1: 'planning' })
  })

  it('draws a row per repo with PRs, bottom up, each with its status and what holds it', () => {
    const rows = railRows(view([
      pr({ index: 1, status: 'review-clean', slot: 2 }),
      pr({ index: 2, status: 'coding', on: 'CHV-9-1', work: 'coding', needsRestack: true, slot: 3 }),
      pr({ index: 3, status: 'planned', on: 'CHV-9-2', queued: true }),
      pr({ index: 4, status: 'in-review', reviewing: true, blocked: 'conflict in a.ts' }),
    ]))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.repo).toBe('api')
    expect(rows[0]!.chips.map((c) => [c.key, c.label, c.marks, c.slot])).toEqual([
      ['CHV-9-1', 'review clean', [], 2],
      ['CHV-9-2', 'coding', ['needs restack'], 3],
      ['CHV-9-3', 'queued', [], null],
      ['CHV-9-4', 'being reviewed', ['stuck: conflict in a.ts'], null],
    ])
    expect(rows[0]!.chips[1]!.on).toBe('CHV-9-1')
  })
})

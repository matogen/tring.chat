import { describe, it, expect } from 'vitest'
import { DEFAULT_WORKFLOW } from '@tring/shared/workflow'
import { workflowControls } from '../src/workflow-view.ts'

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
      'multiPr', 'requireFreshReview', 'autoRestack', 'maxAgents', 'maxPrLines', 'testFirst', 'integrationCheck',
    ])
    const later = controls.filter((c) => c.later).map((c) => c.key)
    expect(later).toEqual(['maxPrLines', 'testFirst', 'integrationCheck'])
    for (const c of controls) expect(c.disabled).toBe(c.later)
  })

  it('offers the agents slider from 4 to 16 at its current value', () => {
    const slider = workflowControls({ ...on, maxAgents: 9 }).find((c) => c.key === 'maxAgents')!
    expect(slider).toMatchObject({ kind: 'slider', min: 4, max: 16, value: 9 })
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
      pinned: false, heading: 'Plan for CHV-9: 3 PR(s)', body: '**CHV-9-1** table',
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

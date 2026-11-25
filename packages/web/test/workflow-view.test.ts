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

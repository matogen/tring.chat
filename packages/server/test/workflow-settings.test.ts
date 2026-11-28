import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WorkflowSettingsStore } from '../src/workflow/settings.ts'

async function store(contents?: string): Promise<{ s: WorkflowSettingsStore; file: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-workflow-'))
  const file = path.join(dir, 'workflow.json')
  if (contents !== undefined) await writeFile(file, contents, 'utf8')
  const s = new WorkflowSettingsStore(file)
  await s.load()
  return { s, file }
}

describe('workflow settings', () => {
  it('starts with the multi-PR workflow off, and its sub-options at their defaults', async () => {
    const { s } = await store()
    expect(s.get()).toEqual({
      multiPr: false,
      requireFreshReview: true,
      autoRestack: 'offer',
      maxAgents: 4,
      maxPrLines: null,
      testFirst: false,
      integrationCheck: true,
      defaultStrategy: 'auto',
      combinedPr: false,
      models: {
        planner: { model: null, effort: null },
        coder: { model: null, effort: null },
        reviewer: { model: null, effort: null },
        integrator: { model: null, effort: null },
      },
    })
  })

  it('turns it on and remembers that across a restart', async () => {
    const { s, file } = await store()
    expect((await s.update({ multiPr: true })).multiPr).toBe(true)
    const again = new WorkflowSettingsStore(file)
    await again.load()
    expect(again.get().multiPr).toBe(true)
    expect(JSON.parse(await readFile(file, 'utf8')).multiPr).toBe(true)
  })

  it('changes only what the patch names', async () => {
    const { s } = await store()
    await s.update({ multiPr: true, maxAgents: 9 })
    const next = await s.update({ autoRestack: 'auto' })
    expect(next).toMatchObject({ multiPr: true, maxAgents: 9, autoRestack: 'auto', requireFreshReview: true })
  })

  it('keeps the agents slider within 4 to 16, in whole agents', async () => {
    const { s } = await store()
    expect((await s.update({ maxAgents: 2 })).maxAgents).toBe(4)
    expect((await s.update({ maxAgents: 40 })).maxAgents).toBe(16)
    expect((await s.update({ maxAgents: 7.6 })).maxAgents).toBe(8)
  })

  it('ignores values of the wrong kind and keys it does not know', async () => {
    const { s } = await store()
    const next = await s.update({ multiPr: 'yes', autoRestack: 'sometimes', maxAgents: 'many', shell: 'rm -rf /' })
    expect(next).toEqual(s.get())
    expect(next.multiPr).toBe(false)
    expect(next.autoRestack).toBe('offer')
    expect(next.maxAgents).toBe(4)
    expect('shell' in next).toBe(false)
  })

  it('reads a damaged or foreign file as the defaults, field by field', async () => {
    expect((await store('not json')).s.get().multiPr).toBe(false)
    expect((await store('[1,2]')).s.get().maxAgents).toBe(4)
    const partial = (await store(JSON.stringify({ multiPr: true, maxAgents: 99, autoRestack: 7 }))).s.get()
    expect(partial).toMatchObject({ multiPr: true, maxAgents: 16, autoRestack: 'offer' })
  })
})

describe('workflow settings: strategy and models', () => {
  it('takes a default strategy, which only pre-selects one on the plan card', async () => {
    const { s } = await store()
    expect((await s.update({ defaultStrategy: 'single' })).defaultStrategy).toBe('single')
    expect((await s.update({ defaultStrategy: 'sideways' })).defaultStrategy).toBe('single')
    expect((await s.update({ defaultStrategy: 'auto', combinedPr: true })).combinedPr).toBe(true)
  })

  it('sets a model and effort per role, one role at a time, and null puts the Claude Code default back', async () => {
    const { s } = await store()
    await s.update({ models: { coder: { model: 'sonnet', effort: 'high' } } })
    const next = await s.update({ models: { reviewer: { model: 'claude-opus-5-5' }, coder: { effort: null } } })
    expect(next.models).toEqual({
      planner: { model: null, effort: null },
      coder: { model: 'sonnet', effort: null },
      reviewer: { model: 'claude-opus-5-5', effort: null },
      integrator: { model: null, effort: null },
    })
  })

  it('refuses a model name that is not one, since it ends up on a command line', async () => {
    const { s } = await store()
    for (const bad of ['sonnet; rm -rf ~', 'opus && x', '"opus"', '', ' ', 'a b', '$(id)', 'x'.repeat(81)]) {
      expect((await s.update({ models: { coder: { model: bad } } })).models.coder.model).toBeNull()
    }
    expect((await s.update({ models: { coder: { effort: 'maximum' } } })).models.coder.effort).toBeNull()
    expect((await s.update({ models: { coder: { model: 'opus[1m]', effort: 'max' } } })).models.coder).toEqual({ model: 'opus[1m]', effort: 'max' })
  })
})

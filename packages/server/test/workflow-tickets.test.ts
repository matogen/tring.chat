import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Plan, StackPr } from '@tring/shared/workflow'
import { TicketStore } from '../src/workflow/tickets.ts'

async function open(dir?: string): Promise<{ store: TicketStore; dir: string }> {
  const d = dir ?? await mkdtemp(path.join(os.tmpdir(), 'tring-tickets-'))
  const store = new TicketStore(path.join(d, 'tickets.json'), path.join(d, 'tickets'), () => 1_700_000_000_000)
  await store.load()
  return { store, dir: d }
}

const spec = {
  key: 'CHV-3193', title: 'Orders page', text: 'As a user I want to see my orders.', source: 'goby',
  repos: [{ id: 'api', root: '/src/api', baseBranch: 'develop' }], maxAgents: 4,
}

const plan: Plan = {
  version: 1, summary: 'Table then page', shared: [], interfaces: [], deployOrder: null, addRepos: [],
  docs: { none: 'internal' },
  prs: [{
    index: 1, repo: 'api', below: null, title: 'Orders table', scope: 'The orders table and its migration.',
    owns: ['db/**'], uses: [], tests: { add: ['test/orders.test.ts'], run: ['npm test'] }, acceptance: ['the table exists'],
  }],
}

const stackPr: StackPr = {
  index: 1, branch: 'feature/CHV-3193-1-orders-table', worktree: '/src/api.worktrees/x', status: 'coding',
  work: 'coding', reviewing: false, paused: false, restack: null, pushAllowed: false, lastActivity: 0, heldRounds: 0,
  coder: null, coderConversation: null,
  flags: { needsRestack: false, baseFailing: false, blocked: null, interfaceReady: false, failing: false },
  baseSha: null, headSha: null, review: null, prUrl: null,
}

describe('TicketStore', () => {
  it('keeps a ticket from a tracker under its own key, and across a restart', async () => {
    const { store, dir } = await open()
    const t = await store.create(spec)
    expect(t).toMatchObject({ key: 'CHV-3193', localKey: 'CHV-3193', phase: 'planning', prs: [], plan: null, maxAgents: 4 })
    const again = (await open(dir)).store
    expect(again.get(t.id)).toEqual(t)
  })

  it('gives a ticket started from an idea a local key, TRING-1, TRING-2…, counted across restarts', async () => {
    const { store, dir } = await open()
    expect((await store.create({ ...spec, key: null })).localKey).toBe('TRING-1')
    expect((await store.create({ ...spec, key: null })).localKey).toBe('TRING-2')
    const again = (await open(dir)).store
    expect((await again.create({ ...spec, key: null })).localKey).toBe('TRING-3')
  })

  it('saves every change', async () => {
    const { store, dir } = await open()
    const t = await store.create(spec)
    await store.update(t.id, (x) => { x.phase = 'awaiting-approval'; x.plan = plan })
    expect((await open(dir)).store.get(t.id)).toMatchObject({ phase: 'awaiting-approval', plan: { summary: 'Table then page' } })
  })

  it('writes the ticket as markdown, and one local ticket per PR once the plan is approved', async () => {
    const { store, dir } = await open()
    const t = await store.create(spec)
    expect(await readdir(path.join(dir, 'tickets', 'CHV-3193'))).toEqual(['CHV-3193.md'])

    await store.update(t.id, (x) => {
      x.plan = plan
      x.phase = 'building'
      x.prs = [stackPr]
      x.log.push({ at: 1_700_000_000_000, pr: 1, who: 'coder', text: 'interface ready: orders(id, total)' })
    })
    const files = await readdir(path.join(dir, 'tickets', 'CHV-3193'))
    expect(files.sort()).toEqual(['CHV-3193-1.md', 'CHV-3193.md'])
    const local = await readFile(path.join(dir, 'tickets', 'CHV-3193', 'CHV-3193-1.md'), 'utf8')
    expect(local).toContain('# CHV-3193-1 Orders table')
    expect(local).toContain('The orders table and its migration.')
    expect(local).toContain('db/**')
    expect(local).toContain('npm test')
    expect(local).toContain('the table exists')
    expect(local).toContain('coding')
    expect(local).toContain('feature/CHV-3193-1-orders-table')
    expect(local).toContain('interface ready: orders(id, total)')
    const parent = await readFile(path.join(dir, 'tickets', 'CHV-3193', 'CHV-3193.md'), 'utf8')
    expect(parent).toContain('As a user I want to see my orders.')
    expect(parent).toContain('CHV-3193-1')
  })

  it('keeps a key that is not a safe directory name out of other directories', async () => {
    const { store, dir } = await open()
    await store.create({ ...spec, key: '../../etc/CHV 1' })
    const dirs = await readdir(path.join(dir, 'tickets'))
    expect(dirs).toEqual(['etc-CHV-1'])
  })

  it('starts empty from a damaged file, and drops tickets it cannot read', async () => {
    const { dir } = await open()
    await writeFile(path.join(dir, 'tickets.json'), 'garbage', 'utf8')
    expect((await open(dir)).store.list()).toEqual([])

    const good = (await open()).store
    const t = await good.create(spec)
    const file = path.join(dir, 'tickets.json')
    await writeFile(file, JSON.stringify({ version: 1, nextLocal: 5, tickets: [t, { id: 3 }, null] }), 'utf8')
    const read = (await open(dir)).store
    expect(read.list().map((x) => x.id)).toEqual([t.id])
    expect((await read.create({ ...spec, key: null })).localKey).toBe('TRING-5')
  })

  it('starts a ticket with no strategy, and reads one saved before strategies as stacked once approved', async () => {
    const { store, dir } = await open()
    const fresh = await store.create(spec)
    expect(fresh).toMatchObject({ strategy: null, combinedPr: false, integration: {}, combined: {}, followUps: [] })
    const old = (over: Record<string, unknown>) => {
      const t: Record<string, unknown> = { ...fresh, ...over }
      for (const k of ['strategy', 'combinedPr', 'integration', 'combined', 'followUps']) delete t[k]
      return t
    }
    await writeFile(path.join(dir, 'tickets.json'), JSON.stringify({
      version: 1, nextLocal: 2,
      tickets: [old({ id: 'a', phase: 'building', prs: [stackPr] }), old({ id: 'b', phase: 'awaiting-approval', plan })],
    }), 'utf8')
    const read = (await open(dir)).store
    expect(read.get('a')).toMatchObject({ strategy: 'stacked', combinedPr: false, integration: {}, combined: {}, followUps: [] })
    expect(read.get('b')!.strategy).toBeNull()
  })
})

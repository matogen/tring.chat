import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { InboxItem } from '@tring/shared/protocol'
import { asSaved, CardStore, restoreCards, type LiveTile, type SavedCard, type TileRef } from '../src/card-store.ts'
import { parseChoices } from '../../web/src/choices.ts'

const CONV_A = '11111111-1111-4111-8111-111111111111'
const CONV_B = '22222222-2222-4222-8222-222222222222'

const reply = (id: string, sessionId: string, message = 'Done. Ship it?'): InboxItem =>
  ({ id, sessionId, kind: 'reply', createdAt: 1000, message })

async function store(where: Record<string, TileRef | null>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-cards-'))
  const file = path.join(dir, 'inbox.json')
  return { file, cards: new CardStore(file, (id) => where[id] ?? null) }
}

describe('CardStore', () => {
  it('saves the cards and loads them back after a restart', async () => {
    const { file, cards } = await store({ s1: { projectId: 'p', slot: 3, claudeId: CONV_A } })
    await cards.save([reply('c1', 's1')])

    const again = new CardStore(file, () => null)
    expect(await again.load()).toEqual([
      { item: reply('c1', 's1'), tile: { projectId: 'p', slot: 3, claudeId: CONV_A } },
    ])
  })

  it('leaves out a card whose tile is gone or has no conversation to reopen', async () => {
    const { file, cards } = await store({ s1: { projectId: 'p', slot: 1, claudeId: CONV_A }, s2: null })
    await cards.save([reply('c1', 's1'), reply('c2', 's2'), reply('c3', 'gone')])
    expect((await new CardStore(file, () => null).load()).map((c) => c.item.id)).toEqual(['c1'])
  })

  it('saves nothing once shutdown has started, so tiles ending do not empty it', async () => {
    const { file, cards } = await store({ s1: { projectId: 'p', slot: 1, claudeId: CONV_A } })
    await cards.save([reply('c1', 's1')])
    await cards.close()
    // What stopping the daemon does to the inbox: every tile exits.
    await cards.save([])
    expect((await new CardStore(file, () => null).load()).map((c) => c.item.id)).toEqual(['c1'])
  })

  it('keeps the latest of several quick saves', async () => {
    const { file, cards } = await store({ s1: { projectId: 'p', slot: 1, claudeId: CONV_A } })
    void cards.save([reply('c1', 's1')])
    void cards.save([reply('c1', 's1'), reply('c2', 's1')])
    await cards.save([reply('c2', 's1')])
    expect((await new CardStore(file, () => null).load()).map((c) => c.item.id)).toEqual(['c2'])
  })

  it('starts empty from a missing, broken or foreign file, and skips bad entries', async () => {
    const { file, cards } = await store({})
    expect(await cards.load()).toEqual([])
    await writeFile(file, '{not json')
    expect(await cards.load()).toEqual([])
    await writeFile(file, JSON.stringify({ version: 2, cards: [] }))
    expect(await cards.load()).toEqual([])
    const good: SavedCard = { item: reply('c1', 's1'), tile: { projectId: 'p', slot: 1, claudeId: CONV_A } }
    await writeFile(file, JSON.stringify({ version: 1, cards: [
      good,
      { item: { ...reply('c2', 's1'), kind: 'permission' }, tile: good.tile },
      { item: reply('c3', 's1'), tile: { projectId: 'p', slot: 1, claudeId: '' } },
      { item: reply('c4', 's1') },
      null,
    ] }))
    expect(await cards.load()).toEqual([good])
  })

  it('writes the file private to the user', async () => {
    if (process.platform === 'win32') return // No POSIX modes to check.
    const { file, cards } = await store({ s1: { projectId: 'p', slot: 1, claudeId: CONV_A } })
    await cards.save([reply('c1', 's1')])
    const { stat } = await import('node:fs/promises')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('writes plain JSON a person can read', async () => {
    const { file, cards } = await store({ s1: { projectId: 'p', slot: 1, claudeId: CONV_A } })
    await cards.save([reply('c1', 's1', 'All green.')])
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, cards: [{ item: { message: 'All green.' } }] })
  })
})

describe('restoreCards', () => {
  const saved = (id: string, slot: number, claudeId: string, projectId = 'p'): SavedCard =>
    ({ item: reply(id, `old-${id}`), tile: { projectId, slot, claudeId } })
  const tile = (id: string, slot: number, conv: string | null): LiveTile =>
    ({ id, slot, claude: conv ? { id: conv } : null })

  it('puts each card on the tile that reopened its conversation, under its new session id', () => {
    const tiles = [tile('new-1', 1, CONV_A), tile('new-2', 2, CONV_B)]
    const out = restoreCards([saved('c1', 1, CONV_A), saved('c2', 2, CONV_B)], () => tiles)
    expect(out.map((i) => [i.id, i.sessionId])).toEqual([['c1', 'new-1'], ['c2', 'new-2']])
  })

  it('follows the conversation when the card remembered an old slot', () => {
    const out = restoreCards([saved('c1', 5, CONV_A)], () => [tile('new-9', 9, CONV_A)])
    expect(out.map((i) => i.sessionId)).toEqual(['new-9'])
  })

  it('prefers the card slot when two tiles reopen the same conversation', () => {
    const out = restoreCards([saved('c1', 2, CONV_A)], () => [tile('t1', 1, CONV_A), tile('t2', 2, CONV_A)])
    expect(out.map((i) => i.sessionId)).toEqual(['t2'])
  })

  it('drops a card whose conversation no tile reopens, or whose project is gone', () => {
    const out = restoreCards(
      [saved('c1', 1, CONV_A), saved('c2', 2, CONV_B, 'deleted')],
      (projectId) => projectId === 'p' ? [tile('t1', 1, CONV_B), tile('t2', 2, null)] : [],
    )
    expect(out).toEqual([])
  })

  it('asks for the tiles by the card’s project and conversation', () => {
    const asked: string[] = []
    restoreCards([saved('c1', 1, CONV_A, 'p2')], (p, c) => { asked.push(`${p}:${c}`); return [] })
    expect(asked).toEqual([`p2:${CONV_A}`])
  })
})

describe('asSaved', () => {
  const base = { id: 'c1', sessionId: 's1', createdAt: 5 }

  it('keeps a reply card as it is', () => {
    expect(asSaved({ ...base, kind: 'reply', message: 'Done.' })).toEqual({ ...base, kind: 'reply', message: 'Done.' })
  })

  it('turns a question into a reply card that still offers its options as buttons', () => {
    const out = asSaved({
      ...base, kind: 'question', tool: 'AskUserQuestion', input: { questions: [] },
      questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }] }],
    })
    expect(out).toMatchObject({ ...base, kind: 'reply', interrupted: 'question' })
    expect(out.input).toBeUndefined()
    expect(out.message).toContain('Which DB?')
    const qs = parseChoices(out.message!)
    expect(qs).toHaveLength(1)
    expect(qs[0]!.options.map((o) => o.label)).toEqual(['Postgres — relational', 'SQLite'])
  })

  it('numbers several questions so each gets its own buttons', () => {
    const out = asSaved({
      ...base, kind: 'question',
      questions: [
        { question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
        { question: 'Pick the runtimes', multiSelect: true, options: [{ label: 'Node' }, { label: 'Bun' }] },
      ],
    })
    const qs = parseChoices(out.message!)
    expect(qs.map((q) => [q.id, q.title, q.options.length])).toEqual([['Q1', 'Which DB?', 2], ['Q2', 'Pick the runtimes (choose any)', 2]])
  })

  it('turns a permission prompt into a reply card saying what it wanted to do', () => {
    const out = asSaved({ ...base, kind: 'permission', tool: 'Bash', input: { command: 'npm publish', description: 'Publish' } })
    expect(out).toMatchObject({ ...base, kind: 'reply', interrupted: 'permission' })
    expect(out.tool).toBeUndefined()
    expect(out.message).toContain('permission to run a command')
    expect(out.message).toContain('```\nnpm publish\n```')
    expect(out.message).toContain('did not go ahead')
  })

  it('fences a command that has fences of its own without letting it break out', () => {
    const out = asSaved({ ...base, kind: 'permission', tool: 'Bash', input: { command: 'echo ```\n# heading' } })
    expect(out.message).toContain('````\necho ```\n# heading\n````')
  })

  it('cuts a huge input short', () => {
    const out = asSaved({ ...base, kind: 'permission', tool: 'mcp__x__y', input: { blob: 'z'.repeat(50_000) } })
    expect(out.message!.length).toBeLessThan(3000)
    expect(out.message).toContain('more characters')
  })

  it('shows the file a Write wanted, not its contents', () => {
    const out = asSaved({ ...base, kind: 'permission', tool: 'Write', input: { file_path: '/a/b.ts', content: 'secret' } })
    expect(out.message).toContain('/a/b.ts')
    expect(out.message).not.toContain('secret')
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { SessionManager } from '../src/session-manager.ts'

const live: SessionManager[] = []
afterEach(() => { for (const m of live.splice(0)) m.disposeAll() })

function manager(): SessionManager {
  const m = new SessionManager({
    projectId: 'p1',
    projectName: 'demo',
    root: process.cwd(),
    url: 'http://127.0.0.1:7331',
    scrollback: 50,
    idleMs: 200,
  })
  live.push(m)
  return m
}

describe('SessionManager.respawn', () => {
  it('reports one structure change, not an empty slot followed by a new one', () => {
    const m = manager()
    const first = m.create({ slot: 3 })

    // Watching the slot from inside the notification is the client's position:
    // told the slot is empty, it blanks the terminal it was focused on.
    const seen: (string | null)[] = []
    m.onStructureChange = () => seen.push(m.at(3)?.id ?? null)

    const second = m.respawn(first.id)
    expect(seen).toEqual([second!.id])
  })

  it('keeps the slot, cwd, name and colour, and gives the new PTY a new id', () => {
    const m = manager()
    const first = m.create({ slot: 2, name: 'agent', command: 'echo hi', color: '#a06cf0' })
    const second = m.respawn(first.id)!

    expect(second.id).not.toBe(first.id)
    expect(second.slot).toBe(2)
    expect(second.name).toBe('agent')
    expect(second.color).toBe('#a06cf0')
    expect(second.command).toBe('echo hi')
    expect(m.get(first.id)).toBeUndefined()
    expect(m.at(2)).toBe(second)
  })

  it('does nothing for an id it does not hold', () => {
    const m = manager()
    let changes = 0
    m.onStructureChange = () => { changes++ }
    expect(m.respawn('nobody')).toBeUndefined()
    expect(changes).toBe(0)
  })

  it('still announces an ordinary kill, which really does empty the slot', () => {
    const m = manager()
    const s = m.create({ slot: 1 })
    const seen: (string | null)[] = []
    m.onStructureChange = () => seen.push(m.at(1)?.id ?? null)
    m.kill(s.id)
    expect(seen).toEqual([null])
  })
})

describe('SessionManager.move', () => {
  it('moves a session into an empty slot', () => {
    const m = manager()
    const s = m.create({ slot: 2 })
    m.move(s.id, 5)
    expect(s.slot).toBe(5)
    expect(m.at(5)).toBe(s)
    expect(m.at(2)).toBeUndefined()
  })

  it('swaps with whatever holds an occupied slot, in one structure change', () => {
    const m = manager()
    const a = m.create({ slot: 2 })
    const b = m.create({ slot: 5 })
    const seen: [string | undefined, string | undefined][] = []
    m.onStructureChange = () => seen.push([m.at(2)?.id, m.at(5)?.id])

    m.move(a.id, 5)
    expect([a.slot, b.slot]).toEqual([5, 2])
    expect(seen).toEqual([[b.id, a.id]])
    expect(m.list().map((s) => s.id)).toEqual([b.id, a.id])
  })

  it('does nothing for its own slot, an unknown id or an out-of-range slot', () => {
    const m = manager()
    const s = m.create({ slot: 3 })
    let changes = 0
    m.onStructureChange = () => { changes++ }

    m.move(s.id, 3)
    m.move('nobody', 4)
    m.move(s.id, 0)
    m.move(s.id, 17)
    m.move(s.id, 2.5)
    expect(changes).toBe(0)
    expect(m.at(3)).toBe(s)
  })

  it('respawns into the slot it was moved to', () => {
    const m = manager()
    const s = m.create({ slot: 1 })
    m.move(s.id, 9)
    expect(m.respawn(s.id)!.slot).toBe(9)
  })
})

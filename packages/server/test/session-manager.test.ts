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

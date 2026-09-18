import { describe, it, expect } from 'vitest'
import type { SessionInfo } from '@tring/shared/protocol'
import { followFocus } from '../src/focus-target.ts'

const session = (id: string, slot: number): SessionInfo => ({
  id,
  projectId: 'p1',
  slot,
  name: null,
  title: null,
  cwd: '/tmp',
  command: null,
  color: null,
  status: 'idle',
  since: 0,
  exitCode: null,
})

describe('followFocus', () => {
  it('leaves a focus that is still there alone', () => {
    const list = [session('a', 1), session('b', 2)]
    expect(followFocus({ id: 'a', slot: 1 }, list)).toEqual({ id: 'a', slot: 1 })
  })

  it('follows the slot when a respawn gives the session a new id', () => {
    // What a respawn looks like from the client: same slot, different id.
    const list = [session('a2', 1), session('b', 2)]
    expect(followFocus({ id: 'a', slot: 1 }, list)).toEqual({ id: 'a2', slot: 1 })
  })

  it('follows the slot after a daemon restart renames every session', () => {
    const list = [session('new1', 1), session('new2', 2)]
    expect(followFocus({ id: 'old2', slot: 2 }, list)).toEqual({ id: 'new2', slot: 2 })
  })

  it('drops the focus when the slot is empty, rather than holding a dead id', () => {
    expect(followFocus({ id: 'a', slot: 1 }, [session('b', 2)])).toBeNull()
  })

  it('drops the focus when every session is gone', () => {
    expect(followFocus({ id: 'a', slot: 1 }, [])).toBeNull()
  })

  it('does not invent a focus when there was none', () => {
    expect(followFocus(null, [session('a', 1)])).toBeNull()
  })

  it('prefers the id over the slot, so a moved session is not mistaken for an heir', () => {
    const list = [session('a', 3), session('b', 1)]
    expect(followFocus({ id: 'a', slot: 1 }, list)).toEqual({ id: 'a', slot: 1 })
  })
})

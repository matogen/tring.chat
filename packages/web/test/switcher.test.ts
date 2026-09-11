import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '@tring/shared/protocol'
import { describeSession, MOBILE_QUERY } from '../src/switcher.ts'

const session = (over: Partial<SessionInfo>): SessionInfo => ({
  id: 's1', projectId: 'p1', slot: 3, cwd: '/home/me/code/api', status: 'busy',
  since: 0, title: null, name: null, color: null, command: null, exitCode: null,
  ...over,
})

describe('describeSession', () => {
  it('shows the slot, the name and the status of the focused session', () => {
    expect(describeSession(session({ name: 'api-tests', status: 'busy' })))
      .toEqual({ key: '3', name: 'api-tests', status: 'busy' })
  })

  it('falls back to the window title, then the shell, like a tile does', () => {
    expect(describeSession(session({ title: 'vim' })).name).toBe('vim')
    expect(describeSession(session({})).name).toBe('shell')
  })

  it('invites a pick when nothing is focused', () => {
    expect(describeSession(null)).toEqual({ key: '—', name: 'pick a session', status: 'idle' })
  })
})

describe('MOBILE_QUERY', () => {
  it('is a max-width media query so tablets in portrait get the phone view too', () => {
    expect(MOBILE_QUERY).toBe('(max-width: 720px)')
  })
})

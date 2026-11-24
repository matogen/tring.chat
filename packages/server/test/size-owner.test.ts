import { describe, expect, it } from 'vitest'
import { SizeOwners } from '../src/size-owner.ts'

describe('SizeOwners', () => {
  it('gives a session\'s size to the device in use, and lets the other take it back', () => {
    const o = new SizeOwners<string>()
    expect(o.claim('s', 'pc')).toBe(true)
    expect(o.claim('s', 'pc')).toBe(false)
    expect(o.claim('s', 'phone')).toBe(true)
    expect(o.owner('s')).toBe('phone')
    expect(o.claim('s', 'pc')).toBe(true)
    expect(o.owner('s')).toBe('pc')
  })

  it('lets a passive resize through only from the owner, or for an unowned session', () => {
    const o = new SizeOwners<string>()
    expect(o.mayResize('s', 'phone')).toBe(true)
    o.claim('s', 'pc')
    expect(o.mayResize('s', 'pc')).toBe(true)
    // The phone's panel opening must not shrink the PC's terminal.
    expect(o.mayResize('s', 'phone')).toBe(false)
  })

  it('forgets a client that looks away or disconnects', () => {
    const o = new SizeOwners<string>()
    o.claim('a', 'pc')
    o.claim('b', 'pc')
    o.release('pc', 'a')
    expect(o.owner('a')).toBeUndefined()
    expect(o.owner('b')).toBe('pc')
    o.release('pc')
    expect(o.owner('b')).toBeUndefined()
  })
})

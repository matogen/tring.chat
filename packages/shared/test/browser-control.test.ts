import { describe, it, expect } from 'vitest'
import { BrowserControl } from '../src/browser-control.ts'

const c = () => new BrowserControl(0)

describe('BrowserControl', () => {
  it('starts with the agent driving', () => {
    expect(c().holder).toBe('agent')
  })

  it('an agent action runs while the agent holds the wheel', () => {
    expect(c().request('a1')).toBe('run')
  })

  it('the human grabs by touching the page', () => {
    const b = c()
    expect(b.grab(100)).toBe(true)
    expect(b.holder).toBe('human')
    expect(b.since).toBe(100)
  })

  it('a second grab is a no-op and does not restamp since', () => {
    const b = c()
    b.grab(100)
    expect(b.grab(200)).toBe(false)
    expect(b.since).toBe(100)
  })

  it('parks an agent action rather than failing it', () => {
    const b = c()
    b.grab(100)
    expect(b.request('a1')).toBe('parked')
    expect(b.parked).toBe(1)
  })

  it('releasing resumes parked actions oldest first', () => {
    const b = c()
    b.grab(100)
    b.request('a1')
    b.request('a2')
    expect(b.release(200)).toEqual(['a1', 'a2'])
    expect(b.holder).toBe('agent')
    expect(b.since).toBe(200)
    expect(b.parked).toBe(0)
  })

  it('asking twice while parked queues once — resuming twice would replay it', () => {
    const b = c()
    b.grab(100)
    b.request('a1')
    b.request('a1')
    expect(b.parked).toBe(1)
    expect(b.release(200)).toEqual(['a1'])
  })

  it('releasing when the agent already holds it resumes nothing', () => {
    expect(c().release(100)).toEqual([])
  })

  it('an abandoned action is not resumed', () => {
    const b = c()
    b.grab(100)
    b.request('a1')
    b.request('a2')
    b.abandon('a1')
    expect(b.release(200)).toEqual(['a2'])
  })

  /**
   * Reading cannot collide with a human typing, and an agent that has just been
   * handed control needs to see what it was handed (spec §4.8).
   */
  it('read-only actions run even while the human drives', () => {
    const b = c()
    b.grab(100)
    expect(b.request('snapshot', { readOnly: true })).toBe('run')
    expect(b.parked).toBe(0)
  })

  /**
   * There is deliberately no timeout that hands control back. If one is ever
   * added, this test is the thing it breaks, and it should be read before it is
   * deleted: a handback on a timer fires while someone is mid-login form.
   */
  it('never returns control on its own', () => {
    const b = c()
    b.grab(0)
    b.request('a1')
    expect(b.holder).toBe('human')
    expect(b.parked).toBe(1)
  })
})

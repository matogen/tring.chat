import { describe, it, expect } from 'vitest'
import { ActionGate, BrowserControl } from '../src/browser-control.ts'

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

/**
 * The piece that hangs an agent forever if it is wrong: a resume that misses
 * its waiter is a tool call that never returns.
 */
describe('ActionGate', () => {
  const gate = (timeoutMs = 50) => {
    const control = new BrowserControl(0)
    return { control, g: new ActionGate(control, timeoutMs) }
  }

  it('lets an action straight through while the agent drives', async () => {
    const { g } = gate()
    await expect(g.wait('a1')).resolves.toBe(true)
    expect(g.waiting).toBe(0)
  })

  it('parks while the human drives, and resolves on handback', async () => {
    const { control, g } = gate(5000)
    control.grab(100)
    const pending = g.wait('a1')
    // Let the promise park before releasing, or the test proves nothing.
    await new Promise((r) => setTimeout(r, 5))
    expect(g.waiting).toBe(1)

    g.release()
    await expect(pending).resolves.toBe(true)
    expect(g.waiting).toBe(0)
  })

  it('resumes several parked actions on one handback', async () => {
    const { control, g } = gate(5000)
    control.grab(0)
    const a = g.wait('a1')
    const b = g.wait('a2')
    await new Promise((r) => setTimeout(r, 5))
    expect(g.release()).toEqual(['a1', 'a2'])
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
  })

  /** Not an error: "still waiting" is an answer the agent can act on. */
  it('gives up after the bound rather than hanging', async () => {
    const { control, g } = gate(20)
    control.grab(0)
    await expect(g.wait('a1')).resolves.toBe(false)
    expect(g.waiting).toBe(0)
    // And is no longer queued, so a later handback does not resume a dead call.
    expect(g.release()).toEqual([])
  })

  it('read-only actions never park', async () => {
    const { control, g } = gate(5000)
    control.grab(0)
    await expect(g.wait('snapshot', { readOnly: true })).resolves.toBe(true)
  })

  /**
   * A detach must wake everything it was holding. Otherwise an agent waits on a
   * page that no longer exists until the bound expires, with no explanation.
   */
  it('wakes and refuses everything when the page goes away', async () => {
    const { control, g } = gate(5000)
    control.grab(0)
    const pending = g.wait('a1')
    await new Promise((r) => setTimeout(r, 5))
    g.abandonAll()
    await expect(pending).resolves.toBe(false)
    expect(g.waiting).toBe(0)
  })
})

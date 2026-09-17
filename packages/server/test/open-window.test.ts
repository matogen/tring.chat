import { describe, it, expect } from 'vitest'
import { awaitRelay, describeFallback, type Probe } from '../src/open-window.ts'

/** A probe that answers from a script, so the loop can be driven exactly. */
const scripted = (answers: Probe[]): [() => Promise<Probe>, () => number] => {
  let calls = 0
  return [() => { calls++; return Promise.resolve(answers.shift() ?? 'refused') }, () => calls]
}

describe('awaitRelay', () => {
  it('keeps asking while the Windows side refuses, which is the whole bug', async () => {
    // WSL mirrors the port a beat after listen(); a browser opened into that
    // gap shows ERR_CONNECTION_REFUSED before Chrome's auto-reload hides it.
    const [probe, calls] = scripted(['refused', 'refused', 'reachable'])
    expect(await awaitRelay(probe, { gapMs: 1 })).toBe('reachable')
    expect(calls()).toBe(3)
  })

  it('does not wait at all when the port is already there', async () => {
    const [probe, calls] = scripted(['reachable'])
    expect(await awaitRelay(probe, { gapMs: 1000, deadlineMs: 1000 })).toBe('reachable')
    expect(calls()).toBe(1)
  })

  it('stops on a probe it cannot run rather than respawning it in a loop', async () => {
    const [probe, calls] = scripted(['unusable'])
    expect(await awaitRelay(probe, { gapMs: 1 })).toBe('unusable')
    expect(calls()).toBe(1)
  })

  it('gives up at the deadline, so a relay that never comes still opens a window', async () => {
    const [probe, calls] = scripted([])
    expect(await awaitRelay(probe, { gapMs: 1, deadlineMs: 20 })).toBe('refused')
    expect(calls()).toBeGreaterThan(0)
  })
})

describe('describeFallback', () => {
  it('names the URL to open by hand', () => {
    expect(describeFallback('http://127.0.0.1:7331')).toContain('http://127.0.0.1:7331')
  })
})

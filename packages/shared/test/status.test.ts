import { describe, it, expect } from 'vitest'
import { ActivityTracker, SUSTAINED_BYTES, SUSTAINED_MS } from '../src/status.ts'

const t = () => new ActivityTracker(0)

describe('ActivityTracker', () => {
  it('starts idle', () => {
    expect(t().status).toBe('idle')
  })

  it('a single keystroke echo never flips it to busy', () => {
    const a = t()
    a.output(1, 100)
    a.tick(5000)
    expect(a.status).toBe('idle')
  })

  it('goes busy on a large burst', () => {
    const a = t()
    a.output(SUSTAINED_BYTES, 100)
    expect(a.status).toBe('busy')
  })

  it('goes busy on output that continues past the sustained window', () => {
    const a = t()
    a.output(10, 0)
    a.output(10, 1000)
    expect(a.status).toBe('idle')
    a.output(10, SUSTAINED_MS)
    expect(a.status).toBe('busy')
  })

  it('does not treat output resumed after a long gap as one burst', () => {
    const a = t()
    a.output(10, 0)
    a.output(10, 60_000) // an hour-ish later: a new burst, not a continuing one
    expect(a.status).toBe('idle')
  })

  it('busy goes done after idleMs of quiet', () => {
    const a = t()
    a.output(SUSTAINED_BYTES, 0)
    a.tick(2999)
    expect(a.status).toBe('busy')
    a.tick(3000)
    expect(a.status).toBe('done')
  })

  for (const signal of ['commandEnd', 'bell', 'hook'] as const) {
    it(`${signal} ends a busy session immediately`, () => {
      const a = t()
      a.output(SUSTAINED_BYTES, 0)
      a[signal](10)
      expect(a.status).toBe('done')
      expect(a.since).toBe(10)
    })

    it(`${signal} is ignored while idle — done is never entered from idle`, () => {
      const a = t()
      a[signal](10)
      expect(a.status).toBe('idle')
    })
  }

  it('OSC 133;C starts a command from idle', () => {
    const a = t()
    a.commandStart(50)
    expect(a.status).toBe('busy')
  })

  it('stays green while unread, even if more output arrives', () => {
    const a = t()
    a.output(SUSTAINED_BYTES, 0)
    a.hook(10)
    a.output(SUSTAINED_BYTES, 20)
    a.tick(10_000)
    expect(a.status).toBe('done')
  })

  it('input clears green; ack clears it too', () => {
    const a = t()
    a.output(SUSTAINED_BYTES, 0)
    a.hook(10)
    a.input(20)
    expect(a.status).toBe('idle')

    const b = t()
    b.output(SUSTAINED_BYTES, 0)
    b.hook(10)
    b.ack(20)
    expect(b.status).toBe('idle')
  })

  it('input does not accumulate echo toward busy', () => {
    const a = t()
    a.output(10, 0)
    a.input(1)
    a.output(10, SUSTAINED_MS + 1)
    expect(a.status).toBe('idle')
  })

  it('exits from any state and keeps the code', () => {
    for (const setup of [
      (a: ActivityTracker) => {},
      (a: ActivityTracker) => a.output(SUSTAINED_BYTES, 0),
      (a: ActivityTracker) => { a.output(SUSTAINED_BYTES, 0); a.hook(1) },
    ]) {
      const a = t()
      setup(a)
      a.exit(130, 500)
      expect(a.status).toBe('exited')
      expect(a.exitCode).toBe(130)
    }
  })

  it('ignores output once exited', () => {
    const a = t()
    a.exit(0, 0)
    a.output(SUSTAINED_BYTES, 10)
    expect(a.status).toBe('exited')
  })
})

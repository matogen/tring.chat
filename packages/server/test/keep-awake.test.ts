import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { KeepAwake, backoffDelay, inhibitCommand, wantsKeepAwake } from '../src/keep-awake.ts'

/** A helper process that does nothing until the test makes it exit or fail. */
class FakeChild extends EventEmitter {
  killed = false
  kill(): boolean { this.killed = true; return true }
}

function rig(platform: NodeJS.Platform = 'win32') {
  let clock = 0
  const spawned: Array<{ cmd: string; args: string[]; child: FakeChild; stdio: unknown }> = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean; unref: () => void }> = []
  const lines: string[] = []
  const k = new KeepAwake({
    platform,
    pid: 4242,
    now: () => clock,
    spawn: (cmd, args, opts) => {
      const child = new FakeChild()
      spawned.push({ cmd, args, child, stdio: opts.stdio })
      return child as unknown as ChildProcess
    },
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false, unref: () => {} }; timers.push(t); return t },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true },
    log: (l) => lines.push(l),
  })
  const fire = () => { const t = timers.filter((x) => !x.cleared).at(-1)!; t.cleared = true; t.fn() }
  return { k, spawned, timers, lines, fire, advance: (ms: number) => { clock += ms } }
}

describe('inhibitCommand', () => {
  it('asks Windows for ES_CONTINUOUS | ES_SYSTEM_REQUIRED and holds it until stdin closes', () => {
    const c = inhibitCommand('win32', 1)!
    expect(c.cmd).toBe('powershell.exe')
    const script = c.args.at(-1)!
    expect(script).toContain('SetThreadExecutionState')
    expect(script).toContain('0x80000001')
    expect(script).toContain('[Console]::In.ReadToEnd()')
  })

  it('uses caffeinate on macOS, tied to the daemon pid', () => {
    expect(inhibitCommand('darwin', 4242)).toEqual({ cmd: 'caffeinate', args: ['-i', '-w', '4242'] })
  })

  it('blocks only idle sleep on Linux', () => {
    const c = inhibitCommand('linux', 1)!
    expect(c.cmd).toBe('systemd-inhibit')
    expect(c.args).toContain('--what=idle')
    expect(c.args.at(-1)).toBe('cat')
  })

  it('knows nothing for other platforms', () => {
    expect(inhibitCommand('aix', 1)).toBeNull()
  })
})

describe('wantsKeepAwake', () => {
  it('is on when a phone can reach tring through an allowed origin or an off-machine bind', () => {
    expect(wantsKeepAwake({ allowSleep: false, allowOrigin: ['https://tring.example.com'], loopbackOnly: true })).toBe(true)
    expect(wantsKeepAwake({ allowSleep: false, allowOrigin: [], loopbackOnly: false })).toBe(true)
  })

  it('is off for a local-only deck, or when sleep is allowed', () => {
    expect(wantsKeepAwake({ allowSleep: false, allowOrigin: [], loopbackOnly: true })).toBe(false)
    expect(wantsKeepAwake({ allowSleep: true, allowOrigin: ['https://tring.example.com'], loopbackOnly: false })).toBe(false)
  })
})

describe('backoffDelay', () => {
  it('waits longer each time the helper keeps dying, up to ten minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(backoffDelay)).toEqual([1_000, 5_000, 30_000, 120_000, 600_000, 600_000, 600_000])
  })
})

describe('KeepAwake', () => {
  it('starts the helper with a stdin pipe it can hold, and no window', () => {
    const r = rig()
    expect(r.k.start()).toBe(true)
    expect(r.spawned).toHaveLength(1)
    expect(r.spawned[0]!.stdio).toEqual(['pipe', 'ignore', 'ignore'])
    expect(r.k.holding).toBe(true)
  })

  it('does nothing where the platform has no way to hold the machine awake', () => {
    const r = rig('aix')
    expect(r.k.start()).toBe(false)
    expect(r.spawned).toHaveLength(0)
  })

  it('starts the helper again when it dies, backing off while it keeps dying', () => {
    const r = rig()
    r.k.start()
    r.spawned[0]!.child.emit('exit', 1)
    expect(r.k.holding).toBe(false)
    expect(r.timers.at(-1)!.ms).toBe(1_000)
    r.fire()
    expect(r.spawned).toHaveLength(2)
    r.spawned[1]!.child.emit('exit', 1)
    expect(r.timers.at(-1)!.ms).toBe(5_000)
    r.fire()
    r.spawned[2]!.child.emit('exit', 1)
    expect(r.timers.at(-1)!.ms).toBe(30_000)
    r.fire()
    expect(r.spawned).toHaveLength(4)
    expect(r.k.holding).toBe(true)
  })

  it('starts the backoff over after a helper that had been working for a while', () => {
    const r = rig()
    r.k.start()
    r.spawned[0]!.child.emit('exit', 1)
    r.fire()
    r.spawned[1]!.child.emit('exit', 1)
    expect(r.timers.at(-1)!.ms).toBe(5_000)
    r.fire()
    r.advance(3_600_000)
    r.spawned[2]!.child.emit('exit', 1)
    expect(r.timers.at(-1)!.ms).toBe(1_000)
  })

  it('gives up, saying so, when the tool is not installed', () => {
    const r = rig('linux')
    r.k.start()
    r.spawned[0]!.child.emit('error', Object.assign(new Error('spawn systemd-inhibit ENOENT'), { code: 'ENOENT' }))
    r.spawned[0]!.child.emit('exit', -2)
    expect(r.timers).toHaveLength(0)
    expect(r.lines.join('\n')).toMatch(/cannot run systemd-inhibit.*may sleep/)
  })

  it('lets go on stop: the helper is killed and no restart follows', () => {
    const r = rig()
    r.k.start()
    const child = r.spawned[0]!.child
    r.k.stop()
    expect(child.killed).toBe(true)
    child.emit('exit', null)
    expect(r.timers).toHaveLength(0)
    expect(r.k.holding).toBe(false)
  })

  it('cancels a pending restart on stop', () => {
    const r = rig()
    r.k.start()
    r.spawned[0]!.child.emit('exit', 1)
    r.k.stop()
    expect(r.timers.at(-1)!.cleared).toBe(true)
    expect(r.spawned).toHaveLength(1)
  })
})

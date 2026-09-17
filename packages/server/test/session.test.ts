import { describe, it, expect, afterEach } from 'vitest'
import { Session } from '../src/session.ts'

const live: Session[] = []
afterEach(() => { for (const s of live.splice(0)) s.dispose() })

function make(command?: string, idleMs = 200, token?: string | null): Session {
  const s = new Session({
    id: 's1', projectId: 'p1', projectName: 'demo', slot: 1,
    cwd: process.cwd(), command: command ?? null,
    url: 'http://127.0.0.1:7331', token: token ?? null, idleMs, scrollback: 100,
  })
  live.push(s)
  return s
}

async function waitFor(fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('timed out waiting for condition')
}

describe('Session', () => {
  it('runs a real shell, goes busy on sustained output, then done when quiet', async () => {
    const s = make()
    // 3000 bytes clears the sustained-output threshold in one burst.
    s.write("printf 'x%.0s' $(seq 1 3000); echo\n")
    await waitFor(() => s.tracker.status === 'busy')

    await waitFor(() => {
      s.tick(Date.now())
      return s.tracker.status === 'done'
    })
    expect(s.tracker.status).toBe('done')
  })

  it('replays what was printed via serialize()', async () => {
    const s = make()
    s.write('echo tring-replay-marker\n')
    await waitFor(() => s.serialize().includes('tring-replay-marker'))
    expect(s.serialize()).toContain('tring-replay-marker')
  })

  it('injects the env vars the Claude Code Stop hook depends on', async () => {
    const s = make()
    s.write('echo "[$TRING_SLOT|$TRING_PROJECT|$TRING_SESSION_ID]"\n')
    await waitFor(() => s.serialize().includes('[1|demo|s1]'))
    expect(s.serialize()).toContain('[1|demo|s1]')
  })

  it('hands the hook the token it now needs to authenticate with', async () => {
    const s = make(undefined, 200, 'f'.repeat(64))
    s.write('echo "[$TRING_TOKEN]"\n')
    await waitFor(() => s.serialize().includes(`[${'f'.repeat(64)}]`))
    expect(s.serialize()).toContain(`[${'f'.repeat(64)}]`)
  })

  it('leaves no stale TRING_TOKEN behind when the daemon has none', async () => {
    // The daemon copies its own environment into every shell, so a
    // TRING_TOKEN it inherited must not be passed off as this daemon's.
    const before = process.env['TRING_TOKEN']
    process.env['TRING_TOKEN'] = 'inherited-from-somewhere-else'
    try {
      const s = make(undefined, 200, null)
      s.write('echo "[${TRING_TOKEN:-unset}]"\n')
      await waitFor(() => s.serialize().includes('[unset]'))
      expect(s.serialize()).toContain('[unset]')
    } finally {
      if (before === undefined) delete process.env['TRING_TOKEN']
      else process.env['TRING_TOKEN'] = before
    }
  })

  it('reports the exit code and lands in exited', async () => {
    const s = make('exit 3')
    let code: number | null = null
    s.onExit = (c) => { code = c }
    await waitFor(() => s.tracker.status === 'exited')
    expect(code).toBe(3)
    expect(s.tracker.exitCode).toBe(3)
  })

  /**
   * A stand-in for a full-screen app on a scroll: it waits for exactly one
   * three-byte sequence and then redraws far more than SUSTAINED_BYTES, all
   * inside a few milliseconds, which is the shape that was turning tiles
   * amber for work nobody had asked for.
   */
  const REDRAWS_ON_KEY =
    "printf 'ready\\n'; read -r -n 3 x; printf 'y%.0s' $(seq 1 8000); sleep 5"

  it('a wheel notch that makes an app redraw does not count as work', async () => {
    const s = make(REDRAWS_ON_KEY)
    await waitFor(() => s.serialize().includes('ready'))

    s.write('\x1b[A') // one notch, as an app on the alternate screen sees it
    await waitFor(() => s.serialize().includes('yyyyyyyy'))
    expect(s.tracker.status).toBe('idle')
  })

  it('the same redraw after a keystroke you meant does count', async () => {
    const s = make(REDRAWS_ON_KEY)
    await waitFor(() => s.serialize().includes('ready'))

    s.write('abc')
    await waitFor(() => s.tracker.status === 'busy')
    expect(s.tracker.status).toBe('busy')
  })

  it('suppresses a snapshot when the visible buffer has not changed', async () => {
    const s = make()
    s.write('echo snap\n')
    await waitFor(() => s.serialize().includes('snap'))
    expect(s.takeSnapshot()).not.toBeNull()
    expect(s.takeSnapshot()).toBeNull()
  })
})

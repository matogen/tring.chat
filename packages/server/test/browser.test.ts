import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AttachedBrowser, capabilityFor, isChromiumInstalled } from '../src/browser.ts'
import { createHandler } from '../src/http.ts'
import { ProjectManager } from '../src/project-manager.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn() })

const withBrowsersPath = async (dir: string | null, fn: () => Promise<void>): Promise<void> => {
  const before = process.env['PLAYWRIGHT_BROWSERS_PATH']
  if (dir === null) delete process.env['PLAYWRIGHT_BROWSERS_PATH']
  else process.env['PLAYWRIGHT_BROWSERS_PATH'] = dir
  try {
    await fn()
  } finally {
    if (before === undefined) delete process.env['PLAYWRIGHT_BROWSERS_PATH']
    else process.env['PLAYWRIGHT_BROWSERS_PATH'] = before
  }
}

describe('capabilityFor', () => {
  it('reports unavailable when nothing is installed, whatever the setting', () => {
    expect(capabilityFor(false, false)).toBe('unavailable')
    expect(capabilityFor(false, true)).toBe('unavailable')
  })

  it('separates installed-but-off from on', () => {
    expect(capabilityFor(true, false)).toBe('off')
    expect(capabilityFor(true, true)).toBe('on')
  })
})

describe('isChromiumInstalled', () => {
  it('is false when the cache directory does not exist', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-pw-'))
    await withBrowsersPath(path.join(dir, 'nope'), async () => {
      expect(await isChromiumInstalled()).toBe(false)
    })
  })

  it('is false when the directory exists but holds no chromium', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-pw-'))
    await mkdir(path.join(dir, 'firefox-1234'), { recursive: true })
    await withBrowsersPath(dir, async () => {
      expect(await isChromiumInstalled()).toBe(false)
    })
  })

  /**
   * The trap this exists to avoid: `executablePath()` answers with a plausible
   * path whether or not anything is there, so a directory alone is not proof.
   */
  it('is false when the chromium directory is present but empty', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-pw-'))
    await mkdir(path.join(dir, 'chromium-1243'), { recursive: true })
    await withBrowsersPath(dir, async () => {
      expect(await isChromiumInstalled()).toBe(false)
    })
  })

  it('finds a real binary in the layouts playwright ships', async () => {
    for (const rel of ['chrome-linux64/chrome', 'chrome-win/chrome.exe']) {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-pw-'))
      const exe = path.join(dir, 'chromium-1243', rel)
      await mkdir(path.dirname(exe), { recursive: true })
      await writeFile(exe, '')
      await withBrowsersPath(dir, async () => {
        expect(await isChromiumInstalled(), rel).toBe(true)
      })
    }
  })

  /**
   * The reason this is a filesystem check rather than `executablePath()`:
   * importing playwright-core costs ~400ms and this runs at every daemon
   * start, including for the users who never enable the feature (spec §6).
   * The threshold is deliberately loose — it is catching a reintroduced
   * import, not measuring disk.
   */
  it('costs nothing, because it must not load playwright', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-pw-'))
    await withBrowsersPath(dir, async () => {
      const started = Date.now()
      await isChromiumInstalled()
      expect(Date.now() - started).toBeLessThan(100)
    })
  })
})

describe('GET /api/capabilities', () => {
  const rig = async (capabilities?: () => { browser: 'unavailable' | 'off' | 'on' }) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-cap-'))
    const pm = await ProjectManager.open({
      url: 'http://127.0.0.1:0', scrollback: 50, idleMs: 150,
      statePath: path.join(dir, 'projects.json'), tickMs: 40,
    })
    const handler = createHandler({
      pm, webRoot: path.join(dir, 'dist'), token: null,
      ...(capabilities ? { capabilities } : {}),
    })
    const server: Server = createServer((req, res) => void handler(req, res))
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    cleanup.push(async () => {
      await pm.dispose()
      await new Promise((res) => server.close(res))
    })
    return base
  }

  it('reports what the daemon was given', async () => {
    const base = await rig(() => ({ browser: 'on' }))
    const res = await fetch(`${base}/api/capabilities`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ browser: 'on' })
  })

  /**
   * A daemon built without the browser half must still answer, and must answer
   * "no" rather than 404 — the client asks this before it draws a tile, and an
   * error there would leave the control in an unknown state.
   */
  it('answers unavailable when the daemon has no capability source', async () => {
    const base = await rig()
    expect(await (await fetch(`${base}/api/capabilities`)).json())
      .toEqual({ browser: 'unavailable' })
  })

  it('refuses to install when no installer is wired up', async () => {
    const base = await rig(() => ({ browser: 'unavailable' }))
    const res = await fetch(`${base}/api/browser/install`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('refuses to install over a browser that is already there', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-cap-'))
    const pm = await ProjectManager.open({
      url: 'http://127.0.0.1:0', scrollback: 50, idleMs: 150,
      statePath: path.join(dir, 'projects.json'), tickMs: 40,
    })
    let installs = 0
    const handler = createHandler({
      pm, webRoot: path.join(dir, 'dist'), token: null,
      capabilities: () => ({ browser: 'off' as const }),
      installBrowser: async () => { installs++ },
    })
    const server: Server = createServer((req, res) => void handler(req, res))
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    cleanup.push(async () => {
      await pm.dispose()
      await new Promise((res) => server.close(res))
    })

    const res = await fetch(`${base}/api/browser/install`, { method: 'POST' })
    expect(res.status).toBe(409)
    expect(installs).toBe(0)
  })
})

describe('per-project browser settings', () => {
  it('default to off with the local-only allowlist', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-set-'))
    const pm = await ProjectManager.open({
      url: 'http://127.0.0.1:0', scrollback: 50, idleMs: 150,
      statePath: path.join(dir, 'projects.json'), tickMs: 40,
    })
    cleanup.push(() => pm.dispose())
    const id = pm.createProject('demo', dir)

    expect(pm.browserSettings(id).enabled).toBe(false)
    expect(pm.policyFor(id).allow).toEqual(['localhost:*', '127.0.0.1:*'])
  })

  it('carries the daemon port into the policy, so its own origin is known', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-set-'))
    const pm = await ProjectManager.open({
      url: 'http://127.0.0.1:7331', scrollback: 50, idleMs: 150,
      statePath: path.join(dir, 'projects.json'), tickMs: 40,
      daemonPort: 7331,
    })
    cleanup.push(() => pm.dispose())
    const id = pm.createProject('demo', dir)
    expect(pm.policyFor(id).daemonPort).toBe(7331)
  })

  it('survives a restart', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-set-'))
    const statePath = path.join(dir, 'projects.json')
    const first = await ProjectManager.open({
      url: 'http://127.0.0.1:0', scrollback: 50, idleMs: 150, statePath, tickMs: 40,
    })
    const id = first.createProject('demo', dir)
    first.setBrowserSettings(id, { enabled: true, allow: ['*.example.com'] })
    await first.save()
    await first.dispose()

    const second = await ProjectManager.open({
      url: 'http://127.0.0.1:0', scrollback: 50, idleMs: 150, statePath, tickMs: 40,
    })
    cleanup.push(() => second.dispose())
    expect(second.browserSettings(id).enabled).toBe(true)
    expect(second.policyFor(id).allow).toEqual(['*.example.com'])
  })
})

/**
 * Found by running it against a real Chromium: a blocked navigation used to
 * leave the page on `chrome-error://chromewebdata/`, throwing away whatever was
 * loaded. Aborting a top-level navigation mid-flight does that, so the policy is
 * checked before `goto` is ever called. The route guard still covers redirects
 * and in-page links, where there is no way to avoid the error page.
 */
describe('a refused navigation does not disturb the page', () => {
  const policy = { allow: ['localhost:*'], daemonPort: 7331, daemonHost: null }
  const fakePage = () => {
    const calls: string[] = []
    const page = {
      goto: async (url: string) => { calls.push(url) },
      goBack: async () => { calls.push('back') },
      reload: async () => { calls.push('reload') },
      url: () => 'http://localhost:5173/app',
      title: async () => 'app',
      viewportSize: () => ({ width: 1280, height: 800 }),
      context: () => ({ newCDPSession: async () => { throw new Error('no cdp') } }),
      on: () => {},
      route: async () => {},
    }
    return { page, calls }
  }
  const make = () => {
    const { page, calls } = fakePage()
    return { b: new AttachedBrowser('s1', page as never, () => policy), calls }
  }

  it('allows a navigation the policy permits', async () => {
    const { b, calls } = make()
    await expect(b.navigate('http://localhost:5173/other')).resolves.toBe(true)
    expect(calls).toEqual(['http://localhost:5173/other'])
  })

  it('refuses one it does not, without calling goto at all', async () => {
    const { b, calls } = make()
    await expect(b.navigate('https://example.com/')).resolves.toBe(false)
    expect(calls).toEqual([])
    expect(b.info().url).toBe('http://localhost:5173/app')
  })

  it('offers a merely-not-allowed host to the human', async () => {
    const { b } = make()
    const prompts: string[] = []
    b.onPrompt = (u) => prompts.push(u)
    await b.navigate('https://example.com/')
    expect(prompts).toEqual(['https://example.com/'])
  })

  /** tring's own address is refused and must never reach the prompt. */
  it('refuses the daemon silently, with nothing for the user to allow', async () => {
    const { b, calls } = make()
    const prompts: string[] = []
    b.onPrompt = (u) => prompts.push(u)
    await expect(b.navigate('http://127.0.0.1:7331/?token=x')).resolves.toBe(false)
    expect(calls).toEqual([])
    expect(prompts).toEqual([])
  })

  it('lets history moves through, which carry no url to check', async () => {
    const { b, calls } = make()
    await expect(b.navigate('back')).resolves.toBe(true)
    await expect(b.navigate('reload')).resolves.toBe(true)
    expect(calls).toEqual(['back', 'reload'])
  })
})

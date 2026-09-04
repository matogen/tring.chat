import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProjectManager } from '../src/project-manager.ts'
import { createHandler } from '../src/http.ts'

interface Rig { pm: ProjectManager; server: Server; base: string; dir: string }
const rigs: Rig[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.pm.dispose()
    await new Promise((res) => r.server.close(res))
  }
})

async function rig(token?: string): Promise<Rig> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-http-'))
  const pm = await ProjectManager.open({
    url: 'http://127.0.0.1:0', scrollback: 50, idleMs: 150,
    statePath: path.join(dir, 'projects.json'), tickMs: 40,
  })
  const handler = createHandler({ pm, webRoot: path.join(dir, 'dist'), token: token ?? null })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const r = { pm, server, base, dir }
  rigs.push(r)
  return r
}

const waitFor = async (fn: () => boolean, ms = 6000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}

describe('HTTP API', () => {
  it('memoises the usage scan, which is why the handler is built once', async () => {
    const r = await rig()
    const config = path.join(r.dir, 'claude')
    const file = path.join(config, 'projects', 'demo', 'a.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    const entry = (id: string, output: number) => JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      cwd: '/home/dev/api-service',
      message: { id, model: 'claude-opus-5', usage: { input_tokens: 0, output_tokens: output } },
    })
    await writeFile(file, entry('msg_1', 100), 'utf8')

    const previous = process.env['CLAUDE_CONFIG_DIR']
    const previousPath = process.env['PATH']
    process.env['CLAUDE_CONFIG_DIR'] = config
    // No PATH means no `claude` to spawn: these cover the local scan, and the
    // limit bridge has its own tests that need no subprocess at all.
    process.env['PATH'] = ''
    try {
      const read = async () =>
        ((await fetch(`${r.base}/api/usage`).then((x) => x.json())) as { week: { tokens: number } })
          .week.tokens
      expect(await read()).toBe(100)
      await writeFile(file, [entry('msg_1', 100), entry('msg_2', 900)].join('\n'), 'utf8')
      // Still the cached answer: a fresh scan per request is what the old
      // per-request createHandler silently caused.
      expect(await read()).toBe(100)
    } finally {
      if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR']
      else process.env['CLAUDE_CONFIG_DIR'] = previous
      process.env['PATH'] = previousPath
    }
  })

  it('serves Claude Code usage read from the transcripts, not from any session', async () => {
    const r = await rig()
    const config = path.join(r.dir, 'claude')
    await mkdir(path.join(config, 'projects', 'demo'), { recursive: true })
    // One message, written as two content-block records the way Claude Code does.
    const record = {
      type: 'assistant',
      timestamp: new Date().toISOString(),
      cwd: '/home/dev/api-service',
      message: {
        id: 'msg_1',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 100, output_tokens: 200,
          cache_creation_input_tokens: 0, cache_read_input_tokens: 5000,
        },
      },
    }
    await writeFile(
      path.join(config, 'projects', 'demo', 'a.jsonl'),
      [JSON.stringify(record), JSON.stringify({ ...record, apiBlockIndex: 1 })].join('\n'),
      'utf8',
    )

    const previous = process.env['CLAUDE_CONFIG_DIR']
    const previousPath = process.env['PATH']
    process.env['CLAUDE_CONFIG_DIR'] = config
    // No PATH means no `claude` to spawn: these cover the local scan, and the
    // limit bridge has its own tests that need no subprocess at all.
    process.env['PATH'] = ''
    try {
      const body = await fetch(`${r.base}/api/usage`).then((x) => x.json()) as {
        window: { tokens: number; cacheReadTokens: number }
        projects: { name: string; tokens: number }[]
      }
      expect(body.window.tokens).toBe(300)
      expect(body.window.cacheReadTokens).toBe(5000)
      expect(body.projects).toEqual([{ name: 'api-service', tokens: 300, cost: expect.any(Number) }])
    } finally {
      if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR']
      else process.env['CLAUDE_CONFIG_DIR'] = previous
      process.env['PATH'] = previousPath
    }
  })

  it('turns a session green through the exact URL the Stop hook posts to', async () => {
    const r = await rig()
    const p = r.pm.createProject('demo', r.dir)
    const s = r.pm.create(p, {})!

    // Reach busy first: done is only ever entered from busy.
    s.write("printf 'z%.0s' $(seq 1 3000)\n")
    await waitFor(() => s.tracker.status === 'busy')

    // This is the §4.6 snippet's URL shape, with no project segment.
    const res = await fetch(`${r.base}/api/sessions/${s.id}/done`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(s.tracker.status).toBe('done')
  })

  it('lists sessions with their project name for scripts', async () => {
    const r = await rig()
    const p = r.pm.createProject('api-service', r.dir)
    r.pm.create(p, { name: 'server' })

    const body = await (await fetch(`${r.base}/api/sessions`)).json() as
      { sessions: { name: string; project: string; slot: number }[] }
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]).toMatchObject({ name: 'server', project: 'api-service', slot: 1 })
  })

  it('validates the status endpoint body', async () => {
    const r = await rig()
    const p = r.pm.createProject('demo', r.dir)
    const s = r.pm.create(p, {})!

    const bad = await fetch(`${r.base}/api/sessions/${s.id}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'weird' }),
    })
    expect(bad.status).toBe(400)

    const ok = await fetch(`${r.base}/api/sessions/${s.id}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'busy' }),
    })
    expect(ok.status).toBe(200)
    expect(s.tracker.status).toBe('busy')
  })

  it('404s an unknown session rather than silently accepting the hook', async () => {
    const r = await rig()
    const res = await fetch(`${r.base}/api/sessions/nope/done`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('requires the bearer token on the API when one is configured', async () => {
    const r = await rig('secret')
    expect((await fetch(`${r.base}/api/sessions`)).status).toBe(401)
    const ok = await fetch(`${r.base}/api/sessions`, {
      headers: { authorization: 'Bearer secret' },
    })
    expect(ok.status).toBe(200)
  })

  it('serves a placeholder page while the web bundle is unbuilt', async () => {
    const r = await rig()
    const res = await fetch(`${r.base}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('not built yet')
  })
})

describe('directory listing', () => {
  it('lists subdirectories of a path so the dialog can browse', async () => {
    const r = await rig()
    const res = await fetch(`${r.base}/api/fs?path=${encodeURIComponent(r.dir)}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { path: string; parent: string | null; entries: unknown[] }
    expect(body.path).toBe(r.dir)
    expect(body.parent).not.toBeNull()
    expect(Array.isArray(body.entries)).toBe(true)
  })

  it('defaults to the home directory when given no path', async () => {
    const r = await rig()
    const body = await (await fetch(`${r.base}/api/fs`)).json() as { path: string }
    expect(body.path).toBe(process.env['HOME'])
  })

  it('reports a directory it cannot read rather than throwing', async () => {
    const r = await rig()
    const res = await fetch(`${r.base}/api/fs?path=/definitely/not/here`)
    expect(res.status).toBe(400)
  })
})

describe('window launcher', () => {
  it('stays out of the way when TRING_NO_OPEN is set, so dev reloads do not spawn windows', async () => {
    const { openWindow } = await import('../src/open-window.ts')
    const prev = process.env['TRING_NO_OPEN']
    process.env['TRING_NO_OPEN'] = '1'
    try {
      expect(openWindow('http://127.0.0.1:7331')).toBe(false)
    } finally {
      if (prev === undefined) delete process.env['TRING_NO_OPEN']
      else process.env['TRING_NO_OPEN'] = prev
    }
  })
})

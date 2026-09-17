import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProjectManager } from '../src/project-manager.ts'
import { createHandler } from '../src/http.ts'
import { MAX_UPLOAD_BYTES, UploadStore } from '../src/uploads.ts'

interface Rig {
  pm: ProjectManager; server: Server; base: string; dir: string; uploads: UploadStore
}
const rigs: Rig[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.pm.dispose()
    await new Promise((res) => r.server.close(res))
  }
})

async function rig(token?: string, fsRoots?: string[]): Promise<Rig> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-http-'))
  const pm = await ProjectManager.open({
    url: 'http://127.0.0.1:0', scrollback: 50, idleMs: 150,
    statePath: path.join(dir, 'projects.json'), tickMs: 40,
  })
  const uploads = new UploadStore(path.join(dir, 'uploads'))
  const handler = createHandler({
    pm, webRoot: path.join(dir, 'dist'), token: token ?? null, uploads,
    ...(fsRoots ? { fsRoots } : {}),
  })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const r = { pm, server, base, dir, uploads }
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

  it('serves the web app manifest with the type browsers require to install it', async () => {
    const r = await rig()
    await mkdir(path.join(r.dir, 'dist'), { recursive: true })
    await writeFile(path.join(r.dir, 'dist', 'manifest.webmanifest'), '{"name":"tring"}')
    const res = await fetch(`${r.base}/manifest.webmanifest`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/manifest+json')
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
    r.pm.createProject('demo', r.dir)
    await mkdir(path.join(r.dir, 'src', 'nested'), { recursive: true })

    const res = await fetch(`${r.base}/api/fs?path=${encodeURIComponent(path.join(r.dir, 'src'))}`)
    expect(res.status).toBe(200)
    const body = await res.json() as
      { path: string; parent: string | null; entries: { name: string }[] }
    expect(body.entries.map((e) => e.name)).toContain('nested')
    // Still inside the project root, so walking back up is offered.
    expect(body.parent).toBe(r.dir)
  })

  it('defaults to the home directory when given no path', async () => {
    const r = await rig()
    const body = await (await fetch(`${r.base}/api/fs`)).json() as { path: string }
    expect(body.path).toBe(process.env['HOME'])
  })

  it('reports a directory it cannot read rather than throwing', async () => {
    const r = await rig()
    const inside = path.join(process.env['HOME']!, 'definitely-not-here-tring')
    const res = await fetch(`${r.base}/api/fs?path=${encodeURIComponent(inside)}`)
    expect(res.status).toBe(400)
  })

  it('refuses to enumerate the machine outside the roots it was given', async () => {
    // Unconstrained this endpoint is `ls /` for anything that reaches the API,
    // which is exactly the reconnaissance step before a shell.
    const r = await rig()
    const res = await fetch(`${r.base}/api/fs?path=${encodeURIComponent(path.parse(r.dir).root)}`)
    expect(res.status).toBe(403)
  })

  it('browses a project root that sits outside home, and stops at its edge', async () => {
    const r = await rig()
    r.pm.createProject('demo', r.dir)

    const body = await (await fetch(`${r.base}/api/fs?path=${encodeURIComponent(r.dir)}`))
      .json() as { path: string; parent: string | null }
    expect(body.path).toBe(r.dir)
    // The dialog is not offered an "up" that would only be refused.
    expect(body.parent).toBeNull()
  })

  it('does not let a symlink inside a root walk back out of it', async () => {
    // The containment check has to resolve what readdir will actually follow:
    // lexically, `<root>/escape/etc` still looks like it is under the root.
    const outside = await mkdtemp(path.join(os.tmpdir(), 'tring-outside-'))
    await mkdir(path.join(outside, 'secrets'))
    const r = await rig()
    r.pm.createProject('demo', r.dir)
    await symlink(outside, path.join(r.dir, 'escape'), 'dir')

    const escaped = path.join(r.dir, 'escape', 'secrets')
    const res = await fetch(`${r.base}/api/fs?path=${encodeURIComponent(escaped)}`)
    expect(res.status).toBe(403)
  })

  it('still browses a root reached through a symlink of its own', async () => {
    // Resolving only one side would refuse a symlinked home or project root.
    const outside = await mkdtemp(path.join(os.tmpdir(), 'tring-real-'))
    await mkdir(path.join(outside, 'src'))
    const link = path.join(await mkdtemp(path.join(os.tmpdir(), 'tring-link-')), 'proj')
    await symlink(outside, link, 'dir')

    const r = await rig(undefined, [link])
    const res = await fetch(`${r.base}/api/fs?path=${encodeURIComponent(path.join(link, 'src'))}`)
    expect(res.status).toBe(200)
  })

  it('opens up a directory named with --fs-root', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'tring-root-'))
    const r = await rig(undefined, [outside])
    const res = await fetch(`${r.base}/api/fs?path=${encodeURIComponent(outside)}`)
    expect(res.status).toBe(200)
  })
})

describe('origin and headers', () => {
  it('refuses a request carrying another site as its origin', async () => {
    // Confirms the fix for the cross-origin path: a page on any site could
    // otherwise reach this API, and the WebSocket beside it.
    const r = await rig()
    const res = await fetch(`${r.base}/api/sessions`, {
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('accepts the origin it serves the page from', async () => {
    const r = await rig()
    const res = await fetch(`${r.base}/api/sessions`, { headers: { origin: r.base } })
    expect(res.status).toBe(200)
  })

  it('sends the header block on the page, the API and a 404 alike', async () => {
    const r = await rig()
    for (const p of ['/', '/api/sessions', '/nope.js']) {
      const res = await fetch(`${r.base}${p}`)
      expect(res.headers.get('x-frame-options'), p).toBe('DENY')
      expect(res.headers.get('x-content-type-options'), p).toBe('nosniff')
      expect(res.headers.get('content-security-policy'), p).toContain("frame-ancestors 'none'")
    }
  })

  it('still takes the bearer token, and still refuses a wrong one', async () => {
    const r = await rig('secret')
    expect((await fetch(`${r.base}/api/sessions`, {
      headers: { authorization: 'Bearer nope' },
    })).status).toBe(401)
    expect((await fetch(`${r.base}/api/sessions`, {
      headers: { authorization: 'Bearer secret' },
    })).status).toBe(200)
  })
})

describe('dropped images', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64),
  ])
  const post = (base: string, body: BodyInit, headers: HeadersInit = {}) =>
    fetch(`${base}/api/upload`, { method: 'POST', body, headers })

  it('writes the image and answers with a path the shell can open', async () => {
    const r = await rig()
    const res = await post(r.base, png, { 'content-type': 'image/png' })
    expect(res.status).toBe(200)

    const { path: file } = await res.json() as { path: string }
    expect(await readFile(file)).toEqual(png)
    expect(path.isAbsolute(file)).toBe(true)
  })

  it('goes through the same token as every other route', async () => {
    const r = await rig('secret')
    expect((await post(r.base, png)).status).toBe(401)
    const ok = await post(r.base, png, { authorization: 'Bearer secret' })
    expect(ok.status).toBe(200)
  })

  it('refuses a file that is not an image, whatever it says it is', async () => {
    const r = await rig()
    // The interesting case: a caller with the token dressing a script up as a
    // PNG. The name is ours and the bytes are sniffed, so neither lands.
    const res = await post(r.base, Buffer.from('#!/bin/sh\necho pwned\n'), {
      'content-type': 'image/png',
    })
    expect(res.status).toBe(415)
  })

  it('turns away an upload too big to be a screenshot', async () => {
    const r = await rig()
    const res = await post(r.base, Buffer.alloc(MAX_UPLOAD_BYTES + 1), {
      'content-type': 'image/png',
    })
    expect(res.status).toBe(413)
  })

  it('refuses an empty body rather than writing a zero-byte file', async () => {
    const r = await rig()
    expect((await post(r.base, Buffer.alloc(0))).status).toBe(400)
  })

  it('is not a GET, and not a way to read anything back', async () => {
    const r = await rig()
    const res = await post(r.base, png)
    const { path: file } = await res.json() as { path: string }
    // The daemon serves the bundle and the API; the uploads directory is
    // neither, so the path it just handed out is not a URL that answers.
    expect((await fetch(`${r.base}/api/upload`)).status).toBe(404)
    expect((await fetch(`${r.base}${file}`)).ok).toBe(false)
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

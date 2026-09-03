import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
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

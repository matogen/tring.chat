import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProjectManager } from '../src/project-manager.ts'
import { createHandler } from '../src/http.ts'
import { WorkflowSettingsStore } from '../src/workflow/settings.ts'

interface Rig { pm: ProjectManager; server: Server; base: string }
const rigs: Rig[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.pm.dispose()
    await new Promise((res) => r.server.close(res))
  }
})

const TOKEN = 't0ken'
const auth = { authorization: `Bearer ${TOKEN}` }

async function rig(withStore = true): Promise<Rig> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-workflow-http-'))
  const pm = await ProjectManager.open({
    url: 'http://127.0.0.1:0', scrollback: 50, idleMs: 150, statePath: path.join(dir, 'projects.json'),
  })
  let workflow: WorkflowSettingsStore | null = null
  if (withStore) {
    workflow = new WorkflowSettingsStore(path.join(dir, 'workflow.json'))
    await workflow.load()
  }
  const handler = createHandler({ pm, webRoot: path.join(dir, 'dist'), token: TOKEN, workflow })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const r = { pm, server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
  rigs.push(r)
  return r
}

const post = (base: string, body: string, headers: Record<string, string> = auth): Promise<Response> =>
  fetch(`${base}/api/workflow`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })

describe('/api/workflow', () => {
  it('reports the settings, off by default', async () => {
    const r = await rig()
    const res = await fetch(`${r.base}/api/workflow`, { headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ multiPr: false, maxAgents: 4, autoRestack: 'offer' })
  })

  it('switches the workflow on and answers with the settings as they now are', async () => {
    const r = await rig()
    const res = await post(r.base, JSON.stringify({ multiPr: true, maxAgents: 12 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ multiPr: true, maxAgents: 12 })
    const again = await (await fetch(`${r.base}/api/workflow`, { headers: auth })).json()
    expect(again).toMatchObject({ multiPr: true, maxAgents: 12 })
  })

  it('turns away a malformed body without changing anything', async () => {
    const r = await rig()
    expect((await post(r.base, '{"multiPr": tru')).status).toBe(400)
    const now = await (await fetch(`${r.base}/api/workflow`, { headers: auth })).json()
    expect(now.multiPr).toBe(false)
  })

  it('needs the token, like every other route', async () => {
    const r = await rig()
    expect((await fetch(`${r.base}/api/workflow`)).status).toBe(401)
    expect((await post(r.base, '{"multiPr":true}', {})).status).toBe(401)
  })

  it('answers 503 when the daemon was started without a store', async () => {
    const r = await rig(false)
    expect((await fetch(`${r.base}/api/workflow`, { headers: auth })).status).toBe(503)
  })
})

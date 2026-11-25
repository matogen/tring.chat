import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { mkdtemp as mkdtempP } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProjectManager } from '../src/project-manager.ts'
import { createHandler, type HttpOptions, type StackApi } from '../src/http.ts'
import { Inbox } from '../src/inbox.ts'
import { OrchestratorTools, TICKET_TOOLS, TOOLS, ToolError, type ToolDeps, type ToolSession } from '../src/orchestrator-tools.ts'
import {
  INSTRUCTIONS, OrchestratorAgent, PRE_ALLOWED, TICKET_INSTRUCTIONS, TICKET_PRE_ALLOWED, workspaceSettings,
} from '../src/orchestrator-agent.ts'
import type { Session } from '../src/session.ts'


interface Rig { pm: ProjectManager; server: Server; base: string }
const rigs: Rig[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.pm.dispose()
    await new Promise((res) => r.server.close(res))
  }
})

const TOKEN = 'daemon-token'

async function rig(over: Partial<HttpOptions> = {}): Promise<Rig> {
  const dir = await mkdtempP(path.join(os.tmpdir(), 'tring-stack-http-'))
  const pm = await ProjectManager.open({ url: 'http://127.0.0.1:0', scrollback: 50, idleMs: 150, statePath: path.join(dir, 'projects.json') })
  const handler = createHandler({ pm, webRoot: path.join(dir, 'dist'), token: TOKEN, ...over })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const r = { pm, server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
  rigs.push(r)
  return r
}

/** One tile token, for one coder. */
const stack: StackApi = {
  authorize: (t) => (t === 'tile-token' ? { role: 'coder' } : null),
  tools: () => [{ name: 'report', description: 'r', inputSchema: {} }],
  async call(_who, name) {
    if (name === 'boom') throw new ToolError('not that')
    return `did ${name}`
  },
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
const call = (base: string, token: string, name: string) => fetch(`${base}/api/stack/call`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...bearer(token) }, body: JSON.stringify({ name, arguments: {} }),
})

describe('/api/stack: a workflow tile\'s own tools', () => {
  it('opens to a tile\'s token, and lists and calls its tools', async () => {
    const r = await rig({ stack })
    const tools = await fetch(`${r.base}/api/stack/tools`, { headers: bearer('tile-token') })
    expect(tools.status).toBe(200)
    expect((await tools.json()).tools.map((t: { name: string }) => t.name)).toEqual(['report'])
    expect(await (await call(r.base, 'tile-token', 'report')).json()).toEqual({ text: 'did report', isError: false })
    expect(await (await call(r.base, 'tile-token', 'boom')).json()).toEqual({ text: 'not that', isError: true })
  })

  it('stays shut to no token, a wrong one, and even the daemon\'s own', async () => {
    const r = await rig({ stack })
    expect((await fetch(`${r.base}/api/stack/tools`)).status).toBe(401)
    expect((await fetch(`${r.base}/api/stack/tools`, { headers: bearer('guess') })).status).toBe(401)
    expect((await fetch(`${r.base}/api/stack/tools`, { headers: bearer(TOKEN) })).status).toBe(401)
  })

  it('does not let a tile\'s token into the rest of the API', async () => {
    const r = await rig({ stack })
    expect((await fetch(`${r.base}/api/projects`, { headers: bearer('tile-token') })).status).toBe(401)
  })

  it('answers 503 while the daemon runs no workflow', async () => {
    const r = await rig()
    expect((await fetch(`${r.base}/api/stack/tools`, { headers: bearer('tile-token') })).status).toBe(503)
  })
})

describe('the hook gate over HTTP', () => {
  it('hands the workflow\'s decision on a tool call back to Claude Code, and tells it about every hook', async () => {
    const seen: string[] = []
    const r = await rig({
      inbox: new Inbox(),
      gate: (_id, tool, input) => tool === 'Edit'
        ? { decision: 'deny', reason: `${String(input['file_path'])} belongs to CHV-1-2` }
        : null,
      onHook: (_id, event) => seen.push(event),
    })
    const p = r.pm.createProject('demo', process.cwd())
    const s = r.pm.create(p, { cwd: process.cwd() })!
    const post = (tool: string) => fetch(`${r.base}/api/sessions/${s.id}/hook`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...bearer(TOKEN) },
      body: JSON.stringify({ event: 'PreToolUse', payload: { tool_name: tool, tool_input: { file_path: 'src/a.ts' } } }),
    })
    expect(await (await post('Edit')).json()).toEqual({
      output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'src/a.ts belongs to CHV-1-2' } },
    })
    expect(await (await post('Read')).json()).toEqual({ output: null })
    expect(seen).toEqual(['PreToolUse', 'PreToolUse'])
  })
})

describe('the orchestrator with the workflow off and on', () => {
  const session: ToolSession = {
    id: 's1', projectId: 'p1', slot: 2, name: null, title: null, cwd: '/r', agentCwd: null, transcript: null, command: 'claude',
    claude: { id: 'c1', cwd: '/r' }, lastMessage: null, stoppedAt: 0, promptedAt: 0, tracker: { status: 'idle' },
    recentText: () => '', write: () => {}, prompted: () => {},
  }
  const deps = (on: boolean, started: string[] = []): ToolDeps => ({
    pm: {
      list: () => [{ id: 'p1', name: 'CHV-9 Orders', root: '/r', sessions: [] }],
      activeProjectId: 'p1', findSession: (id) => (id === 's1' ? session : undefined),
      findProject: () => undefined, create: () => null,
    },
    inbox: { list: () => [] },
    workflow: {
      enabled: () => on,
      ticketOf: (id) => (id === 's1' ? 'CHV-9' : null),
      startTicket: async (a) => { started.push(String(a['title'])); return 'opened' },
      listTickets: () => 'none', ticketStatus: () => 'status', ticketAction: async () => 'done',
    },
  })

  it('offers exactly today\'s tools while off, and the ticket tools once on', () => {
    expect(new OrchestratorTools(deps(false)).list()).toBe(TOOLS)
    expect(new OrchestratorTools(deps(true)).list().map((t) => t.name)).toEqual([...TOOLS, ...TICKET_TOOLS].map((t) => t.name))
  })

  it('refuses the ticket tools while off, and passes them on while on', async () => {
    await expect(new OrchestratorTools(deps(false)).call('start_ticket', { title: 'x' })).rejects.toThrow(/workflow is off/)
    const started: string[] = []
    expect(await new OrchestratorTools(deps(true, started)).call('start_ticket', { title: 'Orders' })).toBe('opened')
    expect(started).toEqual(['Orders'])
  })

  it('will not prompt a ticket\'s tile, and points at ticket_action tell instead', async () => {
    await expect(new OrchestratorTools(deps(true)).call('send_prompt', { session: 's1', text: 'hi' }))
      .rejects.toThrow(/managed by ticket CHV-9.*ticket_action.*tell/)
  })

  it('writes the same workspace as before while off, and adds the ticket section and reads once on', async () => {
    expect(workspaceSettings()).toEqual({ permissions: { defaultMode: 'default', allow: PRE_ALLOWED, deny: expect.any(Array) } })
    expect((workspaceSettings(true) as { permissions: { allow: string[] } }).permissions.allow).toEqual([...PRE_ALLOWED, ...TICKET_PRE_ALLOWED])
    expect(INSTRUCTIONS).not.toContain('start_ticket')
    for (const on of [false, true]) {
      const dir = await mkdtempP(path.join(os.tmpdir(), 'tring-agent-wf-'))
      const agent = new OrchestratorAgent({
        dir: path.join(dir, 'o'), statePath: path.join(dir, 'a.json'), url: 'http://x', token: null, scrollback: 10, idleMs: 100,
        mcpScript: path.join(dir, 'tring-mcp.js'), node: process.execPath, multiPr: () => on,
        spawn: (o) => ({ id: o.id, tracker: { status: 'idle' }, claude: null, tick: () => {}, dispose: () => {} }) as unknown as Session,
      })
      await agent.setEnabled(true)
      expect(readFileSync(path.join(dir, 'o', 'TRING.md'), 'utf8')).toBe(on ? INSTRUCTIONS + TICKET_INSTRUCTIONS : INSTRUCTIONS)
      agent.dispose()
    }
  })
})

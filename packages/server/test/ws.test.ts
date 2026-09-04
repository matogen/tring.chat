import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { decodeOutput, type ServerMessage } from '@tring/shared/protocol'
import { ProjectManager } from '../src/project-manager.ts'
import { Hub } from '../src/ws.ts'

interface Rig {
  pm: ProjectManager
  server: Server
  hub: Hub
  dir: string
  port: number
}

const rigs: Rig[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.hub.dispose()
    await r.pm.dispose()
    await new Promise((res) => r.server.close(res))
  }
})

async function rig(opts: { token?: string } = {}): Promise<Rig> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-ws-'))
  const pm = await ProjectManager.open({
    url: 'http://127.0.0.1:0', scrollback: 200, idleMs: 200,
    statePath: path.join(dir, 'projects.json'), tickMs: 50,
  })
  const server = createServer()
  const hub = new Hub({ pm, snapshotMs: 60, token: opts.token ?? null })
  hub.attach(new WebSocketServer({ server }))
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const port = (server.address() as { port: number }).port
  const r = { pm, server, hub, dir, port }
  rigs.push(r)
  return r
}

interface Collected { json: ServerMessage[]; output: string }

function connect(port: number): Promise<{ ws: WebSocket; got: Collected }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const got: Collected = { json: [], output: '' }
  ws.on('message', (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      const d = decodeOutput(new Uint8Array(raw))
      if (d) got.output += new TextDecoder().decode(d.data)
    } else {
      got.json.push(JSON.parse(raw.toString()) as ServerMessage)
    }
  })
  return new Promise((res) => ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello' }))
    res({ ws, got })
  }))
}

async function waitFor(fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('timed out')
}

const pick = <T extends ServerMessage['type']>(got: Collected, type: T) =>
  got.json.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type)

describe('WebSocket hub', () => {
  it('sends the current screen to a client that attaches after a session went quiet', async () => {
    const r = await rig()
    const id = r.pm.createProject('demo', r.dir)
    const session = r.pm.create(id, { cwd: r.dir })!

    // A first viewer drains the change-gated snapshots, exactly as the real
    // client does, and then the shell sits at its prompt producing nothing.
    const first = await connect(r.port)
    await waitFor(() => pick(first.got, 'snapshot').length > 0)
    await new Promise((res) => setTimeout(res, 400))
    const before = pick(first.got, 'snapshot').length
    await new Promise((res) => setTimeout(res, 400))
    expect(pick(first.got, 'snapshot').length).toBe(before) // quiet: nothing resent

    // A second viewer — a reload, another tab — has never seen that screen.
    const second = await connect(r.port)
    await waitFor(() => pick(second.got, 'snapshot').length > 0, 3000)
    const shot = pick(second.got, 'snapshot').find((m) => m.id === session.id)
    expect(shot, 'a freshly attached client got no screen for an idle session').toBeDefined()
    expect(shot!.snapshot.rows.length).toBeGreaterThan(0)

    first.ws.close()
    second.ws.close()
  })

  it('drives a session end to end: state, focus replay, output and status', async () => {
    const r = await rig()
    const { ws, got } = await connect(r.port)
    await waitFor(() => pick(got, 'state').length > 0)

    const projectId = r.pm.createProject('demo', r.dir)
    const session = r.pm.create(projectId, {})!
    ws.send(JSON.stringify({ type: 'activateProject', projectId }))
    ws.send(JSON.stringify({ type: 'focus', id: session.id, cols: 80, rows: 24 }))
    await waitFor(() => pick(got, 'screen').some((m) => m.id === session.id))

    ws.send(JSON.stringify({ type: 'input', id: session.id, data: 'echo ws-marker\n' }))
    await waitFor(() => got.output.includes('ws-marker'))

    ws.send(JSON.stringify({ type: 'input', id: session.id, data: "printf 'y%.0s' $(seq 1 3000)\n" }))
    await waitFor(() => pick(got, 'status').some((m) => m.id === session.id && m.status === 'busy'))
    await waitFor(() => pick(got, 'status').some((m) => m.id === session.id && m.status === 'done'))

    ws.close()
  })

  it('streams snapshots only for the viewed project, but status for every project', async () => {
    const r = await rig()
    const background = r.pm.createProject('background', r.dir)
    const bgSession = r.pm.create(background, {})!
    const viewed = r.pm.createProject('viewed', r.dir)
    const fgSession = r.pm.create(viewed, {})!

    const { ws, got } = await connect(r.port)
    await waitFor(() => pick(got, 'state').length > 0)
    ws.send(JSON.stringify({ type: 'activateProject', projectId: viewed }))
    await waitFor(() => pick(got, 'state').length > 1)

    // Both produce output; only one is being looked at.
    bgSession.write("printf 'b%.0s' $(seq 1 3000)\n")
    fgSession.write("printf 'f%.0s' $(seq 1 3000)\n")

    await waitFor(() => pick(got, 'snapshot').some((m) => m.id === fgSession.id))
    await waitFor(() => pick(got, 'status').some((m) => m.id === bgSession.id && m.status === 'busy'))
    await waitFor(() => pick(got, 'status').some((m) => m.id === bgSession.id && m.status === 'done'))

    // The whole background-cost decision in one assertion.
    expect(pick(got, 'snapshot').filter((m) => m.id === bgSession.id)).toHaveLength(0)
    expect(pick(got, 'snapshot').filter((m) => m.id === fgSession.id).length).toBeGreaterThan(0)

    ws.close()
  })

  it('rejects a bad token and ignores traffic sent before hello', async () => {
    const r = await rig({ token: 'secret' })
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}`)
    const msgs: ServerMessage[] = []
    ws.on('message', (raw: Buffer) => msgs.push(JSON.parse(raw.toString()) as ServerMessage))
    await new Promise<void>((res) => ws.on('open', () => res()))

    // Anything before a successful hello is refused, authenticated or not.
    ws.send(JSON.stringify({ type: 'createProject', name: 'sneaky', root: r.dir }))
    await waitFor(() => msgs.some((m) => m.type === 'error'))
    expect(msgs[0]).toMatchObject({ message: 'expected hello' })
    expect(r.pm.list()).toHaveLength(0)

    ws.send(JSON.stringify({ type: 'hello', token: 'wrong' }))
    await waitFor(() => msgs.some((m) => m.type === 'error' && m.message === 'unauthorized'))
    ws.close()
  })

  it('accepts the right token and then serves state', async () => {
    const r = await rig({ token: 'secret' })
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}`)
    const msgs: ServerMessage[] = []
    ws.on('message', (raw: Buffer) => msgs.push(JSON.parse(raw.toString()) as ServerMessage))
    await new Promise<void>((res) => ws.on('open', () => res()))
    ws.send(JSON.stringify({ type: 'hello', token: 'secret' }))
    await waitFor(() => msgs.some((m) => m.type === 'state'))
    ws.close()
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { decodeOutput, type ServerMessage } from '@tring/shared/protocol'
import { ProjectManager } from '../src/project-manager.ts'
import { createOriginCheck, upgradeGuard } from '../src/security.ts'
import { Hub } from '../src/ws.ts'

/** The daemon puts this on the upgrade; the rig has to as well to be honest. */
const sameOrigin = createOriginCheck()

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
  hub.attach(new WebSocketServer({ server, verifyClient: upgradeGuard(sameOrigin) }))
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
    // client does. Settle on the stream going quiet rather than on a fixed
    // delay: a real shell finishes painting its prompt on its own schedule.
    const first = await connect(r.port)
    await waitFor(() => pick(first.got, 'snapshot').length > 0)
    let last = pick(first.got, 'snapshot').length
    let quiet = 0
    for (let i = 0; i < 40 && quiet < 4; i++) {
      await new Promise((res) => setTimeout(res, 250))
      const n = pick(first.got, 'snapshot').length
      if (n === last) quiet++
      else { quiet = 0; last = n }
    }
    expect(quiet, 'the shell never stopped changing, so this proves nothing').toBe(4)

    // A second viewer — a reload, another tab — has never seen that screen,
    // and the gate will not reopen for it because nothing is changing.
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

  /**
   * The daemon files the focus against the *socket*, so a reconnect loses it
   * while the client still believes it is watching. Nothing errors: input is
   * still delivered, the thumbnail still paints, and only the centre terminal
   * goes silent — which reads as "enter does not work" rather than as a
   * dropped connection. This pins down both halves: that the new socket really
   * is deaf, and that re-sending `focus` on open is what cures it.
   */
  it('sends no output to a reconnected socket until it re-asserts its focus', async () => {
    const r = await rig()
    const projectId = r.pm.createProject('demo', r.dir)
    const session = r.pm.create(projectId, {})!

    const first = await connect(r.port)
    await waitFor(() => pick(first.got, 'state').length > 0)
    first.ws.send(JSON.stringify({ type: 'activateProject', projectId }))
    first.ws.send(JSON.stringify({ type: 'focus', id: session.id, cols: 80, rows: 24 }))
    await waitFor(() => pick(first.got, 'screen').some((m) => m.id === session.id))
    first.ws.send(JSON.stringify({ type: 'input', id: session.id, data: 'echo before-drop\n' }))
    await waitFor(() => first.got.output.includes('before-drop'))
    first.ws.close()

    // The same tab, a moment later, still believing it is focused.
    const again = await connect(r.port)
    await waitFor(() => pick(again.got, 'state').length > 0)
    again.ws.send(JSON.stringify({ type: 'input', id: session.id, data: 'echo after-drop\n' }))
    // The keystrokes land: the session's own buffer has the echo.
    await waitFor(() => session.serialize().includes('after-drop'))
    // The client hears nothing about it.
    expect(again.got.output).toBe('')

    again.ws.send(JSON.stringify({ type: 'focus', id: session.id, cols: 80, rows: 24 }))
    await waitFor(() => pick(again.got, 'screen').some((m) => m.id === session.id))
    again.ws.send(JSON.stringify({ type: 'input', id: session.id, data: 'echo reattached\n' }))
    await waitFor(() => again.got.output.includes('reattached'))

    again.ws.close()
  })

  it('never shows a respawned slot empty, so a focused client can follow it', async () => {
    const r = await rig()
    const projectId = r.pm.createProject('demo', r.dir)
    const before = r.pm.create(projectId, { slot: 4 })!

    const { ws, got } = await connect(r.port)
    await waitFor(() => pick(got, 'state').length > 0)
    ws.send(JSON.stringify({ type: 'activateProject', projectId }))
    await waitFor(() => pick(got, 'state').length > 1)
    const seen = pick(got, 'state').length

    ws.send(JSON.stringify({ type: 'respawn', id: before.id }))
    await waitFor(() => pick(got, 'state').length > seen)
    await new Promise((res) => setTimeout(res, 300))

    // Every state this client was sent has slot 4 occupied. A single one
    // showing it empty is enough for a focused client to blank its terminal.
    for (const state of pick(got, 'state').slice(seen)) {
      const sessions = state.projects.find((p) => p.id === projectId)?.sessions ?? []
      expect(sessions.map((s) => s.slot)).toContain(4)
    }
    const after = r.pm.managerFor(projectId)!.at(4)!
    expect(after.id).not.toBe(before.id)

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

  it('refuses the handshake from a page on another site, before any hello', async () => {
    // This is the critical finding: with no token configured — the default —
    // a socket from any website reached `create` and `input`, which is a shell.
    const r = await rig()
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}`, { origin: 'https://evil.example' })
    const failed = await new Promise<string>((res) => {
      ws.on('unexpected-response', (_req, incoming) => res(`status ${incoming.statusCode}`))
      ws.on('error', (err) => res(err.message))
      ws.on('open', () => res('opened'))
    })
    expect(failed).not.toBe('opened')
    expect(r.pm.list()).toHaveLength(0)
    ws.close()
  })

  it('still accepts the page the daemon serves', async () => {
    const r = await rig()
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}`, {
      origin: `http://127.0.0.1:${r.port}`,
    })
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res())
      ws.on('error', rej)
    })
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

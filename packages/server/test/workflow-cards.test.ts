import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { InboxItem, ServerMessage } from '@tring/shared/protocol'
import { DEFAULT_PREFS, type Device } from '../src/push-store.ts'
import { Inbox } from '../src/inbox.ts'
import { Notifier } from '../src/notifier.ts'
import { ProjectManager } from '../src/project-manager.ts'
import { createOriginCheck, upgradeGuard } from '../src/security.ts'
import { Hub } from '../src/ws.ts'

const wf = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id, sessionId: '', kind: 'workflow', createdAt: 0, ticketId: 't1', title: 'Plan for CHV-9', message: 'two PRs',
  actions: [{ id: 'approve', label: 'Approve' }], ...over,
})

describe('Inbox.syncWorkflow', () => {
  it('adds the cards a ticket shows, announcing only new ones', () => {
    let clock = 10
    const inbox = new Inbox(() => clock)
    const added: string[] = []
    let changes = 0
    inbox.onAdded = (i) => added.push(i.id)
    inbox.onChange = () => { changes++ }
    inbox.syncWorkflow([wf('t1:feature', { kind: 'feature' }), wf('t1:plan:v1')])
    expect(added).toEqual(['t1:feature', 't1:plan:v1'])
    expect(changes).toBe(1)

    clock = 20
    inbox.syncWorkflow([wf('t1:feature', { kind: 'feature', message: 'building · 30 %' }), wf('t1:plan:v1')])
    expect(added).toHaveLength(2)
    expect(inbox.get('t1:feature')).toMatchObject({ message: 'building · 30 %', createdAt: 10 })
    expect(changes).toBe(2)

    inbox.syncWorkflow([wf('t1:feature', { kind: 'feature', message: 'building · 30 %' }), wf('t1:plan:v1')])
    expect(changes).toBe(2)
  })

  it('removes the cards a ticket no longer shows, and leaves every other card alone', () => {
    const inbox = new Inbox()
    const perm = inbox.open({ sessionId: 's1', kind: 'permission', tool: 'Bash', input: {} }, () => {})
    inbox.syncWorkflow([wf('t1:feature', { kind: 'feature' }), wf('t1:plan:v1')])
    inbox.syncWorkflow([wf('t1:feature', { kind: 'feature' })])
    expect(inbox.list().map((i) => i.id).sort()).toEqual([perm.id, 't1:feature'].sort())
  })

  it('does not announce the cards it brings back after a restart', () => {
    const inbox = new Inbox()
    const added: string[] = []
    inbox.onAdded = (i) => added.push(i.id)
    inbox.syncWorkflow([wf('t1:plan:v1')], false)
    expect(added).toEqual([])
    expect(inbox.get('t1:plan:v1')).toBeDefined()
  })
})

describe('phone notifications for workflow cards', () => {
  const phone: Device = {
    sub: { endpoint: 'https://push.example/p', keys: { p256dh: 'p', auth: 'a' } }, prefs: { ...DEFAULT_PREFS }, label: 'p', createdAt: 0, phone: true,
  }
  function notifier(devices: Device[]) {
    const sent: Array<{ title: string; body: string }> = []
    const n = new Notifier({
      devices: () => devices, forget: () => {}, stillOpen: () => true, anyoneActive: () => false, label: () => null,
      send: async (_d, payload) => { sent.push(payload as { title: string; body: string }); return 201 },
      schedule: (fn) => fn(),
    })
    return { n, sent }
  }

  it('says what kind of call is waiting, and nothing from the card', async () => {
    const { n, sent } = notifier([phone])
    await n.fire(wf('t1:plan:v1', { title: 'Plan for CHV-9 secret-project', message: 'owns src/secret/**' }))
    expect(sent).toEqual([expect.objectContaining({ title: 'Multi-PR ticket', body: 'A plan is waiting for your approval' })])
    expect(JSON.stringify(sent)).not.toContain('secret')
  })

  it('never buzzes for a ticket\'s status card, and follows the question setting', async () => {
    const { n, sent } = notifier([phone, { ...phone, prefs: { ...DEFAULT_PREFS, question: false } }])
    await n.fire(wf('t1:feature', { kind: 'feature' }))
    expect(sent).toEqual([])
    await n.fire(wf('t1:finding:1.1.1'))
    expect(sent).toHaveLength(1)
  })
})

describe('a workflow card\'s button over the socket', () => {
  const rigs: Array<{ pm: ProjectManager; server: Server; hub: Hub }> = []
  afterEach(async () => {
    for (const r of rigs.splice(0)) {
      r.hub.dispose()
      await r.pm.dispose()
      await new Promise((res) => r.server.close(res))
    }
  })

  it('goes to the stack engine, and a button no longer current says so to that screen only', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-wf-ws-'))
    const pm = await ProjectManager.open({ url: 'http://127.0.0.1:0', scrollback: 50, idleMs: 200, statePath: path.join(dir, 'projects.json') })
    const inbox = new Inbox()
    inbox.syncWorkflow([wf('t1:plan:v1')])
    const acts: unknown[] = []
    const hub = new Hub({
      pm, inbox, token: null,
      workflow: {
        act: async (...a) => { acts.push(a); return a[2] === 'approve' ? null : 'that card or button is no longer current' },
        ticketViews: () => [],
      },
    })
    const server = createServer()
    hub.attach(new WebSocketServer({ server, verifyClient: upgradeGuard(createOriginCheck()) }))
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
    rigs.push({ pm, server, hub })
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`)
    const got: ServerMessage[] = []
    ws.on('message', (raw: Buffer, bin: boolean) => { if (!bin) got.push(JSON.parse(raw.toString()) as ServerMessage) })
    await new Promise((res) => ws.on('open', res))
    ws.send(JSON.stringify({ type: 'hello' }))
    ws.send(JSON.stringify({ type: 'action', itemId: 't1:plan:v1', actionId: 'approve' }))
    ws.send(JSON.stringify({ type: 'action', itemId: 't1:plan:v1', actionId: 'revise', text: 'smaller' }))
    ws.send(JSON.stringify({ type: 'action', itemId: 'nope', actionId: 'approve' }))
    const end = Date.now() + 3000
    while (Date.now() < end && !got.some((m) => m.type === 'error')) await new Promise((r) => setTimeout(r, 20))
    expect(acts).toEqual([['t1', 't1:plan:v1', 'approve', undefined, undefined], ['t1', 't1:plan:v1', 'revise', 'smaller', undefined]])
    expect(got.filter((m) => m.type === 'error')).toEqual([{ type: 'error', message: 'that card or button is no longer current' }])
    // Dismissing is not how a ticket's card goes away.
    ws.send(JSON.stringify({ type: 'answer', itemId: 't1:plan:v1', decision: 'terminal' }))
    await new Promise((r) => setTimeout(r, 100))
    expect(inbox.get('t1:plan:v1')).toBeDefined()
    ws.close()
  })
})

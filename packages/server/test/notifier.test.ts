import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InboxItem } from '@tring/shared/protocol'
import { message, Notifier, PER_TILE_MS, type Payload } from '../src/notifier.ts'
import { cleanPrefs, DEFAULT_PREFS, PushStore, type Device, type NotifyPrefs } from '../src/push-store.ts'

const dev = (name: string, prefs: Partial<NotifyPrefs> = {}): Device => ({
  sub: { endpoint: `https://push.example/${name}`, keys: { p256dh: 'p', auth: 'a' } },
  prefs: { ...DEFAULT_PREFS, ...prefs }, label: name, createdAt: 0,
})
const card = (kind: InboxItem['kind'], extra: Partial<InboxItem> = {}): InboxItem =>
  ({ id: `i-${kind}`, sessionId: 's-1', kind, createdAt: 0, ...extra })

describe('what a notification says', () => {
  it('names the tile and the kind of card, and nothing from its content', () => {
    const p = message(card('permission', { tool: 'Bash', input: { command: 'cat .env' } }), 'tring.chat/3 api')!
    expect(p.payload).toEqual({ title: 'tring.chat/3 api needs permission', body: 'It wants to run a command.', tag: 's-1', url: '/?inbox=1' })
    expect(JSON.stringify(p)).not.toMatch(/\.env/)
    expect(p.urgency).toBe('high')
    expect(message(card('question', { questions: [{ question: 'Use the secret key?', header: 'Auth method', options: [] }] }), 'x')!.payload.body)
      .toBe('About: Auth method')
    expect(message(card('reply', { message: 'Here is the diff ...' }), 'x')!.payload).toMatchObject({ title: 'x finished', body: 'It is waiting for your reply.' })
    expect(message(card('permission', { tool: 'mcp__github__create_pr' }), 'x')!.payload.body).toBe('It wants to use github tools.')
  })
})

describe('Notifier', () => {
  let devices: Device[]
  let open: Set<string>
  let active: boolean
  let sent: Array<{ to: string; payload: Payload }>
  let status: number
  let clock: number
  let forgot: string[]
  let scheduled: Array<{ fn: () => void; ms: number }>
  let n: Notifier

  beforeEach(() => {
    devices = [dev('phone')]
    open = new Set(['i-permission', 'i-question', 'i-reply'])
    active = false
    sent = []
    status = 201
    clock = 1_000_000
    forgot = []
    scheduled = []
    n = new Notifier({
      devices: () => devices,
      forget: (e) => { forgot.push(e); devices = devices.filter((d) => d.sub.endpoint !== e) },
      stillOpen: (id) => open.has(id),
      anyoneActive: () => active,
      label: (id) => (id === 's-1' ? 'tring.chat/3 api' : null),
      send: async (d, payload) => { sent.push({ to: d.label, payload }); return status },
      now: () => clock,
      schedule: (fn, ms) => scheduled.push({ fn, ms }),
    })
  })

  it('waits before sending, and sends only if the card is still waiting', async () => {
    n.onCard(card('permission'))
    expect(scheduled[0]!.ms).toBe(15_000)
    expect(sent).toEqual([])
    open.delete('i-permission') // approved by the supervisor meanwhile
    await n.fire(card('permission'))
    expect(sent).toEqual([])
    open.add('i-permission')
    await n.fire(card('permission'))
    expect(sent.map((s) => s.to)).toEqual(['phone'])
  })

  it('does nothing at all with no devices', () => {
    devices = []
    n.onCard(card('permission'))
    expect(scheduled).toEqual([])
  })

  it('respects each device\'s choice of cards', async () => {
    devices = [dev('phone', { reply: false }), dev('tablet')]
    await n.fire(card('reply'))
    expect(sent.map((s) => s.to)).toEqual(['tablet'])
  })

  it('stays quiet while you are at a device, unless the device wants it anyway', async () => {
    active = true
    devices = [dev('phone'), dev('watch', { onlyWhenAway: false })]
    await n.fire(card('question'))
    expect(sent.map((s) => s.to)).toEqual(['watch'])
  })

  it('sends at most one per tile per minute to a device', async () => {
    await n.fire(card('permission'))
    await n.fire(card('question'))
    expect(sent).toHaveLength(1)
    clock += PER_TILE_MS
    await n.fire(card('question'))
    expect(sent).toHaveLength(2)
  })

  it('forgets a device the push service says is gone', async () => {
    status = 410
    await n.fire(card('permission'))
    expect(forgot).toEqual(['https://push.example/phone'])
    expect(devices).toEqual([])
  })

  it('never sends to a desktop, marked as one or a 0.1.24 Windows or Linux device', async () => {
    devices = [{ ...dev('pc'), phone: false }, { ...dev('old pc'), label: 'Windows · Chrome' }, { ...dev('old ipad'), label: 'Mac · Safari' }, dev('phone')]
    await n.fire(card('permission'))
    expect(sent.map((s) => s.to)).toEqual(['Mac · Safari', 'phone'])
  })

  it('never sends for a tile that has gone', async () => {
    await n.fire({ ...card('permission'), sessionId: 's-gone' })
    expect(sent).toEqual([])
  })
})

describe('PushStore', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('makes a VAPID key once, keeps devices and their choices, and removes them cleanly', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tring-push-'))
    const file = path.join(dir, 'push.json')
    const a = new PushStore(file)
    await a.load()
    const key = a.vapid.publicKey
    expect(Buffer.from(key, 'base64url')).toHaveLength(65)
    const sub = { endpoint: 'https://push.example/p', keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } }
    await a.upsert(sub, cleanPrefs({ reply: false }), 'iPhone · Safari', 5)
    await a.setPrefs(sub.endpoint, cleanPrefs({ question: false }))

    const b = new PushStore(file)
    await b.load()
    expect(b.vapid.publicKey).toBe(key)
    expect(b.devices()).toEqual([{ sub, prefs: { ...DEFAULT_PREFS, question: false }, label: 'iPhone · Safari', createdAt: 5, phone: true }])
    expect(await b.remove(sub.endpoint)).toBe(true)
    expect(await b.remove(sub.endpoint)).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).devices).toEqual([])
  })

  it('lets go of 0.1.24 desktop devices when it loads, and keeps phones and Macs (an iPad says Mac)', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tring-push-'))
    const file = path.join(dir, 'push.json')
    const sub = (n: string) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } })
    const a = new PushStore(file)
    await a.load()
    const vapid = a.vapid
    writeFileSync(file, JSON.stringify({ vapid, devices: [
      { sub: sub('w'), prefs: DEFAULT_PREFS, label: 'Windows · Chrome', createdAt: 1 },
      { sub: sub('l'), prefs: DEFAULT_PREFS, label: 'Linux · Firefox', createdAt: 1 },
      { sub: sub('i'), prefs: DEFAULT_PREFS, label: 'iPhone · Safari', createdAt: 1 },
      { sub: sub('m'), prefs: DEFAULT_PREFS, label: 'Mac · Safari', createdAt: 1 },
    ] }))
    const b = new PushStore(file)
    await b.load()
    expect(b.devices().map((d) => d.label)).toEqual(['iPhone · Safari', 'Mac · Safari'])
    expect(JSON.parse(readFileSync(file, 'utf8')).devices).toHaveLength(2)
  })

  it('reads anything odd in a stored choice as the default', () => {
    expect(cleanPrefs({ permission: 'yes', reply: false })).toEqual({ ...DEFAULT_PREFS, reply: false })
    expect(cleanPrefs(null)).toEqual(DEFAULT_PREFS)
  })
})

describe('notifications across a restart', () => {
  it('tags by tile, so a card after a restart replaces the notification from before it', async () => {
    const sent: Payload[] = []
    const n = new Notifier({
      devices: () => [dev('phone')],
      forget: () => {},
      stillOpen: () => true,
      anyoneActive: () => false,
      label: () => 'tring.chat/3 api',
      // The same tile before and after: its session id changed, its place did not.
      tile: (id) => (id === 'old' || id === 'new' ? 'project-1/3' : null),
      send: async (_d, payload) => { sent.push(payload); return 201 },
      now: () => 0,
    })
    await n.fire({ ...card('reply'), sessionId: 'old' })
    expect(sent.map((p) => p.tag)).toEqual(['project-1/3'])
    // And one per tile per minute still holds across the new id.
    await n.fire({ ...card('permission'), sessionId: 'new' })
    expect(sent).toHaveLength(1)
  })

  it('falls back to the session id without a tile', () => {
    expect(message(card('reply'), 'x')!.payload.tag).toBe('s-1')
  })
})

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { generateVapid, validSubscription, type Subscription, type Vapid } from './web-push.ts'

/**
 * The devices that asked for notifications, and this daemon's VAPID key.
 *
 * Per device, not per user: each browser's push subscription is a device, and
 * its choices live with it here — the daemon sends while that browser is
 * closed, so the choices cannot live only in its localStorage. A phone turning
 * notifications on never makes the PC buzz.
 *
 * `push.json` holds the VAPID private key, so it is written owner-only.
 */

export interface NotifyPrefs {
  /** A permission prompt is waiting. */
  permission: boolean
  /** An agent asked a question. */
  question: boolean
  /** An agent finished and is waiting for a reply. */
  reply: boolean
  /** Only when no device has tring in front of you (see Hub.anyoneActive). */
  onlyWhenAway: boolean
}

export const DEFAULT_PREFS: NotifyPrefs = { permission: true, question: true, reply: true, onlyWhenAway: true }

export function cleanPrefs(v: unknown): NotifyPrefs {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const pick = (k: keyof NotifyPrefs): boolean => (typeof o[k] === 'boolean' ? o[k] as boolean : DEFAULT_PREFS[k])
  return { permission: pick('permission'), question: pick('question'), reply: pick('reply'), onlyWhenAway: pick('onlyWhenAway') }
}

export interface Device {
  sub: Subscription
  prefs: NotifyPrefs
  /** What the browser said it is, for the device list: "iPhone · Safari". */
  label: string
  createdAt: number
}

interface Saved {
  vapid?: Vapid
  devices?: Device[]
}

export class PushStore {
  private keys: Vapid | null = null
  private list: Device[] = []
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  get vapid(): Vapid {
    if (!this.keys) throw new Error('push store not loaded')
    return this.keys
  }

  async load(): Promise<void> {
    let saved: Saved = {}
    try {
      saved = JSON.parse(await readFile(this.file, 'utf8')) as Saved
    } catch {
      // First run, or unreadable: a new key, and no devices.
    }
    const v = saved.vapid
    const ok = v && typeof v.publicKey === 'string' && typeof v.privateKey === 'string'
    this.keys = ok ? v : generateVapid()
    this.list = (Array.isArray(saved.devices) ? saved.devices : []).flatMap((d) => {
      const sub = validSubscription(d?.sub)
      return sub ? [{ sub, prefs: cleanPrefs(d.prefs), label: String(d.label ?? '').slice(0, 80), createdAt: Number(d.createdAt) || 0 }] : []
    })
    // A new key must be kept: subscriptions are made against it.
    if (!ok) await this.save()
  }

  devices(): Device[] {
    return [...this.list]
  }

  get(endpoint: string): Device | undefined {
    return this.list.find((d) => d.sub.endpoint === endpoint)
  }

  /** Adds the device, or updates it when the same browser subscribes again. */
  async upsert(sub: Subscription, prefs: NotifyPrefs, label: string, now = Date.now()): Promise<void> {
    const kept = this.get(sub.endpoint)
    this.list = this.list.filter((d) => d.sub.endpoint !== sub.endpoint)
    this.list.push({ sub, prefs, label: label.slice(0, 80), createdAt: kept?.createdAt ?? now })
    await this.save()
  }

  async setPrefs(endpoint: string, prefs: NotifyPrefs): Promise<boolean> {
    const d = this.get(endpoint)
    if (!d) return false
    d.prefs = prefs
    await this.save()
    return true
  }

  /** Turning off, removing the device, or the push service saying it is gone. */
  async remove(endpoint: string): Promise<boolean> {
    const before = this.list.length
    this.list = this.list.filter((d) => d.sub.endpoint !== endpoint)
    if (this.list.length === before) return false
    await this.save()
    return true
  }

  private save(): Promise<void> {
    const data: Saved = { vapid: this.keys!, devices: this.list }
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true })
      await writeFile(this.file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
      await chmod(this.file, 0o600).catch(() => { /* Windows has no mode */ })
    }).catch(() => {})
    return this.writing
  }
}

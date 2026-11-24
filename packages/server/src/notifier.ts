import type { InboxItem } from '@tring/shared/protocol'
import { legacyDesktop, type Device } from './push-store.ts'
import type { PushOptions } from './web-push.ts'

/**
 * Phone notifications for orchestrator cards: a permission prompt, a
 * question, an agent that finished. Only cards — and only when they are
 * still waiting a little after they appear, so the ones the supervisor
 * approves in seconds, or that you answer at once, never buzz.
 *
 * Per device (see push-store.ts): its own choice of cards, and by default only
 * when no device has tring in front of you. One notification per tile at a
 * time — a newer card on the same tile replaces it — and at most one per tile
 * per minute per device.
 *
 * What a notification says is kept short and free of content: which tile, and
 * what kind of card. Commands, code and ticket text stay in tring. The message
 * is encrypted for the device, but a locked phone shows it to anyone looking.
 */

/** Long enough for the supervisor's verdict and a person already at a screen. */
export const DELAY_MS = 15_000
/** At most one notification per tile per device in this window. */
export const PER_TILE_MS = 60_000
/** An hour on: a card older than that is better found in tring than on the lock screen. */
const TTL_SECONDS = 3600

export interface Payload {
  title: string
  body: string
  /** One notification per tile: the service worker replaces by tag. */
  tag: string
  /** Where a tap takes you. */
  url: string
}

export interface NotifierOptions {
  devices: () => Device[]
  /** The push service said this device is gone. */
  forget: (endpoint: string) => void
  /** Whether the card is still waiting (not answered, not dropped). */
  stillOpen: (itemId: string) => boolean
  /** Whether a device has tring in front of you right now. */
  anyoneActive: () => boolean
  /** "tring.chat/3 api", or null for a session that is gone. */
  label: (sessionId: string) => string | null
  send: (device: Device, payload: Payload, opts: PushOptions) => Promise<number>
  delayMs?: number
  now?: () => number
  schedule?: (fn: () => void, ms: number) => void
}

/** The tool as a short phrase, with nothing from its input. */
function toolPhrase(tool: string | undefined): string {
  switch (tool) {
    case 'Bash': case 'PowerShell': return 'run a command'
    case 'Edit': case 'MultiEdit': return 'edit a file'
    case 'Write': return 'write a file'
    case 'NotebookEdit': return 'edit a notebook'
    case 'WebFetch': return 'fetch a web page'
    case 'WebSearch': return 'search the web'
    case 'ExitPlanMode': return 'start on its plan'
  }
  if (tool?.startsWith('mcp__')) return `use ${tool.split('__')[1] ?? 'an MCP'} tools`
  return tool ? `use ${tool}` : 'go ahead'
}

/** What the notification says. Null for a card kind that never notifies. */
export function message(item: InboxItem, label: string): { payload: Payload; urgency: PushOptions['urgency'] } | null {
  const base = { tag: item.sessionId, url: '/?inbox=1' }
  if (item.kind === 'permission') {
    return { payload: { ...base, title: `${label} needs permission`, body: `It wants to ${toolPhrase(item.tool)}.` }, urgency: 'high' }
  }
  if (item.kind === 'question') {
    // The chip ("Auth method") says what it is about without the question itself.
    const header = item.questions?.find((q) => q.header)?.header?.slice(0, 40)
    return { payload: { ...base, title: `${label} has a question`, body: header ? `About: ${header}` : 'Answer it in tring.' }, urgency: 'high' }
  }
  if (item.kind === 'reply') {
    return { payload: { ...base, title: `${label} finished`, body: 'It is waiting for your reply.' }, urgency: 'normal' }
  }
  return null
}

export class Notifier {
  private readonly last = new Map<string, number>()

  constructor(private readonly o: NotifierOptions) {}

  private get now(): number {
    return (this.o.now ?? Date.now)()
  }

  /** A card appeared. Looked at again after the delay, and sent only if it still waits. */
  onCard(item: InboxItem): void {
    if (!this.o.devices().length) return
    const schedule = this.o.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.() })
    schedule(() => { void this.fire(item) }, this.o.delayMs ?? DELAY_MS)
  }

  /** Sends for `item` to every device that wants it. Exposed for tests. */
  async fire(item: InboxItem): Promise<void> {
    if (!this.o.stillOpen(item.id)) return
    const label = this.o.label(item.sessionId)
    if (!label) return
    const msg = message(item, label)
    if (!msg) return
    const away = !this.o.anyoneActive()
    for (const d of this.o.devices()) {
      // Never a desktop: notifications are a phone's (see push-store.ts).
      if (d.phone === false || legacyDesktop(d)) continue
      if (!d.prefs[item.kind]) continue
      if (d.prefs.onlyWhenAway && !away) continue
      const key = `${d.sub.endpoint}|${item.sessionId}`
      if (this.now - (this.last.get(key) ?? -Infinity) < PER_TILE_MS) continue
      this.last.set(key, this.now)
      await this.deliver(d, msg.payload, msg.urgency, item.sessionId)
    }
  }

  /** "Send a test": now, whatever the choices say. The push service's status back. */
  async test(device: Device): Promise<number> {
    return this.deliver(device, {
      title: 'tring notifications are on',
      body: 'Cards from the orchestrator will show up here.',
      tag: 'tring-test',
      url: '/?inbox=1',
    }, 'normal', 'test')
  }

  private async deliver(d: Device, payload: Payload, urgency: PushOptions['urgency'], topic: string): Promise<number> {
    let status = 0
    try {
      status = await this.o.send(d, payload, { ttl: TTL_SECONDS, urgency, topic: topic.replace(/-/g, '') })
    } catch {
      return 0 // Offline, or the push service is down: the card is still in tring.
    }
    // The browser unsubscribed or the subscription expired: stop trying it.
    if (status === 404 || status === 410) this.o.forget(d.sub.endpoint)
    return status
  }
}

import {
  decodeOutput, type ClientMessage, type ServerMessage,
} from '@tring/shared/protocol'

/** In dev Vite serves the page; the daemon is still the one holding the PTYs. */
export const DAEMON = import.meta.env.DEV ? 'http://127.0.0.1:7331' : location.origin

/** Present only when the daemon was started with --token (LAN binding). */
export const TOKEN = new URLSearchParams(location.search).get('token') ?? undefined

export async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${DAEMON}${path}`, {
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
  })
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`)
  return body
}

export interface Handlers {
  onMessage: (msg: ServerMessage) => void
  onOutput: (id: string, data: Uint8Array) => void
  onOpen: () => void
  onClose: () => void
}

/** Reconnecting typed socket. Reloading the page loses nothing (spec §2). */
export class WsClient {
  private ws: WebSocket | null = null
  private retry = 0
  private closed = false

  constructor(private readonly h: Handlers, private readonly token: string | undefined = TOKEN) {}

  connect(): void {
    const url = DAEMON.replace(/^http/, 'ws')
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this.retry = 0
      this.send({ type: 'hello', ...(this.token ? { token: this.token } : {}) })
      this.h.onOpen()
    }
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const frame = decodeOutput(new Uint8Array(ev.data))
        if (frame) this.h.onOutput(frame.id, frame.data)
        return
      }
      this.h.onMessage(JSON.parse(String(ev.data)) as ServerMessage)
    }
    ws.onclose = () => {
      this.ws = null
      this.h.onClose()
      if (this.closed) return
      // Backs off to a couple of seconds; the daemon is local, so a restart
      // is the usual reason we are here.
      this.retry = Math.min(this.retry + 1, 8)
      setTimeout(() => this.connect(), Math.min(200 * this.retry, 2000))
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  dispose(): void {
    this.closed = true
    this.ws?.close()
  }
}

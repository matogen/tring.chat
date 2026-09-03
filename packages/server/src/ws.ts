import type { WebSocket, WebSocketServer } from 'ws'
import { encodeOutput, type ClientMessage, type ServerMessage } from '@tring/shared/protocol'
import type { ProjectManager } from './project-manager.ts'
import type { Session } from './session.ts'

export interface HubOptions {
  pm: ProjectManager
  token?: string | null
  /** Snapshot cadence; spec caps thumbnails at 4 per second. */
  snapshotMs?: number
}

interface Client {
  ws: WebSocket
  authed: boolean
  /** Each socket views its own project, so two tabs can sit in different ones. */
  projectId: string | null
  focusedId: string | null
}

export class Hub {
  private readonly clients = new Set<Client>()
  private readonly timer: NodeJS.Timeout

  constructor(private readonly opts: HubOptions) {
    const pm = opts.pm
    pm.onChange = () => this.broadcastState()
    pm.onSessionStatus = (s) => this.broadcastStatus(s)
    pm.onSessionExit = (s, code) => this.broadcast({ type: 'exit', id: s.id, code })
    pm.onSessionData = (s, data) => {
      const frame = encodeOutput(s.id, Buffer.from(data, 'utf8'))
      for (const c of this.clients) {
        if (c.authed && c.focusedId === s.id) c.ws.send(frame, { binary: true })
      }
    }

    // One loop for the whole hub rather than one per socket: takeSnapshot()
    // reports a change only once, so a per-socket loop would starve the second
    // tab viewing the same project.
    this.timer = setInterval(() => this.pumpSnapshots(), opts.snapshotMs ?? 250)
    this.timer.unref?.()
  }

  attach(wss: WebSocketServer): void {
    wss.on('connection', (ws) => this.accept(ws))
  }

  dispose(): void {
    clearInterval(this.timer)
  }

  private accept(ws: WebSocket): void {
    const client: Client = { ws, authed: false, projectId: null, focusedId: null }
    this.clients.add(client)
    ws.on('close', () => this.clients.delete(client))
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return
      let msg: ClientMessage
      try {
        msg = JSON.parse(String(raw)) as ClientMessage
      } catch {
        return this.send(client, { type: 'error', message: 'malformed message' })
      }
      try {
        this.handle(client, msg)
      } catch (err) {
        this.send(client, { type: 'error', message: (err as Error).message })
      }
    })
  }

  private handle(c: Client, msg: ClientMessage): void {
    const pm = this.opts.pm

    if (msg.type === 'hello') {
      if (this.opts.token && msg.token !== this.opts.token) {
        this.send(c, { type: 'error', message: 'unauthorized' })
        c.ws.close()
        return
      }
      c.authed = true
      c.projectId = pm.activeProjectId
      this.sendState(c)
      return
    }
    if (!c.authed) return this.send(c, { type: 'error', message: 'expected hello' })

    switch (msg.type) {
      case 'activateProject': {
        pm.activate(msg.projectId)
        c.projectId = msg.projectId
        c.focusedId = null
        this.sendState(c)
        break
      }
      case 'createProject': {
        const id = pm.createProject(msg.name, msg.root)
        c.projectId = id
        break
      }
      case 'renameProject':
        pm.renameProject(msg.projectId, msg.name)
        break
      case 'deleteProject':
        pm.deleteProject(msg.projectId)
        if (c.projectId === msg.projectId) {
          c.projectId = pm.activeProjectId
          c.focusedId = null
        }
        break
      case 'create':
        pm.create(msg.projectId ?? c.projectId ?? undefined, {
          slot: msg.slot,
          cwd: msg.cwd,
          command: msg.command ?? null,
          name: msg.name ?? null,
        })
        break
      case 'focus': {
        c.focusedId = msg.id
        if (!msg.id) break
        const s = pm.findSession(msg.id)
        if (!s) break
        s.resize(msg.cols, msg.rows)
        this.send(c, { type: 'screen', id: s.id, ansi: s.serialize() })
        break
      }
      case 'input': {
        pm.findSession(msg.id)?.write(msg.data)
        break
      }
      case 'resize': {
        if (c.focusedId) pm.findSession(c.focusedId)?.resize(msg.cols, msg.rows)
        break
      }
      case 'kill':
        pm.findManager(msg.id)?.kill(msg.id)
        break
      case 'rename':
        pm.findManager(msg.id)?.rename(msg.id, msg.name)
        break
      case 'ack':
        pm.findSession(msg.id)?.ack()
        break
      case 'respawn':
        pm.findManager(msg.id)?.respawn(msg.id)
        break
    }
  }

  /**
   * Snapshots go only to sockets whose viewed project owns the session. A
   * background project keeps its PTYs and its status tracking — that is what
   * the tab badge reads — but costs no pixels.
   */
  private pumpSnapshots(): void {
    const viewed = new Set<string>()
    for (const c of this.clients) if (c.authed && c.projectId) viewed.add(c.projectId)
    if (viewed.size === 0) return

    for (const project of this.opts.pm.list()) {
      if (!viewed.has(project.id)) continue
      const mgr = this.opts.pm.managerFor(project.id)
      if (!mgr) continue
      for (const session of mgr.list()) {
        const shot = session.takeSnapshot()
        if (!shot) continue
        const msg: ServerMessage = { type: 'snapshot', id: session.id, snapshot: shot }
        for (const c of this.clients) {
          if (c.authed && c.projectId === project.id) this.send(c, msg)
        }
      }
    }
  }

  private broadcastStatus(s: Session): void {
    this.broadcast({
      type: 'status',
      id: s.id,
      status: s.tracker.status,
      since: s.tracker.since,
      title: s.title,
    })
  }

  private sendState(c: Client): void {
    this.send(c, {
      type: 'state',
      projects: this.opts.pm.list(),
      activeProjectId: c.projectId ?? this.opts.pm.activeProjectId,
    })
  }

  private broadcastState(): void {
    for (const c of this.clients) if (c.authed) this.sendState(c)
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.clients) if (c.authed) this.send(c, msg)
  }

  private send(c: Client, msg: ServerMessage): void {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg))
  }
}

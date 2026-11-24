import type { WebSocket, WebSocketServer } from 'ws'
import {
  encodeOutput, type ClientMessage, type ServerMessage, type UpdateInfo,
} from '@tring/shared/protocol'
import type { ProjectManager } from './project-manager.ts'
import { secretEquals } from './security.ts'
import type { Session } from './session.ts'
import type { Inbox } from './inbox.ts'
import type { AutoAnswerer } from './auto-answer.ts'
import type { OrchestratorAgent } from './orchestrator-agent.ts'
import { cleanPrompt, typePrompt } from './type-prompt.ts'

export interface HubOptions {
  pm: ProjectManager
  token?: string | null
  /** Snapshot cadence; spec caps thumbnails at 4 per second. */
  snapshotMs?: number
  /** Orchestrator mode's cards. Without one, `answer` and `reply` do nothing. */
  inbox?: Inbox | null
  /** The supervisor; its switch and history are pushed to every client. */
  auto?: AutoAnswerer | null
  /** The orchestrator agent; its terminal is reachable by id like any session's. */
  agent?: OrchestratorAgent | null
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
  private update: UpdateInfo | null = null

  constructor(private readonly opts: HubOptions) {
    const pm = opts.pm
    pm.onChange = () => {
      // A killed or deleted session never sends `exit` here, and its cards
      // would otherwise wait for an agent that no longer exists.
      opts.inbox?.drop((i) => !pm.findSession(i.sessionId))
      this.broadcastState()
    }
    pm.onSessionStatus = (s) => {
      // A reply card is "this session stopped and is waiting for you". Once
      // it is working again that is over. Typing a prompt into its terminal
      // ends it too, through the UserPromptSubmit hook; idle is not enough on
      // its own, since a reply short enough never to have looked busy leaves
      // the session idle from start to finish.
      if (s.tracker.status === 'busy') opts.inbox?.dropSession(s.id, 'reply')
      this.broadcastStatus(s)
    }
    pm.onSessionExit = (s, code) => {
      opts.inbox?.dropSession(s.id)
      this.broadcast({ type: 'exit', id: s.id, code })
    }
    if (opts.inbox) opts.inbox.onChange = () => this.broadcastInbox()
    if (opts.auto) opts.auto.onChange = () => this.broadcastAuto()
    const output = (s: Session, data: string): void => {
      const frame = encodeOutput(s.id, Buffer.from(data, 'utf8'))
      for (const c of this.clients) {
        if (c.authed && c.focusedId === s.id) c.ws.send(frame, { binary: true })
      }
    }
    pm.onSessionData = output
    if (opts.agent) {
      opts.agent.onData = output
      opts.agent.onChange = () => this.broadcastAgent()
    }

    // One loop for the whole hub rather than one per socket: takeSnapshot()
    // reports a change only once, so a per-socket loop would starve the second
    // tab viewing the same project.
    this.timer = setInterval(() => this.pumpSnapshots(), opts.snapshotMs ?? 250)
    this.timer.unref?.()
  }

  /** The registry check is async and must never delay startup, so the notice
   *  arrives later and is pushed to whoever is already connected. */
  setUpdate(update: UpdateInfo): void {
    this.update = update
    this.broadcastState()
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
      // Compared in constant time: this one is reachable from off the machine
      // whenever the daemon is bound past loopback, which is the whole reason
      // a token exists.
      if (this.opts.token && !secretEquals(this.opts.token, msg.token)) {
        this.send(c, { type: 'error', message: 'unauthorized' })
        c.ws.close()
        return
      }
      c.authed = true
      c.projectId = pm.activeProjectId
      this.sendState(c)
      this.sendSnapshots(c)
      if (this.opts.inbox) this.send(c, { type: 'inbox', items: this.opts.inbox.list() })
      if (this.opts.auto) this.send(c, this.autoMessage(this.opts.auto))
      if (this.opts.agent) this.send(c, { type: 'agent', agent: this.opts.agent.info() })
      return
    }
    if (!c.authed) return this.send(c, { type: 'error', message: 'expected hello' })

    switch (msg.type) {
      case 'activateProject': {
        pm.activate(msg.projectId)
        c.projectId = msg.projectId
        // The orchestrator agent belongs to no project: switching projects
        // underneath it must not stop its output reaching this screen. That
        // was the "freezes when I change tabs": keys still went in, nothing
        // came back.
        c.focusedId = this.keepFocus(c)
        this.sendState(c)
        this.sendSnapshots(c)
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
          c.focusedId = this.keepFocus(c)
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
        const s = this.find(msg.id)
        if (!s) break
        s.resize(msg.cols, msg.rows)
        this.send(c, { type: 'screen', id: s.id, ansi: s.serialize() })
        break
      }
      case 'input': {
        this.find(msg.id)?.write(msg.data)
        break
      }
      case 'resize': {
        if (c.focusedId) this.find(c.focusedId)?.resize(msg.cols, msg.rows)
        break
      }
      case 'agent': {
        const agent = this.opts.agent
        if (!agent) break
        if (typeof msg.enabled === 'boolean') void agent.setEnabled(msg.enabled)
        else if (msg.restart === 'resume' || msg.restart === 'fresh') void agent.restart(msg.restart === 'fresh')
        break
      }
      case 'kill':
        pm.findManager(msg.id)?.kill(msg.id)
        break
      case 'rename':
        pm.findManager(msg.id)?.rename(msg.id, msg.name)
        break
      case 'color':
        pm.findManager(msg.id)?.setColor(msg.id, msg.color)
        break
      case 'move':
        pm.findManager(msg.id)?.move(msg.id, msg.slot)
        break
      case 'ack':
        pm.findSession(msg.id)?.ack()
        break
      case 'respawn':
        pm.findManager(msg.id)?.respawn(msg.id)
        break
      case 'answer': {
        const inbox = this.opts.inbox
        const item = inbox?.get(msg.itemId)
        // A card already settled elsewhere is not an error worth showing:
        // the inbox broadcast that removed it is already on its way.
        if (!inbox || !item) break
        if (msg.decision !== 'allow' && msg.decision !== 'deny' && msg.decision !== 'terminal') break
        // A reply card can only be dismissed; its answer is typed, via `reply`.
        if (item.kind === 'reply' && msg.decision !== 'terminal') break
        inbox.answer(item.id, {
          decision: msg.decision,
          ...(msg.answers ? { answers: msg.answers } : {}),
          ...(typeof msg.message === 'string' ? { message: msg.message } : {}),
        })
        break
      }
      case 'autoAnswer':
        void this.opts.auto?.setEnabled(msg.enabled === true)
        break
      case 'reply': {
        const inbox = this.opts.inbox
        const item = inbox?.get(msg.itemId)
        if (!inbox || !item || item.kind !== 'reply') break
        const s = pm.findSession(item.sessionId)
        const text = cleanPrompt(msg.text)
        // Never typed into a session that has started working again: the
        // prompt this reply was written for is no longer the one on screen.
        if (!s || s.tracker.status === 'busy' || s.tracker.status === 'exited' || !text) break
        inbox.answer(item.id, { decision: 'allow' })
        // A follow-up typed into a session that has stopped and is waiting.
        typePrompt(s, text)
        break
      }
    }
  }

  /**
   * Every tile in the project this client has just started viewing, once.
   *
   * The pump below only emits on change, which is what keeps sixteen tiles
   * cheap — but it means a session that has gone quiet is never sent again.
   * Attaching is exactly when a viewer has seen nothing, so it gets the
   * screens as they stand rather than waiting for output that may never come.
   */
  private sendSnapshots(c: Client): void {
    if (!c.projectId) return
    const mgr = this.opts.pm.managerFor(c.projectId)
    if (!mgr) return
    for (const session of mgr.list()) {
      this.send(c, { type: 'snapshot', id: session.id, snapshot: session.snapshotNow() })
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
      notable: s.tracker.notable,
    })
  }

  private autoMessage(auto: AutoAnswerer): ServerMessage {
    return { type: 'autoAnswer', enabled: auto.enabled, history: auto.decisions }
  }

  private broadcastAuto(): void {
    if (this.opts.auto) this.broadcast(this.autoMessage(this.opts.auto))
  }

  /**
   * What a socket stays focused on when its project changes: the orchestrator
   * agent, which is in no project, and nothing else.
   */
  private keepFocus(c: Client): string | null {
    return c.focusedId && this.opts.agent?.find(c.focusedId) ? c.focusedId : null
  }

  /** A tile, or the orchestrator agent's own terminal. */
  private find(id: string): Session | undefined {
    return this.opts.pm.findSession(id) ?? this.opts.agent?.find(id)
  }

  private broadcastAgent(): void {
    if (this.opts.agent) this.broadcast({ type: 'agent', agent: this.opts.agent.info() })
  }

  private broadcastInbox(): void {
    if (this.opts.inbox) this.broadcast({ type: 'inbox', items: this.opts.inbox.list() })
  }

  private sendState(c: Client): void {
    this.send(c, {
      type: 'state',
      projects: this.opts.pm.list(),
      activeProjectId: c.projectId ?? this.opts.pm.activeProjectId,
      update: this.update,
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

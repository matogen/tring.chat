import type { WebSocket, WebSocketServer } from 'ws'
import { sanitizeInput } from '@tring/shared/browser-input'
import {
  CHANNEL_FRAME, encodeBinary, encodeOutput,
  type Capabilities, type ClientMessage, type ServerMessage, type UpdateInfo,
} from '@tring/shared/protocol'
import type { ProjectManager } from './project-manager.ts'
import { secretEquals } from './security.ts'
import type { Session } from './session.ts'

export interface HubOptions {
  pm: ProjectManager
  token?: string | null
  /** Snapshot cadence; spec caps thumbnails at 4 per second. */
  snapshotMs?: number
  /**
   * Read per state message, so an install flips the UI without a restart.
   * Takes the client's project, since the enabled half of the answer is a
   * per-project setting (spec §4.7).
   */
  capabilities?: (projectId: string | null) => Capabilities
}

/** What one client wants to see of one session's page (spec §4.7). */
interface BrowserView {
  width: number
  height: number
  focused: boolean
}

interface Client {
  ws: WebSocket
  authed: boolean
  /** Each socket views its own project, so two tabs can sit in different ones. */
  projectId: string | null
  focusedId: string | null
  /** Per session id, so a thumbnail and a focused pane can coexist. */
  views: Map<string, BrowserView>
}

export class Hub {
  private readonly clients = new Set<Client>()
  private readonly timer: NodeJS.Timeout
  private update: UpdateInfo | null = null

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
    // Screencast frames obey the snapshot rule of §4.4: a browser in a
    // background project keeps running and keeps reporting status, but costs
    // no pixels.
    pm.onSessionFrame = (s, jpeg) => {
      const frame = encodeBinary(s.id, CHANNEL_FRAME, jpeg)
      for (const c of this.clients) {
        if (c.authed && c.projectId === s.projectId) c.ws.send(frame, { binary: true })
      }
    }
    pm.onSessionBrowser = (s) => {
      this.broadcast({ type: 'browser', id: s.id, browser: s.browser?.info() ?? null })
    }
    pm.onSessionBrowserPrompt = (s, url) => {
      this.broadcast({ type: 'browserPrompt', id: s.id, url })
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

  /**
   * Re-push state to everyone. For changes the ProjectManager never sees — a
   * Chromium download finishing flips a capability without touching a project.
   */
  refreshState(): void {
    this.broadcastState()
  }

  dispose(): void {
    clearInterval(this.timer)
  }

  private accept(ws: WebSocket): void {
    const client: Client = {
      ws, authed: false, projectId: null, focusedId: null, views: new Map(),
    }
    this.clients.add(client)
    ws.on('close', () => {
      this.clients.delete(client)
      // The pages this client was watching may now have no viewer, or a
      // smaller one; a closed tab must not hold a page at focus resolution.
      for (const id of client.views.keys()) void this.refreshView(id)
    })
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
      return
    }
    if (!c.authed) return this.send(c, { type: 'error', message: 'expected hello' })

    switch (msg.type) {
      case 'activateProject': {
        pm.activate(msg.projectId)
        c.projectId = msg.projectId
        c.focusedId = null
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
          c.focusedId = null
        }
        break
      case 'create':
        pm.create(msg.projectId ?? c.projectId ?? undefined, {
          slot: msg.slot,
          cwd: msg.cwd,
          command: msg.command ?? null,
          name: msg.name ?? null,
          ...(msg.browser ? { browser: { url: msg.url ?? null } } : {}),
        })
        break
      case 'attachBrowser':
        // Awaited nowhere: launching a browser takes a second or two and the
        // socket must stay responsive. The `browser` broadcast reports the
        // result when it arrives.
        void pm.findManager(msg.id)?.attachBrowser(msg.id, msg.url)
        break
      case 'detachBrowser':
        pm.findManager(msg.id)?.detachBrowser(msg.id)
        break
      case 'browserInput': {
        const browser = pm.findSession(msg.id)?.browser
        if (!browser) break
        // Rebuilt field by field rather than forwarded: this arrived over a
        // socket and is about to become a CDP dispatch (spec §4.7).
        const event = sanitizeInput(msg.event, browser.info().viewport)
        if (event) void browser.input(event)
        break
      }
      case 'browserGrab':
        pm.findSession(msg.id)?.browser?.grab()
        break
      case 'browserRelease':
        pm.findSession(msg.id)?.browser?.release()
        break
      case 'browserNavigate':
        void pm.findSession(msg.id)?.browser?.navigate(msg.to)
        break
      case 'projectBrowser': {
        pm.setBrowserSettings(msg.projectId, {
          ...(msg.enabled !== undefined ? { enabled: msg.enabled } : {}),
          ...(msg.allow !== undefined ? { allow: msg.allow } : {}),
          ...(msg.eval !== undefined ? { eval: msg.eval } : {}),
        })
        // Capability is per project, so every client viewing it needs the new
        // answer — not only the one that flipped the switch.
        this.broadcastState()
        break
      }
      case 'browserView': {
        c.views.set(msg.id, {
          width: msg.width,
          height: msg.height,
          focused: c.focusedId === msg.id,
        })
        void this.refreshView(msg.id)
        break
      }
      case 'focus': {
        const previous = c.focusedId
        c.focusedId = msg.id
        // Focus decides a page's resolution, so both the session being left
        // and the one being entered have to be reconsidered.
        for (const [id, view] of c.views) {
          view.focused = id === msg.id
        }
        if (previous && previous !== msg.id) void this.refreshView(previous)
        if (msg.id) void this.refreshView(msg.id)
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
      case 'color':
        pm.findManager(msg.id)?.setColor(msg.id, msg.color)
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

  /**
   * One page, one screencast, so its size is the best any viewer wants rather
   * than something each of them sets.
   *
   * A focused pane outranks every thumbnail; among equals the largest wins, so
   * two tabs watching the same tile do not fight. A page nobody is watching
   * keeps its last size — stopping the screencast outright would blank the
   * tile of a client that reconnects a moment later.
   */
  private async refreshView(sessionId: string): Promise<void> {
    const browser = this.opts.pm.findSession(sessionId)?.browser
    if (!browser) return

    let best: BrowserView | null = null
    for (const c of this.clients) {
      if (!c.authed) continue
      const view = c.views.get(sessionId)
      if (!view) continue
      if (!best) { best = view; continue }
      if (view.focused && !best.focused) { best = view; continue }
      if (view.focused === best.focused && view.width > best.width) best = view
    }
    if (!best) return
    await browser.setViewport(best.width, best.height, best.focused)
  }

  private sendState(c: Client): void {
    this.send(c, {
      type: 'state',
      projects: this.opts.pm.list(),
      activeProjectId: c.projectId ?? this.opts.pm.activeProjectId,
      update: this.update,
      ...(this.opts.capabilities
        ? { capabilities: this.opts.capabilities(c.projectId) }
        : {}),
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

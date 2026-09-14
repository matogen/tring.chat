import { randomUUID } from 'node:crypto'
import type { BrowserHost } from './browser.ts'
import { Session } from './session.ts'

export interface SessionSpec {
  slot?: number
  cwd?: string
  command?: string | null
  name?: string | null
  color?: string | null
  /** False when restoring from disk; see Session's `autorun`. */
  autorun?: boolean
  /**
   * Attach a browser on creation, reopening this url (spec §4.7).
   *
   * Unlike `command` this *is* replayed on restore: a re-run command executes
   * work, where a reopened page restores a view, and the profile is on disk
   * either way.
   */
  browser?: { url?: string | null } | null
}

export interface SessionManagerOptions {
  projectId: string
  projectName: string
  root: string
  url: string
  token?: string | null
  scrollback: number
  idleMs: number
  shell?: string
  /** Null when browser agents are unavailable or switched off (spec §4.7). */
  browserHost?: BrowserHost | null
}

export const SLOT_COUNT = 16

const HEX = /^#[0-9a-f]{6}$/i

/** The 16 fixed slots of one project (spec §4.3). */
export class SessionManager {
  private readonly bySlot = new Map<number, Session>()
  private readonly byId = new Map<string, Session>()

  onSessionData: ((s: Session, data: string) => void) | null = null
  onSessionStatus: ((s: Session) => void) | null = null
  onSessionExit: ((s: Session, code: number) => void) | null = null
  onStructureChange: (() => void) | null = null
  onSessionBrowser: ((s: Session) => void) | null = null
  onSessionFrame: ((s: Session, jpeg: Buffer) => void) | null = null
  onSessionBrowserPrompt: ((s: Session, url: string) => void) | null = null

  constructor(private readonly opts: SessionManagerOptions) {}

  create(spec: SessionSpec = {}): Session {
    const slot = spec.slot ?? this.firstEmptySlot()
    if (slot === null) throw new Error('all 16 slots are full')
    if (slot < 1 || slot > SLOT_COUNT) throw new Error(`slot ${slot} out of range`)
    if (this.bySlot.has(slot)) throw new Error(`slot ${slot} is occupied`)

    const session = new Session({
      // Globally unique across every project, which is what lets the HTTP API
      // and the Claude Code Stop hook address a session without knowing its
      // project (spec §4.5).
      id: randomUUID(),
      projectId: this.opts.projectId,
      projectName: this.opts.projectName,
      slot,
      cwd: spec.cwd ?? this.opts.root,
      command: spec.command ?? null,
      name: spec.name ?? null,
      color: HEX.test(spec.color ?? '') ? spec.color! : null,
      url: this.opts.url,
      token: this.opts.token ?? null,
      scrollback: this.opts.scrollback,
      idleMs: this.opts.idleMs,
      ...(this.opts.shell ? { shell: this.opts.shell } : {}),
      autorun: spec.autorun,
    })

    session.onData = (data) => this.onSessionData?.(session, data)
    session.onStatusChange = () => this.onSessionStatus?.(session)
    session.onExit = (code) => this.onSessionExit?.(session, code)
    // A moved shell changes what a restart would restore, so persist it.
    session.onCwdChange = () => this.onStructureChange?.()
    session.onBrowserChange = () => {
      this.onSessionBrowser?.(session)
      this.onStructureChange?.()
    }
    session.onBrowserFrame = (jpeg) => this.onSessionFrame?.(session, jpeg)
    session.onBrowserPrompt = (url) => this.onSessionBrowserPrompt?.(session, url)

    this.bySlot.set(slot, session)
    this.byId.set(session.id, session)
    this.onStructureChange?.()
    // After the session is registered, so the change it fires finds it.
    if (spec.browser) void this.attachBrowser(session.id, spec.browser.url ?? undefined)
    return session
  }

  /**
   * Give a running session a page (spec §4.7).
   *
   * Nothing here touches the PTY. A user toggling Terminal to Browser Agent on
   * a working tile keeps their shell, their process and their scrollback, which
   * is the claim the whole design rests on.
   */
  async attachBrowser(id: string, url?: string): Promise<void> {
    const session = this.byId.get(id)
    const host = this.opts.browserHost
    if (!session || !host || session.browser) return
    const browser = await host.attach(this.opts.projectId, session.id, url)
    // The session may have been killed while the browser was opening.
    if (!this.byId.has(id)) {
      await browser.dispose()
      return
    }
    session.attachBrowser(browser)
  }

  detachBrowser(id: string): void {
    this.byId.get(id)?.detachBrowser()
  }

  get(id: string): Session | undefined {
    return this.byId.get(id)
  }

  at(slot: number): Session | undefined {
    return this.bySlot.get(slot)
  }

  list(): Session[] {
    return [...this.bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s)
  }

  rename(id: string, name: string): void {
    const s = this.byId.get(id)
    if (!s) return
    s.name = name
    this.onStructureChange?.()
  }

  /**
   * The tint ends up in a CSS custom property in the browser, and arrives from
   * a socket, so anything but a plain hex value clears the colour rather than
   * being passed along. Every path that sets a colour routes through here.
   */
  setColor(id: string, color: string | null): void {
    const s = this.byId.get(id)
    if (!s) return
    s.color = color !== null && HEX.test(color) ? color : null
    this.onStructureChange?.()
  }

  kill(id: string): void {
    const s = this.byId.get(id)
    if (!s) return
    s.dispose()
    this.bySlot.delete(s.slot)
    this.byId.delete(id)
    this.onStructureChange?.()
  }

  /**
   * Explicit user-initiated respawn of a dead tile. Unlike daemon restore this
   * *does* re-run the recorded command, because the user asked for it.
   */
  respawn(id: string): Session | undefined {
    const old = this.byId.get(id)
    if (!old) return undefined
    const browser = old.browser
    const spec: SessionSpec = {
      slot: old.slot,
      cwd: old.cwd,
      command: old.command,
      name: old.name,
      color: old.color,
      autorun: true,
      ...(browser ? { browser: { url: browser.info().url } } : {}),
    }
    this.kill(id)
    return this.create(spec)
  }

  tick(now: number): void {
    for (const s of this.bySlot.values()) s.tick(now)
  }

  disposeAll(): void {
    for (const s of this.bySlot.values()) s.dispose()
    this.bySlot.clear()
    this.byId.clear()
  }

  private firstEmptySlot(): number | null {
    for (let slot = 1; slot <= SLOT_COUNT; slot++) if (!this.bySlot.has(slot)) return slot
    return null
  }
}

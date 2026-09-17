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
  /** Exported to each session as $TRING_MCP_CONFIG (spec §4.8). */
  mcpConfigPath?: string | null
  /** Put first on each session's PATH, so plain `claude` has tools (§4.8). */
  shimPath?: string | null
}

export const SLOT_COUNT = 16

const HEX = /^#[0-9a-f]{6}$/i

/**
 * Playwright's launch failures arrive as a page of Chromium command line and
 * browser log, which is the right thing for a stack trace and the wrong thing
 * for a toast. The one failure worth naming specifically is a missing system
 * library: it is the normal state of a fresh Linux or WSL box, it has nothing
 * to do with tring, and it has an exact fix.
 */
export function describeLaunchFailure(err: Error): string {
  const text = err.message
  const lib = /error while loading shared libraries: ([^:]+)/.exec(text)
  if (lib) {
    return `Chromium is missing system libraries (${lib[1]}). ` +
      'Install them with:  sudo npx playwright install-deps chromium'
  }
  if (/Executable doesn't exist|ENOENT/.test(text)) {
    return 'Chromium is not installed. Enable browser agents again to download it.'
  }
  // Anything else: the first line, which is the part that ever says why.
  return `Could not start the browser: ${text.split('\n')[0]}`
}

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
  /** A browser that would not start, reported instead of thrown. */
  onBrowserError: ((s: Session, message: string) => void) | null = null

  constructor(private opts: SessionManagerOptions) {}

  /**
   * Turn attachment on or off for a project that is already running.
   *
   * Withholding the host rather than keeping a flag beside it: with nothing to
   * attach with, there is no path that could attach anyway. Disabling detaches
   * what is already open, because leaving pages running under a switch that
   * says off is the kind of gap someone finds later.
   */
  setBrowserHost(host: BrowserHost | null): void {
    this.opts = { ...this.opts, browserHost: host }
    if (host) return
    for (const s of this.bySlot.values()) s.detachBrowser()
  }

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
      mcpConfigPath: this.opts.mcpConfigPath ?? null,
      shimPath: this.opts.shimPath ?? null,
      // Recorded on the session before the attach below is even attempted, so
      // a save in the gap cannot decide this tile never had a page (§4.3).
      browser: spec.browser ?? null,
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
  /**
   * Never rejects.
   *
   * Launching a browser fails for reasons that have nothing to do with tring —
   * missing system libraries, a half-finished download, no memory — and the
   * daemon's job is serving terminals. An unhandled rejection here takes the
   * whole process down and every running shell with it, which is a spectacularly
   * bad trade for a feature the user switched on a moment ago.
   */
  async attachBrowser(id: string, url?: string): Promise<void> {
    const session = this.byId.get(id)
    const host = this.opts.browserHost
    if (!session || !host || session.browser) return
    try {
      const browser = await host.attach(this.opts.projectId, session.id, url)
      // The session may have been killed while the browser was opening.
      if (!this.byId.has(id)) {
        await browser.dispose()
        return
      }
      session.attachBrowser(browser)
    } catch (err) {
      this.onBrowserError?.(session, describeLaunchFailure(err as Error))
    }
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

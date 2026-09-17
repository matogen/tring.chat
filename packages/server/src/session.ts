import { readlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawn, type IPty } from 'node-pty'
import type { Terminal as TerminalT } from '@xterm/headless'
import type { SerializeAddon as SerializeAddonT } from '@xterm/addon-serialize'
import { ActivityTracker, DEFAULT_IDLE_MS } from '@tring/shared/status'
import { DEFAULT_SCROLLBACK, type ScreenSnapshot, type SessionInfo } from '@tring/shared/protocol'
import { snapshot } from './snapshot.ts'
import { prependToPath } from './agent-shim.ts'
import type { AttachedBrowser } from './browser.ts'
import { commandArgs, defaultShell, interactiveArgs, shQuote, usesPosixCd } from './shell.ts'

// Both xterm packages are CJS bundles that assign their exports in a way
// Node's ESM lexer cannot detect, so `import { Terminal }` resolves to
// undefined under a native loader even though bundlers cope. Requiring them
// explicitly is correct at runtime; `typeof import(...)` keeps the types.
const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless')
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize')

/** How often to re-read the shell's working directory. */
const CWD_POLL_MS = 2000
/** Grace period for rc files to finish before checking where we landed. */
const CWD_ENFORCE_MS = 400

export interface SessionOptions {
  id: string
  projectId: string
  projectName: string
  slot: number
  cwd: string
  command?: string | null
  name?: string | null
  color?: string | null
  url: string
  /** The daemon's bearer token, exported as $TRING_TOKEN. Null when disabled. */
  token?: string | null
  /** Exported as $TRING_MCP_CONFIG so an agent can be launched with the
   *  browser tools already wired up (spec §4.8). */
  mcpConfigPath?: string | null
  /**
   * Put first on the session's PATH so plain `claude` gets browser tools
   * (spec §4.8). Null when the platform has no shim.
   */
  shimPath?: string | null
  /**
   * The page this tile owns, recorded before it can possibly be open (§4.3).
   * Set when restoring, so a save during the launch cannot erase it.
   */
  browser?: { url?: string | null } | null
  scrollback?: number
  idleMs?: number
  /** Overrides the platform default; see shell.ts. */
  shell?: string
  /**
   * Whether to actually execute `command`. False on daemon restore, which
   * spawns a plain shell in the right cwd but keeps the recorded command so
   * the tile can offer it as a re-run — auto-executing whatever was there
   * last time is how four dev servers end up fighting over a port.
   */
  autorun?: boolean
}

/**
 * One PTY, its headless mirror, and its activity state (spec §4.1).
 *
 * The mirror is what makes reloading the page free: the daemon holds the
 * screen and scrollback, so a client can attach at any time and be sent a
 * full replay. Out-of-band signals are parsed out of the same stream rather
 * than a second channel.
 */
export class Session {
  readonly id: string
  readonly projectId: string
  readonly slot: number
  readonly command: string | null
  name: string | null
  color: string | null
  title: string | null = null

  readonly tracker: ActivityTracker

  /**
   * The attached page, or null (spec §4.7). Attaching and detaching never
   * touch the PTY below — that is the whole reason the choice can be offered
   * on a tile that is already working.
   */
  browser: AttachedBrowser | null = null

  onData: ((data: string) => void) | null = null
  onStatusChange: (() => void) | null = null
  onExit: ((code: number) => void) | null = null
  /** Fires on url, title, load state or control changes of an attached page. */
  onBrowserChange: (() => void) | null = null
  onBrowserFrame: ((jpeg: Buffer) => void) | null = null
  onBrowserPrompt: ((url: string) => void) | null = null

  private readonly pty: IPty
  private readonly term: TerminalT
  private readonly serializer: SerializeAddonT
  private lastSnapshot: string | null = null
  private disposed = false

  private readonly spawnCwd: string
  private liveCwd: string | null = null
  private lastCwdPoll = 0
  private enforceTimer: NodeJS.Timeout | null = null
  private hasInput = false
  /** The page this tile is meant to own; see `browserRecord`. */
  private wantsBrowser: { url: string | null } | null = null

  /** Fires when the shell moves, so the new location gets persisted. */
  onCwdChange: (() => void) | null = null

  /**
   * Where the shell *is*, not where it started. A session spawned in a project
   * root that the developer then `cd`s out of must come back to where they
   * were working, not to the root.
   */
  get cwd(): string {
    return this.liveCwd ?? this.spawnCwd
  }

  constructor(opts: SessionOptions) {
    this.id = opts.id
    this.projectId = opts.projectId
    this.slot = opts.slot
    this.spawnCwd = opts.cwd
    this.command = opts.command ?? null
    this.name = opts.name ?? null
    this.color = opts.color ?? null
    this.tracker = new ActivityTracker(Date.now(), opts.idleMs ?? DEFAULT_IDLE_MS)
    this.wantsBrowser = opts.browser ? { url: opts.browser.url ?? null } : null

    const shell = opts.shell ?? defaultShell()
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    env['TRING_SESSION_ID'] = this.id
    env['TRING_SLOT'] = String(this.slot)
    env['TRING_PROJECT'] = opts.projectName
    env['TRING_URL'] = opts.url
    // So the documented Stop hook can authenticate without anyone pasting a
    // secret into settings.json. Deleted rather than left inherited when the
    // daemon has no token, so $TRING_TOKEN is never a stale one from the
    // environment the daemon happened to start in.
    if (opts.token) env['TRING_TOKEN'] = opts.token
    else delete env['TRING_TOKEN']
    // Set for every session, browser or not: the environment is fixed at spawn
    // and a page may be attached at any time afterwards (spec §4.8).
    if (opts.mcpConfigPath) env['TRING_MCP_CONFIG'] = opts.mcpConfigPath
    else delete env['TRING_MCP_CONFIG']
    // The variable above is inert on its own — Claude Code takes MCP servers on
    // the command line and from nowhere else. This is what puts it there, by
    // owning the name `claude` for the length of the session (spec §4.8).
    if (opts.shimPath) prependToPath(env, opts.shimPath)

    const autorun = opts.autorun ?? true
    const args = this.command && autorun
      ? commandArgs(shell, this.command)
      : interactiveArgs(shell)
    this.pty = spawn(shell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 36,
      cwd: this.spawnCwd,
      env,
    })

    this.term = new Terminal({
      cols: 120,
      rows: 36,
      scrollback: opts.scrollback ?? DEFAULT_SCROLLBACK,
      allowProposedApi: true,
    })
    this.serializer = new SerializeAddon()
    this.term.loadAddon(this.serializer)

    // onBell rather than scanning for 0x07: the parser knows the difference
    // between a real bell and the BEL that terminates an OSC sequence, which
    // a raw byte scan does not — every title change would look like a bell.
    this.term.onBell(() => this.signal((t, now) => t.bell(now)))
    this.term.onTitleChange((title) => {
      this.title = title
      this.onStatusChange?.()
    })
    // OSC 7 is the standard "my working directory is now X" sequence. Shells
    // that emit it (via PROMPT_COMMAND, or by default in many setups) keep us
    // exact and cost nothing; pollCwd covers the ones that do not.
    this.term.parser.registerOscHandler(7, (data) => {
      try {
        const url = new URL(data)
        if (url.protocol === 'file:') this.setCwd(decodeURIComponent(url.pathname))
      } catch {
        // Not a URL; ignore rather than let a stray sequence break parsing.
      }
      return true
    })
    this.term.parser.registerOscHandler(133, (data) => {
      const kind = data.split(';')[0]
      if (kind === 'C') this.signal((t, now) => t.commandStart(now))
      else if (kind === 'D') this.signal((t, now) => t.commandEnd(now))
      return true
    })

    this.pty.onData((chunk) => {
      this.signal((t, now) => t.output(Buffer.byteLength(chunk), now))
      this.term.write(chunk)
      this.onData?.(chunk)
    })

    // A shell's rc file may cd elsewhere — `cd /mnt/c` in ~/.bashrc is a real
    // and common example — which would silently discard the directory the user
    // chose in the dialog. An explicit per-session choice should beat a global
    // default, so put the shell back once, after rc files have run.
    if (!(this.command && autorun) && usesPosixCd(shell)) {
      this.enforceTimer = setTimeout(() => this.enforceCwd(), CWD_ENFORCE_MS)
      this.enforceTimer.unref?.()
    }

    this.pty.onExit(({ exitCode }) => {
      this.signal((t, now) => t.exit(exitCode, now))
      this.onExit?.(exitCode)
    })
  }

  write(data: string): void {
    if (this.disposed) return
    this.hasInput = true
    this.signal((t, now) => t.input(now))
    this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || cols < 1 || rows < 1) return
    this.pty.resize(cols, rows)
    this.term.resize(cols, rows)
  }

  /** Full buffer including scrollback, for replay on focus or reconnect. */
  serialize(): string {
    return this.serializer.serialize({ scrollback: this.term.options.scrollback ?? 0 })
  }

  /** Returns null when the visible buffer has not changed since last time. */
  /**
   * The current screen, ignoring the change gate below.
   *
   * A client that has just attached has never seen this session, however long
   * it has been quiet — and a shell sitting at its prompt never changes again,
   * so waiting for the gate to open means a black tile forever.
   */
  snapshotNow(): ScreenSnapshot {
    return snapshot(this.term)
  }

  /** Only when the screen actually changed, which is what keeps 16 tiles cheap. */
  takeSnapshot(): ScreenSnapshot | null {
    const shot = snapshot(this.term)
    const key = JSON.stringify(shot.rows)
    if (key === this.lastSnapshot) return null
    this.lastSnapshot = key
    return shot
  }

  /**
   * Adopt a page (spec §4.7).
   *
   * The browser's activity feeds the same ActivityTracker the PTY does, so a
   * slot reports one status however it is working. Navigation is `busy` and
   * settling is `done`; both are inferred, so neither rings. Being parked on a
   * dialog or a selector goes through `hook()`, which is where the explicit
   * signals live — it means exactly one thing, the way a Stop hook does.
   */
  /**
   * What a restart should reattach, which is not the same question as what this
   * session has open right now.
   *
   * A page is attached asynchronously — on restore it is a Chromium launch away,
   * and on a first attach it can take seconds. Reporting only the live page made
   * the window between "this tile is a browser tile" and "the page exists" a
   * window in which any save wrote `null` over the record that was about to be
   * used. Restoring a tile therefore erased the thing being restored, and did it
   * reliably enough to look like tring simply never remembered.
   */
  get browserRecord(): { url: string | null } | null {
    if (this.browser) return { url: this.browser.info().url }
    return this.wantsBrowser
  }

  attachBrowser(browser: AttachedBrowser): void {
    this.teardownBrowser()
    this.browser = browser
    this.wantsBrowser = { url: browser.info().url }
    browser.onChange = () => this.onBrowserChange?.()
    browser.onFrame = (jpeg) => this.onBrowserFrame?.(jpeg)
    browser.onPrompt = (url) => this.onBrowserPrompt?.(url)
    browser.onActivity = (kind) => {
      if (kind === 'start') this.signal((t, now) => t.commandStart(now))
      else if (kind === 'end') this.signal((t, now) => t.settle(now))
      else this.signal((t, now) => t.hook(now))
    }
    this.onBrowserChange?.()
  }

  /**
   * The user closed the page. The intent goes with it, so the tile comes back a
   * terminal rather than reopening a page someone deliberately shut.
   */
  detachBrowser(): void {
    if (!this.browser && !this.wantsBrowser) return
    this.wantsBrowser = null
    if (!this.teardownBrowser()) this.onBrowserChange?.()
  }

  /**
   * Drop the live page without touching what this tile is meant to own. Used
   * where the page is going away for reasons that are not the user's decision —
   * being replaced, or the daemon shutting down, which must not be mistaken for
   * "this tile no longer wants a browser".
   */
  private teardownBrowser(): boolean {
    const browser = this.browser
    if (!browser) return false
    this.browser = null
    browser.onChange = null
    browser.onFrame = null
    browser.onPrompt = null
    browser.onActivity = null
    void browser.dispose()
    this.onBrowserChange?.()
    return true
  }

  ack(): void {
    this.signal((t, now) => t.ack(now))
  }

  hook(): void {
    this.signal((t, now) => t.hook(now))
  }

  tick(now: number): void {
    this.signal((t) => t.tick(now))
    if (now - this.lastCwdPoll >= CWD_POLL_MS) {
      this.lastCwdPoll = now
      this.pollCwd()
    }
  }

  /**
   * Reads the shell's real working directory from /proc, which needs no
   * cooperation from the shell at all — the common case on Linux and WSL,
   * where a stock bash emits no OSC 7. Elsewhere OSC 7 is the only source.
   */
  private pollCwd(): void {
    if (process.platform !== 'linux' || this.disposed) return
    try {
      this.setCwd(readlinkSync(`/proc/${this.pty.pid}/cwd`))
    } catch {
      // Process gone, or /proc not readable; keep the last known directory.
    }
  }

  /** Runs once, only if the shell is not where it was asked to be. */
  private enforceCwd(): void {
    // Once the user has typed, the shell belongs to them — a corrective cd
    // would fight a directory they chose themselves, moments ago.
    if (this.disposed || this.hasInput || process.platform !== 'linux') return
    let actual: string
    try {
      actual = readlinkSync(`/proc/${this.pty.pid}/cwd`)
    } catch {
      return
    }
    if (actual === this.spawnCwd) return
    this.pty.write(`cd -- ${shQuote(this.spawnCwd)}\n`)
  }

  private setCwd(next: string): void {
    if (!next || next === this.cwd) return
    this.liveCwd = next
    this.onCwdChange?.()
  }

  kill(): void {
    if (this.disposed) return
    try {
      this.pty.kill()
    } catch {
      // Already gone; onExit has fired or will.
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.enforceTimer) clearTimeout(this.enforceTimer)
    this.enforceTimer = null
    // Not detachBrowser: shutting down is not the user closing the page.
    this.teardownBrowser()
    this.kill()
    this.term.dispose()
  }

  info(): SessionInfo {
    return {
      id: this.id,
      projectId: this.projectId,
      slot: this.slot,
      name: this.name,
      title: this.title,
      cwd: this.cwd,
      command: this.command,
      color: this.color,
      status: this.tracker.status,
      since: this.tracker.since,
      exitCode: this.tracker.exitCode,
      browser: this.browser?.info() ?? null,
    }
  }

  /** Runs a tracker mutation and fires onStatusChange only on a real change. */
  private signal(fn: (t: ActivityTracker, now: number) => void): void {
    const before = this.tracker.status
    fn(this.tracker, Date.now())
    if (this.tracker.status !== before) this.onStatusChange?.()
  }
}

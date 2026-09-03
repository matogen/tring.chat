import { spawn, type IPty } from 'node-pty'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { ActivityTracker, DEFAULT_IDLE_MS } from '@tring/shared/status'
import { DEFAULT_SCROLLBACK, type ScreenSnapshot, type SessionInfo } from '@tring/shared/protocol'
import { snapshot } from './snapshot.ts'

export interface SessionOptions {
  id: string
  projectId: string
  projectName: string
  slot: number
  cwd: string
  command?: string | null
  name?: string | null
  url: string
  scrollback?: number
  idleMs?: number
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
  readonly cwd: string
  readonly command: string | null
  name: string | null
  title: string | null = null

  readonly tracker: ActivityTracker

  onData: ((data: string) => void) | null = null
  onStatusChange: (() => void) | null = null
  onExit: ((code: number) => void) | null = null

  private readonly pty: IPty
  private readonly term: Terminal
  private readonly serializer: SerializeAddon
  private lastSnapshot: string | null = null
  private disposed = false

  constructor(opts: SessionOptions) {
    this.id = opts.id
    this.projectId = opts.projectId
    this.slot = opts.slot
    this.cwd = opts.cwd
    this.command = opts.command ?? null
    this.name = opts.name ?? null
    this.tracker = new ActivityTracker(Date.now(), opts.idleMs ?? DEFAULT_IDLE_MS)

    const shell = process.env['SHELL'] ?? '/bin/bash'
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    env['TRING_SESSION_ID'] = this.id
    env['TRING_SLOT'] = String(this.slot)
    env['TRING_PROJECT'] = opts.projectName
    env['TRING_URL'] = opts.url

    this.pty = spawn(shell, this.command ? ['-c', this.command] : [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 36,
      cwd: this.cwd,
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

    this.pty.onExit(({ exitCode }) => {
      this.signal((t, now) => t.exit(exitCode, now))
      this.onExit?.(exitCode)
    })
  }

  write(data: string): void {
    if (this.disposed) return
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
  takeSnapshot(): ScreenSnapshot | null {
    const shot = snapshot(this.term)
    const key = JSON.stringify(shot.rows)
    if (key === this.lastSnapshot) return null
    this.lastSnapshot = key
    return shot
  }

  ack(): void {
    this.signal((t, now) => t.ack(now))
  }

  hook(): void {
    this.signal((t, now) => t.hook(now))
  }

  tick(now: number): void {
    this.signal((t) => t.tick(now))
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
      status: this.tracker.status,
      since: this.tracker.since,
      exitCode: this.tracker.exitCode,
    }
  }

  /** Runs a tracker mutation and fires onStatusChange only on a real change. */
  private signal(fn: (t: ActivityTracker, now: number) => void): void {
    const before = this.tracker.status
    fn(this.tracker, Date.now())
    if (this.tracker.status !== before) this.onStatusChange?.()
  }
}

/**
 * Keeps the machine from going to sleep on its own while tring serves phones.
 *
 * A phone reaches tring through the machine: a tunnel or overlay network to
 * this daemon. When the machine sleeps, nothing runs — not the daemon, not
 * the tunnel — and the phone gets nothing until someone wakes it at the
 * keyboard. Windows' idle sleep (45 minutes on mains, 10 on battery by
 * default) counts only local input, so a PC left locked while you work from
 * your phone goes to sleep under you, however busy the phone keeps it.
 *
 * So while remote access is on, tring holds the same thing a video player
 * holds: a request that blocks *idle* sleep only. Closing a laptop's lid,
 * the power button and Start → Sleep still sleep the machine.
 *
 * There is no native module for this, so each platform's own tool holds the
 * request, as a child that dies with the daemon:
 *   Windows  PowerShell calling SetThreadExecutionState(ES_CONTINUOUS |
 *            ES_SYSTEM_REQUIRED), then blocking on stdin until the daemon's
 *            end of the pipe closes; `powercfg /requests` (as admin) lists it
 *   macOS    caffeinate -i -w <daemon pid>
 *   Linux    systemd-inhibit --what=idle, holding `cat` on the same pipe
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

export interface InhibitCommand {
  cmd: string
  args: string[]
}

const WINDOWS_SCRIPT = [
  "Add-Type -Namespace TringKeepAwake -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
  // ES_CONTINUOUS | ES_SYSTEM_REQUIRED: held by this thread until it ends.
  "if ([TringKeepAwake.Power]::SetThreadExecutionState([uint32]'0x80000001') -eq 0) { exit 3 }",
  // Ends when the daemon does: its end of the pipe closes, even on a crash.
  '[void][Console]::In.ReadToEnd()',
].join('; ')

/** The child that holds the request on this platform, or null where tring knows none. */
export function inhibitCommand(platform: NodeJS.Platform, pid: number): InhibitCommand | null {
  if (platform === 'win32') {
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT] }
  }
  if (platform === 'darwin') return { cmd: 'caffeinate', args: ['-i', '-w', String(pid)] }
  if (platform === 'linux') {
    return {
      cmd: 'systemd-inhibit',
      args: ['--what=idle', '--who=tring', '--why=Phones reach this machine through tring', '--mode=block', 'cat'],
    }
  }
  return null
}

/** Waits between restarts of a helper that keeps dying: soon at first, then rarely. */
const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000]
/** A helper that lived this long was working; its next death starts the backoff over. */
const HEALTHY_MS = 60_000

export function backoffDelay(failures: number): number {
  return BACKOFF_MS[Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1]!
}

/** Whether tring should hold the machine awake: only when something off this machine reaches it. */
export function wantsKeepAwake(opts: { allowSleep: boolean; allowOrigin: readonly string[]; loopbackOnly: boolean }): boolean {
  return !opts.allowSleep && (opts.allowOrigin.length > 0 || !opts.loopbackOnly)
}

export interface KeepAwakeOptions {
  platform?: NodeJS.Platform
  pid?: number
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void }
  clearTimer?: (t: unknown) => void
  log?: (line: string) => void
}

export class KeepAwake {
  private child: ChildProcess | null = null
  private timer: unknown = null
  private failures = 0
  private stopped = true
  private readonly o: Required<KeepAwakeOptions>

  constructor(opts: KeepAwakeOptions = {}) {
    this.o = {
      platform: opts.platform ?? process.platform,
      pid: opts.pid ?? process.pid,
      spawn: opts.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, args, o)),
      now: opts.now ?? Date.now,
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)),
      log: opts.log ?? ((line) => console.log(line)),
    }
  }

  /** False where this platform has no way to hold the request. */
  start(): boolean {
    const command = inhibitCommand(this.o.platform, this.o.pid)
    if (!command) return false
    this.stopped = false
    this.run(command)
    return true
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.o.clearTimer(this.timer)
    this.timer = null
    const child = this.child
    this.child = null
    child?.kill()
  }

  get holding(): boolean {
    return this.child !== null
  }

  private run(command: InhibitCommand): void {
    const started = this.o.now()
    let child: ChildProcess
    try {
      child = this.o.spawn(command.cmd, command.args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    } catch (err) {
      return this.giveUp(command, err as Error)
    }
    this.child = child
    let over = false
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (over) return
      over = true
      if (this.child === child) this.child = null
      // Not installed (no systemd-inhibit, say): trying again will not help.
      if (err.code === 'ENOENT') return this.giveUp(command, err)
      this.retry(command, started)
    })
    child.on('exit', () => {
      if (over) return
      over = true
      if (this.child === child) this.child = null
      this.retry(command, started)
    })
  }

  private retry(command: InhibitCommand, started: number): void {
    if (this.stopped) return
    this.failures = this.o.now() - started >= HEALTHY_MS ? 1 : this.failures + 1
    const delay = backoffDelay(this.failures)
    this.o.log(`keep-awake: ${command.cmd} stopped; holding the machine awake again in ${Math.round(delay / 1000)}s`)
    const t = this.o.setTimer(() => {
      this.timer = null
      if (!this.stopped) this.run(command)
    }, delay)
    t.unref?.()
    this.timer = t
  }

  private giveUp(command: InhibitCommand, err: Error): void {
    this.stopped = true
    this.o.log(`keep-awake: cannot run ${command.cmd} (${err.message}); this machine may sleep and drop phones`)
  }
}

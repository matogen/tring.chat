import { randomUUID } from 'node:crypto'
import { Session } from './session.ts'

export interface SessionSpec {
  slot?: number
  cwd?: string
  command?: string | null
  name?: string | null
  /** False when restoring from disk; see Session's `autorun`. */
  autorun?: boolean
}

export interface SessionManagerOptions {
  projectId: string
  projectName: string
  root: string
  url: string
  scrollback: number
  idleMs: number
  shell?: string
}

export const SLOT_COUNT = 16

/** The 16 fixed slots of one project (spec §4.3). */
export class SessionManager {
  private readonly bySlot = new Map<number, Session>()
  private readonly byId = new Map<string, Session>()

  onSessionData: ((s: Session, data: string) => void) | null = null
  onSessionStatus: ((s: Session) => void) | null = null
  onSessionExit: ((s: Session, code: number) => void) | null = null
  onStructureChange: (() => void) | null = null

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
      url: this.opts.url,
      scrollback: this.opts.scrollback,
      idleMs: this.opts.idleMs,
      ...(this.opts.shell ? { shell: this.opts.shell } : {}),
      autorun: spec.autorun,
    })

    session.onData = (data) => this.onSessionData?.(session, data)
    session.onStatusChange = () => this.onSessionStatus?.(session)
    session.onExit = (code) => this.onSessionExit?.(session, code)

    this.bySlot.set(slot, session)
    this.byId.set(session.id, session)
    this.onStructureChange?.()
    return session
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
    const spec: SessionSpec = {
      slot: old.slot,
      cwd: old.cwd,
      command: old.command,
      name: old.name,
      autorun: true,
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

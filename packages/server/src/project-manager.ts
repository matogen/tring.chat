import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ProjectInfo } from '@tring/shared/protocol'
import type { ClaudeConversation, Session } from './session.ts'
import { SessionManager, type SessionSpec } from './session-manager.ts'

export interface PersistedSession {
  slot: number
  name: string | null
  cwd: string
  command: string | null
  color?: string | null
  /** The Claude conversation the tile was running; reopened on restore. */
  claude?: ClaudeConversation | null
}

export interface PersistedProject {
  id: string
  name: string
  root: string
  sessions: PersistedSession[]
}

export interface PersistedState {
  version: 1
  activeProjectId: string | null
  projects: PersistedProject[]
}

export interface ProjectManagerOptions {
  url: string
  /** Handed to each session as $TRING_TOKEN so its hooks can authenticate. */
  token?: string | null
  scrollback: number
  idleMs: number
  statePath?: string
  tickMs?: number
  shell?: string
}

interface ProjectEntry {
  id: string
  name: string
  root: string
  /** Null until the project is activated — this is the lazy respawn. */
  manager: SessionManager | null
  /** Restored-but-not-yet-spawned sessions, held until first activation. */
  pending: PersistedSession[]
}

export function defaultStatePath(): string {
  const base = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config')
  return path.join(base, 'tring', 'projects.json')
}

/**
 * Projects, their persistence, and the restore policy (spec §4.3).
 *
 * Sessions in every activated project stay live and status-tracked, but a
 * project restored from disk does not spawn until it is first activated. Four
 * restored projects therefore cost 16 spawns at launch, not 64.
 */
export class ProjectManager {
  private readonly entries = new Map<string, ProjectEntry>()
  private activeId: string | null = null
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()
  /**
   * Set once shutdown starts. Stopping the daemon (or the machine) signals
   * every shell and Claude in it as well, and what they do on the way out —
   * exiting, ending their conversation — must not be saved as the state to
   * come back to.
   */
  private closing = false

  onChange: (() => void) | null = null
  onSessionData: ((s: Session, data: string) => void) | null = null
  onSessionStatus: ((s: Session) => void) | null = null
  onSessionExit: ((s: Session, code: number) => void) | null = null

  private constructor(private readonly opts: ProjectManagerOptions) {}

  static async open(opts: ProjectManagerOptions): Promise<ProjectManager> {
    const pm = new ProjectManager(opts)
    await pm.load()
    pm.timer = setInterval(() => pm.tick(), opts.tickMs ?? 500)
    pm.timer.unref?.()
    return pm
  }

  get statePath(): string {
    return this.opts.statePath ?? defaultStatePath()
  }

  get activeProjectId(): string | null {
    return this.activeId
  }

  list(): ProjectInfo[] {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      name: e.name,
      root: e.root,
      // A project that has never been activated has nothing running, so it
      // truthfully reports no sessions and a zero done-count.
      sessions: e.manager?.list().map((s) => s.info()) ?? [],
    }))
  }

  createProject(name: string, root: string): string {
    const id = randomUUID()
    this.entries.set(id, { id, name, root, manager: null, pending: [] })
    this.activate(id)
    return id
  }

  renameProject(id: string, name: string): void {
    const e = this.entries.get(id)
    if (!e) return
    e.name = name
    this.changed()
  }

  deleteProject(id: string): void {
    const e = this.entries.get(id)
    if (!e) return
    e.manager?.disposeAll()
    this.entries.delete(id)
    if (this.activeId === id) {
      // Falling back to the first remaining project, or to no project at all —
      // which is the same empty state as first run, deliberately.
      const next = this.entries.keys().next()
      this.activeId = next.done ? null : next.value
      if (this.activeId) this.activate(this.activeId)
    }
    this.changed()
  }

  activate(id: string): SessionManager | null {
    if (!this.entries.has(id)) return null
    this.activeId = id
    return this.ensure(id)
  }

  /**
   * The project's sessions, spawning a restored project's if they are still
   * pending, without making it the active project. The orchestrator agent
   * starts tiles in projects you are not looking at, and doing so must not
   * pull the view out from under you.
   */
  ensure(id: string): SessionManager | null {
    const e = this.entries.get(id)
    if (!e) return null
    if (!e.manager) {
      e.manager = this.spawnManager(e)
      for (const rec of e.pending) {
        // autorun false: restore the place, not the command. A Claude
        // conversation is the exception: it waits for a prompt, so reopening
        // it starts nothing the user did not already have running.
        e.manager.create({ ...rec, autorun: false, resume: rec.claude ?? null })
      }
      e.pending = []
    }
    this.changed()
    return e.manager
  }

  /**
   * The project's tiles, if one of them runs — or, restored and not yet
   * spawned, will reopen — Claude conversation `claudeId`; none otherwise.
   * Spawns the project only in the first case: an inbox card restored for
   * that conversation needs a live tile to reply into (card-store.ts).
   */
  tilesWith(projectId: string, claudeId: string): Session[] {
    const e = this.entries.get(projectId)
    if (!e) return []
    const convs = e.manager ? e.manager.list().map((s) => s.claude) : e.pending.map((p) => p.claude)
    if (!convs.some((c) => c?.id === claudeId)) return []
    return this.ensure(projectId)?.list() ?? []
  }

  managerFor(id: string): SessionManager | null {
    return this.entries.get(id)?.manager ?? null
  }

  activeManager(): SessionManager | null {
    return this.activeId ? this.managerFor(this.activeId) : null
  }

  create(projectId: string | undefined, spec: SessionSpec): Session | null {
    const id = projectId ?? this.activeId
    if (!id) return null
    const mgr = this.ensure(id)
    return mgr ? mgr.create(spec) : null
  }

  /** A project by id, or by name ignoring case — names are what people say. */
  findProject(ref: string): ProjectInfo | undefined {
    const all = this.list()
    const want = ref.trim().toLowerCase()
    return all.find((p) => p.id === ref) ?? all.find((p) => p.name.toLowerCase() === want)
  }

  /** Session lookup by globally unique id, across every live project. */
  findSession(sessionId: string): Session | undefined {
    for (const e of this.entries.values()) {
      const s = e.manager?.get(sessionId)
      if (s) return s
    }
    return undefined
  }

  findManager(sessionId: string): SessionManager | undefined {
    for (const e of this.entries.values()) {
      if (e.manager?.get(sessionId)) return e.manager
    }
    return undefined
  }

  async dispose(): Promise<void> {
    this.closing = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const e of this.entries.values()) e.manager?.disposeAll()
    await this.writing
  }

  private spawnManager(e: ProjectEntry): SessionManager {
    const mgr = new SessionManager({
      projectId: e.id,
      projectName: e.name,
      root: e.root,
      url: this.opts.url,
      token: this.opts.token ?? null,
      scrollback: this.opts.scrollback,
      idleMs: this.opts.idleMs,
      ...(this.opts.shell ? { shell: this.opts.shell } : {}),
    })
    mgr.onSessionData = (s, d) => this.onSessionData?.(s, d)
    mgr.onSessionStatus = (s) => this.onSessionStatus?.(s)
    mgr.onSessionExit = (s, c) => {
      this.onSessionExit?.(s, c)
      this.changed()
    }
    mgr.onStructureChange = () => this.changed()
    return mgr
  }

  private tick(): void {
    const now = Date.now()
    // Every live project, not just the active one: status is the cheap part,
    // and a background agent finishing is exactly what the tab badge reports.
    for (const e of this.entries.values()) e.manager?.tick(now)
  }

  private changed(): void {
    if (this.closing) return
    this.onChange?.()
    void this.save()
  }

  private snapshotState(): PersistedState {
    return {
      version: 1,
      activeProjectId: this.activeId,
      projects: [...this.entries.values()].map((e) => ({
        id: e.id,
        name: e.name,
        root: e.root,
        sessions: e.manager
          ? e.manager.list().map((s) => ({
              slot: s.slot,
              name: s.name,
              cwd: s.cwd,
              command: s.command,
              color: s.color,
              ...(s.claude ? { claude: s.claude } : {}),
            }))
          : e.pending,
      })),
    }
  }

  save(): Promise<void> {
    const state = this.snapshotState()
    // Chained rather than concurrent, so two rapid changes cannot interleave
    // and leave a half-written file.
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.statePath), { recursive: true })
      await writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf8')
    }).catch(() => {})
    return this.writing
  }

  private async load(): Promise<void> {
    let parsed: PersistedState
    try {
      parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedState
    } catch {
      return // No config yet: first run, and the client shows the project dialog.
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.projects)) return

    for (const p of parsed.projects) {
      this.entries.set(p.id, {
        id: p.id,
        name: p.name,
        root: p.root,
        manager: null,
        pending: Array.isArray(p.sessions) ? p.sessions : [],
      })
    }
    // Only the active project spawns eagerly; the rest wait for activation.
    const active = parsed.activeProjectId
    if (active && this.entries.has(active)) this.activate(active)
  }
}

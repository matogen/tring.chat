import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { InboxItem, ProjectInfo, SessionStatus } from '@tring/shared/protocol'
import type { StackPr, Ticket, TicketRepo, WorkflowSettings } from '@tring/shared/workflow'
import { writeAtomic } from '../card-store.ts'
import type { GateDecision } from '../hook-route.ts'
import { secretEquals } from '../security.ts'
import { ToolError, type ToolDef, type WorkflowTools } from '../orchestrator-tools.ts'
import { cleanPrompt, typePrompt } from '../type-prompt.ts'
import { coderBrief, jobText, noteText, plannerBrief, reviewerBrief } from './briefs.ts'
import { cardsFor, checklist, prOf, step, type Command, type EngineEnv, type EngineEvent, type ReviewFinding } from './engine.ts'
import { HeadWatcher, type StackGit } from './git.ts'
import { matches } from './plan.ts'
import { toolsFor, type Role } from './stack-tools.ts'
import { localKeyOf, renderTicket, type TicketStore } from './tickets.ts'

/**
 * Runs the multi-PR workflow: carries out what the stack engine says against
 * real tiles and git, and feeds it what happens — agents' tool calls, hooks,
 * branch heads, the clock.
 *
 * Every event for a ticket goes through one promise chain, so a report and a
 * card click never interleave. Tiles are known by project and slot, which a
 * restart keeps (session ids it does not), with their tokens in tiles.json.
 */

/** The slice of a Session the runner uses. */
export interface RunnerSession {
  id: string
  projectId: string
  slot: number
  claude: { id: string; cwd: string } | null
  tracker: { status: SessionStatus }
  write(data: string): void
  prompted(): void
}

export interface RunnerDeps {
  store: TicketStore
  settings: { get(): WorkflowSettings }
  git: StackGit
  pm: {
    list(): ProjectInfo[]
    createProject(name: string, root: string, activate: boolean): string
    create(projectId: string, spec: { cwd: string; command: string; name: string; claudeArgs: string }): RunnerSession | null
    findSession(id: string): RunnerSession | undefined
    kill(sessionId: string): void
  }
  inbox: { list(): InboxItem[] }
  /** Claude usage is past the quota guard. */
  quotaHigh: () => boolean
  /** Where each tile's settings, MCP config and token go. */
  tileDir: string
  url: string
  /** The MCP relay (mcp-cli.ts / tring-mcp.js) and the Node that runs it. */
  mcpScript: string | null
  node: string
  /** The hook command Claude Code runs; tring-hook, from the daemon's PATH. */
  hookCommand?: string
  now?: () => number
  /** Typing into a tile; replaced in tests. */
  type?: (s: RunnerSession, text: string) => void
  /** The tickets changed: cards and the stack view are redrawn. */
  onChange?: () => void
}

interface TileRecord {
  token: string
  ticketId: string
  role: Role
  /** The PR, for a coder or reviewer. */
  pr: number | null
  projectId: string
  slot: number
  /** A reviewer's range, for its submit_review. */
  range?: { base: string; head: string }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const PUSH = /\bgit\b[^;&|\n]*\bpush\b|\bgh\s+pr\s+create\b/
const MERGE = /\bgh\s+pr\s+merge\b|\bgit\b[^;&|\n]*\bmerge\b[^;&|\n]*\borigin\b/
const READY_SETTLE_MS = 1500
/** Activity is recorded at most this often per PR: hooks fire on every tool call. */
const ACTIVITY_EVERY_MS = 60_000
const BASE_FETCH_MS = 10 * 60_000

export class WorkflowRunner implements WorkflowTools {
  private tiles: TileRecord[] = []
  private readonly chains = new Map<string, Promise<unknown>>()
  /** Messages for a tile, by `ticket:role:pr`, typed in when its agent is idle. */
  private readonly queues = new Map<string, string[]>()
  private readonly idleSince = new Map<string, number>()
  private readonly lastActivity = new Map<string, number>()
  private readonly prefixes = new Map<string, string>()
  private readonly watcher: HeadWatcher
  private timer: NodeJS.Timeout | null = null
  private lastTick = 0
  private lastFetch = 0

  constructor(private readonly d: RunnerDeps) {
    this.watcher = new HeadWatcher(d.git, (key, sha) => {
      const [ticketId, pr] = key.split(':')
      void this.run(ticketId!, { type: 'headMoved', pr: Number(pr), sha })
    })
  }

  private get now(): number { return (this.d.now ?? Date.now)() }
  private get tilesFile(): string { return path.join(this.d.tileDir, 'tiles.json') }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.tilesFile, 'utf8')) as { tiles?: TileRecord[] }
      this.tiles = (raw.tiles ?? []).filter((t) => typeof t?.token === 'string' && typeof t.ticketId === 'string')
    } catch {
      this.tiles = []
    }
    this.rewatch()
  }

  start(): void {
    this.stop()
    this.timer = setInterval(() => { void this.pump() }, 2000)
    this.timer.unref?.()
    this.watcher.start(5000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.watcher.stop()
  }

  enabled(): boolean {
    return this.d.settings.get().multiPr
  }

  /* ---------- events, one ticket at a time ---------- */

  /** An event for a ticket, after the ones before it. Resolves to the engine's notice, or null. */
  run(ticketId: string, e: EngineEvent): Promise<string | null> {
    const next = (this.chains.get(ticketId) ?? Promise.resolve()).then(() => this.apply(ticketId, e))
    this.chains.set(ticketId, next.catch(() => {}))
    return next
  }

  private env(): EngineEnv {
    const s = this.d.settings.get()
    return {
      now: this.now,
      settings: { requireFreshReview: s.requireFreshReview, autoRestack: s.autoRestack },
      quotaHigh: this.d.quotaHigh(),
      repoIdForPath: (p) => path.basename(p),
      branchFor: (t, p) => {
        const slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pr'
        return `${this.prefixes.get(p.repo) ?? 'feature/'}${t.localKey}-${p.index}-${slug}`
      },
    }
  }

  /** Not chained: for the runner's own follow-ups inside a step it is already running. */
  private async apply(ticketId: string, e: EngineEvent): Promise<string | null> {
    const t = this.d.store.get(ticketId)
    if (!t) return `no ticket ${ticketId}`
    const r = step(t, e, this.env())
    if (r.notice) return r.notice
    await this.d.store.update(ticketId, (x) => Object.assign(x, r.ticket))
    await this.exec(ticketId, r.commands)
    this.rewatch()
    this.d.onChange?.()
    return null
  }

  private async exec(ticketId: string, commands: Command[]): Promise<void> {
    for (const c of commands) {
      const t = this.d.store.get(ticketId)
      if (!t) return
      try {
        await this.one(t, c)
      } catch (err) {
        const pr = 'pr' in c ? c.pr : null
        if (pr !== null) await this.apply(ticketId, { type: 'blocked', pr, reason: `tring could not ${c.do}: ${(err as Error).message}` })
      }
    }
  }

  private async one(t: Ticket, c: Command): Promise<void> {
    switch (c.do) {
      case 'startPlanner': {
        const root = t.repos[0]!.root
        await this.spawn(t, 'planner', null, root, null)
        this.queue(t.id, 'planner', null, plannerBrief(t))
        return
      }
      case 'closePlanner': return this.close(t.id, 'planner', null)
      case 'notePlanner': return this.queue(t.id, 'planner', null, noteText(t, c.note))
      case 'createWorktree': {
        const repo = t.repos.find((r) => r.id === c.repo)!
        const made = await this.d.git.createWorktree(repo.root, { branch: c.branch, from: c.from })
        await this.apply(t.id, { type: 'worktree', pr: c.pr, path: made.path, baseSha: made.baseSha })
        return
      }
      case 'work': {
        const pr = prOf(this.d.store.get(t.id)!, c.pr)!
        const open = this.recordFor(t.id, 'coder', c.pr)
        if (!open) {
          const fresh = this.d.store.get(t.id)!
          await this.spawn(fresh, 'coder', c.pr, pr.worktree!, pr.coderConversation)
          if (!pr.coderConversation) this.queue(t.id, 'coder', c.pr, coderBrief(fresh, prOf(fresh, c.pr)!))
        }
        this.queue(t.id, 'coder', c.pr, jobText(t, pr, c.job))
        return
      }
      case 'note':
        // A closed tile gets it when it next opens, ahead of the work it opens for.
        this.queue(t.id, 'coder', c.pr, noteText(t, c.note))
        return
      case 'review': {
        const pr = prOf(t, c.pr)!
        await this.spawn(t, 'reviewer', c.pr, pr.worktree!, null, c.range)
        this.queue(t.id, 'reviewer', c.pr, reviewerBrief(t, pr, c.round, c.range, c.recheck))
        return
      }
      case 'closeCoder': {
        await this.close(t.id, 'coder', c.pr)
        await this.apply(t.id, { type: 'tileClosed', role: 'coder', pr: c.pr })
        return
      }
      case 'freshCoder': {
        await this.close(t.id, 'coder', c.pr)
        await this.d.store.update(t.id, (x) => { const p = prOf(x, c.pr); if (p) p.coderConversation = null })
        const fresh = this.d.store.get(t.id)!
        const pr = prOf(fresh, c.pr)!
        await this.spawn(fresh, 'coder', c.pr, pr.worktree!, null)
        this.queue(t.id, 'coder', c.pr, `${coderBrief(fresh, pr)}\n\nYou are taking over from an agent that got stuck. ` +
          `Status: ${pr.status}. Read \`git log\` and \`git status\` in your worktree, then carry on.`)
        return
      }
      case 'closeAll':
        for (const r of this.tiles.filter((x) => x.ticketId === t.id)) await this.close(t.id, r.role, r.pr)
        return
    }
  }

  /* ---------- tiles ---------- */

  private key(ticketId: string, role: Role, pr: number | null): string {
    return `${ticketId}:${role}:${pr ?? 0}`
  }

  private recordFor(ticketId: string, role: Role, pr: number | null): TileRecord | undefined {
    return this.tiles.find((r) => r.ticketId === ticketId && r.role === role && r.pr === pr)
  }

  private sessionOf(r: TileRecord): RunnerSession | undefined {
    const info = this.d.pm.list().find((p) => p.id === r.projectId)?.sessions.find((s) => s.slot === r.slot)
    return info ? this.d.pm.findSession(info.id) : undefined
  }

  /** The tile a session is, if it is one of the workflow's. */
  private recordOfSession(sessionId: string): TileRecord | undefined {
    const s = this.d.pm.findSession(sessionId)
    return s ? this.tiles.find((r) => r.projectId === s.projectId && r.slot === s.slot) : undefined
  }

  private async spawn(t: Ticket, role: Role, pr: number | null, cwd: string, resume: string | null, range?: { base: string; head: string }): Promise<void> {
    if (!t.projectId) throw new Error('the ticket has no tab')
    if (!this.d.mcpScript) throw new Error('the tring MCP relay is missing from this install')
    const token = randomBytes(24).toString('hex')
    const dir = path.join(this.d.tileDir, t.id, `${role}-${pr ?? 0}`)
    await mkdir(dir, { recursive: true })
    const tokenFile = path.join(dir, '.token')
    await writeAtomic(tokenFile, `${token}\n`)
    const script = this.d.mcpScript
    const nodeArgs = script.endsWith('.ts') ? ['--experimental-strip-types', '--no-warnings'] : []
    await writeAtomic(path.join(dir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        'tring-stack': {
          type: 'stdio', command: this.d.node,
          args: [...nodeArgs, script, '--url', this.d.url, '--api', 'stack', '--token-file', tokenFile],
        },
      },
    }, null, 2) + '\n')
    await writeAtomic(path.join(dir, 'settings.json'), JSON.stringify(tileSettings(t, role, pr, this.d.hookCommand ?? 'tring-hook'), null, 2) + '\n')
    const claudeArgs = `--permission-mode auto --settings ${quoted(path.join(dir, 'settings.json'))} --mcp-config ${quoted(path.join(dir, 'mcp.json'))}`
    const name = role === 'planner' ? `${t.localKey} planner` : role === 'coder' ? localKeyOf(t, pr!) : `${localKeyOf(t, pr!)} review`
    const s = this.d.pm.create(t.projectId, {
      cwd, name, claudeArgs, command: `claude ${claudeArgs}${resume ? ` --resume ${resume}` : ''}`,
    })
    if (!s) throw new Error('no free slot in the ticket tab')
    // One tile per role and PR: a respawn replaces the record.
    this.tiles = this.tiles.filter((r) => !(r.ticketId === t.id && r.role === role && r.pr === pr))
    this.tiles.push({ token, ticketId: t.id, role, pr, projectId: s.projectId, slot: s.slot, ...(range ? { range } : {}) })
    await this.saveTiles()
    if (role === 'coder' && pr !== null) {
      await this.d.store.update(t.id, (x) => { const p = prOf(x, pr); if (p) p.coder = { projectId: s.projectId, slot: s.slot, claudeId: null } })
    }
  }

  private async close(ticketId: string, role: Role, pr: number | null): Promise<void> {
    const r = this.recordFor(ticketId, role, pr)
    if (!r) return
    const s = this.sessionOf(r)
    if (role === 'coder' && pr !== null && s?.claude) {
      const id = s.claude.id
      await this.d.store.update(ticketId, (x) => { const p = prOf(x, pr); if (p) p.coderConversation = id })
    }
    if (s) this.d.pm.kill(s.id)
    this.tiles = this.tiles.filter((x) => x !== r)
    this.queues.delete(this.key(ticketId, role, pr))
    await this.saveTiles()
  }

  private saveTiles(): Promise<void> {
    return writeAtomic(this.tilesFile, JSON.stringify({ tiles: this.tiles }, null, 2) + '\n')
  }

  private queue(ticketId: string, role: Role, pr: number | null, text: string): void {
    const k = this.key(ticketId, role, pr)
    this.queues.set(k, [...(this.queues.get(k) ?? []), text])
  }

  /** Types queued messages into tiles whose agents are idle and not holding a prompt. */
  async deliver(): Promise<void> {
    const waiting = new Set(this.d.inbox.list().filter((i) => i.kind !== 'reply').map((i) => i.sessionId))
    for (const r of this.tiles) {
      const k = this.key(r.ticketId, r.role, r.pr)
      const q = this.queues.get(k)
      const s = this.sessionOf(r)
      if (!s) continue
      if (r.role === 'coder' && r.pr !== null && s.claude) {
        const t = this.d.store.get(r.ticketId)
        const p = t && prOf(t, r.pr)
        if (p && p.coder && p.coder.claudeId !== s.claude.id) {
          const id = s.claude.id
          await this.d.store.update(r.ticketId, (x) => { const y = prOf(x, r.pr!); if (y?.coder) { y.coder.claudeId = id; y.coderConversation = id } })
        }
      }
      if (!q?.length) continue
      const idle = !!s.claude && s.tracker.status !== 'busy' && !waiting.has(s.id)
      if (!idle) { this.idleSince.delete(s.id); continue }
      const since = this.idleSince.get(s.id) ?? this.now
      this.idleSince.set(s.id, since)
      if (this.now - since < READY_SETTLE_MS) continue
      const text = cleanPrompt(q.join('\n\n---\n\n'))
      this.queues.delete(k)
      this.idleSince.delete(s.id)
      s.prompted()
      ;(this.d.type ?? typePrompt)(s, text)
    }
  }

  private rewatch(): void {
    const list = this.d.store.list().flatMap((t) => t.prs
      .filter((p) => p.worktree && p.status !== 'merged')
      .map((p) => ({ key: `${t.id}:${p.index}`, repo: this.repoOf(t, p)!.root, branch: p.branch })))
    this.watcher.watch(list)
  }

  private repoOf(t: Ticket, p: StackPr): TicketRepo | undefined {
    const repo = t.plan?.prs.find((x) => x.index === p.index)?.repo
    return t.repos.find((r) => r.id === repo)
  }

  /** The runner's clock: deliveries every pump, the engine's tick every 30 s, base fetches every 10 min. */
  async pump(): Promise<void> {
    await this.deliver()
    const active = this.d.store.list().filter((t) => t.phase === 'building' || t.phase === 'integrating')
    if (this.now - this.lastTick >= 30_000) {
      this.lastTick = this.now
      for (const t of active) await this.run(t.id, { type: 'tick' })
    }
    if (this.now - this.lastFetch >= BASE_FETCH_MS) {
      this.lastFetch = this.now
      for (const t of active) await this.fetchBases(t)
    }
  }

  private async fetchBases(t: Ticket): Promise<void> {
    for (const repo of t.repos) {
      const roots = t.prs.filter((p) => t.plan?.prs.find((x) => x.index === p.index && x.repo === repo.id && x.below === null) && p.baseSha)
      if (!roots.length) continue
      const r = await this.d.git.fetchBase(repo.root, repo.baseBranch, roots[0]!.baseSha!)
      if (r.error || r.commits === 0) continue
      const tops = t.prs.filter((p) => t.plan?.prs.find((x) => x.index === p.index && x.repo === repo.id) &&
        !t.plan.prs.some((x) => x.below === p.index))
      let conflict = false
      for (const top of tops) if (await this.d.git.conflicts(repo.root, top.branch, `origin/${repo.baseBranch}`)) conflict = true
      await this.run(t.id, { type: 'baseMoved', repo: repo.id, commits: r.commits, conflict })
    }
  }

  /* ---------- hooks ---------- */

  /** Any hook from a workflow tile: its agent is alive. */
  onHook(sessionId: string): void {
    const r = this.recordOfSession(sessionId)
    if (!r || r.pr === null) return
    const k = this.key(r.ticketId, r.role, r.pr)
    if (this.now - (this.lastActivity.get(k) ?? 0) < ACTIVITY_EVERY_MS) return
    this.lastActivity.set(k, this.now)
    void this.run(r.ticketId, { type: 'activity', pr: r.pr })
  }

  /** The workflow's say on a tool call in one of its tiles (hook-route.ts). */
  gate(sessionId: string, tool: string, input: Record<string, unknown>): GateDecision | null {
    const r = this.recordOfSession(sessionId)
    if (!r) return null
    const t = this.d.store.get(r.ticketId)
    if (!t) return null
    if (EDIT_TOOLS.has(tool)) {
      if (r.role !== 'coder' || r.pr === null) return { decision: 'deny', reason: `This ${r.role} tile is read-only: it does not edit files.` }
      return this.editGate(t, r.pr, String(input['file_path'] ?? input['notebook_path'] ?? input['path'] ?? ''))
    }
    if (SHELL_TOOLS.has(tool)) {
      const cmd = String(input['command'] ?? '')
      if (MERGE.test(cmd) && /\bgh\s+pr\s+merge\b/.test(cmd)) return { decision: 'deny', reason: 'tring never merges: the user merges on the forge.' }
      if (!PUSH.test(cmd)) return null
      const pr = r.pr !== null ? prOf(t, r.pr) : undefined
      if (r.role !== 'coder' || !pr) return { decision: 'deny', reason: `A ${r.role} never pushes.` }
      if (!pr.pushAllowed) {
        return {
          decision: 'deny',
          reason: 'Pushing is held: tring lets a push through only once your PR is review-clean, its whole lane passes, and the user clicks Push. Carry on with your work.',
        }
      }
      return null
    }
    return null
  }

  private editGate(t: Ticket, index: number, file: string): GateDecision {
    const pr = prOf(t, index)
    const planned = t.plan?.prs.find((x) => x.index === index)
    if (!pr?.worktree || !planned) return { decision: 'deny', reason: 'Your PR has no worktree yet.' }
    if (pr.reviewing) return { decision: 'deny', reason: 'Your PR is being reviewed: wait for the review before changing anything.' }
    const abs = path.resolve(pr.worktree, file)
    const rel = path.relative(pr.worktree, abs).replace(/\\/g, '/')
    if (!file || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { decision: 'deny', reason: `${file} is outside your worktree (${pr.worktree}). Work only there.` }
    }
    if (planned.owns.some((g) => matches(g, rel))) return { decision: 'allow', reason: `${rel} is owned by ${localKeyOf(t, index)}.` }
    const owner = t.plan!.prs.find((x) => x.repo === planned.repo && x.index !== index && x.owns.some((g) => matches(g, rel)))
    return {
      decision: 'deny',
      reason: owner
        ? `${rel} belongs to ${localKeyOf(t, owner.index)}. Call request_change to ask it for the change instead.`
        : `${rel} is not owned by any PR in the plan. If your PR needs it, call blocked and say so; the user decides.`,
    }
  }

  /* ---------- the tiles' tools (tring-stack) ---------- */

  authorize(token: string | null): TileRecord | null {
    if (!token) return null
    return this.tiles.find((r) => secretEquals(r.token, token)) ?? null
  }

  tools(who: unknown): ToolDef[] {
    return toolsFor((who as TileRecord).role)
  }

  async call(who: unknown, name: string, args: Record<string, unknown>): Promise<string> {
    const r = who as TileRecord
    const t = this.d.store.get(r.ticketId)
    if (!t) throw new ToolError('this ticket is gone')
    if (!toolsFor(r.role).some((x) => x.name === name)) throw new ToolError(`a ${r.role} has no ${name}`)
    const say = (notice: string | null, ok: string): string => {
      if (notice) throw new ToolError(notice)
      return ok
    }
    const str = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')
    switch (name) {
      case 'stack_brief': {
        const pr = r.pr !== null ? prOf(t, r.pr) : undefined
        const brief = r.role === 'planner' ? plannerBrief(t) : pr && r.role === 'coder' ? coderBrief(t, pr)
          : pr ? reviewerBrief(t, pr, (pr.review?.round ?? 0) + 1, r.range ?? { base: pr.baseSha ?? '', head: pr.headSha ?? '' }, []) : ''
        const docs = renderTicket(t)
        const local = r.pr !== null ? [...docs.entries()].find(([n]) => n.endsWith(`-${r.pr}.md`))?.[1] : [...docs.values()][0]
        return `${brief}\n\n---\n\n${local ?? ''}`
      }
      case 'stack_status': return this.stackStatus(t)
      case 'submit_plan': {
        const plan = args['plan']
        const added: TicketRepo[] = []
        const raw = plan && typeof plan === 'object' ? (plan as { addRepos?: unknown }).addRepos : null
        for (const a of Array.isArray(raw) ? raw : []) {
          const p = typeof a?.path === 'string' ? a.path.trim() : ''
          if (!p) continue
          if (!await this.d.git.isRepo(p)) throw new ToolError(`${p} is not a git repository; fix addRepos and submit again`)
          const id = path.basename(p)
          this.prefixes.set(id, await this.d.git.branchPrefix(p))
          added.push({ id, root: p, baseBranch: typeof a.base === 'string' && a.base.trim() ? a.base.trim() : await this.d.git.baseBranch(p) })
        }
        const notice = await this.run(t.id, { type: 'planSubmitted', plan, addedRepos: added })
        const now = this.d.store.get(t.id)!
        if (notice) throw new ToolError(notice)
        if (now.phase !== 'awaiting-approval') throw new ToolError(`The plan was not accepted:\n${now.planErrors.map((e) => `- ${e}`).join('\n')}`)
        return 'Submitted. The user approves it on a card; you will hear back if they want changes.'
      }
      case 'report': return this.report(t, r, args)
      case 'resolve_finding':
        return say(await this.run(t.id, {
          type: 'resolveFinding', pr: r.pr!, finding: str('id'),
          outcome: str('outcome') === 'declined' ? 'declined' : 'fixed', note: str('note'),
        }), 'Recorded.')
      case 'request_change':
        return say(await this.run(t.id, { type: 'requestChange', from: r.pr!, to: Number(args['to_pr']), what: str('what') }), 'Sent to that PR.')
      case 'amend_interface':
        return say(await this.run(t.id, { type: 'amendInterface', pr: r.pr!, name: str('name'), contract: str('contract'), why: str('why') }),
          'Asked the user. Keep to the current contract until you hear back.')
      case 'blocked':
        return say(await this.run(t.id, { type: 'blocked', pr: r.pr!, reason: str('reason') || 'no reason given' }), 'The user has been told.')
      case 'submit_review': {
        const findings: ReviewFinding[] = (Array.isArray(args['findings']) ? args['findings'] : []).map((f: Record<string, unknown>) => ({
          severity: (['high', 'medium', 'low', 'nit'].includes(String(f['severity'])) ? f['severity'] : 'medium') as ReviewFinding['severity'],
          file: typeof f['file'] === 'string' ? f['file'] : null,
          line: typeof f['line'] === 'number' ? f['line'] : null,
          summary: String(f['summary'] ?? ''),
        }))
        const pr = prOf(t, r.pr!)!
        const notice = await this.run(t.id, {
          type: 'review', pr: r.pr!, findings, testsPassed: args['tests_passed'] === true, evidence: str('evidence'),
          range: r.range ?? { base: pr.baseSha ?? '', head: pr.headSha ?? '' },
        })
        if (notice) throw new ToolError(notice)
        // After the answer reaches the reviewer: its tile closes.
        setTimeout(() => { void this.close(t.id, 'reviewer', r.pr) }, 3000).unref?.()
        return 'Review recorded. Thank you; this tile closes now.'
      }
    }
    throw new ToolError(`unknown tool ${name}`)
  }

  private async report(t: Ticket, r: TileRecord, args: Record<string, unknown>): Promise<string> {
    const kind = String(args['kind'] ?? '')
    const pr = prOf(t, r.pr!)
    if (!pr) throw new ToolError('your PR is not in the stack')
    const evidence = typeof args['evidence'] === 'string' ? args['evidence'] : ''
    const sha = typeof args['sha'] === 'string' ? args['sha'].trim() : ''
    let e: EngineEvent
    switch (kind) {
      case 'interface_ready': e = { type: 'report', pr: pr.index, kind }; break
      case 'tests_failing': case 'lane_failing': e = { type: 'report', pr: pr.index, kind, evidence }; break
      case 'pushed': {
        const url = typeof args['url'] === 'string' ? args['url'].trim() : ''
        if (!/^https?:\/\//.test(url)) throw new ToolError('give the PR\'s URL')
        e = { type: 'report', pr: pr.index, kind, url }
        break
      }
      case 'tests_passing': case 'restacked': case 'lane_passing': {
        if (!sha) throw new ToolError('give the sha of the commit the tests ran on')
        if (!evidence.trim()) throw new ToolError('give the test commands and their summary lines as evidence')
        const git = await this.d.git.check(pr.worktree!)
        // Said to the agent at once; the engine checks the same again.
        if (!git.clean) throw new ToolError('the worktree has uncommitted changes: commit them, run the tests again and report on that commit')
        if (git.head !== sha) throw new ToolError(`you reported on ${sha.slice(0, 8)}, but HEAD is ${git.head.slice(0, 8)}: run the tests on HEAD and report that`)
        let diffChanged: boolean | undefined
        if (kind === 'restacked' && pr.restack && pr.headSha) {
          const parent = t.plan?.prs.find((x) => x.index === pr.index)?.below
          const parentPr = parent != null ? prOf(t, parent) : undefined
          const onto = parentPr && parentPr.status !== 'merged' ? parentPr.branch : `origin/${this.repoOf(t, pr)!.baseBranch}`
          diffChanged = await this.d.git.diffChanged(pr.worktree!, { base: pr.restack.from, head: pr.headSha }, { base: onto, head: git.head })
        }
        e = { type: 'report', pr: pr.index, kind, sha, evidence, git: { ...git, ...(diffChanged !== undefined ? { diffChanged } : {}) } }
        break
      }
      default: throw new ToolError(`unknown report kind ${kind}`)
    }
    const notice = await this.run(t.id, e)
    if (notice) throw new ToolError(notice)
    const now = prOf(this.d.store.get(t.id)!, pr.index)!
    return `Recorded. ${localKeyOf(t, pr.index)} is ${now.status}${now.work !== 'idle' ? ` (${now.work})` : ''}.`
  }

  private stackStatus(t: Ticket): string {
    return t.prs.map((p) => {
      const planned = t.plan?.prs.find((x) => x.index === p.index)
      return `${localKeyOf(t, p.index)} ${planned?.title} — ${p.status}; ${planned?.repo} ${p.branch}; owns ${planned?.owns.join(', ')}` +
        `${p.flags.needsRestack ? '; needs restack' : ''}${p.flags.blocked ? `; blocked: ${p.flags.blocked}` : ''}`
    }).join('\n') || 'The plan is not approved yet.'
  }

  /* ---------- the orchestrator's ticket tools ---------- */

  ticketOf(sessionId: string): string | null {
    const r = this.recordOfSession(sessionId)
    return r ? this.d.store.get(r.ticketId)?.localKey ?? null : null
  }

  private find(ref: string): Ticket {
    const want = ref.trim().toLowerCase()
    const all = this.d.store.list()
    const t = all.find((x) => x.localKey.toLowerCase() === want || x.key?.toLowerCase() === want) ??
      all.find((x) => x.title.toLowerCase() === want) ?? all.find((x) => x.id === ref)
    if (!t) throw new ToolError(`no ticket ${ref}; tickets: ${all.map((x) => x.localKey).join(', ') || 'none'}`)
    return t
  }

  async startTicket(args: Record<string, unknown>): Promise<string> {
    const s = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')
    const title = s('title')
    const text = s('text')
    if (!title || !text) throw new ToolError('a ticket needs a title and its text; look it up, or ask the user to paste it')
    const rawRepos = Array.isArray(args['repos']) ? args['repos'] as Array<Record<string, unknown>> : []
    if (!rawRepos.length) throw new ToolError('name at least one local repository the ticket touches')
    const repos: TicketRepo[] = []
    for (const r of rawRepos) {
      const root = typeof r['path'] === 'string' ? path.resolve(r['path']) : ''
      if (!root || !await this.d.git.isRepo(root)) throw new ToolError(`${r['path']} is not a git repository; ask the user for the path`)
      const id = path.basename(root)
      if (repos.some((x) => x.id === id)) continue
      this.prefixes.set(id, await this.d.git.branchPrefix(root))
      repos.push({ id, root, baseBranch: typeof r['base'] === 'string' && r['base'].trim() ? r['base'].trim() : await this.d.git.baseBranch(root) })
    }
    const key = s('key') || null
    if (key && this.d.store.list().some((x) => x.key === key && x.phase !== 'done' && x.phase !== 'abandoned')) {
      throw new ToolError(`${key} already has a ticket tab; see ticket_status`)
    }
    const t = await this.d.store.create({ key, title, text, source: s('source') || 'pasted', repos, maxAgents: this.d.settings.get().maxAgents })
    const projectId = this.d.pm.createProject(`${t.localKey} ${title}`.slice(0, 48), repos[0]!.root, false)
    await this.d.store.update(t.id, (x) => { x.projectId = projectId })
    const notice = await this.run(t.id, { type: 'start' })
    if (notice) throw new ToolError(notice)
    return `Opened the tab "${t.localKey} ${title.slice(0, 40)}" with a planner agent in slot 1. ` +
      `Repos: ${repos.map((r) => `${r.id} on ${r.baseBranch}`).join(', ')}. The plan comes to the user as a card to approve; ` +
      'nothing is coded before that. Follow it with ticket_status.'
  }

  listTickets(): string {
    const all = this.d.store.list()
    if (!all.length) return 'No tickets yet. Start one with start_ticket.'
    return all.map((t) => {
      const waiting = cardsFor(t).filter((c) => c.kind !== 'feature').length
      const prs = t.prs.map((p) => `${p.index} ${p.status}${p.flags.blocked ? ' (blocked)' : ''}`).join(', ')
      return `${t.localKey} ${t.title} — ${t.phase}${prs ? `; PRs: ${prs}` : ''}${waiting ? `; ${waiting} card(s) waiting on the user` : ''}`
    }).join('\n')
  }

  ticketStatus(ref: string): string {
    const t = this.find(ref)
    const lines = [
      `${t.localKey} ${t.title} — ${t.phase}; agents ${t.maxAgents}; repos ${t.repos.map((r) => `${r.id} (${r.root}, on ${r.baseBranch})`).join(', ')}`,
      ...(t.planErrors.length ? ['The planner is fixing:', ...t.planErrors.map((e) => `- ${e}`)] : []),
      ...(t.plan ? [`Plan v${t.plan.version}: ${t.plan.summary}`] : []),
      ...t.prs.map((p) => {
        const findings = (p.review?.findings ?? []).map((f) =>
          `    ${f.id} [${f.severity}${f.holds ? ', holds' : ''}] ${f.summary} — ${typeof f.resolution === 'string' ? f.resolution : JSON.stringify(f.resolution)}`)
        return [`- ${localKeyOf(t, p.index)} ${t.plan?.prs.find((x) => x.index === p.index)?.title}: ${p.status}${p.work !== 'idle' ? ` (${p.work})` : ''}` +
          `${p.reviewing ? ' (being reviewed)' : ''}; ${p.branch}${p.worktree ? ` at ${p.worktree}` : ''}${p.prUrl ? `; ${p.prUrl}` : ''}` +
          `${p.flags.needsRestack ? '; needs restack' : ''}${p.flags.baseFailing ? '; a lower PR is failing' : ''}${p.flags.blocked ? `; blocked: ${p.flags.blocked}` : ''}${p.paused ? '; paused' : ''}`,
        ...findings].join('\n')
      }),
      `Checklist: ${Object.entries(checklist(t)).map(([k, v]) => `${k} ${v === true ? 'yes' : v === false ? 'no' : 'unknown'}`).join(', ')}`,
      'Waiting on the user:',
      ...cardsFor(t).filter((c) => c.kind !== 'feature').map((c) => `- ${c.title} [${c.actions.map((a) => a.id).join(', ')}]`),
      'Recent log:',
      ...t.log.slice(-12).map((e) => `- ${e.pr !== null ? `${localKeyOf(t, e.pr)} ` : ''}${e.who}: ${e.text}`),
    ]
    return lines.join('\n')
  }

  async ticketAction(args: Record<string, unknown>): Promise<string> {
    const t = this.find(String(args['ticket'] ?? ''))
    const action = String(args['action'] ?? '')
    const pr = typeof args['pr'] === 'number' ? args['pr'] : undefined
    const text = typeof args['text'] === 'string' ? args['text'] : undefined
    const value = typeof args['value'] === 'number' ? args['value'] : undefined
    if (action === 'tell') {
      if (pr === undefined || !text) throw new ToolError('tell needs pr and text')
      const notice = await this.run(t.id, { type: 'tell', pr, text })
      if (notice) throw new ToolError(notice)
      return `Passed to ${localKeyOf(t, pr)}; it gets it when it is next idle.`
    }
    const cards = cardsFor(t)
    const byKind = (kind: string): typeof cards[number] | undefined =>
      cards.find((c) => c.kind === kind && (pr === undefined || c.prIndex === pr))
    const pick: Record<string, () => [typeof cards[number] | undefined, string]> = {
      approve: () => [byKind('plan') ?? byKind('amendment'), 'approve'],
      revise: () => [byKind('plan'), 'revise'],
      cancel: () => [byKind('feature'), 'cancel'],
      agents: () => [byKind('plan') ?? cards[0], 'agents'],
      restack: () => [byKind('restack'), 'restack'],
      fix: () => [cards.find((c) => c.findingId === args['finding']), 'fix'],
      skip: () => [cards.find((c) => c.findingId === args['finding']), 'skip'],
      'fix-all': () => [byKind('review'), 'fix-all'],
      push: () => [byKind('push'), 'push'],
      'push-stack': () => [cards[0], `push-stack:${pr}`],
      merged: () => [cards[0], `merged:${pr}`],
      resume: () => [cards[0], `resume:${pr}`],
      nudge: () => [byKind('blocked'), 'nudge'],
      fresh: () => [byKind('blocked'), 'fresh'],
      pause: () => [byKind('blocked'), 'pause'],
    }
    const chosen = pick[action]?.()
    if (!chosen) throw new ToolError(`unknown action ${action}`)
    const [card, id] = chosen
    if (!card) throw new ToolError(`nothing to ${action}${pr !== undefined ? ` for ${localKeyOf(t, pr)}` : ''} right now; see ticket_status`)
    const notice = await this.run(t.id, { type: 'action', cardId: card.id, action: id, ...(text ? { text } : {}), ...(value !== undefined ? { value } : {}) })
    if (notice) throw new ToolError(notice)
    return `Done: ${action}${pr !== undefined ? ` ${localKeyOf(t, pr)}` : ''} on ${t.localKey}.`
  }

/** Every ticket's cards, as inbox items (Inbox.syncWorkflow keeps the inbox to these). */
  cardItems(): InboxItem[] {
    return this.d.store.list().filter((t) => !t.archived).flatMap((t) => cardsFor(t).map((c): InboxItem => ({
      id: c.id,
      sessionId: '',
      kind: c.kind === 'feature' ? 'feature' : 'workflow',
      createdAt: 0,
      ticketId: t.id,
      title: c.title,
      message: c.body,
      actions: c.actions,
      ...(c.prIndex !== undefined ? { prIndex: c.prIndex } : {}),
    })))
  }

  /** A card button pressed in the inbox. */
  act(ticketId: string, cardId: string, action: string, text?: string, value?: number): Promise<string | null> {
    return this.run(ticketId, { type: 'action', cardId, action, ...(text ? { text } : {}), ...(value !== undefined ? { value } : {}) })
  }
}

/** A path for any shell's command line: double quotes, refused if it holds what a shell would expand. */
function quoted(p: string): string {
  if (/["`$%]/.test(p)) throw new Error(`cannot hand ${p} to a shell safely; move tring's config directory`)
  return `"${p}"`
}

/**
 * A tile's own `--settings`: tring's hook on edits and shell commands (the
 * ownership and push gates), the plan's approved test commands allowed, and
 * for a planner or reviewer no editing at all.
 */
export function tileSettings(t: Ticket, role: Role, pr: number | null, hook: string): Record<string, unknown> {
  const planned = pr !== null ? t.plan?.prs.find((x) => x.index === pr) : undefined
  const allow = role === 'planner' ? [] : (planned?.tests.run ?? []).map((c) => `Bash(${c})`)
  return {
    permissions: {
      allow,
      ...(role === 'coder' ? {} : { deny: ['Edit', 'Write', 'NotebookEdit'] }),
    },
    hooks: {
      PreToolUse: [{
        matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell',
        hooks: [{ type: 'command', command: `${hook} PreToolUse`, timeout: 15 }],
      }],
    },
  }
}

import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { DiffResult, InboxItem, ProjectInfo, SessionStatus } from '@tring/shared/protocol'
import { gitDiff } from './git-diff.ts'
import {
  defaultWorktreePath, normal, realGit, repoName, samePath, type GitOps, type GitPlace, type Worktree,
} from './git-worktrees.ts'
import { cleanPrompt, typePrompt } from './type-prompt.ts'
import { findTranscript, readTranscript, type Transcript, type Turn } from './transcript.ts'
import { defaultTranscriptDir } from './usage.ts'

/**
 * What the orchestrator agent can do with the tiles, served to it as the
 * `tring` MCP server (see mcp-cli.ts, which only relays to here).
 *
 * The line it never crosses: it talks to *agents*. It reads any tile, but it
 * only ever types into one that is running Claude Code and is not holding a
 * permission prompt or a question — so its words always land as a prompt,
 * where that agent's own permissions still apply, and never as keystrokes in
 * a shell or as a choice in someone else's dialog. Permission cards stay
 * yours, in the inbox, as they were.
 *
 * Git worktrees are first-class: every tile is placed in its repository and
 * worktree — where its *agent* is working, which is not always where its
 * shell started — so parallel work can be kept one agent to a worktree.
 */

/** The slice of a Session the tools use, so tests can pass a stub. */
export interface ToolSession {
  id: string
  projectId: string
  slot: number
  name: string | null
  title: string | null
  cwd: string
  /** Where the tile's agent is working, from its hooks; see Session.agentCwd. */
  agentCwd: string | null
  /** The conversation's transcript file, from its hooks; see Session.transcript. */
  transcript: string | null
  command: string | null
  claude: { id: string; cwd: string } | null
  lastMessage: string | null
  stoppedAt: number
  promptedAt: number
  tracker: { status: SessionStatus }
  recentText(lines: number): string
  write(data: string): void
  prompted(): void
}

export interface ToolDeps {
  pm: {
    list(): ProjectInfo[]
    readonly activeProjectId: string | null
    findSession(id: string): ToolSession | undefined
    findProject(ref: string): ProjectInfo | undefined
    create(projectId: string | undefined, spec: { cwd?: string; command?: string | null; name?: string | null }): ToolSession | null
  }
  inbox: { list(): InboxItem[] }
  git?: GitOps
  /** Reading Claude Code transcripts; replaced in tests. */
  transcripts?: {
    read(file: string): Promise<Transcript | null>
    find(conversationId: string): Promise<string | null>
  }
  diff?: (cwd: string) => Promise<DiffResult>
  isDir?: (p: string) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Typing a prompt; replaced in tests so nothing waits on a timer. */
  type?: (s: ToolSession, text: string) => void
  /** The multi-PR workflow (workflow/runner.ts); its tools are listed only while it is switched on. */
  workflow?: WorkflowTools | null
}

/** What the orchestrator's ticket tools call. */
export interface WorkflowTools {
  enabled(): boolean
  /** The local key of the ticket a tile belongs to, or null for any other tile. */
  ticketOf(sessionId: string): string | null
  startTicket(args: Record<string, unknown>): Promise<string>
  listTickets(): string
  ticketStatus(ref: string): string
  ticketAction(args: Record<string, unknown>): Promise<string>
}

/** A mistake the agent can fix — a wrong ref, a tile that cannot take a prompt. */
export class ToolError extends Error {}

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const SESSION_REF = {
  type: 'string',
  description: 'A session id from list_sessions, or "<project>/<slot>" such as "tring.chat/3". A bare slot number means the project the user is viewing.',
}

export const TOOLS: ToolDef[] = [
  {
    name: 'list_sessions',
    description: 'Every project and terminal tile in tring: slot, name, status (busy = working, done = finished and waiting for the user, idle, exited), the directory its agent is working in, its git repository, worktree and branch, whether it runs Claude Code, what it is waiting on, and the last thing its agent said. Flags tiles that share a worktree. Call this first to know what is going on.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Only this project (name or id).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_worktrees',
    description: 'Every git worktree of each project\'s repository (and of any repository a tile is in): path, branch, whether it is the main checkout, and which tiles are working in it. Use it to find a free worktree for new work, or to see where a branch is checked out.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Only this project\'s repository (name or id).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'find_work',
    description: 'Which tiles have been working on something: ranks every tile by how well the request matches its name, branch, worktree, conversation title, the prompts it was given, what its agent said and the files it edited. Use it whenever the user refers to work by topic ("the reporting box", "the login bug") instead of by tile.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What the user is talking about, in their words, e.g. "reporting box colour".' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_history',
    description: 'A tile\'s Claude Code conversation: the prompts it was given, what its agent answered and the files it edited, newest last. With `search`, only the turns that mention it. Use it to confirm a tile is the one working on something before sending it work.',
    inputSchema: {
      type: 'object',
      properties: {
        session: SESSION_REF,
        turns: { type: 'integer', minimum: 1, maximum: 60, description: 'How many recent turns, default 12.' },
        search: { type: 'string', description: 'Only turns mentioning these words.' },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_session',
    description: 'The last lines of a tile\'s terminal (screen and scrollback) as plain text: what its agent or shell is showing right now.',
    inputSchema: {
      type: 'object',
      properties: {
        session: SESSION_REF,
        lines: { type: 'integer', minimum: 1, maximum: 400, description: 'How many lines, default 80.' },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_changes',
    description: 'The uncommitted git changes in the worktree a tile\'s agent is working in: files with lines added and removed, and the patch (all files, trimmed, or one file in full).',
    inputSchema: {
      type: 'object',
      properties: {
        session: SESSION_REF,
        file: { type: 'string', description: 'Only this file\'s patch (a path from the file list).' },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_prompt',
    description: 'Send a prompt to the Claude Code agent in a tile, as if the user typed it there and pressed Enter. Only works on tiles running Claude Code that are not waiting on a permission prompt or question. A busy agent queues it. Use wait_for afterwards to get its answer.',
    inputSchema: {
      type: 'object',
      properties: {
        session: SESSION_REF,
        text: { type: 'string', description: 'The prompt. Write it as a complete instruction; that agent cannot see this conversation.' },
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_session',
    description: 'Start a new tile running Claude Code in the first empty slot of a project, optionally with a first prompt. Give `branch` to run it in a git worktree for that branch: an existing worktree that has the branch checked out is reused; otherwise a new worktree is added (checking out the branch if it exists, or creating it from `base`). One agent per worktree: parallel work gets its own branch. The user sees the new tile in the ring.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id; default the project the user is viewing.' },
        cwd: { type: 'string', description: 'Working directory, or with `branch` the repository to add the worktree to; default the project root. A relative path is resolved against the root.' },
        branch: { type: 'string', description: 'Run in a worktree for this branch, e.g. "feature/CHV-3193-login".' },
        base: { type: 'string', description: 'With a new `branch`: what to branch from (branch, tag or commit); default the repository\'s current HEAD.' },
        worktree_path: { type: 'string', description: 'With `branch`: where to put a new worktree. Default: beside the existing worktrees, or <parent>/<repo>.worktrees/<branch>.' },
        name: { type: 'string', description: 'A short tile name, e.g. "api tests"; defaults to the branch.' },
        prompt: { type: 'string', description: 'First prompt, sent once Claude Code is ready.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for',
    description: 'Wait until the given tiles finish their current work (or need the user, or exit), then return each one\'s status and last message. Use after send_prompt or create_session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessions: { type: 'array', items: SESSION_REF, minItems: 1 },
        timeout_seconds: { type: 'integer', minimum: 5, maximum: 900, description: 'Default 300.' },
      },
      required: ['sessions'],
      additionalProperties: false,
    },
  },
]

/** The multi-PR workflow's tools, listed while Settings → Workflow → Multi-PR workflow is on. */
export const TICKET_TOOLS: ToolDef[] = [
  {
    name: 'start_ticket',
    description: 'Start the multi-PR workflow for a ticket: tring opens a tab for it with a planner agent that splits it into small stacked PRs, each built, tested and freshly reviewed in its own worktree. Look the ticket up first (or ask the user to paste it) and pass its text. Name every local repository it touches; the planner may add more.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The tracker key, e.g. "CHV-3193". Omit for work that has no ticket: tring keys it TRING-<n>.' },
        title: { type: 'string', description: 'A short title.' },
        text: { type: 'string', description: 'The ticket text, in full.' },
        source: { type: 'string', description: 'Where the text came from: "goby", "github", "pasted"…' },
        repos: {
          type: 'array', minItems: 1,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'The local clone\'s main checkout.' },
              base: { type: 'string', description: 'Branch to build on; default develop when the repo has one, else its default branch.' },
            },
            required: ['path'], additionalProperties: false,
          },
        },
      },
      required: ['title', 'text', 'source', 'repos'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_tickets',
    description: 'Every multi-PR ticket: its phase, each PR\'s status, and what is waiting on the user.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ticket_status',
    description: 'One ticket in full: its plan, each PR (status, branch, worktree, flags, findings), the checklist and the work log.',
    inputSchema: {
      type: 'object',
      properties: { ticket: { type: 'string', description: 'Its key (CHV-3193, TRING-2) or title.' } },
      required: ['ticket'], additionalProperties: false,
    },
  },
  {
    name: 'ticket_action',
    description: 'Do what a ticket\'s card buttons do, when the user says it to you: approve the plan, ask for changes, restack, fix or skip a finding, push, mark merged, nudge, pause, set agents, cancel. Or "tell" to pass the user\'s words to one PR\'s agent: the only way to message a ticket\'s agents.',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', description: 'Its key or title.' },
        action: {
          type: 'string',
          enum: ['approve', 'revise', 'cancel', 'agents', 'restack', 'fix', 'skip', 'fix-all', 'push', 'push-stack', 'merged', 'nudge', 'fresh', 'pause', 'resume', 'tell'],
        },
        pr: { type: 'integer', minimum: 1, description: 'The PR it is about (the n in <KEY>-n).' },
        finding: { type: 'string', description: 'fix/skip: the finding id from ticket_status.' },
        text: { type: 'string', description: 'revise, skip: the reason; tell: the message.' },
        value: { type: 'integer', description: 'agents: how many, 4 to 16.' },
      },
      required: ['ticket', 'action'], additionalProperties: false,
    },
  },
]

const MAX_LAST_MESSAGE = 600
const MAX_PATCH_CHARS = 16_000
const READY_TIMEOUT_MS = 30_000
/** Claude draws its UI for a moment after SessionStart before the prompt takes input. */
const READY_SETTLE_MS = 1500
/**
 * A prompt that never made the session busy and never got a Stop — hooks
 * missing, or a prompt Claude answered without a turn — counts as done after
 * this, so wait_for cannot hang on a tile that is plainly sitting there.
 */
const PROMPT_GRACE_MS = 15_000

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s)

async function isDirectory(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory() } catch { return false }
}

/** Where a tile's work happens: its agent's directory, else its shell's. */
export const workdir = (s: ToolSession): string => s.agentCwd ?? s.cwd

/** One tile's place in git, looked up once per tool call. */
interface Placed {
  s: ToolSession
  ref: string
  place: GitPlace | null
}

export class OrchestratorTools {
  constructor(private readonly d: ToolDeps) {}

  private get now(): number { return (this.d.now ?? Date.now)() }
  private get git(): GitOps { return this.d.git ?? realGit }

  private sleep(ms: number): Promise<void> {
    return (this.d.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms)
  }

  /** The tools to offer: the ticket tools only while the workflow is on, so off means off. */
  list(): ToolDef[] {
    return this.d.workflow?.enabled() ? [...TOOLS, ...TICKET_TOOLS] : TOOLS
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const wf = this.d.workflow
    if (TICKET_TOOLS.some((t) => t.name === name)) {
      if (!wf?.enabled()) throw new ToolError('the multi-PR workflow is off (Settings → Workflow)')
      switch (name) {
        case 'start_ticket': return wf.startTicket(args)
        case 'list_tickets': return wf.listTickets()
        case 'ticket_status': return wf.ticketStatus(String(args['ticket'] ?? ''))
        case 'ticket_action': return wf.ticketAction(args)
      }
    }
    switch (name) {
      case 'list_sessions': return this.listSessions(str(args['project']))
      case 'list_worktrees': return this.listWorktrees(str(args['project']))
      case 'find_work': return this.findWork(String(args['query'] ?? ''))
      case 'session_history': return this.sessionHistory(this.resolve(args['session']), num(args['turns']) ?? 12, str(args['search']))
      case 'read_session': return this.readSession(this.resolve(args['session']), num(args['lines']) ?? 80)
      case 'session_changes': return this.changes(this.resolve(args['session']), str(args['file']))
      case 'send_prompt': return this.sendPrompt(this.resolve(args['session']), String(args['text'] ?? ''))
      case 'create_session': return this.createSession(args, signal)
      case 'wait_for': return this.waitFor(args, signal)
    }
    throw new ToolError(`unknown tool ${name}`)
  }

  /** "<project>/<slot>", a session id, or a slot in the viewed project. */
  resolve(ref: unknown): ToolSession {
    const r = String(ref ?? '').trim()
    if (!r) throw new ToolError('session is required')
    const byId = this.d.pm.findSession(r)
    if (byId) return byId
    const at = r.lastIndexOf('/')
    const projectRef = at >= 0 ? r.slice(0, at) : null
    const slot = Number(at >= 0 ? r.slice(at + 1) : r)
    const project = projectRef !== null
      ? this.d.pm.findProject(projectRef)
      : this.d.pm.list().find((p) => p.id === this.d.pm.activeProjectId)
    if (!project) throw new ToolError(`no project ${projectRef ?? '(none is being viewed)'}; see list_sessions`)
    if (!Number.isInteger(slot)) throw new ToolError(`cannot read "${r}" as a session; use an id or "<project>/<slot>"`)
    const info = project.sessions.find((s) => s.slot === slot)
    const s = info && this.d.pm.findSession(info.id)
    if (!s) throw new ToolError(`slot ${slot} in ${project.name} is empty`)
    return s
  }

  private ref(s: ToolSession): string {
    const project = this.d.pm.list().find((p) => p.id === s.projectId)
    return `${project?.name ?? 'project'}/${s.slot}`
  }

  private label(s: ToolSession): string {
    return `${this.ref(s)}${s.name ? ` (${s.name})` : ''}`
  }

  private waiting(s: ToolSession): InboxItem[] {
    return this.d.inbox.list().filter((i) => i.sessionId === s.id && i.kind !== 'reply')
  }

  private allSessions(): ToolSession[] {
    return this.d.pm.list().flatMap((p) => p.sessions)
      .map((i) => this.d.pm.findSession(i.id))
      .filter((s): s is ToolSession => !!s)
  }

  /** Every tile with its repository and worktree, in one pass of git calls. */
  private async placeAll(sessions: ToolSession[] = this.allSessions()): Promise<Placed[]> {
    const memo = new Map<string, Promise<GitPlace | null>>()
    const place = (dir: string): Promise<GitPlace | null> => {
      const k = normal(dir)
      if (!memo.has(k)) memo.set(k, this.git.place(dir))
      return memo.get(k)!
    }
    return Promise.all(sessions.map(async (s) => ({ s, ref: this.ref(s), place: await place(workdir(s)) })))
  }

  /** Other live tiles whose agents are in the same worktree as `p`. */
  private sharing(p: Placed, all: Placed[]): Placed[] {
    if (!p.place) return []
    return all.filter((o) => o.s.id !== p.s.id && o.place && o.s.tracker.status !== 'exited' &&
      samePath(o.place.root, p.place!.root))
  }

  private async listSessions(only: string | undefined): Promise<string> {
    let projects = this.d.pm.list()
    if (only) {
      const p = this.d.pm.findProject(only)
      if (!p) throw new ToolError(`no project ${only}; projects: ${projects.map((x) => x.name).join(', ')}`)
      projects = [p]
    }
    const placed = await this.placeAll()
    const byId = new Map(placed.map((p) => [p.s.id, p]))
    const talks = new Map(await Promise.all(placed.map(async (p) => [p.s.id, await this.history(p.s)] as const)))
    const worked = new Map(await Promise.all(placed.map(async (p) => [p.s.id, await this.workedIn(talks.get(p.s.id) ?? null)] as const)))
    const out = projects.map((p) => ({
      project: p.name,
      id: p.id,
      root: p.root,
      viewing: p.id === this.d.pm.activeProjectId,
      sessions: p.sessions.map((info) => {
        const pl = byId.get(info.id)
        const s = pl?.s
        const waiting = s ? this.waiting(s) : []
        const shared = pl ? this.sharing(pl, placed).map((o) => o.ref) : []
        const agentDir = s?.agentCwd && !samePath(s.agentCwd, info.cwd) ? s.agentCwd : null
        return {
          ref: `${p.name}/${info.slot}`,
          id: info.id,
          slot: info.slot,
          name: info.name ?? info.title ?? null,
          status: info.status,
          cwd: info.cwd,
          ...(agentDir ? { agentCwd: agentDir } : {}),
          git: pl?.place ? gitSummary(pl.place) : null,
          ...(shared.length ? { sameWorktreeAs: shared } : {}),
          agent: s?.claude ? 'claude' : null,
          ...conversationSummary(talks.get(info.id) ?? null),
          ...workedSummary(worked.get(info.id) ?? []),
          ...(waiting.length ? { waitingOnUser: waiting.map(summary) } : {}),
          ...(s?.lastMessage ? { lastMessage: clip(s.lastMessage, MAX_LAST_MESSAGE) } : {}),
        }
      }),
    }))
    return JSON.stringify({ projects: out }, null, 2)
  }

  private async listWorktrees(only: string | undefined): Promise<string> {
    let projects = this.d.pm.list()
    if (only) {
      const p = this.d.pm.findProject(only)
      if (!p) throw new ToolError(`no project ${only}; projects: ${projects.map((x) => x.name).join(', ')}`)
      projects = [p]
    }
    const placed = await this.placeAll()
    // Every repository a project root or a tile is in, once each.
    const repos = new Map<string, { dir: string; projects: Set<string> }>()
    const add = (place: GitPlace | null, dir: string, project?: string): void => {
      if (!place) return
      const k = normal(place.commonDir)
      const r = repos.get(k) ?? { dir, projects: new Set<string>() }
      if (project) r.projects.add(project)
      repos.set(k, r)
    }
    const roots = await Promise.all(projects.map(async (p) => ({ p, place: await this.git.place(p.root) })))
    for (const { p, place } of roots) add(place, p.root, p.name)
    const wanted = new Set(projects.map((p) => p.id))
    for (const pl of placed) if (wanted.has(pl.s.projectId)) add(pl.place, workdir(pl.s))

    if (repos.size === 0) return 'No git repositories: none of these projects or tiles is inside one.'
    const out = await Promise.all([...repos.entries()].map(async ([commonDir, r]) => {
      const trees = await this.git.worktrees(r.dir)
      return {
        repo: repoName(commonDir),
        ...(r.projects.size ? { projects: [...r.projects] } : {}),
        // git lists the main worktree first; in a bare-repo layout that entry
        // is the bare repository itself, and every checkout is a linked one.
        worktrees: trees.map((w, i) => ({ w, main: i === 0 && !w.bare })).filter(({ w }) => !w.bare).map(({ w, main }) => {
          const tiles = placed.filter((pl) => pl.place && samePath(pl.place.root, w.path))
          return {
            path: w.path,
            branch: w.branch ?? (w.detached ? '(detached)' : null),
            main,
            tiles: tiles.map((t) => `${t.ref} ${t.s.tracker.status}${t.s.claude ? ' claude' : ''}`),
            ...(w.locked ? { locked: true } : {}),
            ...(w.prunable ? { prunable: true } : {}),
          }
        }),
      }
    }))
    return JSON.stringify({ repos: out }, null, 2)
  }

  /**
   * The worktrees an agent has really been working in, by the files it edited
   * and read and the paths in the commands it ran — not where its shell sits.
   * A Claude started in the home directory that spends the day editing one
   * repository is working in that repository.
   */
  private async workedIn(talk: Transcript | null): Promise<Array<{ root: string; edits: number; reads: number }>> {
    if (!talk) return []
    const tally = new Map<string, { root: string; edits: number; reads: number }>()
    const count = async (p: string, kind: 'edits' | 'reads'): Promise<void> => {
      if (!path.isAbsolute(p)) return
      const root = await this.git.rootOf(p)
      if (!root) return
      const k = normal(root)
      const t = tally.get(k) ?? { root, edits: 0, reads: 0 }
      t[kind]++
      tally.set(k, t)
    }
    const jobs: Array<Promise<void>> = []
    for (const t of talk.turns) {
      for (const f of t.files ?? []) jobs.push(count(f, 'edits'))
      for (const p of t.paths ?? []) jobs.push(count(p, 'reads'))
      for (const c of t.commands ?? []) for (const p of pathsIn(c)) jobs.push(count(p, 'reads'))
    }
    await Promise.all(jobs)
    return [...tally.values()].sort((a, b) => b.edits * 3 + b.reads - (a.edits * 3 + a.reads)).slice(0, 5)
  }

  /** The tile's conversation, from the transcript its hooks named, or found by id. */
  private async history(s: ToolSession): Promise<Transcript | null> {
    const t = this.d.transcripts ?? {
      read: readTranscript,
      find: (id: string) => findTranscript(defaultTranscriptDir(), id),
    }
    // The hook's path first, but not on trust: a conversation resumed from
    // another directory (every tile after a tring restart, reopened in its
    // shell's directory) gets a SessionStart whose transcript_path is built
    // from the new directory, and no such file exists. Only the next prompt or
    // tool call reports the real one, so an idle tile kept the dead path — and
    // with it no title, prompts or workedIn — until someone typed there.
    if (s.transcript) {
      const talk = await t.read(s.transcript)
      if (talk) return talk
    }
    // Then by conversation id, which tring persists across restarts: the file
    // is `<id>.jsonl` under whichever project directory Claude filed it in.
    const found = s.claude ? await t.find(s.claude.id) : null
    if (!found || found === s.transcript) return null
    const talk = await t.read(found)
    if (talk) s.transcript = found
    return talk
  }

  private async sessionHistory(s: ToolSession, count: number, search: string | undefined): Promise<string> {
    const talk = await this.history(s)
    if (!talk) {
      return `${this.label(s)}: no conversation to read${s.claude ? ' (its transcript was not found)' : ' — it is not running Claude Code'}.`
    }
    const n = Math.max(1, Math.min(60, Math.floor(count)))
    let turns = talk.turns
    if (search) {
      const ws = words(search)
      turns = turns.filter((t) => ws.some((w) => turnText(t).toLowerCase().includes(w)))
      if (!turns.length) return `${this.label(s)}: nothing in its conversation mentions "${search}".`
    }
    const shown = turns.slice(-n)
    const head = `${this.label(s)}${talk.title ? ` — "${talk.title}"` : ''}: ` +
      `${shown.length} of ${turns.length} ${search ? 'matching ' : ''}turn(s)${talk.partial ? ' (a very long conversation: only its start and end were read)' : ''}`
    const body = shown.map((t) => {
      const who = t.role === 'user' ? 'PROMPT' : 'AGENT'
      const files = t.files?.length ? `\n(edited: ${t.files.join(', ')})` : ''
      return `[${who}${t.at ? ` ${t.at.slice(0, 16).replace('T', ' ')}` : ''}]\n${clip(t.text, t.role === 'user' ? 800 : 1500)}${files}`
    })
    return `${head}\n\n${body.join('\n\n')}`
  }

  /**
   * Ranks tiles against what the user said. Each word counts for more the
   * fewer tiles mention it — "change" is everywhere, "reporting" is not — and
   * what a tile was asked, titled or edited counts for more than what its
   * agent happened to say, as do its recent turns over its old ones.
   */
  private async findWork(query: string): Promise<string> {
    const ws = words(query)
    if (!ws.length) throw new ToolError('say what the work is about, e.g. "reporting box"')
    const placed = await this.placeAll()
    const docs = await Promise.all(placed.map(async (p) => {
      const talk = await this.history(p.s)
      const worked = await this.workedIn(talk)
      const fields: Array<{ why: string; text: string; weight: number }> = [
        { why: 'name', text: [p.s.name, p.s.title].filter(Boolean).join(' '), weight: 4 },
        { why: 'branch', text: [p.place?.branch, p.place?.root].filter(Boolean).join(' '), weight: 4 },
        { why: 'title', text: talk?.title ?? '', weight: 4 },
        { why: 'worked in', text: worked.map((w) => w.root).join(' '), weight: 4 },
        { why: 'last message', text: p.s.lastMessage ?? '', weight: 1 },
        // What is on its terminal. With no conversation to read — a shell, a
        // Claude whose transcript cannot be found — it is the tile's only
        // record of what it is doing, and counts for as much as a title.
        { why: talk ? 'screen' : 'screen only', text: p.s.recentText(SCREEN_LINES), weight: talk ? 1 : 3 },
      ]
      const turns = talk?.turns ?? []
      turns.forEach((t, i) => {
        const recent = i >= turns.length - 10 ? 2 : 1
        if (t.role === 'user') fields.push({ why: 'prompt', text: t.text, weight: 3 * recent })
        else fields.push({ why: 'agent said', text: t.text, weight: recent })
        if (t.files?.length) fields.push({ why: 'edited', text: t.files.join(' '), weight: 3 * recent })
        if (t.paths?.length) fields.push({ why: 'read', text: t.paths.join(' '), weight: recent })
        if (t.commands?.length) fields.push({ why: 'ran', text: t.commands.join(' '), weight: recent })
      })
      return { p, fields }
    }))
    // How many tiles mention each word, for its weight.
    const df = new Map(ws.map((w) => [w, docs.filter((d) => d.fields.some((f) => f.text.toLowerCase().includes(w))).length]))
    // Words no tile mentions say nothing either way. "Edit tring since it cuts
    // off characters on cards" is one word of signal and five of description.
    const known = ws.filter((w) => df.get(w)! > 0)
    const ranked = docs.map(({ p, fields }) => {
      let score = 0
      const why = new Set<string>()
      let best: { score: number; text: string } | null = null
      // A word in passing is not a match: "payments page" must not land on
      // the tile whose agent once wrote "login page". Confident means every
      // word in one place, or at least half of them where the tile's purpose
      // is recorded — its name, branch, title, prompts or edits.
      let whole = false
      const strong = new Set<string>()
      for (const f of fields) {
        const low = f.text.toLowerCase()
        const hit = ws.filter((w) => low.includes(w))
        if (!hit.length) continue
        const s = f.weight * hit.reduce((n, w) => n + 1 / df.get(w)!, 0) * (hit.length === ws.length ? 2 : 1)
        score += s
        why.add(f.why)
        if (!best || s > best.score) best = { score: s, text: snippet(f.text, hit[0]!) }
        if (hit.length === ws.length) whole = true
        if (STRONG.has(f.why)) for (const w of hit) strong.add(w)
      }
      // Confident when: every word in one place; or, across the places a
      // tile's purpose is recorded, half the words any tile knows; or a word
      // only this tile knows, there — "tring" in the repos its agent edited.
      const confident = whole || strong.size >= Math.max(1, known.length / 2) ||
        [...strong].some((w) => df.get(w) === 1)
      return { p, score, confident, why: [...why], snippet: best?.text ?? '' }
    }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score)

    const top = ranked.slice(0, 5)
    const lines = top.map((r) =>
      `- ${this.label(r.p.s)} — ${r.p.s.tracker.status}${r.p.place?.branch ? `, on ${r.p.place.branch}` : ''}` +
      ` (score ${r.score.toFixed(1)}; matched ${r.why.join(', ')})\n  "${r.snippet}"`)
    const sure = top.filter((r) => r.confident)
    if (!sure.length) {
      return `No tile clearly matches "${query}". Ask the user which tile, or offer a new one in its own worktree.` +
        (lines.length ? `\n\nOnly passing mentions:\n${lines.join('\n')}` : '')
    }
    const close = sure.length > 1 && sure[1]!.score >= sure[0]!.score * 0.75
    const verdict = close
      ? 'Two or more tiles match about equally: ask the user which one before sending anything.'
      : `Best match: ${this.label(sure[0]!.p.s)}. Confirm with session_history if unsure.`
    return `${verdict}\n\n${lines.join('\n')}`
  }

  private readSession(s: ToolSession, lines: number): string {
    const n = Math.max(1, Math.min(400, Math.floor(lines)))
    return `${this.label(s)} — ${s.tracker.status}, ${workdir(s)}\n\n${s.recentText(n) || '(nothing on screen)'}`
  }

  private async changes(s: ToolSession, file: string | undefined): Promise<string> {
    const r = await (this.d.diff ?? gitDiff)(workdir(s))
    if ('error' in r) return `${this.label(s)}: ${r.error}`
    if (r.files.length === 0) return `${this.label(s)}: no uncommitted changes in ${r.cwd}`
    const list = r.files.map((f) => `${f.path}  +${f.added} -${f.removed}${f.note ? ` (${f.note})` : ''}`)
    const head = `${this.label(s)}: ${r.files.length} changed file(s) in ${r.cwd}${r.truncated ? ' (patch truncated)' : ''}\n${list.join('\n')}`
    if (file) {
      const f = r.files.find((x) => x.path === file || x.path.endsWith(`/${file}`))
      if (!f) throw new ToolError(`${file} has no changes; changed: ${r.files.map((x) => x.path).join(', ')}`)
      return `${head}\n\n--- ${f.path}\n${clip(f.patch || f.note || '', MAX_PATCH_CHARS * 2)}`
    }
    let budget = MAX_PATCH_CHARS
    const patches: string[] = []
    for (const f of r.files) {
      if (!f.patch || budget <= 0) continue
      const p = clip(f.patch, budget)
      budget -= p.length
      patches.push(`--- ${f.path}\n${p}`)
    }
    const rest = budget <= 0 ? '\n\n(more patches left out; ask for one file with `file`)' : ''
    return `${head}\n\n${patches.join('\n\n')}${rest}`
  }

  /** Why this tile cannot take a prompt now, or null when it can. */
  private refusal(s: ToolSession): string | null {
    if (s.tracker.status === 'exited') return `${this.label(s)} has exited`
    const ticket = this.d.workflow?.ticketOf(s.id) ?? null
    if (ticket) {
      return `${this.label(s)} is managed by ticket ${ticket}. Use ticket_action with action "tell" to pass it a message; ` +
        'its work is sequenced by the ticket, not by prompts.'
    }
    if (!s.claude) {
      return `${this.label(s)} is not running Claude Code (or tring's hooks are not installed, so it cannot tell). ` +
        'send_prompt only talks to agents; use create_session to start one.'
    }
    const waiting = this.waiting(s)
    if (waiting.length) {
      return `${this.label(s)} is waiting on the user (${waiting.map(summary).join('; ')}). ` +
        'Ask the user to answer it in the inbox first; typing now would land in that dialog.'
    }
    return null
  }

  private deliver(s: ToolSession, text: string): void {
    s.prompted()
    ;(this.d.type ?? typePrompt)(s, text)
  }

  /** A warning for the agent when another agent is busy in the same worktree. */
  private async crowding(s: ToolSession): Promise<string> {
    const placed = await this.placeAll()
    const me = placed.find((p) => p.s.id === s.id)
    const busy = me ? this.sharing(me, placed).filter((o) => o.s.claude && o.s.tracker.status === 'busy') : []
    if (!busy.length || !me?.place) return ''
    return ` Warning: ${busy.map((o) => o.ref).join(', ')} ${busy.length === 1 ? 'is' : 'are'} also working in ` +
      `${me.place.root}; two agents in one worktree edit the same files. Prefer a worktree per task.`
  }

  private async sendPrompt(s: ToolSession, raw: string): Promise<string> {
    const text = cleanPrompt(raw)
    if (!text) throw new ToolError('text is empty')
    const why = this.refusal(s)
    if (why) throw new ToolError(why)
    const busy = s.tracker.status === 'busy'
    const warning = await this.crowding(s)
    this.deliver(s, text)
    return `Sent to ${this.label(s)}${busy ? ' (it was busy, so Claude Code queues it)' : ''}.${warning} ` +
      `Use wait_for with "${s.id}" for the answer.`
  }

  /**
   * The worktree for `branch`: the one it is already checked out in, or a new
   * one. Returns the directory to start in, and what was done, in words.
   */
  private async worktreeFor(repoDir: string, args: Record<string, unknown>): Promise<{ dir: string; note: string }> {
    const branch = str(args['branch'])!
    const git = this.git
    const place = await git.place(repoDir)
    if (!place) throw new ToolError(`${repoDir} is not inside a git repository, so there is no worktree to make`)
    const bad = await git.checkBranch(repoDir, branch)
    if (bad) throw new ToolError(bad)
    const trees = await git.worktrees(repoDir)
    const there = trees.find((w) => w.branch === branch && !w.prunable)
    if (there) {
      const inside = (await this.placeAll())
        .filter((p) => p.place && samePath(p.place.root, there.path) && p.s.tracker.status !== 'exited')
      const crowd = inside.length
        ? ` Warning: ${inside.map((p) => p.ref).join(', ')} ${inside.length === 1 ? 'is' : 'are'} already in that worktree; ` +
          'one agent per worktree, so make sure they are not both working, or use a new branch.'
        : ''
      return { dir: there.path, note: `Reused the existing worktree ${there.path}, which has ${branch} checked out.${crowd}` }
    }

    const base = str(args['base'])
    if (base?.startsWith('-')) throw new ToolError(`"${base}" is not a usable base`)
    const exists = await git.branchExists(repoDir, branch)
    const wanted = str(args['worktree_path'])
    const dir = wanted ? path.resolve(repoDir, wanted) : defaultWorktreePath(place.commonDir, trees, branch)
    if (await (this.d.isDir ?? isDirectory)(dir)) throw new ToolError(`${dir} already exists; pick another worktree_path`)
    const err = await git.addWorktree(repoDir, { path: dir, branch, create: !exists, ...(base && !exists ? { base } : {}) })
    if (err) throw new ToolError(`git worktree add failed: ${err}`)
    const what = exists ? `checked out the existing branch ${branch}` : `created ${branch} from ${base ?? 'the current HEAD'}`
    return { dir, note: `Added the worktree ${dir} and ${what}.` }
  }

  private async createSession(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const projectRef = str(args['project'])
    const project = projectRef
      ? this.d.pm.findProject(projectRef)
      : this.d.pm.list().find((p) => p.id === this.d.pm.activeProjectId) ?? this.d.pm.list()[0]
    if (!project) throw new ToolError(projectRef ? `no project ${projectRef}; see list_sessions` : 'there are no projects yet')
    const cwdArg = str(args['cwd'])
    let cwd = cwdArg ? path.resolve(project.root, cwdArg) : project.root
    if (!await (this.d.isDir ?? isDirectory)(cwd)) throw new ToolError(`${cwd} is not a directory`)

    const branch = str(args['branch'])
    let note = ''
    if (branch) {
      const wt = await this.worktreeFor(cwd, args)
      cwd = wt.dir
      note = ` ${wt.note}`
    }

    let s: ToolSession | null
    try {
      s = this.d.pm.create(project.id, { cwd, command: 'claude', name: str(args['name']) ?? branch ?? null })
    } catch (err) {
      throw new ToolError(`${(err as Error).message}.${note}`)
    }
    if (!s) throw new ToolError(`could not start a session.${note}`)
    const started = `Started ${this.label(s)} (id ${s.id}) running claude in ${cwd}.${note}`

    const prompt = cleanPrompt(String(args['prompt'] ?? ''))
    if (!prompt) return started
    const ready = await this.ready(s, signal)
    if (!ready) {
      return `${started} The first prompt was NOT sent: Claude Code did not report it was ready within ` +
        `${READY_TIMEOUT_MS / 1000}s (are tring's hooks installed? is the folder trusted?). Check with read_session, then use send_prompt.`
    }
    this.deliver(s, prompt)
    return `${started} First prompt sent. Use wait_for with "${s.id}" for the answer.`
  }

  /** Claude has started (SessionStart hook) and drawn its prompt. */
  private async ready(s: ToolSession, signal?: AbortSignal): Promise<boolean> {
    const until = this.now + READY_TIMEOUT_MS
    let since: number | null = null
    while (this.now < until && !signal?.aborted) {
      if (s.tracker.status === 'exited') return false
      if (s.claude && s.tracker.status !== 'busy') {
        since ??= this.now
        if (this.now - since >= READY_SETTLE_MS) return true
      } else {
        since = null
      }
      await this.sleep(250)
    }
    return false
  }

  private async waitFor(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const refs = Array.isArray(args['sessions']) ? args['sessions'] : [args['sessions']]
    const sessions = refs.map((r) => this.resolve(r))
    const timeout = Math.max(5, Math.min(900, num(args['timeout_seconds']) ?? 300)) * 1000
    const until = this.now + timeout
    while (!signal?.aborted) {
      if (sessions.every((s) => this.state(s) !== 'working') || this.now >= until) break
      await this.sleep(1000)
    }
    const timedOut = sessions.some((s) => this.state(s) === 'working')
    const lines = sessions.map((s) => {
      const st = this.state(s)
      const waiting = this.waiting(s)
      const said = s.lastMessage && s.stoppedAt >= s.promptedAt ? `\n${clip(s.lastMessage, 4000)}` : ''
      const why = st === 'needs-user' ? ` — waiting on the user: ${waiting.map(summary).join('; ')}` : ''
      return `## ${this.label(s)} — ${st === 'working' ? 'still working' : st}${why}${said}`
    })
    return (timedOut ? `Timed out after ${timeout / 1000}s.\n\n` : '') + lines.join('\n\n')
  }

  private state(s: ToolSession): 'working' | 'finished' | 'needs-user' | 'exited' {
    if (s.tracker.status === 'exited') return 'exited'
    if (this.waiting(s).length) return 'needs-user'
    if (s.tracker.status === 'busy') return 'working'
    if (s.promptedAt > s.stoppedAt && this.now - s.promptedAt < PROMPT_GRACE_MS) return 'working'
    return 'finished'
  }
}

/** What a tile is about, in a few lines, for list_sessions. */
function conversationSummary(t: Transcript | null): Record<string, unknown> {
  if (!t) return {}
  const prompts = t.turns.filter((x) => x.role === 'user').map((x) => clip(x.text.replace(/\s+/g, ' '), 200))
  if (!t.title && !prompts.length) return {}
  return {
    conversation: {
      ...(t.title ? { title: t.title } : {}),
      ...(prompts.length ? { firstPrompt: prompts[0] } : {}),
      ...(prompts.length > 1 ? { recentPrompts: prompts.slice(-3) } : {}),
    },
  }
}

/** Where a tile's purpose is recorded, as opposed to what its agent happened to say. */
const STRONG = new Set(['name', 'branch', 'title', 'worked in', 'prompt', 'edited', 'screen only'])
/** How much of a tile's terminal find_work reads. */
const SCREEN_LINES = 200

/** For list_sessions: the repositories the agent has been editing and reading in. */
function workedSummary(w: Array<{ root: string; edits: number; reads: number }>): Record<string, unknown> {
  if (!w.length) return {}
  return { workedIn: w.map((x) => `${x.root} (${x.edits} edits, ${x.reads} reads)`) }
}

/**
 * Absolute paths named in a shell command: quoted ones (which may hold
 * spaces, as Windows paths do) and bare ones. Enough to see which repository
 * a `cd "C:/src/app" && npm test` was about.
 */
export function pathsIn(command: string): string[] {
  const out = new Set<string>()
  const abs = /^(?:[A-Za-z]:[\\/]|\/(?!\/))/
  for (const m of command.matchAll(/"([^"\n]+)"|'([^'\n]+)'/g)) {
    const p = (m[1] ?? m[2] ?? '').trim()
    if (abs.test(p)) out.add(p)
  }
  for (const m of command.replace(/"[^"\n]*"|'[^'\n]*'/g, ' ').matchAll(/(?:^|[\s=(])((?:[A-Za-z]:[\\/]|\/)[^\s"'`;|&<>()]+)/g)) {
    if (abs.test(m[1]!) && m[1] !== '/') out.add(m[1]!)
  }
  return [...out].slice(0, 10)
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'then', 'than', 'please', 'can', 'could',
  'would', 'should', 'you', 'your', 'our', 'its', 'are', 'was', 'were', 'has', 'have', 'had', 'not', 'but', 'all',
  'any', 'some', 'one', 'out', 'make', 'change', 'update', 'fix', 'add', 'set', 'get', 'put', 'use', 'now', 'also',
  'just', 'like', 'want', 'need', 'tile', 'terminal', 'session', 'agent', 'work', 'working', 'thing', 'there',
  'since', 'because', 'when', 'where', 'what', 'which', 'while', 'about', 'after', 'before', 'still', 'very',
  'really', 'only', 'even', 'more', 'most', 'much', 'many', 'other', 'over', 'under', 'again', 'seems', 'look',
  'looks', 'see', 'show', 'shows', 'does', 'doesn', 'don', 'did', 'will', 'won', 'cannot', 'edit', 'sure',
  'should', 'here', 'they', 'them', 'their', 'what', 'who', 'how', 'why', 'yes', 'okay',
])

/**
 * The words of a query worth matching, shortened to a stem so "reporting"
 * finds "report" and "reports". Short and common words carry nothing.
 */
export function words(query: string): string[] {
  const out = query.toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 5 ? w.replace(/(ing|ed|es|s)$/, '') : w))
  return [...new Set(out)]
}

function turnText(t: Turn): string {
  return `${t.text} ${t.files?.join(' ') ?? ''}`
}

/** A line of context around the first match. */
function snippet(text: string, word: string): string {
  const flat = text.replace(/\s+/g, ' ')
  const i = flat.toLowerCase().indexOf(word)
  const from = Math.max(0, i - 60)
  return `${from > 0 ? '…' : ''}${flat.slice(from, from + 160)}${from + 160 < flat.length ? '…' : ''}`
}

function gitSummary(p: GitPlace): Record<string, unknown> {
  return {
    repo: repoName(p.commonDir),
    branch: p.branch ?? (p.detached ? '(detached)' : null),
    worktree: p.root,
    linkedWorktree: p.linked,
  }
}

function summary(i: InboxItem): string {
  if (i.kind === 'question') return `question: ${clip(i.questions?.map((q) => q.question).join(' / ') ?? '', 200)}`
  const input = i.input ?? {}
  const what = String(input['command'] ?? input['file_path'] ?? input['url'] ?? '')
  return `permission for ${i.tool ?? 'a tool'}${what ? `: ${clip(what, 200)}` : ''}`
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

export type { Worktree }

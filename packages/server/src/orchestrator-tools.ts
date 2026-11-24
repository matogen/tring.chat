import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { DiffResult, InboxItem, ProjectInfo, SessionStatus } from '@tring/shared/protocol'
import { gitDiff } from './git-diff.ts'
import { cleanPrompt, typePrompt } from './type-prompt.ts'

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
 */

const run = promisify(execFile)

/** The slice of a Session the tools use, so tests can pass a stub. */
export interface ToolSession {
  id: string
  projectId: string
  slot: number
  name: string | null
  title: string | null
  cwd: string
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
  branch?: (cwd: string) => Promise<string | null>
  diff?: (cwd: string) => Promise<DiffResult>
  isDir?: (p: string) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Typing a prompt; replaced in tests so nothing waits on a timer. */
  type?: (s: ToolSession, text: string) => void
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
    description: 'Every project and terminal tile in tring: slot, name, status (busy = working, done = finished and waiting for the user, idle, exited), working directory, git branch, whether it runs Claude Code, what it is waiting on, and the last thing its agent said. Call this first to know what is going on.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Only this project (name or id).' } },
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
    description: 'The uncommitted git changes in a tile\'s working directory: files with lines added and removed, and the patch (all files, trimmed, or one file in full).',
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
    description: 'Start a new tile running Claude Code in the first empty slot of a project, optionally with a first prompt. Use it to start parallel work. The user sees the new tile in the ring.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id; default the project the user is viewing.' },
        cwd: { type: 'string', description: 'Working directory; default the project root. A path relative to the root is resolved against it.' },
        name: { type: 'string', description: 'A short tile name, e.g. "api tests".' },
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

/** SAFE flags as in git-diff.ts: a repository's config runs nothing here. */
export async function gitBranch(cwd: string): Promise<string | null> {
  const git = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await run('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', timeout: 3000 })
      return stdout.trim() || null
    } catch {
      return null
    }
  }
  // symbolic-ref also names a branch with no commits yet, where rev-parse fails.
  return await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    ?? (await git(['rev-parse', '--short', 'HEAD']) !== null ? '(detached)' : null)
}

async function isDirectory(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory() } catch { return false }
}

export class OrchestratorTools {
  constructor(private readonly d: ToolDeps) {}

  private get now(): number { return (this.d.now ?? Date.now)() }

  private sleep(ms: number): Promise<void> {
    return (this.d.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms)
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    switch (name) {
      case 'list_sessions': return this.listSessions(str(args['project']))
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

  private label(s: ToolSession): string {
    const project = this.d.pm.list().find((p) => p.id === s.projectId)
    return `${project?.name ?? 'project'}/${s.slot}${s.name ? ` (${s.name})` : ''}`
  }

  private waiting(s: ToolSession): InboxItem[] {
    return this.d.inbox.list().filter((i) => i.sessionId === s.id && i.kind !== 'reply')
  }

  private async listSessions(only: string | undefined): Promise<string> {
    let projects = this.d.pm.list()
    if (only) {
      const p = this.d.pm.findProject(only)
      if (!p) throw new ToolError(`no project ${only}; projects: ${projects.map((x) => x.name).join(', ')}`)
      projects = [p]
    }
    const branch = this.d.branch ?? gitBranch
    const out = await Promise.all(projects.map(async (p) => ({
      project: p.name,
      id: p.id,
      root: p.root,
      viewing: p.id === this.d.pm.activeProjectId,
      sessions: await Promise.all(p.sessions.map(async (info) => {
        const s = this.d.pm.findSession(info.id)
        const waiting = s ? this.waiting(s) : []
        return {
          ref: `${p.name}/${info.slot}`,
          id: info.id,
          slot: info.slot,
          name: info.name ?? info.title ?? null,
          status: info.status,
          cwd: info.cwd,
          branch: await branch(info.cwd),
          agent: s?.claude ? 'claude' : null,
          ...(waiting.length ? { waitingOnUser: waiting.map(summary) } : {}),
          ...(s?.lastMessage ? { lastMessage: clip(s.lastMessage, MAX_LAST_MESSAGE) } : {}),
        }
      })),
    })))
    return JSON.stringify({ projects: out }, null, 2)
  }

  private readSession(s: ToolSession, lines: number): string {
    const n = Math.max(1, Math.min(400, Math.floor(lines)))
    return `${this.label(s)} — ${s.tracker.status}, ${s.cwd}\n\n${s.recentText(n) || '(nothing on screen)'}`
  }

  private async changes(s: ToolSession, file: string | undefined): Promise<string> {
    const r = await (this.d.diff ?? gitDiff)(s.cwd)
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

  private sendPrompt(s: ToolSession, raw: string): string {
    const text = cleanPrompt(raw)
    if (!text) throw new ToolError('text is empty')
    const why = this.refusal(s)
    if (why) throw new ToolError(why)
    const busy = s.tracker.status === 'busy'
    this.deliver(s, text)
    return `Sent to ${this.label(s)}${busy ? ' (it was busy, so Claude Code queues it)' : ''}. Use wait_for with "${s.id}" for the answer.`
  }

  private async createSession(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const projectRef = str(args['project'])
    const project = projectRef
      ? this.d.pm.findProject(projectRef)
      : this.d.pm.list().find((p) => p.id === this.d.pm.activeProjectId) ?? this.d.pm.list()[0]
    if (!project) throw new ToolError(projectRef ? `no project ${projectRef}; see list_sessions` : 'there are no projects yet')
    const cwdArg = str(args['cwd'])
    const cwd = cwdArg ? path.resolve(project.root, cwdArg) : project.root
    if (!await (this.d.isDir ?? isDirectory)(cwd)) throw new ToolError(`${cwd} is not a directory`)

    let s: ToolSession | null
    try {
      s = this.d.pm.create(project.id, { cwd, command: 'claude', name: str(args['name']) ?? null })
    } catch (err) {
      throw new ToolError((err as Error).message)
    }
    if (!s) throw new ToolError('could not start a session')
    const started = `Started ${this.label(s)} (id ${s.id}) running claude in ${cwd}.`

    const prompt = cleanPrompt(String(args['prompt'] ?? ''))
    if (!prompt) return started
    const ready = await this.ready(s, signal)
    if (!ready) {
      return `${started} The first prompt was NOT sent: Claude Code did not report it was ready within ` +
        `${READY_TIMEOUT_MS / 1000}s (are tring's hooks installed?). Check with read_session, then use send_prompt.`
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

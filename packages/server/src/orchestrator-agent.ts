import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import type { AgentInfo } from '@tring/shared/protocol'
import { claudeConversation, Session, type ClaudeConversation } from './session.ts'

/**
 * The orchestrator agent: a Claude Code session of its own, in the centre of
 * orchestrator mode, that you type to instead of to each tile.
 *
 * It is not in any project's ring. It runs in a workspace directory tring
 * owns (`~/.config/tring/orchestrator`), with the `tring` MCP server (see
 * mcp-cli.ts and orchestrator-tools.ts) so it can see every tile — status,
 * branch, screen, changes — prompt the agents in them, and start new ones.
 *
 * Off by default. Off, nothing here runs, and orchestrator mode is the inbox
 * it always was.
 */

/** Tools Claude Code may call without asking: reading, and talking to agents. */
export const PRE_ALLOWED = ['list_sessions', 'list_worktrees', 'find_work', 'session_history', 'read_session', 'session_changes', 'send_prompt', 'wait_for']
  .map((t) => `mcp__tring__${t}`)

/** With the multi-PR workflow on, reading tickets needs no asking either. */
export const TICKET_PRE_ALLOWED = ['list_tickets', 'ticket_status'].map((t) => `mcp__tring__${t}`)

/**
 * The orchestrator allocates work and looks things up. It never does the work:
 * caught testing in the browser itself after "use the browser to test", in
 * auto mode, where nothing asked first. Instructions alone did not hold, so
 * the tools that do work are taken away here, in the workspace settings tring
 * rewrites on every start — a deny holds whatever mode the session is in.
 *
 * Its shell is not denied: lookups the user allows (a ticket tool) need it.
 * Instead the workspace runs in the default permission mode, so any command
 * not allowed in `.claude/settings.local.json` — the user's file — asks first.
 */
export const DENIED = [
  // Changing files is the tiles' job. (No MultiEdit: Claude Code 2.1 warns it
  // matches no tool, and Edit covers it.)
  'Edit', 'Write', 'NotebookEdit',
  // So is testing in a browser.
  'mcp__claude-in-chrome', 'mcp__computer-use', 'mcp__Claude_Browser',
  // Research and subagents would be work done here rather than in a tile.
  'WebFetch', 'WebSearch', 'Agent', 'Task',
]

/** An exit this soon after a resume is a conversation that no longer exists. */
const RESUME_FAIL_MS = 10_000

export interface AgentOptions {
  /** The workspace directory; also where the conversation's transcripts are filed. */
  dir: string
  /** Where the on/off switch and the conversation id are kept. */
  statePath: string
  url: string
  token: string | null
  scrollback: number
  idleMs: number
  shell?: string
  /** The MCP relay to run (tring-mcp.js, or mcp-cli.ts in a checkout); null when missing. */
  mcpScript: string | null
  /** The Node that runs it: the daemon's own. */
  node: string
  /** Builds the session; replaced in tests so nothing spawns. */
  spawn?: (opts: ConstructorParameters<typeof Session>[0]) => Session
  /** Whether the multi-PR workflow is on: its instructions and tools are added only then. */
  multiPr?: () => boolean
}

interface Saved {
  enabled?: boolean
  claude?: ClaudeConversation | null
}

export class OrchestratorAgent {
  private on = false
  private conversation: ClaudeConversation | null = null
  private current: Session | null = null
  private startedAt = 0
  private error: string | null = null
  private timer: NodeJS.Timeout | null = null

  onChange: (() => void) | null = null
  onData: ((s: Session, data: string) => void) | null = null

  constructor(private readonly opts: AgentOptions) {}

  get enabled(): boolean {
    return this.on
  }

  get session(): Session | null {
    return this.current
  }

  /** The agent's session, if `id` is it. */
  find(id: string): Session | undefined {
    return this.current && this.current.id === id ? this.current : undefined
  }

  info(): AgentInfo {
    return {
      enabled: this.on,
      id: this.current?.id ?? null,
      status: this.current?.tracker.status ?? null,
      error: this.error,
    }
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.opts.statePath, 'utf8')) as Saved
      this.on = raw.enabled === true
      this.conversation = claudeConversation(raw.claude)
    } catch {
      this.on = false
    }
    if (this.on) await this.start()
  }

  async setEnabled(on: boolean): Promise<void> {
    if (on === this.on) return
    this.on = on
    if (on) await this.start()
    else this.stop()
    await this.save()
    this.onChange?.()
  }

  /** A fresh conversation, or the same one again after Claude was quit. */
  async restart(fresh: boolean): Promise<void> {
    if (!this.on) return
    if (fresh) this.conversation = null
    this.stop()
    await this.start()
    await this.save()
    this.onChange?.()
  }

  dispose(): void {
    this.stop()
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.current?.dispose()
    this.current = null
  }

  private async start(): Promise<void> {
    if (this.current) return
    this.error = null
    if (!this.opts.mcpScript) {
      this.error = 'the tring MCP relay is missing from this install, so the agent would have no tools'
      this.onChange?.()
      return
    }
    try {
      await this.writeWorkspace()
    } catch (err) {
      this.error = `cannot write ${this.opts.dir}: ${(err as Error).message}`
      this.onChange?.()
      return
    }
    // Only fixed words and a UUID go into the command: the workspace is the
    // cwd, so no path needs quoting for whichever shell this is.
    const resume = this.conversation ? ` --resume ${this.conversation.id}` : ''
    // --strict-mcp-config: tring's server and no other. The user's own
    // connectors (deploys, mail, browsers) are for the tiles, not for this.
    const command = `claude --strict-mcp-config --mcp-config tring-mcp.json${resume}`
    const s = (this.opts.spawn ?? ((o) => new Session(o)))({
      id: randomUUID(),
      projectId: '',
      projectName: 'orchestrator',
      slot: 0,
      cwd: this.opts.dir,
      command,
      name: 'Orchestrator',
      url: this.opts.url,
      token: this.opts.token,
      scrollback: this.opts.scrollback,
      idleMs: this.opts.idleMs,
      ...(this.opts.shell ? { shell: this.opts.shell } : {}),
      autorun: true,
    })
    this.current = s
    this.startedAt = Date.now()
    // Not in any project, so no ProjectManager ticks it; busy/done need the clock.
    this.timer = setInterval(() => s.tick(Date.now()), 500)
    this.timer.unref?.()
    s.onData = (data) => this.onData?.(s, data)
    s.onStatusChange = () => this.onChange?.()
    s.onClaudeChange = () => {
      if (s.claude) this.conversation = s.claude
      void this.save()
    }
    s.onExit = () => {
      // `--resume` of a conversation that is gone exits at once. Start over
      // with a fresh one rather than leave a dead centre every time.
      if (resume && Date.now() - this.startedAt < RESUME_FAIL_MS && this.current === s) {
        this.conversation = null
        this.stop()
        void this.start().then(() => this.save()).then(() => this.onChange?.())
        return
      }
      this.onChange?.()
    }
    this.onChange?.()
  }

  private async save(): Promise<void> {
    try {
      await mkdir(path.dirname(this.opts.statePath), { recursive: true })
      const saved: Saved = { enabled: this.on, claude: this.conversation }
      await writeFile(this.opts.statePath, JSON.stringify(saved, null, 2) + '\n', 'utf8')
    } catch {
      // The switch still works for this run; it just will not be remembered.
    }
  }

  /**
   * Rewritten on every start, so an upgrade brings new instructions and a
   * moved Node with it. CLAUDE.md is the user's: written once, and it only
   * imports TRING.md, so anything they add there survives.
   */
  private async writeWorkspace(): Promise<void> {
    const dir = this.opts.dir
    await mkdir(path.join(dir, '.claude'), { recursive: true })
    const tokenFile = path.join(dir, '.token')
    if (this.opts.token) {
      await writeFile(tokenFile, `${this.opts.token}\n`, { mode: 0o600 })
      await chmod(tokenFile, 0o600).catch(() => { /* Windows has no mode */ })
    }
    const script = this.opts.mcpScript!
    const nodeArgs = script.endsWith('.ts') ? ['--experimental-strip-types', '--no-warnings'] : []
    const mcp = {
      mcpServers: {
        tring: {
          type: 'stdio',
          command: this.opts.node,
          args: [...nodeArgs, script, '--url', this.opts.url, ...(this.opts.token ? ['--token-file', tokenFile] : [])],
        },
      },
    }
    await writeFile(path.join(dir, 'tring-mcp.json'), JSON.stringify(mcp, null, 2) + '\n', 'utf8')
    const multiPr = this.opts.multiPr?.() ?? false
    await writeFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify(workspaceSettings(multiPr), null, 2) + '\n', 'utf8')
    await writeFile(path.join(dir, 'TRING.md'), multiPr ? INSTRUCTIONS + TICKET_INSTRUCTIONS : INSTRUCTIONS, 'utf8')
    const claudeMd = path.join(dir, 'CLAUDE.md')
    try {
      await access(claudeMd)
    } catch {
      await writeFile(claudeMd, '@TRING.md\n\n# Your own instructions for the orchestrator go below.\n', 'utf8')
    }
  }
}

/**
 * The orchestrator workspace's `.claude/settings.json`. The default mode beats
 * a global auto mode (project settings win over user settings), so anything
 * neither allowed here nor in the user's settings.local.json asks first.
 */
export function workspaceSettings(multiPr = false): Record<string, unknown> {
  return { permissions: { defaultMode: 'default', allow: multiPr ? [...PRE_ALLOWED, ...TICKET_PRE_ALLOWED] : PRE_ALLOWED, deny: DENIED } }
}

/** Added to TRING.md while the multi-PR workflow is on. */
export const TICKET_INSTRUCTIONS = `
## Tickets: the multi-PR workflow (on)

When the user says "work on ticket X" (or describes a feature or bug fix to
build that way), it becomes a ticket of its own:

1. Get the ticket's text. Look it up with the lookups the user allows (their
   ticket skill, e.g. goby); if none works, ask them to paste it. Never create,
   edit or comment on tickets in their tracker: tring keeps its own.
2. Work out which local repositories it touches, from the ticket and the
   user's repository list (in their CLAUDE.md). Ask when unsure; never search
   the disk.
3. \`start_ticket\` with the key, title, full text, source and repos. tring
   opens a tab with a planner agent; the user approves the plan on a card,
   choosing how it lands: independent PRs, stacked PRs or a single PR (the
   planner recommends one). If they tell you instead, \`ticket_action\`
   "approve" with that \`strategy\` (and \`combined\` for independent PRs
   through one final PR).

After that the ticket runs itself: tring starts, sequences, reviews and
restacks its agents. Do not \`send_prompt\` to a ticket's tiles (it is
refused); pass the user's words on with \`ticket_action\` "tell". When the
user answers a ticket's card by talking to you ("approve the plan", "skip that
one, it's intended"), use \`ticket_action\`. Report from \`ticket_status\`.
`

export const INSTRUCTIONS = `# You are the tring orchestrator

The user runs many terminal tiles in tring, most of them Claude Code agents,
each in its own slot of a project. You sit in the centre of tring's
orchestrator mode: the user talks to you instead of typing into each tile, and
you get the work done through the agents in those tiles.

## Your tools (the \`tring\` MCP server)

- \`list_sessions\` — every project and tile: status (busy = working, done =
  finished and waiting, idle, exited), the directory its agent works in, its
  repository, worktree and branch, the repositories its agent has edited in
  (\`workedIn\`), whether it runs Claude Code, what it is waiting on, and what
  its agent last said. \`sameWorktreeAs\` marks tiles sharing a worktree.
  Start here whenever you need to know what is going on.
- \`list_worktrees\` — every worktree of each repository, its branch, and
  which tiles are in it. Free worktrees are the ones with no tiles.
- \`find_work\` — which tiles have been working on a topic, ranked: by name,
  branch, conversation title, the prompts they were given, what their agent
  said and the files they edited.
- \`session_history\` — a tile's conversation: prompts, answers, edited files.
- \`read_session\` — the last lines of a tile's terminal.
- \`session_changes\` — the uncommitted git changes in a tile's worktree.
- \`send_prompt\` — give an agent an instruction, as if the user typed it.
- \`create_session\` — start a new Claude Code tile, optionally with a first
  prompt, and with \`branch\` in its own git worktree. The user approves each one.
- \`wait_for\` — wait until tiles finish, then read what they said.

Refer to tiles the way the user does: by project and slot (\`tring.chat/3\`),
or by name. A bare slot number means the project the user is looking at.

## You never do the work yourself

You do two things: allocate work to the agents in the tiles, and look things
up (the tiles, and tickets with the lookup tools the user allows). Everything
else is a tile's job, even when the user's words sound like an order to you:

- "Test it", "use the browser to test", "run the tests", "check it on the test
  site": choose the tile that owns that work and \`send_prompt\` it the
  instruction, with what you know (URL, ticket, what to check). Then
  \`wait_for\` it and report.
- Editing files, running builds or tests, browsing, deploying, investigating
  code or logs: the same. Never do them here, even if a tool would let you.
  Editing and browser tools are switched off in this workspace for that reason.
- If no tile fits, offer to start one (\`create_session\`) rather than doing it.
- Your shell is for ticket lookups only. A command that would change or
  test anything is never yours to run; send it to a tile.

## How to work

- Delegate. You coordinate; the agents in the tiles do the coding, in their
  own repositories.
- The agents cannot see this conversation. Every prompt you send must stand
  on its own: the goal, the context they need, and what "done" looks like.
- Pick the tile whose directory and branch fit the task. If none fits, or the
  work should run in parallel, offer to start a new tile.
- After sending work, use \`wait_for\` and report back what each agent did, in
  a few lines. Quote them when it matters; never claim work an agent has not
  reported.
- Permission prompts and questions from the agents are the user's to answer
  in tring's inbox, beside you. If a tile is waiting on one, say so; do not
  try to answer it by typing into that tile (send_prompt refuses anyway).
- Keep replies short and scannable. The user is juggling many sessions.

## Which tile? Route by what each one has been doing

The user talks about work, not slots: "make the reporting box green". Send it
to the agent that has been working on that, which already has the context.

1. Call \`find_work\` with the user's words. \`list_sessions\` also shows each
   tile's conversation title and recent prompts.
2. One clear best match: confirm with \`session_history\` (\`search\` for the
   topic) when the match is thin, then send it there and tell the user which
   tile you chose and why, in one line.
3. Several match about equally, or none does: do not guess. Ask the user,
   naming the candidates (slot, name, branch), or offer to start a new tile
   in its own worktree for it.
4. A clear match that is busy, waiting on the user, or exited: say so, and ask
   whether to queue it there or start a new tile.

A tile's directory is where its shell started, not what it works on. A Claude
started in the home directory may spend all day editing one repository:
\`workedIn\` in \`list_sessions\` lists the repositories its agent has really
edited and read in. When the user names an app or repository ("edit tring"),
look there and in \`find_work\`, not only at directories and branches.

Never search the disk for a repository (no recursive listings of drives or
home folders): it is slow and the user has to stop it. If the tools do not
show it, ask the user for the path.

## Git worktrees

The user works in git worktrees: one branch, one worktree, one agent. Treat
that as a rule, not a preference.

- Know where each agent is before you give it work: its \`git.branch\` and
  \`git.worktree\` in \`list_sessions\`, not just the tile's name. An agent can
  move into a worktree after its tile started; the tools follow it there.
- Never give two agents work in the same worktree at once; they would edit the
  same files. If \`sameWorktreeAs\` shows a clash, tell the user.
- New parallel work gets its own worktree: \`create_session\` with a
  \`branch\` (and \`base\` when it should not start from the current HEAD).
  If a worktree already has that branch, it is reused, not duplicated.
- Name branches the way the user's existing branches are named (look at
  \`list_worktrees\`), e.g. with their ticket number when they use one.
- Say which branch and worktree each piece of work is on when you report back.
- Do not remove worktrees, delete branches, merge or push unless the user asks;
  when they do, have the agent in that worktree do it.
`

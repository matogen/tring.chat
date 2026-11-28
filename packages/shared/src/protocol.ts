/** WebSocket and REST payloads shared by both sides (spec §4.4, §4.5). */

import type { SessionStatus } from './status.ts'
import type { TicketView } from './workflow.ts'

export type { SessionStatus }

export const DEFAULT_PORT = 7331
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_SCROLLBACK = 5000

/** One run of cells sharing the same attributes, for cheap thumbnails. */
export interface SnapshotCell {
  text: string
  fg: number
  bg: number
  bold: boolean
}

export interface ScreenSnapshot {
  cols: number
  rows: SnapshotCell[][]
}

export interface SessionInfo {
  id: string
  projectId: string
  slot: number
  name: string | null
  title: string | null
  cwd: string
  /** Kept so the tile can offer a re-run; never executed automatically. */
  command: string | null
  /** User-assigned tile tint as `#rrggbb`, or null. Never a status colour. */
  color: string | null
  status: SessionStatus
  since: number
  exitCode: number | null
}

export interface ProjectInfo {
  id: string
  name: string
  root: string
  sessions: SessionInfo[]
}

export interface UpdateInfo {
  current: string
  latest: string
}

export type ClientMessage =
  | { type: 'hello'; token?: string }
  | { type: 'focus'; id: string | null; cols: number; rows: number }
  | { type: 'input'; id: string; data: string }
  /**
   * This client's terminal size for its focused session. `claim` takes the
   * PTY's size for this device (a click, a keystroke-free focus, a window
   * resize); without it the size is only recorded unless this client already
   * owns it. See size-owner.ts on the server.
   */
  | { type: 'resize'; cols: number; rows: number; claim?: boolean }
  | { type: 'create'; projectId?: string; slot?: number; cwd: string; command?: string; name?: string }
  | { type: 'kill'; id: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'color'; id: string; color: string | null }
  /** Into `slot`, swapping with any session already there. */
  | { type: 'move'; id: string; slot: number }
  | { type: 'ack'; id: string }
  | { type: 'respawn'; id: string }
  | { type: 'activateProject'; projectId: string }
  | { type: 'createProject'; name: string; root: string }
  | { type: 'renameProject'; projectId: string; name: string }
  | { type: 'deleteProject'; projectId: string }
  /** Settles a permission or question card in the orchestrator inbox. */
  | {
      type: 'answer'
      itemId: string
      decision: InboxDecision
      /** Question text -> chosen label(s), comma-joined for multi-select. */
      answers?: Record<string, string>
      /** Shown to the agent with a deny. */
      message?: string
    }
  /** A button on a multi-PR workflow card, with the words or number it asked for. */
  /** value: a number (the agents slider) or a choice (the strategy picker). */
  | { type: 'action'; itemId: string; actionId: string; text?: string; value?: number | string }
  /** Types a follow-up prompt into a session that finished and is waiting. */
  | { type: 'reply'; itemId: string; text: string }
  /** Turns the supervisor that approves routine permission prompts on or off. */
  | { type: 'autoAnswer'; enabled: boolean }
  /**
   * The orchestrator agent: switch it on or off, or start its Claude again —
   * in the same conversation after it was quit, or in a fresh one.
   */
  | { type: 'agent'; enabled?: boolean; restart?: 'resume' | 'fresh' }
  /**
   * Whether this screen has tring in front of someone: visible, and touched
   * in the last couple of minutes. Repeated while true, so a screen that goes
   * quiet without saying so expires. Phone notifications wait for nobody.
   */
  | { type: 'presence'; active: boolean }

export type ServerMessage =
  | {
      type: 'state'
      projects: ProjectInfo[]
      activeProjectId: string | null
      update?: UpdateInfo | null
      /** The multi-PR workflow's tickets, for tab badges and stack rails; absent while it has none. */
      tickets?: TicketView[]
    }
  | {
      type: 'status'
      id: string
      status: SessionStatus
      since: number
      title: string | null
      /** Whether this `done` is confident enough to announce out loud. */
      notable?: boolean
    }
  | { type: 'screen'; id: string; ansi: string }
  /**
   * The PTY's size for a session this client is watching. `mine` is true when
   * this client owns it; otherwise another device does, and this client draws
   * at exactly `cols`×`rows` until it claims the size back.
   */
  | { type: 'size'; id: string; cols: number; rows: number; mine: boolean }
  | { type: 'snapshot'; id: string; snapshot: ScreenSnapshot }
  | { type: 'exit'; id: string; code: number }
  | { type: 'error'; message: string }
  /** Every open card, oldest first, whenever the set changes. */
  | { type: 'inbox'; items: InboxItem[] }
  /** The supervisor's switch and what it decided, newest first. */
  | { type: 'autoAnswer'; enabled: boolean; history: AutoDecision[] }
  /** The orchestrator agent's switch and session, whenever either changes. */
  | { type: 'agent'; agent: AgentInfo }

/**
 * Output travels as a binary frame — a UTF-8 session id, a 0x00 separator,
 * then raw PTY bytes — so the hot path never JSON-encodes terminal data.
 */
export function encodeOutput(id: string, data: Buffer | Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(id + '\0')
  const out = new Uint8Array(head.length + data.length)
  out.set(head, 0)
  out.set(data, head.length)
  return out
}

export function decodeOutput(frame: Uint8Array): { id: string; data: Uint8Array } | null {
  const sep = frame.indexOf(0)
  if (sep < 0) return null
  return {
    id: new TextDecoder().decode(frame.subarray(0, sep)),
    data: frame.subarray(sep + 1),
  }
}

/** One file in a session's uncommitted changes (GET /api/sessions/:id/diff). */
export interface DiffFile {
  /** Relative to the repository root. */
  path: string
  added: number
  removed: number
  /** Unified hunks from the first `@@` on; empty when `note` is set. */
  patch: string
  /** Shown instead of the patch: 'binary', 'too large', 'not a regular file'. */
  note?: string
}

export type DiffResult =
  | { cwd: string; files: DiffFile[]; truncated: boolean }
  | { cwd: string; error: string }

/**
 * Orchestrator mode: what the agents in other sessions are asking.
 *
 * Cards come from Claude Code hooks, never from reading the screen — the
 * hook payload says exactly which tool and which input, where a scraped
 * prompt is a guess that breaks with every TUI redesign.
 */
export type InboxKind = 'permission' | 'question' | 'reply' | 'workflow' | 'feature'

/**
 * A button on a multi-PR workflow card. Its answer goes to the stack engine
 * (an `action` message), never into a tile.
 */
export interface InboxAction {
  id: string
  label: string
  primary?: boolean
  /** Asks for words first: a reason to skip, the changes wanted. */
  needsText?: boolean
  /** Asks for a number first: the agents slider. */
  needsValue?: { min: number; max: number; value: number }
  /**
   * A choice shown above the buttons and sent with this one as its value:
   * the plan card's strategy picker. `misfit`: why the plan does not fit it as
   * it is (picking it re-plans); `note`: what it would mean.
   */
  choices?: Array<{ value: string; label: string; recommended?: boolean; note?: string; misfit?: string | null }>
  /** The choice pre-selected. */
  selected?: string
  /** A checkbox shown with one choice, sent as `<value>:<id>` when ticked: the final combined PR, with independent PRs. */
  option?: { id: string; label: string; for: string; checked: boolean }
}

/** `terminal` hands the prompt back to the session's own TUI unanswered. */
export type InboxDecision = 'allow' | 'deny' | 'terminal'

export interface InboxOption {
  label: string
  description?: string
}

/** One question from Claude Code's AskUserQuestion tool. */
export interface InboxQuestion {
  question: string
  header?: string
  options: InboxOption[]
  multiSelect?: boolean
}

export interface InboxItem {
  id: string
  sessionId: string
  kind: InboxKind
  createdAt: number
  /** permission: the tool asking, e.g. "Bash", "Edit", "mcp__github__create_pr". */
  tool?: string
  /** permission: the tool's input as the agent sent it. Untrusted text. */
  input?: Record<string, unknown>
  /** question: what AskUserQuestion is asking. */
  questions?: InboxQuestion[]
  /** reply: the agent's last message before it stopped. */
  message?: string
  /**
   * reply: a permission prompt or question that tring restarted in the middle
   * of. Its hook died with the old daemon, so it can no longer be answered as
   * one; the agent reopens waiting for a prompt, and `message` says what it
   * was asking.
   */
  interrupted?: 'permission' | 'question'
  /** workflow, feature: the ticket it is about. Its body is `message`, as markdown. */
  ticketId?: string
  /** workflow, feature: the card's heading. */
  title?: string
  /** workflow, feature: its buttons. */
  actions?: InboxAction[]
  /** workflow: the PR it is about. */
  prIndex?: number
}

/**
 * The orchestrator agent: a Claude Code session of its own, outside every
 * ring, that you type to and that drives the tiles through tring's MCP tools.
 * Its terminal is addressed by `id` like any session's (focus, input, resize).
 */
export interface AgentInfo {
  enabled: boolean
  /** Null while it is off, or could not start. */
  id: string | null
  status: SessionStatus | null
  /** Why it could not start, in words for the user. */
  error: string | null
}

/** One permission prompt the supervisor looked at. */
export interface AutoDecision {
  at: number
  sessionId: string
  tool: string
  /** The command, path or URL, cut short. Untrusted text. */
  what: string
  /** `allow` was approved for you; `ask` was left in the inbox. */
  verdict: 'allow' | 'ask'
  reason: string
}

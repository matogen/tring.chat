/** WebSocket and REST payloads shared by both sides (spec §4.4, §4.5). */

import type { SessionStatus } from './status.ts'

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
  | { type: 'resize'; cols: number; rows: number }
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
  /** Types a follow-up prompt into a session that finished and is waiting. */
  | { type: 'reply'; itemId: string; text: string }

export type ServerMessage =
  | {
      type: 'state'
      projects: ProjectInfo[]
      activeProjectId: string | null
      update?: UpdateInfo | null
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
  | { type: 'snapshot'; id: string; snapshot: ScreenSnapshot }
  | { type: 'exit'; id: string; code: number }
  | { type: 'error'; message: string }
  /** Every open card, oldest first, whenever the set changes. */
  | { type: 'inbox'; items: InboxItem[] }

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
export type InboxKind = 'permission' | 'question' | 'reply'

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
}

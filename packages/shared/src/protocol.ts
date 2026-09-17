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

/**
 * What a Browser Agent tile runs by default (spec §4.8).
 *
 * A default, not a hardcode: it lands in the dialog's Command field where it can
 * be read and edited, so §2's "tool-agnostic — Claude Code gets optional extras,
 * never a dependency" still holds. Someone running a different agent types over
 * it. Without it, a Browser Agent tile is a plain shell beside a page nothing is
 * driving, which is the one thing the choice promises not to be.
 *
 * Pass null where a session's PATH carries the shim (§4.8), which is the normal
 * case: the flag is already added by the time claude starts, and a command with
 * it spelled out would be a second, worse way to get the same tools — one that
 * goes stale, and one a user copies into a shell where it does not work. The
 * spelled-out form is the fallback for a platform with no shim, where
 * `$TRING_MCP_CONFIG` on the command line is the only route left.
 */
export function browserAgentCommand(mcpConfigRef: string | null): string {
  const base = mcpConfigRef ? `claude --mcp-config ${mcpConfigRef}` : 'claude'
  return `${base} --permission-mode auto`
}

/**
 * Why the default starts in auto mode.
 *
 * A Browser Agent tile is chosen by someone who wants a page driven, and every
 * step of driving it is a tool call. In manual mode the agent stops on the first
 * one and the tile sits there needing a human for the thing the human just asked
 * for — the failure §4.7 spends its whole design avoiding, arriving immediately
 * and for no reason. Auto rather than `bypassPermissions`: the classifier still
 * stops the destructive cases, and the human still has the wheel (§5.13).
 *
 * It is on the *default command*, not on the shim, because the shim owns the
 * name `claude` everywhere in tring. A Terminal tile is not a place to quietly
 * change what typing `claude` does — this is a field in a dialog the user opened.
 */

/** Who may act on a session's page right now (spec §4.7). */
export type BrowserControlHolder = 'agent' | 'human'

/**
 * A session's attached browser, or null when it has none (spec §4.7).
 *
 * Deliberately not a `kind: 'shell' | 'browser'` enum on the session. A session
 * is always a shell and may *additionally* own a page — the browser attaches to
 * a running PTY and detaches without killing it, which is the whole reason the
 * choice can be offered on a tile that is already working. An enum would
 * describe a thing that replaces the shell, which is not what this is.
 */
export interface BrowserInfo {
  url: string
  title: string | null
  control: BrowserControlHolder
  loading: boolean
  /**
   * The page's own viewport, in CSS pixels.
   *
   * Needed because frames are letterboxed: a screencast is scaled to fit the
   * size the viewer asked for, so a click at some point on the canvas has to be
   * mapped back through that scale before it means anything to the page. The
   * viewport is deliberately *not* resized to match the pane — a divider drag
   * would otherwise reflow the page under an agent mid-action.
   */
  viewport: { width: number; height: number }
  /**
   * What the agent is parked on — a selector it is waiting for, or a dialog it
   * cannot dismiss. Set when a human is probably needed (a login form, a
   * captcha), which is an explicit signal rather than the idle guess a shell
   * has to make.
   */
  blockedOn: string | null
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
  /** The attached page, or null. See BrowserInfo on why this is not a `kind`. */
  browser: BrowserInfo | null
}

/**
 * Whether browser agents can be used, asked for, or neither (spec §4.7).
 *
 * Three states because the middle one is real: Chromium is ~150MB and is not
 * an npm dependency, so "installed but off" and "not installed" need different
 * controls — a checkbox and a download button.
 */
export type BrowserCapability = 'unavailable' | 'off' | 'on'

export interface Capabilities {
  browser: BrowserCapability
  /**
   * The command a Browser Agent tile offers, built by the daemon because only
   * it knows which shell it spawns and therefore how to spell `$VAR`.
   */
  browserAgentCommand?: string
}

export interface ProjectInfo {
  id: string
  name: string
  root: string
  sessions: SessionInfo[]
  /** Host patterns this project's pages may navigate to (spec §4.7). */
  browserAllow?: string[]
}

export interface UpdateInfo {
  current: string
  latest: string
}

/**
 * One input event for an attached page (spec §4.4).
 *
 * Normalised by the client rather than forwarded as a raw DOM event: the
 * daemon hands these to CDP, and a shape the daemon defines is a shape the
 * daemon can validate. Coordinates are in CSS pixels within the page viewport.
 */
export type BrowserInputEvent =
  | { kind: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clicks?: number }
  | { kind: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { kind: 'key'; action: 'down' | 'up'; key: string; code: string; text?: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }

export type BrowserNavigation = string | 'back' | 'forward' | 'reload'

export type ClientMessage =
  | { type: 'hello'; token?: string }
  | { type: 'focus'; id: string | null; cols: number; rows: number }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'create'; projectId?: string; slot?: number; cwd: string; command?: string; name?: string; browser?: boolean; url?: string }
  | { type: 'attachBrowser'; id: string; url?: string }
  | { type: 'detachBrowser'; id: string }
  | { type: 'browserInput'; id: string; event: BrowserInputEvent }
  | { type: 'browserGrab'; id: string }
  | { type: 'browserRelease'; id: string }
  | { type: 'browserNavigate'; id: string; to: BrowserNavigation }
  | { type: 'browserView'; id: string; width: number; height: number }
  /**
   * Per-project browser settings. On the daemon rather than in localStorage
   * because enabling this spawns a process and stores cookies (spec §5.7).
   */
  | { type: 'projectBrowser'; projectId: string; enabled?: boolean; allow?: string[]; eval?: boolean }
  | { type: 'kill'; id: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'color'; id: string; color: string | null }
  | { type: 'ack'; id: string }
  | { type: 'respawn'; id: string }
  | { type: 'activateProject'; projectId: string }
  | { type: 'createProject'; name: string; root: string }
  | { type: 'renameProject'; projectId: string; name: string }
  | { type: 'deleteProject'; projectId: string }

export type ServerMessage =
  | {
      type: 'state'
      projects: ProjectInfo[]
      activeProjectId: string | null
      update?: UpdateInfo | null
      /**
       * Inlined rather than left to `GET /api/capabilities` alone: the UI needs
       * this before it draws its first tile, and a second round trip would make
       * the Terminal/Browser Agent control flicker into existence.
       */
      capabilities?: Capabilities
    }
  | { type: 'browser'; id: string; browser: BrowserInfo | null }
  | {
      type: 'browserPrompt'
      id: string
      /** A navigation held because the allowlist does not cover it (spec §4.7). */
      url: string
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

/** Raw PTY bytes. */
export const CHANNEL_PTY = 0x00
/** One JPEG screencast frame from an attached page (spec §4.7). */
export const CHANNEL_FRAME = 0x01

export type Channel = typeof CHANNEL_PTY | typeof CHANNEL_FRAME

/**
 * Binary frame layout: a UTF-8 session id, a 0x00 separator, a one-byte
 * channel tag, then the payload. The hot path never JSON-encodes terminal
 * data, and screencast JPEGs ride the same socket rather than opening a
 * second one.
 *
 * The tag is a real byte on the wire rather than something inferred from the
 * payload, so a JPEG that happens to start with printable bytes can never be
 * written into a terminal. Both halves of the app are built and shipped from
 * this package together, so there is no version in which one side writes the
 * tag and the other does not expect it.
 */
export function encodeBinary(id: string, channel: Channel, data: Buffer | Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(id + '\0')
  const out = new Uint8Array(head.length + 1 + data.length)
  out.set(head, 0)
  out[head.length] = channel
  out.set(data, head.length + 1)
  return out
}

export function decodeBinary(
  frame: Uint8Array,
): { id: string; channel: number; data: Uint8Array } | null {
  const sep = frame.indexOf(0)
  // A frame with no separator, or one that ends at the separator, carries no
  // channel byte and cannot be routed. Dropping it beats guessing PTY.
  if (sep < 0 || sep + 1 >= frame.length) return null
  return {
    id: new TextDecoder().decode(frame.subarray(0, sep)),
    channel: frame[sep + 1]!,
    data: frame.subarray(sep + 2),
  }
}

/** PTY output, the overwhelmingly common case. */
export function encodeOutput(id: string, data: Buffer | Uint8Array): Uint8Array {
  return encodeBinary(id, CHANNEL_PTY, data)
}

export function decodeOutput(frame: Uint8Array): { id: string; channel: number; data: Uint8Array } | null {
  return decodeBinary(frame)
}

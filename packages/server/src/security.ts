import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/**
 * Who is allowed to talk to the daemon, and what every response admits to.
 *
 * The daemon spawns shells, so "listens on 127.0.0.1" is not the boundary it
 * looks like. The same-origin policy does not gate WebSockets: any page the
 * user happens to have open can `new WebSocket('ws://127.0.0.1:7331')` and
 * start typing into a terminal, with no preflight to stop it. Loopback keeps
 * other *machines* out; the Origin check here is what keeps other *websites*
 * out, and it is the only thing doing so in the default no-token setup.
 */

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i

/** `[::1]:7331` and `127.0.0.1:7331` both have to lose their port. */
export function hostname(host: string): string {
  return (/^(\[[^\]]*\]|[^:]*)/.exec(host)?.[1] ?? host).toLowerCase()
}

/**
 * Whether a bind address only ever accepts connections from this machine.
 *
 * Takes the address as given to --host rather than a Host header, so no port
 * is stripped: `::1` is a bind address, `[::1]:7331` is not.
 */
export function isLoopbackBind(host: string | null | undefined): boolean {
  return !host || LOOPBACK.test(host)
}

/**
 * A daemon reachable from other machines needs a secret; loopback does not.
 *
 * The Origin check cannot stand in for one here. Bound past loopback the
 * hostname is the user's own and unguessable to us, so Host is unpinned — and
 * a rebound domain then supplies a Host *and* an Origin that agree with each
 * other. On loopback the name itself is the tell; off it, only the token is.
 */
export function bindNeedsToken(
  host: string | null | undefined,
  token: string | null | undefined,
): boolean {
  return !isLoopbackBind(host) && !token
}

/** The `host:port` an Origin denotes, or null if it is not one we can trust. */
function originHost(origin: string): string | null {
  try {
    const u = new URL(origin)
    // A sandboxed frame or a file:// page sends `Origin: null`, which throws
    // above; anything that parses but is not http(s) is not the deck either.
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host.toLowerCase() : null
  } catch {
    return null
  }
}

export type OriginCheck = (req: IncomingMessage) => boolean

export interface OriginOptions {
  /** The address passed to --host. Loopback means Host is pinned as well. */
  host?: string | null
  /** Origins allowed verbatim — the Vite dev server in a dev checkout. */
  allow?: readonly string[]
}

export function createOriginCheck(opts: OriginOptions = {}): OriginCheck {
  const allow = new Set(
    (opts.allow ?? [])
      .map((o) => originHost(o.trim()))
      .filter((o): o is string => o !== null),
  )
  // Bound to loopback, the only names that resolve here are loopback names, so
  // a Host header that is anything else is a domain an attacker rebound to
  // 127.0.0.1 rather than a way the user actually reaches the deck. Bound
  // anywhere else the hostname is the user's own and we cannot guess it.
  const pinned = isLoopbackBind(opts.host)

  return function sameOrigin(req: IncomingMessage): boolean {
    const host = req.headers.host?.toLowerCase()
    if (pinned && (!host || !LOOPBACK.test(hostname(host)))) return false

    const origin = req.headers.origin
    // curl, the Claude Code hooks and every other non-browser client send no
    // Origin at all. A browser always sends one when it is off-origin, so an
    // absent header is never the attacking page this check exists for.
    if (!origin) return true

    const from = originHost(origin)
    return from !== null && (from === host || allow.has(from))
  }
}

/**
 * The same check in the shape `ws` wants on the upgrade — sync, boolean.
 *
 * Refusing here rather than inside Hub means a disallowed origin never gets a
 * socket at all, so there is no `hello` to get wrong later.
 */
export const upgradeGuard = (check: OriginCheck) =>
  ({ req }: { req: IncomingMessage }): boolean => check(req)

/**
 * Constant-time secret comparison, blind to length as well as to content.
 *
 * `!==` short-circuits on the first differing byte, which over a network path
 * is a (slow, but real) oracle for recovering the token a byte at a time.
 * Comparing digests rather than the raw strings keeps the compared buffers a
 * fixed 32 bytes, so the length of the secret does not leak either.
 */
export function secretEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()
  return timingSafeEqual(digest(a), digest(b))
}

/** `Authorization: Bearer <token>`, compared the same careful way. */
export function bearerEquals(token: string, header: string | undefined): boolean {
  // RFC 7235 makes the scheme case-insensitive; the secret after it is not.
  const match = header ? /^bearer +(.*)$/i.exec(header) : null
  return secretEquals(token, match?.[1] ?? null)
}

/**
 * Sent on every response, static file and API alike.
 *
 * `frame-ancestors` is the one with teeth today: a deck that can be framed can
 * be clicked through by the page framing it. The rest of the CSP is a backstop
 * — there is no HTML injection sink in the app right now, and this is what
 * keeps the day one appears from being the day it becomes code execution.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    // xterm writes a <style> element of its own for terminal metrics.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", // the favicon is an inline SVG
    "font-src 'self'",
    "connect-src 'self'", // ws:// to this same host is 'self' under CSP 3
    "worker-src 'self'", // the PWA service worker
    "manifest-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
})

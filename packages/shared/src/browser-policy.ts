/**
 * What an attached browser is allowed to navigate to (spec §4.7).
 *
 * Pure: a URL and a policy in, a verdict out. The daemon applies this on every
 * navigation *including redirects and sub-frame loads*, because a site that is
 * on the allowlist can redirect to one that is not, and a policy consulted only
 * on the first hop is not a policy.
 */

export type NavigationVerdict =
  | { ok: true }
  /** Not http(s). Never promptable. */
  | { ok: false; reason: 'scheme' }
  /** tring's own daemon. Never promptable — see refusesDaemonOrigin below. */
  | { ok: false; reason: 'daemon' }
  /** Outside the allowlist. Held, and offered to the user as allow-once/always. */
  | { ok: false; reason: 'not-allowed'; host: string }
  | { ok: false; reason: 'malformed' }

export interface NavigationPolicy {
  /** Host patterns, optionally with `:port`. `*` matches one or more labels. */
  allow: string[]
  /** The port the daemon itself is listening on. */
  daemonPort: number
  /**
   * The host the daemon is bound to, when it is not loopback — a Tailscale
   * address, say. Loopback is handled by name rather than by string equality,
   * because it has many spellings.
   */
  daemonHost?: string | null
}

/** The default for a new project: the developer's own machine and nothing else. */
export const DEFAULT_ALLOW = ['localhost:*', '127.0.0.1:*'] as const

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/**
 * Loopback has many spellings and they are not string-equal: `localhost`,
 * `127.0.0.1`, `127.0.0.2`, `::1`. All of them reach the same daemon.
 */
export function isLoopback(host: string): boolean {
  const h = host.toLowerCase()
  if (LOOPBACK_NAMES.has(h)) return true
  // The whole 127.0.0.0/8 block, not just .1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

function portOf(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

/**
 * Whether this URL is tring's own web UI.
 *
 * **This is checked before the allowlist and cannot be overridden by it.** The
 * daemon serves a page that drives every terminal on the machine and takes its
 * bearer token from a query parameter, so an agent that navigates to
 * `http://127.0.0.1:7331/?token=…` is typing into its own ring — and into the
 * other fifteen. The WebSocket origin check of §4.7 cannot catch this, because
 * that request's origin genuinely *is* the daemon's.
 *
 * It matters that this is a port-and-host test rather than an origin string
 * comparison: the default allowlist admits `localhost:*` and `127.0.0.1:*`,
 * which would otherwise admit the daemon's own port along with every dev server
 * the developer actually wanted to reach.
 */
export function isDaemonOrigin(url: URL, policy: NavigationPolicy): boolean {
  const port = portOf(url)
  if (port !== policy.daemonPort) return false
  if (isLoopback(url.hostname)) return true
  if (policy.daemonHost && url.hostname.toLowerCase() === policy.daemonHost.toLowerCase()) {
    return true
  }
  return false
}

/**
 * Matches a host[:port] pattern. `*` stands for one or more dot-separated
 * labels, so `*.example.com` covers `a.example.com` and `a.b.example.com` but
 * not `example.com` itself — a wildcard that silently included the apex would
 * be a surprise in the direction of more access.
 */
export function matchesPattern(pattern: string, hostname: string, port: number): boolean {
  const trimmed = pattern.trim().toLowerCase()
  if (!trimmed) return false

  // Split off a port suffix, taking care not to mistake an IPv6 colon for one.
  // `::1` is a host, `[::1]:7331` is a host and a port, and `localhost:*` is
  // the common case — telling them apart needs the bracket rule, because a
  // bare `::1` otherwise splits into host `:` on port 1.
  let hostPart = trimmed
  let portPart: string | null = null
  const lastColon = trimmed.lastIndexOf(':')
  if (lastColon > -1) {
    const before = trimmed.slice(0, lastColon)
    const bracketed = trimmed.startsWith('[') && before.includes(']')
    if (bracketed || !before.includes(':')) {
      hostPart = before
      portPart = trimmed.slice(lastColon + 1)
    }
  }

  if (portPart !== null && portPart !== '*' && Number(portPart) !== port) return false

  if (hostPart === '*') return true
  const rx = new RegExp(
    '^' + hostPart.split('*').map(escapeRegex).join('[^.]+(?:\\.[^.]+)*') + '$',
  )
  return rx.test(hostname.toLowerCase())
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function checkNavigation(raw: string, policy: NavigationPolicy): NavigationVerdict {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  // `file:` would hand an agent the filesystem through a surface with none of
  // the daemon's path checks; everything else non-http is a scheme handler we
  // have made no promises about.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme' }
  }

  // Before the allowlist, deliberately. See isDaemonOrigin.
  if (isDaemonOrigin(url, policy)) return { ok: false, reason: 'daemon' }

  const port = portOf(url)
  for (const pattern of policy.allow) {
    if (matchesPattern(pattern, url.hostname, port)) return { ok: true }
  }
  return { ok: false, reason: 'not-allowed', host: url.host }
}

/** Whether a refusal is one the user can wave through from the tile (spec §4.7). */
export function isPromptable(verdict: NavigationVerdict): boolean {
  return !verdict.ok && verdict.reason === 'not-allowed'
}

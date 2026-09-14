import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The daemon's bearer token, and where it lives when we make one ourselves.
 *
 * "Listens on 127.0.0.1" is not an authentication boundary. The daemon spawns
 * shells, so a no-token default means every process on the machine — a
 * postinstall script in some dependency, a second user account, a container
 * sharing the host network namespace — can open one. Loopback keeps other
 * *machines* out and nothing else, and the Origin check deliberately waves
 * through anything that sends no Origin at all, because that is what keeps the
 * hooks and curl working.
 *
 * So there is no unauthenticated mode unless it is asked for by name. When no
 * --token is given we mint one and keep it at ~/.config/tring/token with mode
 * 0600, which the daemon then hands to the browser it opens. Same-machine
 * clients that used to rely on there being no secret read it back from that
 * file; other users on the box cannot, which is the entire point.
 */

/** Long enough that guessing is not a strategy; `openssl rand -hex 32` is 64. */
export const MIN_TOKEN_LENGTH = 16

/** Sits beside projects.json, under the same XDG-or-~/.config base. */
export function defaultTokenPath(): string {
  const base = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config')
  return path.join(base, 'tring', 'token')
}

/** 32 bytes of CSPRNG output, hex — the same shape the README's openssl line gives. */
export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Why a given string is not usable as a token, or null if it is fine.
 *
 * `String(argv[++i])` on a trailing flag produces the literal "undefined",
 * which is truthy and therefore satisfied every `if (token)` gate in the
 * daemon. Length is the cheap catch-all for that whole family of accidents.
 */
export function tokenProblem(token: string): string | null {
  if (token.trim() !== token) return 'a token cannot start or end with whitespace'
  if (token.length < MIN_TOKEN_LENGTH) {
    return `a token must be at least ${MIN_TOKEN_LENGTH} characters — ` +
      'generate one with `openssl rand -hex 32`'
  }
  return null
}

/** Owner-only, and repaired rather than trusted: the file is the credential. */
function lockDown(file: string): void {
  // chmod is a no-op on Windows, where the ACL inherited from the user's own
  // config directory is the protection instead.
  try { chmodSync(file, 0o600) } catch { /* best effort; Windows has no mode */ }
}

/**
 * The persisted token, minting and storing one on first run.
 *
 * Stable across restarts on purpose: a token that changed every launch would
 * invalidate the link in every installed PWA and every hook script on the
 * machine each time the daemon came back up.
 *
 * Throws if the file cannot be written. That is deliberate — falling back to
 * running with no authentication is the failure this module exists to prevent,
 * so the caller exits instead, and --insecure-no-token remains the way to ask
 * for an unauthenticated daemon on purpose.
 */
export function loadOrCreateToken(file: string = defaultTokenPath()): string {
  try {
    const existing = readFileSync(file, 'utf8').trim()
    // A truncated or hand-edited file is replaced rather than honoured: a weak
    // secret here would be indistinguishable from a strong one at the door.
    if (tokenProblem(existing) === null) {
      lockDown(file)
      return existing
    }
  } catch { /* no token yet, or unreadable — write a fresh one below */ }

  const token = generateToken()
  mkdirSync(path.dirname(file), { recursive: true })
  // mode on the open() is masked by the umask, so chmod afterwards is what
  // actually guarantees 0600 for a user whose umask is 022.
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  lockDown(file)
  return token
}

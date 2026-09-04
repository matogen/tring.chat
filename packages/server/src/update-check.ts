import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)

/** Works from both src/ and dist/ — each is one level under the package root. */
export function currentVersion(): string {
  try {
    return (require('../package.json') as { version: string }).version
  } catch {
    return '0.0.0'
  }
}

/**
 * A newer release exists. Prereleases are ignored: `npm i -g tring` installs
 * the latest stable, so nagging about 0.2.0-beta.1 would be advice the user
 * cannot act on with the command we would show them.
 */
export function isNewer(latest: string, current: string): boolean {
  if (latest.includes('-')) return false
  const parse = (v: string): number[] => v.split('-')[0]!.split('.').map((n) => Number(n) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

interface Cache {
  checkedAt: number
  latest: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Asks the npm registry, at most once a day, whether a newer tring exists.
 *
 * Never throws and never blocks startup: an offline machine, a proxy or a
 * registry outage must not stop a local terminal deck from opening. Opt out
 * entirely with --no-update-check or TRING_NO_UPDATE_CHECK.
 */
export async function checkForUpdate(cachePath: string): Promise<string | null> {
  const current = currentVersion()

  let cache: Cache | null = null
  try {
    cache = JSON.parse(await readFile(cachePath, 'utf8')) as Cache
  } catch {
    cache = null
  }

  if (cache && Date.now() - cache.checkedAt < DAY_MS) {
    return isNewer(cache.latest, current) ? cache.latest : null
  }

  let latest: string
  try {
    const res = await fetch('https://registry.npmjs.org/tring/latest', {
      signal: AbortSignal.timeout(3000),
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!res.ok) return null
    latest = ((await res.json()) as { version?: string }).version ?? ''
    if (!latest) return null
  } catch {
    return null
  }

  try {
    await mkdir(path.dirname(cachePath), { recursive: true })
    await writeFile(cachePath, JSON.stringify({ checkedAt: Date.now(), latest }), 'utf8')
  } catch {
    // A cache we cannot write just means we ask again next start.
  }

  return isNewer(latest, current) ? latest : null
}

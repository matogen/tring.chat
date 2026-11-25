import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * What tring reads back from a forge about a PR its agents opened: whether it
 * is merged, and its CI. GitHub only, through the user's own `gh`; a PR
 * anywhere else (Bitbucket) is followed with the feature card's Mark merged
 * button, and its CI shows as unknown. Read-only: tring never merges.
 */

export interface PrState {
  state: 'open' | 'merged' | 'closed'
  /** null while the PR has no checks. */
  ci: 'green' | 'red' | 'pending' | null
}

type Gh = (args: string[]) => Promise<string>

const run = promisify(execFile)
const realGh: Gh = async (args) => (await run('gh', args, { encoding: 'utf8', timeout: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } })).stdout

interface Check { status?: string; conclusion?: string; state?: string }

export class Forge {
  constructor(private readonly gh: Gh = realGh) {}

  async pr(url: string): Promise<PrState | null> {
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) return null
    let raw: { state?: string; statusCheckRollup?: Check[] }
    try {
      raw = JSON.parse(await this.gh(['pr', 'view', url, '--json', 'state,statusCheckRollup'])) as typeof raw
    } catch {
      return null
    }
    const state = raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : 'open'
    return { state, ci: rollup(raw.statusCheckRollup ?? []) }
  }
}

/** Red on any failure; pending while anything still runs; green when all passed. */
function rollup(checks: Check[]): PrState['ci'] {
  if (!checks.length) return null
  const each = checks.map((c): 'green' | 'red' | 'pending' => {
    if (c.state) return c.state === 'SUCCESS' ? 'green' : c.state === 'PENDING' || c.state === 'EXPECTED' ? 'pending' : 'red'
    if (c.status !== 'COMPLETED') return 'pending'
    return ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? '') ? 'green' : 'red'
  })
  return each.includes('red') ? 'red' : each.includes('pending') ? 'pending' : 'green'
}

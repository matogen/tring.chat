import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

/**
 * tring's side of a forge: it opens the draft PR a coder's pushed branch
 * needs, retargets it when the PR below merges, and reads back whether it is
 * merged and its CI. The agents never hold a forge token; tring never merges.
 *
 * GitHub goes through the user's own `gh`. Bitbucket Cloud goes through its
 * REST API with a scoped API token the user puts in bitbucket.json (or
 * TRING_BITBUCKET_TOKEN): read:pullrequest:bitbucket and
 * write:pullrequest:bitbucket. Without a token tring opens nothing on
 * Bitbucket and hands back the link to open the PR by hand.
 */

export interface PrState {
  state: 'open' | 'merged' | 'closed'
  /** null while the PR has no checks. */
  ci: 'green' | 'red' | 'pending' | null
}

export interface OpenPr {
  /** origin's URL, as `git remote get-url origin` gives it. */
  origin: string
  head: string
  base: string
  title: string
  body: string
}

/** The PR's URL, or why it could not be opened and, where known, a link to open it by hand. */
export type Opened = { url: string } | { error: string; link?: string }

export interface BitbucketCreds {
  token: string
  /** With an email the token goes as basic auth (an Atlassian API token); without, as a bearer. */
  email?: string
}

export interface Origin { host: 'github' | 'bitbucket'; owner: string; repo: string }

type Gh = (args: string[]) => Promise<string>
type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface ForgeDeps {
  gh?: Gh
  fetch?: Fetch
  /** Read at each call, so a token added later needs no restart. */
  bitbucket?: () => BitbucketCreds | null
}

const run = promisify(execFile)
const realGh: Gh = async (args) => (await run('gh', args, { encoding: 'utf8', timeout: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } })).stdout

const BB_API = 'https://api.bitbucket.org/2.0/repositories'
const BB_SCOPES = 'read:pullrequest:bitbucket and write:pullrequest:bitbucket'
const NO_TOKEN = 'no Bitbucket token: tring opens and follows Bitbucket PRs with a scoped API token in bitbucket.json in its config folder'

/** A GitHub or Bitbucket Cloud remote, over HTTPS or SSH. */
export function parseOrigin(url: string): Origin | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)(github\.com|bitbucket\.org)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  if (!m) return null
  return { host: m[1] === 'github.com' ? 'github' : 'bitbucket', owner: m[2]!, repo: m[3]! }
}

const GH_PR = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/
const BB_PR = /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/

/** A PR tring can follow, not a link to open one by hand. */
export const isPrUrl = (url: string): boolean => GH_PR.test(url) || BB_PR.test(url)

/** The Bitbucket token: bitbucket.json in tring's config folder, else the environment. */
export function bitbucketCreds(configDir: string, env: NodeJS.ProcessEnv = process.env): BitbucketCreds | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(configDir, 'bitbucket.json'), 'utf8')) as Partial<BitbucketCreds>
    if (typeof raw.token === 'string' && raw.token.trim()) {
      return { token: raw.token.trim(), ...(typeof raw.email === 'string' && raw.email.trim() ? { email: raw.email.trim() } : {}) }
    }
    return null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null
  }
  const token = env['TRING_BITBUCKET_TOKEN']?.trim()
  if (!token) return null
  const email = env['TRING_BITBUCKET_EMAIL']?.trim()
  return { token, ...(email ? { email } : {}) }
}

interface Check { status?: string; conclusion?: string; state?: string }
interface BbStatus { key?: string; state?: string; updated_on?: string }

export class Forge {
  private readonly gh: Gh
  private readonly fetch: Fetch
  private readonly creds: () => BitbucketCreds | null

  constructor(d: ForgeDeps = {}) {
    this.gh = d.gh ?? realGh
    this.fetch = d.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.creds = d.bitbucket ?? (() => null)
  }

  async pr(url: string): Promise<PrState | null> {
    if (GH_PR.test(url)) return this.ghPr(url)
    const bb = BB_PR.exec(url)
    if (bb) return this.bbPr(bb[1]!, bb[2]!, bb[3]!)
    return null
  }

  async open(o: OpenPr): Promise<Opened> {
    const origin = parseOrigin(o.origin)
    if (!origin) return { error: `tring cannot open PRs on ${o.origin}` }
    const head = encodeURIComponent(o.head)
    const base = encodeURIComponent(o.base)
    if (origin.host === 'github') {
      const link = `https://github.com/${origin.owner}/${origin.repo}/compare/${base}...${head}?expand=1`
      try {
        const out = await this.gh(['pr', 'create', '--repo', `${origin.owner}/${origin.repo}`, '--draft', '--head', o.head, '--base', o.base, '--title', o.title, '--body', o.body])
        const url = out.split(/\s+/).find((w) => GH_PR.test(w))
        return url ? { url } : { error: 'gh did not say the PR\'s URL', link }
      } catch (err) {
        return { error: `gh could not open the PR: ${firstLine(err)}`, link }
      }
    }
    const link = `https://bitbucket.org/${origin.owner}/${origin.repo}/pull-requests/new?source=${head}&dest=${base}`
    const r = await this.bb('POST', `${origin.owner}/${origin.repo}/pullrequests`, {
      title: o.title, description: o.body, draft: true, close_source_branch: false,
      source: { branch: { name: o.head } }, destination: { branch: { name: o.base } },
    })
    if ('error' in r) return { error: r.error, link }
    const url = (r.json as { links?: { html?: { href?: string } } }).links?.html?.href
    return url ? { url } : { error: 'Bitbucket did not say the PR\'s URL', link }
  }

  /** Points an open PR at `base`; the error, or null. */
  async retarget(url: string, base: string): Promise<string | null> {
    if (GH_PR.test(url)) {
      try {
        await this.gh(['pr', 'edit', url, '--base', base])
        return null
      } catch (err) {
        return `gh could not retarget the PR: ${firstLine(err)}`
      }
    }
    const bb = BB_PR.exec(url)
    if (!bb) return `tring cannot retarget ${url}`
    const at = `${bb[1]}/${bb[2]}/pullrequests/${bb[3]}`
    const cur = await this.bb('GET', at)
    if ('error' in cur) return cur.error
    // Bitbucket wants the title with any change to a PR.
    const title = (cur.json as { title?: string }).title
    const r = await this.bb('PUT', at, { ...(title ? { title } : {}), destination: { branch: { name: base } } })
    return 'error' in r ? r.error : null
  }

  private async ghPr(url: string): Promise<PrState | null> {
    let raw: { state?: string; statusCheckRollup?: Check[] }
    try {
      raw = JSON.parse(await this.gh(['pr', 'view', url, '--json', 'state,statusCheckRollup'])) as typeof raw
    } catch {
      return null
    }
    const state = raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : 'open'
    return { state, ci: rollup(raw.statusCheckRollup ?? []) }
  }

  private async bbPr(ws: string, repo: string, id: string): Promise<PrState | null> {
    const pr = await this.bb('GET', `${ws}/${repo}/pullrequests/${id}`)
    if ('error' in pr) return null
    const st = (pr.json as { state?: string }).state
    const state = st === 'MERGED' ? 'merged' : st === 'DECLINED' || st === 'SUPERSEDED' ? 'closed' : 'open'
    const statuses = await this.bb('GET', `${ws}/${repo}/pullrequests/${id}/statuses?pagelen=100`)
    return { state, ci: 'error' in statuses ? null : bbRollup((statuses.json as { values?: BbStatus[] }).values ?? []) }
  }

  private async bb(method: string, at: string, body?: unknown): Promise<{ json: unknown } | { error: string }> {
    const creds = this.creds()
    if (!creds) return { error: NO_TOKEN }
    const auth = creds.email
      ? `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`
      : `Bearer ${creds.token}`
    let res: Response
    try {
      res = await this.fetch(`${BB_API}/${at}`, {
        method,
        headers: { authorization: auth, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      return { error: `could not reach Bitbucket: ${firstLine(err)}` }
    }
    const json = await res.json().catch(() => ({})) as { error?: { message?: string } }
    if (res.ok) return { json }
    const why = json.error?.message ? `: ${json.error.message.split('\n')[0]}` : ''
    if (res.status === 401 || res.status === 403) {
      return { error: `Bitbucket refused the token (${res.status}${why}); it needs the ${BB_SCOPES} scopes` }
    }
    return { error: `Bitbucket answered ${res.status}${why}` }
  }
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string }
  return String(e.stderr || e.message || err).trim().split('\n')[0] ?? ''
}

/** Red on any failure; pending while anything still runs; green when all passed. */
function rollup(checks: Check[]): PrState['ci'] {
  if (!checks.length) return null
  const each = checks.map((c): 'green' | 'red' | 'pending' => {
    if (c.state) return c.state === 'SUCCESS' ? 'green' : c.state === 'PENDING' || c.state === 'EXPECTED' ? 'pending' : 'red'
    if (c.status !== 'COMPLETED') return 'pending'
    return ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? '') ? 'green' : 'red'
  })
  return combine(each)
}

/** The latest status of each build (by key) on a Bitbucket PR; a stopped build is not a pass. */
function bbRollup(statuses: BbStatus[]): PrState['ci'] {
  const latest = new Map<string, BbStatus>()
  for (const s of statuses) {
    const k = s.key ?? ''
    const prev = latest.get(k)
    if (!prev || (s.updated_on ?? '') >= (prev.updated_on ?? '')) latest.set(k, s)
  }
  if (!latest.size) return null
  return combine([...latest.values()].map((s) => s.state === 'SUCCESSFUL' ? 'green' : s.state === 'INPROGRESS' ? 'pending' : 'red'))
}

function combine(each: Array<'green' | 'red' | 'pending'>): PrState['ci'] {
  return each.includes('red') ? 'red' : each.includes('pending') ? 'pending' : 'green'
}

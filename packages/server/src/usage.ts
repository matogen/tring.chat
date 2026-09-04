import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Claude Code's session limit runs in five-hour blocks from your first message. */
export const WINDOW_MS = 5 * 3_600_000
const WEEK_MS = 7 * 24 * 3_600_000

/**
 * Dollars per million tokens, by model id prefix.
 *
 * ponytail: hardcoded price table, drifts when Anthropic changes pricing —
 * swap it for a fetched one only if the estimate starts mattering to someone.
 * Cache creation bills at 1.25x input and cache reads at 0.1x, per the API docs.
 */
const PRICES: [string, number, number][] = [
  ['claude-fable-5', 10, 50],
  ['claude-mythos-5', 10, 50],
  ['claude-opus-', 5, 25],
  ['claude-sonnet-4-6', 3, 15],
  ['claude-sonnet-', 2, 10],
  ['claude-haiku-', 1, 5],
]

export interface UsageBucket {
  /** input + output + cache creation: the tokens actually processed fresh. */
  tokens: number
  /** Reported apart, because reads dwarf everything and cost a tenth as much. */
  cacheReadTokens: number
  cost: number
  messages: number
}

/** One row of Claude Code's own `/usage`, which is the real limit. */
export interface Limit {
  label: string
  percent: number
  resets: string | null
}

export interface UsageReport {
  /** Empty when Claude Code is not installed, or on an API key. */
  limits: Limit[]
  limitsError: string | null
  window: UsageBucket & { startedAt: number | null; resetsAt: number | null }
  today: UsageBucket
  week: UsageBucket
  projects: { name: string; tokens: number; cost: number }[]
  scannedAt: number
}

interface Entry {
  at: number
  project: string
  tokens: number
  cacheReadTokens: number
  cost: number
}

export function defaultTranscriptDir(): string {
  const base = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude')
  return path.join(base, 'projects')
}

const empty = (): UsageBucket => ({ tokens: 0, cacheReadTokens: 0, cost: 0, messages: 0 })

function add(b: UsageBucket, e: Entry): void {
  b.tokens += e.tokens
  b.cacheReadTokens += e.cacheReadTokens
  b.cost += e.cost
  b.messages += 1
}

function priceOf(model: string): [number, number] {
  for (const [prefix, input, output] of PRICES) if (model.startsWith(prefix)) return [input, output]
  return [0, 0]
}

/**
 * Reads Claude Code's own transcripts and buckets what they cost.
 *
 * Two things a naive sum gets wrong, both load-bearing:
 *
 *   One assistant message is written as one record *per content block*, each
 *   echoing the same usage object — five records for one reply is ordinary, so
 *   summing records over-counts by roughly two. Messages are therefore keyed by
 *   `message.id`.
 *
 *   A resumed or forked session replays earlier messages into a second file, so
 *   that key has to be global rather than per-file.
 */
export async function scanUsage(dir: string, now: number): Promise<UsageReport> {
  const seen = new Set<string>()
  const entries: Entry[] = []
  const weekAgo = now - WEEK_MS

  for (const file of await transcripts(dir, weekAgo)) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue // deleted mid-scan, or unreadable: it is a cache, not a ledger
    }
    for (const line of text.split('\n')) {
      // Cheaper than parsing every user record and file-history blob.
      if (!line.includes('"usage"')) continue
      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const entry = toEntry(rec, seen)
      if (entry && entry.at >= weekAgo) entries.push(entry)
    }
  }

  const report: UsageReport = {
    limits: [],
    limitsError: null,
    window: { ...empty(), startedAt: null, resetsAt: null },
    today: empty(),
    week: empty(),
    projects: [],
    scannedAt: now,
  }

  entries.sort((a, b) => a.at - b.at)
  const blockStart = liveBlockStart(entries, now)
  const dayStart = new Date(now).setHours(0, 0, 0, 0)
  const byProject = new Map<string, { name: string; tokens: number; cost: number }>()

  for (const e of entries) {
    add(report.week, e)
    if (e.at >= dayStart) add(report.today, e)
    if (blockStart !== null && e.at >= blockStart) add(report.window, e)

    const p = byProject.get(e.project) ?? { name: e.project, tokens: 0, cost: 0 }
    p.tokens += e.tokens
    p.cost += e.cost
    byProject.set(e.project, p)
  }

  if (blockStart !== null) {
    report.window.startedAt = blockStart
    report.window.resetsAt = blockStart + WINDOW_MS
  }
  report.projects = [...byProject.values()].sort((a, b) => b.tokens - a.tokens)
  return report
}

function toEntry(rec: Record<string, unknown>, seen: Set<string>): Entry | null {
  if (rec['type'] !== 'assistant') return null
  const message = rec['message'] as Record<string, unknown> | undefined
  const usage = message?.['usage'] as Record<string, number> | undefined
  if (!usage) return null

  const id = String(message?.['id'] ?? rec['requestId'] ?? '')
  if (!id || seen.has(id)) return null
  seen.add(id)

  const at = Date.parse(String(rec['timestamp'] ?? ''))
  if (Number.isNaN(at)) return null

  const input = usage['input_tokens'] ?? 0
  const output = usage['output_tokens'] ?? 0
  const creation = usage['cache_creation_input_tokens'] ?? 0
  const read = usage['cache_read_input_tokens'] ?? 0
  const [inPrice, outPrice] = priceOf(String(message?.['model'] ?? ''))

  const cwd = String(rec['cwd'] ?? '')
  return {
    at,
    project: cwd.split(/[/\\]/).filter(Boolean).pop() ?? 'unknown',
    tokens: input + output + creation,
    cacheReadTokens: read,
    cost:
      (input * inPrice + creation * inPrice * 1.25 + read * inPrice * 0.1 + output * outPrice) /
      1_000_000,
  }
}

/**
 * The start of the block that is still live, or null when nothing is running.
 * A block opens on the first message after a five-hour gap and closes five
 * hours later, which is the shape of the limit itself.
 */
function liveBlockStart(entries: Entry[], now: number): number | null {
  let start: number | null = null
  let prev = 0
  for (const e of entries) {
    if (start === null || e.at - start >= WINDOW_MS || e.at - prev >= WINDOW_MS) start = e.at
    prev = e.at
  }
  return start !== null && now - start < WINDOW_MS ? start : null
}

/** Only files touched inside the window can hold entries inside it. */
async function transcripts(dir: string, since: number): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir, { recursive: true })
  } catch {
    return [] // no Claude Code on this machine, which is not an error
  }
  const out: string[] = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const file = path.join(dir, name)
    try {
      if ((await stat(file)).mtimeMs >= since) out.push(file)
    } catch {
      // raced with a delete
    }
  }
  return out
}


/* ---------- the real limits, from Claude Code itself ---------- */

/**
 * `Current session: 26% used · resets Sep 4, 11:30am (Africa/Johannesburg)`
 *
 * Anchored to the line start so the prose underneath — "69% of your usage was
 * at >150k context" — cannot be mistaken for a limit.
 */
const LIMIT_LINE = /^Current ([^:]+):\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+?))?\s*$/

export function parseLimits(text: string): Limit[] {
  const out: Limit[] = []
  for (const line of text.split('\n')) {
    const m = LIMIT_LINE.exec(line.trim())
    if (!m) continue
    const label = m[1]!.trim()
    out.push({
      label: label.charAt(0).toUpperCase() + label.slice(1),
      percent: Number(m[2]),
      resets: m[3]?.trim() ?? null,
    })
  }
  return out
}

/**
 * Asks Claude Code what its own limits are.
 *
 * `/usage` is handled inside the CLI rather than sent to the model — the run
 * reports zero turns and zero cost — so this is a local question, not an API
 * call. It is also the only way to get real utilisation: nothing under
 * `~/.claude` records it, and the alternative would be reading the user's
 * OAuth token and calling an undocumented endpoint.
 */
export function readLimits(timeoutMs = 30_000): Promise<Limit[]> {
  const args = ['-p', '/usage', '--output-format', 'json']

  const run = (cmd: string): Promise<Limit[]> =>
    new Promise((resolve, reject) => {
      // Resolved on `exit`, not on stdio close: something downstream of the
      // CLI keeps a pipe open after the process is gone, and waiting for that
      // costs three seconds per call (6.4s measured, against 2.1s this way).
      // A truncated read cannot pass silently — it fails JSON.parse below.
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        child.kill()
        reject(new Error('timed out'))
      }, timeoutMs)

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { out += chunk })
      child.on('error', (err) => { clearTimeout(timer); if (!settled) reject(err) })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (settled) return
        // One tick for whatever is still in the pipe buffer.
        setTimeout(() => {
          if (code !== 0) return reject(new Error(`claude exited ${code}`))
          try {
            resolve(parseLimits((JSON.parse(out) as { result?: string }).result ?? ''))
          } catch {
            reject(new Error('could not read Claude Code usage output'))
          }
        }, 50)
      })
    })

  // npm installs a .cmd shim on Windows, which spawn will not find bare.
  return run('claude').catch((err: Error & { code?: string }) =>
    process.platform === 'win32' && err.code === 'ENOENT'
      ? run('claude.cmd')
      : Promise.reject(err),
  )
}

/** The whole picture: Claude Code's limits, plus what the transcripts cost. */
export async function collectUsage(dir: string, now: number): Promise<UsageReport> {
  const [report, limits] = await Promise.all([
    scanUsage(dir, now),
    readLimits().then(
      (l) => ({ limits: l, error: null as string | null }),
      (e: Error) => ({ limits: [] as Limit[], error: describe(e) }),
    ),
  ])
  report.limits = limits.limits
  report.limitsError = limits.error
  return report
}

function describe(err: Error & { code?: string; killed?: boolean }): string {
  if (err.code === 'ENOENT') return 'the `claude` command is not on this machine’s PATH'
  if (err.killed) return '`claude -p /usage` timed out'
  return err.message || 'could not run `claude -p /usage`'
}

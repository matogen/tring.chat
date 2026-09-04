import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseLimits, scanUsage, WINDOW_MS } from '../src/usage.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

const HOUR = 3_600_000
const NOW = Date.parse('2026-09-04T12:00:00.000Z')

interface Entry {
  at: number
  id: string
  cwd?: string
  model?: string
  input?: number
  output?: number
  cacheCreation?: number
  cacheRead?: number
  /** How many content-block records this one message is written as. */
  blocks?: number
}

function lines(entries: Entry[]): string {
  const out: string[] = []
  for (const e of entries) {
    for (let b = 0; b < (e.blocks ?? 1); b++) {
      out.push(JSON.stringify({
        type: 'assistant',
        timestamp: new Date(e.at).toISOString(),
        cwd: e.cwd ?? '/home/dev/api-service',
        requestId: `req_${e.id}`,
        apiBlockIndex: b,
        message: {
          id: `msg_${e.id}`,
          model: e.model ?? 'claude-opus-5',
          usage: {
            input_tokens: e.input ?? 0,
            output_tokens: e.output ?? 0,
            cache_creation_input_tokens: e.cacheCreation ?? 0,
            cache_read_input_tokens: e.cacheRead ?? 0,
          },
        },
      }))
    }
  }
  return out.join('\n') + '\n'
}

async function fixture(files: Record<string, Entry[]>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-usage-'))
  dirs.push(dir)
  for (const [name, entries] of Object.entries(files)) {
    const file = path.join(dir, name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, lines(entries), 'utf8')
  }
  return dir
}

describe('usage scan', () => {
  it('counts a message once however many content blocks it was written as', async () => {
    const dir = await fixture({
      'proj/a.jsonl': [{ at: NOW - HOUR, id: '1', output: 1000, blocks: 5 }],
    })
    // The naive sum of every usage-bearing record would be 5000.
    expect((await scanUsage(dir, NOW)).window.tokens).toBe(1000)
  })

  it('counts a message once when a resumed session repeats it in another file', async () => {
    const shared: Entry = { at: NOW - HOUR, id: 'shared', output: 700 }
    const dir = await fixture({
      'proj/a.jsonl': [shared],
      'proj/b.jsonl': [shared, { at: NOW - HOUR, id: 'other', output: 300 }],
    })
    expect((await scanUsage(dir, NOW)).window.tokens).toBe(1000)
  })

  it('keeps cache reads out of the headline but still reports them', async () => {
    const dir = await fixture({
      'proj/a.jsonl': [{
        at: NOW - HOUR, id: '1',
        input: 10, output: 20, cacheCreation: 30, cacheRead: 900_000,
      }],
    })
    const r = await scanUsage(dir, NOW)
    expect(r.window.tokens).toBe(60)
    expect(r.window.cacheReadTokens).toBe(900_000)
  })

  it('starts a new five-hour block after a gap, and resets five hours in', async () => {
    const blockStart = NOW - 2 * HOUR
    const dir = await fixture({
      'proj/a.jsonl': [
        { at: NOW - 30 * HOUR, id: 'old', output: 500 },   // long past, its own block
        { at: blockStart, id: 'b1', output: 100 },          // opens the live block
        { at: NOW - HOUR, id: 'b2', output: 200 },
      ],
    })
    const r = await scanUsage(dir, NOW)
    expect(r.window.tokens).toBe(300)
    expect(r.window.startedAt).toBe(blockStart)
    expect(r.window.resetsAt).toBe(blockStart + WINDOW_MS)
  })

  it('reports no live window once five hours have passed with nothing running', async () => {
    const dir = await fixture({
      'proj/a.jsonl': [{ at: NOW - 6 * HOUR, id: 'old', output: 500 }],
    })
    const r = await scanUsage(dir, NOW)
    expect(r.window.tokens).toBe(0)
    expect(r.window.startedAt).toBeNull()
  })

  it('splits the week by project, using the cwd each message was sent from', async () => {
    const dir = await fixture({
      'a.jsonl': [
        { at: NOW - HOUR, id: '1', cwd: '/home/dev/api-service', output: 300 },
        { at: NOW - 2 * HOUR, id: '2', cwd: '/home/dev/web-ui', output: 100 },
        { at: NOW - 3 * HOUR, id: '3', cwd: '/home/dev/api-service', output: 200 },
      ],
    })
    const r = await scanUsage(dir, NOW)
    expect(r.projects.map((p) => [p.name, p.tokens])).toEqual([
      ['api-service', 500],
      ['web-ui', 100],
    ])
  })

  it('leaves anything older than seven days out of the week', async () => {
    const dir = await fixture({
      'proj/a.jsonl': [
        { at: NOW - 8 * 24 * HOUR, id: 'old', output: 999 },
        { at: NOW - 2 * 24 * HOUR, id: 'new', output: 111 },
      ],
    })
    const r = await scanUsage(dir, NOW)
    expect(r.week.tokens).toBe(111)
  })

  it('prices output above input, and cache reads far below both', async () => {
    const dir = await fixture({
      'proj/a.jsonl': [{ at: NOW - HOUR, id: '1', model: 'claude-opus-5', input: 1_000_000 }],
      'proj/b.jsonl': [{ at: NOW - HOUR, id: '2', model: 'claude-opus-5', output: 1_000_000 }],
    })
    const r = await scanUsage(dir, NOW)
    expect(r.window.cost).toBeCloseTo(5 + 25, 5)
  })

  it('returns an empty report when there is nothing to read', async () => {
    const dir = await fixture({})
    const r = await scanUsage(dir, NOW)
    expect(r.week.tokens).toBe(0)
    expect(r.projects).toEqual([])
  })
})

/** Verbatim from `claude -p "/usage" --output-format json` on a Max plan. */
const REAL_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 26% used · resets Sep 4, 11:30am (Africa/Johannesburg)
Current week (all models): 27% used · resets Sep 7, 10am (Africa/Johannesburg)
Current week (Fable): 28% used · resets Sep 7, 10am (Africa/Johannesburg)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 1165 requests · 13 sessions
  69% of your usage was at >150k context
`

describe('limit parsing', () => {
  it('reads every limit row Claude Code prints, with its reset text', () => {
    expect(parseLimits(REAL_OUTPUT)).toEqual([
      { label: 'Session', percent: 26, resets: 'Sep 4, 11:30am (Africa/Johannesburg)' },
      { label: 'Week (all models)', percent: 27, resets: 'Sep 7, 10am (Africa/Johannesburg)' },
      { label: 'Week (Fable)', percent: 28, resets: 'Sep 7, 10am (Africa/Johannesburg)' },
    ])
  })

  it('ignores the percentages in the contributing-factors prose', () => {
    // "69% of your usage was at >150k context" is not a limit.
    expect(parseLimits(REAL_OUTPUT).map((l) => l.percent)).not.toContain(69)
  })

  it('copes with a row that has no reset time', () => {
    expect(parseLimits('Current session: 5% used')).toEqual([
      { label: 'Session', percent: 5, resets: null },
    ])
  })

  it('returns nothing rather than guessing when the output is unrecognised', () => {
    expect(parseLimits('Usage limits are not available for API key users.')).toEqual([])
  })
})

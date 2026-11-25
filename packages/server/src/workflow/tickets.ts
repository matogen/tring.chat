import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { strategyPhrase, type Finding, type StackPr, type Ticket, type TicketPhase, type TicketRepo } from '@tring/shared/workflow'
import { writeAtomic } from '../card-store.ts'
import { adviceLines } from './engine.ts'

/**
 * The multi-PR workflow's tickets: `~/.config/tring/tickets.json`, and each
 * ticket written out as markdown under `~/.config/tring/tickets/<KEY>/`.
 *
 * These are tring's own local tickets. A tracker's ticket (Goby, GitHub) is
 * read once, by the orchestrator, and copied in as `text`; nothing here ever
 * writes back to a tracker. Once the plan is approved each PR gets a local
 * ticket of its own, `<KEY>-n`, which is what its agents work from — so every
 * tile reads the same scope, rules and status, and only the stack engine
 * changes them.
 */

export interface NewTicket {
  key: string | null
  title: string
  text: string
  source: string
  repos: TicketRepo[]
  maxAgents: number
}

interface TicketsFile {
  version: 1
  /** The n of the next TRING-n, for tickets started from an idea. */
  nextLocal: number
  tickets: Ticket[]
}

const PHASES: readonly TicketPhase[] = ['planning', 'awaiting-approval', 'building', 'integrating', 'done', 'abandoned']

export class TicketStore {
  private readonly tickets = new Map<string, Ticket>()
  private nextLocal = 1
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    /** Where the markdown goes, one directory per ticket. */
    private readonly docsDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    let parsed: Partial<TicketsFile> | null = null
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<TicketsFile>
    } catch {
      return // first run, or a file that is not ours: no tickets
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.tickets)) return
    for (const t of parsed.tickets) if (validTicket(t)) this.tickets.set(t.id, upgrade(t))
    if (typeof parsed.nextLocal === 'number' && Number.isInteger(parsed.nextLocal) && parsed.nextLocal > 0) {
      this.nextLocal = parsed.nextLocal
    }
  }

  list(): Ticket[] {
    return [...this.tickets.values()].sort((a, b) => a.createdAt - b.createdAt).map(clone)
  }

  get(id: string): Ticket | undefined {
    const t = this.tickets.get(id)
    return t ? clone(t) : undefined
  }

  async create(spec: NewTicket): Promise<Ticket> {
    const key = spec.key?.trim() || null
    const t: Ticket = {
      id: randomUUID(),
      key,
      localKey: key ?? `TRING-${this.nextLocal++}`,
      title: spec.title,
      text: spec.text,
      source: spec.source,
      repos: spec.repos.map((r) => ({ ...r })),
      projectId: null,
      phase: 'planning',
      plan: null,
      prs: [],
      maxAgents: spec.maxAgents,
      log: [],
      createdAt: this.now(),
      amendments: [],
      baseMoved: {},
      planErrors: [],
      strategy: null,
      combinedPr: false,
      integrationCheck: true,
      integration: {},
      combined: {},
      followUps: [],
    }
    this.tickets.set(t.id, t)
    await this.save(t)
    return clone(t)
  }

  /** Changes a ticket in place (on a copy, kept only if `change` returns) and saves it. */
  async update(id: string, change: (t: Ticket) => void): Promise<Ticket> {
    const t = this.tickets.get(id)
    if (!t) throw new Error(`no ticket ${id}`)
    const next = clone(t)
    change(next)
    this.tickets.set(id, next)
    await this.save(next)
    return clone(next)
  }

  /** The directory a ticket's markdown is in. */
  dirOf(t: Pick<Ticket, 'localKey'>): string {
    return path.join(this.docsDir, safeName(t.localKey))
  }

  private save(changed: Ticket): Promise<void> {
    const state: TicketsFile = { version: 1, nextLocal: this.nextLocal, tickets: [...this.tickets.values()] }
    const text = JSON.stringify(state, null, 2) + '\n'
    const docs = renderTicket(changed)
    const dir = this.dirOf(changed)
    // Chained, so two quick changes cannot land out of order.
    this.writing = this.writing.then(async () => {
      await writeAtomic(this.file, text)
      await mkdir(dir, { recursive: true })
      for (const [name, body] of docs) await writeAtomic(path.join(dir, name), body)
      // A revised plan with fewer PRs leaves no local ticket for a PR that is gone.
      const keep = new Set(docs.keys())
      const prFile = new RegExp(`^${escape(safeName(changed.localKey))}-\\d+\\.md$`)
      for (const f of await readdir(dir)) if (prFile.test(f) && !keep.has(f)) await rm(path.join(dir, f), { force: true })
    }).catch(() => {})
    return this.writing
  }
}

const clone = <T>(v: T): T => structuredClone(v)
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A key as one directory name: `../../etc/CHV 1` -> `etc-CHV-1`. Never a path. */
export function safeName(key: string): string {
  return key.split(/[^A-Za-z0-9_-]+/).filter(Boolean).join('-') || 'ticket'
}

/** A PR's local ticket key: `CHV-3193-2`. */
export const localKeyOf = (t: Pick<Ticket, 'localKey'>, index: number): string => `${t.localKey}-${index}`

/** Every markdown file of a ticket, by file name: the ticket, and once planned, each PR's. */
export function renderTicket(t: Ticket): Map<string, string> {
  const out = new Map<string, string>()
  const base = safeName(t.localKey)
  out.set(`${base}.md`, renderParent(t))
  for (const pr of t.prs) out.set(`${base}-${pr.index}.md`, renderPr(t, pr))
  return out
}

function renderParent(t: Ticket): string {
  const lines = [
    `# ${t.localKey} ${t.title}`,
    '',
    `Source: ${t.source}${t.key ? ` (${t.key})` : ' (started in tring)'} · Phase: ${t.phase} · ` +
      `Repos: ${t.repos.map((r) => `${r.id} (${r.baseBranch})`).join(', ')}`,
    '',
    '## Ticket',
    '',
    t.text,
  ]
  if (t.plan) {
    lines.push('', `## Plan (version ${t.plan.version})`, '', t.plan.summary)
    if (t.strategy) lines.push('', `Landing as: ${strategyPhrase(t.strategy)} (the user's choice)`)
    lines.push(...adviceLines(t.plan.advice))
  }
  if (t.prs.length) {
    lines.push('', '## Local tickets', '')
    for (const pr of t.prs) {
      const p = t.plan?.prs.find((x) => x.index === pr.index)
      lines.push(`- ${localKeyOf(t, pr.index)} ${p?.title ?? ''} — ${pr.status} (${p?.repo ?? '?'}, ${pr.branch})`)
    }
  }
  if (t.followUps.length) {
    lines.push('', '## Follow-ups', '', 'Found in review, already on the base; nothing held for them.', '',
      ...t.followUps.map((f) => `- ${localKeyOf(t, f.pr)}: ${f.summary}`))
  }
  const log = t.log.filter((e) => e.pr === null)
  if (log.length) lines.push('', '## Work log', '', ...log.map(logLine))
  return lines.join('\n') + '\n'
}

function renderPr(t: Ticket, pr: StackPr): string {
  const p = t.plan?.prs.find((x) => x.index === pr.index)
  const below = p?.below != null ? localKeyOf(t, p.below) : t.repos.find((r) => r.id === p?.repo)?.baseBranch ?? '?'
  const flags = [
    pr.flags.needsRestack && 'needs restack',
    pr.flags.baseFailing && 'a lower PR is failing',
    pr.flags.blocked && `blocked: ${pr.flags.blocked}`,
    pr.flags.interfaceReady && 'interface ready',
  ].filter(Boolean)
  const lines = [
    `# ${localKeyOf(t, pr.index)} ${p?.title ?? ''}`,
    '',
    `Part of ${t.localKey} ${t.title}. Repo: ${p?.repo ?? '?'} · Branch: ${pr.branch} · Sits on: ${below}`,
    `Status: ${pr.status}${flags.length ? ` (${flags.join('; ')})` : ''}${pr.prUrl ? ` · PR: ${pr.prUrl}` : ''}`,
    '',
    '## Scope',
    '',
    p?.scope ?? '',
    '',
    '## Owns (only these files may be edited)',
    '',
    ...(p?.owns ?? []).map((g) => `- \`${g}\``),
  ]
  const provides = t.plan?.interfaces.filter((i) => i.owner === pr.index) ?? []
  const uses = (p?.uses ?? []).map((u) => t.plan?.interfaces.find((i) => i.name === u)).filter((i) => !!i)
  if (provides.length || uses.length) {
    lines.push('', '## Interfaces', '')
    for (const i of provides) lines.push(`- Provides **${i.name}**: ${i.contract}`)
    for (const i of uses) lines.push(`- Uses **${i.name}** (from ${localKeyOf(t, i.owner)}): ${i.contract}`)
  }
  const shared = t.plan?.shared.filter((s) => s.owner === pr.index) ?? []
  if (shared.length) {
    lines.push('', '## Shared files it owns', '', ...shared.map((s) => `- \`${s.path}\`: ${s.why}`))
  }
  lines.push(
    '', '## Tests', '',
    ...(p?.tests.add ?? []).map((f) => `- Add \`${f}\``),
    ...(p?.tests.run ?? []).map((c) => `- Run \`${c}\``),
    '', '## Acceptance criteria', '',
    ...(p?.acceptance ?? []).map((a) => `- ${a}`),
  )
  if (pr.review?.findings.length) {
    lines.push('', `## Review (round ${pr.review.round})`, '', ...pr.review.findings.map(findingLine))
  }
  const log = t.log.filter((e) => e.pr === pr.index)
  if (log.length) lines.push('', '## Work log', '', ...log.map(logLine))
  return lines.join('\n') + '\n'
}

function findingLine(f: Finding): string {
  const r = f.resolution
  const state = typeof r === 'string' ? r : 'skipped' in r ? `skipped: ${r.skipped}` : `declined: ${r.declined}`
  const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : ''
  return `- [${f.severity}${f.holds ? ', holds' : ''}]${where} ${f.summary} — ${state}`
}

function logLine(e: Ticket['log'][number]): string {
  return `- ${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} ${e.who}: ${e.text}`
}

/**
 * A ticket saved before strategies existed: built as a stack, so once its plan
 * was approved it is a stacked one.
 */
function upgrade(t: Ticket): Ticket {
  const approved = t.prs.length > 0 || ['building', 'integrating', 'done'].includes(t.phase)
  t.strategy ??= approved ? 'stacked' : null
  t.combinedPr ??= false
  // Before the integration check, lanes were checked whole; the check stands in for that.
  t.integrationCheck ??= true
  delete (t as { laneChecks?: unknown }).laneChecks
  for (const p of t.prs) if ((p.work as string) === 'checking-lane') p.work = 'idle'
  t.integration ??= {}
  t.combined ??= {}
  t.followUps ??= []
  return t
}

function validTicket(v: unknown): v is Ticket {
  const t = v as Partial<Ticket> | null
  return !!t && typeof t === 'object' &&
    typeof t.id === 'string' && !!t.id &&
    typeof t.localKey === 'string' && !!t.localKey &&
    (t.key === null || typeof t.key === 'string') &&
    typeof t.title === 'string' && typeof t.text === 'string' && typeof t.source === 'string' &&
    Array.isArray(t.repos) && Array.isArray(t.prs) && Array.isArray(t.log) &&
    PHASES.includes(t.phase as TicketPhase) &&
    typeof t.maxAgents === 'number' && typeof t.createdAt === 'number'
}

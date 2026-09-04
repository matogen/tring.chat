import { api } from './ws-client.ts'

/** Mirrors the daemon's UsageReport (packages/server/src/usage.ts). */
export interface UsageBucket {
  tokens: number
  cacheReadTokens: number
  cost: number
  messages: number
}

export interface Limit {
  label: string
  percent: number
  resets: string | null
}

export interface UsageReport {
  limits: Limit[]
  limitsError: string | null
  window: UsageBucket & { startedAt: number | null; resetsAt: number | null }
  today: UsageBucket
  week: UsageBucket
  projects: { name: string; tokens: number; cost: number }[]
  scannedAt: number
}

/* ---------- settings, per browser like the sound toggle ---------- */

const ENABLED_KEY = 'tring.usage'
const BUDGET_KEY = 'tring.usage.budgets'

export interface Budgets {
  /** Tokens allowed in one five-hour block, or null for "just show the number". */
  window: number | null
  week: number | null
}

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

const write = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private windows keep the setting for this session only.
  }
}

let enabled = read(ENABLED_KEY, false)
let budgets = read<Budgets>(BUDGET_KEY, { window: null, week: null })

export const isEnabled = (): boolean => enabled
export const getBudgets = (): Budgets => budgets

export function setEnabled(next: boolean): void {
  enabled = next
  write(ENABLED_KEY, next)
}

export function setBudgets(next: Budgets): void {
  budgets = next
  write(BUDGET_KEY, next)
}

export const fetchUsage = (): Promise<UsageReport> => api<UsageReport>('/api/usage')

/* ---------- rendering ---------- */

function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

const money = (n: number): string => `$${n.toFixed(2)}`

const clock = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/**
 * A meter, coloured by how close it is. Amber and red carry their usual
 * meaning here rather than the ring's: this view replaces the ring entirely,
 * so no status tile is on screen to be confused with. Mint stays out of it —
 * that one means a finished agent and nothing else (spec §5.1).
 */
function meter(used: number, budget: number): HTMLElement {
  const pct = Math.min(100, (used / budget) * 100)
  const wrap = el('div', 'meter')
  const fill = el('i')
  fill.style.width = `${pct}%`
  if (pct >= 90) fill.classList.add('hot')
  else if (pct >= 75) fill.classList.add('warm')
  wrap.append(fill)
  wrap.setAttribute('role', 'progressbar')
  wrap.setAttribute('aria-valuenow', String(Math.round(pct)))
  return wrap
}

export function renderUsage(root: HTMLElement, report: UsageReport | null, error: string | null): void {
  root.replaceChildren()
  const panel = el('div', 'usage')

  if (error) {
    panel.append(el('h2', undefined, 'Claude usage'))
    panel.append(el('p', 'hint', error))
    root.append(panel)
    return
  }
  if (!report) {
    panel.append(el('p', 'hint', 'asking Claude Code…'))
    root.append(panel)
    return
  }

  if (report.limits.length > 0) {
    // The real thing: Claude Code's own numbers, not an estimate.
    for (const l of report.limits) {
      panel.append(limitRow(l))
    }
    panel.append(el('p', 'source', 'from Claude Code’s own /usage'))
  } else {
    // No `claude` to ask, so fall back to counting tokens against a budget.
    const b = getBudgets()
    const w = report.window
    panel.append(budgetRow('5-hour window', w.tokens, b.window,
      w.resetsAt ? `resets ${clock(w.resetsAt)}` : 'nothing running'))
    panel.append(budgetRow('This week', report.week.tokens, b.week, 'rolling 7 days'))
    panel.append(el('p', 'source',
      (report.limitsError ?? 'Claude Code’s own limits are unavailable') +
      ' — these are counted from transcripts against the budget you set.'))
  }

  const totals = el('div', 'utotals')
  const cell = (label: string, value: string) => {
    const c = el('div', 'ucell')
    c.append(el('b', undefined, value), el('span', undefined, label))
    return c
  }
  totals.append(cell('tokens today', tokens(report.today.tokens)))
  totals.append(cell('today, est.', money(report.today.cost)))
  totals.append(cell('this week, est.', money(report.week.cost)))
  totals.append(cell('cache reads, 7d', tokens(report.week.cacheReadTokens)))
  panel.append(totals)

  if (report.projects.length > 0) {
    panel.append(el('h3', undefined, 'By project, last 7 days'))
    const most = report.projects[0]!.tokens
    const list = el('div', 'uprojects')
    for (const p of report.projects.slice(0, 8)) {
      const r = el('div', 'uproject')
      r.append(el('span', 'nm', p.name))
      r.append(meter(p.tokens, most))
      r.append(el('span', 'tag', tokens(p.tokens)))
      list.append(r)
    }
    panel.append(list)
  }

  panel.append(el('p', 'hint',
    `Token counts and costs are read from transcripts on this machine. Updated ${clock(report.scannedAt)}.`))
  root.append(panel)
}

function limitRow(l: Limit): HTMLElement {
  const r = el('div', 'urow')
  const head = el('div', 'uhead')
  head.append(el('span', 'ulabel', l.label))
  head.append(el('span', 'upct', `${l.percent}%`))
  r.append(head)
  r.append(meter(l.percent, 100))
  if (l.resets) {
    const foot = el('div', 'ufoot')
    foot.append(el('span', 'unote', `resets ${l.resets}`))
    r.append(foot)
  }
  return r
}

function budgetRow(
  label: string, used: number, budget: number | null, note?: string,
): HTMLElement {
  const r = el('div', 'urow')
  const head = el('div', 'uhead')
  head.append(el('span', 'ulabel', label))
  if (budget) head.append(el('span', 'upct', `${Math.round((used / budget) * 100)}%`))
  r.append(head)
  if (budget) r.append(meter(used, budget))
  const foot = el('div', 'ufoot')
  foot.append(el('span', undefined,
    budget ? `${tokens(used)} / ${tokens(budget)} tokens` : `${tokens(used)} tokens`))
  if (note) foot.append(el('span', 'unote', note))
  r.append(foot)
  return r
}

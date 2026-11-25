import {
  MAX_PRS, MIN_PRS, STRATEGIES, STRATEGY_FACTORS, type Plan, type PlanInterface, type PlannedPr, type SharedFile,
  type Strategy, type StrategyAdvice, type StrategyFactor, type TicketRepo,
} from '@tring/shared/workflow'

/**
 * Checks a plan the planner submitted, before it reaches the user's plan card.
 *
 * Every error is a sentence addressed to the planner, which gets them all back
 * at once as a prompt: one round to fix a plan, not one per mistake. Pure: no
 * git, no files. (Whether an added repo really is a git repository is asked
 * of git by the caller.)
 */

export interface PlanContext {
  repos: TicketRepo[]
  /** The id an added repository will have: its name, as for the ticket's own. */
  repoIdForPath: (path: string) => string
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; errors: string[] }

type Raw = Record<string, unknown>

const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter(Boolean) : [])
const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)

export function validatePlan(raw: unknown, ctx: PlanContext): PlanResult {
  if (!isObj(raw)) return { ok: false, errors: ['This is not a plan: send an object with summary, prs, interfaces, shared, deployOrder, addRepos and docs.'] }
  const rawPrs = Array.isArray(raw['prs']) ? raw['prs'] : []
  if (rawPrs.length < MIN_PRS || rawPrs.length > MAX_PRS) {
    // Nothing else is worth checking until the plan has a size that can be built.
    return { ok: false, errors: [`A plan has ${MIN_PRS} to ${MAX_PRS} PRs, not ${rawPrs.length}.`] }
  }

  const errors: string[] = []
  const addRepos = (Array.isArray(raw['addRepos']) ? raw['addRepos'] : []).filter(isObj).map((r) => ({
    path: text(r['path']),
    base: text(r['base']) || null,
    why: text(r['why']),
  }))
  for (const r of addRepos) {
    if (!r.path) errors.push('An added repo has no path.')
    else if (!r.why) errors.push(`The added repo ${r.path} needs a why: what does the ticket need from it?`)
  }
  const repoIds = [...ctx.repos.map((r) => r.id), ...addRepos.filter((r) => r.path).map((r) => ctx.repoIdForPath(r.path))]
  const repoList = repoIds.join(', ')

  if (!text(raw['summary'])) errors.push('The plan needs a summary.')

  /* ---- the PRs ---- */

  const prs: PlannedPr[] = []
  rawPrs.forEach((p, n) => {
    const r = isObj(p) ? p : {}
    const index = whole(r['index'])
    if (index === null || index < 1) {
      errors.push(`PR #${n + 1} in the list has no whole-number index (1, 2, 3…).`)
      return
    }
    const tests = isObj(r['tests']) ? r['tests'] : {}
    const pr: PlannedPr = {
      index,
      repo: text(r['repo']),
      below: r['below'] === null || r['below'] === undefined ? null : whole(r['below']) ?? -1,
      title: text(r['title']),
      scope: text(r['scope']),
      owns: texts(r['owns']),
      uses: texts(r['uses']),
      tests: { add: texts(tests['add']), run: texts(tests['run']) },
      acceptance: texts(r['acceptance']),
    }
    const me = `PR ${index}`
    if (!pr.title) errors.push(`${me} has no title.`)
    if (!pr.scope) errors.push(`${me} has no scope: say what it does and what it leaves to other PRs.`)
    if (!pr.owns.length) errors.push(`${me} owns no files: list the globs it may edit.`)
    if (!pr.tests.run.length) errors.push(`${me} has no test commands to run.`)
    if (!pr.acceptance.length) errors.push(`${me} has no acceptance criteria.`)
    if (!repoIds.includes(pr.repo)) {
      errors.push(`${me} is in repo "${pr.repo}", which the ticket does not have (${repoList}); add it under addRepos with a reason.`)
    }
    prs.push(pr)
  })

  const byIndex = new Map<number, PlannedPr>()
  for (const p of prs) {
    if (byIndex.has(p.index)) errors.push(`The index ${p.index} is used twice; every PR needs its own.`)
    else byIndex.set(p.index, p)
  }

  for (const p of prs) {
    if (p.below === null) continue
    const lower = byIndex.get(p.below)
    if (!lower) errors.push(`PR ${p.index} sits on PR ${p.below < 0 ? '?' : p.below}, and there is no such PR.`)
    else if (lower.repo !== p.repo) {
      errors.push(`PR ${p.index} cannot sit on PR ${lower.index}: it is in another repo (${lower.repo}, not ${p.repo}). Across repos, use an interface.`)
    }
  }

  /* ---- interfaces ---- */

  const interfaces: PlanInterface[] = []
  const seen = new Set<string>()
  for (const i of (Array.isArray(raw['interfaces']) ? raw['interfaces'] : []).filter(isObj)) {
    const it: PlanInterface = { name: text(i['name']), owner: whole(i['owner']) ?? -1, contract: text(i['contract']) }
    if (!it.name) { errors.push('An interface has no name.'); continue }
    if (seen.has(it.name)) { errors.push(`The interface "${it.name}" is declared twice.`); continue }
    seen.add(it.name)
    if (!byIndex.has(it.owner)) errors.push(`The interface "${it.name}" is owned by PR ${it.owner < 0 ? '?' : it.owner}, and there is no such PR.`)
    if (!it.contract) errors.push(`The interface "${it.name}" has no contract: what do its users code against?`)
    interfaces.push(it)
  }
  const ownerOf = new Map(interfaces.map((i) => [i.name, i.owner]))
  for (const p of prs) {
    for (const u of p.uses) {
      const owner = ownerOf.get(u)
      if (owner === undefined) errors.push(`PR ${p.index} uses "${u}", and there is no such interface.`)
      else if (owner === p.index) errors.push(`PR ${p.index} uses "${u}", which is its own interface.`)
    }
  }

  /* ---- what waits on what ---- */

  const waitsOn = new Map<number, number[]>(prs.map((p) => [p.index, [
    ...(p.below !== null && byIndex.get(p.below)?.repo === p.repo ? [p.below] : []),
    ...p.uses.map((u) => ownerOf.get(u)).filter((o): o is number => o !== undefined && o !== p.index && byIndex.has(o)),
  ]]))
  for (const circle of circles(waitsOn)) {
    errors.push(`These PRs wait on each other in a circle (through below or uses): ${circle.join(', ')}. Break it.`)
  }

  /* ---- ownership ---- */

  for (let a = 0; a < prs.length; a++) {
    for (let b = a + 1; b < prs.length; b++) {
      const pa = prs[a]!
      const pb = prs[b]!
      if (pa.repo !== pb.repo) continue
      for (const ga of pa.owns) {
        for (const gb of pb.owns) {
          if (!overlap(ga, gb)) continue
          const [lo, hi] = pa.index < pb.index ? [pa, pb] : [pb, pa]
          const files = ga === gb ? `"${ga}"` : `files matching "${ga}" and "${gb}"`
          errors.push(`PR ${lo.index} and PR ${hi.index} both own ${files} in ${pa.repo}: give it to one of them, and list it under shared if the other needs it.`)
        }
      }
    }
  }

  const shared: SharedFile[] = []
  for (const s of (Array.isArray(raw['shared']) ? raw['shared'] : []).filter(isObj)) {
    const f: SharedFile = { repo: text(s['repo']), path: text(s['path']), owner: whole(s['owner']) ?? -1, why: text(s['why']) }
    const owner = byIndex.get(f.owner)
    if (!f.path) { errors.push('A shared file has no path.'); continue }
    if (!owner) errors.push(`The shared file ${f.path} is owned by PR ${f.owner < 0 ? '?' : f.owner}, and there is no such PR.`)
    else if (owner.repo !== f.repo || !owner.owns.some((g) => matches(g, f.path))) {
      errors.push(`The shared file ${f.path} (${f.repo}) is given to PR ${f.owner}, but PR ${f.owner} does not own it; add it to that PR's owns.`)
    }
    shared.push(f)
  }

  /* ---- shipping and docs ---- */

  let deployOrder: string[] | null = null
  if (Array.isArray(raw['deployOrder'])) {
    deployOrder = texts(raw['deployOrder'])
    const counted = new Set<string>()
    for (const id of deployOrder) {
      if (!repoIds.includes(id)) errors.push(`The deploy order names "${id}", which is not one of this ticket's repos (${repoList}).`)
      else if (counted.has(id)) errors.push(`The deploy order names "${id}" twice.`)
      counted.add(id)
    }
  }

  let docs: Plan['docs'] = { none: '' }
  const d = isObj(raw['docs']) ? raw['docs'] : {}
  if (Array.isArray(d['files'])) {
    const files = d['files'].filter(isObj).map((f) => ({ repo: text(f['repo']), path: text(f['path']) })).filter((f) => f.path)
    for (const f of files) {
      if (!repoIds.includes(f.repo)) errors.push(`The docs file ${f.path} is in repo "${f.repo}", which the ticket does not have.`)
    }
    if (!files.length) errors.push('The docs list is empty: say which files change, or why none do (docs: { none: "…" }).')
    docs = { files }
  } else {
    const why = text(d['none'])
    if (!why) errors.push('Say which docs files change (docs: { files: […] }), or why none do (docs: { none: "…" }).')
    docs = { none: why }
  }

  /* ---- the strategy it recommends ---- */

  const advice = readAdvice(raw['advice'], errors)

  if (errors.length || !advice) return { ok: false, errors }
  const plan: Plan = {
    version: whole(raw['version']) ?? 1,
    summary: text(raw['summary']),
    prs: [...prs].sort((a, b) => a.index - b.index),
    shared,
    interfaces,
    deployOrder,
    addRepos,
    docs,
    advice,
  }
  const misfit = fits(plan, advice.recommended)
  if (misfit.length) {
    return {
      ok: false,
      errors: [`The advice recommends ${NAMES[advice.recommended]}, which this plan does not fit: ${misfit.join(' ')} Change the plan or the recommendation.`],
    }
  }
  return { ok: true, plan }
}

const NAMES: Record<Strategy, string> = { independent: 'independent PRs', stacked: 'stacked PRs', single: 'a single PR' }

const FACTOR_HINT: Record<StrategyFactor, string> = {
  coupling: 'how much the units depend on each other.',
  overlap: 'whether they need the same files.',
  size: 'how big the change is, in all and per unit.',
  repos: 'how many repos it spans.',
  review: 'what reviewing it would take.',
  shipping: 'whether parts could ship on their own.',
}

function readAdvice(raw: unknown, errors: string[]): StrategyAdvice | null {
  if (!isObj(raw)) {
    errors.push('Recommend a strategy: advice: { recommended, factors: [{ factor, note, favours }], means: { independent, stacked, single } }.')
    return null
  }
  const recommended = text(raw['recommended']) as Strategy
  if (!STRATEGIES.includes(recommended)) errors.push(`advice.recommended is independent, stacked or single, not "${text(raw['recommended'])}".`)
  const factors = (Array.isArray(raw['factors']) ? raw['factors'] : []).filter(isObj).map((f) => ({
    factor: text(f['factor']) as StrategyFactor,
    note: text(f['note']),
    favours: STRATEGIES.includes(text(f['favours']) as Strategy) ? text(f['favours']) as Strategy : null,
  })).filter((f) => STRATEGY_FACTORS.includes(f.factor))
  for (const name of STRATEGY_FACTORS) {
    const f = factors.filter((x) => x.factor === name)
    if (!f.length || !f[0]!.note) errors.push(`advice.factors needs one line on ${name}: ${FACTOR_HINT[name]}`)
    else if (f.length > 1) errors.push(`advice.factors has ${name} more than once.`)
  }
  const m = isObj(raw['means']) ? raw['means'] : {}
  const means = {} as Record<Strategy, string>
  for (const s of STRATEGIES) {
    means[s] = text(m[s])
    if (!means[s]) errors.push(`advice.means.${s}: say in a line what ${NAMES[s]} would mean for this ticket.`)
  }
  const ordered = STRATEGY_FACTORS.map((n) => factors.find((f) => f.factor === n)).filter((f) => f !== undefined)
  return { recommended, factors: ordered, means }
}

/**
 * Why `plan` cannot be landed as `strategy` as it stands; empty when it can.
 * Stacked and single PRs take any valid plan. Independent PRs each branch off
 * the base, so no unit may sit on another or use an interface from another
 * in its own repo (across repos an interface is fine: each ships alone).
 */
export function fits(plan: Plan, strategy: Strategy): string[] {
  if (strategy !== 'independent') return []
  const out: string[] = []
  for (const p of plan.prs) {
    if (p.below !== null) {
      out.push(`PR ${p.index} sits on PR ${p.below}.`)
      continue
    }
    for (const u of p.uses) {
      const owner = plan.interfaces.find((i) => i.name === u)?.owner
      const o = owner !== undefined ? plan.prs.find((x) => x.index === owner) : undefined
      if (o && o.index !== p.index && o.repo === p.repo) out.push(`PR ${p.index} uses ${u} from PR ${o.index} in the same repo.`)
    }
  }
  return out
}

/** Each circle in a "waits on" graph once, as the PRs in it, lowest first. */
function circles(edges: Map<number, number[]>): number[][] {
  const out = new Map<string, number[]>()
  const walk = (at: number, path: number[]): void => {
    const loop = path.indexOf(at)
    if (loop >= 0) {
      const circle = path.slice(loop).sort((a, b) => a - b)
      out.set(circle.join(','), circle)
      return
    }
    for (const next of edges.get(at) ?? []) walk(next, [...path, at])
  }
  for (const start of edges.keys()) walk(start, [])
  return [...out.values()]
}

/* ---------- globs ---------- */

/** `**` any depth, `*` within one directory, `?` one character; everything else literal. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** Whether `path` (relative to its repo, forward slashes) is covered by `glob`. */
export function matches(glob: string, path: string): boolean {
  return globToRegExp(norm(glob)).test(norm(path))
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')

/** A path the glob covers, for asking whether another glob covers it too. */
const sample = (glob: string): string =>
  norm(glob).replace(/\*\*\/?/g, 'x/y/').replace(/\*/g, 'x').replace(/\?/g, 'x').replace(/\/$/, '/z')

/**
 * Whether two globs can cover one file. Not a full intersection: each is
 * tried on a path the other covers, which catches a directory and a file in
 * it, and two spellings of one tree. The ownership hook decides edits by the
 * PR's own globs either way.
 */
export function overlap(a: string, b: string): boolean {
  return norm(a) === norm(b) || matches(a, sample(b)) || matches(b, sample(a))
}

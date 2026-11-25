import { describe, it, expect } from 'vitest'
import type { Plan, PlannedPr, TicketRepo } from '@tring/shared/workflow'
import { fits, validatePlan } from '../src/workflow/plan.ts'
import { advice } from './workflow-advice.ts'

const repos: TicketRepo[] = [
  { id: 'api', root: '/src/api', baseBranch: 'develop' },
  { id: 'web', root: '/src/web', baseBranch: 'develop' },
]
const ctx = { repos, repoIdForPath: (p: string) => p.split('/').pop()! }

const pr = (over: Partial<PlannedPr> & Pick<PlannedPr, 'index'>): PlannedPr => ({
  repo: 'api', below: null, title: `PR ${over.index}`, scope: 'something small', owns: [`pr${over.index}/**`],
  uses: [], tests: { add: [`test/pr${over.index}.test.ts`], run: ['npm test'] }, acceptance: ['it works'],
  ...over,
})

/** Schema → API in one repo, UI in another coding against the API. */
function plan(over: Partial<Plan> = {}): Plan {
  return {
    version: 1,
    summary: 'Orders: table, endpoint, page',
    prs: [
      pr({ index: 1, title: 'Orders table', owns: ['db/**'] }),
      pr({ index: 2, below: 1, title: 'Orders API', owns: ['src/routes/orders.ts', 'test/orders.test.ts'], uses: ['OrdersTable'] }),
      pr({ index: 3, repo: 'web', title: 'Orders page', owns: ['src/orders/**'], uses: ['OrdersApi'] }),
    ],
    shared: [],
    interfaces: [
      { name: 'OrdersTable', owner: 1, contract: 'orders(id uuid, total cents)' },
      { name: 'OrdersApi', owner: 2, contract: 'GET /orders -> Order[]' },
    ],
    deployOrder: ['api', 'web'],
    addRepos: [],
    docs: { none: 'internal feature, no user docs' },
    advice: advice('stacked'),
    ...over,
  }
}

const errorsOf = (raw: unknown): string[] => {
  const r = validatePlan(raw, ctx)
  return r.ok ? [] : r.errors
}

describe('validatePlan', () => {
  it('accepts a plan of lanes across two repos with interfaces between them', () => {
    const r = validatePlan(plan(), ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.plan.prs.map((p) => p.index)).toEqual([1, 2, 3])
  })

  it('takes 1 to 16 PRs', () => {
    expect(errorsOf(plan({ prs: [] }))).toEqual([expect.stringMatching(/1 to 16 PRs/)])
    const one = plan({ prs: [pr({ index: 1 })], interfaces: [], deployOrder: null })
    expect(errorsOf(one)).toEqual([])
    const many = [...Array(17)].map((_, i) => pr({ index: i + 1 }))
    expect(errorsOf(plan({ prs: many, interfaces: [], deployOrder: null }))).toEqual([expect.stringMatching(/1 to 16 PRs, not 17/)])
  })

  it('says which PR is missing what, all at once', () => {
    const bad = plan({ prs: [pr({ index: 1, title: ' ', owns: [], tests: { add: [], run: [] }, acceptance: [] })], interfaces: [], deployOrder: null })
    const errors = errorsOf(bad)
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/PR 1.*title/),
      expect.stringMatching(/PR 1.*owns no files/),
      expect.stringMatching(/PR 1.*no test commands/),
      expect.stringMatching(/PR 1.*acceptance criteria/),
    ]))
  })

  it('refuses two PRs with the same index', () => {
    const p = plan()
    p.prs[2] = { ...p.prs[2]!, index: 2 }
    expect(errorsOf(p)).toContainEqual(expect.stringMatching(/index 2 is used twice/))
  })

  it('refuses a repo the ticket does not have', () => {
    const p = plan()
    p.prs[2] = { ...p.prs[2]!, repo: 'mobile' }
    expect(errorsOf(p)).toContainEqual(expect.stringMatching(/PR 3.*repo "mobile"/))
  })

  it('accepts a repo the plan adds, under its name', () => {
    const p = plan({ addRepos: [{ path: '/src/mobile', base: null, why: 'the app shows orders too' }] })
    p.prs[2] = { ...p.prs[2]!, repo: 'mobile' }
    expect(errorsOf(p)).toEqual([])
    const noWhy = plan({ addRepos: [{ path: '/src/mobile', base: null, why: '' }] })
    expect(errorsOf(noWhy)).toContainEqual(expect.stringMatching(/\/src\/mobile.*why/))
  })

  it('stacks a PR only on one in its own repo, and never in a circle', () => {
    const cross = plan()
    cross.prs[2] = { ...cross.prs[2]!, below: 2 }
    expect(errorsOf(cross)).toContainEqual(expect.stringMatching(/PR 3.*cannot sit on PR 2.*another repo/))

    const unknown = plan()
    unknown.prs[1] = { ...unknown.prs[1]!, below: 9 }
    expect(errorsOf(unknown)).toContainEqual(expect.stringMatching(/PR 2.*PR 9.*no such PR/))

    const circle = plan()
    circle.prs[0] = { ...circle.prs[0]!, below: 2 }
    expect(errorsOf(circle)).toContainEqual(expect.stringMatching(/circle.*1.*2/))
  })

  it('refuses two PRs of one repo owning the same file', () => {
    const p = plan()
    p.prs[1] = { ...p.prs[1]!, owns: ['db/migrations/002.sql', 'src/routes/orders.ts'] }
    expect(errorsOf(p)).toContainEqual(expect.stringMatching(/PR 1 and PR 2 both own.*db\/migrations\/002\.sql/))

    const same = plan()
    same.prs[1] = { ...same.prs[1]!, owns: ['db/**'] }
    expect(errorsOf(same)).toContainEqual(expect.stringMatching(/PR 1 and PR 2 both own/))
  })

  it('lets PRs in different repos own the same paths', () => {
    const p = plan()
    p.prs[2] = { ...p.prs[2]!, owns: ['db/**'] }
    expect(errorsOf(p)).toEqual([])
  })

  it('gives a shared file to one owner, which must own it, and to no one else', () => {
    const good = plan({ shared: [{ repo: 'api', path: 'db/schema.ts', owner: 1, why: 'the API reads the types' }] })
    expect(errorsOf(good)).toEqual([])

    const notOwned = plan({ shared: [{ repo: 'api', path: 'src/app.ts', owner: 1, why: 'route registration' }] })
    expect(errorsOf(notOwned)).toContainEqual(expect.stringMatching(/src\/app\.ts.*PR 1 does not own it/))

    const p = plan({ shared: [{ repo: 'api', path: 'db/schema.ts', owner: 1, why: 'types' }] })
    p.prs[1] = { ...p.prs[1]!, owns: [...p.prs[1]!.owns, 'db/schema.ts'] }
    expect(errorsOf(p)).toContainEqual(expect.stringMatching(/PR 1 and PR 2 both own.*db\/schema\.ts/))
  })

  it('checks every interface: a known owner, a contract, one name, and real users', () => {
    const p = plan({
      interfaces: [
        { name: 'OrdersTable', owner: 1, contract: 'orders(id uuid)' },
        { name: 'OrdersTable', owner: 2, contract: 'again' },
        { name: 'OrdersApi', owner: 7, contract: '' },
      ],
    })
    const errors = errorsOf(p)
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/interface "OrdersTable" is declared twice/),
      expect.stringMatching(/interface "OrdersApi".*PR 7/),
      expect.stringMatching(/interface "OrdersApi".*contract/),
    ]))

    const unknown = plan()
    unknown.prs[2] = { ...unknown.prs[2]!, uses: ['Payments'] }
    expect(errorsOf(unknown)).toContainEqual(expect.stringMatching(/PR 3 uses "Payments".*no such interface/))

    const own = plan()
    own.prs[0] = { ...own.prs[0]!, uses: ['OrdersTable'] }
    expect(errorsOf(own)).toContainEqual(expect.stringMatching(/PR 1 uses "OrdersTable".*its own/))
  })

  it('refuses a circle through interfaces', () => {
    // PR 1 waits for PR 2's interface, and PR 2 sits on PR 1.
    const p = plan()
    p.prs[0] = { ...p.prs[0]!, uses: ['OrdersApi'] }
    expect(errorsOf(p)).toContainEqual(expect.stringMatching(/circle/))
  })

  it('keeps the deploy order to the ticket\'s repos, each once', () => {
    expect(errorsOf(plan({ deployOrder: ['api', 'mobile'] }))).toContainEqual(expect.stringMatching(/deploy order.*"mobile"/))
    expect(errorsOf(plan({ deployOrder: ['api', 'api', 'web'] }))).toContainEqual(expect.stringMatching(/deploy order.*"api" twice/))
  })

  it('needs the docs to change, or a reason why none do', () => {
    expect(errorsOf(plan({ docs: { none: '' } }))).toContainEqual(expect.stringMatching(/docs/))
    expect(errorsOf(plan({ docs: { files: [{ repo: 'api', path: 'README.md' }] } }))).toEqual([])
    expect(errorsOf(plan({ docs: { files: [{ repo: 'nope', path: 'README.md' }] } }))).toContainEqual(expect.stringMatching(/docs.*"nope"/))
  })

  it('answers junk with errors instead of throwing', () => {
    expect(errorsOf(null)).toEqual([expect.stringMatching(/not a plan/)])
    expect(errorsOf({ prs: 'lots' })).toContainEqual(expect.stringMatching(/1 to 16 PRs/))
    expect(errorsOf({ ...plan(), prs: [{ index: 'one' }] })).toContainEqual(expect.stringMatching(/index/))
  })
})

describe('the planner’s strategy advice', () => {
  it('needs a recommendation, all six factors with a note, and what each strategy would mean', () => {
    expect(errorsOf(plan({ advice: undefined }))).toEqual([expect.stringMatching(/advice/)])
    const a = advice('stacked')
    const missing = { ...a, factors: a.factors.filter((f) => f.factor !== 'review'), means: { ...a.means, single: ' ' } }
    const errors = errorsOf(plan({ advice: missing }))
    expect(errors).toContainEqual(expect.stringMatching(/review/))
    expect(errors).toContainEqual(expect.stringMatching(/single/))
    expect(errorsOf(plan({ advice: { ...a, recommended: 'sideways' as never } }))).toContainEqual(expect.stringMatching(/independent, stacked or single/))
  })

  it('keeps the advice with the plan', () => {
    const r = validatePlan(plan(), ctx)
    expect(r.ok && r.plan.advice).toEqual(advice('stacked'))
  })

  it('refuses a recommendation the plan does not fit, saying why', () => {
    expect(errorsOf(plan({ advice: advice('independent') }))).toEqual([
      expect.stringMatching(/recommends independent PRs.*PR 2 sits on PR 1/s),
    ])
  })
})

describe('fits', () => {
  const independent = plan({
    prs: [
      pr({ index: 1, title: 'Orders table', owns: ['db/**'] }),
      pr({ index: 2, title: 'Audit log', owns: ['src/audit/**'] }),
      pr({ index: 3, repo: 'web', title: 'Orders page', owns: ['src/orders/**'], uses: ['OrdersTable'] }),
    ],
    interfaces: [{ name: 'OrdersTable', owner: 1, contract: 'orders(id uuid)' }],
  })

  it('fits any plan as stacked or as a single PR', () => {
    for (const p of [plan(), independent]) {
      expect(fits(p, 'stacked')).toEqual([])
      expect(fits(p, 'single')).toEqual([])
    }
  })

  it('fits independent PRs only when no unit builds on another in its repo', () => {
    expect(fits(independent, 'independent')).toEqual([])
    expect(fits(plan(), 'independent')).toEqual([expect.stringMatching(/PR 2 sits on PR 1/)])
    const sameRepoUse = plan({
      prs: [pr({ index: 1, owns: ['db/**'] }), pr({ index: 2, owns: ['src/**'], uses: ['OrdersTable'] })],
      interfaces: [{ name: 'OrdersTable', owner: 1, contract: 'x' }], deployOrder: null,
    })
    expect(fits(sameRepoUse, 'independent')).toEqual([expect.stringMatching(/PR 2 uses OrdersTable from PR 1 in the same repo/)])
  })
})

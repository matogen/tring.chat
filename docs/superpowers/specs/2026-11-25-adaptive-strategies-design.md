# Multi-PR workflow: adaptive strategies (design)

Status: **design, not built** (2026-11-25). Builds on `2026-11-25-multi-pr-workflow-design.md`
(branch `feat/multi-pr-workflow`). Nothing here is implemented until the owner says go.

The ask: stacked PRs are one way to land a ticket, not the only one. Each ticket can be landed as
**independent PRs**, **stacked PRs** or **a single PR of several agent-made commits**. The planner
recommends one with its reasons, and the user picks one on the plan card every time. The review gate, file
ownership and tests-before-review hold for all three.

## 1. Research

Primary sources only; anything else is marked. "Local" means the pstack plugin installed at
`~/.claude/plugins/cache/cursor-plugins/pstack/0.15.42` (commit `bf0c7cd`, from
[cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack)).

### pstack (Lauren Tan)

- **Strategy follows dependency.** `autopilot-full`: "Run owners in parallel off trunk, never stacked, so
  each PR lands on its own." `autopilot-stack`: "Stack a PR only when it builds on another PR."
  (local `skills/poteto-mode/playbooks/`). Independent is the default shape; stacking is the exception.
- **Small, ordered commits.** `opening-a-pr.md`: "Prefer five narrow PRs to one large PR", and each commit
  is "a future PR: landable, ordered to tell the story". Principle `sequence-verifiable-units`: every unit
  ends in a verifiable state.
- **Roles.** A coordinator that never writes code ("You run the program, never the code",
  `orchestrate.md`), one owner per PR who is the only writer of its branch, verifiers who are never the
  author, and read-only judges/reviewers.
- **Model per role.** `setup-pstack` writes `~/.claude/rules/pstack-models.md` mapping roles (feature work,
  bug fixes, swarm workers, review panels…) to a model and effort, scaled by a budget. Reason in the README:
  every model has strengths; a review panel mixes models so it stays diverse.
- **Review.** A change is blocked "only for a problem you can show, with a failing run at the head or a doc
  line the PR made wrong", and a problem the base already has does not block (`autopilot-full.md` step 4).
  A verdict covers a patch: after a rebase, compare `git patch-id` before trusting an old verdict
  (`shipping.md` step 3). Two retries per unit, then replan (`orchestrate.md`).
- **Shared state.** "Instructions and conventions are not concurrency control": remove the shared write
  target first (per-actor files or branches), serialize only what is left
  (`principle-separate-before-serializing-shared-state`). Pitfall #1 in `10-recipes-and-pitfalls.md`:
  parallel agents in one worktree.
- **Planning.** README: "i don't believe in planning. the best spec is code". When a plan is written
  (`multi-phase-plan.md`), it has one section per PR: depends on, files, build, verify, review gate, merge.
- **Not in pstack:** a deterministic coordinator (its coordinators are LLM chats following playbooks) and a
  "one PR from several agents' commits" strategy.
- Lauren Tan's GitHub profile now lists `@xai-org` ([api.github.com/users/poteto](https://api.github.com/users/poteto)).
  Her X article "Loops You Can Trust" and her talk could not be fetched (X refuses automated reads);
  second-hand summaries ([redreamality.com](https://redreamality.com/blog/lauren-tan-poteto-trust-before-parallel/))
  say "throughput comes from trust, not more agents". **Unconfirmed** from her own words.

### xAI / Grok

- **Published:** Grok Build runs subagents in parallel "in their own worktrees", with a plan you approve,
  comment on or rewrite first ([x.ai/news/grok-build-cli](https://x.ai/news/grok-build-cli)). Its
  Workflows fan a task out over many agents with "independent skeptics verifying every finding"
  ([x.ai/news/workflows](https://x.ai/news/workflows)). The Grok Bot engineering guide describes bots that
  each own an area and auto-merge a PR only when review confidence is high and blast radius low
  ([x.ai/bot/guides/grok-bot-for-engineering](https://x.ai/bot/guides/grok-bot-for-engineering)); that page
  is product marketing.
- **Unconfirmed:** how the Grok/xAI team itself splits work into PRs or whether it stacks. Nothing primary
  says so; third-party articles only restate product features.

### Other practice

- **Google, Small CLs** ([eng-practices](https://google.github.io/eng-practices/review/developer/small-cls.html)):
  about 100 lines is reasonable and 1000 usually too large; split by stacking, by files, horizontally
  (layers with stubs) or vertically (full-stack slices); keep tests with the change; never break the build
  between dependent CLs.
- **GitHub stacked PRs**, generally available 2026-10-06
  ([changelog](https://github.blog/changelog/2026-10-06-stacked-pull-requests-generally-available)): a stack
  lands through the merge queue as one group; approvals on unchanged code survive rebases. GitHub's guide
  for AI-written stacks: design layers by dependency, get the bottom layer right first, fix feedback in the
  layer it belongs to, rebase upward ([docs](https://docs.github.com/en/copilot/tutorials/stack-ai-generated-code-in-pull-requests)).
- **Merge queues** test a temporary branch of base plus the PRs ahead, and evict a failing one
  ([GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue),
  [Graphite](https://graphite.com/docs/graphite-merge-queue)).
- **Claude Code agent teams** ([docs](https://code.claude.com/docs/en/agent-teams)): for sequential work,
  same-file edits or many dependencies a single session is better; two teammates on one file overwrite each
  other, so give each its own files; approve a plan before implementing; 3–5 teammates is a good start.

### What tring borrows (and what not)

| Borrow | From | Where in this design |
| --- | --- | --- |
| Pick the shape from the dependency graph; stack only on a real dependency | pstack autopilot-full/-stack, Claude Code agent teams, Google | §3 rubric, §4 |
| Small units, each ending green; ordered commits that tell the story | pstack opening-a-pr, sequence-verifiable-units, Google | §4 single PR, §3 size factor |
| One integration mechanism: base + the tips, tested together | merge queues | §5 |
| A verdict covers a patch: `git patch-id` decides whether a review survives a rebase | pstack shipping | §6 |
| A finding holds only with proof; problems already on the base never hold | pstack autopilot-full | §6 |
| Model and effort per role | pstack setup-pstack | §7 settings |
| Every writer has its own worktree; a coordinator never writes code | pstack, Grok Build, Claude Code | unchanged, and kept for single PR |

Not borrowed, with reasons: **auto-merge** (Grok Bot) — tring never merges (decision Q5); **an LLM
coordinator** (pstack) — rules stay in the stack engine, because instructions are not concurrency
control; **open PRs ready, not draft** (pstack) — drafts stay the default (Q4); **best-of-N arena runs** —
they multiply quota for one unit; **GitHub native stacks** (`gh stack`) — attractive on GitHub, but
Bitbucket has no equivalent, so tring keeps one retargeting path for both; later option.

## 2. Decisions taken in this design

The owner asked for design calls to be made here with reasons, not as questions.

| # | Decision | Why |
| --- | --- | --- |
| A1 | One model: a ticket is **units** (one agent, one worktree, owned files, tests, a reviewer). The strategy only decides how units become branches and PRs. | Ownership, review, tests and agent limits stay one code path for all three; only branching, assembly, push and merge differ. |
| A2 | The user picks the strategy on every plan card, in a strategy picker above one **Approve plan** button; the settings default only pre-selects. No "planner may override" switch. | The owner's rule, and the layout the owner chose (2026-11-25) over three approve buttons: "Approve" stays one clear go. With the choice always shown, an override switch would only hide the planner's advice. |
| A3 | The planner always recommends, with one line per factor (coupling, file overlap, size, repos, review load, shipping separately) and one line per strategy on what it would mean here. | The owner asked for reasons; per-strategy lines make the other two buttons informed choices. |
| A4 | The plan is shaped once. Stacked and single fit any valid plan; independent fits only a plan with no `below` and no `uses` inside one repo. Choosing a strategy that does not fit sends the planner back to re-plan for it. | Converting stacked → single or independent → anything is mechanical; independent needs units that do not depend on each other. |
| A5 | **One integration check** for all three: per repo, `origin/<base>` merged with every tip, tested by a read-only integrator agent. It replaces the lane check. | Merge-queue practice; for a single lane the merge is its top, so the lane check was a special case of this. |
| A6 | Single PR: each unit still has its **own worktree and local branch**; tring assembles one branch with **one commit per unit**, in dependency order. Agents never share a worktree. | pstack pitfall #1 and Claude Code's same-file overwrite warning; one commit per unit is the owner's "ordered green commits". |
| A7 | Independent PRs merge into the base by default; a **final combined PR** (unit PRs into `feature/<KEY>`, then one PR into the base) is a setting and a plan-card toggle. | The owner asked for it as an option. |
| A8 | Reviews survive a rebase when `git patch-id --stable` of the unit's diff is unchanged; otherwise a fresh review. Replaces the range-diff check. | pstack shipping step 3; standard, cheaper and exact. |
| A9 | A held finding needs proof (a failing command, or a line the unit changed); a problem already on the base never holds and goes to a follow-ups list. | pstack's blocking rule; cuts review churn without lowering the bar. |
| A10 | Model and effort per role (planner, coder, reviewer, integrator), default "Claude Code's default". | pstack; the CLI takes `--model` (aliases `fable`, `opus`, `sonnet`) and `--effort` (low…max). No surprise cost: unset means unchanged. |
| A11 | Tickets saved before this change load as `stacked`. | They were built as stacks. |
| A12 | Cross-repo end-to-end checks stay out of scope (`integrationCheck` covers one repo's units together). | Each repo's test suite is what tring can run; cross-repo e2e needs per-project setup. |

## 3. Strategy selection

1. `start_ticket` as today. The planner brief gains the three strategies, the default from Settings, and
   this rubric:
   - **Independent** when units do not depend on each other (no `below`, no shared interfaces in one repo)
     and could ship in any order: parallel full-stack slices, unrelated fixes, separate repos.
   - **Stacked** when units build on each other: schema → API → UI, a refactor then the feature on it.
     Units that do not depend on anything still sit side by side on the base.
   - **Single PR** when the change is tightly coupled (most units touch the same files or must land
     together), small overall (about 400 changed lines or less), or one PR per ticket is wanted.
   - Size: aim for units of 100–400 changed lines (Google's "100 is reasonable, 1000 too large").
2. `submit_plan` gains `advice`:
   ```ts
   advice: {
     recommended: 'independent' | 'stacked' | 'single'
     factors: Array<{ factor: 'coupling' | 'overlap' | 'size' | 'repos' | 'review' | 'shipping'; note: string; favours: Strategy | null }>
     means: Record<Strategy, string>   // "Stacked: 3 PRs, API waits on the table; merge bottom up."
   }
   ```
   Validation: all six factors, a `means` line for each strategy, and `recommended` must fit the plan (A4).
3. The plan card shows the advice, then a **strategy picker** and the card's buttons (decided 2026-11-25):
   ```
   Strategy:  ( ) Independent   (•) Stacked ★ recommended   ( ) Single PR
   [Approve plan]   [Revise…]   [Cancel]
   ```
   The planner's pick carries "★ recommended". The pre-selected one is the Settings default, or the
   planner's pick under Auto. Picking only changes the card in the browser; **Approve plan** sends the
   picked strategy with the approval. A strategy the plan does not fit reads `Independent (re-plans)`,
   and with it picked the button reads **Re-plan as independent**: the planner gets a revise note and the
   card comes back with the new plan and the same picker. With Independent picked, a `Final combined PR`
   checkbox shows. The agents slider stays.
   Card model: `InboxAction` gains `choices: { value, label, recommended?, misfit? }[]` with a selected
   `value`; the `action` message already carries `value`, now also a string.
4. `ticket_action approve` takes `strategy` (and `combined`), so the orchestrator can relay "approve it as a
   single PR". Approval records `Ticket.strategy`; nothing starts before.

## 4. The three strategies

| | Independent PRs | Stacked PRs | Single PR, agent commits |
| --- | --- | --- | --- |
| Unit branch | off `origin/<base>` | off the unit below, else the base | local only (`tring/<KEY>-n`), off the unit it depends on, else the base |
| Parallel work | all units at once | units with interfaces first; uppers code against contracts | same as stacked, per unit worktree |
| Review | per unit, fresh reviewer | per unit | per unit (the commit it becomes) |
| What is pushed | one PR per unit → base (or → `feature/<KEY>`) | one PR per unit → the branch below | one branch per repo, one commit per unit, one PR |
| Merge order | any | bottom up | one merge |
| After a merge | nothing to retarget | restack above, push on click, retarget | done |
| Conflict between units | prevented by ownership; detected by `merge-tree` between tips. Card: **Stack B on A** (B rebases on A and becomes stacked) or **Ask A's owner** (`request_change`) | prevented by ownership; the upper unit rebases on the lower (as built) | prevented by ownership; an assembly conflict has the later unit rebase onto the assembled branch, then tring reassembles |
| Base moved | per unit `merge-tree`; only a conflicting unit is offered **Update** (rebase on base). No cascade | lane root offered **Update lane**; restack cascades up | tring reassembles on the new base (mechanical, no agent) |
| Integration check | base + every unit tip | base + every lane top | the assembled branch: each unit's tests at its own commit, the full suite at the top |
| Push gate | review-clean + integration passing + your click | as built + integration passing | every unit review-clean + integration passing + one click |

Single PR assembly (tring, no agent): in a reusable worktree at `origin/<base>`, for each unit in
dependency order, `cherry-pick` the unit's commits and squash them into one commit titled with the unit's
title, body from its scope and acceptance criteria. A commit whose tree equals its unit's reviewed tree
is already verified; any other is checked by the integrator at that commit.

Final combined PR (independent, optional): on the first Push, tring creates `feature/<KEY>-<slug>` from
the base (pushed with that click), unit PRs target it, and once every unit is merged into it the feature
card offers **Open final PR**; tring opens it into the base and follows it like any other.

## 5. Integration check

- When: for a repo once every unit in it is review-clean (or after any tip or the base moves, while they
  still are). Gates pushing when `integrationCheck` is on (the default).
- How: `merge-tree --write-tree` first (no worktree); on a clean result, tring checks the merge out in the
  repo's integration worktree (`<repo>.worktrees/tring-<KEY>-integration`, detached) and opens an
  **integrator** tile there. Read-only (the hook denies edits and pushes). It runs every unit's
  `tests.run` plus the repo's full suite and calls `report_integration { sha, passed, evidence, failures:
  [{ test, unit? }] }`; tring checks `sha` is the merge it built.
- Failing: a card per failure, routed to the unit that owns the failing test file (Fix / Skip with
  reason), else a blocked card for the user. Conflict: the conflict card from §4.

## 6. Review changes that apply to all three

- `Review.patchId`: the patch the verdict covers. After a rebase, the same patch-id keeps the review; a
  different one sends the unit back to `tests-passing` for a fresh review.
- `Finding.proof` (required for high/medium) and `Finding.preExisting`. A pre-existing finding never
  holds; it lands in `Ticket.followUps`, listed on the feature card and in the ticket file.

## 7. Data model (`packages/shared/src/workflow.ts`)

```ts
export type Strategy = 'independent' | 'stacked' | 'single'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AgentRole = 'planner' | 'coder' | 'reviewer' | 'integrator'

interface WorkflowSettings {
  // …as now, plus:
  defaultStrategy: 'auto' | Strategy            // 'auto': the planner's pick is pre-selected
  combinedPr: boolean                           // independent: a final combined PR by default (false)
  integrationCheck: boolean                     // now real; default true
  models: Record<AgentRole, { model: string | null; effort: Effort | null }>   // null: Claude Code's default
}

interface Plan { /* …as now */ advice: StrategyAdvice }

interface Ticket {
  // …as now, plus:
  strategy: Strategy | null                     // set on approval; old tickets load as 'stacked'
  combinedPr: boolean
  integration: Record<string, Integration>      // by repo id
  combined: Record<string, CombinedPr>          // single PR, or independent's final PR, by repo id
  followUps: Array<{ pr: number; summary: string }>
}

interface Integration {
  status: 'waiting' | 'conflict' | 'running' | 'passing' | 'failing'
  base: string                                  // sha of origin/<base> it used
  tips: Record<number, string>                  // unit -> head it used
  sha: string | null                            // the merge (or assembled head) tested
  conflict: { units: number[]; files: string[] } | null
  evidence: string | null
}

interface CombinedPr {
  branch: string; base: string; units: number[]
  commits: Array<{ unit: number; sha: string; verified: boolean }>
  status: 'local' | 'pushed' | 'merged'; prUrl: string | null
}

// StackPr: review.patchId; Finding.proof, Finding.preExisting. Unit statuses stay the same;
// in a single PR a unit's 'pushed'/'merged' mean its commit is in the pushed/merged combined PR.
// TicketView gains strategy, integration and combined, for the work view.
```

Engine: new events `integration`, `assembled`, `combinedPushed`; actions `approve` with a strategy value,
`combined`, `stack-on:<a>:<b>`, `open-final`; commands `integrate {repo}`, `assemble {repo}`,
`openFinal {repo}`. `schedule` branches on `t.strategy` for worktree origin, push and restack; everything
else is shared. Git (`StackGit`): `integrate(repo, base, tips)`, `assemble(repo, base, units)`,
`patchId(worktree, from, to)`. Runner: the integrator role, `report_integration`, model/effort flags per
role on every tile it launches.

## 8. UI

- **Plan card:** the advice (recommended strategy, six factor lines, what each strategy means here), the
  strategy picker (★ on the recommendation, the default pre-selected), **Approve plan** (or **Re-plan as …**
  for a misfit), Revise…, Cancel, the combined-PR checkbox when Independent is picked. On the phone the
  picker wraps to one option per line.
- **Work view** (the stack rail, renamed): a header `CHV-9 · Stacked · building`; one row per repo.
  - Stacked: `develop ← 1 Table ← 2 API` as now.
  - Independent: unit chips side by side, each "on develop"; a `final PR` chip when combined.
  - Single: one segmented chip, `PR feature/CHV-9-orders: ① Table ② API ③ Page`, each segment coloured by
    its unit's status, verified commits ticked.
  - Every row ends in an integration chip: waiting, conflict, running, passing, failing.
- **Settings → Workflow:** Default strategy (Auto · Independent · Stacked · Single PR) with the hint "you
  still choose on every plan"; Final combined PR (independent); Integration check (no longer greyed);
  Models per role (Default · Fable · Opus · Sonnet · Haiku, and effort Default · low…max).
- **Feature card:** strategy in the title line, integration per repo on the checklist, follow-ups.

## 9. Tests

- **Shared:** `mergeWorkflow` for the new settings; old `workflow.json` and `tickets.json` load (strategy
  `stacked`, integration on).
- **Plan:** advice validation; `fits(plan, strategy)` for every strategy × plan shape.
- **Engine** (pure, scripted agents), per strategy: who starts when; push gates; independent conflict →
  stack-on / ask owner; base move without cascade; any merge order; combined PR flow; single assembly,
  one push, merge marks every unit; assembly conflict → restack → reassemble; patch-id review carry-over;
  proof and pre-existing findings; approve with a strategy that does not fit → re-plan.
- **Git** (real temp repos): `integrate` (clean merge of N tips, planted conflict named by files),
  `assemble` (one commit per unit, tree equality, planted conflict), `patchId` (same after a clean rebase,
  different after an edit).
- **Runner:** integrator tile launch and read-only gate; `report_integration` checks the sha; model/effort
  flags in the launch command; `ticket_action approve` with a strategy.
- **Web:** the plan card picker (recommended, pre-selected, misfit relabels the button, value sent with Approve), work view rows for all three, settings
  controls.
- **End to end:** the runner with real git and scripted agents (a fake agent that commits in its worktree
  and reports through the `tring-stack` tools), one ticket through each strategy from plan to pushed.
  PTY-based tests are already the flaky baseline on this machine, so the end-to-end suite drives the runner
  directly rather than through terminals; one built-daemon smoke covers the wiring.

## 10. Split

A new branch, `feat/adaptive-strategies`, from `feat/multi-pr-workflow`, as **one PR stacked on the
multi-PR PR**, in ordered commits that each build and pass on their own (behaviour stays "stacked" until
commit 3 lets you choose):

| # | Commit | Contents |
| --- | --- | --- |
| 1 | Strategy model and settings | types, migration, Settings controls, model/effort per role on tile launch |
| 2 | Planner advice | brief rubric, `advice` validation, `fits()` |
| 3 | Choose the strategy on the plan card | strategy picker + Approve plan, re-plan on a misfit, `ticket_action approve strategy` |
| 4 | Integration check | `integrate`, integrator role and tool, gate on push, replaces the lane check |
| 5 | Review carry-over and proof | `patchId`, `Finding.proof`/`preExisting`, follow-ups |
| 6 | Independent PRs | scheduling off the base, conflict cards, no cascade, combined PR |
| 7 | Single PR | unit branches, assembly, one push and PR, reassembly |
| 8 | Work view | rail → work view for all three, feature card |
| 9 | End to end and docs | scripted-agent suite, smoke, README, specs |

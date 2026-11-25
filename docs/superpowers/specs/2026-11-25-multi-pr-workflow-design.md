# Multi-PR workflow: one ticket, one tab, a stack of small reviewed PRs

Status: **built 2026-11-25** on `feat/multi-pr-workflow` (commits 0–8 below; decisions Q1–Q20 at the end). Not pushed.

## Context

Today the orchestrator agent routes work to tiles: `create_session` with `branch`/`base` gives a tile its own
worktree, cards come from hooks (`permission`, `question`, `reply`), and choice buttons are parsed out of a
reply card's markdown (`web/src/choices.ts`). Nothing in tring knows that several tiles belong to one piece of
work, what order their branches stack in, or whether a PR has been reviewed.

Goal (owner): with **Settings → Workflow → Multi-PR workflow** on, "work on ticket X" becomes a ticket tab of
agents that build the ticket as 3–6 stacked, small, tested PRs, each reviewed by a fresh agent before it may
push, tracked on one feature card (desktop and phone). Off, nothing changes.

What exists and is reused:

| Need | Already there |
| --- | --- |
| A tab per ticket | `ProjectManager.createProject(name, root)`; projects persist in `projects.json` |
| A worktree per PR, branched from the PR below | `OrchestratorTools.worktreeFor` / `GitOps.addWorktree` (`-b branch base`) |
| Knowing where a tile's agent works | `Session.agentCwd`, `GitOps.place` |
| Prompting a tile safely | `send_prompt`'s refusal rules + `typePrompt`, `ready()` before a first prompt |
| Waiting for tiles | `wait_for` / `state()` (promptedAt / stoppedAt) |
| Cards on desktop + phone + push | `Inbox`, `InboxPanel` (stacks on a phone), `Notifier` |
| Cards across a restart | `CardStore` keyed by project + slot + Claude conversation |
| Gating a tool call | hook route already holds `PermissionRequest` / `PreToolUse` and can answer `deny` |

## 1. Data model

New server module `packages/server/src/workflow/` (pure where possible), types in `shared/src/workflow.ts`.

```ts
interface WorkflowSettings {           // ~/.config/tring/workflow.json, daemon-side (the orchestrator needs it)
  multiPr: boolean                     // default false
  maxPrLines: number | null            // future: soft cap on +/- lines per PR, review flags it
  requireFreshReview: boolean          // default true once multiPr is on
  autoRestack: 'offer' | 'auto'        // default 'offer'
  maxAgents: number                    // default agents per ticket for new tickets: slider 4–16, default 4
  testFirst: boolean                   // future
  integrationCheck: boolean            // future (whole-stack check is always on; this is CI/e2e env)
}

interface Ticket {
  id: string                           // uuid
  key: string | null                   // "CHV-3193"
  title: string
  text: string                         // the ticket body, fetched by the orchestrator and handed to start_ticket
  source: string                       // "goby", "pasted", "github"… — informational; tring knows no tracker
  repos: TicketRepo[]                  // one or more (decided 2026-11-25: multi-repo, many PRs per repo, one tab)
  projectId: string                    // the ticket tab
  phase: 'planning' | 'awaiting-approval' | 'building' | 'integrating' | 'done' | 'abandoned'
  plan: Plan | null
  prs: StackPr[]                       // by PlannedPr.index
  checklist: Checklist                 // derived, cached for the card
  maxAgents: number                    // this ticket's slider, 4–16 (plan card / feature card)
  localKey: string                     // key its local tickets derive from: `key`, or a minted TRING-<n>
  createdAt: number
}

interface TicketRepo {
  id: string                           // short name, e.g. "telemetry.store" (repoName of its common dir)
  root: string                         // the main checkout
  baseBranch: string                   // what a PR with `below: null` branches from, e.g. main / develop
}

interface Plan {
  version: number                      // bumps on every replan/amendment
  summary: string
  prs: PlannedPr[]                     // see the limits question
  shared: Array<{ repo: string; path: string; owner: number; why: string }>   // files more than one PR needs
  interfaces: Array<{ name: string; owner: number; contract: string }>  // what other PRs code against, any repo
  deployOrder: string[] | null         // repo ids, when cross-repo changes must ship in an order
  addRepos: Array<{ path: string; base: string | null; why: string }>   // repos the planner needs beyond start_ticket's
}

interface PlannedPr {
  index: number                        // unique across the ticket
  repo: string                         // a TicketRepo id
  below: number | null                 // the PR it branches from: same repo only; null = the repo's baseBranch
  title: string                        // "Schema for X"
  scope: string
  owns: string[]                       // globs in its repo; disjoint across PRs of a repo except plan.shared
  uses: string[]                       // interface names it codes against (may be owned in another repo)
  tests: { add: string[]; run: string[] }   // test files to write; commands that must pass
  acceptance: string[]
}
```

**Shape of a ticket.** `below` makes each repo a forest: usually one chain (schema → API → UI), but two
independent PRs in one repo may both sit on `baseBranch`. A **lane** is one chain in one repo; restacks run
within a lane only. Across lanes and repos, order comes only from `uses` → the owner's `interfaceReady`, and
`deployOrder` for shipping. The validator checks: `below` is in the same repo and acyclic; ownership is
disjoint per repo; every `uses` names an interface whose owner is not itself downstream of the user (no cycles
through interfaces either).

```ts

type PrStatus = 'planned' | 'coding' | 'tests-passing' | 'in-review' | 'review-clean' | 'pushed' | 'merged'

interface StackPr {
  index: number
  branch: string                       // "<prefix>/<key>-<n>-<slug>", named like the repo's branches
  worktree: string | null
  coder: TileRef | null                // project + slot + claudeId while its tile is open
  coderConversation: string | null     // kept after the tile closes, for `claude --resume`
  status: PrStatus
  flags: {
    needsRestack: boolean              // the PR below moved since this one was based on it
    baseFailing: boolean               // a lower PR's tests are red: hold review/push
    blocked: string | null             // conflict / stuck / waiting on user, in words
    interfaceReady: boolean            // this PR's interface (plan.interfaces) is frozen
  }
  baseSha: string | null               // the head of `below` (or of baseBranch) this one sits on
  headSha: string | null
  review: Review | null
  prUrl: string | null
}

interface Review {
  round: number
  reviewer: TileRef | null             // a fresh tile per round, closed after it reports
  reviewedRange: { base: string; head: string }
  findings: Finding[]
}

interface Finding {
  id: string
  severity: 'high' | 'medium' | 'low' | 'nit'
  file: string | null; line: number | null
  summary: string
  holds: boolean                       // severity high | medium
  resolution: 'open' | 'fix-requested' | 'fixed' | 'verified'
    | { skipped: string }              // by the user, with a reason
    | { declined: string }             // by the coder after looking: not really an issue, with a reason
}
```

**Local tickets** (decided 2026-11-25). tring never creates or edits anything on Goby (or any tracker): it
reads the ticket once, through the orchestrator, and from then on works from its own tickets.
- On plan approval, one **local ticket per planned PR**, keyed from the parent: `CHV-3193-1` … `CHV-3193-n`.
  Started from an idea with no tracker ticket, tring also makes a local parent `TRING-<n>` (a counter in
  `tickets.json`).
- Each holds: scope, owned files, interfaces provided and used (with their contract text), tests, acceptance
  criteria, status, findings, and a work log built from the agents' reports and the user's card actions.
- Stored in `tickets.json`, and rendered to markdown under `~/.config/tring/tickets/<KEY>/<KEY>-n.md`
  (outside every repo; rewritten on each change) so a person or agent can read them as files.
- Agents read theirs with `stack_brief` and never edit them directly; they change only through the stack tools
  and the user's card actions, so every tile sees the same version. Briefs and `TRING.md` say "do not create,
  edit or comment on tracker tickets".
- The stack rail and the feature card open a PR's local ticket on click.

**Roles** (each its own tile and Claude conversation, all in the ticket tab). Slots are the first free ones;
the numbers below are only the usual layout.

| Role | Slot | Worktree | Lifetime |
| --- | --- | --- | --- |
| Planner | 1 | none of its own; read-only in each repo's main checkout (its permissions deny Edit/Write) | until the plan is approved, then closed |
| Coder (one per PR) | 2… | its PR's worktree, branched from its `below` PR or the repo base | while the PR is active (coding … pushed); reopened with `--resume` for restacks and fixes |
| Reviewer | 8+ | the PR's worktree, **read-only** (Edit/Write/push denied) | one review round; closed after `submit_review` |

There is no coordinator *agent*: sequencing is a deterministic **stack engine** in the daemon (decided
2026-11-25). Agents only plan, code and review; the orchestrator starts tickets and reports on them.

**Feature card**: a new `InboxKind` `'feature'`, one per ticket, not tied to a hook; it lives as long as the
ticket and is rebuilt from the `Ticket` (never edited directly). Workflow cards with explicit actions use a new
kind `'workflow'` (decided 2026-11-25):

```ts
// InboxItem additions
ticketId?: string; prIndex?: number; findingId?: string
actions?: Array<{ id: string; label: string; primary?: boolean; needsText?: boolean }>
// ClientMessage addition
| { type: 'action'; itemId: string; actionId: string; text?: string }
```

The engine checks each action against the ticket's current state before applying it; a stale one (the plan was
already approved on the phone) replaces the card with the current one instead of acting twice. Reply cards and
`choices.ts` are unchanged.

Persistence: `~/.config/tring/tickets.json` (atomic write like `card-store.ts`, 0600). Tiles are found again
after a restart by `TileRef`, exactly as cards are.

## 2. Flow: "work on ticket X" to merged

0. **The tab's root** is the first repo named (`repos[0].root`); every tile has its own cwd anyway, and
   `list_worktrees` covers every repo a tile is in.
1. **Start.** The user tells the orchestrator. It looks the ticket up with the lookups it already has (the
   `goby` skill, allowed shell tools), or asks the user to paste it, and calls `start_ticket {key, title,
   text, source, repos: [{path, base?}]}` with its best guess at the repos (ticket text, the user's repo
   table in their global CLAUDE.md). `base` defaults to `develop` when the repo has one (local or
`origin/develop`) — new features land there first for testing — else the remote's default branch. Every path must be a git
   repository (decided 2026-11-25).
   tring creates the ticket tab (`<KEY> <short title>`, root = repo), the `Ticket` (phase `planning`), the
   feature card, and the planner tile with its brief.
2. **Plan.** The planner reads the code and calls `submit_plan`. The engine validates it: 3–6 PRs; `owns`
   globs disjoint except entries in `shared`; every PR has `tests.run` and acceptance criteria; every interface
   has an owner below its users. Invalid → the error goes back to the planner as a prompt.
   The planner may add repos (`plan.addRepos`, each with a reason); tring checks each is a git repository
   before the plan reaches the user.
3. **Approve.** A plan card (phone too): the repos (added ones flagged — approving the plan approves them),
   then the lanes and PRs with scope, owned files, tests, interfaces. Buttons:
   *Approve*, *Change…* (free text → planner revises, version+1), *Cancel ticket*. No code before *Approve*.
4. **Build.** On approval the engine creates PR worktrees in each repo, root of each lane first (`branch` from
   the repo's `baseBranch` when `below` is null, else from the `below` PR's branch), and starts coders under the concurrency limit (§3.8). Each coder's brief: ticket,
   whole plan, its own PR, the interfaces it consumes, the files it owns, its test commands, the rules in §3.
5. **Tests.** A coder writes tests, makes them pass, commits, and calls `report(tests_passing, evidence)` with
   the commands it ran and their summary lines. Status → `tests-passing`.
6. **Review gate.** If `requireFreshReview`: the engine starts a reviewer tile (clean context) in the PR's
   worktree with a brief: ticket, plan, this PR's scope/owned files/acceptance, and the range
   `baseSha..headSha`. It uses the `code-review` skill if one is installed (checked by the brief: "if the
   skill exists, use it"), re-runs `tests.run`, and calls `submit_review(findings)`. Status `in-review`.
7. **Findings** (decided 2026-11-25). Only **high and medium** findings hold the PR; low and nit findings are
   advisory, listed on the feature card, and can still be sent for fixing. The user decides per finding:
   *Fix* or *Skip with reason…* (plus *Fix all held*). *Fix* means "look into it": the coder investigates and
   either fixes it (commits, `resolve_finding(id, fixed, note)`) or, if it is not really an issue, declines
   it (`resolve_finding(id, declined, reason)`). A finding in a file another PR owns is routed to that PR as a
   `request_change` and holds both. When no held finding is open, a **fresh** reviewer sees only the new
   range, each fix, and each decline with its reason: it accepts or re-raises (a re-raised decline comes back
   to the user as a card). No held findings → `review-clean`. Three rounds that each bring new held findings →
   the stuck card.
8. **Whole stack.** When every PR of a lane is `review-clean`, the engine has the lane's **top** coder (its
   branch contains the whole lane) run every lane PR's `tests.run` plus that repo's full suite. Every lane
   green → phase `integrating` ends. Cross-repo end-to-end checks are the future `integrationCheck`.
9. **Push / PRs** (decided 2026-11-25). Nothing is pushed until the user clicks. A PR that is `review-clean`
   with a green whole-stack check gets *Push & open PR* on its card; the feature card offers *Push stack*
   (bottom-up). The click lifts that PR's push hold and prompts its coder to push, then call `open_pr`
   with a title and body (the `pr` skill for the body when installed). **tring opens the draft PR against the
   branch below itself** (Q20, decided 2026-11-25): `gh pr create --draft` on GitHub, the Bitbucket Cloud REST
   API (`POST …/pullrequests`, `draft: true`) with a scoped API token the user puts in `bitbucket.json`. The
   agents never hold a forge token; the hook denies `gh pr create|edit|ready` and `api.bitbucket.org` in a tile.
   Without a token (or when `gh` fails) the push is recorded with the link to open the PR by hand. The click is
   the consent (tiles run in auto mode, see §4). Status `pushed`. CI: `gh pr view --json statusCheckRollup` on
   GitHub, `GET …/pullrequests/{id}/statuses` (latest per build key; STOPPED counts as red) on Bitbucket.
10. **Merge** (decided 2026-11-25). The user merges on the forge; tring never merges. Detection, every 2 min:
    the PR's state from the forge (GitHub `MERGED`; Bitbucket `MERGED`, with `DECLINED`/`SUPERSEDED` as closed);
    where the forge cannot say, git (the branch is an ancestor of `origin/<base>`); *Mark merged* always works,
    and is the only way for a squash merge without a token. On merge of PR k: `merged`, its coder tile closes
    (worktree kept), and PR k+1 is offered *Restack onto `<base>`* (automatic under `autoRestack: auto`): the
    tile runs `git rebase --onto <base> <PR k's old head>` — correct after a squash merge — runs its tests,
    and reports `restacked`. A pushed PR whose head moved gets `flags.repush` and a card *push the rebased
    branch*: re-pushing needs `--force-with-lease` and is always a *Push* click. Its coder then calls
    `open_pr` again, and tring retargets the PR it already has (`gh pr edit --base`; Bitbucket `PUT` with
    the new `destination`) rather than opening another. All merged → phase `done`.
11. **Clean-up** (decided 2026-11-25), never automatic. The feature card becomes *Done ✓* with *Clean up…*: a
    dialog listing the tab, its tiles, each worktree and each local branch, pre-ticking only what is safe (no
    uncommitted changes; branch merged or its PR closed). Removal is `git worktree remove` / `git branch -d`,
    never `--force` / `-D`. The ticket stays archived in `tickets.json` (*Recent tickets*: stack, PR links). A
    cancelled ticket gets the same dialog with nothing ticked.

### Repos: which ones, and how tring reaches them

tring never talks to Bitbucket or GitHub to read code and never clones. Every repo is a **local clone** on
this machine, and every git command runs in it with the user's own git setup (credential manager, SSH keys).

- *Which repos*: `start_ticket.repos` holds local paths. The orchestrator picks them from the ticket text, the
  repo table in the user's global `~/.claude/CLAUDE.md` (Claude Code loads it in the orchestrator workspace
  too), existing project roots and `list_worktrees`. A repo it cannot place is asked for, never searched for.
  The planner may add paths; the plan card shows them all for approval.
- *Base branch*: per repo, `develop` if `refs/heads/develop` or `refs/remotes/origin/develop` exists, else
  `origin/HEAD`'s branch; `start_ticket` can override it.
- *Worktrees*: `git worktree add` beside the clone, following the layout already there (`defaultWorktreePath`
  learns it, e.g. `C:\BITBUCKET REPOSITORIES\cypherview.worktrees\<branch>`).
- *Fetch*: the daemon's 10-minute `git fetch origin <base>` runs with `GIT_TERMINAL_PROMPT=0` and a timeout,
  so a credential prompt fails instead of hanging; the feature card then shows "can't fetch develop in X" with
  git's error.
- *Pushes, rebases, PR creation* run in the tiles, by their agents, with the same credentials the user's own
  terminal has.

## 3. Coordination rules

1. **One agent per worktree.** The engine is the only thing that starts tiles in a ticket's worktrees. A
   reviewer shares the coder's worktree but only while the coder is idle and blocked from editing
   (`in-review`: the coder's edit hook denies with "under review; wait").
   *The orchestrator and ticket tiles* (decided 2026-11-25): its read tools work on them as on any tile;
   `send_prompt` into one is refused with "managed by ticket X; use `ticket_action tell`". `tell` logs the
   message on the ticket and the engine delivers it to that PR's coder when idle (reopening it with
   `--resume` if closed), prefixed with the PR's current rules. The user can always type into any tile; the
   engine only observes the results (commits, reports, hooks).
2. **File ownership.** Coder tiles start with a per-tile `--settings` file whose `PreToolUse` hook (Edit,
   Write, NotebookEdit) asks the daemon; an edit outside the PR's `owns` (and not a `shared` file it owns) is
   denied with the owner's name and "call `request_change` to ask that PR". Enforced, not just instructed.
3. **Lower interfaces first.** A coder works interface-first: it commits the interface (types, schema,
   endpoint signatures) and calls `report(interface_ready)`. Uppers only start once the PR below them has
   `interfaceReady` (or immediately, if the plan says the interface is fully specified in `plan.interfaces`).
4. **Uppers code against the plan.** An upper's brief quotes the `contract` text of every interface it uses.
   If the lower must change it, it calls `amend_interface`; that is a card for the user (approve/reject), and
   approval bumps the plan version and tells each affected upper.
5. **Learning that a lower PR changed.** ("PR k+1" below means each PR whose `below` chain leads to PR k,
   within its lane.) The engine watches each PR branch head (`git rev-parse`, every 5 s
   for active tickets, plus immediately on a coder's PostToolUse of a `git commit`/`rebase`). When PR k's head
   is no longer an ancestor of PR k+1, PR k+1… get `needsRestack`. Each affected tile gets a short prompt when
   it is next idle: "PR k moved (abc→def): <commit subjects>. Restack is pending; keep working". It is never
   interrupted mid-turn.
6. **Rebases are sequenced by the engine.** A restack card (*Restack now* / *Later*; automatic if
   `autoRestack: auto`) runs PR k+1, then k+2, …: each tile is prompted to `git rebase --onto <k head> <old
   base sha>`, run its tests, and `report(restacked, evidence)`. The next PR starts only after that report.
   A rebased PR that was `review-clean` drops to `tests-passing` only if the rebase changed its own diff
   (`git range-diff` non-empty); otherwise it keeps its review.
7. **Failures.**
   - *Merge conflict* in a rebase: the tile resolves conflicts in files it owns. A conflict in a file it does
     not own → `git rebase --abort`, `blocked`, a card: *Let PR n resolve it* / *Ask owner PR m to adapt* /
     *Open the tile*.
   - *The base branch moves* (decided 2026-11-25): every 10 min the engine runs `git fetch origin <base>`
     per repo (read-only). If `origin/<base>` moved, the feature card shows *develop moved N commits* with
     *Update lane* (restack the lane root onto it, then each PR above in order). Before *Push stack*,
     `git merge-tree` checks the lane against the new base: a conflict makes the update required; otherwise
     the push may go ahead behind. Never automatic, even under `autoRestack: auto`.
   - *Failing test in a lower PR* (its report or the watcher sees a red re-run): PR k back to `coding`; every
     PR above gets `baseFailing` and is held at review/push (they keep coding). Cleared when PR k reports green.
   - *Stuck agent*: busy with no hook activity for 10 min, three test/review rounds without progress, or the
     agent calls `blocked(reason)`. Card: *Nudge* (prompt "summarise where you are and what is blocking"),
     *Fresh context* (new tile, same worktree, brief + `git log`/diff summary), *Open the tile*, *Pause PR*.
   - *Planner fails* (no valid plan after 3 tries): card with its last error; the user edits or cancels.
8. **Limits** (decided 2026-11-25).
   - *PRs*: 1–16 per ticket (validator); the planner aims at 2–6 per lane and small PRs.
   - *Tiles*: a coder tile exists only while its PR is active (`coding` … `pushed`); then it closes, its
     Claude conversation id kept on the `StackPr`, and a later restack or fix reopens it with
     `claude --resume`. Planner closes on approval; reviewers after each round. Never more than the tab's slots (24); when slots run short, idle coder tiles close first and reopen with `--resume`.
   - *Agents at once* (Q19): `Ticket.maxAgents`, a 4–16 slider on the plan card and the feature card, starting from the Settings default (4). Lowering it never stops an agent mid-turn; new work waits. No overall cap across tickets: the quota guard is the brake.
     Beyond that a PR is *queued* (shown in the stack view). Lower PRs first; a waiting reviewer before a
     new coder.
   - *Quota*: with usage monitoring on, no new agent starts while 5-hour or weekly usage is over 90 %; the
     feature card says so.
9. **Tests** (decided 2026-11-25). Every brief requires unit tests, plus integration/e2e where the repo has
   them (the planner lists which suites exist). `report(tests_passing)` carries the commands, their summary
   lines and the commit sha they ran on; the engine rejects it unless that sha is the worktree's `HEAD` and
   `git status --porcelain` is empty (pure git, no LLM). The fresh reviewer re-runs `tests.run` read-only and
   reports the result with its findings; red is a high finding. The whole lane runs at its top before any
   push. tring itself never runs repo commands.

## 4. MCP tools

**Orchestrator (`tring` server)** — only listed while `multiPr` is on (`GET /api/orchestrator/tools` filters):

| Tool | Does |
| --- | --- |
| `start_ticket {key?, title, text, source, repos: [{path, base?}]}` | Creates the ticket tab, ticket, feature card, planner. User approves (spawns processes). |
| `list_tickets` | Every ticket with phase, PR statuses, what is waiting on the user. Pre-allowed. |
| `ticket_status {ticket}` | One ticket in full: plan, PRs, findings, checklist. Pre-allowed. |
| `ticket_action {ticket, action, pr?, text?}` | The card actions (approve plan, restack, nudge, pause, cancel), for "approve the plan" said to the orchestrator, and `tell` (relay a message to a PR's coder). Not pre-allowed. |

`TRING.md` gets a section, written only when `multiPr` is on: "work on ticket X" → look the ticket up, then
`start_ticket`; messages for a ticket's agents go through `ticket_action tell`, never `send_prompt`; report
from `ticket_status`.

**Tiles (`tring-stack` server)** — the same relay (`mcp-cli.ts`) pointed at `/api/stack/*` with a per-tile
capability token, so a tile can only act as its own role on its own PR. Added to the tile with
`--mcp-config` (not strict: the user's own servers stay).

| Role | Tools |
| --- | --- |
| all | `stack_brief` (its brief, re-readable after compaction), `stack_status` (the stack, who owns what) |
| planner | `submit_plan` |
| coder | `report {kind: interface_ready \| tests_passing \| restacked \| tests_failing, evidence}`, `resolve_finding {id, outcome: fixed \| declined, note}`, `request_change {to_pr, what}`, `amend_interface {name, contract, why}`, `blocked {reason}` |
| reviewer | `submit_review {findings[]}` |

**Tile permissions** (decided 2026-11-25). Every ticket tile — planner, coders, reviewers — starts as
`claude --permission-mode auto`, so routine work is not a stream of prompts. Its per-tile `--settings` adds:
the ownership hook answers *allow* for Edit/Write inside the PR's owned files (and *deny* outside them); the
plan's exact `tests.run` commands, approved with the plan, become `Bash(<cmd>)` allow rules. Planner and
reviewer deny Edit/Write/NotebookEdit and pushes. tring's hook denies hold whatever the mode. If auto mode is
not available to the user's Claude Code, the tile still starts (in their default mode) and the feature card
says so.

**Push hold**: the per-tile settings also hook `PreToolUse` on Bash/PowerShell; `git push` (and `gh pr
create`) from a coder whose PR is not `review-clean` with a green whole-stack check is denied with the reason.
The user's *Push* click is the consent: it lets exactly that PR's push (and `--force-with-lease` after a
restack) through once; auto mode may not prompt again, and does not need to.

## 5. UI

**Desktop**
- *Settings → Workflow*: a section like Voice input that acts at once (`GET/POST /api/workflow`): the
  Multi-PR workflow switch; when on, require fresh review, auto-restack (offer/auto), max agents; *max PR
  size*, *test-first*, *integration check* shown greyed with "later".
- *Ticket tab*: the project tab shows the key and progress (`CHV-3193 · 2/5`) and a ticket glyph.
- *Stack view*: in a ticket tab, a rail above the ring with one row per lane (repo name, then its chain), and
  a dotted mark where a PR `uses` another lane's interface; one chip per PR bottom-to-top
  (`1 Schema ● review clean`, `2 API ● coding ⟳ restack`), with the status colours, flags, branch on hover;
  click focuses the PR's coder tile. A *Restack* button appears when any PR needs it.
- *Cards*: plan, finding, restack, stuck and conflict cards with real buttons (*Approve*, *Fix*, *Skip with
  reason…*); the feature card pinned to the top of the inbox: ticket, progress bar, checklist (tests written,
  tests passing, review clean, docs updated, CI green), PR list with status/branch/PR link, *Open tab*.

**Phone**: the same cards in the stacked inbox; the feature card shows the stack as a compact list. Push
notifications for: plan ready, findings, stuck/conflict, ready to push, all merged. The switcher shows the
ticket tab like any project.

## 6. Testing this feature

- **Pure units** (vitest, no processes): plan validation (counts, ownership overlap, interface order);
  status transitions and gates (no review before tests, no push before clean, `baseFailing` propagation);
  restack ordering and range-diff rule; scheduler (limits, priority); finding lifecycle; checklist.
- **Engine with stubs**: `StackEngine` with injected `GitOps`, sessions, clock and prompt sink, like
  `orchestrator-tools.test.ts`; a scripted "agent" stub answers prompts by calling stack tools.
- **Real git**: temp repo, 3-PR stack via real `git worktree add`; commit on PR 1 → watcher flags 2 and 3;
  scripted rebases in order; a planted conflict in an unowned file → blocked.
- **Hooks/HTTP**: the edit-ownership and push-hold hooks over the real hook route (`hook-http.test.ts`
  style); capability tokens: a coder cannot `submit_review`, cannot act on another PR.
- **Persistence**: tickets and the feature card survive a restart (`card-store.test.ts` style).
- **Web**: pure view-models for the stack rail, feature card and settings section (`inbox-view.test.ts`
  style); the card actions' message shapes.
- **Off means off**: with `multiPr` false, the tool list, `TRING.md`, hooks and UI are byte-for-byte as today.
- **Manual**: a real small ticket on a scratch repo with real Claude tiles, including a daemon restart mid-stack.
- **Baseline** (decided 2026-11-25): on the owner's Windows machine 30 tests in 9 files already fail on a
  clean `ebe2668` (`session`, `cwd`, `hook-http`, `ws`, `http`, `shell`, `git-diff`, `auto-answer`, …: PTY
  timeouts, hook "File not found", `ERR_INVALID_URL` from a Windows path, an auto-answer rule). Each PR of
  this feature adds no new failures and passes every test it adds or touches; the list goes in each PR
  description; fixing them is a separate ticket.

## As built (notes against the design)

- **Shared files**: a file several PRs need is owned by exactly one PR, which must cover it in its `owns`;
  the others ask it with `request_change`. Ownership globs never overlap within a repo.
- **Worktrees** are made when a PR starts, not at approval, so each branches from the PR below as it is then
  (no restack before the first line of code).
- **Engine and runner**: `workflow/engine.ts` is the pure stack engine; `workflow/runner.ts` carries out
  its commands against tiles and git; cards are derived from the ticket (`cardsFor`), never stored.
- **Phone notifications** for workflow cards say what kind of call is waiting and nothing from the card, as
  every tring notification does; the feature card never buzzes.
- **Clean up**: `git branch -d` is run with the branch's upstream pointed at `origin/<base>`, so it deletes
  exactly what is merged into the base. A squash-merged branch is not an ancestor of the base; it is left
  unticked, and -d refuses it.
- **Restarts**: tiles keep their flags through `Session.claudeArgs`; tile tokens and places are in
  `stack-tiles/tiles.json`; tickets in `tickets.json`.
- **Not yet**: `maxPrLines`, `testFirst`, `integrationCheck` (shown
  greyed in Settings), a global agents cap (dropped in Q19).

## 7. Building this feature

One branch (`feat/multi-pr-workflow`), **one PR**, nine commits in this order (decided 2026-11-25). Each
commit builds, typechecks and passes its tests on its own (against the baseline above), so it can be reviewed
commit by commit and split along commits later if needed. The setting is off by default throughout.

| # | Commit | Contents | Tests |
| --- | --- | --- | --- |
| 0 | 24 slots | `SLOT_COUNT` 24 (server + keymap); ring size 24 (7×7) in Settings, default stays 16, grows to 24 when a slot above 16 is used; keys 17–20 Ctrl/Shift+7…0, 21–24 Alt+1…4 (Mac: picker/switcher); phone switcher lists 24 | ring-layout, keymap, session-manager |
| 1 | Setting | `workflow.json`, `GET/POST /api/workflow`, Settings → Workflow section (future options greyed) | store, API, off-means-off |
| 2 | Model + plan validation | ticket, repos, lanes (`below`/`uses`), findings; validator (1–16 PRs, per-repo ownership, no cycles); `tickets.json` | validator, persistence |
| 3 | Stack engine core | statuses and gates, held findings, scheduler (agents slider, quota), restack order, failure handling — pure | engine with stubs + scripted agent |
| 4 | Git side | worktrees per lane, base detection (`develop`), head watcher, base fetch, `merge-tree`, `range-diff`, evidence check | real-git temp repos incl. planted conflict |
| 5 | Tiles + tools | `start_ticket`/`list_tickets`/`ticket_status`/`ticket_action` (+`tell`), ticket tab, role launch (auto mode, `--settings`, `--mcp-config`, briefs), `tring-stack` + per-tile tokens, hooks (ownership, push hold, read-only roles), `send_prompt` refusal | HTTP/hook, capability, tools |
| 6 | Cards | `workflow` kind + `action` message; plan/finding/restack/stuck/conflict/push cards; feature card; desktop, phone, push, restart | card/action, web view-models |
| 7 | Stack rail + finish | lanes rail, tab badge, *Push & open PR* / *Push stack*, `gh` merge detection + *Mark merged*, retarget, clean-up dialog, README + spec | view-models, `gh` stubs, clean-up safety |
| 8 | Forges | tring opens and retargets PRs itself (`open_pr`): `gh` on GitHub, the Bitbucket Cloud REST API with a scoped token (`bitbucket.json`); Bitbucket state and build statuses; git merge detection without a token; *push the rebased branch* card; Settings shows whether a token is set | forge (fake gh + fake fetch), engine repush, runner `open_pr`/retarget/fallback, gate, `/api/workflow/forges` |

Nothing is pushed or opened as a PR until the owner says so.

## Decisions (2026-11-25)

Q1 ticket text: the orchestrator fetches it and passes text + `source` · Q2 coordinator: the daemon's stack
engine · Q3 cards: structured `workflow` kind with actions, plus `feature` · Q4 pushing: a button; the coder
tile pushes and opens a draft PR · Q5 merging: the user merges; tring detects, restacks `--onto`, retargets ·
Q6 done: *Clean up…* offer, safe items ticked, never forced · Q7 multi-repo, many PRs per repo, one tab, lanes
· Q8 repos: orchestrator proposes, planner adds, plan approval approves · Q9 limits: 1–16 PRs (2026-11-25: was 1–12), tiles only while
active, agents per ticket on a 4–16 slider, 90 % quota guard · Q10 tiles in auto mode plus plan-derived allows · Q11
tests: evidence + HEAD/clean check + reviewer re-run · Q12 only high/medium findings hold; *Fix* means
investigate, the coder may decline with a reason · Q13 base moves: fetch, offer *Update lane*, required only
on a `merge-tree` conflict; base defaults to `develop` · Q14 orchestrator relays through `ticket_action
tell` · Q15 the 30 failing tests are the baseline · Q16 one PR, green commits in order · Q17 local tickets per PR (`<KEY>-n`, `TRING-<n>` parent), never written to Goby · Q18 24 slots on every tab (commit 0) · Q19 agents slider per ticket (4–16, default 4), no overall cap · Q20 forges: tring opens and retargets PRs itself (`open_pr`), `gh` on GitHub and the Bitbucket Cloud REST API with a scoped API token in `bitbucket.json`; no token falls back to a by-hand link and git merge detection.

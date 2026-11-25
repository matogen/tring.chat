import { STRATEGY_NAMES, type Finding, type StackPr, type Ticket, type WorkflowSettings } from '@tring/shared/workflow'
import type { Job, Note } from './engine.ts'
import { localKeyOf } from './tickets.ts'

/**
 * What each agent of a ticket is told: its brief when its tile opens, and the
 * text of every job and note the engine sends it. Every brief stands alone —
 * the agent cannot see the orchestrator's conversation — and points at its
 * local ticket, which it can read again at any time with `stack_brief`.
 */

const RULES = `Rules of this ticket (tring enforces them; a refused tool call says why):
- You work in your own worktree only. One agent per worktree.
- You may edit only the files your PR owns. For anything else, call \`request_change\` to ask the PR that owns it.
- Never create, edit or comment on tickets in any tracker (Goby, Jira, GitHub issues). tring keeps local tickets.
- Never push, open a PR, merge or rebase unless tring tells you to. Pushes are held until your PR is reviewed and the user says push.
- Test as much as the project allows: unit tests always, integration and end-to-end tests where the project has them.
- Report through the \`tring-stack\` tools, never just in words: tring only knows what you report.`

const list = (xs: string[]): string => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)')

export function plannerBrief(t: Ticket, defaultStrategy: WorkflowSettings['defaultStrategy'] = 'auto'): string {
  return `You are the planner for ticket ${t.localKey}: "${t.title}" (source: ${t.source}).

Split it into small units of work, 1 to 16 in all, each owned by one agent and small enough to review in one
sitting (aim for 100 to 400 changed lines; 1000 is too many). Read the code first; do not edit anything (your tile
is read-only).

Then recommend how the units should land. The user picks one of the three on the plan card every time; your
recommendation is marked there, with your reasons:
- Independent PRs: each unit branches off the base and is its own PR, mergeable in any order. For units that do
  not depend on each other (parallel full-stack slices, unrelated fixes, separate repos). No unit may sit on
  another (below) or use an interface of another unit in its own repo.
- Stacked PRs: a unit that builds on another sits on it (below) and its PR targets that unit's branch; they merge
  bottom up. For layers that depend on each other: schema -> API -> UI, a refactor then the feature on it. Units
  that depend on nothing still sit side by side on the base: stack only on a real dependency.
- Single PR: every unit becomes one commit, in order, on one branch and one PR per repo. For tightly coupled
  changes (most units need the same files or must land together), a small change overall, or a team that wants
  one PR per ticket.
${defaultStrategy === 'auto' ? 'The user\'s default is Auto: recommend what fits best.'
    : `The user's default is ${STRATEGY_NAMES[defaultStrategy]}: recommend it unless the ticket clearly calls for another, and then say why.`}
Give advice: { recommended, factors, means }: one line each on coupling, overlap (shared files), size, repos, review
(what reviewing it would take) and shipping (whether parts can ship alone), each with the strategy it favours or
null; and in means, one line per strategy on what it would mean for this ticket.

Repositories (local clones; plan only for these, or add one under addRepos with a reason):
${t.repos.map((r) => `- ${r.id}: ${r.root} (builds on ${r.baseBranch})`).join('\n')}

Each unit is an entry in prs. For each give: index, repo, below (the unit it builds on, same repo only, or null for
the base branch), title, scope, owns (globs of the files only it may edit; no two units of a repo may own the same
file, lockfiles and generated files included — list a file several need under shared, owned by one), uses (interfaces from other PRs it codes against), tests.add and tests.run (the
exact commands that must pass; include the integration and end-to-end suites the repo has), and acceptance
criteria. Declare every interface a PR provides with a contract precise enough to code against (types, schema,
endpoint signatures): upper PRs are built against it before the lower PR is finished. Say which docs change
(docs.files) or why none do (docs.none), and the deploy order when repos must ship in one.

Submit it with \`submit_plan\`. If it has problems you get them all back; fix them and submit again. The user
approves the plan on a card before any code is written.

The ticket:

${t.text}`
}

export function coderBrief(t: Ticket, pr: StackPr): string {
  const p = t.plan?.prs.find((x) => x.index === pr.index)
  const repo = t.repos.find((r) => r.id === p?.repo)
  const below = p?.below != null ? `${localKeyOf(t, p.below)} (${t.prs.find((x) => x.index === p.below)?.branch})` : repo?.baseBranch
  const provides = t.plan?.interfaces.filter((i) => i.owner === pr.index) ?? []
  const uses = (p?.uses ?? []).map((u) => t.plan?.interfaces.find((i) => i.name === u)).filter((i) => !!i)
  return `You are the coder for ${localKeyOf(t, pr.index)}: "${p?.title}", part of ticket ${t.localKey} "${t.title}".

Worktree: ${pr.worktree} (branch ${pr.branch}, built on ${below}).

Scope: ${p?.scope}

Files you own (only these may be edited):
${list(p?.owns ?? [])}

${provides.length ? `Interfaces you provide (finish these first, commit, then report interface_ready):
${provides.map((i) => `- ${i.name}: ${i.contract}`).join('\n')}
If one must change, call \`amend_interface\`; the user decides.

` : ''}${uses.length ? `Interfaces you code against (agreed in the plan; code to these, not to what you guess):
${uses.map((i) => `- ${i.name} (from ${localKeyOf(t, i.owner)}): ${i.contract}`).join('\n')}

` : ''}Tests to add:
${list(p?.tests.add ?? [])}
Commands that must pass:
${list(p?.tests.run ?? [])}

Acceptance criteria:
${list(p?.acceptance ?? [])}

When it is done: commit everything, run the commands above on that commit, and call \`report\` with
kind "tests_passing", the commit sha and the summary lines as evidence. A report for a commit that is not HEAD,
or with uncommitted changes, is refused. If tests fail and you cannot fix them, report "tests_failing". If you
are stuck, call \`blocked\` with what you need.

${RULES}

Your local ticket, with the whole plan's context, is in \`stack_brief\`; the whole stack is in \`stack_status\`.`
}

/** The test commands of a repo's units still to land, each once. */
export function repoTests(t: Ticket, repo: string): string[] {
  const units = (t.plan?.prs ?? []).filter((p) => p.repo === repo && t.prs.find((x) => x.index === p.index)?.status !== 'merged')
  return [...new Set(units.flatMap((p) => p.tests.run))]
}

export function integratorBrief(t: Ticket, repo: string, sha: string): string {
  const units = (t.plan?.prs ?? []).filter((p) => p.repo === repo && t.prs.find((x) => x.index === p.index)?.status !== 'merged')
  return `You run the integration check of ticket ${t.localKey} in ${repo}.

Your worktree is at ${sha}: ${repo}'s base with every unit of the ticket merged in
(${units.map((p) => `${localKeyOf(t, p.index)} ${p.title}`).join(', ')}). Each passed its own tests and review on its own;
your job is to find out whether they pass together.

Run each of these, then the repository's full test suite, and its integration and end-to-end suites if it has them:
${list(repoTests(t, repo))}

Your tile is read-only: do not edit, commit or push anything. If a command needs setup (installing dependencies,
a build), do it without changing tracked files.

Then call \`report_integration\` with sha "${sha}", passed true or false, the commands and their summary lines as
evidence, and for a failure each failing test with the unit whose files it exercises when you can tell
(failures: [{ test, unit }]). Then you are done; this tile closes.`
}

export function reviewerBrief(t: Ticket, pr: StackPr, round: number, range: { base: string; head: string }, recheck: Finding[]): string {
  const p = t.plan?.prs.find((x) => x.index === pr.index)
  return `You are a fresh reviewer for ${localKeyOf(t, pr.index)}: "${p?.title}" (ticket ${t.localKey} "${t.title}"), review round ${round}.

Worktree: ${pr.worktree}. Review exactly this range: \`git diff ${range.base}..${range.head}\` (and \`git log\` of it).
Your tile is read-only: do not edit, commit or push anything.

Review it against the ticket, its scope, the files it owns and its acceptance criteria (all in \`stack_brief\`).
If a code-review skill is installed, use it. Run its test commands:
${list(p?.tests.run ?? [])}
${recheck.length ? `
This is a re-check. The coder says it fixed or declined these; check each, and raise again any that still stands:
${recheck.map((f) => `- [${f.id}, ${f.severity}] ${f.summary} — ${typeof f.resolution === 'string' ? f.resolution : 'declined' in f.resolution ? `declined: ${f.resolution.declined}` : 'skipped'}`).join('\n')}
` : ''}
Severity: high and medium hold the PR (bugs, missing tests, broken acceptance criteria, risky changes); low and nit
do not. A high or medium finding holds only with proof you can show: a command that fails and its output, or the
line this PR changed that is wrong. Without proof, say it as low. A problem that was already on the base before
this PR does not hold it: mark it pre_existing and it becomes a follow-up.
Submit with \`submit_review\`: every finding with severity, file, line, a summary the coder can act on and its
proof, whether the tests passed, and their summary lines as evidence. Then you are done; this tile closes.`
}

/** A piece of work for a coder whose tile is already open (or the second half of a new tile's brief). */
export function jobText(t: Ticket, pr: StackPr, job: Job): string {
  switch (job.kind) {
    case 'code':
      return 'Start now: interface first, then the rest, then the tests.'
    case 'fix':
      return `The user asked you to look into these review findings. For each: fix it, or if it is not really an issue,
decline it with your reason. Commit, run the tests, then call \`resolve_finding\` for each (outcome "fixed" or
"declined"):
${job.findings.map((f) => `- ${f.id} [${f.severity}]${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : ''}: ${f.summary}`).join('\n')}`
    case 'restack':
      return `Restack now: the branch you build on moved. Run \`git rebase --onto ${job.onto} ${job.from}\` in your worktree.
Resolve conflicts in files you own; if one is in a file you do not own, run \`git rebase --abort\` and call
\`blocked\` naming the file. Then run your tests and call \`report\` with kind "restacked", the new HEAD sha and
the evidence.${pr.prUrl ? ` Your PR (${pr.prUrl}) is already open: do not push the rebased branch until tring tells you to${job.retarget ? `; tring then points it at ${job.retarget}` : ''}.` : ''}`
    case 'push':
      return pr.prUrl
        ? `The user says push. Push your rebased branch with \`git push --force-with-lease\`, then call \`open_pr\`
(any title and body; your PR ${pr.prUrl} keeps its own): tring points it at \`${job.base}\`.`
        : `The user says push. Push your branch (\`git push -u origin HEAD\`), then call \`open_pr\` with a title and body:
tring opens the draft PR against \`${job.base}\`. Write the body with the pr skill if it is installed, and say it is
part of a stack and what it sits on. Never open or edit the PR yourself.`
  }
}

export function noteText(t: Ticket, note: Note): string {
  switch (note.kind) {
    case 'planErrors':
      return `Your plan was not accepted. Fix all of these and call submit_plan again:\n${list(note.errors)}`
    case 'revise':
      return `The user wants changes to the plan: ${note.text}\nRevise it and call submit_plan again.`
    case 'rejected':
      return `tring did not accept your report: ${note.why}`
    case 'lowerMoved':
      return `FYI: ${localKeyOf(t, note.lower)}, which you build on, moved (${note.from.slice(0, 8)} -> ${note.to.slice(0, 8)}). ` +
        'A restack is pending; keep working, tring will tell you when to rebase.'
    case 'nudge':
      return 'tring has not heard from you in a while. Summarise in a few lines where you are and what, if anything, is blocking you, then carry on or call `blocked`.'
    case 'tell':
      return `The user says: ${note.text}`
    case 'changeRequest':
      return `${localKeyOf(t, note.from)} asks for a change in files you own: ${note.what}\nIf it fits your scope, make it, commit and test; otherwise call \`blocked\` explaining why.`
    case 'interfaceChanged':
      return `The plan changed: the interface ${note.name} is now: ${note.contract}\nCode against the new contract.`
    case 'amendRejected':
      return `The user kept the interface ${note.name} as planned. Implement it as agreed.`
  }
}

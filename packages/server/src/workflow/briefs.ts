import type { Finding, StackPr, Ticket } from '@tring/shared/workflow'
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

export function plannerBrief(t: Ticket): string {
  return `You are the planner for ticket ${t.localKey}: "${t.title}" (source: ${t.source}).

Split it into a stack of small PRs that build on each other: typically schema -> API -> UI -> end-to-end tests,
1 to 16 PRs in all, 2 to 6 per lane, each small enough to review in one sitting. Read the code first; do not edit
anything (your tile is read-only).

Repositories (local clones; plan only for these, or add one under addRepos with a reason):
${t.repos.map((r) => `- ${r.id}: ${r.root} (builds on ${r.baseBranch})`).join('\n')}

For each PR give: index, repo, below (the PR it builds on, same repo only, or null for the base branch), title,
scope, owns (globs of the files only it may edit; no two PRs of a repo may own the same file — list a file several
need under shared, owned by one), uses (interfaces from other PRs it codes against), tests.add and tests.run (the
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
do not. Submit with \`submit_review\`: every finding with severity, file, line and a summary the coder can act on,
whether the tests passed, and their summary lines as evidence. Then you are done; this tile closes.`
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
    case 'checkLane':
      return `Every PR in your lane is reviewed: ${job.prs.map((i) => localKeyOf(t, i)).join(', ')}. Your branch holds all of them.
Run every one of their test commands, plus the repository's full test suite, on your HEAD. Call \`report\` with kind
"lane_passing" (and the sha and evidence) if all pass, or "lane_failing" with what failed.`
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

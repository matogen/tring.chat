import type { ToolDef } from '../orchestrator-tools.ts'

/**
 * The `tring-stack` MCP tools a multi-PR workflow tile gets: what its role
 * may do, and nothing else. Which ticket, role and PR a call is for comes
 * from the tile's own token, never from the arguments.
 */

export type Role = 'planner' | 'coder' | 'reviewer' | 'integrator'

const COMMON: ToolDef[] = [
  {
    name: 'stack_brief',
    description: 'Your brief and your local ticket: the ticket, your part of the plan, the files you own, the interfaces, your tests and acceptance criteria, and the work log. Read it again whenever you are unsure.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'stack_status',
    description: 'The whole stack: every PR, its repo, branch, status and who owns which files.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

const PLANNER: ToolDef[] = [{
  name: 'submit_plan',
  description: 'Submit the plan. All its problems come back at once if it has any; otherwise it goes to the user to approve.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'object',
        description: '{ summary, prs: [{ index, repo, below, title, scope, owns, uses, tests: { add, run }, acceptance }], interfaces: [{ name, owner, contract }], shared: [{ repo, path, owner, why }], deployOrder: [repo…] | null, addRepos: [{ path, base, why }], docs: { files: [{ repo, path }] } | { none: "why" }, advice: { recommended: "independent" | "stacked" | "single", factors: [{ factor: "coupling" | "overlap" | "size" | "repos" | "review" | "shipping", note, favours: strategy | null }], means: { independent, stacked, single } } }',
      },
    },
    required: ['plan'],
    additionalProperties: false,
  },
}]

const CODER: ToolDef[] = [
  {
    name: 'report',
    description: 'Tell tring where your PR is. interface_ready: the interfaces you provide are committed. tests_passing / restacked: give the commit sha you ran the tests on and their summary lines (tring checks it is HEAD and nothing is uncommitted). tests_failing: what failed.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['interface_ready', 'tests_passing', 'tests_failing', 'restacked'] },
        sha: { type: 'string', description: 'The commit the tests ran on.' },
        evidence: { type: 'string', description: 'The test commands and their summary lines.' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_pr',
    description: 'Once you have pushed your branch (only when tring tells you to push): tring opens your draft PR against the branch below, or, after a restack, points the PR you already have at it. You never open or edit PRs yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The PR title.' },
        body: { type: 'string', description: 'The PR description (Markdown). Say it is part of a stack and what it sits on.' },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'resolve_finding',
    description: 'After looking into a review finding you were sent: "fixed" (committed), or "declined" with why it is not really an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        outcome: { type: 'string', enum: ['fixed', 'declined'] },
        note: { type: 'string', description: 'What you changed, or why you declined.' },
      },
      required: ['id', 'outcome', 'note'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_change',
    description: 'Ask the PR that owns a file for a change you need there (you may not edit it yourself).',
    inputSchema: {
      type: 'object',
      properties: { to_pr: { type: 'integer', minimum: 1 }, what: { type: 'string' } },
      required: ['to_pr', 'what'],
      additionalProperties: false,
    },
  },
  {
    name: 'amend_interface',
    description: 'Ask to change an interface your PR provides. The user decides; every PR that uses it is told.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, contract: { type: 'string' }, why: { type: 'string' } },
      required: ['name', 'contract', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'blocked',
    description: 'You cannot go on without help: a conflict in a file you do not own, a decision, something broken outside your PR.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
]

const REVIEWER: ToolDef[] = [{
  name: 'submit_review',
  description: 'Your review: every finding (high and medium hold the PR; low and nit do not), whether the PR\'s tests passed when you ran them, and their summary lines.',
  inputSchema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['high', 'medium', 'low', 'nit'] },
            file: { type: 'string' },
            line: { type: 'integer' },
            summary: { type: 'string' },
            proof: { type: 'string', description: 'How you showed it: the failing command and its output, or the changed line. High and medium findings hold the PR only with proof.' },
            pre_existing: { type: 'boolean', description: 'The problem was already on the base before this PR: it never holds the PR, and is listed as a follow-up.' },
          },
          required: ['severity', 'summary'],
          additionalProperties: false,
        },
      },
      tests_passed: { type: 'boolean' },
      evidence: { type: 'string' },
    },
    required: ['findings', 'tests_passed', 'evidence'],
    additionalProperties: false,
  },
}]

const INTEGRATOR: ToolDef[] = [{
  name: 'report_integration',
  description: 'The integration check\'s result: the sha you tested (the merge your worktree is at), whether everything passed, the commands and their summary lines as evidence, and each failing test with the unit whose files it exercises when you can tell.',
  inputSchema: {
    type: 'object',
    properties: {
      sha: { type: 'string' },
      passed: { type: 'boolean' },
      evidence: { type: 'string' },
      failures: {
        type: 'array',
        items: {
          type: 'object',
          properties: { test: { type: 'string' }, unit: { type: 'integer', minimum: 1 } },
          required: ['test'],
          additionalProperties: false,
        },
      },
    },
    required: ['sha', 'passed', 'evidence'],
    additionalProperties: false,
  },
}]

export function toolsFor(role: Role): ToolDef[] {
  return [...COMMON, ...(role === 'planner' ? PLANNER : role === 'coder' ? CODER : role === 'integrator' ? INTEGRATOR : REVIEWER)]
}

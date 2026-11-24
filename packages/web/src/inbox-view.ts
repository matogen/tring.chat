import type { InboxItem, InboxQuestion } from '@tring/shared/protocol'

/**
 * What a card says, separate from how it is drawn, so it can be tested
 * without a DOM. Everything here is the agent's text and is untrusted: the
 * panel puts it on screen through textContent only.
 */

/**
 * A ceiling against a runaway input (a Write of a whole bundle), not a reading
 * limit: an agent's reply or plan is shown whole, and a long one folds behind
 * "Show all" on its card. At 4000 replies were cut mid-sentence.
 */
export const MAX_BODY = 100_000

export interface CardText {
  /** "Run a command", "Edit a file", "Question", "Finished" … */
  heading: string
  /** The tool's name as Claude Code reports it, for the permission cards. */
  tool?: string
  /** The thing being approved: a command, a path, or the input as JSON. */
  body: string
  /** True when `body` is code-like and should be monospaced. */
  mono: boolean
  /** The agent's own one-line reason, when it gave one. */
  note?: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

export function clip(text: string, max = MAX_BODY): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… ${text.length - max} more characters`
}

export function describe(item: InboxItem): CardText {
  if (item.kind === 'reply') {
    // A prompt that a restart cut off (see card-store.ts on the server): the
    // agent did not finish, it stopped where it was asking.
    const heading = item.interrupted === 'question' ? 'Question cut off by a restart'
      : item.interrupted === 'permission' ? 'Permission cut off by a restart'
      : 'Finished — waiting for you'
    return { heading, body: clip(item.message ?? ''), mono: false }
  }
  if (item.kind === 'question') {
    return { heading: 'Question', body: '', mono: false }
  }

  const input = item.input ?? {}
  const tool = item.tool ?? 'tool'
  const note = str(input['description'])
  const path = str(input['file_path']) ?? str(input['notebook_path']) ?? str(input['path'])

  switch (tool) {
    case 'Bash':
      return { heading: 'Run a command', tool, body: clip(str(input['command']) ?? ''), mono: true, ...(note ? { note } : {}) }
    case 'Edit':
    case 'MultiEdit':
      return { heading: 'Edit a file', tool, body: clip(editBody(input, path)), mono: true }
    case 'Write':
      return { heading: 'Write a file', tool, body: clip(`${path ?? ''}\n\n${str(input['content']) ?? ''}`), mono: true }
    case 'NotebookEdit':
      return { heading: 'Edit a notebook', tool, body: clip(path ?? ''), mono: true }
    case 'WebFetch':
      return { heading: 'Fetch a web page', tool, body: clip(str(input['url']) ?? ''), mono: true, ...(str(input['prompt']) ? { note: str(input['prompt'])! } : {}) }
    case 'WebSearch':
      return { heading: 'Search the web', tool, body: clip(str(input['query']) ?? ''), mono: false }
    case 'ExitPlanMode':
      return { heading: 'Approve the plan', tool, body: clip(str(input['plan']) ?? ''), mono: false }
  }
  const heading = tool.startsWith('mcp__') ? `Use ${tool.split('__')[1] ?? 'an MCP'} tool` : `Use ${tool}`
  return { heading, tool, body: clip(JSON.stringify(input, null, 2)), mono: true, ...(note ? { note } : {}) }
}

function editBody(input: Record<string, unknown>, path: string | undefined): string {
  const edits = Array.isArray(input['edits'])
    ? (input['edits'] as Array<Record<string, unknown>>)
    : [input]
  const parts = edits.map((e) => {
    const old = str(e['old_string']) ?? ''
    const neu = str(e['new_string']) ?? ''
    return [...old.split('\n').map((l) => `- ${l}`), ...neu.split('\n').map((l) => `+ ${l}`)].join('\n')
  })
  return [path ?? '', ...parts].join('\n\n')
}

/**
 * The answers map AskUserQuestion expects: question text to the chosen
 * label, several labels joined with ", " for a multi-select. Null until every
 * question has an answer, since a partial answer would be sent as final.
 */
export function answersFor(
  questions: InboxQuestion[],
  chosen: ReadonlyMap<number, ReadonlySet<string>>,
  other: ReadonlyMap<number, string>,
): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const [i, q] of questions.entries()) {
    const picks = [...(chosen.get(i) ?? [])]
    const typed = other.get(i)?.trim()
    if (typed) picks.push(typed)
    if (picks.length === 0) return null
    out[q.question] = q.multiSelect ? picks.join(', ') : picks[picks.length - 1]!
  }
  return out
}

/** "12s", "4m", "2h" — how long a card has been waiting. */
export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

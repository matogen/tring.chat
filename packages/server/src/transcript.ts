import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * What a tile's Claude has been asked and has said, read from Claude Code's
 * own transcript (`~/.claude/projects/<dir>/<session>.jsonl`).
 *
 * The orchestrator agent uses it to route "change the reporting box" to the
 * tile that has been working on the reporting box: the conversation is the
 * one record of what a tile is *about* that survives a commit, a cleared
 * screen and a last message on something else. Read-only, local, and only
 * ever the transcript of a conversation a tile is running.
 */

export interface Turn {
  role: 'user' | 'assistant'
  text: string
  /** ISO time from the transcript, when it has one. */
  at: string | null
  /** Files the agent edited or wrote in this turn. */
  files?: string[]
}

export interface Transcript {
  /** Claude Code's own title for the conversation (`ai-title`), newest. */
  title: string | null
  turns: Turn[]
  /** True when only the head and tail of a very long file were read. */
  partial: boolean
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** Read whole up to this; past it, the head (first prompt, title) and the tail. */
const WHOLE_BYTES = 8 << 20
const HEAD_BYTES = 512 << 10
const TAIL_BYTES = 8 << 20

/**
 * A prompt a person gave, as opposed to the things Claude Code files as user
 * messages: tool results, task notifications, slash-command echoes, injected
 * reminders. A prompt the orchestrator typed in counts — it arrives typed.
 */
function humanPrompt(j: Record<string, unknown>): string | null {
  const msg = j['message'] as { content?: unknown } | undefined
  if (j['isMeta'] || j['isSidechain']) return null
  const origin = j['origin'] as { kind?: string } | undefined
  if (origin && origin.kind !== 'human') return null
  let text: string | null = null
  if (typeof msg?.content === 'string') text = msg.content
  else if (Array.isArray(msg?.content)) {
    const blocks = msg.content as Array<{ type?: string; text?: string }>
    if (blocks.some((b) => b.type === 'tool_result')) return null
    text = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') || null
  }
  text = text?.trim() ?? null
  if (!text || text.startsWith('<')) return null
  return text
}

/** The transcript's lines, in order, into turns. Unknown lines are skipped. */
export function parseTranscript(lines: string[]): Omit<Transcript, 'partial'> {
  let title: string | null = null
  const turns: Turn[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    let j: Record<string, unknown>
    try { j = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const at = typeof j['timestamp'] === 'string' ? j['timestamp'] : null
    if (j['type'] === 'ai-title' && typeof j['aiTitle'] === 'string') { title = j['aiTitle']; continue }
    if (j['type'] === 'user') {
      const text = humanPrompt(j)
      if (text) turns.push({ role: 'user', text, at })
      continue
    }
    if (j['type'] !== 'assistant' || j['isSidechain']) continue
    const blocks = (j['message'] as { content?: unknown } | undefined)?.content
    if (!Array.isArray(blocks)) continue
    const texts: string[] = []
    const files: string[] = []
    for (const b of blocks as Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }>) {
      if (b.type === 'text' && b.text?.trim()) texts.push(b.text.trim())
      if (b.type === 'tool_use' && b.name && EDIT_TOOLS.has(b.name)) {
        const f = b.input?.['file_path'] ?? b.input?.['notebook_path']
        if (typeof f === 'string') files.push(f)
      }
    }
    if (!texts.length && !files.length) continue
    // One assistant turn is many transcript lines (text, tools, more text):
    // they are folded together until the next prompt.
    const last = turns[turns.length - 1]
    if (last?.role === 'assistant') {
      if (texts.length) last.text = [last.text, ...texts].filter(Boolean).join('\n\n')
      if (files.length) last.files = [...new Set([...(last.files ?? []), ...files])]
    } else {
      turns.push({ role: 'assistant', text: texts.join('\n\n'), at, ...(files.length ? { files: [...new Set(files)] } : {}) })
    }
  }
  return { title, turns }
}

async function readRange(file: string, start: number, length: number): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, start)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

const cache = new Map<string, { key: string; value: Transcript }>()
const CACHE_LIMIT = 48

/** A transcript, read and parsed once per change of size or time. Null when unreadable. */
export async function readTranscript(file: string): Promise<Transcript | null> {
  let info
  try { info = await stat(file) } catch { return null }
  const key = `${info.size}:${info.mtimeMs}`
  const hit = cache.get(file)
  if (hit?.key === key) return hit.value
  let lines: string[]
  let partial = false
  try {
    if (info.size <= WHOLE_BYTES) {
      lines = (await readRange(file, 0, info.size)).split('\n')
    } else {
      // Head for the opening prompt, tail for the recent work; the line each
      // cut lands in is dropped rather than parsed half-way.
      const head = (await readRange(file, 0, HEAD_BYTES)).split('\n').slice(0, -1)
      const tail = (await readRange(file, info.size - TAIL_BYTES, TAIL_BYTES)).split('\n').slice(1)
      lines = [...head, ...tail]
      partial = true
    }
  } catch {
    return null
  }
  const value = { ...parseTranscript(lines), partial }
  cache.delete(file)
  cache.set(file, { key, value })
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return value
}

/**
 * The transcript of conversation `id`, when no hook has said where it is yet
 * (a tile restored before its next hook). Claude Code files it under a
 * directory named after the cwd; rather than re-derive that naming, look for
 * the one file with this id.
 */
export async function findTranscript(projectsDir: string, id: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  let dirs: string[]
  try { dirs = await readdir(projectsDir) } catch { return null }
  for (const d of dirs) {
    const f = path.join(projectsDir, d, `${id}.jsonl`)
    try { if ((await stat(f)).isFile()) return f } catch { /* not here */ }
  }
  return null
}

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { InboxItem, InboxQuestion } from '@tring/shared/protocol'
import { toolPhrase } from './notifier.ts'

/**
 * The orchestrator inbox, kept across a restart of the daemon.
 *
 * A card names its tile by session id, and a session id is minted fresh every
 * time a tile spawns, so no id from before a restart means anything after it.
 * What does carry over is where the tile is (project and slot) and the Claude
 * conversation in it, which the restored tile reopens with `claude --resume`.
 * A card is saved with both and comes back on the tile that reopens that
 * conversation; one whose conversation nobody reopens is gone with it.
 *
 * Only cards a person can still act on are worth keeping, and after a restart
 * that is always a reply card. A permission prompt or question was held open
 * by a hook that died with the old daemon, and the agent comes back waiting
 * for a prompt rather than for that answer, so it is saved as a reply card
 * that says what was being asked (`interrupted`).
 */

/** Which tile a card belongs to, in terms that survive a restart. */
export interface TileRef {
  projectId: string
  slot: number
  /** The Claude conversation in the tile: the one a restart reopens there. */
  claudeId: string
}

export interface SavedCard {
  /** Always a reply card (see asSaved); `sessionId` is the old, dead one. */
  item: InboxItem
  tile: TileRef
}

interface CardsFile {
  version: 1
  cards: SavedCard[]
}

/** The parts of a restored tile that matching reads; a Session has them. */
export interface LiveTile {
  id: string
  slot: number
  claude: { id: string } | null
}

/** A ceiling on what a saved card quotes from the tool input it was asking about. */
const DETAIL_MAX = 2000

export class CardStore {
  private writing: Promise<void> = Promise.resolve()
  private last: string | null = null
  private closed = false

  /**
   * `locate` says where a live session is; null for one that is gone, or
   * that has no Claude conversation to come back to.
   */
  constructor(
    private readonly file: string,
    private readonly locate: (sessionId: string) => TileRef | null,
  ) {}

  /** What was saved, checked rather than trusted. Nothing on a first run. */
  async load(): Promise<SavedCard[]> {
    let parsed: Partial<CardsFile> | null
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<CardsFile>
    } catch {
      return []
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.cards)) return []
    return parsed.cards.filter(validCard)
  }

  /**
   * Writes the cards as they stand. Called on every change to the inbox and
   * to the tiles, since a moved tile or a new conversation changes where a
   * card belongs; unchanged contents are not written again.
   */
  save(items: InboxItem[]): Promise<void> {
    if (this.closed) return this.writing
    const cards: SavedCard[] = []
    for (const item of items) {
      const tile = this.locate(item.sessionId)
      if (tile) cards.push({ item: asSaved(item), tile })
    }
    const text = JSON.stringify({ version: 1, cards } satisfies CardsFile, null, 2) + '\n'
    if (text === this.last) return this.writing
    this.last = text
    // Chained, so two quick changes cannot land out of order.
    this.writing = this.writing.then(() => writeAtomic(this.file, text)).catch(() => {})
    return this.writing
  }

  /**
   * Shutdown has started. Stopping the daemon ends every tile, and each card
   * goes with its tile on the way out; that is not the inbox to come back to,
   * so nothing more is written. Resolves once the last real write is down.
   */
  close(): Promise<void> {
    this.closed = true
    return this.writing
  }
}

/**
 * The saved cards that still have a tile, re-pointed at its new session id.
 *
 * `tilesWith` lists a project's tiles if one of them reopens conversation
 * `claudeId` (spawning a project that was waiting to be opened, since a card
 * is no use without a tile to reply into), and nothing otherwise. Within the
 * conversation's tiles, the one in the card's slot wins.
 */
export function restoreCards(
  saved: SavedCard[],
  tilesWith: (projectId: string, claudeId: string) => LiveTile[],
): InboxItem[] {
  const out: InboxItem[] = []
  for (const { item, tile } of saved) {
    const mine = tilesWith(tile.projectId, tile.claudeId).filter((t) => t.claude?.id === tile.claudeId)
    const to = mine.find((t) => t.slot === tile.slot) ?? mine[0]
    if (to) out.push({ ...item, sessionId: to.id })
  }
  return out
}

/** A card as it is saved: a reply card, with nothing that only a live hook could use. */
export function asSaved(item: InboxItem): InboxItem {
  const base = { id: item.id, sessionId: item.sessionId, kind: 'reply' as const, createdAt: item.createdAt }
  if (item.kind === 'question') {
    return { ...base, interrupted: 'question', message: questionMessage(item.questions ?? []) }
  }
  if (item.kind === 'permission') {
    return { ...base, interrupted: 'permission', message: permissionMessage(item.tool, item.input ?? {}) }
  }
  return { ...base, message: item.message ?? '', ...(item.interrupted ? { interrupted: item.interrupted } : {}) }
}

/**
 * The questions, written the way the card's choice buttons read a message
 * (web/src/choices.ts): ❓, a question with a "?", then (a), (b)… — numbered
 * Q1, Q2 when there are several — so they come back as buttons.
 */
function questionMessage(qs: InboxQuestion[]): string {
  const many = qs.length > 1
  const blocks = qs.map((q, n) => {
    const text = q.question.trim()
    const ask = q.multiSelect ? ' (choose any)' : text.includes('?') ? '' : ' (choose one)'
    const title = `❓ ${many ? `**Q${n + 1}** - ` : ''}**${text}**${ask}`
    const options = q.options.map((o, k) =>
      `- (${String.fromCharCode(97 + k)}) ${o.label}${o.description ? ` — ${o.description}` : ''}`)
    return [title, ...options].join('\n')
  })
  return ['tring restarted while this question was open, so the agent never got your answer. Reply to answer it now.', ...blocks]
    .join('\n\n')
}

function permissionMessage(tool: string | undefined, input: Record<string, unknown>): string {
  const head = `tring restarted while this was waiting for your permission to ${toolPhrase(tool)}, so it did not go ahead.`
  const detail = toolDetail(tool, input)
  const tail = 'Reply to tell it what to do, for example "go ahead".'
  return detail ? `${head}\n\n${detail}\n\n${tail}` : `${head}\n\n${tail}`
}

/** The thing that was to be approved, as markdown: a command, a path, a URL, a plan. */
function toolDetail(tool: string | undefined, input: Record<string, unknown>): string {
  const str = (k: string): string | null => {
    const v = input[k]
    return typeof v === 'string' && v.trim() ? clip(v.trim()) : null
  }
  switch (tool) {
    case 'Bash': case 'PowerShell': {
      const cmd = str('command')
      return cmd ? fenced(cmd) : ''
    }
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': {
      const file = str('file_path') ?? str('notebook_path') ?? str('path')
      return file ? fenced(file) : ''
    }
    case 'WebFetch': return fenced(str('url') ?? '')
    case 'WebSearch': return fenced(str('query') ?? '')
    // A plan is markdown written to be read, so it is shown as such.
    case 'ExitPlanMode': return str('plan') ?? ''
  }
  return Object.keys(input).length ? fenced(clip(JSON.stringify(input, null, 2))) : ''
}

function clip(s: string): string {
  return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX)}\n… ${s.length - DETAIL_MAX} more characters` : s
}

/** A code fence longer than any run of backticks inside, so the text cannot close it. */
function fenced(s: string): string {
  if (!s) return ''
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${s}\n${fence}`
}

function validCard(v: unknown): v is SavedCard {
  const c = v as Partial<SavedCard> | null
  const item = c?.item
  const tile = c?.tile
  return !!item && !!tile &&
    typeof item.id === 'string' && !!item.id &&
    typeof item.sessionId === 'string' &&
    item.kind === 'reply' &&
    typeof item.message === 'string' &&
    typeof item.createdAt === 'number' &&
    (item.interrupted === undefined || item.interrupted === 'permission' || item.interrupted === 'question') &&
    typeof tile.projectId === 'string' &&
    Number.isInteger(tile.slot) &&
    typeof tile.claudeId === 'string' && !!tile.claudeId
}

/**
 * Through a temporary file and a rename, so a daemon killed mid-write (a
 * closed console window, a shutdown) leaves the old file, never half a new one.
 * The cards quote agents' messages and commands, so the file is private.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, text, { mode: 0o600 })
  try {
    await rename(tmp, file)
  } catch {
    // Windows refuses the rename while something (a virus scanner) has the
    // old file open; writing it in place is the next best thing.
    await writeFile(file, text, { mode: 0o600 })
    await rm(tmp, { force: true })
  }
  await chmod(file, 0o600).catch(() => { /* Windows has no mode */ })
}

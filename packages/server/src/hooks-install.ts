import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Claude Code hooks for orchestrator mode, merged into the user's settings.
 *
 * Every entry runs `tring-hook <Event>`, which exits at once and prints
 * nothing outside a tring session (it checks $TRING_SESSION_ID), so the same
 * settings file is safe for every `claude` the user runs anywhere. The command
 * prefix is also the marker: install drops any entry that starts with it
 * before adding its own, so running it twice changes nothing, and uninstall
 * removes exactly what install added and nothing the user wrote.
 */

export const HOOK_COMMAND = 'tring-hook'

interface HookSpec {
  event: string
  matcher?: string
  /** Seconds. A held prompt waits for a person, so those get an hour. */
  timeout: number
}

export const HOOK_SPECS: readonly HookSpec[] = [
  { event: 'PermissionRequest', timeout: 3600 },
  { event: 'PreToolUse', matcher: 'AskUserQuestion', timeout: 3600 },
  { event: 'PostToolUse', timeout: 10 },
  { event: 'PostToolUseFailure', timeout: 10 },
  { event: 'UserPromptSubmit', timeout: 10 },
  { event: 'Notification', timeout: 10 },
  { event: 'Stop', timeout: 10 },
]

interface HookEntry { type?: string; command?: string; timeout?: number }
interface HookGroup { matcher?: string; hooks?: HookEntry[] }
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> }

export function defaultClaudeSettingsPath(): string {
  const base = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude')
  return path.join(base, 'settings.json')
}

const ours = (h: HookEntry): boolean =>
  typeof h.command === 'string' && h.command.trim().startsWith(HOOK_COMMAND + ' ')

/** Settings with every tring entry taken out, and groups left empty removed. */
export function withoutHooks(settings: Settings): Settings {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings
  const hooks: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue }
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h)) }))
      .filter((g) => g.hooks.length > 0)
    if (kept.length) hooks[event] = kept
  }
  const out: Settings = { ...settings, hooks }
  if (Object.keys(hooks).length === 0) delete out.hooks
  return out
}

/** Settings with tring's entries present exactly once each. */
export function withHooks(settings: Settings): Settings {
  const base = withoutHooks(settings)
  const hooks: Record<string, HookGroup[]> = { ...(base.hooks ?? {}) }
  for (const spec of HOOK_SPECS) {
    const group: HookGroup = {
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      hooks: [{ type: 'command', command: `${HOOK_COMMAND} ${spec.event}`, timeout: spec.timeout }],
    }
    hooks[spec.event] = [...(hooks[spec.event] ?? []), group]
  }
  return { ...base, hooks }
}

/** Which of tring's events are installed. */
export function installedEvents(settings: Settings): string[] {
  const found = new Set<string>()
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue
    if (groups.some((g) => (g.hooks ?? []).some(ours))) found.add(event)
  }
  return HOOK_SPECS.map((s) => s.event).filter((e) => found.has(e))
}

export interface HooksStatus {
  path: string
  /** Every event tring needs is present. */
  installed: boolean
  events: string[]
}

async function read(file: string): Promise<Settings | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object`)
  }
  return parsed as Settings
}

/**
 * Written beside the original and renamed over it, with the previous file
 * kept as `settings.json.tring-backup`. A settings file that does not parse is
 * refused rather than replaced: it is the user's, and a guess at repairing it
 * would lose whatever they were in the middle of writing.
 */
async function write(file: string, previous: boolean, settings: Settings): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  if (previous) await copyFile(file, `${file}.tring-backup`)
  const tmp = `${file}.tring-${process.pid}`
  await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

export async function hooksStatus(file = defaultClaudeSettingsPath()): Promise<HooksStatus> {
  let settings: Settings | null = null
  try { settings = await read(file) } catch { settings = null }
  const events = settings ? installedEvents(settings) : []
  return { path: file, events, installed: events.length === HOOK_SPECS.length }
}

export async function installHooks(file = defaultClaudeSettingsPath()): Promise<void> {
  const current = await read(file)
  await write(file, current !== null, withHooks(current ?? {}))
}

export async function uninstallHooks(file = defaultClaudeSettingsPath()): Promise<boolean> {
  const current = await read(file)
  if (!current || installedEvents(current).length === 0) return false
  await write(file, true, withoutHooks(current))
  return true
}

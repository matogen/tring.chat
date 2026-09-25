import { execFile } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { DiffFile, DiffResult } from '@tring/shared/protocol'

const run = promisify(execFile)

/** Patch text the panel is sent in total; past it, files keep only their counts. */
export const MAX_PATCH_BYTES = 1 << 20

/** `git hash-object -t tree /dev/null`: the base for a repository with no commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * A repository's own config can make git run programs — fsmonitor on every
 * status, external diff and textconv drivers on every diff. The panel polls
 * every two seconds in whatever directory the shell happens to be in, so none
 * of that runs; quotePath off keeps non-ASCII names readable.
 */
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false']

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', [...SAFE, ...args], {
    cwd, encoding: 'utf8', maxBuffer: 64 << 20,
  })
  return stdout
}

/**
 * `-c` overrides that empty every filter driver the repository defines.
 *
 * `git diff` pipes each stat-dirty file through its `.gitattributes` clean
 * filter, which is a command from config — the same hazard as fsmonitor, but
 * under a driver name only the config knows. Reading config runs nothing, so
 * the names are listed first and each driver is blanked; an empty command is
 * git's own "no filter", and `required=false` keeps that from being an error.
 */
async function filtersOff(root: string): Promise<string[]> {
  const keys = await git(root, ['config', '--name-only', '--get-regexp', '^filter\\.']).catch(() => '')
  const drivers = new Set(keys.split('\n').filter(Boolean).map((k) => k.slice(0, k.lastIndexOf('.'))))
  return [...drivers].flatMap((d) => [
    '-c', `${d}.clean=`, '-c', `${d}.smudge=`, '-c', `${d}.process=`, '-c', `${d}.required=false`,
  ])
}

/** `+++ b/x` → `x`; git appends a TAB when the path has a space in it. */
const pathOf = (line: string): string => line.slice(6).replace(/\t$/, '')

/** A `git diff` into one entry per file, patch trimmed to its hunks. */
export function splitPatch(text: string): DiffFile[] {
  const out: DiffFile[] = []
  for (const chunk of text.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue
    const lines = chunk.replace(/\n$/, '').split('\n')
    const plus = lines.find((l) => l.startsWith('+++ '))
    const minus = lines.find((l) => l.startsWith('--- '))
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(lines[0]!)
    const file =
      plus && plus !== '+++ /dev/null' ? pathOf(plus)
        : minus && minus !== '--- /dev/null' ? pathOf(minus)
          : header?.[2] ?? lines[0]!
    if (lines.some((l) => l.startsWith('Binary files '))) {
      out.push({ path: file, added: 0, removed: 0, patch: '', note: 'binary' })
      continue
    }
    const start = lines.findIndex((l) => l.startsWith('@@'))
    const hunks = start < 0 ? [] : lines.slice(start)
    let added = 0
    let removed = 0
    for (const l of hunks) {
      if (l.startsWith('+')) added++
      else if (l.startsWith('-')) removed++
    }
    out.push({ path: file, added, removed, patch: hunks.join('\n') })
  }
  return out
}

/**
 * An untracked file as an all-added patch, never read past `budget`.
 *
 * Null for a file that vanished between `ls-files` and here — an editor's
 * swap file does that constantly — and a note for one that cannot be read,
 * so one odd file never takes the whole panel down with it.
 */
async function untracked(root: string, rel: string, budget: number): Promise<DiffFile | null> {
  const full = path.join(root, rel)
  let bytes: Buffer
  try {
    const st = await lstat(full)
    if (!st.isFile()) return { path: rel, added: 0, removed: 0, patch: '', note: 'not a regular file' }
    if (st.size > budget) return { path: rel, added: 0, removed: 0, patch: '', note: 'too large' }
    bytes = await readFile(full)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { path: rel, added: 0, removed: 0, patch: '', note: 'unreadable' }
  }
  if (bytes.length === 0) return { path: rel, added: 0, removed: 0, patch: '' }
  if (bytes.subarray(0, 8000).includes(0)) return { path: rel, added: 0, removed: 0, patch: '', note: 'binary' }
  const lines = bytes.toString('utf8').replace(/\n$/, '').split('\n')
  return {
    path: rel,
    added: lines.length,
    removed: 0,
    patch: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n'),
  }
}

/**
 * Everything uncommitted in the repository containing `cwd`: tracked changes
 * against HEAD (or the empty tree before the first commit) plus untracked
 * files. Always from the repository root, so a shell sitting in a
 * subdirectory still sees the whole change set with root-relative paths.
 */
export async function gitDiff(cwd: string): Promise<DiffResult> {
  let root: string
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return { cwd, error: 'not a git repository' }
  }
  try {
    const base = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => 'HEAD', () => EMPTY_TREE)
    const tracked = splitPatch(await git(root, [
      ...await filtersOff(root),
      'diff', base, '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
      // Whatever diff.noprefix / diff.mnemonicPrefix the user has set.
      '--src-prefix=a/', '--dst-prefix=b/',
    ]))
    const names = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0').filter(Boolean).sort()

    // One at a time against a shrinking budget: a repo that does not ignore
    // its build output can list thousands of files, and reading them all at
    // once is hundreds of MB every two seconds.
    const loose: DiffFile[] = []
    let readBudget = MAX_PATCH_BYTES
    for (const n of names) {
      const f = await untracked(root, n, readBudget)
      if (!f) continue
      readBudget = Math.max(0, readBudget - Buffer.byteLength(f.patch))
      loose.push(f)
    }
    const files = [...tracked, ...loose].sort((a, b) => a.path.localeCompare(b.path))

    let budget = MAX_PATCH_BYTES
    let truncated = files.some((f) => f.note === 'too large')
    for (const f of files) {
      const size = Buffer.byteLength(f.patch)
      if (size <= budget) { budget -= size; continue }
      f.patch = ''
      f.note = 'too large'
      truncated = true
    }
    return { cwd, files, truncated }
  } catch (err) {
    return { cwd, error: `cannot read the changes: ${(err as Error).message.split('\n')[0]}` }
  }
}

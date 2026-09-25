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

/** An untracked file as an all-added patch, never read past the cap. */
async function untracked(root: string, rel: string): Promise<DiffFile> {
  const full = path.join(root, rel)
  const st = await lstat(full)
  if (!st.isFile()) return { path: rel, added: 0, removed: 0, patch: '', note: 'not a regular file' }
  if (st.size > MAX_PATCH_BYTES) return { path: rel, added: 0, removed: 0, patch: '', note: 'too large' }
  const bytes = await readFile(full)
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
      'diff', base, '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
    ]))
    const names = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0').filter(Boolean)
    const files = [...tracked, ...await Promise.all(names.map((n) => untracked(root, n)))]
      .sort((a, b) => a.path.localeCompare(b.path))

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

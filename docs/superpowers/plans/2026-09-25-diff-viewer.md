# Diff Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A resizable panel beside the centre terminal showing the focused session's uncommitted git changes, opened from the tile's right-click dialog.

**Architecture:** The daemon gains `GET /api/sessions/:id/diff`, which runs git (no shell, repo-config programs disabled) in the session's live cwd and returns per-file patches. The web client adds a `DiffPanel` inside `.focus-cell` that polls that route every 2s while open, renders with `textContent` only, and has a drag handle whose width persists in `localStorage`.

**Tech Stack:** TypeScript, Node `child_process.execFile`, vanilla DOM, xterm.js (existing), vitest.

**Spec:** `docs/superpowers/specs/2026-09-25-diff-viewer-design.md`

## Global Constraints

- Compare base: `git diff HEAD` plus untracked files (`ls-files --others --exclude-standard`); empty tree when the repo has no commits.
- git runs via `execFile`, never a shell, always with `-c core.fsmonitor=false -c core.quotePath=false` and `--no-ext-diff --no-textconv --no-color --no-renames` on `diff`.
- Total patch text capped at 1 MB (`1 << 20` bytes); files past the cap keep their counts, lose their patch, and set `truncated: true`.
- Poll interval 2000 ms, only while the panel is open; at most one request in flight.
- Panel width clamped to 240 px … 75% of the focus cell; width and open state stored under `localStorage` key `tring.diffPanel`, every access in try/catch.
- Hidden at `(max-width: 720px)` (`MOBILE_QUERY`), including the dialog button.
- File content reaches the DOM only through `textContent` — never `innerHTML`.
- Existing colour tokens only (`--mint`, `--red`, `--dim`, `--line`, …).

## Review Focus

- **Focus switches while a request is in flight** → the late response for the old session must not be drawn over the new one. Test: `DiffPanel` drops responses whose session id no longer matches (covered by the `id !== this.sessionId` guard in Task 3; exercised manually in Task 3 Step 8).
- **Repo with no commits yet** → staged and untracked files still listed, not an error. Test in Task 1.
- **Path containing spaces** → git appends a TAB to `+++ b/…` for such paths; the path must come out clean. Test in Task 1.
- **Binary or huge untracked file** → shown with a note, never read whole into memory or dumped as garbage. Tests in Task 1.
- **Session cwd is a subdirectory of the repo** → still the whole repo's changes, paths relative to the repo root. Test in Task 1.

## Execution setup

Work on a new branch `feat/diff-viewer` cut from `main` (use superpowers:using-git-worktrees; the current checkout has unrelated uncommitted work on `bugfix/fig-drag-and-drop`). First commit on that branch: copy in the spec and this plan.

```bash
git add docs/superpowers/specs/2026-09-25-diff-viewer-design.md docs/superpowers/plans/2026-09-25-diff-viewer.md
git commit -m "docs: diff viewer spec and plan"
```

---

### Task 1: Server — git diff module and route

**Files:**
- Modify: `packages/shared/src/protocol.ts` (append types)
- Create: `packages/server/src/git-diff.ts`
- Modify: `packages/server/src/http.ts` (new route next to `/api/sessions/:id/status`, ~line 225)
- Create: `packages/server/test/git-diff.test.ts`
- Modify: `packages/server/test/http.test.ts` (two tests in the sessions `describe`)

**Interfaces:**
- Produces (shared):
  ```ts
  export interface DiffFile { path: string; added: number; removed: number; patch: string; note?: string }
  export type DiffResult =
    | { cwd: string; files: DiffFile[]; truncated: boolean }
    | { cwd: string; error: string }
  ```
- Produces (server): `splitPatch(text: string): DiffFile[]`, `gitDiff(cwd: string): Promise<DiffResult>`, `MAX_PATCH_BYTES = 1 << 20`.
- Route: `GET /api/sessions/:id/diff` → `200 DiffResult` or `404 { error: 'no such session' }`.

- [ ] **Step 1: Add the shared types**

Append to `packages/shared/src/protocol.ts`:

```ts
/** One file in a session's uncommitted changes (GET /api/sessions/:id/diff). */
export interface DiffFile {
  /** Relative to the repository root. */
  path: string
  added: number
  removed: number
  /** Unified hunks from the first `@@` on; empty when `note` is set. */
  patch: string
  /** Shown instead of the patch: 'binary', 'too large', 'not a regular file'. */
  note?: string
}

export type DiffResult =
  | { cwd: string; files: DiffFile[]; truncated: boolean }
  | { cwd: string; error: string }
```

- [ ] **Step 2: Write the failing tests**

Create `packages/server/test/git-diff.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DiffFile } from '@tring/shared/protocol'
import { gitDiff, MAX_PATCH_BYTES, splitPatch } from '../src/git-diff.ts'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd })

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-diff-'))
  git(dir, 'init', '-q')
  return dir
}

const files = async (cwd: string): Promise<DiffFile[]> => {
  const r = await gitDiff(cwd)
  if ('error' in r) throw new Error(r.error)
  return r.files
}

describe('splitPatch', () => {
  it('splits files, counts lines, and keeps only the hunks', () => {
    const text = [
      'diff --git a/a.ts b/a.ts',
      'index 1..2 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      '',
    ].join('\n')
    expect(splitPatch(text)).toEqual([
      { path: 'a.ts', added: 1, removed: 1, patch: '@@ -1,2 +1,2 @@\n keep\n-old\n+new' },
      { path: 'gone.ts', added: 0, removed: 1, patch: '@@ -1 +0,0 @@\n-bye' },
    ])
  })

  it('strips the tab git appends to a path with a space in it', () => {
    const text = 'diff --git a/my file.ts b/my file.ts\n--- a/my file.ts\t\n+++ b/my file.ts\t\n@@ -1 +1 @@\n-a\n+b\n'
    expect(splitPatch(text)[0]!.path).toBe('my file.ts')
  })

  it('marks a binary change instead of carrying a patch', () => {
    const text = 'diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n'
    expect(splitPatch(text)).toEqual([
      { path: 'logo.png', added: 0, removed: 0, patch: '', note: 'binary' },
    ])
  })
})

describe('gitDiff', () => {
  it('reports a directory outside any repository as a state, not a throw', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-nogit-'))
    expect(await gitDiff(dir)).toEqual({ cwd: dir, error: 'not a git repository' })
  })

  it('lists a modified tracked file and an untracked one', async () => {
    const dir = await repo()
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', 'init')
    await writeFile(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    await writeFile(path.join(dir, 'new.txt'), 'x\ny\n')

    expect(await files(dir)).toEqual([
      { path: 'a.txt', added: 2, removed: 1, patch: '@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+three' },
      { path: 'new.txt', added: 2, removed: 0, patch: '@@ -0,0 +1,2 @@\n+x\n+y' },
    ])
  })

  it('works in a repository with no commits yet', async () => {
    const dir = await repo()
    await writeFile(path.join(dir, 'staged.txt'), 's\n')
    git(dir, 'add', 'staged.txt')
    await writeFile(path.join(dir, 'loose.txt'), 'l\n')

    expect((await files(dir)).map((f) => [f.path, f.added])).toEqual([
      ['loose.txt', 1], ['staged.txt', 1],
    ])
  })

  it('reports the whole repository from a subdirectory, paths from the root', async () => {
    const dir = await repo()
    await mkdir(path.join(dir, 'sub'))
    await writeFile(path.join(dir, 'top.txt'), 't\n')
    expect((await files(path.join(dir, 'sub'))).map((f) => f.path)).toEqual(['top.txt'])
  })

  it('notes a binary untracked file instead of reading it as text', async () => {
    const dir = await repo()
    await writeFile(path.join(dir, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    expect(await files(dir)).toEqual([
      { path: 'blob.bin', added: 0, removed: 0, patch: '', note: 'binary' },
    ])
  })

  it('stops carrying patches past the cap and says so', async () => {
    const dir = await repo()
    const big = 'x'.repeat(1000) + '\n'
    await writeFile(path.join(dir, 'a.txt'), big.repeat(700)) // ~700 KB
    await writeFile(path.join(dir, 'b.txt'), big.repeat(700))
    const r = await gitDiff(dir)
    if ('error' in r) throw new Error(r.error)
    expect(r.truncated).toBe(true)
    expect(r.files.map((f) => f.added)).toEqual([700, 700])
    expect(r.files[1]!.patch).toBe('')
    expect(r.files[1]!.note).toBe('too large')
    const total = r.files.reduce((n, f) => n + Buffer.byteLength(f.patch), 0)
    expect(total).toBeLessThanOrEqual(MAX_PATCH_BYTES)
  })

  it('notes an untracked file over the cap without reading it', async () => {
    const dir = await repo()
    await writeFile(path.join(dir, 'huge.log'), Buffer.alloc(MAX_PATCH_BYTES + 1, 0x61))
    const r = await gitDiff(dir)
    if ('error' in r) throw new Error(r.error)
    expect(r.files).toEqual([{ path: 'huge.log', added: 0, removed: 0, patch: '', note: 'too large' }])
    expect(r.truncated).toBe(true)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/server/test/git-diff.test.ts`
Expected: FAIL — `Failed to resolve import "../src/git-diff.ts"`.

- [ ] **Step 4: Implement `packages/server/src/git-diff.ts`**

```ts
import { execFile } from 'node:child_process'
import { open, lstat } from 'node:fs/promises'
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

/** An untracked file as an all-added patch, read no further than the cap. */
async function untracked(root: string, rel: string): Promise<DiffFile> {
  const full = path.join(root, rel)
  const st = await lstat(full)
  if (!st.isFile()) return { path: rel, added: 0, removed: 0, patch: '', note: 'not a regular file' }
  if (st.size > MAX_PATCH_BYTES) return { path: rel, added: 0, removed: 0, patch: '', note: 'too large' }
  const fh = await open(full, 'r')
  let bytes: Buffer
  try {
    bytes = await fh.readFile()
  } finally {
    await fh.close()
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
```

- [ ] **Step 5: Run the module tests to verify they pass**

Run: `npx vitest run packages/server/test/git-diff.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Write the failing route tests**

In `packages/server/test/http.test.ts`, inside the same `describe` that holds `'lists sessions with their project name for scripts'`, add:

```ts
  it('serves the focused session\'s uncommitted changes', async () => {
    const r = await rig()
    execFileSync('git', ['init', '-q'], { cwd: r.dir })
    await writeFile(path.join(r.dir, 'hello.txt'), 'hi\n')
    const p = r.pm.createProject('demo', r.dir)
    const s = r.pm.create(p, {})!

    const res = await fetch(`${r.base}/api/sessions/${s.id}/diff`)
    expect(res.status).toBe(200)
    const body = await res.json() as { files: { path: string }[] }
    expect(body.files.map((f) => f.path)).toContain('hello.txt')
  })

  it('404s a diff for a session that does not exist', async () => {
    const r = await rig()
    const res = await fetch(`${r.base}/api/sessions/nope/diff`)
    expect(res.status).toBe(404)
  })
```

and add `import { execFileSync } from 'node:child_process'` to the imports at the top.

- [ ] **Step 7: Run to verify the route tests fail**

Run: `npx vitest run packages/server/test/http.test.ts -t diff`
Expected: `serves the focused session's uncommitted changes` FAILS with status 404 (no route yet). The 404 test may already pass through the unknown-route fallback; that is fine.

- [ ] **Step 8: Add the route**

In `packages/server/src/http.ts`, add `import { gitDiff } from './git-diff.ts'` beside the other local imports, and directly after the `/status` route block (the one ending `return json(res, 200, { ok: true })` before the `/api/fs` comment) add:

```ts
    // The panel beside the centre terminal: what is uncommitted where that
    // session's shell currently is. git is run without a shell and with the
    // repo-config program hooks switched off — see git-diff.ts.
    const diff = url.pathname.match(/^\/api\/sessions\/([^/]+)\/diff$/)
    if (diff && req.method === 'GET') {
      const s = pm.findSession(decodeURIComponent(diff[1]!))
      if (!s) return json(res, 404, { error: 'no such session' })
      return json(res, 200, await gitDiff(s.cwd))
    }
```

- [ ] **Step 9: Run the server tests and typecheck**

Run: `npx vitest run packages/server && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/protocol.ts packages/server/src/git-diff.ts packages/server/src/http.ts packages/server/test/git-diff.test.ts packages/server/test/http.test.ts
git commit -m "feat(server): serve a session's uncommitted changes for the diff panel"
```

---

### Task 2: Web — patch rows and width clamp (pure helpers)

**Files:**
- Create: `packages/web/src/diff-rows.ts`
- Create: `packages/web/test/diff-rows.test.ts`

Kept apart from the panel because `ws-client.ts` reads `location` at import time, which the node test environment does not have — the same reason `copy.ts` is pure.

**Interfaces:**
- Produces:
  ```ts
  export type Row =
    | { kind: 'hunk'; text: string }
    | { kind: 'add' | 'del' | 'ctx'; old: number | null; new: number | null; text: string }
  export function patchRows(patch: string): Row[]
  export const MIN_WIDTH = 240
  export function clampWidth(px: number, cellWidth: number): number
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/web/test/diff-rows.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { clampWidth, MIN_WIDTH, patchRows } from '../src/diff-rows.ts'

describe('patchRows', () => {
  it('numbers old and new lines independently across hunks', () => {
    const rows = patchRows([
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '@@ -10,2 +10,3 @@',
      ' j',
      '+k',
      ' l',
    ].join('\n'))
    expect(rows).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { kind: 'ctx', old: 1, new: 1, text: 'a' },
      { kind: 'del', old: 2, new: null, text: 'b' },
      { kind: 'add', old: null, new: 2, text: 'B' },
      { kind: 'ctx', old: 3, new: 3, text: 'c' },
      { kind: 'hunk', text: '@@ -10,2 +10,3 @@' },
      { kind: 'ctx', old: 10, new: 10, text: 'j' },
      { kind: 'add', old: null, new: 11, text: 'k' },
      { kind: 'ctx', old: 11, new: 12, text: 'l' },
    ])
  })

  it('starts a new file at line 1 and skips the no-newline marker', () => {
    expect(patchRows('@@ -0,0 +1,2 @@\n+x\n+y\n\\ No newline at end of file')).toEqual([
      { kind: 'hunk', text: '@@ -0,0 +1,2 @@' },
      { kind: 'add', old: null, new: 1, text: 'x' },
      { kind: 'add', old: null, new: 2, text: 'y' },
    ])
  })

  it('returns nothing for an empty patch', () => {
    expect(patchRows('')).toEqual([])
  })
})

describe('clampWidth', () => {
  it('keeps a width inside 240px and 75% of the cell', () => {
    expect(clampWidth(500, 1000)).toBe(500)
    expect(clampWidth(100, 1000)).toBe(MIN_WIDTH)
    expect(clampWidth(900, 1000)).toBe(750)
  })

  it('never goes below the minimum, even in a narrow cell', () => {
    expect(clampWidth(500, 200)).toBe(MIN_WIDTH)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/web/test/diff-rows.test.ts`
Expected: FAIL — cannot resolve `../src/diff-rows.ts`.

- [ ] **Step 3: Implement `packages/web/src/diff-rows.ts`**

```ts
/** One rendered line of a file's diff. */
export type Row =
  | { kind: 'hunk'; text: string }
  | { kind: 'add' | 'del' | 'ctx'; old: number | null; new: number | null; text: string }

/** Unified hunks into rows carrying old and new line numbers. */
export function patchRows(patch: string): Row[] {
  const rows: Row[] = []
  let o = 0
  let n = 0
  let inHunk = false
  for (const line of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) {
      o = Number(h[1])
      n = Number(h[2])
      // A new file's hunk says `-0,0 +1,n`: there is no old line 0 to count
      // from, and the first new line is 1, which is what `n` already holds.
      inHunk = true
      rows.push({ kind: 'hunk', text: line })
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+')) rows.push({ kind: 'add', old: null, new: n++, text: line.slice(1) })
    else if (line.startsWith('-')) rows.push({ kind: 'del', old: o++, new: null, text: line.slice(1) })
    else if (line.startsWith(' ')) rows.push({ kind: 'ctx', old: o++, new: n++, text: line.slice(1) })
    // `\ No newline at end of file` and blank trailers carry no content.
  }
  return rows
}

export const MIN_WIDTH = 240

/** Panel width in px: at most 75% of the focus cell, never under MIN_WIDTH. */
export function clampWidth(px: number, cellWidth: number): number {
  return Math.round(Math.max(MIN_WIDTH, Math.min(px, cellWidth * 0.75)))
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run packages/web/test/diff-rows.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/diff-rows.ts packages/web/test/diff-rows.test.ts
git commit -m "feat(web): diff rows and panel width clamp"
```

---

### Task 3: Web — the panel, its styling, and the tile dialog entry

**Files:**
- Create: `packages/web/src/diff-panel.ts`
- Modify: `packages/web/src/main.ts` (focus cell setup ~lines 64-66; `attachSession` ~line 425; the `focusedId = null` at ~line 537; `sessionMenu` ~line 593)
- Modify: `packages/web/src/overlay.ts` (`openSessionDialog`, ~line 335)
- Modify: `packages/web/src/style.css` (after the `.focus-cell` rules ~line 128, and the `@media (max-width: 720px)` block)

**Interfaces:**
- Consumes: `patchRows`, `clampWidth`, `Row` from `./diff-rows.ts`; `DiffFile`, `DiffResult` from `@tring/shared/protocol`; `api<T>(path)` from `./ws-client.ts`.
- Produces:
  ```ts
  export class DiffPanel {
    constructor(cell: HTMLElement, onLayout: () => void)
    get isOpen(): boolean
    open(): void
    close(): void
    toggle(): void
    setSession(id: string | null): void
  }
  ```
  `openSessionDialog(session, onSubmit, onDelete, diff: { open: boolean; onToggle: () => void })`.

This task is DOM wiring with no node-testable logic beyond Task 2; it is verified by typecheck, build, and the manual checks in Step 8.

- [ ] **Step 1: Create `packages/web/src/diff-panel.ts`**

```ts
import type { DiffFile, DiffResult } from '@tring/shared/protocol'
import { clampWidth, MIN_WIDTH, patchRows } from './diff-rows.ts'
import { api } from './ws-client.ts'

const POLL_MS = 2000
const STORAGE_KEY = 'tring.diffPanel'
const DEFAULT_WIDTH = 420

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement('div')
  d.className = cls
  if (text !== undefined) d.textContent = text
  return d
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span')
  s.className = cls
  s.textContent = text
  return s
}

/** Per browser, like the ring size: a display choice, not session state. */
function load(): { width: number; open: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { width?: unknown; open?: unknown }
    return {
      width: typeof v.width === 'number' ? v.width : DEFAULT_WIDTH,
      open: v.open === true,
    }
  } catch {
    return { width: DEFAULT_WIDTH, open: false }
  }
}

/**
 * The focused session's uncommitted changes, beside the centre terminal.
 *
 * Every string from the repository — paths and file content alike — goes in
 * through textContent. A diff is attacker-shaped text by nature (anything a
 * cloned repo contains), and this page holds the token to a shell.
 */
export class DiffPanel {
  private readonly el = div('diff-panel')
  private readonly handle = div('diff-handle')
  private readonly title = span('diff-title', '')
  private readonly plus = span('diff-plus', '')
  private readonly minus = span('diff-minus', '')
  private readonly scroll = div('diff-scroll')
  private sessionId: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight = false
  private last = ''
  private width: number
  private opened: boolean

  /**
   * Builds its DOM into `cell` and restores the saved width and open state,
   * but never calls `onLayout` from here: main.ts constructs this before the
   * terminal and the socket exist, and the terminal's own first fit then sees
   * the panel already in place.
   */
  constructor(private readonly cell: HTMLElement, private readonly onLayout: () => void) {
    const head = div('diff-head')
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'diff-close'
    close.textContent = '✕'
    close.title = 'Close diff viewer'
    close.onclick = () => this.close()
    head.append(this.title, this.plus, this.minus, close)
    this.el.append(head, this.scroll)
    cell.append(this.handle, this.el)

    const saved = load()
    this.width = Math.max(MIN_WIDTH, saved.width)
    this.opened = saved.open
    this.bindResize()
    this.paint()
    if (this.opened) this.startPolling()
  }

  get isOpen(): boolean {
    return this.opened
  }

  open(): void {
    if (this.opened) return
    this.opened = true
    this.paint()
    this.save()
    this.onLayout()
    this.startPolling()
  }

  close(): void {
    if (!this.opened) return
    this.opened = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.paint()
    this.save()
    this.onLayout()
  }

  toggle(): void {
    if (this.opened) this.close()
    else this.open()
  }

  /** Follows the centre terminal; a response for the previous one is dropped. */
  setSession(id: string | null): void {
    if (id === this.sessionId) return
    this.sessionId = id
    this.last = ''
    this.note(id ? 'loading…' : 'no session')
    if (this.opened) void this.tick()
  }

  private paint(): void {
    this.el.hidden = !this.opened
    this.handle.hidden = !this.opened
    this.el.style.width = `${this.width}px`
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: this.width, open: this.opened }))
    } catch {
      // Still applies for this page load.
    }
  }

  private startPolling(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => void this.tick(), POLL_MS)
    void this.tick()
  }

  private async tick(): Promise<void> {
    const id = this.sessionId
    if (!id || this.inflight || !this.opened) return
    this.inflight = true
    try {
      const d = await api<DiffResult>(`/api/sessions/${encodeURIComponent(id)}/diff`)
      if (id !== this.sessionId || !this.opened) return
      const key = JSON.stringify(d)
      if (key === this.last) return
      this.last = key
      this.render(d)
    } catch (err) {
      if (id !== this.sessionId) return
      this.last = ''
      this.note((err as Error).message)
    } finally {
      this.inflight = false
    }
  }

  private note(text: string): void {
    this.title.textContent = ''
    this.plus.textContent = ''
    this.minus.textContent = ''
    this.scroll.replaceChildren(div('diff-note', text))
  }

  private render(d: DiffResult): void {
    if ('error' in d) return this.note(d.error)
    const { files } = d
    let added = 0
    let removed = 0
    for (const f of files) { added += f.added; removed += f.removed }
    this.title.textContent = `${files.length} file${files.length === 1 ? '' : 's'} changed`
    this.plus.textContent = `+${added}`
    this.minus.textContent = `-${removed}`
    if (files.length === 0) {
      this.scroll.replaceChildren(div('diff-note', 'no uncommitted changes'))
      return
    }

    const list = div('diff-files')
    const body = div('diff-body')
    for (const f of files) {
      const section = this.fileSection(f)
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'diff-file-row'
      row.append(span('path', f.path), span('diff-plus', `+${f.added}`), span('diff-minus', `-${f.removed}`))
      row.onclick = () => section.scrollIntoView({ block: 'start' })
      list.append(row)
      body.append(section)
    }
    if (d.truncated) list.append(div('diff-note', 'some diffs are over the 1 MB limit and not shown'))

    // Polling redraws on every change; keep the reader where they were.
    const top = this.scroll.scrollTop
    this.scroll.replaceChildren(list, body)
    this.scroll.scrollTop = top
  }

  private fileSection(f: DiffFile): HTMLElement {
    const section = div('diff-file')
    section.append(div('diff-file-head', f.path))
    if (f.note) {
      section.append(div('diff-note', f.note))
      return section
    }
    for (const r of patchRows(f.patch)) {
      if (r.kind === 'hunk') {
        section.append(div('dl dl-hunk', r.text))
        continue
      }
      const line = div(`dl dl-${r.kind}`)
      line.append(
        span('ln', r.old === null ? '' : String(r.old)),
        span('ln', r.new === null ? '' : String(r.new)),
        span('tx', r.text),
      )
      section.append(line)
    }
    return section
  }

  /**
   * Drag the handle to resize. The terminal is refitted once, on release:
   * fitting on every move would send the PTY a resize per pixel.
   */
  private bindResize(): void {
    let right = 0
    this.handle.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      right = this.el.getBoundingClientRect().right
      this.handle.setPointerCapture(e.pointerId)
      this.handle.classList.add('dragging')
    })
    this.handle.addEventListener('pointermove', (e) => {
      if (!this.handle.hasPointerCapture(e.pointerId)) return
      this.width = clampWidth(right - e.clientX, this.cell.clientWidth)
      this.el.style.width = `${this.width}px`
    })
    const end = (e: PointerEvent) => {
      if (!this.handle.hasPointerCapture(e.pointerId)) return
      this.handle.releasePointerCapture(e.pointerId)
      this.handle.classList.remove('dragging')
      this.save()
      this.onLayout()
    }
    this.handle.addEventListener('pointerup', end)
    this.handle.addEventListener('pointercancel', end)
  }
}
```

- [ ] **Step 2: Give the terminal its own host inside the focus cell**

In `packages/web/src/main.ts`, add `import { DiffPanel } from './diff-panel.ts'` with the other local imports, and replace:

```ts
const focusCell = document.createElement('div')
focusCell.className = 'focus-cell'
const focusTerm = new FocusTerminal(focusCell)
```

with:

```ts
const focusCell = document.createElement('div')
focusCell.className = 'focus-cell'
// The terminal gets a host of its own so the diff panel can sit beside it in
// the same cell. The panel is built first: the terminal's initial fit then
// already sees the width the panel leaves it.
const termHost = document.createElement('div')
termHost.className = 'term-host'
focusCell.append(termHost)
const diffPanel = new DiffPanel(focusCell, () => fitTerminal())
const focusTerm = new FocusTerminal(termHost)
```

- [ ] **Step 3: Keep the panel on the focused session**

In `attachSession`, directly after `focusedSlot = s?.slot ?? null` add:

```ts
  diffPanel.setSession(focusedId)
```

At the other assignment `focusedId = null` (~line 537), add on the line after it:

```ts
  diffPanel.setSession(null)
```

- [ ] **Step 4: Add the dialog button**

In `packages/web/src/overlay.ts`, change the `openSessionDialog` signature to:

```ts
export function openSessionDialog(
  session: SessionInfo,
  onSubmit: (v: { name: string; color: string | null }) => void,
  onDelete: () => void,
  diff: { open: boolean; onToggle: () => void },
): void {
```

and replace the actions block's Delete setup and `actions.append(del, cancel, ok)` with:

```ts
  const del = el('button', 'btn danger', 'Delete') as HTMLButtonElement
  del.type = 'button'
  del.onclick = () => { close(); onDelete() }
  const diffBtn = el('button', 'btn diff-toggle',
    diff.open ? 'Hide diff viewer' : 'Diff viewer') as HTMLButtonElement
  diffBtn.type = 'button'
  // Delete and this sit on the left, apart from Cancel/Save.
  diffBtn.style.marginRight = 'auto'
  diffBtn.onclick = () => { close(); diff.onToggle() }
  const cancel = el('button', 'btn', 'Cancel') as HTMLButtonElement
  cancel.type = 'button'
  cancel.onclick = () => close()
  const ok = el('button', 'btn primary', 'Save') as HTMLButtonElement
  ok.type = 'submit'
  actions.append(del, diffBtn, cancel, ok)
```

(The existing comment above `del` about keeping the destructive action apart stays.)

In `packages/web/src/main.ts`, `sessionMenu` passes the fourth argument:

```ts
    () => killSession(s),
    {
      open: diffPanel.isOpen,
      // The panel always describes the centre terminal, so opening it from
      // another tile brings that tile to the centre first.
      onToggle: () => {
        if (!diffPanel.isOpen) focusSession(id)
        diffPanel.toggle()
      },
    },
  )
```

- [ ] **Step 5: Style it**

In `packages/web/src/style.css`, after the `.focus-cell.dropping` rule add:

```css
/* The diff panel shares the focus cell with the terminal (diff-panel.ts). */
.focus-cell { display: flex; }
.term-host { flex: 1 1 auto; min-width: 0; height: 100%; }

.diff-handle {
  flex: 0 0 5px;
  margin: 0 3px;
  border-radius: 3px;
  background: var(--line);
  cursor: col-resize;
  touch-action: none;
}
.diff-handle:hover, .diff-handle.dragging { background: var(--emerald); }

.diff-panel {
  flex: 0 0 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  color: var(--text);
  font: 11.5px/1.55 var(--mono);
}
.diff-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 2px 4px 6px;
  border-bottom: 1px solid var(--line);
}
.diff-title { font-weight: 700; }
.diff-plus { color: var(--mint); }
.diff-minus { color: var(--red); }
.diff-close {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--dim);
  font: inherit;
  cursor: pointer;
}
.diff-close:hover { color: var(--text); }
.diff-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
.diff-files { padding: 4px 0; border-bottom: 1px solid var(--line); }
.diff-file-row {
  display: flex;
  gap: 8px;
  width: 100%;
  padding: 1px 4px;
  border: none;
  background: transparent;
  color: var(--muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.diff-file-row:hover { background: var(--panel-2); color: var(--text); }
.diff-file-row .path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-file-head {
  position: sticky;
  top: 0;
  padding: 4px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
  font-weight: 700;
}
.dl { display: grid; grid-template-columns: 5ch 5ch 1fr; white-space: pre; }
.dl .ln { padding-right: 1ch; color: var(--dim); text-align: right; user-select: none; }
.dl-add { background: rgba(62, 233, 164, 0.12); }
.dl-del { background: rgba(242, 84, 91, 0.12); }
.dl-hunk { display: block; padding: 2px 4px; color: var(--dim); }
.diff-note { padding: 6px 4px; color: var(--dim); }
```

Inside the existing `@media (max-width: 720px)` block add:

```css
  .diff-panel, .diff-handle, .diff-toggle { display: none !important; }
```

- [ ] **Step 6: Typecheck, test, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: no type errors, all tests pass, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/diff-panel.ts packages/web/src/main.ts packages/web/src/overlay.ts packages/web/src/style.css
git commit -m "feat(web): resizable diff panel beside the centre terminal"
```

- [ ] **Step 8: Manual check in the running app**

Start the daemon from the worktree (`npm run build && npm start`, or `npm run dev` for the web half) and check, in a git repo with some changes:

1. Right-click a tile that is not in the centre → **Diff viewer** → that session moves to the centre and the panel opens on its right with the changed files.
2. Edit a file in that repo from the terminal → the panel updates within ~2s, keeping its scroll position.
3. Drag the handle → the panel widens/narrows; on release the terminal refits (a `claude` or `htop` inside redraws at the new width). Reload → same width, still open.
4. Click another tile → the panel switches to that session's repo; a slow repo's late answer does not flash over it.
5. `cd /tmp` in the shell → `not a git repository`.
6. Right-click a tile → **Hide diff viewer** closes it; `✕` also closes it; the terminal takes the full width back.
7. Narrow the window under 720px → panel, handle, and dialog button are gone.

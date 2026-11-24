import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

/**
 * Where a directory sits in git: which repository, which worktree of it, on
 * which branch. What the orchestrator agent needs to keep parallel agents in
 * separate worktrees.
 *
 * Read-only calls run with fsmonitor off (as in git-diff.ts), so a repo's
 * config runs nothing just because the agent looked. `git worktree add` is
 * the exception, and deliberately so: it is a checkout the user approved, and
 * it should behave exactly as their own `git worktree add` would — LFS
 * filters, post-checkout hooks and all.
 */

const run = promisify(execFile)

export interface GitPlace {
  /** The worktree's top directory. */
  root: string
  /** The shared .git directory: the same for every worktree of one repository. */
  commonDir: string
  /** A linked worktree (`git worktree add`), not the main checkout. */
  linked: boolean
  /** Null when detached or on an unborn branch with no name. */
  branch: string | null
  detached: boolean
}

export interface Worktree {
  path: string
  branch: string | null
  head: string | null
  bare: boolean
  detached: boolean
  locked: boolean
  prunable: boolean
}

export interface GitOps {
  place(dir: string): Promise<GitPlace | null>
  /** The worktree a file or directory is in, without running git; see worktreeRootOf. */
  rootOf(p: string): Promise<string | null>
  worktrees(dir: string): Promise<Worktree[]>
  branchExists(dir: string, branch: string): Promise<boolean>
  /** Null when the name is valid; otherwise why not. */
  checkBranch(dir: string, branch: string): Promise<string | null>
  /** `git worktree add`; resolves to git's error text, or null on success. */
  addWorktree(dir: string, spec: { path: string; branch: string; create: boolean; base?: string }): Promise<string | null>
}

async function git(cwd: string, args: string[], timeout = 5000): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', timeout })
    return stdout
  } catch {
    return null
  }
}

/** One spelling per directory: git says C:/x, Node says C:\x, Windows ignores case. */
export function samePath(a: string, b: string): boolean {
  return normal(a) === normal(b)
}

export function normal(p: string): string {
  const r = path.resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/** The repository's name: `tring.chat` for both `tring.chat/.git` and `tring.chat.git`. */
export function repoName(commonDir: string): string {
  const base = path.basename(commonDir)
  return base === '.git' ? path.basename(path.dirname(commonDir)) : base.replace(/\.git$/, '')
}

/** A branch as a directory name: `feature/CHV-12 x` -> `feature-CHV-12-x`. */
export function branchSlug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree'
}

/** `git worktree list --porcelain`, one block per worktree. */
export function parseWorktreeList(text: string): Worktree[] {
  const out: Worktree[] = []
  for (const block of text.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    const lines = block.split('\n').filter(Boolean)
    const first = lines[0]
    if (!first?.startsWith('worktree ')) continue
    const w: Worktree = {
      path: first.slice('worktree '.length), branch: null, head: null,
      bare: false, detached: false, locked: false, prunable: false,
    }
    for (const l of lines.slice(1)) {
      if (l.startsWith('HEAD ')) w.head = l.slice(5)
      else if (l.startsWith('branch ')) w.branch = l.slice(7).replace(/^refs\/heads\//, '')
      else if (l === 'bare') w.bare = true
      else if (l === 'detached') w.detached = true
      else if (l === 'locked' || l.startsWith('locked ')) w.locked = true
      else if (l === 'prunable' || l.startsWith('prunable ')) w.prunable = true
    }
    out.push(w)
  }
  return out
}

/**
 * Where a new worktree for `branch` goes when nobody said.
 *
 * Teams have a layout already, and the worktrees that exist show it: if the
 * linked ones share a parent directory, the new one goes there too. With none
 * to learn from, `<parent>/<repo>.worktrees/<branch>` — beside the repository,
 * never inside it, where it would show up in its `git status`.
 */
export function defaultWorktreePath(commonDir: string, existing: Worktree[], branch: string): string {
  const slug = branchSlug(branch)
  const linked = existing.filter((w, i) => i > 0 && !w.bare && !w.prunable)
  const parents = [...new Set(linked.map((w) => normal(path.dirname(w.path))))]
  if (parents.length === 1) return path.join(path.dirname(linked[0]!.path), slug)
  // The checkout that holds `.git`, or for a bare repository the repository
  // itself: either way, the new directory goes beside it.
  const repoDir = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir
  return path.join(path.dirname(repoDir), `${repoName(commonDir)}.worktrees`, slug)
}

const roots = new Map<string, Promise<string | null>>()

/**
 * The worktree a path is in, by walking up to the nearest `.git` (a
 * directory in a main checkout, a file in a linked worktree) — no git process,
 * because one transcript names dozens of paths. Remembered per directory for
 * the life of the daemon; a repository appearing later is a rare enough case
 * to cost only a restart.
 */
export function worktreeRootOf(p: string): Promise<string | null> {
  const start = path.resolve(p)
  const k = normal(start)
  let hit = roots.get(k)
  if (!hit) {
    hit = (async () => {
      let dir = start
      for (let i = 0; i < 64; i++) {
        try {
          await stat(path.join(dir, '.git'))
          return dir
        } catch { /* keep climbing */ }
        const up = path.dirname(dir)
        if (up === dir) return null
        dir = up
      }
      return null
    })()
    roots.set(k, hit)
  }
  return hit
}

export const realGit: GitOps = {
  rootOf: worktreeRootOf,
  async place(dir) {
    const out = await git(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])
    const [root, gitDir, commonDir] = out?.trim().split(/\r?\n/) ?? []
    if (!root || !gitDir || !commonDir) return null
    const branch = (await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim() || null
    const detached = !branch && (await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])) !== null
    return { root: path.resolve(root), commonDir: path.resolve(commonDir), linked: !samePath(gitDir, commonDir), branch, detached }
  },
  async worktrees(dir) {
    const out = await git(dir, ['worktree', 'list', '--porcelain'])
    return out ? parseWorktreeList(out).map((w) => ({ ...w, path: path.resolve(w.path) })) : []
  },
  async branchExists(dir, branch) {
    return (await git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) !== null
  },
  async checkBranch(dir, branch) {
    if (!branch || branch.startsWith('-')) return `"${branch}" is not a usable branch name`
    return (await git(dir, ['check-ref-format', '--branch', branch])) === null
      ? `"${branch}" is not a valid branch name`
      : null
  },
  async addWorktree(dir, spec) {
    const args = spec.create
      ? ['worktree', 'add', '-b', spec.branch, spec.path, ...(spec.base ? [spec.base] : [])]
      : ['worktree', 'add', spec.path, spec.branch]
    try {
      // No -c here: see the note at the top.
      await run('git', args, { cwd: dir, encoding: 'utf8', timeout: 180_000 })
      return null
    } catch (err) {
      const e = err as { stderr?: string; message: string }
      return (e.stderr || e.message).trim().split(/\r?\n/).slice(-3).join(' ')
    }
  },
}

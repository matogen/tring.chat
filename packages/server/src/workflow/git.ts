import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { defaultWorktreePath, realGit, type GitOps } from '../git-worktrees.ts'

/**
 * What the stack engine needs to know from git, asked of the user's own local
 * clones. tring reads code from no remote and clones nothing; the one network
 * call is `git fetch origin <base>`, and it never waits for a password.
 *
 * Read-only calls run with fsmonitor off, as in git-diff.ts. Adding a
 * worktree runs as plain git (filters, hooks), as create_session does.
 */

const run = promisify(execFile)

interface Ran { ok: boolean; out: string; err: string; code: number | null }

async function git(cwd: string, args: string[], opts: { timeout?: number; plain?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Ran> {
  try {
    const { stdout, stderr } = await run('git', [...(opts.plain ? [] : ['-c', 'core.fsmonitor=false']), ...args], {
      cwd, encoding: 'utf8', timeout: opts.timeout ?? 10_000, maxBuffer: 16 * 2 ** 20,
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    })
    return { ok: true, out: stdout, err: stderr, code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number | string; message: string }
    return { ok: false, out: err.stdout ?? '', err: (err.stderr || err.message).trim(), code: typeof err.code === 'number' ? err.code : null }
  }
}

const lastLines = (s: string): string => s.trim().split(/\r?\n/).slice(-3).join(' ')

export interface WorktreeMade {
  path: string
  /** What `from` pointed at when the branch was made: what the PR sits on. */
  baseSha: string
}

export class StackGit {
  constructor(private readonly ops: GitOps = realGit) {}

  async isRepo(dir: string): Promise<boolean> {
    return (await this.ops.place(dir)) !== null
  }

  /** `develop` when the repo has one, locally or on origin; else origin's default branch. */
  async baseBranch(repo: string): Promise<string> {
    for (const ref of ['refs/heads/develop', 'refs/remotes/origin/develop']) {
      if ((await git(repo, ['show-ref', '--verify', '--quiet', ref])).ok) return 'develop'
    }
    const head = await git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    if (head.ok && head.out.trim()) return head.out.trim().replace(/^origin\//, '')
    const current = await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    return current.ok && current.out.trim() ? current.out.trim() : 'main'
  }

  /** The prefix most of the repo's branches have (`feat/`, `feature/`…); `feature/` when none do. */
  async branchPrefix(repo: string): Promise<string> {
    const r = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    const counts = new Map<string, number>()
    for (const b of r.out.split(/\r?\n/)) {
      const at = b.indexOf('/')
      if (at > 0) counts.set(b.slice(0, at), (counts.get(b.slice(0, at)) ?? 0) + 1)
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    return best ? `${best[0]}/` : 'feature/'
  }

  /** A new worktree with `branch` made from `from`, beside the repo's other worktrees. */
  async createWorktree(repo: string, spec: { branch: string; from: string }): Promise<WorktreeMade> {
    const bad = await this.ops.checkBranch(repo, spec.branch)
    if (bad) throw new Error(bad)
    if (spec.from.startsWith('-')) throw new Error(`"${spec.from}" is not a usable base`)
    const base = await git(repo, ['rev-parse', '--verify', '--quiet', `${spec.from}^{commit}`])
    if (!base.ok) throw new Error(`${spec.from} does not exist in ${repo}`)
    const place = await this.ops.place(repo)
    if (!place) throw new Error(`${repo} is not a git repository`)
    const trees = await this.ops.worktrees(repo)
    const there = trees.find((w) => w.branch === spec.branch && !w.prunable)
    if (there) return { path: there.path, baseSha: base.out.trim() }
    const exists = await this.ops.branchExists(repo, spec.branch)
    const dir = defaultWorktreePath(place.commonDir, trees, spec.branch)
    const err = await this.ops.addWorktree(repo, { path: dir, branch: spec.branch, create: !exists, ...(exists ? {} : { base: spec.from }) })
    if (err) throw new Error(`git worktree add failed: ${err}`)
    return { path: path.resolve(dir), baseSha: base.out.trim() }
  }

  /** HEAD, and whether there is anything uncommitted (untracked files included). */
  async check(worktree: string): Promise<{ head: string; clean: boolean }> {
    const head = await git(worktree, ['rev-parse', 'HEAD'])
    const status = await git(worktree, ['status', '--porcelain', '--untracked-files=normal'])
    return { head: head.out.trim(), clean: status.ok && status.out.trim() === '' }
  }

  /** Each branch's head, in one call; null for a branch that does not exist. */
  async heads(repo: string, branches: string[]): Promise<Map<string, string | null>> {
    const r = await git(repo, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'])
    const all = new Map<string, string>()
    for (const line of r.out.split(/\r?\n/)) {
      const at = line.lastIndexOf(' ')
      if (at > 0) all.set(line.slice(0, at), line.slice(at + 1))
    }
    return new Map(branches.map((b) => [b, all.get(b) ?? null]))
  }

  /**
   * Whether a rebase changed the PR's own change, by `git range-diff` of its
   * commits before and after: a review survives a restack that did not.
   */
  async diffChanged(worktree: string, before: { base: string; head: string }, after: { base: string; head: string }): Promise<boolean> {
    const r = await git(worktree, ['range-diff', '--no-color', `${before.base}..${before.head}`, `${after.base}..${after.head}`])
    if (!r.ok) return true // cannot tell: the review does not hold
    const marks = r.out.split(/\r?\n/).map((l) => /^\s*(?:\d+|-):\s+\S+\s+([=!<>])\s/.exec(l)?.[1]).filter(Boolean)
    return marks.some((m) => m !== '=')
  }

  /**
   * `git fetch origin <base>`, and how many commits it has that `since` does
   * not. Never prompts: a fetch that would need a password fails, with git's
   * words, for the feature card.
   */
  async fetchBase(repo: string, base: string, since: string): Promise<{ commits: number; error: string | null }> {
    const f = await git(repo, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], {
      plain: true, timeout: 60_000, env: { GIT_TERMINAL_PROMPT: '0' },
    })
    if (!f.ok) return { commits: 0, error: lastLines(f.err) || 'git fetch failed' }
    const n = await git(repo, ['rev-list', '--count', `${since}..origin/${base}`])
    return { commits: n.ok ? Number(n.out.trim()) || 0 : 0, error: n.ok ? null : lastLines(n.err) }
  }

  /** Whether `branch` is in `base` on origin (or locally): merged by a merge or a fast-forward. A squash merge is not. */
  async isMerged(repo: string, branch: string, base: string): Promise<boolean> {
    for (const into of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
      if (!(await git(repo, ['show-ref', '--verify', '--quiet', into])).ok) continue
      return (await git(repo, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, into])).ok
    }
    return false
  }

  /** `git worktree remove`, never forced: one with changes in it stays. Git's words, or null. */
  async removeWorktree(repo: string, worktree: string): Promise<string | null> {
    const r = await git(repo, ['worktree', 'remove', worktree], { plain: true })
    return r.ok ? null : lastLines(r.err) || 'git worktree remove failed'
  }

  /**
   * `git branch -d`, never -D. Git checks -d against the branch's upstream,
   * so that is pointed at origin/<base> first: it deletes exactly what is
   * merged into the base, and refuses the rest.
   */
  async deleteBranch(repo: string, branch: string, base: string): Promise<string | null> {
    await git(repo, ['branch', '--quiet', `--set-upstream-to=origin/${base}`, branch])
    const r = await git(repo, ['branch', '-d', branch])
    return r.ok ? null : lastLines(r.err) || 'git branch -d failed'
  }

  /** Whether `branch` would conflict with `onto` (merge-tree, nothing written to any worktree). */
  async conflicts(repo: string, branch: string, onto: string): Promise<boolean> {
    const r = await git(repo, ['merge-tree', '--write-tree', '--quiet', onto, branch])
    return !r.ok && r.code === 1
  }
}

export interface Watched {
  /** Whatever the caller needs to know which PR it is, e.g. "<ticket>:<pr>". */
  key: string
  repo: string
  branch: string
}

/**
 * Tells the engine when a PR's branch head moves. Polled (every few seconds
 * while tickets are active, and at once after a coder's commit), since a
 * commit, a rebase and a reset all move a branch and none says so.
 */
export class HeadWatcher {
  private watched: Watched[] = []
  private readonly known = new Map<string, { branch: string; sha: string | null }>()
  private timer: NodeJS.Timeout | null = null
  private polling: Promise<void> | null = null

  constructor(private readonly sg: Pick<StackGit, 'heads'>, private readonly onMove: (key: string, sha: string) => void) {}

  /** What to watch from now on. A key whose branch changed starts afresh, without a report. */
  watch(list: Watched[]): void {
    this.watched = list
    const keys = new Set(list.map((w) => w.key))
    for (const k of [...this.known.keys()]) if (!keys.has(k)) this.known.delete(k)
  }

  /** One look at every watched head. Overlapping calls share one look. */
  poll(): Promise<void> {
    this.polling ??= this.look().finally(() => { this.polling = null })
    return this.polling
  }

  start(everyMs = 5000): void {
    this.stop()
    this.timer = setInterval(() => { void this.poll() }, everyMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async look(): Promise<void> {
    const byRepo = new Map<string, Watched[]>()
    for (const w of this.watched) byRepo.set(w.repo, [...(byRepo.get(w.repo) ?? []), w])
    for (const [repo, list] of byRepo) {
      const heads = await this.sg.heads(repo, list.map((w) => w.branch))
      for (const w of list) {
        const sha = heads.get(w.branch) ?? null
        const was = this.known.get(w.key)
        this.known.set(w.key, { branch: w.branch, sha })
        if (was && was.branch === w.branch && sha && was.sha !== sha) this.onMove(w.key, sha)
      }
    }
  }
}

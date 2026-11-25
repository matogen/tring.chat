import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HeadWatcher, StackGit } from '../src/workflow/git.ts'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim()

const commit = (cwd: string, file: string, body: string, msg = file): string => {
  writeFileSync(path.join(cwd, file), body)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-qm', msg)
  return git(cwd, 'rev-parse', 'HEAD')
}

let tmp: string
let origin: string
/** The user's clone, where the ticket's worktrees go. */
let repo: string
/** Someone else's clone, pushing to develop meanwhile. */
let other: string
const sg = new StackGit()

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'tring-stackgit-'))
  origin = path.join(tmp, 'origin.git')
  git(tmp, 'init', '-q', '--bare', origin)
  const seed = path.join(tmp, 'seed')
  git(tmp, 'clone', '-q', origin, seed)
  commit(seed, 'README.md', 'hi\n')
  git(seed, 'push', '-q', 'origin', 'main')
  git(seed, 'checkout', '-qb', 'develop')
  commit(seed, 'app.ts', 'export const a = 1\n')
  git(seed, 'push', '-q', 'origin', 'develop')
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  repo = path.join(tmp, 'app')
  git(tmp, 'clone', '-q', origin, repo)
  git(repo, 'branch', 'feat/one', 'origin/develop')
  git(repo, 'branch', 'feat/two', 'origin/develop')
  git(repo, 'branch', 'fix/three', 'origin/develop')
  other = path.join(tmp, 'other')
  git(tmp, 'clone', '-q', '-b', 'develop', origin, other)
})
afterAll(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('StackGit', () => {
  it('bases a ticket on develop when the repo has one, else on the remote\'s default branch', async () => {
    expect(await sg.baseBranch(repo)).toBe('develop')
    const plain = path.join(tmp, 'plain')
    git(tmp, 'clone', '-q', origin, plain)
    git(plain, 'update-ref', '-d', 'refs/remotes/origin/develop')
    expect(await sg.baseBranch(plain)).toBe('main')
  })

  it('names branches with the prefix the repo already uses most', async () => {
    expect(await sg.branchPrefix(repo)).toBe('feat/')
    expect(await sg.branchPrefix(other)).toBe('feature/')
  })

  it('tells a git repository from a plain directory', async () => {
    expect(await sg.isRepo(repo)).toBe(true)
    expect(await sg.isRepo(tmp)).toBe(false)
  })

  it('adds a worktree for a PR, branched from what it sits on, and says where that was', async () => {
    const wt = await sg.createWorktree(repo, { branch: 'feat/CHV-1-1-table', from: 'origin/develop' })
    expect(existsSync(path.join(wt.path, 'app.ts'))).toBe(true)
    expect(wt.baseSha).toBe(git(repo, 'rev-parse', 'origin/develop'))
    expect(path.dirname(wt.path)).toBe(path.join(tmp, 'app.worktrees'))
    const second = await sg.createWorktree(repo, { branch: 'feat/CHV-1-2-api', from: 'feat/CHV-1-1-table' })
    expect(second.baseSha).toBe(wt.baseSha)
  })

  it('reports a worktree\'s HEAD and whether it is clean', async () => {
    const wt = await sg.createWorktree(repo, { branch: 'feat/check', from: 'origin/develop' })
    const sha = commit(wt.path, 'one.ts', '1\n')
    expect(await sg.check(wt.path)).toEqual({ head: sha, clean: true })
    writeFileSync(path.join(wt.path, 'scratch.ts'), 'wip')
    expect(await sg.check(wt.path)).toEqual({ head: sha, clean: false })
  })

  it('reads branch heads in one call, null for a branch that is gone', async () => {
    const heads = await sg.heads(repo, ['feat/one', 'nope/missing'])
    expect(heads.get('feat/one')).toBe(git(repo, 'rev-parse', 'feat/one'))
    expect(heads.get('nope/missing')).toBeNull()
  })

  it('says whether a rebase changed a PR\'s own diff', async () => {
    const wt = await sg.createWorktree(repo, { branch: 'feat/rd', from: 'origin/develop' })
    const oldBase = git(wt.path, 'rev-parse', 'HEAD')
    const oldHead = commit(wt.path, 'feature.ts', 'export const f = 1\n')
    // The base gains an unrelated commit; the PR is rebased onto it.
    git(repo, 'branch', 'rd-base', oldBase)
    const lower = await sg.createWorktree(repo, { branch: 'rd-lower', from: 'rd-base' })
    const newBase = commit(lower.path, 'other.ts', 'x\n')
    git(wt.path, 'rebase', '-q', '--onto', newBase, oldBase)
    const newHead = git(wt.path, 'rev-parse', 'HEAD')
    expect(await sg.diffChanged(wt.path, { base: oldBase, head: oldHead }, { base: newBase, head: newHead })).toBe(false)
    // The same PR, but its change is different now.
    commit(wt.path, 'feature.ts', 'export const f = 2\n', 'amend')
    git(wt.path, 'reset', '-q', '--soft', 'HEAD~2')
    git(wt.path, 'commit', '-qm', 'feature again')
    const changed = git(wt.path, 'rev-parse', 'HEAD')
    expect(await sg.diffChanged(wt.path, { base: oldBase, head: oldHead }, { base: newBase, head: changed })).toBe(true)
  })

  it('fetches the base, counts what is new on it, and finds a conflict before pushing', async () => {
    const wt = await sg.createWorktree(repo, { branch: 'feat/lane', from: 'origin/develop' })
    const base = git(wt.path, 'rev-parse', 'HEAD')
    commit(wt.path, 'app.ts', 'export const a = 2\n', 'change a')
    expect(await sg.fetchBase(repo, 'develop', base)).toEqual({ commits: 0, error: null })

    commit(other, 'b.ts', 'b\n')
    git(other, 'push', '-q', 'origin', 'develop')
    expect(await sg.fetchBase(repo, 'develop', base)).toEqual({ commits: 1, error: null })
    expect(await sg.conflicts(repo, 'feat/lane', 'origin/develop')).toBe(false)

    commit(other, 'app.ts', 'export const a = 3\n', 'theirs')
    git(other, 'push', '-q', 'origin', 'develop')
    expect((await sg.fetchBase(repo, 'develop', base)).commits).toBe(2)
    expect(await sg.conflicts(repo, 'feat/lane', 'origin/develop')).toBe(true)
  })

  it('fails a fetch it cannot make instead of waiting for a password', async () => {
    const lost = path.join(tmp, 'lost')
    git(tmp, 'clone', '-q', origin, lost)
    git(lost, 'remote', 'set-url', 'origin', path.join(tmp, 'gone.git'))
    const r = await sg.fetchBase(lost, 'develop', 'HEAD')
    expect(r.error).toMatch(/.+/)
  })
})

describe('HeadWatcher', () => {
  it('reports a branch head once when it moves, and nothing when it has not', async () => {
    const seen: Array<{ key: string; sha: string }> = []
    const w = new HeadWatcher(sg, (key, sha) => seen.push({ key, sha }))
    w.watch([{ key: 't1:1', repo, branch: 'feat/one' }])
    await w.poll()
    expect(seen).toEqual([])
    const wt = await sg.createWorktree(repo, { branch: 'feat/watched', from: 'feat/one' })
    w.watch([{ key: 't1:1', repo, branch: 'feat/watched' }])
    await w.poll()
    const sha = commit(wt.path, 'w.ts', 'w\n')
    await w.poll()
    await w.poll()
    expect(seen).toEqual([{ key: 't1:1', sha }])
  })
})

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  branchSlug, defaultWorktreePath, parseWorktreeList, realGit, repoName, samePath,
} from '../src/git-worktrees.ts'

describe('parseWorktreeList', () => {
  it('reads main, linked, detached, locked and prunable worktrees', () => {
    const text = [
      'worktree /r', 'HEAD aaa', 'branch refs/heads/main', '',
      'worktree /w/a', 'HEAD bbb', 'branch refs/heads/feat/a', 'locked reason here', '',
      'worktree /w/b', 'HEAD ccc', 'detached', 'prunable gitdir file points to non-existent location', '',
    ].join('\n')
    expect(parseWorktreeList(text)).toEqual([
      { path: '/r', head: 'aaa', branch: 'main', bare: false, detached: false, locked: false, prunable: false },
      { path: '/w/a', head: 'bbb', branch: 'feat/a', bare: false, detached: false, locked: true, prunable: false },
      { path: '/w/b', head: 'ccc', branch: null, bare: false, detached: true, locked: false, prunable: true },
    ])
  })
  it('reads a bare repository entry', () => {
    expect(parseWorktreeList('worktree /r.git\nbare\n')[0]).toMatchObject({ path: '/r.git', bare: true })
  })
})

describe('naming and placing worktrees', () => {
  const t = (p: string, extra: object = {}) =>
    ({ path: p, branch: 'x', head: null, bare: false, detached: false, locked: false, prunable: false, ...extra })
  const fwd = (p: string): string => p.replace(/\\/g, '/').replace(/^[A-Z]:/i, '')

  it('names repos and slugs branches', () => {
    expect(repoName('/src/tring.chat/.git')).toBe('tring.chat')
    expect(repoName('/src/tring.chat.git')).toBe('tring.chat')
    expect(branchSlug('feature/CHV-3193 login fix')).toBe('feature-CHV-3193-login-fix')
  })
  it('follows the layout of the existing linked worktrees', () => {
    expect(fwd(defaultWorktreePath('/src/app/.git', [t('/src/app'), t('/wt/one'), t('/wt/two')], 'feat/b'))).toBe('/wt/feat-b')
  })
  it('falls back to a sibling <repo>.worktrees directory', () => {
    expect(fwd(defaultWorktreePath('/src/app/.git', [t('/src/app')], 'feat/b'))).toBe('/src/app.worktrees/feat-b')
    // Linked worktrees scattered in different places say nothing about a layout.
    expect(fwd(defaultWorktreePath('/src/app/.git', [t('/src/app'), t('/a/one'), t('/b/two')], 'x'))).toBe('/src/app.worktrees/x')
  })
  it('places a bare-repo layout beside the bare repository', () => {
    expect(fwd(defaultWorktreePath('/src/app.git', [t('/src/app.git', { bare: true })], 'main'))).toBe('/src/app.worktrees/main')
  })
})

/** Against a real repository: what the tools see in a real worktree layout. */
describe('realGit', () => {
  let dir: string
  let repo: string
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tring-wt-'))
    repo = path.join(dir, 'app')
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 't')
    writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    git('add', '.')
    git('commit', '-q', '-m', 'first')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('places the main checkout', async () => {
    const p = await realGit.place(repo)
    expect(p).toMatchObject({ branch: 'main', linked: false, detached: false })
    expect(samePath(p!.root, repo)).toBe(true)
    expect(repoName(p!.commonDir)).toBe('app')
  })

  it('adds a worktree with a new branch, and places a directory inside it', async () => {
    const wt = path.join(dir, 'app.worktrees', 'feat-a')
    expect(await realGit.checkBranch(repo, 'feat/a')).toBeNull()
    expect(await realGit.branchExists(repo, 'feat/a')).toBe(false)
    expect(await realGit.addWorktree(repo, { path: wt, branch: 'feat/a', create: true, base: 'main' })).toBeNull()
    expect(await realGit.branchExists(repo, 'feat/a')).toBe(true)

    const p = await realGit.place(wt)
    expect(p).toMatchObject({ branch: 'feat/a', linked: true })
    expect(samePath(p!.root, wt)).toBe(true)
    // The same repository as the main checkout, which is how tiles are grouped.
    expect(samePath(p!.commonDir, (await realGit.place(repo))!.commonDir)).toBe(true)

    const trees = await realGit.worktrees(repo)
    expect(trees.map((w) => w.branch)).toEqual(['main', 'feat/a'])
  })

  it('reports git\'s own error when a branch is already checked out elsewhere', async () => {
    const err = await realGit.addWorktree(repo, { path: path.join(dir, 'again'), branch: 'feat/a', create: false })
    expect(err).toMatch(/already|used by worktree/i)
  })

  it('refuses names git would refuse, and option-like ones', async () => {
    expect(await realGit.checkBranch(repo, 'bad name')).toMatch(/not a valid/)
    expect(await realGit.checkBranch(repo, '--force')).toMatch(/not a usable/)
    expect(await realGit.checkBranch(repo, 'feat/..x')).toMatch(/not a valid/)
  })

  it('is null outside a repository', async () => {
    expect(await realGit.place(os.tmpdir())).toBeNull()
  })
})

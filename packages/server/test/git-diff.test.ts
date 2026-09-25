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

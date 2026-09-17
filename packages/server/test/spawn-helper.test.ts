import { describe, it, expect, afterEach } from 'vitest'
import { chmodSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fixSpawnHelper, nodePtyRoot, spawnHelperPaths } from '../src/spawn-helper.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

/** A node-pty install with the permissions the published tarball ships. */
async function fakeNodePty(mode: number, platforms = ['darwin-arm64']): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tring-pty-'))
  dirs.push(root)
  for (const platform of platforms) {
    const dir = path.join(root, 'prebuilds', platform)
    mkdirSync(dir, { recursive: true })
    const helper = path.join(dir, 'spawn-helper')
    writeFileSync(helper, '#!/bin/sh\n')
    chmodSync(helper, mode)
  }
  return root
}

const mode = (p: string): number => statSync(p).mode & 0o777

// chmod means something else on Windows, and there is no helper to fix there.
describe.skipIf(process.platform === 'win32')('fixSpawnHelper', () => {
  it('makes a 0644 prebuilt helper executable — the bug that breaks every macOS tile', async () => {
    const root = await fakeNodePty(0o644)
    const helper = path.join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper')

    expect(fixSpawnHelper(root)).toEqual([helper])
    expect(mode(helper)).toBe(0o755)
  })

  it('leaves a healthy install alone, so the daemon says nothing on startup', async () => {
    const root = await fakeNodePty(0o755)
    expect(fixSpawnHelper(root)).toEqual([])
  })

  it('repairs every prebuilt platform, not just the one we guess at', async () => {
    const root = await fakeNodePty(0o644, ['darwin-arm64', 'darwin-x64'])
    expect(fixSpawnHelper(root)).toHaveLength(2)
  })

  it('keeps the read and write bits it found', async () => {
    const root = await fakeNodePty(0o600)
    const helper = path.join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper')
    fixSpawnHelper(root)
    expect(mode(helper)).toBe(0o711)
  })

  it('is idempotent, because it runs at install time and again at startup', async () => {
    const root = await fakeNodePty(0o644)
    expect(fixSpawnHelper(root)).toHaveLength(1)
    expect(fixSpawnHelper(root)).toEqual([])
  })

  it('refuses a helper that is a symlink, which chmod would follow out of the package', async () => {
    // This pass is also the postinstall hook, so `npm i -g` can be running it
    // as root. A symlink here would put the execute bit on whatever it points
    // at, anywhere on the filesystem.
    const root = await fakeNodePty(0o644, ['darwin-arm64'])
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-victim-'))
    dirs.push(dir)
    const victim = path.join(dir, 'not-ours')
    writeFileSync(victim, 'plain data\n')
    chmodSync(victim, 0o644)

    const helper = path.join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper')
    rmSync(helper)
    symlinkSync(victim, helper)

    expect(fixSpawnHelper(root)).toEqual([])
    expect(mode(victim)).toBe(0o644)
  })

  it('does nothing when node-pty cannot be found rather than throwing at startup', () => {
    expect(fixSpawnHelper(null)).toEqual([])
  })

  it('shrugs at a root with no prebuilds at all', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tring-pty-'))
    dirs.push(root)
    expect(fixSpawnHelper(root)).toEqual([])
  })
})

describe('spawnHelperPaths', () => {
  it('always considers the locally compiled helper', () => {
    expect(spawnHelperPaths('/x')).toContain(path.join('/x', 'build', 'Release', 'spawn-helper'))
  })

  it('resolves the real node-pty, which is what the startup pass repairs', () => {
    const root = nodePtyRoot()
    expect(root).not.toBeNull()
    expect(path.basename(root!)).toBe('node-pty')
  })
})

/**
 * Puts the execute bit back on node-pty's spawn-helper (issue #4).
 *
 * node-pty 1.1.0 — what `^1.1.0` still installs — publishes
 * prebuilds/darwin-*\/spawn-helper with mode 0644, and its own post-install
 * does not correct it (microsoft/node-pty#850). Every PTY on macOS is forked
 * through that binary, so a plain `npm i -g tring-chat` gives `posix_spawnp
 * failed` on the first tile and no shell ever starts. The fix is in
 * 1.2.0-beta; there is no stable release carrying it.
 *
 * This runs twice, because neither pass covers the other's case: as our
 * postinstall, which is the only one running as whoever owns the files and so
 * the only one that can repair a root-owned global install; and again before
 * the first spawn, which is the only one that survives `--ignore-scripts`.
 *
 * Delete the file and both call sites once node-pty ships a stable tarball
 * with the bit set and the dependency is bumped to it.
 */

import { chmodSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/** Owner, group and other execute. The rest of the mode is left alone. */
const EXEC = 0o111

/** Where node-pty is installed, or null if it cannot be resolved from here. */
export function nodePtyRoot(): string | null {
  try {
    return path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
  } catch {
    return null
  }
}

/**
 * Every spawn-helper this install could load: one per prebuilt platform, plus
 * the one a locally compiled node-pty leaves in build/Release. Only one of
 * them is ever the live path, and which one is node-pty's business, so all of
 * them are checked rather than guessing at the platform triple.
 */
export function spawnHelperPaths(root: string): string[] {
  const found = [path.join(root, 'build', 'Release', 'spawn-helper')]
  let prebuilds: Dirent<string>[]
  try {
    prebuilds = readdirSync(path.join(root, 'prebuilds'), { withFileTypes: true })
  } catch {
    return found // built from source, so build/Release is the only candidate
  }
  for (const entry of prebuilds) {
    if (entry.isDirectory()) found.push(path.join(root, 'prebuilds', entry.name, 'spawn-helper'))
  }
  return found
}

/** Returns the files it had to repair — empty on every healthy install. */
export function fixSpawnHelper(root: string | null = nodePtyRoot()): string[] {
  // Windows forks through conpty and winpty. There is no helper binary there,
  // and no execute bit for one to be missing.
  if (process.platform === 'win32' || root === null) return []

  const fixed: string[] = []
  for (const file of spawnHelperPaths(root)) {
    try {
      const mode = statSync(file).mode & 0o777
      if (mode & EXEC) continue
      chmodSync(file, mode | EXEC)
      fixed.push(file)
    } catch {
      // Not built for this platform, or an install this user cannot write to.
      // Saying so here would be noise on every healthy machine, and on a
      // broken one node-pty's own spawn failure is the clearer message.
    }
  }
  return fixed
}

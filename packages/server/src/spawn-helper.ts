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

import {
  closeSync, constants, fchmodSync, fstatSync, openSync, readdirSync, type Dirent,
} from 'node:fs'
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

/**
 * Returns the files it had to repair — empty on every healthy install.
 *
 * Every helper is opened once, `O_NOFOLLOW`, and inspected and chmod'ed
 * through that one descriptor. The path is never resolved twice and a symlink
 * is never followed, because neither is safe here: this same function is the
 * package's postinstall hook, so on `npm i -g` it can be running as root, and
 * `chmod` follows a link. A `spawn-helper` that was a symlink would put the
 * execute bit on whatever it pointed at, anywhere on the filesystem, and a
 * name checked and then re-opened could be swapped for one in between. Only a
 * regular file inside node-pty is ours to repair.
 */
export function fixSpawnHelper(root: string | null = nodePtyRoot()): string[] {
  // Windows forks through conpty and winpty. There is no helper binary there,
  // and no execute bit for one to be missing.
  if (process.platform === 'win32' || root === null) return []

  const fixed: string[] = []
  for (const file of spawnHelperPaths(root)) {
    let fd: number | null = null
    try {
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const info = fstatSync(fd)
      if (!info.isFile()) continue
      const mode = info.mode & 0o777
      if (mode & EXEC) continue
      fchmodSync(fd, mode | EXEC)
      fixed.push(file)
    } catch {
      // Not built for this platform, an install this user cannot write to, or
      // a symlink where a helper should be (ELOOP). Saying so here would be
      // noise on every healthy machine, and on a broken one node-pty's own
      // spawn failure is the clearer message.
    } finally {
      if (fd !== null) closeSync(fd)
    }
  }
  return fixed
}

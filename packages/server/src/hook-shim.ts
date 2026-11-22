import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Puts a `tring-hook` command on the PATH of every session this daemon spawns.
 *
 * The installed hooks run `tring-hook`, not an absolute path, so they survive
 * upgrades and work from any checkout. A global npm install already has the
 * bin on PATH; this shim covers everything else — a dev checkout, an npx run,
 * a Node version manager that moved the global prefix — by pointing at the
 * exact script and Node binary this daemon is running.
 */
export async function writeHookShim(dir: string, node: string, script: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  await writeFile(path.join(dir, 'tring-hook'), `#!/bin/sh\nexec ${q(node)} ${q(script)} "$@"\n`, 'utf8')
  await chmod(path.join(dir, 'tring-hook'), 0o755)
  await writeFile(path.join(dir, 'tring-hook.cmd'), `@"${node}" "${script}" %*\r\n`, 'utf8')
}

/** PATH with `dir` first, once. */
export function prependPath(current: string | undefined, dir: string): string {
  const parts = (current ?? '').split(path.delimiter).filter((p) => p && p !== dir)
  return [dir, ...parts].join(path.delimiter)
}

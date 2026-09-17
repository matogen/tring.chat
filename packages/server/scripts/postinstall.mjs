/**
 * Repairs node-pty's spawn-helper at install time. See src/spawn-helper.ts for
 * what is wrong with it and why this runs as well as the startup pass.
 *
 * A loader rather than a second copy of the logic: `npm run build` emits the
 * real thing beside the daemon. A source checkout has nothing built yet when
 * npm runs this — and also nothing installed to repair, and the startup pass
 * to cover it — so a missing file here is the normal case, not a failure.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const built = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist/fix-spawn-helper.mjs',
)
if (existsSync(built)) await import(pathToFileURL(built).href)

import { build } from 'esbuild'
import { cp, rm, chmod, access } from 'node:fs/promises'

// The published package carries the web bundle, so refuse to build a broken
// one rather than shipping a daemon that serves the "not built yet" page.
try {
  await access('../web/dist')
} catch {
  console.error('packages/web/dist is missing — run `npm run build` from the repo root')
  process.exit(1)
}

await rm('dist', { recursive: true, force: true })

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/tring.js',
  banner: { js: '#!/usr/bin/env node' },
  // Native and prebuilt packages stay external; they are real dependencies
  // and must be resolved from node_modules at runtime, not inlined.
  external: ['node-pty', '@xterm/headless', '@xterm/addon-serialize', 'ws'],
})
await chmod('dist/tring.js', 0o755)

// The same spawn-helper repair the daemon runs at startup, as a script the
// postinstall hook can run at install time — where it is still whoever owns
// the install, and can therefore fix a global one owned by root. One source,
// two entry points, rather than two copies drifting apart.
await build({
  stdin: {
    contents: [
      "import { fixSpawnHelper } from './src/spawn-helper.ts'",
      'for (const file of fixSpawnHelper()) console.log(`tring: made ${file} executable`)',
    ].join('\n'),
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/fix-spawn-helper.mjs',
})

// Ship the web bundle inside the server package so an installed copy is
// self-contained and does not reach back into the monorepo.
await cp('../web/dist', 'dist/web', { recursive: true })

// npm reads the README and LICENSE from the package directory, so the
// published page is the project's own README rather than blank, and the MIT
// licence package.json declares actually ships with the tarball.
await cp('../../README.md', 'README.md')
await cp('../../LICENSE', 'LICENSE')

console.log('built dist/tring.js + dist/web')

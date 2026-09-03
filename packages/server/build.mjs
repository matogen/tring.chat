import { build } from 'esbuild'
import { cp, rm, chmod } from 'node:fs/promises'

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

// Ship the web bundle inside the server package so an installed copy is
// self-contained and does not reach back into the monorepo.
await cp('../web/dist', 'dist/web', { recursive: true })

console.log('built dist/tring.js + dist/web')

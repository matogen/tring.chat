/**
 * The shim is a shell script, so it is tested by running it — against a stub
 * `claude` that prints the argv it was handed. Asserting on the generated text
 * would pass for a script with a syntax error in it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { prependToPath, windowsShim, writeAgentShim } from '../src/agent-shim.ts'

const run = promisify(execFile)

let root: string
let shimDir: string
let realDir: string
let mcpConfig: string

/** What the stub claude prints: one argument per line, so an empty one shows. */
const STUB = '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n'

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tring-shim-'))
  shimDir = (await writeAgentShim(root))!
  realDir = path.join(root, 'real')
  await mkdir(realDir, { recursive: true })
  await writeFile(path.join(realDir, 'claude'), STUB, 'utf8')
  await chmod(path.join(realDir, 'claude'), 0o755)
  mcpConfig = path.join(root, 'mcp.json')
  await writeFile(mcpConfig, '{"mcpServers":{}}', 'utf8')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Invoke the shim the way a session's shell would: shim dir first on PATH. */
async function shim(
  args: string[],
  env: Record<string, string> = { TRING_MCP_CONFIG: '' },
): Promise<{ argv: string[]; code: number; stderr: string }> {
  const full: Record<string, string> = { ...env, PATH: `${shimDir}${path.delimiter}${realDir}` }
  if (!full['TRING_MCP_CONFIG']) delete full['TRING_MCP_CONFIG']
  try {
    const { stdout } = await run(path.join(shimDir, 'claude'), args, { env: full })
    return { argv: stdout.split('\n').filter(Boolean), code: 0, stderr: '' }
  } catch (err) {
    const e = err as { code?: number; stderr?: string }
    return { argv: [], code: e.code ?? 1, stderr: e.stderr ?? '' }
  }
}

describe.skipIf(process.platform === 'win32')('posix shim', () => {
  it('is executable', async () => {
    const s = await stat(path.join(shimDir, 'claude'))
    expect(s.mode & 0o111).toBeTruthy()
  })

  it('adds the session config to a bare claude', async () => {
    const { argv } = await shim([], { TRING_MCP_CONFIG: mcpConfig })
    expect(argv).toEqual(['--mcp-config', mcpConfig])
  })

  it('keeps the user arguments after the flag', async () => {
    const { argv } = await shim(['-c', 'go to youtube'], { TRING_MCP_CONFIG: mcpConfig })
    expect(argv).toEqual(['--mcp-config', mcpConfig, '-c', 'go to youtube'])
  })

  // The shim sits on the PATH of every session, browser or not, and a session
  // outside tring's control must be indistinguishable from an unshimmed one.
  it('adds nothing when no config is exported', async () => {
    const { argv } = await shim(['--version'])
    expect(argv).toEqual(['--version'])
  })

  it('adds nothing when the config was deleted underneath it', async () => {
    const { argv } = await shim([], { TRING_MCP_CONFIG: path.join(root, 'gone.json') })
    expect(argv).toEqual([])
  })

  // `claude mcp list --mcp-config x` is a usage error, not an ignored extra.
  it('leaves subcommands alone', async () => {
    const { argv } = await shim(['mcp', 'list'], { TRING_MCP_CONFIG: mcpConfig })
    expect(argv).toEqual(['mcp', 'list'])
  })

  it('defers to a config the user passed themselves', async () => {
    const { argv } = await shim(['--mcp-config', 'mine.json'], { TRING_MCP_CONFIG: mcpConfig })
    expect(argv).toEqual(['--mcp-config', 'mine.json'])
    const eq = await shim(['--mcp-config=mine.json'], { TRING_MCP_CONFIG: mcpConfig })
    expect(eq.argv).toEqual(['--mcp-config=mine.json'])
  })

  // Every test above runs with a PATH holding nothing but the shim and the
  // stub — no coreutils, no /usr/bin. That is the case that turns a shim built
  // out of external commands into a fork bomb, so it is the case they all use.
  it('does not exec itself when it is the only claude on the PATH', async () => {
    const { code, stderr } = await run(path.join(shimDir, 'claude'), [], { env: { PATH: shimDir } })
      .then(() => ({ code: 0, stderr: '' }))
      .catch((err: { code?: number; stderr?: string }) =>
        ({ code: err.code ?? 1, stderr: err.stderr ?? '' }))
    expect(code).toBe(127)
    expect(stderr).toContain('not installed')
  })

  // The marker, not the directory's name or path, is what makes this true — so
  // it stays true for a PATH entry that reaches the shim by another spelling.
  it('skips a shim directory reached by a different path', async () => {
    const aliased = `${shimDir}${path.sep}.${path.sep}`
    const { stdout } = await run(path.join(shimDir, 'claude'), ['--version'], {
      env: { PATH: `${aliased}${path.delimiter}${realDir}` },
    })
    expect(stdout.split('\n').filter(Boolean)).toEqual(['--version'])
  })
})

describe('windows shim', () => {
  it('runs the resolved claude and guards every branch on it', () => {
    const text = windowsShim('C:\\Users\\a\\claude.cmd')
    expect(text).toContain('set "TRING_REAL=C:\\Users\\a\\claude.cmd"')
    expect(text).toContain('if not exist "%TRING_REAL%" goto plain')
    expect(text).toContain('if "%TRING_MCP_CONFIG%"=="" goto plain')
    expect(text).toContain('if /i "%~1"=="mcp" goto plain')
    expect(text).toContain('"%TRING_REAL%" --mcp-config "%TRING_MCP_CONFIG%" %*')
    // Batch reads a file with bare \n as one line, which would run the flagged
    // branch and the plain one back to back.
    expect(text.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true)
  })
})

describe('prependToPath', () => {
  it('puts the shim first', () => {
    const env: Record<string, string> = { PATH: `/usr/bin${path.delimiter}/bin` }
    prependToPath(env, '/shim')
    expect(env['PATH']).toBe(`/shim${path.delimiter}/usr/bin${path.delimiter}/bin`)
  })

  // Windows environments carry `Path`, and a plain object copied out of
  // process.env has none of its case-insensitive lookup.
  it('finds the variable however the platform spells it', () => {
    const env: Record<string, string> = { Path: 'C:\\Windows' }
    prependToPath(env, 'C:\\shim')
    expect(env['Path']).toBe(`C:\\shim${path.delimiter}C:\\Windows`)
    expect(env['PATH']).toBeUndefined()
  })

  it('copes with no PATH at all', () => {
    const env: Record<string, string> = {}
    prependToPath(env, '/shim')
    expect(env['PATH']).toBe('/shim')
  })
})

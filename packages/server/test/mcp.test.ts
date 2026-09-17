import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createTools, handleRpc, writeMcpConfig, type McpOptions } from '../src/mcp.ts'

interface Call { url: string; method: string; body: unknown; headers: Record<string, string> }

const rig = (respond: (call: Call) => { status?: number; body: unknown } = () => ({ body: { ok: true } })) => {
  const calls: Call[] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)
    const { status = 200, body } = respond(call)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response
  }) as unknown as typeof fetch

  const opts: McpOptions = {
    url: 'http://127.0.0.1:7331',
    token: 'secret',
    sessionId: 's-123',
    fetchImpl,
  }
  return { calls, tools: createTools(opts) }
}

describe('JSON-RPC surface', () => {
  it('answers initialize with a protocol version and tool capability', async () => {
    const { tools } = rig()
    const out = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, tools)
    expect(out).toMatchObject({
      jsonrpc: '2.0', id: 1,
      result: { capabilities: { tools: {} }, serverInfo: { name: 'tring-browser' } },
    })
  })

  /**
   * A notification has no id and must get no reply. Replying to one is the
   * mistake that hangs a client hardest, because it is waiting on a different
   * message entirely.
   */
  it('never replies to a notification', async () => {
    const { tools } = rig()
    expect(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools))
      .toBeNull()
    expect(await handleRpc({ jsonrpc: '2.0', id: null, method: 'whatever' }, tools)).toBeNull()
  })

  it('lists every tool with a schema', async () => {
    const { tools } = rig()
    const out = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools) as
      { result: { tools: Array<{ name: string; inputSchema: unknown }> } }
    const names = out.result.tools.map((t) => t.name)
    expect(names).toContain('browser_snapshot')
    expect(names).toContain('browser_click')
    expect(names).toContain('browser_eval')
    for (const t of out.result.tools) expect(t.inputSchema).toBeTruthy()
  })

  it('reports an unknown method as a JSON-RPC error', async () => {
    const { tools } = rig()
    expect(await handleRpc({ jsonrpc: '2.0', id: 3, method: 'nope' }, tools))
      .toMatchObject({ error: { code: -32601 } })
  })

  it('reports an unknown tool as a JSON-RPC error', async () => {
    const { tools } = rig()
    const out = await handleRpc(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_fly' } }, tools,
    )
    expect(out).toMatchObject({ error: { code: -32602 } })
  })
})

describe('tool calls reach the daemon', () => {
  /**
   * The scoping rule: the session id comes from this process's environment and
   * is baked into the URL. No tool takes one, so an agent cannot address a page
   * that is not its own (spec §4.8).
   */
  it('addresses the caller\'s own session and nothing else', async () => {
    const { calls, tools } = rig()
    await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_snapshot' } },
      tools,
    )
    expect(calls[0]!.url).toBe('http://127.0.0.1:7331/api/browser/s-123/snapshot')
  })

  it('has no tool that accepts a session or browser id', async () => {
    const { tools } = rig()
    for (const t of tools) {
      const schema = t.inputSchema as { properties?: Record<string, unknown> }
      const keys = Object.keys(schema.properties ?? {})
      expect(keys, t.name).not.toContain('session')
      expect(keys, t.name).not.toContain('sessionId')
      expect(keys, t.name).not.toContain('id')
    }
  })

  it('authenticates with the token from the environment', async () => {
    const { calls, tools } = rig()
    await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_snapshot' } },
      tools,
    )
    expect(calls[0]!.headers['authorization']).toBe('Bearer secret')
  })

  /** The daemon refuses a foreign Origin, and this is not the served page. */
  it('names the daemon as its own origin so the check passes', async () => {
    const { calls, tools } = rig()
    await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_snapshot' } },
      tools,
    )
    expect(calls[0]!.headers['origin']).toBe('http://127.0.0.1:7331')
  })

  it('posts a click with the ref it was given', async () => {
    const { calls, tools } = rig()
    await handleRpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'browser_click', arguments: { ref: 'e7' } },
    }, tools)
    expect(calls[0]).toMatchObject({
      url: 'http://127.0.0.1:7331/api/browser/s-123/click',
      method: 'POST',
      body: { ref: 'e7' },
    })
  })

  it('posts type with both the ref and the text', async () => {
    const { calls, tools } = rig()
    await handleRpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'browser_type', arguments: { ref: 'e2', text: 'hello' } },
    }, tools)
    expect(calls[0]!.body).toEqual({ ref: 'e2', text: 'hello' })
  })

  it('omits an absent optional rather than sending undefined', async () => {
    const { calls, tools } = rig()
    await handleRpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'browser_wait', arguments: { for: '#login' } },
    }, tools)
    expect(calls[0]!.body).toEqual({ for: '#login' })
  })
})

describe('what counts as a tool failure', () => {
  /**
   * A blocked action is an answer, not a failure. Marking it isError makes an
   * agent retry-loop against a wall instead of waiting (spec §4.8).
   */
  it('does not flag a blocked action as an error', async () => {
    const { tools } = rig(() => ({
      status: 200, body: { ok: false, blocked: true, error: 'the human has control of this page' },
    }))
    const out = await handleRpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'browser_click', arguments: { ref: 'e1' } },
    }, tools) as { result: { isError?: boolean; content: Array<{ text: string }> } }

    expect(out.result.isError).toBeFalsy()
    expect(out.result.content[0]!.text).toContain('the human has control')
  })

  it('surfaces a refusal as readable text rather than an exception', async () => {
    const { tools } = rig(() => ({
      status: 403, body: { error: 'browser_eval is disabled for this project' },
    }))
    const out = await handleRpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'browser_eval', arguments: { js: '1+1' } },
    }, tools) as { result: { isError?: boolean; content: Array<{ text: string }> } }

    expect(out.result.isError).toBeFalsy()
    expect(out.result.content[0]!.text).toContain('disabled for this project')
  })

  it('flags a transport failure as a real error', async () => {
    const fetchImpl = (async () => { throw new Error('connection refused') }) as unknown as typeof fetch
    const tools = createTools({
      url: 'http://127.0.0.1:7331', token: null, sessionId: 's-1', fetchImpl,
    })
    const out = await handleRpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'browser_snapshot' },
    }, tools) as { result: { isError?: boolean } }
    expect(out.result.isError).toBe(true)
  })
})

/**
 * The config is a command line, and the only thing worth asserting about a
 * command line is that it runs. Every cheaper check passed while the real one
 * exited on ERR_UNKNOWN_FILE_EXTENSION: `npm start` is `tsx src/index.ts`, so
 * the daemon's execPath is a node that cannot read its own argv[1], and a config
 * naming the two without the loader between them describes a server that dies
 * before it speaks. The agent's only symptom was reaching for a desktop browser.
 */
describe('writeMcpConfig', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repo = path.resolve(here, '../../..')
  const entry = {
    execPath: process.execPath,
    // How `tsx src/index.ts` reaches node, which is how the daemon is started
    // in a checkout. An installed build has none of this and is unaffected.
    execArgv: [
      '--require', path.join(repo, 'node_modules/tsx/dist/preflight.cjs'),
      '--import', pathToFileURL(path.join(repo, 'node_modules/tsx/dist/loader.mjs')).href,
    ],
    script: path.join(repo, 'packages/server/src/index.ts'),
  }

  it('writes a server that starts and answers initialize', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tring-mcp-'))
    try {
      const file = await writeMcpConfig(dir, entry)
      const written = JSON.parse(await readFile(file, 'utf8')) as {
        mcpServers: { 'tring-browser': { command: string; args: string[] } }
      }
      const server = written.mcpServers['tring-browser']

      const reply = await new Promise<string>((resolve, reject) => {
        const child = spawn(server.command, server.args, {
          env: { ...process.env, TRING_SESSION_ID: 's-1', TRING_URL: 'http://127.0.0.1:7331' },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let out = ''
        let err = ''
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString()
          if (out.includes('\n')) { child.kill(); resolve(out) }
        })
        child.stderr.on('data', (d: Buffer) => { err += d.toString() })
        child.on('exit', () => reject(new Error(`server exited without replying: ${err || out}`)))
        child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
      })

      expect(JSON.parse(reply.split('\n')[0]!)).toMatchObject({
        id: 1, result: { serverInfo: { name: 'tring-browser' } },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 20000)
})

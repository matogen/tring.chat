/**
 * `tring-mcp` — the `tring` MCP server the orchestrator agent's Claude Code
 * starts (see orchestrator-agent.ts, which writes its config).
 *
 * A relay and nothing more: MCP's JSON-RPC over stdio on one side, the
 * daemon's `/api/orchestrator/*` on the other. Every tool lives in the daemon
 * (orchestrator-tools.ts), where the sessions are, so this never needs
 * changing when a tool does — `tools/list` is the daemon's own list.
 *
 *   tring-mcp --url http://127.0.0.1:7331 --token-file ~/.config/tring/orchestrator/.token
 *
 * $TRING_URL and $TRING_TOKEN work too. No imports from the rest of the
 * daemon: this is bundled on its own and runs in a checkout with only types
 * stripped.
 */
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const PROTOCOL = '2025-06-18'

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// The flags come as a pair, written by the daemon they point at, and win over
// the environment: a $TRING_TOKEN inherited from some other tring (a daemon
// started from inside a tile) belongs to a different daemon than --url.
const urlFlag = flag('--url')
// `--api stack`: a multi-PR workflow tile's tools, behind its own token.
const api = flag('--api') === 'stack' ? 'stack' : 'orchestrator'
const base = urlFlag ?? process.env['TRING_URL'] ?? ''
const token = ((): string | undefined => {
  const file = flag('--token-file')
  if (file) {
    try { return readFileSync(file, 'utf8').trim() || undefined } catch { return undefined }
  }
  return urlFlag ? undefined : process.env['TRING_TOKEN']
})()

interface Reply { status: number; body: string }

function call(method: 'GET' | 'POST', route: string, payload?: unknown, signal?: AbortSignal): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let url: URL
    try { url = new URL(route, base) } catch { return reject(new Error(`bad daemon URL ${base}`)) }
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    const https = url.protocol === 'https:'
    const req = (https ? httpsRequest : httpRequest)(url, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      // A self-signed --tls-cert on this machine is still our daemon.
      ...(https && LOOPBACK.has(url.hostname) ? { rejectUnauthorized: false } : {}),
      ...(signal ? { signal } : {}),
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}

type Id = string | number
interface Request { jsonrpc: '2.0'; id?: Id; method: string; params?: Record<string, unknown> }

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const pending = new Map<Id, AbortController>()

async function handle(req: Request): Promise<void> {
  const { id, method, params } = req
  const reply = (result: unknown): void => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }) }
  const fail = (code: number, message: string): void => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } }) }

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof params?.['protocolVersion'] === 'string' ? params['protocolVersion'] : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: api === 'stack' ? 'tring-stack' : 'tring', version: '1' },
        instructions: api === 'stack'
          ? 'Your place in a multi-PR ticket: your brief, the stack, and how you report to it.'
          : 'Tools for the tiles in tring: list them, read them, prompt their agents, start new ones, wait for them.',
      })
    case 'ping':
      return reply({})
    case 'notifications/cancelled': {
      const target = params?.['requestId'] as Id | undefined
      if (target !== undefined) pending.get(target)?.abort()
      return
    }
    case 'tools/list': {
      try {
        const r = await call('GET', `/api/${api}/tools`)
        if (r.status !== 200) return fail(-32603, `tring answered ${r.status}`)
        return reply({ tools: (JSON.parse(r.body) as { tools: unknown[] }).tools })
      } catch (err) {
        return fail(-32603, `cannot reach tring at ${base}: ${(err as Error).message}`)
      }
    }
    case 'tools/call': {
      const abort = new AbortController()
      if (id !== undefined) pending.set(id, abort)
      try {
        const r = await call('POST', `/api/${api}/call`, { name: params?.['name'], arguments: params?.['arguments'] ?? {} }, abort.signal)
        const parsed = r.status === 200 ? JSON.parse(r.body) as { text: string; isError: boolean } : null
        const text = parsed?.text ?? `tring answered ${r.status}: ${r.body.slice(0, 300)}`
        return reply({ content: [{ type: 'text', text }], isError: parsed?.isError ?? true })
      } catch (err) {
        if (abort.signal.aborted) return
        return reply({ content: [{ type: 'text', text: `cannot reach tring at ${base}: ${(err as Error).message}. Is the daemon running?` }], isError: true })
      } finally {
        if (id !== undefined) pending.delete(id)
      }
    }
  }
  if (method.startsWith('notifications/')) return
  fail(-32601, `method not found: ${method}`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  let nl: number
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    let req: Request
    try {
      req = JSON.parse(line) as Request
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      continue
    }
    void handle(req)
  }
})
process.stdin.on('end', () => process.exit(0))

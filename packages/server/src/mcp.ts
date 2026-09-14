/**
 * `tring mcp` — browser tools for an agent running inside a tring session
 * (spec §4.8).
 *
 * **Why stdio and not an HTTP endpoint on the daemon.** The tools have to be
 * scoped to the caller's own page, and the only thing that identifies the
 * caller is `TRING_SESSION_ID` in its environment. An HTTP server sees a
 * socket, not a process, so it could never read that — the daemon would have to
 * take a session id as a parameter, and a tool that takes a session id is a
 * tool one agent can point at another agent's page.
 *
 * Run as a child of the agent, this process inherits the environment §4.1
 * already injects. It is a shim: every tool becomes one authenticated call to
 * the daemon, which is where the control wheel and the navigation policy live.
 */

import { createInterface } from 'node:readline'

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call: (args: Record<string, unknown>) => Promise<unknown>
}

const PROTOCOL = '2025-06-18'

const str = (o: Record<string, unknown>, k: string): string =>
  typeof o[k] === 'string' ? (o[k] as string) : ''

export interface McpOptions {
  url: string
  token: string | null
  sessionId: string
  /** Injected in tests. */
  fetchImpl?: typeof fetch
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
}

export function createTools(opts: McpOptions): Tool[] {
  const doFetch = opts.fetchImpl ?? fetch
  const base = `${opts.url}/api/browser/${encodeURIComponent(opts.sessionId)}`

  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await doFetch(`${base}/${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        // The page tring serves refuses a foreign Origin; this is not that
        // page, so it names itself as the daemon's own to pass the check.
        origin: opts.url,
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, error: body['error'] ?? `request failed (${res.status})` }
    return body
  }

  const post = (path: string, body: unknown): Promise<unknown> =>
    call(path, { method: 'POST', body: JSON.stringify(body) })

  return [
    {
      name: 'browser_snapshot',
      description:
        'Read the page as an accessibility tree. Each element carries a [ref=eN] ' +
        'handle to pass to the other tools. Use this before acting, and again ' +
        'after anything changes the page.',
      inputSchema: { type: 'object', properties: {} },
      call: () => call('snapshot'),
    },
    {
      name: 'browser_navigate',
      description:
        'Go to a URL. Subject to this project\'s allowlist — a blocked navigation ' +
        'is offered to the human on the tile rather than failing silently.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      call: (a) => post('navigate', { url: str(a, 'url') }),
    },
    {
      name: 'browser_click',
      description: 'Click the element with this ref, taken from the last snapshot.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref'],
      },
      call: (a) => post('click', { ref: str(a, 'ref') }),
    },
    {
      name: 'browser_type',
      description: 'Replace the contents of a field with this text.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' }, text: { type: 'string' } },
        required: ['ref', 'text'],
      },
      call: (a) => post('type', { ref: str(a, 'ref'), text: str(a, 'text') }),
    },
    {
      name: 'browser_select',
      description: 'Choose an option in a select element.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' }, value: { type: 'string' } },
        required: ['ref', 'value'],
      },
      call: (a) => post('select', { ref: str(a, 'ref'), value: str(a, 'value') }),
    },
    {
      name: 'browser_wait',
      description:
        'Wait for a selector to appear. A timeout marks the tile as needing a ' +
        'human and turns it green, which is the right outcome for a login wall ' +
        'or a captcha — stop and let the person take over.',
      inputSchema: {
        type: 'object',
        properties: { for: { type: 'string' }, timeout: { type: 'number' } },
        required: ['for'],
      },
      call: (a) => post('wait', {
        for: str(a, 'for'),
        ...(typeof a['timeout'] === 'number' ? { timeout: a['timeout'] } : {}),
      }),
    },
    {
      name: 'browser_eval',
      description:
        'Run JavaScript in the page and return the result. Disabled unless this ' +
        'project has explicitly enabled it.',
      inputSchema: {
        type: 'object',
        properties: { js: { type: 'string' } },
        required: ['js'],
      },
      call: (a) => post('eval', { js: str(a, 'js') }),
    },
  ]
}

/** Handles one JSON-RPC request, or returns null for a notification. */
export async function handleRpc(
  msg: Record<string, unknown>, tools: Tool[],
): Promise<Record<string, unknown> | null> {
  const id = msg['id']
  const method = msg['method']
  // Notifications carry no id and get no reply, which is the part of JSON-RPC
  // that breaks a client hardest if you get it wrong.
  if (id === undefined || id === null) return null

  const reply = (result: unknown): Record<string, unknown> =>
    ({ jsonrpc: '2.0', id, result })

  if (method === 'initialize') {
    return reply({
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'tring-browser', version: '1' },
    })
  }

  if (method === 'tools/list') {
    return reply({
      tools: tools.map((t) => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema,
      })),
    })
  }

  if (method === 'tools/call') {
    const params = (msg['params'] ?? {}) as Record<string, unknown>
    const tool = tools.find((t) => t.name === params['name'])
    if (!tool) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `no tool ${String(params['name'])}` } }
    }
    try {
      const out = await tool.call((params['arguments'] ?? {}) as Record<string, unknown>)
      // `isError` is left false even for a blocked or refused action: those are
      // answers the agent should read and act on, not tool failures to retry
      // against (spec §4.8).
      return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] })
    } catch (err) {
      return reply({
        content: [{ type: 'text', text: `error: ${(err as Error).message}` }],
        isError: true,
      })
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${String(method)}` } }
}

/** Newline-delimited JSON-RPC on stdio, which is what MCP stdio transport is. */
export function runMcp(opts: McpOptions): void {
  const tools = createTools(opts)
  const out = opts.stdout ?? process.stdout
  const rl = createInterface({ input: opts.stdin ?? process.stdin })

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return // Nothing to reply to: a malformed line has no id.
    }
    void handleRpc(msg, tools).then((reply) => {
      if (reply) out.write(JSON.stringify(reply) + '\n')
    })
  })
}

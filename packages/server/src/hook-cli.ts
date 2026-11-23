/**
 * `tring-hook <Event>` — the command every Claude Code hook tring installs runs.
 *
 * Reads the hook's JSON from stdin, hands it to the daemon that owns this
 * session, waits for the answer, and prints whatever the daemon says the hook
 * should print. Outside a tring session it exits at once and prints nothing,
 * which is what lets the hooks live in the user's global settings.
 *
 * Every failure is silent and exits 0: a daemon that is down, a token that
 * changed, a timeout. Claude Code then does exactly what it would have done
 * with no hook installed, which is show its own prompt in the terminal.
 *
 * No imports from the rest of the daemon: this is bundled on its own and
 * started once per hook event, so it should cost a Node startup and no more.
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    const chunks: Buffer[] = []
    process.stdin.on('data', (c: Buffer) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => resolve(''))
  })
}

function post(url: URL, token: string | undefined, body: string): Promise<string | null> {
  return new Promise((resolve) => {
    const https = url.protocol === 'https:'
    const req = (https ? httpsRequest : httpRequest)(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      // A daemon on this machine with a self-signed --tls-cert is still the
      // daemon that spawned us; anywhere else the certificate must check out.
      ...(https && LOOPBACK.has(url.hostname) ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(res.statusCode === 200 ? Buffer.concat(chunks).toString('utf8') : null))
      res.on('error', () => resolve(null))
    })
    req.on('error', () => resolve(null))
    req.end(body)
  })
}

async function main(): Promise<void> {
  const event = process.argv[2]
  const id = process.env['TRING_SESSION_ID']
  const base = process.env['TRING_URL']
  if (!event || !id || !base) return

  const raw = await readStdin()
  let payload: unknown = {}
  try { payload = raw.trim() ? JSON.parse(raw) : {} } catch { return }

  let url: URL
  try {
    url = new URL(`/api/sessions/${encodeURIComponent(id)}/hook`, base)
  } catch {
    return
  }
  const reply = await post(url, process.env['TRING_TOKEN'], JSON.stringify({ event, payload }))
  if (!reply) return
  try {
    const { output } = JSON.parse(reply) as { output?: unknown }
    if (output && typeof output === 'object') process.stdout.write(JSON.stringify(output) + '\n')
  } catch {
    // Nothing printed: Claude Code carries on as without a hook.
  }
}

main().then(() => process.exit(0), () => process.exit(0))

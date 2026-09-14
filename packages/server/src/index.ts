import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_SCROLLBACK } from '@tring/shared/protocol'
import { DEFAULT_IDLE_MS } from '@tring/shared/status'
import { ProjectManager } from './project-manager.ts'
import { createHandler } from './http.ts'
import {
  bindNeedsToken, createOriginCheck, SECURITY_HEADERS, upgradeGuard,
} from './security.ts'
import { Hub } from './ws.ts'
import { openWindow, describeFallback } from './open-window.ts'
import { checkForUpdate, currentVersion } from './update-check.ts'

interface Args {
  port: number
  host: string
  token: string | null
  scrollback: number
  idleMs: number
  open: boolean
  shell: string | null
  updateCheck: boolean
  allowOrigin: string[]
  fsRoot: string[]
  insecureNoToken: boolean
}

/** Repeatable flags also accept one comma-separated value, as env vars must. */
const listOf = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: Number(process.env['TRING_PORT'] ?? DEFAULT_PORT),
    host: process.env['TRING_HOST'] ?? DEFAULT_HOST,
    token: process.env['TRING_TOKEN'] ?? null,
    scrollback: DEFAULT_SCROLLBACK,
    idleMs: DEFAULT_IDLE_MS,
    open: !process.env['TRING_NO_OPEN'],
    shell: process.env['TRING_SHELL'] ?? null,
    updateCheck: !process.env['TRING_NO_UPDATE_CHECK'],
    allowOrigin: listOf(process.env['TRING_ALLOW_ORIGIN']),
    fsRoot: listOf(process.env['TRING_FS_ROOT']),
    insecureNoToken: !!process.env['TRING_INSECURE_NO_TOKEN'],
  }
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i]!.split('=', 2)
    const value = inline ?? argv[++i]
    switch (flag) {
      case '--port': args.port = Number(value); break
      case '--host': args.host = String(value); break
      case '--token': args.token = String(value); break
      case '--scrollback': args.scrollback = Number(value); break
      case '--idle-ms': args.idleMs = Number(value); break
      case '--shell': args.shell = String(value); break
      case '--allow-origin': args.allowOrigin.push(...listOf(String(value))); break
      case '--fs-root': args.fsRoot.push(...listOf(String(value))); break
      case '--insecure-no-token': args.insecureNoToken = true; i--; break
      case '--no-open': args.open = false; i--; break
      case '--no-update-check': args.updateCheck = false; i--; break
      case '--version': console.log(currentVersion()); process.exit(0)
      case '--help':
        console.log(`tring — focus-centred terminal deck

  --port <n>        default ${DEFAULT_PORT}
  --host <addr>     default ${DEFAULT_HOST}
  --token <secret>  require bearer auth (use when binding off localhost)
  --scrollback <n>  lines kept per session, default ${DEFAULT_SCROLLBACK}
  --idle-ms <n>     quiet period before a session is done, default ${DEFAULT_IDLE_MS}
  --shell <path>    shell to spawn; default $SHELL, or powershell.exe on
                    Windows. Use --shell wsl.exe for WSL shells from Windows
  --fs-root <path>  extra directory the project picker may browse; repeatable.
                    Home and existing project roots are always browsable
  --allow-origin <o> extra browser origin allowed to reach the daemon;
                    repeatable. Only the page the daemon serves is allowed by
                    default, which is what stops any website you visit from
                    opening a socket to it
  --insecure-no-token
                    bind off localhost with no --token anyway. The daemon
                    spawns shells, so this hands one to everything that can
                    reach the port, and to any site that can rebind a name
                    to it. Only for a network you already trust that far
  --no-open         do not launch a browser window
  --no-update-check do not ask npm whether a newer tring exists
  --version         print the version and exit`)
        process.exit(0)
    }
  }
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // Refused before anything is opened, not warned about after the port is
  // already up. Off loopback the Origin check alone cannot hold the line — the
  // hostname is the user's own, so Host goes unpinned and a rebound domain
  // matches it — which leaves the token as the only gate on a shell.
  if (bindNeedsToken(args.host, args.token) && !args.insecureNoToken) {
    console.error(`refusing to bind ${args.host} without --token.

  The daemon spawns shells, so off localhost the token is the only thing
  between the port and a shell on this machine.

    tring --host ${args.host} --token "$(openssl rand -hex 32)"

  Pass --insecure-no-token if the network is already trusted that far.`)
    process.exit(1)
  }

  const url = `http://${args.host}:${args.port}`
  // Installed builds carry the web bundle at dist/web; a dev checkout running
  // from source finds it in the sibling workspace.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const webRoot = [
    path.resolve(here, 'web'),
    path.resolve(here, '../../web/dist'),
  ].find((p) => existsSync(p)) ?? path.resolve(here, 'web')

  const pm = await ProjectManager.open({
    url,
    scrollback: args.scrollback,
    idleMs: args.idleMs,
    ...(args.shell ? { shell: args.shell } : {}),
  })

  // One rule for both doors. The WebSocket is the door that matters: the
  // same-origin policy does not gate it, so without this any page the user has
  // open can open a socket here and drive a shell (§ security).
  const sameOrigin = createOriginCheck({ host: args.host, allow: args.allowOrigin })

  // Built once, not per request: the handler holds the usage-scan cache, and a
  // fresh closure per request would throw that away on every call.
  const handle = createHandler({
    pm, webRoot, token: args.token, sameOrigin, fsRoots: args.fsRoot,
  })
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS).end('internal error')
    })
  })

  // Rejected at the handshake, before Hub ever sees a socket: an origin that
  // is refused here never gets to send a `hello` at all.
  const wss = new WebSocketServer({ server, verifyClient: upgradeGuard(sameOrigin) })
  const hub = new Hub({ pm, token: args.token })
  hub.attach(wss)

  server.listen(args.port, args.host, () => {
    console.log(`tring listening on ${url}`)
    // Only reachable via --insecure-no-token; the plain case exits above.
    if (bindNeedsToken(args.host, args.token)) {
      console.warn('warning: bound off localhost with no token — anything that can reach ' +
        `${args.host}:${args.port} can open a shell here`)
    }
    if (args.updateCheck) {
      // Fire and forget: an offline machine or a registry outage must never
      // keep a local terminal deck from opening.
      void checkForUpdate(path.join(path.dirname(pm.statePath), 'update-check.json'))
        .then((latest) => {
          if (!latest) return
          hub.setUpdate({ current: currentVersion(), latest })
          console.log(`update available: ${currentVersion()} -> ${latest}  (npm i -g tring-chat)`)
        })
    }
    if (args.open) {
      const opened = openWindow(url)
      if (!opened) console.log(`no browser found — ${describeFallback(url)}`)
    }
  })

  const shutdown = async (): Promise<void> => {
    hub.dispose()
    await pm.dispose()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main()

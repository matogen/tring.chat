import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_SCROLLBACK } from '@tring/shared/protocol'
import { DEFAULT_IDLE_MS } from '@tring/shared/status'
import { ProjectManager } from './project-manager.ts'
import { createHandler } from './http.ts'
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
}

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

  const server = createServer((req, res) => {
    void createHandler({ pm, webRoot, token: args.token })(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end('internal error')
    })
  })

  const wss = new WebSocketServer({ server })
  const hub = new Hub({ pm, token: args.token })
  hub.attach(wss)

  server.listen(args.port, args.host, () => {
    console.log(`tring listening on ${url}`)
    if (!args.token && args.host !== '127.0.0.1' && args.host !== 'localhost') {
      console.warn('warning: bound off localhost without --token')
    }
    if (args.updateCheck) {
      // Fire and forget: an offline machine or a registry outage must never
      // keep a local terminal deck from opening.
      void checkForUpdate(path.join(path.dirname(pm.statePath), 'update-check.json'))
        .then((latest) => {
          if (!latest) return
          hub.setUpdate({ current: currentVersion(), latest })
          console.log(`update available: ${currentVersion()} -> ${latest}  (npm i -g tring)`)
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

import { existsSync, readFileSync } from 'node:fs'
import { createServer, type RequestListener } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { parseArgs, UsageError, type Args } from './args.ts'
import { ProjectManager } from './project-manager.ts'
import { createHandler } from './http.ts'
import {
  bindNeedsToken, createOriginCheck, isLoopbackBind, SECURITY_HEADERS, upgradeGuard,
} from './security.ts'
import { defaultTokenPath, loadOrCreateToken } from './token.ts'
import { Hub } from './ws.ts'
import { openWindow, describeFallback } from './open-window.ts'
import { fixSpawnHelper } from './spawn-helper.ts'
import { UploadStore } from './uploads.ts'
import { checkForUpdate, currentVersion } from './update-check.ts'

interface Auth {
  token: string | null
  /** True when we minted or read it ourselves, which is worth a startup line. */
  persisted: boolean
}

/**
 * The token the daemon will run with, minting and persisting one if needed.
 *
 * There is no unauthenticated default any more: on loopback as much as off it,
 * the only way to get one is to ask for it by name with --insecure-no-token.
 */
function resolveAuth(args: Args): Auth {
  if (args.insecureNoToken) return { token: null, persisted: false }
  if (args.token) return { token: args.token, persisted: false }
  return { token: loadOrCreateToken(), persisted: true }
}

function loadTls(certFile: string, keyFile: string): { cert: Buffer; key: Buffer } {
  const read = (file: string, what: string): Buffer => {
    try {
      return readFileSync(file)
    } catch (err) {
      throw new UsageError(`cannot read the TLS ${what} at ${file}: ${(err as Error).message}`)
    }
  }
  return { cert: read(certFile, 'certificate'), key: read(keyFile, 'key') }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  let auth: Auth
  try {
    auth = resolveAuth(args)
  } catch (err) {
    // Never falls through to running unauthenticated: that silent downgrade is
    // the whole failure mode the generated token exists to close.
    throw new UsageError(`cannot read or create ${defaultTokenPath()}: ${(err as Error).message}
  Fix the permissions on that path, pass --token, or accept an unauthenticated
  daemon on purpose with --insecure-no-token.`)
  }
  const { token } = auth

  // Defence in depth, and deliberately unreachable: resolveAuth() hands back a
  // null token only when --insecure-no-token asked for one, so nothing else can
  // get here. It stays so that "bound off loopback with no token" cannot become
  // reachable again through a refactor without someone deleting this on purpose
  // — off loopback the Origin check cannot hold the line, since the hostname is
  // the user's own, Host goes unpinned, and a rebound domain matches it.
  if (bindNeedsToken(args.host, token) && !args.insecureNoToken) {
    throw new UsageError(`refusing to bind ${args.host} without a token.

  The daemon spawns shells, so off localhost the token is the only thing
  between the port and a shell on this machine.

    tring --host ${args.host} --token "$(openssl rand -hex 32)"`)
  }

  const tls = args.tlsCert && args.tlsKey ? loadTls(args.tlsCert, args.tlsKey) : null
  const url = `${tls ? 'https' : 'http'}://${args.host}:${args.port}`
  // Everything the daemon carries is the kind of thing that must not travel in
  // clear: the bearer token, every keystroke typed into a shell, and whatever
  // the shell prints back — SSH passphrases, .env contents, source.
  const cleartextOffBox = !tls && !isLoopbackBind(args.host)

  // Installed builds carry the web bundle at dist/web; a dev checkout running
  // from source finds it in the sibling workspace.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const webRoot = [
    path.resolve(here, 'web'),
    path.resolve(here, '../../web/dist'),
  ].find((p) => existsSync(p)) ?? path.resolve(here, 'web')

  // Before anything can try to fork a PTY through it. An install that skipped
  // scripts never ran the postinstall pass, and on macOS that is the whole
  // difference between a tile and `posix_spawnp failed` (see spawn-helper.ts).
  for (const file of fixSpawnHelper()) console.log(`made ${file} executable`)

  const pm = await ProjectManager.open({
    url,
    // Reaches each session as $TRING_TOKEN, so the documented Stop hook can
    // authenticate itself without the user copying a secret into settings.json.
    token,
    scrollback: args.scrollback,
    idleMs: args.idleMs,
    ...(args.shell ? { shell: args.shell } : {}),
  })

  // One rule for both doors. The WebSocket is the door that matters: the
  // same-origin policy does not gate it, so without this any page the user has
  // open can open a socket here and drive a shell (§ security).
  const sameOrigin = createOriginCheck({ host: args.host, allow: args.allowOrigin })

  // Scratch space for images dropped on a terminal, beside the state file so
  // it inherits the same private directory. Emptied on shutdown.
  const uploads = new UploadStore(path.join(path.dirname(pm.statePath), 'uploads'))

  // Built once, not per request: the handler holds the usage-scan cache, and a
  // fresh closure per request would throw that away on every call.
  const handle = createHandler({
    pm, webRoot, token, sameOrigin, fsRoots: args.fsRoot, uploads,
  })
  const listener: RequestListener = (req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS).end('internal error')
    })
  }
  const server = tls ? createSecureServer(tls, listener) : createServer(listener)

  // Rejected at the handshake, before Hub ever sees a socket: an origin that
  // is refused here never gets to send a `hello` at all.
  const wss = new WebSocketServer({ server, verifyClient: upgradeGuard(sameOrigin) })
  const hub = new Hub({ pm, token })
  hub.attach(wss)

  // The one link that carries the secret. The client stores it and scrubs it
  // from the address bar on arrival, so it is needed once per browser.
  const authUrl = token ? `${url}/?token=${encodeURIComponent(token)}` : url

  server.listen(args.port, args.host, () => {
    console.log(`tring listening on ${url}`)
    if (auth.persisted) console.log(`  token: ${defaultTokenPath()}`)
    // Only reachable via --insecure-no-token now; every other path has a token.
    if (!token) {
      console.warn('warning: running with no token — every process on this machine ' +
        'can open a shell here' +
        (isLoopbackBind(args.host) ? '' : `, as can anything that reaches ${args.host}:${args.port}`))
    }
    if (cleartextOffBox) {
      console.warn(`warning: ${url} is plain http — the token, every keystroke and all ` +
        'terminal output cross the network in clear. Use an encrypted overlay ' +
        '(Tailscale, WireGuard) or pass --tls-cert/--tls-key.')
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
      // Awaited internally on WSL, where the window has to wait for the port
      // to be mirrored onto the Windows loopback (see open-window.ts). Nothing
      // downstream depends on it, so the daemon is serving either way.
      void openWindow(authUrl).then((opened) => {
        if (!opened) console.log(`no browser found — ${describeFallback(authUrl)}`)
      })
    } else if (token) {
      console.log(`open ${authUrl}`)
    }
  })

  const shutdown = async (): Promise<void> => {
    hub.dispose()
    await uploads.dispose()
    await pm.dispose()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(err.message)
    process.exit(1)
  }
  throw err
})

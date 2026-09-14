import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_SCROLLBACK } from '@tring/shared/protocol'
import { DEFAULT_IDLE_MS } from '@tring/shared/status'
import { tokenProblem } from './token.ts'
import { currentVersion } from './update-check.ts'

export interface Args {
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
  tlsCert: string | null
  tlsKey: string | null
}

/** Repeatable flags also accept one comma-separated value, as env vars must. */
const listOf = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)

/** A command line we refuse to run, as opposed to a crash. Caught in main(). */
export class UsageError extends Error {}

const HELP = `tring — focus-centred terminal deck

  --port <n>        default ${DEFAULT_PORT}
  --host <addr>     default ${DEFAULT_HOST}
  --token <secret>  bearer token clients must present. One is generated and
                    kept at ~/.config/tring/token when this is not given
  --tls-cert <file> PEM certificate; serves https/wss instead of http/ws
  --tls-key <file>  PEM private key for --tls-cert
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
                    run with no token at all. The daemon spawns shells, so
                    this hands one to every process on this machine, to
                    everything that can reach the port when bound off
                    localhost, and to any site that can rebind a name to it
  --no-open         do not launch a browser window
  --no-update-check do not ask npm whether a newer tring exists
  --version         print the version and exit`

/**
 * The command line, with every value-taking flag actually checked.
 *
 * `const value = inline ?? argv[++i]` followed by `String(value)` turns a
 * trailing `--token` into the nine-character string "undefined" — truthy, so
 * it satisfies the off-loopback token requirement and binds the world a shell
 * behind a secret an attacker guesses first. `--token --host 0.0.0.0` is the
 * quieter twin: the token becomes "--host" and the bind address is silently
 * dropped. Both are rejected here rather than coerced.
 */
export function parseArgs(argv: string[]): Args {
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
    tlsCert: process.env['TRING_TLS_CERT'] ?? null,
    tlsKey: process.env['TRING_TLS_KEY'] ?? null,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)

    /**
     * The next argv entry, consumed only by flags that take one.
     *
     * A separate word is refused when it looks like a flag, since that is
     * always a missing value rather than a value that happens to start with
     * two dashes. `--flag=--literal` stays available for the latter, where the
     * `=` says the user meant it.
     */
    const take = (): string => {
      const separate = inline === undefined
      const value = separate ? argv[i + 1] : inline
      if (value === undefined || value === '') throw new UsageError(`${flag} needs a value`)
      if (separate && value.startsWith('--')) {
        throw new UsageError(`${flag} needs a value, but the next argument is ${value}`)
      }
      if (separate) i++
      return value
    }

    const takeNumber = (): number => {
      const raw = take()
      const n = Number(raw)
      if (!Number.isFinite(n)) throw new UsageError(`${flag} needs a number, got ${raw}`)
      return n
    }

    /** Boolean flags take no value, so `--no-open=1` is a typo worth catching. */
    const noValue = (): void => {
      if (inline !== undefined) throw new UsageError(`${flag} takes no value`)
    }

    switch (flag) {
      case '--port': {
        const port = takeNumber()
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new UsageError(`--port must be a whole number from 0 to 65535, got ${port}`)
        }
        args.port = port
        break
      }
      case '--host': args.host = take(); break
      case '--token': {
        const token = take()
        const problem = tokenProblem(token)
        if (problem) throw new UsageError(`--token: ${problem}`)
        args.token = token
        break
      }
      case '--tls-cert': args.tlsCert = take(); break
      case '--tls-key': args.tlsKey = take(); break
      case '--scrollback': {
        const lines = takeNumber()
        if (!Number.isInteger(lines) || lines < 0) {
          throw new UsageError(`--scrollback must be a whole number of lines, got ${lines}`)
        }
        args.scrollback = lines
        break
      }
      case '--idle-ms': {
        const ms = takeNumber()
        if (!Number.isInteger(ms) || ms < 0) {
          throw new UsageError(`--idle-ms must be a whole number of milliseconds, got ${ms}`)
        }
        args.idleMs = ms
        break
      }
      case '--shell': args.shell = take(); break
      case '--allow-origin': args.allowOrigin.push(...listOf(take())); break
      case '--fs-root': args.fsRoot.push(...listOf(take())); break
      case '--insecure-no-token': noValue(); args.insecureNoToken = true; break
      case '--no-open': noValue(); args.open = false; break
      case '--no-update-check': noValue(); args.updateCheck = false; break
      case '--version': console.log(currentVersion()); process.exit(0); break
      case '--help': console.log(HELP); process.exit(0); break
      // A flag we silently ignored used to mean a `--tokn` typo ran an
      // unauthenticated daemon that looked authenticated.
      default: throw new UsageError(`unknown argument ${arg}`)
    }
  }

  // Checked here too: an env var reaches exactly the same gates a flag does.
  if (args.token !== null) {
    const problem = tokenProblem(args.token)
    if (problem) throw new UsageError(`TRING_TOKEN: ${problem}`)
  }
  if (!args.tlsCert !== !args.tlsKey) {
    throw new UsageError('--tls-cert and --tls-key must be given together')
  }
  return args
}

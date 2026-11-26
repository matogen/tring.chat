import { existsSync, readFileSync } from 'node:fs'
import { createServer, type RequestListener } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import os from 'node:os'
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
import { Inbox } from './inbox.ts'
import { CardStore, restoreCards } from './card-store.ts'
import { AutoAnswerer } from './auto-answer.ts'
import { hooksStatus, installHooks, uninstallHooks } from './hooks-install.ts'
import { prependPath, writeHookShim } from './hook-shim.ts'
import { autostartOff, autostartOn, autostartStatus, ForeignAutostart, type AutostartEnv } from './autostart.ts'
import { OrchestratorAgent } from './orchestrator-agent.ts'
import { OrchestratorTools } from './orchestrator-tools.ts'
import { PushStore } from './push-store.ts'
import { Notifier } from './notifier.ts'
import { pushApi } from './push-api.ts'
import { sendPush } from './web-push.ts'
import { vocabulary, Whisper } from './whisper.ts'
import { realGit } from './git-worktrees.ts'
import { WorkflowSettingsStore } from './workflow/settings.ts'
import { TicketStore } from './workflow/tickets.ts'
import { StackGit } from './workflow/git.ts'
import { Forge, bitbucketCreds } from './workflow/forge.ts'
import { WorkflowRunner } from './workflow/runner.ts'
import type { Limit } from './usage.ts'

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

/** `tring hooks install|uninstall|status`; true when argv was that command. */
async function hooksCommand(argv: string[]): Promise<boolean> {
  if (argv[0] !== 'hooks') return false
  const verb = argv[1] ?? 'status'
  if (verb === 'install') {
    await installHooks()
    const st = await hooksStatus()
    console.log(`installed tring hooks in ${st.path} (backup beside it as settings.json.tring-backup)`)
  } else if (verb === 'uninstall') {
    const removed = await uninstallHooks()
    console.log(removed ? 'removed tring hooks' : 'no tring hooks were installed')
  } else if (verb === 'status') {
    const st = await hooksStatus()
    console.log(st.installed
      ? `tring hooks installed in ${st.path}`
      : `tring hooks not installed in ${st.path}${st.events.length ? ` (partial: ${st.events.join(', ')})` : ''}` +
        '\n  run: tring hooks install')
  } else {
    throw new UsageError(`unknown hooks command ${verb}; use install, uninstall or status`)
  }
  return true
}

/** `tring autostart on|off|status`; true when argv was that command. */
async function autostartCommand(argv: string[]): Promise<boolean> {
  if (argv[0] !== 'autostart') return false
  const script = fileURLToPath(import.meta.url)
  if (script.endsWith('.ts')) {
    throw new UsageError('autostart needs an installed tring (npm i -g tring-chat); a source checkout has no script to start')
  }
  const env: AutostartEnv = { platform: process.platform, home: os.homedir(), env: process.env, node: process.execPath, script }
  const verb = argv[1] ?? 'status'
  try {
    if (verb === 'on') {
      // The flags are checked the way the daemon will read them, so a typo
      // fails here rather than at every login.
      parseArgs(argv.slice(2))
      const st = await autostartOn(env, argv.slice(2))
      console.log(`tring will start at login: ${st.file}`)
      if (process.platform === 'linux') console.log('  start it now: systemctl --user start tring')
    } else if (verb === 'off') {
      console.log(await autostartOff(env) ? 'tring will no longer start at login' : 'autostart was not on')
    } else if (verb === 'status') {
      const st = await autostartStatus(env)
      console.log(!st.present ? `autostart is off (${st.file} does not exist)\n  run: tring autostart on`
        : st.ours ? `autostart is on: ${st.file}`
        : `${st.file} exists but was not written by tring; tring leaves it alone`)
    } else {
      throw new UsageError(`unknown autostart command ${verb}; use on, off or status`)
    }
  } catch (err) {
    if (err instanceof ForeignAutostart) throw new UsageError(err.message)
    throw err
  }
  return true
}

async function main(): Promise<void> {
  if (await hooksCommand(process.argv.slice(2))) return
  if (await autostartCommand(process.argv.slice(2))) return
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

  // Before the first session spawns: each copies this PATH, and the installed
  // Claude Code hooks find `tring-hook` through it (see hook-shim.ts). Built
  // installs run the bundled script; a source checkout runs the .ts directly.
  const hookScript = [path.resolve(here, 'tring-hook.js'), path.resolve(here, 'hook-cli.ts')]
    .find((p) => existsSync(p))
  if (hookScript) {
    const binDir = path.join(path.dirname(defaultTokenPath()), 'bin')
    try {
      await writeHookShim(binDir, process.execPath, hookScript)
      process.env['PATH'] = prependPath(process.env['PATH'], binDir)
    } catch (err) {
      console.warn(`warning: cannot write ${binDir}: ${(err as Error).message} — orchestrator hooks will not reach this daemon`)
    }
  }

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
  // Orchestrator mode: what the agents are asking, shared by the hook route
  // that fills it and the sockets that show and answer it.
  const inbox = new Inbox()
  // Off until switched on from the inbox, and remembered across restarts.
  const auto = new AutoAnswerer({
    inbox,
    statePath: path.join(path.dirname(pm.statePath), 'orchestrator.json'),
    context: (id) => {
      const s = pm.findSession(id)
      if (!s) return null
      const shot = s.snapshotNow()
      return { cwd: s.cwd, screen: shot.rows.map((r) => r.map((c) => c.text).join('')).join('\n') }
    },
  })
  await auto.load()
  // The orchestrator agent (off by default): a Claude Code of its own that
  // drives the tiles through the tools below, relayed by tring-mcp.
  const configDir = path.dirname(pm.statePath)
  const workflow = new WorkflowSettingsStore(path.join(configDir, 'workflow.json'))
  await workflow.load()
  const tickets = new TicketStore(path.join(configDir, 'tickets.json'), path.join(configDir, 'tickets'))
  await tickets.load()
  let limits: Limit[] = []
  /** Redraws the workflow's cards when a ticket changes; set once the inbox can show them. */
  let onTickets: () => void = () => {}
  const mcpScript = [path.resolve(here, 'tring-mcp.js'), path.resolve(here, 'mcp-cli.ts')].find((p) => existsSync(p)) ?? null
  const runner = new WorkflowRunner({
    store: tickets,
    settings: workflow,
    git: new StackGit(),
    pm: {
      list: () => pm.list(),
      createProject: (name, root, activate) => pm.createProject(name, root, activate),
      create: (projectId, spec) => pm.create(projectId, spec),
      findSession: (id) => pm.findSession(id),
      kill: (id) => pm.findManager(id)?.kill(id),
      deleteProject: (id) => pm.deleteProject(id),
    },
    inbox,
    quotaHigh: () => limits.some((l) => l.percent >= 90),
    tileDir: path.join(configDir, 'stack-tiles'),
    url,
    mcpScript,
    node: process.execPath,
    onChange: () => onTickets(),
    forge: new Forge({ bitbucket: () => bitbucketCreds(configDir) }),
  })
  await runner.load()
  runner.start()
  const agent = new OrchestratorAgent({
    dir: path.join(configDir, 'orchestrator'),
    statePath: path.join(configDir, 'orchestrator-agent.json'),
    url,
    token,
    scrollback: args.scrollback,
    idleMs: args.idleMs,
    ...(args.shell ? { shell: args.shell } : {}),
    mcpScript,
    node: process.execPath,
    multiPr: () => workflow.get().multiPr,
  })
  const tools = new OrchestratorTools({ pm, inbox, workflow: runner })
  // The cards survive a restart (card-store.ts). Brought back before the hub
  // exists, so the first inbox any screen sees already has them, and before
  // anything is listening for new cards, so none of them buzzes a phone twice.
  const cards = new CardStore(path.join(configDir, 'inbox.json'), (id) => {
    const s = pm.findSession(id)
    return s?.claude ? { projectId: s.projectId, slot: s.slot, claudeId: s.claude.id } : null
  })
  const savedCards = await cards.load()
  const restored = restoreCards(savedCards, (projectId, claudeId) => pm.tilesWith(projectId, claudeId))
  inbox.restore(restored)
  // Said out loud, so "my cards are gone" can be told apart from "this build never kept them".
  if (savedCards.length) console.log(`inbox: ${restored.length} of ${savedCards.length} saved cards came back`)
  // Phone notifications for orchestrator cards: off until a device turns
  // them on in settings. The VAPID key is made on first run and kept.
  const pushStore = new PushStore(path.join(configDir, 'push.json'))
  await pushStore.load()
  let hubRef: Hub | null = null
  const notifier = new Notifier({
    devices: () => pushStore.devices(),
    forget: (endpoint) => { void pushStore.remove(endpoint) },
    stillOpen: (id) => inbox.get(id) !== undefined,
    anyoneActive: () => hubRef?.anyoneActive() ?? false,
    label: (sessionId) => {
      const s = pm.findSession(sessionId)
      if (!s) return null
      const project = pm.list().find((p) => p.id === s.projectId)
      return `${project?.name ?? 'tring'}/${s.slot}${s.name ? ` ${s.name}` : ''}`
    },
    tile: (sessionId) => {
      const s = pm.findSession(sessionId)
      return s ? `${s.projectId}/${s.slot}` : null
    },
    send: (device, payload, opts) => sendPush(device.sub, payload, pushStore.vapid, 'https://tring.chat', opts),
  })
  inbox.onAdded = (item) => notifier.onCard(item)
  // The desktop microphone's optional local Whisper (off until installed from
  // Settings). Its vocabulary hint is what tring knows: projects, tile names,
  // and the branches they are on, with the ticket numbers in them.
  const whisper = new Whisper(path.join(configDir, 'whisper'), path.join(configDir, 'whisper.json'))
  await whisper.load()
  let vocab = { at: 0, text: '' }
  const voiceVocabulary = async (): Promise<string> => {
    if (Date.now() - vocab.at < 60_000) return vocab.text
    const names: string[] = []
    for (const p of pm.list()) {
      names.push(p.name)
      for (const s of p.sessions) {
        if (s.name) names.push(s.name)
        if (s.title) names.push(s.title)
        const place = await realGit.place(pm.findSession(s.id)?.agentCwd ?? s.cwd).catch(() => null)
        if (place?.branch) names.push(place.branch)
      }
    }
    vocab = { at: Date.now(), text: vocabulary(names) }
    return vocab.text
  }
  const handle = createHandler({
    pm, webRoot, token, sameOrigin, fsRoots: args.fsRoot, uploads, inbox,
    onPermission: (item) => { void auto.offer(item) },
    tools,
    agentSession: (id) => agent.find(id),
    push: pushApi(pushStore, notifier),
    // Switching the workflow on or off changes the orchestrator's tools and
    // instructions, which Claude reads when it starts: so it starts again, in
    // the same conversation.
    workflow: {
      get: () => workflow.get(),
      update: async (patch) => {
        const was = workflow.get().multiPr
        const next = await workflow.update(patch)
        if (next.multiPr !== was && agent.enabled) await agent.restart(false)
        return next
      },
    },
    forges: () => ({ bitbucket: bitbucketCreds(configDir) !== null, file: path.join(configDir, 'bitbucket.json') }),
    stack: runner,
    gate: (id, tool, input) => runner.gate(id, tool, input),
    onHook: (id) => runner.onHook(id),
    onUsage: (report) => { limits = report.limits },
    cleanup: { plan: (id) => runner.cleanupPlan(id), run: (id, items) => runner.cleanup(id, items) },
    voice: {
      status: () => whisper.status(),
      install: (model) => whisper.install(model),
      setEnabled: (on) => whisper.setEnabled(on),
      transcribe: async (wav) => whisper.transcribe(wav, await voiceVocabulary()),
    },
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
  const hub = new Hub({ pm, token, inbox, auto, agent, workflow: runner })
  onTickets = () => { inbox.syncWorkflow(runner.cardItems()); hub.refreshTickets() }
  inbox.syncWorkflow(runner.cardItems(), false)
  hubRef = hub
  hub.attach(wss)
  // The hub owns both change callbacks; saving the cards rides along. Tiles
  // count too: a moved tile or a new conversation changes where a card goes.
  // Once now as well, which drops the cards that found no tile to come back to.
  const saveCards = (): void => { void cards.save(inbox.list()) }
  const onInbox = inbox.onChange
  inbox.onChange = () => { onInbox?.(); saveCards() }
  const onProjects = pm.onChange
  pm.onChange = () => { onProjects?.(); saveCards() }
  saveCards()
  // After the hub, so its first state change reaches the sockets.
  await agent.load()

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
    // First: ending the tiles below drops their cards, which must not be saved.
    await cards.close()
    hub.dispose()
    agent.dispose()
    runner.stop()
    whisper.stopServer()
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

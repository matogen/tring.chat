import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { ProjectManager } from './project-manager.ts'
import {
  bearerEquals, createOriginCheck, SECURITY_HEADERS, type OriginCheck,
} from './security.ts'
import { collectUsage, defaultTranscriptDir, type UsageReport } from './usage.ts'
import { MAX_UPLOAD_BYTES, type UploadStore } from './uploads.ts'
import { gitDiff } from './git-diff.ts'
import type { Inbox, HookPayload } from './inbox.ts'
import { routeHook } from './hook-route.ts'
import type { InboxItem } from '@tring/shared/protocol'
import { hooksStatus, installHooks, type HooksStatus } from './hooks-install.ts'
import { ToolError, TOOLS, type OrchestratorTools } from './orchestrator-tools.ts'
import type { Session } from './session.ts'
import { claudeConversation } from './session.ts'
import type { PushApi } from './push-api.ts'
import { isModel, type ModelId, type WhisperStatus } from './whisper.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  // Browsers refuse to install a PWA whose manifest is served as anything else.
  '.webmanifest': 'application/manifest+json',
}

export interface HttpOptions {
  pm: ProjectManager
  webRoot: string
  token?: string | null
  /** Shared with the WebSocket upgrade so both doors answer to one rule. */
  sameOrigin?: OriginCheck
  /** Directories the browse endpoint may reach outside the home tree. */
  fsRoots?: readonly string[]
  /** Where images dropped on a terminal are written. Null disables the route. */
  uploads?: UploadStore | null
  /** Orchestrator mode. Null leaves the hook route answering "no opinion". */
  inbox?: Inbox | null
  /** Offered each new permission card; may settle it (auto-answer). */
  onPermission?: (item: InboxItem) => void
  /** Where Claude Code's user settings live; overridable for tests. */
  claudeSettingsPath?: string
  /** What the orchestrator agent's MCP relay calls. Null answers 503. */
  tools?: OrchestratorTools | null
  /** The orchestrator agent's own session, which is in no project. */
  agentSession?: (id: string) => Session | undefined
  /** Phone notifications for orchestrator cards. Null answers 503. */
  push?: PushApi | null
  /** Local speech recognition for the desktop microphone (whisper.ts). Null answers 503. */
  voice?: VoiceApi | null
}

export interface VoiceApi {
  status(): Promise<WhisperStatus>
  /** False when an install is already running. */
  install(model?: ModelId): boolean
  setEnabled(on: boolean): Promise<void>
  transcribe(wav: Buffer): Promise<string>
}

/** About eight minutes of 16 kHz mono speech: a dictated prompt, never a recording session. */
const MAX_AUDIO_BYTES = 16 * 2 ** 20

/** No response leaves without the header block — a 404 is framable too. */
const head = (res: ServerResponse, code: number, type: string): void => {
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': type })
}

const json = (res: ServerResponse, code: number, body: unknown): void => {
  head(res, code, 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

const text = (res: ServerResponse, code: number, body: string): void => {
  head(res, code, 'text/plain; charset=utf-8')
  res.end(body)
}

/** How long a body we have stopped reading may go on arriving before we hang up. */
const DRAIN_GRACE_MS = 2000

/**
 * Answers a body that overran its ceiling, and hangs up once it is delivered.
 *
 * Destroying the request the moment the limit is passed is what the obvious
 * version does, and it loses the 413: the socket goes with it, and the client
 * — `curl -T -`, which has no length to declare and so is the honest caller
 * that ends up here — sees a connection reset with no reason attached. So the
 * rest of the body is allowed to arrive and is dropped on the floor, which
 * costs nothing now that the reader has stopped buffering, and the connection
 * closes cleanly at the end of it. The grace is for a sender that never ends.
 */
const tooLarge = (req: IncomingMessage, res: ServerResponse, message: string): void => {
  res.writeHead(413, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    connection: 'close',
  })
  res.end(JSON.stringify({ error: message }))
  const cut = setTimeout(() => req.destroy(), DRAIN_GRACE_MS)
  cut.unref()
  req.on('end', () => clearTimeout(cut))
  req.on('close', () => clearTimeout(cut))
  req.resume()
}

/** Hooks post nothing large, so a status body over this is not a status body. */
const MAX_BODY_BYTES = 1e6

/**
 * The body as bytes, with a ceiling. Null means it never arrived whole.
 *
 * Content-Length is checked by the caller first where there is one, so a
 * client that declares its size is turned away before a byte is read. This is
 * the backstop for one that does not, or that lies: reading stops at the
 * limit and nothing is buffered past it either way.
 *
 * Every way a request can finish lands on the same `settle`, which is the
 * whole point of it. `end` does not fire on a request the client abandoned,
 * nor on one we hang up on ourselves at the limit — so a promise that waits
 * only for `end` waits for ever. The handler never returns, no response is
 * ever written, and the bytes read so far stay pinned for the life of the
 * daemon: a page closed mid-drop was a megabyte the process never got back.
 */
const readBytes = (req: IncomingMessage, limit: number): Promise<Buffer | null> =>
  new Promise((resolve) => {
    let chunks: Buffer[] | null = []
    let size = 0
    const settle = (body: Buffer | null): void => {
      if (chunks === null) return // already answered; later events are noise
      chunks = null
      resolve(body)
    }
    req.on('data', (c: Buffer) => {
      if (chunks === null) return
      size += c.length
      if (size > limit) {
        // Answered here, but not hung up on here — see tooLarge. Everything
        // that still arrives falls through the guard above and is discarded.
        settle(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => settle(chunks ? Buffer.concat(chunks) : null))
    req.on('error', () => settle(null))
    req.on('close', () => settle(null))
  })

/** The same, as text. Null for a body that was too large or cut short. */
const readBody = async (req: IncomingMessage): Promise<string | null> => {
  const bytes = await readBytes(req, MAX_BODY_BYTES)
  return bytes === null ? null : bytes.toString('utf8')
}

/**
 * A scan is ~0.5s and `claude -p /usage` about 1.4s, so the first visit to the
 * tab pays for both and every refresh inside the window is free.
 */
const USAGE_CACHE_MS = 30_000

export function createHandler(opts: HttpOptions) {
  const { pm, webRoot, token } = opts
  const sameOrigin = opts.sameOrigin ?? createOriginCheck()
  let usage: { at: number; report: Promise<UsageReport> } | null = null

  const homeDir = (): string => process.env['HOME'] ?? os.homedir()

  const within = (root: string, dir: string): boolean => {
    const rel = path.relative(path.resolve(root), dir)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }

  /**
   * Resolved through symlinks, since that is what `readdir` will follow.
   *
   * A path that does not exist cannot be read either way, so it falls back to
   * the lexical form and is refused or 400s on its own merits.
   */
  const real = async (p: string): Promise<string> => {
    try { return await realpath(p) } catch { return path.resolve(p) }
  }

  /**
   * Where the picker may look.
   *
   * Serving a picker is not a reason to serve `ls /`. Unconstrained, this
   * endpoint enumerates the whole machine — usernames, install paths, project
   * layouts — for anything that can reach the API, which is ideal groundwork
   * for whoever gets to the shell next. Home, the roots of projects that
   * already exist, and anything named with --fs-root; the roots list is read
   * per request, so a project created a moment ago is browsable at once.
   *
   * Compared after both sides are resolved: a lexical check reads a symlink
   * out of the tree as still inside it, which hands back the whole machine
   * again through any link that happens to sit in a browsable root. Resolving
   * the roots too keeps a symlinked home (`/home/me` -> `/mnt/data/me`) from
   * failing the other way.
   */
  const browsable = async (dir: string): Promise<boolean> => {
    const roots = [homeDir(), ...pm.list().map((p) => p.root), ...(opts.fsRoots ?? [])]
    const [target, ...resolved] = await Promise.all([dir, ...roots].map(real))
    return resolved.some((root) => within(root, target!))
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')

    // Ahead of the token check, and covering the static bundle as well as the
    // API: a page that has no business here does not get to learn whether it
    // guessed the secret either.
    if (!sameOrigin(req)) return text(res, 403, 'forbidden origin')

    if (url.pathname.startsWith('/api/')) {
      if (token && !bearerEquals(token, req.headers.authorization)) {
        return json(res, 401, { error: 'unauthorized' })
      }
      return await api(req, res, url)
    }
    return await serveStatic(res, url.pathname)
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // Session ids are globally unique, so no route needs a project segment —
    // this is what keeps already-installed Claude Code hooks working (§4.5).
    const done = url.pathname.match(/^\/api\/sessions\/([^/]+)\/done$/)
    if (done && req.method === 'POST') {
      const s = pm.findSession(decodeURIComponent(done[1]!))
      if (!s) return json(res, 404, { error: 'no such session' })
      s.hook()
      return json(res, 200, { ok: true })
    }

    /**
     * Every Claude Code hook tring installs lands here (see hook-cli.ts).
     *
     * A permission or question is held open until it is settled — from the
     * inbox, by the auto-answerer, or by the hook hanging up because the
     * prompt was answered in the terminal. Holding is safe: in an interactive
     * session Claude shows its own dialog alongside, and the first answer wins.
     */
    const hook = url.pathname.match(/^\/api\/sessions\/([^/]+)\/hook$/)
    if (hook && req.method === 'POST') {
      const id = decodeURIComponent(hook[1]!)
      const agent = opts.agentSession?.(id)
      const s = pm.findSession(id)
      if (!s && !agent) return json(res, 404, { error: 'no such session' })
      const raw = await readBody(req)
      if (raw === null) return tooLarge(req, res, 'body too large')
      let body: { event?: unknown; payload?: unknown }
      try {
        body = JSON.parse(raw || '{}') as typeof body
      } catch {
        return json(res, 400, { error: 'malformed body' })
      }
      if (typeof body.event !== 'string') return json(res, 400, { error: 'event is required' })
      const payload = (body.payload && typeof body.payload === 'object' ? body.payload : {}) as HookPayload
      // The orchestrator agent's own prompts are on screen in front of you,
      // so none of them become cards. Only its conversation id is kept, so a
      // restart reopens the same one.
      if (agent) {
        const conv = body.event === 'SessionStart' ? claudeConversation({ id: payload.session_id, cwd: payload.cwd }) : null
        if (conv) agent.setClaude(conv)
        return json(res, 200, { output: null })
      }
      if (!s) return json(res, 404, { error: 'no such session' })
      if (!opts.inbox) {
        if (body.event === 'Stop' || body.event === 'Notification') s.hook()
        return json(res, 200, { output: null })
      }
      // `close` on the response before it is written means the hook process
      // went away: Claude timed it out, or the prompt was answered elsewhere.
      const gone = new AbortController()
      res.on('close', () => { if (!res.writableFinished) gone.abort() })
      const output = await routeHook({
        inbox: opts.inbox, session: s, event: body.event, payload,
        signal: gone.signal, onPermission: opts.onPermission,
      })
      if (gone.signal.aborted) return
      return json(res, 200, { output })
    }

    /**
     * The orchestrator agent's tools, relayed by its MCP server (mcp-cli.ts).
     * Behind the same token as everything else: anything holding it can
     * already type into every shell, so this opens no door that was shut.
     */
    if (url.pathname === '/api/orchestrator/tools' && req.method === 'GET') {
      return json(res, 200, { tools: TOOLS })
    }
    if (url.pathname === '/api/orchestrator/call' && req.method === 'POST') {
      const tools = opts.tools
      if (!tools) return json(res, 503, { error: 'the orchestrator agent is not available' })
      const raw = await readBody(req)
      if (raw === null) return tooLarge(req, res, 'body too large')
      let body: { name?: unknown; arguments?: unknown }
      try {
        body = JSON.parse(raw || '{}') as typeof body
      } catch {
        return json(res, 400, { error: 'malformed body' })
      }
      if (typeof body.name !== 'string') return json(res, 400, { error: 'name is required' })
      const args = (body.arguments && typeof body.arguments === 'object' ? body.arguments : {}) as Record<string, unknown>
      // wait_for can run for minutes; the relay hanging up (Esc in Claude)
      // ends it instead of leaving a poller behind.
      const gone = new AbortController()
      res.on('close', () => { if (!res.writableFinished) gone.abort() })
      try {
        const text = await tools.call(body.name, args, gone.signal)
        if (gone.signal.aborted) return
        return json(res, 200, { text, isError: false })
      } catch (err) {
        if (gone.signal.aborted) return
        if (err instanceof ToolError) return json(res, 200, { text: err.message, isError: true })
        return json(res, 200, { text: `tring could not do that: ${(err as Error).message}`, isError: true })
      }
    }

    /**
     * Phone notifications: the settings section's calls. Each names its
     * device by the push subscription's endpoint, which only that browser has.
     */
    if (url.pathname === '/api/push' && req.method === 'GET') {
      if (!opts.push) return json(res, 503, { error: 'notifications are not available' })
      return json(res, 200, { publicKey: opts.push.publicKey() })
    }
    const pushRoute = url.pathname.match(/^\/api\/push\/(status|subscribe|prefs|unsubscribe|test)$/)
    if (pushRoute && req.method === 'POST') {
      const push = opts.push
      if (!push) return json(res, 503, { error: 'notifications are not available' })
      const raw = await readBody(req)
      if (raw === null) return tooLarge(req, res, 'body too large')
      let body: { endpoint?: unknown; subscription?: unknown; prefs?: unknown; label?: unknown; phone?: unknown }
      try {
        body = JSON.parse(raw || '{}') as typeof body
      } catch {
        return json(res, 400, { error: 'malformed body' })
      }
      const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
      switch (pushRoute[1]) {
        case 'status': return json(res, 200, push.status(endpoint))
        case 'subscribe':
          return await push.subscribe(body.subscription, body.prefs, body.label, body.phone)
            ? json(res, 200, { ok: true })
            : json(res, 400, { error: 'not a push subscription' })
        case 'prefs':
          return await push.setPrefs(endpoint, body.prefs) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'unknown device' })
        case 'unsubscribe':
          await push.unsubscribe(endpoint)
          return json(res, 200, { ok: true })
        case 'test': {
          const status = await push.test(endpoint)
          if (status === null) return json(res, 404, { error: 'unknown device' })
          return json(res, 200, { ok: status >= 200 && status < 300, status })
        }
      }
    }

    /**
     * The desktop microphone's local Whisper: its status and the model this
     * PC should use, installing it, switching it on, and turning speech into
     * text. The audio is a WAV the page recorded, and stays on this machine.
     */
    if (url.pathname.startsWith('/api/voice')) {
      const voice = opts.voice
      if (!voice) return json(res, 503, { error: 'local speech recognition is not available' })
      if (url.pathname === '/api/voice' && req.method === 'GET') return json(res, 200, await voice.status())
      if (url.pathname === '/api/voice/transcribe' && req.method === 'POST') {
        if (Number(req.headers['content-length'] ?? '0') > MAX_AUDIO_BYTES) return json(res, 413, { error: 'that recording is too long' })
        const wav = await readBytes(req, MAX_AUDIO_BYTES)
        if (wav === null) return tooLarge(req, res, 'that recording is too long')
        if (wav.length < 44 || wav.subarray(0, 4).toString('latin1') !== 'RIFF') return json(res, 400, { error: 'not a WAV recording' })
        try {
          return json(res, 200, { text: await voice.transcribe(wav) })
        } catch (err) {
          return json(res, 500, { error: (err as Error).message })
        }
      }
      if (req.method === 'POST' && (url.pathname === '/api/voice/install' || url.pathname === '/api/voice/enable')) {
        const raw = await readBody(req)
        if (raw === null) return tooLarge(req, res, 'body too large')
        let body: { model?: unknown; enabled?: unknown }
        try {
          body = JSON.parse(raw || '{}') as typeof body
        } catch {
          return json(res, 400, { error: 'malformed body' })
        }
        if (url.pathname === '/api/voice/install') {
          return json(res, 200, { started: voice.install(isModel(body.model) ? body.model : undefined) })
        }
        await voice.setEnabled(body.enabled === true)
        return json(res, 200, await voice.status())
      }
    }

    if (url.pathname === '/api/hooks' && req.method === 'GET') {
      return json(res, 200, await hooksStatus(opts.claudeSettingsPath) satisfies HooksStatus)
    }
    if (url.pathname === '/api/hooks' && req.method === 'POST') {
      try {
        await installHooks(opts.claudeSettingsPath)
        return json(res, 200, await hooksStatus(opts.claudeSettingsPath))
      } catch (err) {
        return json(res, 500, { error: (err as Error).message })
      }
    }

    const status = url.pathname.match(/^\/api\/sessions\/([^/]+)\/status$/)
    if (status && req.method === 'POST') {
      const s = pm.findSession(decodeURIComponent(status[1]!))
      if (!s) return json(res, 404, { error: 'no such session' })
      const raw = await readBody(req)
      if (raw === null) return tooLarge(req, res, 'body too large')
      let body: { status?: string }
      try {
        body = JSON.parse(raw || '{}') as { status?: string }
      } catch {
        return json(res, 400, { error: 'malformed body' })
      }
      if (body.status === 'done') s.hook()
      else if (body.status === 'busy') s.tracker.commandStart(Date.now())
      else return json(res, 400, { error: 'status must be "busy" or "done"' })
      return json(res, 200, { ok: true })
    }

    // The panel beside the centre terminal: what is uncommitted where that
    // session's shell currently is. git is run without a shell and with the
    // repo-config program hooks switched off — see git-diff.ts.
    const diff = url.pathname.match(/^\/api\/sessions\/([^/]+)\/diff$/)
    if (diff && req.method === 'GET') {
      const s = pm.findSession(decodeURIComponent(diff[1]!))
      if (!s) return json(res, 404, { error: 'no such session' })
      return json(res, 200, await gitDiff(s.cwd))
    }

    // Directory listing for the project/session dialogs. A browser can never
    // hand back an absolute path — webkitdirectory and showDirectoryPicker
    // both withhold it — so the picker has to be served by the side that
    // actually has the filesystem.
    if (url.pathname === '/api/fs' && req.method === 'GET') {
      const raw = url.searchParams.get('path')?.trim()
      const dir = raw ? path.resolve(raw) : homeDir()
      if (!await browsable(dir)) return json(res, 403, { error: 'outside the browsable roots' })
      try {
        const found = await readdir(dir, { withFileTypes: true })
        const entries = found
          .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name))
        // Stop offering "up" at the edge rather than offering a step that 403s.
        const parent = path.dirname(dir)
        const up = parent !== dir && await browsable(parent) ? parent : null
        return json(res, 200, { path: dir, parent: up, entries })
      } catch {
        return json(res, 400, { error: `cannot read ${dir}` })
      }
    }

    // Claude Code's own transcripts, bucketed. Read-only, local, and entirely
    // separate from the session machinery — nothing here touches a PTY.
    if (url.pathname === '/api/usage' && req.method === 'GET') {
      const now = Date.now()
      if (!usage || now - usage.at > USAGE_CACHE_MS) {
        usage = { at: now, report: collectUsage(defaultTranscriptDir(), now) }
      }
      try {
        return json(res, 200, await usage.report)
      } catch {
        usage = null
        return json(res, 500, { error: 'cannot read Claude Code transcripts' })
      }
    }

    /**
     * A file dropped on a terminal (spec §5.4).
     *
     * The response is a path on *this* machine, which is the only kind the
     * shell behind the terminal can open — the browser may well be on another
     * one. What the client does with it is type it into the prompt.
     */
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const store = opts.uploads
      if (!store) return json(res, 503, { error: 'uploads are not configured' })

      const declared = Number(req.headers['content-length'] ?? '0')
      if (declared > MAX_UPLOAD_BYTES) {
        return json(res, 413, { error: `uploads are limited to ${MAX_UPLOAD_BYTES >> 20}MB` })
      }
      // Null is a body that overran the limit or was cut short — a lying
      // Content-Length lands here rather than on the 413 above.
      const bytes = await readBytes(req, MAX_UPLOAD_BYTES)
      if (bytes === null) {
        return tooLarge(req, res, `uploads are limited to ${MAX_UPLOAD_BYTES >> 20}MB`)
      }
      if (bytes.length === 0) return json(res, 400, { error: 'empty upload' })

      try {
        return json(res, 200, { path: await store.save(bytes, url.searchParams.get('name') ?? '') })
      } catch {
        return json(res, 500, { error: 'cannot write the dropped file' })
      }
    }

    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      const sessions = pm.list().flatMap((p) =>
        p.sessions.map((s) => ({ ...s, project: p.name })),
      )
      return json(res, 200, { sessions })
    }

    return json(res, 404, { error: 'not found' })
  }

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const file = path.resolve(webRoot, rel)
    // Never serve outside the bundle, whatever the request contains.
    if (file !== webRoot && !file.startsWith(webRoot + path.sep)) {
      text(res, 403, 'forbidden')
      return
    }
    try {
      const info = await stat(file)
      if (!info.isFile()) throw new Error('not a file')
      head(res, 200, MIME[path.extname(file)] ?? 'application/octet-stream')
      createReadStream(file).pipe(res)
    } catch {
      if (rel === 'index.html') {
        head(res, 200, MIME['.html']!)
        res.end('<!doctype html><meta charset="utf-8"><title>tring</title>' +
          '<body style="font:14px ui-monospace,monospace;background:#040c0a;color:#dceee7;padding:2rem">' +
          '<p>Daemon is running. The web bundle is not built yet.</p>' +
          '<p style="color:#8aa79d">Run <code>npm run build -w @tring/web</code>.</p>')
        return
      }
      text(res, 404, 'not found')
    }
  }
}

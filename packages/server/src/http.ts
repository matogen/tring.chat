import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Capabilities } from '@tring/shared/protocol'
import type { ProjectManager } from './project-manager.ts'
import {
  bearerEquals, createOriginCheck, SECURITY_HEADERS, type OriginCheck,
} from './security.ts'
import { collectUsage, defaultTranscriptDir, type UsageReport } from './usage.ts'

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
  /** Browser-agent capability, re-read per request (spec §4.7). */
  capabilities?: () => Capabilities
  /** Fetches Chromium, reporting progress. Absent means the route 404s. */
  installBrowser?: (onProgress: (received: number, total: number) => void) => Promise<void>
}

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

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1e6) req.destroy() // hooks post nothing large
    })
    req.on('end', () => resolve(data))
  })

/**
 * A scan is ~0.5s and `claude -p /usage` about 1.4s, so the first visit to the
 * tab pays for both and every refresh inside the window is free.
 */
const USAGE_CACHE_MS = 30_000

export function createHandler(opts: HttpOptions) {
  const { pm, webRoot, token } = opts
  const sameOrigin = opts.sameOrigin ?? createOriginCheck()
  let usage: { at: number; report: Promise<UsageReport> } | null = null
  let installing = false

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

    const status = url.pathname.match(/^\/api\/sessions\/([^/]+)\/status$/)
    if (status && req.method === 'POST') {
      const s = pm.findSession(decodeURIComponent(status[1]!))
      if (!s) return json(res, 404, { error: 'no such session' })
      let body: { status?: string }
      try {
        body = JSON.parse((await readBody(req)) || '{}') as { status?: string }
      } catch {
        return json(res, 400, { error: 'malformed body' })
      }
      if (body.status === 'done') s.hook()
      else if (body.status === 'busy') s.tracker.commandStart(Date.now())
      else return json(res, 400, { error: 'status must be "busy" or "done"' })
      return json(res, 200, { ok: true })
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

    // Browser actions for the agent (spec §4.8). Addressed by **session** id,
    // because that is what an in-session agent already has as
    // $TRING_SESSION_ID — a browser id could never reach a shell whose
    // environment was fixed before the page was attached.
    const action = url.pathname.match(/^\/api\/browser\/([^/]+)\/([a-z]+)$/)
    if (action) {
      const session = pm.findSession(decodeURIComponent(action[1]!))
      if (!session) return json(res, 404, { error: 'no such session' })
      const browser = session.browser
      if (!browser) return json(res, 409, { error: 'this session has no browser attached' })

      const what = action[2]!
      if (what === 'snapshot' && req.method === 'GET') {
        return json(res, 200, await browser.snapshot())
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

      let body: Record<string, unknown>
      try {
        body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
      } catch {
        return json(res, 400, { error: 'malformed body' })
      }
      const ref = typeof body['ref'] === 'string' ? body['ref'] : null

      switch (what) {
        case 'navigate': {
          const to = body['url']
          if (typeof to !== 'string') return json(res, 400, { error: 'url is required' })
          const went = await browser.navigate(to)
          if (!went) {
            // Not an error: the agent should read this and wait, or pick
            // somewhere else. The human has been offered the choice on the tile.
            return json(res, 200, {
              ok: false,
              blocked: true,
              error: `navigation to ${to} is not allowed for this project; ` +
                'the human has been asked whether to permit it',
              url: browser.info().url,
            })
          }
          return json(res, 200, { ok: true, url: browser.info().url })
        }
        case 'click':
          if (!ref) return json(res, 400, { error: 'ref is required' })
          return json(res, 200, await browser.act('click', (l) => l(ref).click()))
        case 'type': {
          const text = typeof body['text'] === 'string' ? body['text'] : null
          if (!ref || text === null) return json(res, 400, { error: 'ref and text are required' })
          return json(res, 200, await browser.act('type', (l) => l(ref).fill(text)))
        }
        case 'select': {
          const value = typeof body['value'] === 'string' ? body['value'] : null
          if (!ref || value === null) return json(res, 400, { error: 'ref and value are required' })
          return json(res, 200, await browser.act('select', async (l) => {
            await l(ref).selectOption(value)
          }))
        }
        case 'wait': {
          const target = typeof body['for'] === 'string' ? body['for'] : null
          if (!target) return json(res, 400, { error: 'for is required' })
          const timeout = typeof body['timeout'] === 'number' ? body['timeout'] : 10_000
          return json(res, 200, await browser.act('wait', async (l) => {
            await l(target).waitFor({ timeout })
          }))
        }
        case 'eval': {
          // Off unless the project turned it on: one fetch() from page script
          // routes around the navigation allowlist completely (spec §4.7).
          if (!pm.browserSettings(session.projectId).eval) {
            return json(res, 403, { error: 'browser_eval is disabled for this project' })
          }
          const js = typeof body['js'] === 'string' ? body['js'] : null
          if (!js) return json(res, 400, { error: 'js is required' })
          return json(res, 200, await browser.evaluate(js))
        }
        default:
          return json(res, 404, { error: 'not found' })
      }
    }

    if (url.pathname === '/api/capabilities' && req.method === 'GET') {
      return json(res, 200, opts.capabilities?.() ?? { browser: 'unavailable' })
    }

    // Streams `{received, total}` lines while ~150MB arrives, so the settings
    // dialog can show a bar rather than a spinner that lasts minutes.
    if (url.pathname === '/api/browser/install' && req.method === 'POST') {
      if (!opts.installBrowser) return json(res, 404, { error: 'not found' })
      // A second click must not start a second download.
      if (installing) return json(res, 409, { error: 'already installing' })
      if (opts.capabilities?.().browser !== 'unavailable') {
        return json(res, 409, { error: 'already installed' })
      }
      installing = true
      head(res, 200, 'application/x-ndjson; charset=utf-8')
      try {
        await opts.installBrowser((received, total) => {
          res.write(JSON.stringify({ received, total }) + '\n')
        })
        res.end(JSON.stringify({ done: true }) + '\n')
      } catch (err) {
        res.end(JSON.stringify({ error: (err as Error).message }) + '\n')
      } finally {
        installing = false
      }
      return
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

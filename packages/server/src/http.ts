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
import { MAX_UPLOAD_BYTES, NotAnImage, type UploadStore } from './uploads.ts'

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
 * The body as bytes, with a ceiling.
 *
 * Content-Length is checked by the caller first, so an honest client gets a
 * 413 it can show the user. This is the backstop for one that lies: the
 * socket goes, and nothing is buffered past the limit either way.
 */
const readBytes = (req: IncomingMessage, limit: number): Promise<Buffer | null> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(null))
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

    /**
     * An image dropped on a terminal (spec §5.4).
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
        return json(res, 413, { error: `images are limited to ${MAX_UPLOAD_BYTES >> 20}MB` })
      }
      const bytes = await readBytes(req, MAX_UPLOAD_BYTES)
      if (!bytes || bytes.length === 0) return json(res, 400, { error: 'empty upload' })

      try {
        return json(res, 200, { path: await store.save(bytes) })
      } catch (err) {
        if (err instanceof NotAnImage) return json(res, 415, { error: err.message })
        return json(res, 500, { error: 'cannot write the dropped image' })
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

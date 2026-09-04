import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { ProjectManager } from './project-manager.ts'
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
}

export interface HttpOptions {
  pm: ProjectManager
  webRoot: string
  token?: string | null
}

const json = (res: ServerResponse, code: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
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
  let usage: { at: number; report: Promise<UsageReport> } | null = null

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname.startsWith('/api/')) {
      if (token && req.headers.authorization !== `Bearer ${token}`) {
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
    // actually has the filesystem. No extra privilege is granted here: this
    // daemon already spawns arbitrary shells, and --token still gates it.
    if (url.pathname === '/api/fs' && req.method === 'GET') {
      const raw = url.searchParams.get('path')?.trim()
      const dir = raw ? path.resolve(raw) : (process.env['HOME'] ?? os.homedir())
      try {
        const found = await readdir(dir, { withFileTypes: true })
        const entries = found
          .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name))
        const parent = path.dirname(dir)
        return json(res, 200, { path: dir, parent: parent === dir ? null : parent, entries })
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
      res.writeHead(403).end('forbidden')
      return
    }
    try {
      const info = await stat(file)
      if (!info.isFile()) throw new Error('not a file')
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
      createReadStream(file).pipe(res)
    } catch {
      if (rel === 'index.html') {
        res.writeHead(200, { 'content-type': MIME['.html']! })
        res.end('<!doctype html><meta charset="utf-8"><title>tring</title>' +
          '<body style="font:14px ui-monospace,monospace;background:#040c0a;color:#dceee7;padding:2rem">' +
          '<p>Daemon is running. The web bundle is not built yet.</p>' +
          '<p style="color:#8aa79d">Run <code>npm run build -w @tring/web</code>.</p>')
        return
      }
      res.writeHead(404).end('not found')
    }
  }
}

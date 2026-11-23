import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectManager } from '../src/project-manager.ts'
import { createHandler } from '../src/http.ts'
import { Inbox } from '../src/inbox.ts'

const HOOK_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/hook-cli.ts')
const TOKEN = 'a'.repeat(64)

interface Rig { pm: ProjectManager; server: Server; base: string; inbox: Inbox; sessionId: string }
const rigs: Rig[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.pm.dispose()
    r.server.closeAllConnections()
    await new Promise((res) => r.server.close(res))
  }
})

async function rig(): Promise<Rig> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-hook-'))
  const pm = await ProjectManager.open({
    url: 'http://127.0.0.1:0', scrollback: 50, idleMs: 150,
    statePath: path.join(dir, 'projects.json'), tickMs: 40,
  })
  const inbox = new Inbox()
  const handler = createHandler({ pm, webRoot: path.join(dir, 'dist'), token: TOKEN, inbox })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const p = pm.createProject('demo', dir)
  const sessionId = pm.create(p, {})!.id
  const r = { pm, server, base, inbox, sessionId }
  rigs.push(r)
  return r
}

const waitFor = async (fn: () => boolean, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error('timed out')
}

/** Runs the real hook command the way Claude Code would. */
function runHook(env: Record<string, string | undefined>, event: string, payload: object) {
  const child = spawn(process.execPath, [HOOK_CLI, event], {
    env: { PATH: process.env['PATH'], ...env } as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (c: Buffer) => { out += c.toString() })
  child.stdin.end(JSON.stringify(payload))
  const done = new Promise<{ code: number | null; out: string }>((resolve) =>
    child.on('exit', (code) => resolve({ code, out })))
  return { child, done }
}

describe('hook route', () => {
  it('holds a permission request and returns the inbox decision', async () => {
    const r = await rig()
    const res = fetch(`${r.base}/api/sessions/${r.sessionId}/hook`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ event: 'PermissionRequest', payload: { tool_name: 'Bash', tool_input: { command: 'ls' } } }),
    })
    await waitFor(() => r.inbox.list().length === 1)
    r.inbox.answer(r.inbox.list()[0]!.id, { decision: 'deny', message: 'no' })
    const body = await (await res).json() as { output: unknown }
    expect(body.output).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no' } },
    })
  })

  it('drops the card when the caller hangs up', async () => {
    const r = await rig()
    const ac = new AbortController()
    const res = fetch(`${r.base}/api/sessions/${r.sessionId}/hook`, {
      method: 'POST', signal: ac.signal,
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ event: 'PermissionRequest', payload: { tool_name: 'Bash', tool_input: {} } }),
    }).catch(() => null)
    await waitFor(() => r.inbox.list().length === 1)
    ac.abort()
    await res
    await waitFor(() => r.inbox.list().length === 0)
  })

  it('needs the token', async () => {
    const r = await rig()
    const res = await fetch(`${r.base}/api/sessions/${r.sessionId}/hook`, {
      method: 'POST', body: JSON.stringify({ event: 'Stop', payload: {} }),
    })
    expect(res.status).toBe(401)
  })
})

describe('tring-hook command', () => {
  it('does nothing outside a tring session', async () => {
    const { done } = runHook({}, 'PermissionRequest', { tool_name: 'Bash' })
    expect(await done).toEqual({ code: 0, out: '' })
  })

  it('prints nothing and exits 0 when the daemon is unreachable', async () => {
    const { done } = runHook({
      TRING_SESSION_ID: 'x', TRING_URL: 'http://127.0.0.1:1', TRING_TOKEN: TOKEN,
    }, 'PermissionRequest', { tool_name: 'Bash' })
    expect(await done).toEqual({ code: 0, out: '' })
  })

  it('carries a question to the inbox and prints the answer for Claude Code', async () => {
    const r = await rig()
    const payload = {
      hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
    }
    const { done } = runHook({
      TRING_SESSION_ID: r.sessionId, TRING_URL: r.base, TRING_TOKEN: TOKEN,
    }, 'PreToolUse', payload)
    await waitFor(() => r.inbox.list().length === 1)
    r.inbox.answer(r.inbox.list()[0]!.id, { decision: 'allow', answers: { 'Ship it?': 'Yes' } })
    const { code, out } = await done
    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...payload.tool_input, answers: { 'Ship it?': 'Yes' } },
      },
    })
  })

  it('clears the card when Claude Code kills the hook', async () => {
    const r = await rig()
    const { child, done } = runHook({
      TRING_SESSION_ID: r.sessionId, TRING_URL: r.base, TRING_TOKEN: TOKEN,
    }, 'PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } })
    await waitFor(() => r.inbox.list().length === 1)
    child.kill()
    await done
    await waitFor(() => r.inbox.list().length === 0)
  })
})

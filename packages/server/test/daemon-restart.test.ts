import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import type { InboxItem } from '@tring/shared/protocol'

/**
 * The whole daemon, stopped and started again: the card store's own tests
 * cover its parts, and this covers what only index.ts does — saving on every
 * change, loading before the first screen connects, and handing each card to
 * the tile that reopened its conversation.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.resolve(here, '../src/index.ts')
const REPO = path.resolve(here, '../../..')
const TOKEN = 'c'.repeat(64)
const CONVERSATION = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'

const children: ChildProcess[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {})
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await sleep(100)
  }
}

interface Rig { config: string; env: NodeJS.ProcessEnv; port: number; url: string }

/**
 * A config dir with one project whose tile 1 holds a Claude conversation,
 * and a `claude` on PATH that only prints, so the tile reopening it starts
 * nothing real.
 */
async function rig(): Promise<Rig> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tring-restart-'))
  dirs.push(root)
  const config = path.join(root, 'config')
  const bin = path.join(root, 'bin')
  await mkdir(path.join(config, 'tring'), { recursive: true })
  await mkdir(bin, { recursive: true })
  if (process.platform === 'win32') {
    await writeFile(path.join(bin, 'claude.cmd'), '@echo stand-in claude %*\r\n')
  } else {
    await writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho stand-in claude "$@"\n')
    await chmod(path.join(bin, 'claude'), 0o755)
  }
  await writeFile(path.join(config, 'tring', 'projects.json'), JSON.stringify({
    version: 1,
    activeProjectId: 'p1',
    projects: [{ id: 'p1', name: 'demo', root, sessions: [{ slot: 1, cwd: root, claude: { id: CONVERSATION, cwd: root } }] }],
  }))
  const port = await freePort()
  return {
    config,
    port,
    url: `http://127.0.0.1:${port}`,
    env: { ...process.env, XDG_CONFIG_HOME: config, PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}` },
  }
}

async function start(r: Rig): Promise<ChildProcess> {
  const child = spawn(process.execPath, [
    '--import', 'tsx', DAEMON,
    '--port', String(r.port), '--token', TOKEN, '--no-open', '--no-update-check',
  ], { cwd: REPO, env: r.env, stdio: ['ignore', 'ignore', 'ignore'] })
  children.push(child)
  await waitFor(async () => (await fetch(`${r.url}/api/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } })).ok)
  return child
}

async function sessions(r: Rig): Promise<Array<{ id: string; slot: number }>> {
  const res = await fetch(`${r.url}/api/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } })
  return ((await res.json()) as { sessions: Array<{ id: string; slot: number }> }).sessions
}

/** The inbox the first screen to connect is shown. */
function inboxOnConnect(r: Rig): Promise<InboxItem[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(r.url.replace(/^http/, 'ws'), { headers: { origin: r.url } })
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('no inbox')) }, 10_000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN })))
    ws.on('message', (data, binary) => {
      if (binary) return
      const msg = JSON.parse(String(data)) as { type: string; items?: InboxItem[] }
      if (msg.type !== 'inbox') return
      clearTimeout(timer)
      ws.close()
      resolve(msg.items ?? [])
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

function stopped(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
  })
}

describe('daemon restart', { timeout: 90_000 }, () => {
  it('brings a "finished, waiting for you" card back on the tile that reopened its conversation', async () => {
    const r = await rig()
    let daemon = await start(r)
    const [before] = await waitFor(async () => {
      const list = await sessions(r)
      return list.length ? list : null
    })

    // The agent finishes its turn: Claude Code's Stop hook, as tring-hook sends it.
    const hook = await fetch(`${r.url}/api/sessions/${before!.id}/hook`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'Stop', payload: { session_id: CONVERSATION, last_assistant_message: 'Done. Over to you.' } }),
    })
    expect(hook.status).toBe(200)
    await waitFor(async () => {
      const saved = JSON.parse(await readFile(path.join(r.config, 'tring', 'inbox.json'), 'utf8')) as { cards: unknown[] }
      return saved.cards.length === 1
    })

    // Killed outright, as a closed console window, a crash or a reboot does it:
    // nothing gets a chance to write on the way out.
    daemon.kill('SIGKILL')
    await stopped(daemon)

    daemon = await start(r)
    const after = await sessions(r)
    expect(after).toHaveLength(1)
    expect(after[0]!.id).not.toBe(before!.id)

    const items = await inboxOnConnect(r)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'reply', message: 'Done. Over to you.', sessionId: after[0]!.id })
  })
})

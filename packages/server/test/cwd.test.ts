import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProjectManager } from '../src/project-manager.ts'

const live: ProjectManager[] = []
afterEach(async () => { for (const pm of live.splice(0)) await pm.dispose() })

const open = (statePath: string) => ProjectManager.open({
  url: 'http://127.0.0.1:7331', scrollback: 50, idleMs: 200, statePath, tickMs: 50,
})
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn: () => boolean, ms = 9000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await settle(50)
  }
  throw new Error('timed out')
}

describe('working directory', () => {
  it('restores each session where it was created', async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tring-cwd-')))
    const statePath = path.join(dir, 'projects.json')
    const a = path.join(dir, 'alpha'); await mkdir(a)
    const b = path.join(dir, 'beta'); await mkdir(b)

    const pm = await open(statePath); live.push(pm)
    const proj = pm.createProject('demo', dir)
    pm.create(proj, { slot: 1, cwd: a })
    pm.create(proj, { slot: 2, cwd: b })
    await pm.save()
    await pm.dispose()

    const restored = await open(statePath); live.push(restored)
    const sessions = restored.list()[0]!.sessions.sort((x, y) => x.slot - y.slot)
    expect(sessions.map((s) => s.cwd)).toEqual([a, b])
  })

  it('follows the shell when the user cd-s, and restores there instead', async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tring-cd-')))
    const statePath = path.join(dir, 'projects.json')
    const sub = path.join(dir, 'wandered'); await mkdir(sub)

    const pm = await open(statePath); live.push(pm)
    const proj = pm.createProject('demo', dir)
    const s = pm.create(proj, { slot: 1, cwd: dir })!
    expect(s.cwd).toBe(dir)

    s.write(`cd ${sub}\n`)
    await waitFor(() => s.cwd === sub)
    expect(s.cwd).toBe(sub)

    // The move must survive a restart — that is the whole point.
    await pm.save()
    await pm.dispose()
    const restored = await open(statePath); live.push(restored)
    expect(restored.list()[0]!.sessions[0]!.cwd).toBe(sub)
  })

  it('persists the move without needing any other change to happen', async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tring-auto-')))
    const statePath = path.join(dir, 'projects.json')
    const sub = path.join(dir, 'deep'); await mkdir(sub)

    const pm = await open(statePath); live.push(pm)
    const proj = pm.createProject('demo', dir)
    const s = pm.create(proj, { slot: 1, cwd: dir })!
    s.write(`cd ${sub}\n`)
    await waitFor(() => s.cwd === sub)

    // No save() call here: moving is itself a change worth writing down.
    const { readFile } = await import('node:fs/promises')
    await settle(300)
    const state = JSON.parse(await readFile(statePath, 'utf8')) as
      { projects: { sessions: { cwd: string }[] }[] }
    expect(state.projects[0]!.sessions[0]!.cwd).toBe(sub)
  })
})

describe('rc files that cd', () => {
  // A shell whose startup moves it elsewhere, which is what `cd /mnt/c` in a
  // ~/.bashrc does. Scripted rather than relying on the ambient rc, so the
  // test means the same thing on every machine.
  async function wanderingShell(target: string, dir: string): Promise<string> {
    const { writeFile, chmod } = await import('node:fs/promises')
    const p = path.join(dir, 'wandersh')
    await writeFile(p, `#!/bin/sh\ncd ${target}\nexec /bin/sh\n`)
    await chmod(p, 0o755)
    return p
  }

  it('puts the shell back in the directory the user chose', async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tring-rc-')))
    const chosen = path.join(dir, 'chosen'); await mkdir(chosen)
    const elsewhere = path.join(dir, 'elsewhere'); await mkdir(elsewhere)
    const shell = await wanderingShell(elsewhere, dir)

    const { Session } = await import('../src/session.ts')
    const s = new Session({
      id: 'rc1', projectId: 'p', projectName: 'demo', slot: 1,
      cwd: chosen, shell, url: 'http://127.0.0.1:7331', idleMs: 200, scrollback: 100,
    })
    try {
      await waitFor(() => s.cwd === chosen, 9000)
      expect(s.cwd).toBe(chosen)
    } finally {
      s.dispose()
    }
  })

  it('does not touch a shell that is already where it was asked to be', async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tring-noop-')))
    const { Session } = await import('../src/session.ts')
    // /bin/sh reads no rc here, so it stays put and needs no correction.
    const s = new Session({
      id: 'noop1', projectId: 'p', projectName: 'demo', slot: 1,
      cwd: dir, shell: '/bin/sh', url: 'http://127.0.0.1:7331', idleMs: 200, scrollback: 100,
    })
    try {
      await settle(900)
      expect(s.serialize()).not.toContain('cd -- ')
      expect(s.cwd).toBe(dir)
    } finally {
      s.dispose()
    }
  })

  it('leaves the shell alone once the user has started typing', async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tring-typed-')))
    const chosen = path.join(dir, 'chosen'); await mkdir(chosen)
    const elsewhere = path.join(dir, 'elsewhere'); await mkdir(elsewhere)
    const shell = await wanderingShell(elsewhere, dir)

    const { Session } = await import('../src/session.ts')
    const s = new Session({
      id: 'typed1', projectId: 'p', projectName: 'demo', slot: 1,
      cwd: chosen, shell, url: 'http://127.0.0.1:7331', idleMs: 200, scrollback: 100,
    })
    try {
      s.write('\n') // user is here first; the shell is theirs now
      await settle(1200)
      expect(s.serialize()).not.toContain('cd -- ')
    } finally {
      s.dispose()
    }
  })
})

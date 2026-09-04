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

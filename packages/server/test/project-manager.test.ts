import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrowserControl } from '@tring/shared/browser-control'
import type { BrowserInfo } from '@tring/shared/protocol'
import type { AttachedBrowser } from '../src/browser.ts'
import { ProjectManager, type PersistedState } from '../src/project-manager.ts'

const open = async (statePath: string, root: string) =>
  ProjectManager.open({ url: 'http://127.0.0.1:7331', scrollback: 50, idleMs: 200, statePath, tickMs: 50 })

const live: ProjectManager[] = []
afterEach(async () => { for (const pm of live.splice(0)) await pm.dispose() })

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-'))
  const statePath = path.join(dir, 'projects.json')
  const pm = await open(statePath, dir)
  live.push(pm)
  return { dir, statePath, pm }
}

const exists = (p: string) => stat(p).then(() => true, () => false)
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))

describe('ProjectManager', () => {
  it('starts empty when there is no config, which is the first-run state', async () => {
    const { pm } = await fixture()
    expect(pm.list()).toEqual([])
    expect(pm.activeProjectId).toBeNull()
  })

  it('round-trips projects and sessions through projects.json', async () => {
    const { dir, statePath, pm } = await fixture()
    const id = pm.createProject('api', dir)
    pm.create(id, { name: 'server', cwd: dir })
    await pm.save()

    const state = JSON.parse(await readFile(statePath, 'utf8')) as PersistedState
    expect(state.version).toBe(1)
    expect(state.activeProjectId).toBe(id)
    expect(state.projects[0]?.name).toBe('api')
    expect(state.projects[0]?.sessions[0]).toMatchObject({ slot: 1, name: 'server', cwd: dir })
  })

  it('remembers a tile colour across a restart', async () => {
    const { dir, statePath, pm } = await fixture()
    const id = pm.createProject('api', dir)
    const session = pm.create(id, { name: 'server', cwd: dir })!
    pm.findManager(session.id)!.setColor(session.id, '#a06cf0')
    await pm.save()
    await pm.dispose()

    const restored = await open(statePath, dir)
    live.push(restored)
    expect(restored.list()[0]?.sessions[0]?.color).toBe('#a06cf0')
  })

  it('refuses a colour that is not a plain hex value, since it reaches CSS', async () => {
    const { dir, pm } = await fixture()
    const id = pm.createProject('api', dir)
    const session = pm.create(id, { name: 'server', cwd: dir })!
    const mgr = pm.findManager(session.id)!

    mgr.setColor(session.id, 'red; background: url(evil)')
    expect(session.color).toBeNull()

    mgr.setColor(session.id, '#a06cf0')
    expect(session.color).toBe('#a06cf0')

    // Clearing back to no colour stays allowed.
    mgr.setColor(session.id, null)
    expect(session.color).toBeNull()
  })

  it('respawns the active project eagerly and leaves the others until activated', async () => {
    const { dir, statePath, pm } = await fixture()
    const a = pm.createProject('alpha', dir)
    pm.create(a, { name: 'a1' })
    const b = pm.createProject('beta', dir) // createProject activates, so beta is active
    pm.create(b, { name: 'b1' })
    await pm.save()
    await pm.dispose()

    const restored = await open(statePath, dir)
    live.push(restored)
    expect(restored.activeProjectId).toBe(b)

    const byId = Object.fromEntries(restored.list().map((p) => [p.id, p]))
    expect(byId[b]?.sessions).toHaveLength(1)   // active: spawned
    expect(byId[a]?.sessions).toHaveLength(0)   // background: still pending

    restored.activate(a)
    expect(restored.list().find((p) => p.id === a)?.sessions).toHaveLength(1)
  })

  it('never re-runs a recorded command on restore, but keeps it for the tile', async () => {
    const { dir, statePath, pm } = await fixture()
    const marker = path.join(dir, 'ran')
    const id = pm.createProject('demo', dir)
    pm.create(id, { command: `touch ${marker}` })

    await settle()
    expect(await exists(marker)).toBe(true)   // explicit create does run it
    await pm.save()
    await pm.dispose()
    await rm(marker)

    const restored = await open(statePath, dir)
    live.push(restored)
    await settle()

    expect(await exists(marker)).toBe(false)  // restore must not
    const session = restored.list().find((p) => p.id === id)?.sessions[0]
    expect(session?.command).toBe(`touch ${marker}`)
  })

  it('gives every session a globally unique id findable without its project', async () => {
    const { dir, pm } = await fixture()
    const a = pm.createProject('alpha', dir)
    const s1 = pm.create(a, {})!
    const b = pm.createProject('beta', dir)
    const s2 = pm.create(b, {})!

    expect(s1.id).not.toBe(s2.id)
    expect(pm.findSession(s1.id)?.projectId).toBe(a)
    expect(pm.findSession(s2.id)?.projectId).toBe(b)
  })

  it('allocates the first empty slot and refuses a seventeenth session', async () => {
    const { dir, pm } = await fixture()
    const id = pm.createProject('full', dir)
    const mgr = pm.managerFor(id)!
    for (let i = 0; i < 16; i++) mgr.create({})
    expect(mgr.list().map((s) => s.slot)).toEqual([...Array(16)].map((_, i) => i + 1))
    expect(() => mgr.create({})).toThrow(/full/)

    mgr.kill(mgr.at(7)!.id)
    expect(mgr.create({}).slot).toBe(7)
  })

  it('drops to the first-run empty state when the last project is deleted', async () => {
    const { dir, pm } = await fixture()
    const a = pm.createProject('alpha', dir)
    const b = pm.createProject('beta', dir)

    pm.deleteProject(b)
    expect(pm.activeProjectId).toBe(a)
    pm.deleteProject(a)
    expect(pm.activeProjectId).toBeNull()
    expect(pm.list()).toEqual([])
  })
})

/**
 * Attachment without Playwright — the same shape the daemon talks to, so every
 * path through persistence is exercised without downloading a browser.
 */
class StubBrowser {
  readonly control = new BrowserControl(0)
  onFrame: ((jpeg: Buffer) => void) | null = null
  onChange: (() => void) | null = null
  onPrompt: ((url: string) => void) | null = null
  onActivity: ((kind: unknown) => void) | null = null
  onClosed: (() => void) | null = null
  url = 'https://example.test/watch'
  info(): BrowserInfo {
    return {
      url: this.url, title: 'stub', control: this.control.holder,
      loading: false, blockedOn: null, viewport: { width: 1920, height: 1200 },
    }
  }
  async dispose(): Promise<void> {}
}
const asBrowser = (s: StubBrowser): AttachedBrowser => s as unknown as AttachedBrowser

describe('a page is part of what a tile is', () => {
  /**
   * Reopening tring has to bring back the tiles as they were left, and a tile
   * with a page attached is not the same tile as a bare terminal. `command` is
   * deliberately not re-run on restore; a page is, because reopening it
   * restores a view rather than executing work (spec §4.3).
   */
  it('writes the attached page into the state file', async () => {
    const { dir, statePath, pm } = await fixture()
    const id = pm.createProject('api', dir)
    const session = pm.create(id, { name: 'agent', cwd: dir })!
    session.attachBrowser(asBrowser(new StubBrowser()))
    await pm.save()

    const state = JSON.parse(await readFile(statePath, 'utf8')) as PersistedState
    expect(state.projects[0]?.sessions[0]?.browser).toEqual({ url: 'https://example.test/watch' })
  })

  // The other half: a tile whose page was closed must not come back with one.
  it('forgets the page once it is detached', async () => {
    const { dir, statePath, pm } = await fixture()
    const id = pm.createProject('api', dir)
    const session = pm.create(id, { name: 'agent', cwd: dir })!
    session.attachBrowser(asBrowser(new StubBrowser()))
    session.detachBrowser()
    await pm.save()

    const state = JSON.parse(await readFile(statePath, 'utf8')) as PersistedState
    expect(state.projects[0]?.sessions[0]?.browser).toBeNull()
  })

  // Attaching is a change to the tile, so it must reach the state file on its
  // own — not only when some later edit happens to write it out.
  it('persists on attach without waiting for another change', async () => {
    const { dir, statePath, pm } = await fixture()
    const id = pm.createProject('api', dir)
    const session = pm.create(id, { name: 'agent', cwd: dir })!
    await settle()
    session.attachBrowser(asBrowser(new StubBrowser()))
    await settle()

    const state = JSON.parse(await readFile(statePath, 'utf8')) as PersistedState
    expect(state.projects[0]?.sessions[0]?.browser).toEqual({ url: 'https://example.test/watch' })
  })

  it('carries the page through a restart into the restored session spec', async () => {
    const { dir, statePath, pm } = await fixture()
    const id = pm.createProject('api', dir)
    const session = pm.create(id, { name: 'agent', cwd: dir })!
    session.attachBrowser(asBrowser(new StubBrowser()))
    await pm.save()
    await pm.dispose()
    live.splice(live.indexOf(pm), 1)

    const reopened = await open(statePath, dir)
    live.push(reopened)
    await reopened.save()
    const state = JSON.parse(await readFile(statePath, 'utf8')) as PersistedState
    expect(state.projects[0]?.sessions[0]?.browser).toEqual({ url: 'https://example.test/watch' })
  })
})

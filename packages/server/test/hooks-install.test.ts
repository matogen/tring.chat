import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  HOOK_SPECS, hooksStatus, installHooks, installedEvents, uninstallHooks, withHooks, withoutHooks,
} from '../src/hooks-install.ts'

const theirs = {
  model: 'opus',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] }],
  },
}

describe('withHooks / withoutHooks', () => {
  it('adds every event and keeps what the user had', () => {
    const out = withHooks(theirs)
    expect(installedEvents(out)).toEqual(HOOK_SPECS.map((s) => s.event))
    expect(out['model']).toBe('opus')
    expect(out.hooks!['Stop']![0]).toEqual(theirs.hooks.Stop[0])
    expect(out.hooks!['PreToolUse']).toContainEqual(theirs.hooks.PreToolUse[0])
    expect(out.hooks!['PreToolUse']).toContainEqual({
      matcher: 'AskUserQuestion',
      hooks: [{ type: 'command', command: 'tring-hook PreToolUse', timeout: 3600 }],
    })
  })

  it('is the same after a second install', () => {
    expect(withHooks(withHooks(theirs))).toEqual(withHooks(theirs))
  })

  it('removes only its own entries', () => {
    expect(withoutHooks(withHooks(theirs))).toEqual(theirs)
    expect(withoutHooks(withHooks({}))).toEqual({})
  })
})

describe('settings file', () => {
  it('installs, reports and uninstalls, keeping a backup', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-hooks-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify(theirs))

    expect((await hooksStatus(file)).installed).toBe(false)
    await installHooks(file)
    expect((await hooksStatus(file)).installed).toBe(true)
    expect(JSON.parse(await readFile(`${file}.tring-backup`, 'utf8'))).toEqual(theirs)

    expect(await uninstallHooks(file)).toBe(true)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(theirs)
    expect(await uninstallHooks(file)).toBe(false)
  })

  it('creates a settings file that does not exist yet', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-hooks-'))
    const file = path.join(dir, 'nested', 'settings.json')
    await installHooks(file)
    expect((await hooksStatus(file)).installed).toBe(true)
  })

  it('refuses to overwrite a file that does not parse', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-hooks-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, '{ "model": "opus", ')
    await expect(installHooks(file)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('{ "model": "opus", ')
  })
})

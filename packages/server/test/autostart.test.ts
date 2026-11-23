import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MARKER, autostartContent, autostartFile, autostartOff, autostartOn, autostartStatus,
  ForeignAutostart, type AutostartEnv,
} from '../src/autostart.ts'

async function env(platform: NodeJS.Platform = 'linux') {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tring-home-'))
  const calls: string[] = []
  const e: AutostartEnv = {
    platform, home,
    env: { PATH: '/home/u/.local/bin:/usr/bin', XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData') },
    node: '/usr/bin/node', script: '/opt/tring/dist/tring.js',
    run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return true },
  }
  return { e, calls, home }
}
const exists = (p: string) => stat(p).then(() => true, () => false)

describe('autostart', () => {
  it('puts each platform in its own per-user place', async () => {
    const { e, home } = await env()
    expect(autostartFile(e)).toBe(path.join(home, '.config/systemd/user/tring.service'))
    expect(autostartFile({ ...e, platform: 'darwin' })).toBe(path.join(home, 'Library/LaunchAgents/chat.tring.daemon.plist'))
    expect(autostartFile({ ...e, platform: 'win32' })).toMatch(/Startup\\tring\.cmd$/)
  })

  it('writes a systemd unit that carries PATH and never opens a browser', async () => {
    const { e } = await env()
    const unit = autostartContent(e, ['--allow-origin', 'https://deck.example'])
    expect(unit).toContain(MARKER)
    expect(unit).toContain('Environment="PATH=/home/u/.local/bin:/usr/bin"')
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/tring/dist/tring.js" "--no-open" "--allow-origin" "https://deck.example"')
    expect(unit).toContain('WantedBy=default.target')
  })

  it('escapes what systemd would otherwise read as a specifier or quote', async () => {
    const { e } = await env()
    expect(autostartContent({ ...e, env: { PATH: '/a%b' } }, [])).toContain('Environment="PATH=/a%%b"')
    expect(autostartContent(e, ['x"y'])).toContain('"x\\"y"')
  })

  it('writes a LaunchAgent and a Startup .cmd elsewhere', async () => {
    const { e } = await env()
    const plist = autostartContent({ ...e, platform: 'darwin' }, [])
    expect(plist).toContain('<string>--no-open</string>')
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    const cmd = autostartContent({ ...e, platform: 'win32' }, [])
    expect(cmd).toContain(`rem ${MARKER}`)
    expect(cmd).toContain('start "tring" /min "/usr/bin/node" "/opt/tring/dist/tring.js" "--no-open"')
  })

  it('on writes the unit and enables it without starting a second daemon', async () => {
    const { e, calls } = await env()
    const st = await autostartOn(e)
    expect(st).toMatchObject({ present: true, ours: true })
    expect(await readFile(st.file, 'utf8')).toContain(MARKER)
    expect(calls).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable tring.service'])
  })

  it('off disables and removes only what it wrote', async () => {
    const { e, calls } = await env()
    expect(await autostartOff(e)).toBe(false)
    const st = await autostartOn(e)
    calls.length = 0
    expect(await autostartOff(e)).toBe(true)
    expect(await exists(st.file)).toBe(false)
    expect(calls[0]).toBe('systemctl --user disable tring.service')
  })

  it('never replaces or removes a unit someone wrote by hand', async () => {
    const { e } = await env()
    const file = autostartFile(e)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '[Service]\nExecStart=/my/own/tring\n')
    expect(await autostartStatus(e)).toMatchObject({ present: true, ours: false })
    await expect(autostartOn(e)).rejects.toBeInstanceOf(ForeignAutostart)
    await expect(autostartOff(e)).rejects.toBeInstanceOf(ForeignAutostart)
    expect(await readFile(file, 'utf8')).toBe('[Service]\nExecStart=/my/own/tring\n')
  })
})

/**
 * `tring autostart on|off|status`: start the daemon when the user logs in, so
 * a reboot brings every tile (and, with the hooks, every Claude conversation)
 * back without anyone running `tring` first.
 *
 * One file per platform, each the native per-user mechanism, so no admin
 * rights are needed and `off` is a delete:
 *   Linux   a systemd user unit, ~/.config/systemd/user/tring.service
 *   macOS   a LaunchAgent, ~/Library/LaunchAgents/chat.tring.daemon.plist
 *   Windows a .cmd in the Startup folder
 *
 * The PATH at install time is written into the file. A login service starts
 * with a bare PATH, and every session the daemon spawns inherits it: without
 * this, `claude`, node from a version manager and the user's tools would all
 * be missing from the tiles.
 *
 * Every file carries MARKER. A file without it is someone's own (a unit
 * written by hand, say) and is never replaced or removed.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const MARKER = 'written by tring autostart'
const LABEL = 'chat.tring.daemon'

export interface AutostartEnv {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  /** The node binary and the tring script it runs. */
  node: string
  script: string
  /** Runs a command, resolving whether it succeeded. Injected for tests. */
  run?: (cmd: string, args: string[]) => Promise<boolean>
}

export interface AutostartStatus {
  file: string
  /** A file exists at that path. */
  present: boolean
  /** It is one tring wrote. */
  ours: boolean
}

export function autostartFile(e: Pick<AutostartEnv, 'platform' | 'home' | 'env'>): string {
  if (e.platform === 'darwin') return path.join(e.home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
  if (e.platform === 'win32') {
    const appData = e.env['APPDATA'] ?? path.join(e.home, 'AppData', 'Roaming')
    return path.win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'tring.cmd')
  }
  const config = e.env['XDG_CONFIG_HOME'] ?? path.join(e.home, '.config')
  return path.join(config, 'systemd', 'user', 'tring.service')
}

/** systemd's own quoting: double quotes, with \, " and the % specifier escaped. */
const sdQuote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** cmd.exe has no escape inside quotes; a quote in a path is not a real case, so it is refused. */
const cmdQuote = (s: string): string => {
  if (/["%\r\n]/.test(s)) throw new Error(`cannot put ${JSON.stringify(s)} in a .cmd file`)
  return `"${s}"`
}

/**
 * The file's contents. `--no-open` always: at login there may be no browser
 * yet, and the user opens their own tab. Extra flags (`--allow-origin`,
 * `--port`) are passed through as given.
 */
export function autostartContent(e: AutostartEnv, flags: string[]): string {
  const argv = [e.node, e.script, '--no-open', ...flags]
  const PATH = e.env['PATH'] ?? ''
  if (e.platform === 'darwin') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MARKER} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(PATH)}</string></dict>
  <key>WorkingDirectory</key><string>${xml(e.home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`
  }
  if (e.platform === 'win32') {
    return [
      '@echo off',
      `rem ${MARKER}`,
      `set ${cmdQuote(`PATH=${PATH}`)}`,
      `cd /d ${cmdQuote(e.home)}`,
      `start "tring" /min ${argv.map(cmdQuote).join(' ')}`,
      '',
    ].join('\r\n')
  }
  return `# ${MARKER}
[Unit]
Description=tring terminal deck daemon
After=graphical-session.target

[Service]
Type=simple
Environment=${sdQuote(`PATH=${PATH}`)}
WorkingDirectory=${e.home}
ExecStart=${argv.map(sdQuote).join(' ')}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`
}

const defaultRun = (cmd: string, args: string[]): Promise<boolean> =>
  new Promise((resolve) => execFile(cmd, args, (err) => resolve(!err)))

export async function autostartStatus(e: AutostartEnv): Promise<AutostartStatus> {
  const file = autostartFile(e)
  try {
    const text = await readFile(file, 'utf8')
    return { file, present: true, ours: text.includes(MARKER) }
  } catch {
    return { file, present: false, ours: false }
  }
}

/** Thrown for a file tring did not write; the message says what to do. */
export class ForeignAutostart extends Error {}

export async function autostartOn(e: AutostartEnv, flags: string[] = []): Promise<AutostartStatus> {
  const st = await autostartStatus(e)
  if (st.present && !st.ours) {
    throw new ForeignAutostart(`${st.file} already exists and tring did not write it, so it was left alone.
  If it already starts tring at login there is nothing to do; otherwise move it aside and run this again.`)
  }
  await mkdir(path.dirname(st.file), { recursive: true })
  const tmp = `${st.file}.tring-${process.pid}`
  await writeFile(tmp, autostartContent(e, flags), 'utf8')
  await rename(tmp, st.file)
  const run = e.run ?? defaultRun
  // Enabled, not started: whoever runs this is usually running tring already,
  // and a second daemon would only fail on the port.
  if (e.platform === 'linux') {
    await run('systemctl', ['--user', 'daemon-reload'])
    if (!await run('systemctl', ['--user', 'enable', 'tring.service'])) {
      throw new Error(`wrote ${st.file}, but systemctl --user enable tring.service failed`)
    }
  }
  return { ...st, present: true, ours: true }
}

export async function autostartOff(e: AutostartEnv): Promise<boolean> {
  const st = await autostartStatus(e)
  if (!st.present) return false
  if (!st.ours) throw new ForeignAutostart(`${st.file} was not written by tring, so it was left alone.`)
  const run = e.run ?? defaultRun
  if (e.platform === 'linux') await run('systemctl', ['--user', 'disable', 'tring.service'])
  if (e.platform === 'darwin') await run('launchctl', ['bootout', `gui/${os.userInfo().uid}/${LABEL}`])
  await rm(st.file, { force: true })
  if (e.platform === 'linux') await run('systemctl', ['--user', 'daemon-reload'])
  return true
}

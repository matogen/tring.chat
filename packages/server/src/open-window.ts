import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'

/**
 * Opens the app in a chromeless browser window (spec §6).
 *
 * The window is the point, not convenience: in an `--app` window Chrome does
 * not reserve Ctrl+1..Ctrl+8 for tab switching, so slots 11-16 get their
 * natural keys, and there is no address bar or tab strip. It is also the
 * cheap two-thirds of what Electron would later provide.
 */

function isWsl(): boolean {
  if (process.env['WSL_DISTRO_NAME']) return true
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

/** Windows browsers, reached from WSL through /mnt/c. */
function wslCandidates(): string[] {
  const user = process.env['WSL_USER'] ?? ''
  const roots = ['/mnt/c/Program Files', '/mnt/c/Program Files (x86)']
  const paths = [
    ...roots.map((r) => `${r}/Google/Chrome/Application/chrome.exe`),
    ...roots.map((r) => `${r}/Microsoft/Edge/Application/msedge.exe`),
    ...roots.map((r) => `${r}/BraveSoftware/Brave-Browser/Application/brave.exe`),
  ]
  if (user) paths.push(`/mnt/c/Users/${user}/AppData/Local/Google/Chrome/Application/chrome.exe`)
  return paths
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p
  return null
}

export function openWindow(url: string): boolean {
  if (process.env['TRING_NO_OPEN']) return false

  const appFlag = `--app=${url}`
  let command: string
  let args: string[]

  if (isWsl()) {
    const exe = firstExisting(wslCandidates())
    if (!exe) return false
    // WSL2 mirrors listening ports onto the Windows loopback, so a Windows
    // browser reaches this daemon at the same 127.0.0.1 address.
    command = exe
    args = [appFlag]
  } else if (process.platform === 'darwin') {
    command = 'open'
    args = ['-na', 'Google Chrome', '--args', appFlag]
  } else if (process.platform === 'win32') {
    command = 'cmd'
    args = ['/c', 'start', '', 'chrome', appFlag]
  } else {
    const exe = firstExisting([
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    ])
    if (!exe) return false
    command = exe
    args = [appFlag]
  }

  try {
    // Detached: closing the window must not take the daemon with it, and
    // vice versa — the PTYs outlive any particular view of them.
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

export function describeFallback(url: string): string {
  return isWsl() || os.platform() === 'linux'
    ? `open ${url} in your browser`
    : `open ${url}`
}

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

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

/**
 * Whether the port answers yet from the side the browser is on.
 *
 * `unusable` is a probe that could not be run at all, which is a different
 * answer from `refused`: there is nothing to wait for, so the caller stops
 * waiting rather than retrying a spawn that will fail the same way again.
 */
export type Probe = 'reachable' | 'refused' | 'unusable'

/** Windows has shipped curl.exe since 1803. It is how we ask the other side. */
const WINDOWS_CURL = '/mnt/c/Windows/System32/curl.exe'

/** Long enough for the relay on a slow boot, short enough not to feel stuck. */
const RELAY_DEADLINE_MS = 8000
const RELAY_GAP_MS = 150

/**
 * Asks Windows whether it can reach the daemon.
 *
 * Only the origin is probed and never the link we are about to open, which
 * carries the bearer token: the probe has no use for it, and an argument
 * vector is readable by every other account on the machine. Any HTTP answer
 * at all means the relay is up — 403 and 404 are as good as 200 here, because
 * what is being tested is the connection and not the route.
 */
function reachableFromWindows(origin: string): Promise<Probe> {
  return new Promise((resolve) => {
    // -k because a --tls-cert deck is typically self-signed, and a certificate
    // this probe refused would read as a port that is not there.
    const probe = spawn(WINDOWS_CURL, [
      '-s', '-k', '-o', 'NUL', '--max-time', '2', origin,
    ], { stdio: 'ignore' })
    probe.on('close', (code) => resolve(code === 0 ? 'reachable' : 'refused'))
    probe.on('error', () => resolve('unusable'))
  })
}

/** The retry loop, with the probe handed in so a test can drive it. */
export async function awaitRelay(
  probe: () => Promise<Probe>,
  opts: { deadlineMs?: number; gapMs?: number } = {},
): Promise<Probe> {
  const deadline = Date.now() + (opts.deadlineMs ?? RELAY_DEADLINE_MS)
  for (;;) {
    const answer = await probe()
    if (answer !== 'refused') return answer
    if (Date.now() >= deadline) return 'refused'
    await delay(opts.gapMs ?? RELAY_GAP_MS)
  }
}

/**
 * Waits for the port to be reachable from the side the browser is on.
 *
 * WSL2 mirrors a listening socket onto the Windows loopback through a relay
 * that runs on the Windows side, and that relay is not instant: measured on
 * this machine, between half a second and one and a third after `listen`
 * returned. A Windows browser launched inside that gap is answered with
 * ERR_CONNECTION_REFUSED, so what the user sees on starting tring is Chrome's
 * error page for a moment, until Chrome's own auto-reload retries and the deck
 * replaces it. Nothing is broken by it and nothing in the log says it
 * happened, which is exactly why it is worth removing: it reads as a crash.
 *
 * Nowhere else pays for this. A native browser talks to the socket the listen
 * callback has already opened, so only WSL waits, and only until the first
 * probe comes back.
 */
async function waitForWindowsRelay(url: string): Promise<void> {
  if (!existsSync(WINDOWS_CURL)) return
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return
  }
  // Whatever comes back, the caller opens the window next. A relay that never
  // appears — localhostForwarding turned off, a host reached by IP instead —
  // is a reason to stop waiting, not a reason to open nothing.
  await awaitRelay(() => reachableFromWindows(origin))
}

export async function openWindow(url: string): Promise<boolean> {
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
    const local = process.env['LOCALAPPDATA'] ?? ''
    const exe = firstExisting([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ...(local ? [`${local}\\Google\\Chrome\\Application\\chrome.exe`] : []),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ])
    // Spawning the exe directly rather than `start chrome`, so a missing
    // browser is detectable here instead of failing silently inside cmd.
    if (!exe) return false
    command = exe
    args = [appFlag]
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

  // After the browser is found, so a machine with none says so at once
  // instead of waiting on a relay it has no use for.
  if (isWsl()) await waitForWindowsRelay(url)

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

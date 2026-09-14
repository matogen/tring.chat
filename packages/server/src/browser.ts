import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { BrowserContext, CDPSession, Page } from 'playwright-core'
import { BrowserControl } from '@tring/shared/browser-control'
import {
  checkNavigation, isPromptable, type NavigationPolicy,
} from '@tring/shared/browser-policy'
import type {
  BrowserCapability, BrowserInfo, BrowserInputEvent, BrowserNavigation,
} from '@tring/shared/protocol'

/**
 * Playwright lifecycle and the attached page (spec §4.7).
 *
 * Everything here is behind a lazy `import()`. A user who never enables browser
 * agents never loads Playwright, and a machine without Chromium reports
 * `unavailable` rather than failing at startup — the daemon's job is serving
 * terminals and that must not depend on a browser being present.
 */

/** Thumbnail frames: small enough that sixteen of them stay uninteresting. */
const THUMB_WIDTH = 320
const THUMB_HEIGHT = 200
const THUMB_QUALITY = 40
/** A focused pane is being looked at, so it gets a better picture. */
const FOCUS_QUALITY = 60

/** The page is given a moment to settle before a navigation counts as finished. */
const SETTLE_MS = 400

/**
 * Fixed, and not tied to the pane's size.
 *
 * Resizing the viewport whenever the divider moves would reflow the page under
 * an agent that is mid-action, and make a selector that resolved a moment ago
 * resolve differently. The pane letterboxes instead, and maps input back
 * through the scale.
 */
const VIEWPORT = { width: 1280, height: 800 }

type Chromium = typeof import('playwright-core')['chromium']

/**
 * Resolved by name in a variable so the bundler leaves it alone, and awaited
 * only when someone has asked for a browser.
 */
async function chromium(): Promise<Chromium> {
  const specifier = 'playwright-core'
  const pw = (await import(specifier)) as typeof import('playwright-core')
  return pw.chromium
}

/** Where Playwright keeps downloaded browsers, per platform. */
function browsersPath(): string {
  const override = process.env['PLAYWRIGHT_BROWSERS_PATH']
  if (override) return override
  const home = homedir()
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright')
  if (process.platform === 'win32') {
    return path.join(process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local'), 'ms-playwright')
  }
  return path.join(home, '.cache', 'ms-playwright')
}

/** Layouts Playwright has shipped; the first that exists wins. */
const CHROME_BINARIES = [
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-win/chrome.exe',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
]

/**
 * Whether a usable Chromium is on disk — **without importing Playwright.**
 *
 * The obvious implementation asks `chromium.executablePath()`, but loading
 * `playwright-core` costs ~400ms, and this runs at every daemon start. A user
 * who never enables browser agents would pay it every time, which is precisely
 * what §6 says must not happen. So the cache directory is inspected directly.
 *
 * Reaching into another package's on-disk layout is a real cost, and it is
 * bounded on purpose: both ways of being wrong are recoverable. A false
 * negative offers a download the installer then completes in seconds, because
 * it is idempotent. A false positive fails at launch and reports it. Neither
 * breaks a daemon that is only serving terminals.
 *
 * (`executablePath()` would not have been enough on its own either: it answers
 * with a path whether or not anything is there.)
 */
export async function isChromiumInstalled(): Promise<boolean> {
  try {
    const root = browsersPath()
    const dirs = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith('chromium-'))
    for (const dir of dirs) {
      for (const rel of CHROME_BINARIES) {
        if (existsSync(path.join(root, dir.name, rel))) return true
      }
    }
  } catch {
    // No cache directory at all, which is the common "never installed" case.
  }
  return false
}

/**
 * Composes the installation fact with the project's setting (spec §5.7).
 *
 * Three states because the middle one is real: "installed but switched off"
 * needs a checkbox and "not installed" needs a download button, and a single
 * boolean cannot ask for either.
 */
export function capabilityFor(installed: boolean, enabled: boolean): BrowserCapability {
  if (!installed) return 'unavailable'
  return enabled ? 'on' : 'off'
}

/** Matches playwright's own progress line: `|███| 42% of 148.7 MiB`. */
const PROGRESS = /(\d+)%\s+of\s+([\d.]+)\s*([KMG]i?B)/i
const UNITS: Record<string, number> = {
  kb: 1e3, kib: 1024, mb: 1e6, mib: 1024 ** 2, gb: 1e9, gib: 1024 ** 3,
}

/**
 * Fetches Chromium by running playwright-core's own installer.
 *
 * Shelling out to the CLI rather than calling an internal: Playwright exposes
 * no public download API, and reaching into its internals is how this breaks on
 * a patch release. The progress line is parsed best-effort — a version that
 * words it differently costs a progress bar, not the download.
 */
export async function installChromium(
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  const { createRequire } = await import('node:module')
  const { spawn } = await import('node:child_process')
  const require = createRequire(import.meta.url)
  const cli = require.resolve('playwright-core/cli.js')

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const read = (chunk: Buffer): void => {
      const m = PROGRESS.exec(chunk.toString())
      if (!m) return
      const total = Number(m[2]) * (UNITS[m[3]!.toLowerCase()] ?? 1)
      onProgress(Math.round((Number(m[1]) / 100) * total), Math.round(total))
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`playwright install exited with ${code}`))
    })
  })
}

export interface BrowserHostOptions {
  /** Profiles live under here, one directory per project. */
  profileRoot: string
  /** Read per navigation, so an allowlist edit applies without a reattach. */
  policy: (projectId: string) => NavigationPolicy
}

/**
 * One persistent context per **project**, one page per session.
 *
 * Not one context per session, which the design originally assumed: Playwright
 * offers either isolated contexts (`newContext`, cookies gone on close) or a
 * persistent profile (`launchPersistentContext`, one context per directory),
 * and per-project persistence is the half worth having. Logging into a staging
 * environment once and finding every agent in that repo already authenticated
 * is the point; isolating agents in the same project from each other would mean
 * logging in once per agent, which is the opposite of the point. Pages inside
 * the context are still independent, so two agents do not share a viewport.
 *
 * Projects remain isolated from each other, which is the boundary that matters:
 * different repositories, different credentials.
 */
export class BrowserHost {
  private readonly contexts = new Map<string, Promise<BrowserContext>>()
  private readonly attached = new Map<string, Set<AttachedBrowser>>()

  constructor(private readonly opts: BrowserHostOptions) {}

  async attach(projectId: string, sessionId: string, url?: string): Promise<AttachedBrowser> {
    const context = await this.contextFor(projectId)
    const page = await context.newPage()
    const browser = new AttachedBrowser(
      sessionId,
      page,
      () => this.opts.policy(projectId),
    )
    await browser.start(url)

    let set = this.attached.get(projectId)
    if (!set) this.attached.set(projectId, (set = new Set()))
    set.add(browser)
    browser.onClosed = () => void this.forget(projectId, browser)
    return browser
  }

  private async forget(projectId: string, browser: AttachedBrowser): Promise<void> {
    const set = this.attached.get(projectId)
    if (!set) return
    set.delete(browser)
    if (set.size > 0) return
    // The project's last page went away, so its browser process should too.
    this.attached.delete(projectId)
    const pending = this.contexts.get(projectId)
    this.contexts.delete(projectId)
    try {
      await (await pending)?.close()
    } catch {
      // Already gone, or never opened.
    }
  }

  private contextFor(projectId: string): Promise<BrowserContext> {
    const existing = this.contexts.get(projectId)
    if (existing) return existing
    const opening = this.launch(projectId)
    this.contexts.set(projectId, opening)
    // A failed launch must not be cached as the project's context forever.
    opening.catch(() => this.contexts.delete(projectId))
    return opening
  }

  private async launch(projectId: string): Promise<BrowserContext> {
    const dir = path.join(this.opts.profileRoot, projectId, 'browser')
    await mkdir(dir, { recursive: true })
    return await (await chromium()).launchPersistentContext(dir, {
      viewport: { ...VIEWPORT },
      // An agent that can save files has a second filesystem surface with none
      // of the daemon's path checks in front of it (spec §4.7).
      acceptDownloads: false,
    })
  }

  async dispose(): Promise<void> {
    const closing = [...this.contexts.values()].map(async (pending) => {
      try {
        await (await pending).close()
      } catch {
        // Nothing useful to do while shutting down.
      }
    })
    this.contexts.clear()
    this.attached.clear()
    await Promise.all(closing)
  }
}

export type BrowserActivity = 'start' | 'end' | 'blocked'

/**
 * One page, its screencast, and the control wheel in front of it.
 *
 * Deliberately knows nothing about ActivityTracker: it reports activity and the
 * session decides what that means for its tile, so the browser half stays
 * testable and the status rules stay in one place (spec §4.2).
 */
export class AttachedBrowser {
  readonly control: BrowserControl

  onFrame: ((jpeg: Buffer) => void) | null = null
  onChange: (() => void) | null = null
  onPrompt: ((url: string) => void) | null = null
  onActivity: ((kind: BrowserActivity) => void) | null = null
  onClosed: (() => void) | null = null

  private cdp: CDPSession | null = null
  private title: string | null = null
  private loading = false
  private blockedOn: string | null = null
  private settle: NodeJS.Timeout | null = null
  private width = THUMB_WIDTH
  private height = THUMB_HEIGHT
  private focused = false
  private disposed = false

  constructor(
    readonly sessionId: string,
    private readonly page: Page,
    private readonly policy: () => NavigationPolicy,
  ) {
    this.control = new BrowserControl(Date.now())
  }

  async start(url?: string): Promise<void> {
    await this.guardNavigation()

    this.page.on('framenavigated', (frame) => {
      if (frame !== this.page.mainFrame()) return
      this.began()
    })
    this.page.on('load', () => this.settled())
    this.page.on('domcontentloaded', () => this.settled())
    this.page.on('close', () => {
      this.disposed = true
      this.onClosed?.()
      this.onChange?.()
    })
    this.page.on('crash', () => {
      this.blockedOn = 'the page crashed'
      this.onActivity?.('blocked')
      this.onChange?.()
    })
    // A dialog stops the page dead and no agent tool can clear it. That is the
    // clearest "a human is needed here" signal a browser produces.
    this.page.on('dialog', (dialog) => {
      this.blockedOn = `${dialog.type()}: ${dialog.message()}`.slice(0, 200)
      this.onActivity?.('blocked')
      this.onChange?.()
    })

    await this.startScreencast()
    if (url) await this.navigate(url)
  }

  info(): BrowserInfo {
    return {
      url: this.safeUrl(),
      title: this.title,
      control: this.control.holder,
      loading: this.loading,
      blockedOn: this.blockedOn,
      viewport: this.page.viewportSize() ?? { width: VIEWPORT.width, height: VIEWPORT.height },
    }
  }

  /**
   * Every navigation, including redirects and sub-frame loads.
   *
   * A first-hop-only check is not a policy: an allowed site can redirect to one
   * that is not, and an iframe is a navigation the user never asked for. Only
   * main-frame refusals are offered to the user, because prompting for every
   * third-party iframe would train them to click allow.
   */
  private async guardNavigation(): Promise<void> {
    await this.page.route('**/*', async (route) => {
      const request = route.request()
      let navigation = false
      let main = false
      try {
        navigation = request.isNavigationRequest()
        main = request.frame() === this.page.mainFrame()
      } catch {
        // A frame that has already detached; let it through to fail normally.
      }
      if (!navigation) return await route.continue()

      const verdict = checkNavigation(request.url(), this.policy())
      if (verdict.ok) return await route.continue()
      if (main && isPromptable(verdict)) this.onPrompt?.(request.url())
      try {
        await route.abort('blockedbyclient')
      } catch {
        // The route may already be resolved if the page navigated away.
      }
    })
  }

  async navigate(to: BrowserNavigation): Promise<void> {
    if (this.disposed) return
    this.blockedOn = null
    try {
      if (to === 'back') await this.page.goBack()
      else if (to === 'forward') await this.page.goForward()
      else if (to === 'reload') await this.page.reload()
      else await this.page.goto(to)
    } catch {
      // A refused or failed navigation leaves the page where it was; the
      // prompt or the error is already the user-visible part.
    }
    this.onChange?.()
  }

  /** The human touched the page, which is also how they take the wheel. */
  async input(event: BrowserInputEvent): Promise<void> {
    if (this.disposed) return
    if (this.control.grab(Date.now())) this.onChange?.()
    await this.dispatch(event)
  }

  grab(): void {
    if (this.control.grab(Date.now())) this.onChange?.()
  }

  /** Returns the parked agent actions, oldest first, for the caller to resume. */
  release(): string[] {
    const resumed = this.control.release(Date.now())
    this.onChange?.()
    return resumed
  }

  /**
   * A focused pane is looked at, a thumbnail is glanced at. One screencast per
   * page means the size is a property of the best current viewer rather than
   * something each of them chooses.
   */
  async setViewport(width: number, height: number, focused: boolean): Promise<void> {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    if (w === this.width && h === this.height && focused === this.focused) return
    this.width = w
    this.height = h
    this.focused = focused
    await this.startScreencast()
  }

  private async startScreencast(): Promise<void> {
    if (this.disposed) return
    try {
      if (!this.cdp) {
        this.cdp = await this.page.context().newCDPSession(this.page)
        this.cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => {
          this.onFrame?.(Buffer.from(frame.data, 'base64'))
          // Acked before the next frame is produced, so a slow client throttles
          // the page rather than queueing frames into memory.
          this.cdp?.send('Page.screencastFrameAck', { sessionId: frame.sessionId })
            .catch(() => {})
        })
      } else {
        await this.cdp.send('Page.stopScreencast').catch(() => {})
      }
      await this.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.focused ? FOCUS_QUALITY : THUMB_QUALITY,
        maxWidth: this.width,
        maxHeight: this.height,
        everyNthFrame: 1,
      })
    } catch {
      // No screencast means no pixels, which is a degraded tile rather than a
      // broken session — the agent can still drive the page.
    }
  }

  private async dispatch(event: BrowserInputEvent): Promise<void> {
    const cdp = this.cdp
    if (!cdp) return
    try {
      if (event.kind === 'mouse') {
        await cdp.send('Input.dispatchMouseEvent', {
          type: event.action === 'move' ? 'mouseMoved'
            : event.action === 'down' ? 'mousePressed' : 'mouseReleased',
          x: event.x,
          y: event.y,
          button: event.button ?? 'left',
          clickCount: event.clicks ?? (event.action === 'move' ? 0 : 1),
        })
      } else if (event.kind === 'wheel') {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: event.x, y: event.y, deltaX: event.dx, deltaY: event.dy,
        })
      } else {
        await cdp.send('Input.dispatchKeyEvent', {
          type: event.text ? 'keyDown' : event.action === 'down' ? 'rawKeyDown' : 'keyUp',
          key: event.key,
          code: event.code,
          ...(event.text ? { text: event.text } : {}),
          modifiers:
            (event.alt ? 1 : 0) | (event.ctrl ? 2 : 0) |
            (event.meta ? 4 : 0) | (event.shift ? 8 : 0),
        })
      }
    } catch {
      // The page may have navigated or closed between event and dispatch.
    }
  }

  private began(): void {
    this.loading = true
    this.blockedOn = null
    this.onActivity?.('start')
    this.onChange?.()
  }

  /**
   * Debounced: `domcontentloaded` and `load` both fire, and a page that is
   * still fetching is not finished. This is the browser's equivalent of the
   * idle gate in §4.2 and is inferred the same way, so it is not `notable`.
   */
  private settled(): void {
    if (this.settle) clearTimeout(this.settle)
    this.settle = setTimeout(() => {
      this.loading = false
      void this.readTitle()
      this.onActivity?.('end')
      this.onChange?.()
    }, SETTLE_MS)
    this.settle.unref?.()
  }

  private async readTitle(): Promise<void> {
    try {
      this.title = await this.page.title()
    } catch {
      // Navigated away mid-read; the next settle will pick it up.
    }
  }

  private safeUrl(): string {
    try {
      return this.page.url()
    } catch {
      return 'about:blank'
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.settle) clearTimeout(this.settle)
    this.settle = null
    this.onFrame = null
    try {
      await this.cdp?.send('Page.stopScreencast').catch(() => {})
      await this.page.close()
    } catch {
      // Already closed.
    }
    this.onClosed?.()
  }
}

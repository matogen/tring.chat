import { describe, it, expect, afterEach } from 'vitest'
import { BrowserControl } from '@tring/shared/browser-control'
import type { BrowserInfo } from '@tring/shared/protocol'
import type { AttachedBrowser, BrowserActivity } from '../src/browser.ts'
import { Session } from '../src/session.ts'

/**
 * Attachment without Playwright.
 *
 * The rules worth pinning here are about what attaching does to the *session*,
 * and none of them need a real browser: a stub with the same surface exercises
 * every path the daemon takes. The one real-Chromium test lives behind a flag
 * (spec §7).
 */
class StubBrowser {
  readonly control = new BrowserControl(0)
  onFrame: ((jpeg: Buffer) => void) | null = null
  onChange: (() => void) | null = null
  onPrompt: ((url: string) => void) | null = null
  onActivity: ((kind: BrowserActivity) => void) | null = null
  onClosed: (() => void) | null = null
  disposed = false
  url = 'https://example.test/'

  info(): BrowserInfo {
    return {
      url: this.url,
      title: 'stub',
      control: this.control.holder,
      loading: false,
      blockedOn: null,
      viewport: { width: 1280, height: 800 },
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }

  /** Drive the session's tracker the way a real page would. */
  fire(kind: BrowserActivity): void {
    this.onActivity?.(kind)
  }
}

const asBrowser = (s: StubBrowser): AttachedBrowser => s as unknown as AttachedBrowser

const live: Session[] = []
afterEach(() => { for (const s of live.splice(0)) s.dispose() })

function make(idleMs = 200): Session {
  const s = new Session({
    id: 's1', projectId: 'p1', projectName: 'demo', slot: 1,
    cwd: process.cwd(), command: null,
    url: 'http://127.0.0.1:7331', token: null, idleMs, scrollback: 100,
  })
  live.push(s)
  return s
}

async function waitFor(fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('timed out waiting for condition')
}

describe('attaching a browser', () => {
  it('reports no browser until one is attached', () => {
    expect(make().info().browser).toBeNull()
  })

  it('surfaces the attached page on info()', () => {
    const s = make()
    s.attachBrowser(asBrowser(new StubBrowser()))
    expect(s.info().browser).toMatchObject({ url: 'https://example.test/', control: 'agent' })
  })

  /**
   * The claim the whole design rests on (spec §9.13). If attaching or detaching
   * ever kills the PTY, "Terminal or Browser Agent on every tile" stops being
   * offerable on a tile that is working, and the feature loses its point.
   */
  it('leaves the shell, its process and its scrollback untouched', async () => {
    const s = make()
    s.write('echo tring-before-attach\n')
    await waitFor(() => s.serialize().includes('tring-before-attach'))

    const stub = new StubBrowser()
    s.attachBrowser(asBrowser(stub))
    expect(s.serialize()).toContain('tring-before-attach')

    // The shell is still a shell: it takes input and answers.
    s.write('echo tring-while-attached\n')
    await waitFor(() => s.serialize().includes('tring-while-attached'))

    s.detachBrowser()
    expect(stub.disposed).toBe(true)
    expect(s.info().browser).toBeNull()
    // Scrollback from before *and* during the attachment survives detaching.
    expect(s.serialize()).toContain('tring-before-attach')
    expect(s.serialize()).toContain('tring-while-attached')

    s.write('echo tring-after-detach\n')
    await waitFor(() => s.serialize().includes('tring-after-detach'))
    expect(s.tracker.status).not.toBe('exited')
  })

  it('attaching twice replaces the first page rather than leaking it', () => {
    const s = make()
    const first = new StubBrowser()
    s.attachBrowser(asBrowser(first))
    s.attachBrowser(asBrowser(new StubBrowser()))
    expect(first.disposed).toBe(true)
  })

  it('disposing the session takes the page with it', () => {
    const s = make()
    const stub = new StubBrowser()
    s.attachBrowser(asBrowser(stub))
    s.dispose()
    expect(stub.disposed).toBe(true)
  })

  it('forwards frames and prompts to the session listeners', () => {
    const s = make()
    const stub = new StubBrowser()
    const frames: Buffer[] = []
    const prompts: string[] = []
    s.onBrowserFrame = (f) => frames.push(f)
    s.onBrowserPrompt = (u) => prompts.push(u)
    s.attachBrowser(asBrowser(stub))

    stub.onFrame?.(Buffer.from('jpeg'))
    stub.onPrompt?.('https://blocked.test/')
    expect(frames).toHaveLength(1)
    expect(prompts).toEqual(['https://blocked.test/'])
  })

  /**
   * A detached page must hold no route back into the session. Detaching clears
   * the listeners on the browser rather than gating on a flag inside them, so a
   * late frame from a page that is still closing reaches nothing.
   */
  it('leaves a detached page no way back into the session', () => {
    const s = make()
    const stub = new StubBrowser()
    let frames = 0
    s.onBrowserFrame = () => { frames++ }
    s.attachBrowser(asBrowser(stub))

    stub.onFrame?.(Buffer.from('jpeg'))
    expect(frames).toBe(1)

    s.detachBrowser()
    expect(stub.onFrame).toBeNull()
    expect(stub.onActivity).toBeNull()
    expect(stub.onPrompt).toBeNull()

    stub.onFrame?.(Buffer.from('jpeg'))
    stub.fire('blocked')
    expect(frames).toBe(1)
  })
})

describe('browser activity drives the tile', () => {
  it('a navigation makes the slot busy', () => {
    const s = make()
    const stub = new StubBrowser()
    s.attachBrowser(asBrowser(stub))
    stub.fire('start')
    expect(s.tracker.status).toBe('busy')
  })

  /**
   * A page that finished loading must be able to end a busy session even
   * though the PTY produced no output — `tick` gates on the byte stream, which
   * a session working only in its browser never touches.
   */
  it('settling ends it without any PTY output', () => {
    const s = make()
    const stub = new StubBrowser()
    s.attachBrowser(asBrowser(stub))
    stub.fire('start')
    stub.fire('end')
    expect(s.tracker.status).toBe('done')
  })

  it('an ordinary page load does not ring', () => {
    const s = make()
    const stub = new StubBrowser()
    s.attachBrowser(asBrowser(stub))
    stub.fire('start')
    stub.fire('end')
    // Inferred, and quick: green, but not worth interrupting anyone for.
    expect(s.tracker.notable).toBe(false)
  })

  /**
   * The case the feature exists for: an agent parked on a login form is an
   * explicit "a human is needed here", and rings like a Stop hook does.
   */
  it('being blocked rings', () => {
    const s = make()
    const stub = new StubBrowser()
    s.attachBrowser(asBrowser(stub))
    stub.fire('start')
    stub.fire('blocked')
    expect(s.tracker.status).toBe('done')
    expect(s.tracker.notable).toBe(true)
  })
})

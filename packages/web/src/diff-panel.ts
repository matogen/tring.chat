import type { DiffFile, DiffResult } from '@tring/shared/protocol'
import { clampWidth, MIN_WIDTH, patchRows } from './diff-rows.ts'
import { api } from './ws-client.ts'

const POLL_MS = 2000
const STORAGE_KEY = 'tring.diffPanel'
const DEFAULT_WIDTH = 420

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement('div')
  d.className = cls
  if (text !== undefined) d.textContent = text
  return d
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span')
  s.className = cls
  s.textContent = text
  return s
}

/** Per browser, like the ring size: a display choice, not session state. */
function load(): { width: number; open: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { width?: unknown; open?: unknown }
    return {
      width: typeof v.width === 'number' ? v.width : DEFAULT_WIDTH,
      open: v.open === true,
    }
  } catch {
    return { width: DEFAULT_WIDTH, open: false }
  }
}

/**
 * The focused session's uncommitted changes, beside the centre terminal.
 *
 * Every string from the repository — paths and file content alike — goes in
 * through textContent. A diff is attacker-shaped text by nature (anything a
 * cloned repo contains), and this page holds the token to a shell.
 */
export class DiffPanel {
  private readonly el = div('diff-panel')
  private readonly handle = div('diff-handle')
  private readonly title = span('diff-title', '')
  private readonly plus = span('diff-plus', '')
  private readonly minus = span('diff-minus', '')
  private readonly scroll = div('diff-scroll')
  private sessionId: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight = false
  private last = ''
  private width: number
  private opened: boolean

  /**
   * Builds its DOM into `cell` and restores the saved width and open state,
   * but never calls `onLayout` from here: main.ts constructs this before the
   * terminal and the socket exist, and the terminal's own first fit then sees
   * the panel already in place.
   */
  constructor(private readonly cell: HTMLElement, private readonly onLayout: () => void) {
    const head = div('diff-head')
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'diff-close'
    close.textContent = '✕'
    close.title = 'Close diff viewer'
    close.onclick = () => this.close()
    head.append(this.title, this.plus, this.minus, close)
    this.el.append(head, this.scroll)
    cell.append(this.handle, this.el)

    const saved = load()
    this.width = Math.max(MIN_WIDTH, saved.width)
    this.opened = saved.open
    this.bindResize()
    this.paint()
    if (this.opened) this.startPolling()
  }

  get isOpen(): boolean {
    return this.opened
  }

  open(): void {
    if (this.opened) return
    this.opened = true
    this.paint()
    this.save()
    this.onLayout()
    this.startPolling()
  }

  close(): void {
    if (!this.opened) return
    this.opened = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.paint()
    this.save()
    this.onLayout()
  }

  toggle(): void {
    if (this.opened) this.close()
    else this.open()
  }

  /** Follows the centre terminal; a response for the previous one is dropped. */
  setSession(id: string | null): void {
    if (id === this.sessionId) return
    this.sessionId = id
    this.last = ''
    this.note(id ? 'loading…' : 'no session')
    if (this.opened) void this.tick()
  }

  private paint(): void {
    this.el.hidden = !this.opened
    this.handle.hidden = !this.opened
    this.el.style.width = `${this.width}px`
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: this.width, open: this.opened }))
    } catch {
      // Still applies for this page load.
    }
  }

  private startPolling(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => void this.tick(), POLL_MS)
    void this.tick()
  }

  private async tick(): Promise<void> {
    const id = this.sessionId
    if (!id || this.inflight || !this.opened) return
    this.inflight = true
    try {
      const d = await api<DiffResult>(`/api/sessions/${encodeURIComponent(id)}/diff`)
      if (id !== this.sessionId || !this.opened) return
      const key = JSON.stringify(d)
      if (key === this.last) return
      this.last = key
      this.render(d)
    } catch (err) {
      if (id !== this.sessionId) return
      this.last = ''
      this.note((err as Error).message)
    } finally {
      this.inflight = false
    }
  }

  private note(text: string): void {
    this.title.textContent = ''
    this.plus.textContent = ''
    this.minus.textContent = ''
    this.scroll.replaceChildren(div('diff-note', text))
  }

  private render(d: DiffResult): void {
    if ('error' in d) return this.note(d.error)
    const { files } = d
    let added = 0
    let removed = 0
    for (const f of files) { added += f.added; removed += f.removed }
    this.title.textContent = `${files.length} file${files.length === 1 ? '' : 's'} changed`
    this.plus.textContent = `+${added}`
    this.minus.textContent = `-${removed}`
    if (files.length === 0) {
      this.scroll.replaceChildren(div('diff-note', 'no uncommitted changes'))
      return
    }

    const list = div('diff-files')
    const body = div('diff-body')
    for (const f of files) {
      const section = this.fileSection(f)
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'diff-file-row'
      row.append(span('path', f.path), span('diff-plus', `+${f.added}`), span('diff-minus', `-${f.removed}`))
      row.onclick = () => section.scrollIntoView({ block: 'start' })
      list.append(row)
      body.append(section)
    }
    if (d.truncated) list.append(div('diff-note', 'some diffs are over the 1 MB limit and not shown'))

    // Polling redraws on every change; keep the reader where they were.
    const top = this.scroll.scrollTop
    this.scroll.replaceChildren(list, body)
    this.scroll.scrollTop = top
  }

  private fileSection(f: DiffFile): HTMLElement {
    const section = div('diff-file')
    section.append(div('diff-file-head', f.path))
    if (f.note) {
      section.append(div('diff-note', f.note))
      return section
    }
    for (const r of patchRows(f.patch)) {
      if (r.kind === 'hunk') {
        section.append(div('dl dl-hunk', r.text))
        continue
      }
      const line = div(`dl dl-${r.kind}`)
      line.append(
        span('ln', r.old === null ? '' : String(r.old)),
        span('ln', r.new === null ? '' : String(r.new)),
        span('tx', r.text),
      )
      section.append(line)
    }
    return section
  }

  /**
   * Drag the handle to resize. The terminal is refitted once, on release:
   * fitting on every move would send the PTY a resize per pixel.
   */
  private bindResize(): void {
    let right = 0
    this.handle.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      right = this.el.getBoundingClientRect().right
      this.handle.setPointerCapture(e.pointerId)
      this.handle.classList.add('dragging')
    })
    this.handle.addEventListener('pointermove', (e) => {
      if (!this.handle.hasPointerCapture(e.pointerId)) return
      this.width = clampWidth(right - e.clientX, this.cell.clientWidth)
      this.el.style.width = `${this.width}px`
    })
    const end = (e: PointerEvent) => {
      if (!this.handle.hasPointerCapture(e.pointerId)) return
      this.handle.releasePointerCapture(e.pointerId)
      this.handle.classList.remove('dragging')
      this.save()
      this.onLayout()
    }
    this.handle.addEventListener('pointerup', end)
    this.handle.addEventListener('pointercancel', end)
  }
}

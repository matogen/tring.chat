import type { AgentInfo, AutoDecision, InboxDecision, InboxItem } from '@tring/shared/protocol'
import { age, answersFor, describe } from './inbox-view.ts'
import { renderMarkdown } from './markdown.ts'
import { clampWidth } from './diff-rows.ts'

const WIDTH_KEY = 'tring.inboxWidth'
/** Beside the agent: wide enough for a card's buttons on one row. */
const DEFAULT_WIDTH = 420

const STORAGE_KEY = 'tring.orchestrator'
/**
 * A card that moves under the keyboard on its own — the one you were on was
 * answered elsewhere, or a new one arrived first in line — ignores keys for
 * this long, so a keystroke meant for the old card never lands on the new one.
 */
const ARM_MS = 350

export interface SessionLabel {
  name: string
  slot: number
  color: string | null
  /** True when the session is in another project than the one on screen. */
  elsewhere: string | null
}

export interface InboxCallbacks {
  label: (sessionId: string) => SessionLabel | null
  onAnswer: (itemId: string, decision: InboxDecision, extra?: { answers?: Record<string, string>; message?: string }) => void
  onReply: (itemId: string, text: string) => void
  onOpen: (sessionId: string) => void
  /** Hooks are what fill the inbox; null while unknown. */
  hooks: () => Promise<{ installed: boolean; path: string }>
  installHooks: () => Promise<void>
  /** The supervisor that approves routine permission prompts. */
  onAuto: (enabled: boolean) => void
  /** The orchestrator agent: on or off, or start its Claude again. */
  onAgent: (change: { enabled: boolean } | { restart: 'resume' | 'fresh' }) => void
  /** The column beside the agent was resized: the terminal must refit. */
  onLayout?: () => void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function button(label: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el('button', `btn ${cls}`, label)
  b.type = 'button'
  if (title) b.title = title
  b.onclick = (e) => { e.stopPropagation(); onClick() }
  return b
}

/**
 * A card body that is taller than its box gets a "Show all" that lets it grow
 * to its full height, and "Show less" to fold it again. Measured once it is on
 * screen, since only then does it have a height; re-measured when the panel
 * changes width, which changes how much the text wraps.
 */
function expandable(body: HTMLElement): [HTMLElement, HTMLButtonElement] {
  const toggle = el('button', 'card-more', 'Show all')
  toggle.type = 'button'
  toggle.hidden = true
  const measure = (): void => {
    if (body.classList.contains('expanded')) return
    toggle.hidden = body.scrollHeight <= body.clientHeight + 2
  }
  toggle.onclick = (e) => {
    e.stopPropagation()
    const open = body.classList.toggle('expanded')
    toggle.textContent = open ? 'Show less' : 'Show all'
    if (!open) measure()
  }
  requestAnimationFrame(measure)
  new ResizeObserver(measure).observe(body)
  return [body, toggle]
}

interface Card {
  item: InboxItem
  root: HTMLElement
  /** Only ever called with a fresh item for the same id, to refresh labels. */
  paintHeader: () => void
  key: (e: KeyboardEvent) => boolean
}

/**
 * Orchestrator mode: every prompt the agents are waiting on, in the centre.
 *
 * Laid over the terminal rather than replacing it, so the WebGL canvas is
 * never detached and comes back exactly as it was. Cards are kept by id across
 * updates — rebuilding them on every broadcast would wipe a half-typed reply
 * or a question with two of three answers picked.
 */
export class InboxPanel {
  readonly el = el('div', 'inbox')
  private readonly list = el('div', 'inbox-list')
  private readonly empty = el('div', 'inbox-empty')
  private readonly banner = el('div', 'inbox-banner')
  private readonly autoBox = el('input')
  private readonly agentBox = el('input')
  /** Says why the agent is not running, with the way to start it again. */
  private readonly agentNote = el('div', 'inbox-banner agent-note')
  /** Drags the column beside the agent wider or narrower, like the diff panel's. */
  private readonly handle = el('div', 'inbox-handle')
  private width = InboxPanel.savedWidth()
  private readonly history = el('details', 'inbox-history')
  private readonly historyList = el('ol', 'inbox-history-list')
  private readonly historySummary = el('summary')
  private readonly cards = new Map<string, Card>()
  private items: InboxItem[] = []
  private shown = false
  private armedAt = 0
  private ticker: ReturnType<typeof setInterval> | null = null

  constructor(private readonly cell: HTMLElement, private readonly cb: InboxCallbacks) {
    this.el.hidden = true
    this.el.tabIndex = -1
    const head = el('div', 'inbox-head')
    head.append(el('span', 'inbox-title', 'Orchestrator'), el('span', 'inbox-hint',
      'a allow · d deny · t answer in terminal · o open · 1–9 pick · ↑↓ move · Ctrl+Space then o to leave'))
    // The supervisor's switch. Off by default; what it decides is listed
    // below so an approval made for you is never invisible.
    this.autoBox.type = 'checkbox'
    this.autoBox.onchange = () => this.cb.onAuto(this.autoBox.checked)
    const autoLabel = el('label', 'inbox-auto')
    autoLabel.title = 'A small Claude model approves routine permission prompts (tests, builds, edits inside the project). ' +
      'Pushes, deletes, sudo, secrets, publishing, MCP tools, plans and questions always come to you. It never denies.'
    autoLabel.append(this.autoBox, el('span', undefined, 'AI approves routine prompts'))
    // The agent's switch. Off, this panel is the inbox it always was; on, a
    // Claude Code of its own takes the centre and the cards move beside it.
    this.agentBox.type = 'checkbox'
    this.agentBox.onchange = () => this.cb.onAgent({ enabled: this.agentBox.checked })
    const agentLabel = el('label', 'inbox-auto inbox-agent')
    agentLabel.title = 'A Claude Code session of its own in the centre. Tell it what you want; it reads every tile ' +
      '(status, branch, screen, changes), prompts the agents in them and starts new ones. ' +
      'Permission prompts stay here, with you.'
    agentLabel.append(this.agentBox, el('span', undefined, 'Agent'))
    head.append(agentLabel, autoLabel)
    this.history.hidden = true
    this.history.append(this.historySummary, this.historyList)
    this.banner.hidden = true
    this.agentNote.hidden = true
    this.el.append(head, this.agentNote, this.banner, this.history, this.list, this.empty)
    this.el.addEventListener('keydown', (e) => this.onKey(e))
    this.handle.hidden = true
    this.handle.title = 'Drag to resize'
    cell.append(this.handle, this.el)
    this.bindResize()
  }

  get isOpen(): boolean {
    return this.shown
  }

  /** Per browser: a display choice, like the ring size. */
  static wanted(): boolean {
    try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
  }

  /** `takeKeys` false leaves the keyboard where it is: on the agent's terminal. */
  open(takeKeys = true): void {
    this.shown = true
    this.el.hidden = false
    try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* private mode */ }
    this.render()
    void this.checkHooks()
    this.ticker ??= setInterval(() => this.paintAges(), 5000)
    if (takeKeys) this.focusCard(0, false)
  }

  /**
   * Beside the agent's terminal rather than over it. The keyboard hint goes:
   * the keys are the terminal's until a card is clicked.
   */
  setBeside(beside: boolean): void {
    this.el.classList.toggle('beside', beside)
    this.handle.hidden = !beside
    if (beside) this.el.style.flexBasis = `${this.width}px`
    else this.el.style.removeProperty('flex-basis')
  }

  /** Per browser, like the diff panel's width. */
  private static savedWidth(): number {
    try {
      const v = Number(localStorage.getItem(WIDTH_KEY))
      return Number.isFinite(v) && v > 0 ? v : DEFAULT_WIDTH
    } catch {
      return DEFAULT_WIDTH
    }
  }

  /**
   * Drag the handle to resize the column beside the agent. The terminal is
   * refitted once, on release: fitting on every move would send the PTY a
   * resize per pixel.
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
      this.el.style.flexBasis = `${this.width}px`
    })
    const end = (e: PointerEvent): void => {
      if (!this.handle.hasPointerCapture(e.pointerId)) return
      this.handle.releasePointerCapture(e.pointerId)
      this.handle.classList.remove('dragging')
      try { localStorage.setItem(WIDTH_KEY, String(this.width)) } catch { /* private mode */ }
      this.cb.onLayout?.()
    }
    this.handle.addEventListener('pointerup', end)
    this.handle.addEventListener('pointercancel', end)
  }

  /** Mirrors the daemon's agent state: the switch, and a note when it is down. */
  setAgent(agent: AgentInfo): void {
    this.agentBox.checked = agent.enabled
    const down = agent.enabled && (agent.error !== null || agent.id === null || agent.status === 'exited')
    this.agentNote.hidden = !down
    if (!down) return
    if (agent.error) {
      this.agentNote.replaceChildren(el('span', undefined, `The orchestrator agent could not start: ${agent.error}`))
      return
    }
    this.agentNote.replaceChildren(
      el('span', undefined, agent.id ? 'The orchestrator agent’s Claude has exited.' : 'The orchestrator agent is starting…'),
      ...(agent.id ? [
        button('Start again', 'primary', () => this.cb.onAgent({ restart: 'resume' }), 'Reopen the same conversation'),
        button('New conversation', '', () => this.cb.onAgent({ restart: 'fresh' })),
      ] : []),
    )
  }

  close(): void {
    this.shown = false
    this.el.hidden = true
    try { localStorage.setItem(STORAGE_KEY, '0') } catch { /* private mode */ }
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }

  /** The cards for one session, so its tile can show it is asking. */
  countFor(sessionId: string): number {
    return this.items.filter((i) => i.sessionId === sessionId).length
  }

  get count(): number {
    return this.items.length
  }

  /** New ids, for the chime. */
  setItems(items: InboxItem[]): InboxItem[] {
    const before = new Set(this.items.map((i) => i.id))
    const focusedId = this.focusedCardId()
    this.items = items
    this.render()
    // The card under the keyboard went away: move to whatever now sits in
    // its place, but disarmed for a beat (see ARM_MS).
    if (this.shown && focusedId && !this.cards.has(focusedId)) this.focusCard(0, true)
    else if (this.shown && !focusedId && document.activeElement === this.el) this.focusCard(0, true)
    return items.filter((i) => !before.has(i.id))
  }

  setAuto(enabled: boolean, history: AutoDecision[]): void {
    this.autoBox.checked = enabled
    this.history.hidden = history.length === 0
    const allowed = history.filter((h) => h.verdict === 'allow').length
    this.historySummary.textContent =
      `AI decisions: ${allowed} approved for you, ${history.length - allowed} left for you`
    this.historyList.replaceChildren(...history.map((h) => {
      const li = el('li', `hist-${h.verdict}`)
      const who = this.cb.label(h.sessionId)
      li.append(
        el('span', 'hist-verdict', h.verdict === 'allow' ? 'approved' : 'asked you'),
        el('span', 'hist-who', who ? `${who.slot} ${who.name}` : 'closed session'),
        el('code', 'hist-what', h.what || h.tool),
        el('span', 'hist-reason', h.reason),
        el('span', 'hist-age', age(Date.now() - h.at)),
      )
      return li
    }))
  }

  /** Labels changed (rename, recolour), not the cards. */
  repaint(): void {
    for (const c of this.cards.values()) c.paintHeader()
  }

  private render(): void {
    // Whatever has the keyboard — usually a half-typed reply — keeps it. A
    // node the DOM moves loses focus, so cards already in place are never
    // touched: a new card arriving is an insert, not a rebuild of the list.
    const active = document.activeElement
    const typing = active instanceof HTMLElement && this.list.contains(active) ? active : null
    const keep = new Set(this.items.map((i) => i.id))
    for (const [id, card] of this.cards) {
      if (!keep.has(id)) { card.root.remove(); this.cards.delete(id) }
    }
    let prev: Node | null = null
    for (const item of this.items) {
      let card = this.cards.get(item.id)
      if (!card) {
        card = this.build(item)
        this.cards.set(item.id, card)
      }
      // Oldest first. Only a card that is not already where it belongs moves.
      const want: Node | null = prev ? prev.nextSibling : this.list.firstChild
      if (want !== card.root) this.list.insertBefore(card.root, want)
      prev = card.root
    }
    if (typing && typing.isConnected && document.activeElement !== typing) typing.focus({ preventScroll: true })
    this.empty.hidden = this.items.length > 0
    this.empty.textContent = 'Nothing is waiting on you. Cards appear here when an agent asks for permission, asks a question, or finishes.'
  }

  private async checkHooks(): Promise<void> {
    try {
      const st = await this.cb.hooks()
      this.banner.hidden = st.installed
      if (st.installed) return
      this.banner.replaceChildren(
        el('span', undefined, `Claude Code hooks are not installed, so agents cannot reach this inbox. They go in ${st.path} and do nothing outside tring.`),
        button('Install hooks', 'primary', () => {
          void this.cb.installHooks().then(() => this.checkHooks(), (err: Error) => {
            this.banner.replaceChildren(el('span', undefined, `Could not install: ${err.message}`))
          })
        }),
        el('span', 'inbox-note', 'Restart running claude sessions to pick them up.'),
      )
    } catch {
      this.banner.hidden = true
    }
  }

  private focusedCardId(): string | null {
    const active = document.activeElement
    for (const [id, c] of this.cards) if (c.root.contains(active)) return id
    return null
  }

  private focusCard(index: number, disarm: boolean): void {
    const card = [...this.cards.values()][Math.max(0, Math.min(index, this.cards.size - 1))]
    if (disarm) this.armedAt = performance.now() + ARM_MS
    if (card) card.root.focus({ preventScroll: false })
    else this.el.focus()
  }

  private paintAges(): void {
    for (const c of this.cards.values()) {
      const a = c.root.querySelector<HTMLElement>('.card-age')
      if (a) a.textContent = age(Date.now() - c.item.createdAt)
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const target = e.target as HTMLElement
    const typing = target.tagName === 'TEXTAREA' || target.tagName === 'INPUT'
    const ids = [...this.cards.keys()]
    const at = ids.indexOf(this.focusedCardId() ?? '')

    if (!typing && (e.key === 'ArrowDown' || e.key === 'j')) {
      e.preventDefault(); this.focusCard(at + 1, false); return
    }
    if (!typing && (e.key === 'ArrowUp' || e.key === 'k')) {
      e.preventDefault(); this.focusCard(Math.max(0, at - 1), false); return
    }
    if (at < 0) return
    if (performance.now() < this.armedAt) { e.preventDefault(); return }
    if (this.cards.get(ids[at]!)!.key(e)) e.preventDefault()
  }

  private build(item: InboxItem): Card {
    const text = describe(item)
    const root = el('section', `card card-${item.kind}`)
    root.tabIndex = 0

    const head = el('header', 'card-head')
    const slot = el('span', 'card-slot')
    const name = el('span', 'card-name')
    const where = el('span', 'card-where')
    const heading = el('span', 'card-heading', text.heading)
    const when = el('span', 'card-age', age(Date.now() - item.createdAt))
    head.append(slot, name, where, heading, when)
    const paintHeader = (): void => {
      const l = this.cb.label(item.sessionId)
      slot.textContent = l ? String(l.slot) : '?'
      name.textContent = l?.name ?? 'session'
      where.textContent = l?.elsewhere ? `in ${l.elsewhere}` : ''
      if (l?.color) root.style.setProperty('--tint', l.color)
      else root.style.removeProperty('--tint')
    }
    paintHeader()
    root.append(head)

    const answer = (d: InboxDecision, extra?: { answers?: Record<string, string>; message?: string }): void =>
      this.cb.onAnswer(item.id, d, extra)
    const open = (): void => this.cb.onOpen(item.sessionId)
    const actions = el('div', 'card-actions')
    let key: (e: KeyboardEvent) => boolean = () => false

    if (item.kind === 'permission') {
      if (text.note) root.append(el('p', 'card-note', text.note))
      // Commands and diffs stay verbatim; a plan is prose, written in Markdown.
      root.append(...expandable(text.mono ? el('pre', 'card-body', text.body) : renderMarkdown(text.body, 'card-body md')))
      if (text.tool) root.append(el('div', 'card-tool', text.tool))

      const reason = el('input', 'card-reason')
      reason.placeholder = 'Why not? (optional, Enter to deny)'
      reason.hidden = true
      const deny = (): void => {
        if (reason.hidden) { reason.hidden = false; reason.focus(); return }
        answer('deny', { message: reason.value })
      }
      reason.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); answer('deny', { message: reason.value }) }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); reason.hidden = true; root.focus() }
      })
      actions.append(
        button('Allow', 'primary', () => answer('allow'), 'a'),
        button('Deny', 'danger', deny, 'd'),
        button('Answer in terminal', '', () => answer('terminal'), 't'),
        button('Open', '', open, 'o'),
      )
      root.append(actions, reason)
      key = (e) => {
        if (e.target !== root) return false
        if (e.key === 'a') { answer('allow'); return true }
        if (e.key === 'd') { deny(); return true }
        if (e.key === 't') { answer('terminal'); return true }
        if (e.key === 'o') { open(); return true }
        return false
      }
    }

    if (item.kind === 'question') {
      const qs = item.questions ?? []
      const chosen = new Map<number, Set<string>>()
      const other = new Map<number, string>()
      const send = button('Send answers', 'primary', () => submit())
      const submit = (): void => {
        const answers = answersFor(qs, chosen, other)
        if (answers) answer('allow', { answers })
      }
      const refresh = (): void => { send.disabled = answersFor(qs, chosen, other) === null }
      const single = qs.length === 1 && !qs[0]!.multiSelect
      const optionButtons: HTMLButtonElement[] = []

      for (const [qi, q] of qs.entries()) {
        const block = el('div', 'card-question')
        if (q.header) block.append(el('span', 'card-chip', q.header))
        block.append(renderMarkdown(q.question, 'card-ask md'))
        const opts = el('div', 'card-options')
        for (const [oi, o] of q.options.entries()) {
          const b = el('button', 'option')
          b.type = 'button'
          b.append(el('b', undefined, `${oi + 1}`), el('span', undefined, o.label))
          if (o.description) b.append(el('small', undefined, o.description))
          b.onclick = (e) => {
            e.stopPropagation()
            const set = chosen.get(qi) ?? new Set<string>()
            if (q.multiSelect) { if (set.has(o.label)) set.delete(o.label); else set.add(o.label) }
            else { set.clear(); set.add(o.label) }
            chosen.set(qi, set)
            Array.from(opts.querySelectorAll<HTMLElement>('.option')).forEach((sib, j) => {
              sib.classList.toggle('picked', set.has(q.options[j]!.label))
            })
            refresh()
            if (single) submit()
          }
          if (qi === 0) optionButtons.push(b)
          opts.append(b)
        }
        const typed = el('input', 'card-other')
        typed.placeholder = 'Or type your own answer'
        typed.addEventListener('input', () => { other.set(qi, typed.value); refresh() })
        typed.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit() }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); root.focus() }
        })
        block.append(opts, typed)
        root.append(block)
      }
      refresh()
      actions.append(
        ...(single ? [] : [send]),
        button('Answer in terminal', '', () => answer('terminal'), 't'),
        button('Open', '', open, 'o'),
      )
      root.append(actions)
      key = (e) => {
        if (e.target !== root) return false
        const n = Number(e.key)
        if (n >= 1 && n <= 9 && optionButtons[n - 1]) { optionButtons[n - 1]!.click(); return true }
        if (e.key === 't') { answer('terminal'); return true }
        if (e.key === 'o') { open(); return true }
        if (e.key === 'Enter' && !single) { submit(); return true }
        return false
      }
    }

    if (item.kind === 'reply') {
      // What the agent said, as it meant it to read: **bold** is bold.
      root.append(...expandable(renderMarkdown(text.body, 'card-message md')))
      const box = el('textarea', 'card-reply')
      box.rows = 2
      box.placeholder = 'Reply… (Enter sends, Shift+Enter for a new line)'
      const send = (): void => {
        const v = box.value.trim()
        if (v) this.cb.onReply(item.id, v)
      }
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); send() }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); root.focus() }
      })
      actions.append(
        button('Send', 'primary', send),
        button('Dismiss', '', () => answer('terminal'), 'x'),
        button('Open', '', open, 'o'),
      )
      root.append(box, actions)
      key = (e) => {
        if (e.target !== root) return false
        if (e.key === 'Enter' || e.key === 'r') { box.focus(); return true }
        if (e.key === 'x') { answer('terminal'); return true }
        if (e.key === 'o') { open(); return true }
        return false
      }
    }

    return { item, root, paintHeader, key }
  }
}

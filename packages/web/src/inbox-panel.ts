import type { AgentInfo, AutoDecision, InboxDecision, InboxItem } from '@tring/shared/protocol'
import { age, answersFor, describe } from './inbox-view.ts'
import { renderMarkdown } from './markdown.ts'
import { answerText, parseChoices } from './choices.ts'
import { MOBILE_QUERY as PHONE } from './switcher.ts'
import { cardSignature, orderCards, pickerLabel, pickerValue, workflowCard } from './workflow-view.ts'
import {
  clampSplit, MIN_CARDS_HEIGHT, MIN_CARDS_WIDTH, MIN_TERMINAL_HEIGHT, MIN_TERMINAL_WIDTH,
} from './split.ts'

const WIDTH_KEY = 'tring.inboxWidth'
const HEIGHT_KEY = 'tring.inboxHeight'
/** Beside the agent: wide enough for a card's buttons on one row. */
const DEFAULT_WIDTH = 420

const STORAGE_KEY = 'tring.orchestrator'
/** The same microphone as the phone's bar (switcher.ts). */
const MIC_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15"/></svg>'
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
  /** The reply box's microphone (voice.ts): start or stop talking into `box`. */
  onVoice?: (box: HTMLTextAreaElement, button: HTMLButtonElement) => void
  /** A button on a multi-PR workflow card, with the words or number it asked for. */
  onAction?: (itemId: string, actionId: string, text?: string, value?: number | string) => void
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
  /** Workflow cards only: what it shows, so it is drawn again when that changes. */
  sig?: string
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
  private width = InboxPanel.saved(WIDTH_KEY) ?? DEFAULT_WIDTH
  /** Stacked on a phone; null keeps the stylesheet's share. */
  private height: number | null = InboxPanel.saved(HEIGHT_KEY)
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
    // The phone's back gesture, while a card is full screen.
    window.addEventListener('popstate', () => { if (this.fullId) this.closeFull(true) })
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
    this.applySize()
  }

  /** On a phone the cards are a band above the terminal, and the split is a height. */
  private stacked(): boolean {
    return getComputedStyle(this.cell).flexDirection.startsWith('column')
  }

  /**
   * The saved split, along whichever way the cell is laid out now. A phone
   * with no saved height keeps the stylesheet's default share.
   */
  private applySize(): void {
    if (!this.el.classList.contains('beside')) {
      this.el.style.removeProperty('flex-basis')
      return
    }
    const size = this.stacked() ? this.height : this.width
    if (size) this.el.style.flexBasis = `${size}px`
    else this.el.style.removeProperty('flex-basis')
    this.handle.classList.toggle('across', this.stacked())
  }

  /** Per browser, like the diff panel's width. */
  private static saved(key: string): number | null {
    try {
      const v = Number(localStorage.getItem(key))
      return Number.isFinite(v) && v > 0 ? v : null
    } catch {
      return null
    }
  }

  /**
   * Drag the handle to share the cell between the agent and the cards: a width
   * side by side, a height when stacked. Both sides keep a minimum (split.ts).
   * The terminal follows as the cards move — main.ts watches its box and
   * refits it, and the PTY gets one resize once the size settles.
   */
  private bindResize(): void {
    let from = 0
    let across = false
    this.handle.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      across = this.stacked()
      const box = this.el.getBoundingClientRect()
      // Side by side the cards are on the right, so they grow leftwards;
      // stacked they are on top and grow downwards.
      from = across ? box.top : box.right
      this.handle.setPointerCapture(e.pointerId)
      this.handle.classList.add('dragging')
    })
    this.handle.addEventListener('pointermove', (e) => {
      if (!this.handle.hasPointerCapture(e.pointerId)) return
      if (across) {
        this.height = clampSplit(e.clientY - from, this.cell.clientHeight, MIN_CARDS_HEIGHT, MIN_TERMINAL_HEIGHT)
        this.el.style.flexBasis = `${this.height}px`
      } else {
        this.width = clampSplit(from - e.clientX, this.cell.clientWidth, MIN_CARDS_WIDTH, MIN_TERMINAL_WIDTH)
        this.el.style.flexBasis = `${this.width}px`
      }
    })
    const end = (e: PointerEvent): void => {
      if (!this.handle.hasPointerCapture(e.pointerId)) return
      this.handle.releasePointerCapture(e.pointerId)
      this.handle.classList.remove('dragging')
      try {
        if (across && this.height) localStorage.setItem(HEIGHT_KEY, String(this.height))
        if (!across) localStorage.setItem(WIDTH_KEY, String(this.width))
      } catch { /* private mode */ }
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
    this.closeFull()
    this.shown = false
    this.el.hidden = true
    try { localStorage.setItem(STORAGE_KEY, '0') } catch { /* private mode */ }
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }

  /* ---- one card, full screen (on a phone) ---- */

  private fullId: string | null = null
  private fullSession: string | null = null
  /** A history entry is ours while full screen is open, for the back gesture. */
  private fullPushed = false
  private fullTimer: ReturnType<typeof setTimeout> | null = null
  /** Cards answered from this panel, so full screen can tell "you answered" from "it went away". */
  private readonly answeredHere = new Set<string>()

  private answered(id: string): void {
    this.answeredHere.add(id)
  }

  private reply(id: string, text: string): void {
    this.answered(id)
    this.cb.onReply(id, text)
  }

  /**
   * Shows one card over the whole screen: the same element, so a half-typed
   * reply or picked choices come along, and it keeps updating in place. The
   * message scrolls; choices, the reply box and the buttons stay pinned at
   * the bottom, sized to the visible viewport so an open keyboard does not
   * cover them.
   */
  openFull(id: string): void {
    const card = this.cards.get(id)
    if (!card) return
    if (this.fullTimer) { clearTimeout(this.fullTimer); this.fullTimer = null }
    const switching = this.fullId !== null
    if (switching && this.fullId !== id) this.unstyleFull(this.cards.get(this.fullId!)?.root)
    this.fullId = id
    this.fullSession = card.item.sessionId
    card.root.classList.add('full')
    document.body.classList.add('card-full-open')
    // One history entry while it is open: the phone's back gesture closes it
    // instead of leaving tring.
    if (!switching) {
      history.pushState({ tringCard: true }, '')
      this.fullPushed = true
      window.visualViewport?.addEventListener('resize', this.fitFull)
      window.visualViewport?.addEventListener('scroll', this.fitFull)
    }
    this.fitFull()
    card.root.focus({ preventScroll: true })
  }

  /** `fromBack`: the back gesture already took our history entry. */
  closeFull(fromBack = false): void {
    if (this.fullTimer) { clearTimeout(this.fullTimer); this.fullTimer = null }
    if (!this.fullId) return
    this.unstyleFull(this.cards.get(this.fullId)?.root)
    this.fullId = null
    this.fullSession = null
    document.body.classList.remove('card-full-open')
    window.visualViewport?.removeEventListener('resize', this.fitFull)
    window.visualViewport?.removeEventListener('scroll', this.fitFull)
    const pushed = this.fullPushed
    this.fullPushed = false
    if (pushed && !fromBack && (history.state as { tringCard?: boolean } | null)?.tringCard) history.back()
  }

  private unstyleFull(root: HTMLElement | undefined): void {
    if (!root) return
    root.classList.remove('full')
    root.style.removeProperty('height')
    root.style.removeProperty('top')
  }

  /**
   * Fits the full-screen card to the part of the screen that is visible. With
   * the keyboard up, iOS shrinks only the visual viewport, and a card sized to
   * the layout viewport would have its reply box under the keyboard.
   */
  private readonly fitFull = (): void => {
    const vv = window.visualViewport
    const root = this.fullId ? this.cards.get(this.fullId)?.root : undefined
    if (!vv || !root) return
    root.style.height = `${vv.height}px`
    root.style.top = `${vv.offsetTop}px`
  }

  /**
   * The full-screen card left the list. Answered here: close — nothing is
   * left to do there until the agent finishes, and other cards may need you.
   * Gone otherwise (answered on another device, or replaced: a finished card
   * is dropped, then its successor arrives): follow the tile's newer card if
   * one comes within a moment, else close.
   */
  private fullGone(): void {
    const was = this.fullId!
    const session = this.fullSession
    if (this.answeredHere.has(was)) { this.closeFull(); return }
    const next = this.items.find((i) => i.sessionId === session)
    if (next) { this.openFull(next.id); return }
    this.fullTimer ??= setTimeout(() => {
      this.fullTimer = null
      if (this.fullId !== was) return
      const later = this.items.find((i) => i.sessionId === session)
      if (later) this.openFull(later.id)
      else this.closeFull()
    }, 1500)
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
    for (const item of orderCards(this.items)) {
      let card = this.cards.get(item.id)
      // A ticket's card shows its state, which moves on: redraw it, unless
      // someone is typing in it (a reason, the changes they want).
      if (card?.sig !== undefined && card.sig !== cardSignature(item) && !card.root.contains(document.activeElement)) {
        const fresh = this.build(item)
        card.root.replaceWith(fresh.root)
        this.cards.set(item.id, fresh)
        card = fresh
      }
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
    for (const id of this.answeredHere) if (!keep.has(id) && id !== this.fullId) this.answeredHere.delete(id)
    if (this.fullId && !this.cards.has(this.fullId)) this.fullGone()
    this.empty.hidden = this.items.length > 0
    this.empty.textContent = 'Nothing is waiting on you. Cards appear here when an agent asks for permission, asks a question, or finishes.'
  }

  /**
   * A multi-PR workflow card: the ticket's status (pinned), or a call for the
   * user — a plan, a finding, a restack, a push. Its buttons go to the stack
   * engine; one that asks for words or a number opens a box for it first.
   */
  private buildWorkflow(item: InboxItem): Card {
    const v = workflowCard(item)
    const root = el('section', `card card-${item.kind}${v.pinned ? ' pinned' : ''}`)
    root.tabIndex = 0
    const head = el('header', 'card-head')
    head.append(
      el('span', 'card-slot', v.pinned ? '\u25c6' : '\u2022'),
      el('span', 'card-heading', v.heading),
      el('span', 'card-age', age(Date.now() - item.createdAt)),
    )
    const main = el('div', 'card-main')
    main.append(...expandable(renderMarkdown(v.body, 'card-message md')))
    const foot = el('div', 'card-foot')
    const actions = el('div', 'card-actions')
    const ask = el('div', 'card-ask')
    ask.hidden = true
    const send = (id: string, text?: string, value?: number | string): void => this.cb.onAction?.(item.id, id, text, value)
    const plain: HTMLButtonElement[] = []
    // The strategy picker: radio buttons above the buttons; its pick goes with its button, whose label follows it.
    const picker = v.picker
    let picked = picker?.selected ?? ''
    let ticked = picker?.option?.checked ?? false
    let pickerButton: HTMLButtonElement | null = null
    if (picker) {
      const group = el('fieldset', 'card-picker')
      group.append(el('legend', undefined, 'Strategy'))
      const note = el('p', 'card-picker-note')
      const option = el('label', 'card-picker-option')
      const box = el('input')
      box.type = 'checkbox'
      box.id = `${item.id}-option`
      box.checked = ticked
      box.onchange = () => { ticked = box.checked }
      if (picker.option) option.append(box, el('span', undefined, picker.option.label))
      const paint = (): void => {
        const c = picker.choices.find((x) => x.value === picked)
        note.textContent = c ? [c.note, c.misfit ? `Needs a re-plan: ${c.misfit}` : ''].filter(Boolean).join(' ') : ''
        option.hidden = !picker.option || picker.option.for !== picked
        if (pickerButton) pickerButton.textContent = pickerLabel(picker, picked)
      }
      for (const c of picker.choices) {
        const row = el('label', 'card-picker-choice')
        const radio = el('input')
        radio.type = 'radio'
        radio.name = `${item.id}-strategy`
        radio.id = `${item.id}-strategy-${c.value}`
        radio.value = c.value
        radio.checked = c.value === picked
        radio.onchange = () => { picked = c.value; paint() }
        row.append(radio, el('span', undefined, c.label))
        group.append(row)
      }
      group.append(note, option)
      main.append(group)
      queueMicrotask(paint)
    }
    for (const b of v.buttons) {
      const btn = button(picker && b.id === picker.action ? pickerLabel(picker, picked) : b.label, b.primary ? 'primary' : '', () => {
        if (picker && b.id === picker.action) return send(b.id, undefined, pickerValue(picker, picked, ticked))
        if (b.input === 'none') return send(b.id)
        ask.hidden = false
        if (b.input === 'text') {
          const box = el('input', 'card-reason')
          box.placeholder = `${b.label.replace(/…$/, '')}: why? (Enter sends)`
          box.onkeydown = (e) => {
            if (e.key === 'Enter' && box.value.trim()) { e.preventDefault(); send(b.id, box.value.trim()) }
            if (e.key === 'Escape') { e.preventDefault(); ask.hidden = true; root.focus() }
          }
          ask.replaceChildren(box, button('Send', 'primary', () => { if (box.value.trim()) send(b.id, box.value.trim()) }))
          box.focus()
        } else {
          const range = el('input', 'card-range')
          range.type = 'range'
          range.min = String(b.min ?? 0)
          range.max = String(b.max ?? 0)
          range.value = String(b.value ?? b.min ?? 0)
          const shown = el('b', 'card-range-value', range.value)
          range.oninput = () => { shown.textContent = range.value }
          ask.replaceChildren(el('span', undefined, b.label), range, shown, button('Set', 'primary', () => send(b.id, undefined, Number(range.value))))
          range.focus()
        }
      })
      if (picker && b.id === picker.action) pickerButton = btn
      if (b.input === 'none') plain.push(btn)
      actions.append(btn)
    }
    foot.append(actions, ask)
    root.append(head, main, foot)
    return {
      item, root, sig: cardSignature(item), paintHeader: () => {},
      // 1-9 press the card's buttons that need nothing more, in order.
      key: (e) => {
        const n = Number(e.key)
        if (n >= 1 && n <= 9 && plain[n - 1]) { plain[n - 1]!.click(); return true }
        return false
      },
    }
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
    if (e.key === 'Escape' && this.fullId && !typing) { e.preventDefault(); this.closeFull(); return }
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
    if (item.kind === 'workflow' || item.kind === 'feature') return this.buildWorkflow(item)
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
    // Full screen on a phone (see openFull): a large expand button, and the
    // title too. Close and the back gesture leave it.
    const expand = el('button', 'card-expand')
    expand.type = 'button'
    expand.title = 'Open full screen'
    expand.setAttribute('aria-label', 'Open full screen')
    expand.textContent = '\u2922'
    expand.onclick = (e) => { e.stopPropagation(); this.openFull(item.id) }
    const shut = el('button', 'card-close', 'Close')
    shut.type = 'button'
    shut.setAttribute('aria-label', 'Close full screen')
    shut.onclick = (e) => { e.stopPropagation(); this.closeFull() }
    head.append(expand, shut)
    for (const t of [name, heading]) {
      t.addEventListener('click', (e) => {
        if (!window.matchMedia(PHONE).matches || root.classList.contains('full')) return
        e.stopPropagation()
        this.openFull(item.id)
      })
    }
    const paintHeader = (): void => {
      const l = this.cb.label(item.sessionId)
      slot.textContent = l ? String(l.slot) : '?'
      name.textContent = l?.name ?? 'session'
      where.textContent = l?.elsewhere ? `in ${l.elsewhere}` : ''
      if (l?.color) root.style.setProperty('--tint', l.color)
      else root.style.removeProperty('--tint')
    }
    paintHeader()
    const main = el('div', 'card-main')
    const foot = el('div', 'card-foot')
    root.append(head, main, foot)

    const answer = (d: InboxDecision, extra?: { answers?: Record<string, string>; message?: string }): void => {
      this.answered(item.id)
      this.cb.onAnswer(item.id, d, extra)
    }
    const open = (): void => this.cb.onOpen(item.sessionId)
    const actions = el('div', 'card-actions')
    let key: (e: KeyboardEvent) => boolean = () => false

    if (item.kind === 'permission') {
      if (text.note) main.append(el('p', 'card-note', text.note))
      // Commands and diffs stay verbatim; a plan is prose, written in Markdown.
      main.append(...expandable(text.mono ? el('pre', 'card-body', text.body) : renderMarkdown(text.body, 'card-body md')))
      if (text.tool) main.append(el('div', 'card-tool', text.tool))

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
      foot.append(actions, reason)
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
        main.append(block)
      }
      refresh()
      actions.append(
        ...(single ? [] : [send]),
        button('Answer in terminal', '', () => answer('terminal'), 't'),
        button('Open', '', open, 'o'),
      )
      foot.append(actions)
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
      main.append(...expandable(renderMarkdown(text.body, 'card-message md')))
      const box = el('textarea', 'card-reply')
      box.rows = 2
      box.placeholder = 'Reply… (Enter sends, Shift+Enter for a new line)'
      const send = (): void => {
        const v = box.value.trim()
        if (v) this.reply(item.id, v)
      }
      // A plain-text multiple choice at the end of its turn (the grilling
      // skill's rounds): one button per option, outside the folded message so
      // they show whether it is folded or not. See choices.ts.
      const choiceKeys = this.choiceButtons(item, foot, box)
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); send() }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); root.focus() }
      })
      actions.append(
        button('Send', 'primary', send),
        button('Dismiss', '', () => answer('terminal'), 'x'),
        button('Open', '', open, 'o'),
      )
      // Talk instead of typing (desktop; a phone has its keyboard's dictation).
      if (this.cb.onVoice) {
        const onVoice = this.cb.onVoice
        const mic = el('button', 'btn voice-btn card-voice')
        mic.type = 'button'
        mic.title = 'Talk: the words go into the reply box, to edit before sending'
        mic.setAttribute('aria-label', 'Voice input')
        mic.innerHTML = MIC_ICON
        mic.onclick = (e) => { e.stopPropagation(); onVoice(box, mic) }
        actions.append(mic)
      }
      foot.append(box, actions)
      key = (e) => {
        if (e.target !== root) return false
        if (choiceKeys(e)) return true
        if (e.key === 'Enter' || e.key === 'r') { box.focus(); return true }
        if (e.key === 'x') { answer('terminal'); return true }
        if (e.key === 'o') { open(); return true }
        return false
      }
    }

    return { item, root, paintHeader, key }
  }

  /**
   * The option buttons for a finished card whose message ends in a choice,
   * styled like Claude Code's own questions (AskUserQuestion) above.
   *
   * One question: a button sends at once — "(a) <option text>", which the
   * agent cannot misread even if it scrolled, or "yes" for its recommendation.
   * Several (a grilling round): sending on the first click would answer only
   * Q1, so each click fills that question's line in the reply box instead
   * ("Q1: yes", "Q2: (b) One day") and Send goes once they are done.
   * "Something else" and "Other" open the reply box rather than sending.
   *
   * Returns the card's extra keys: 1–9 for an option and y for yes, when there
   * is a single question.
   */
  private choiceButtons(item: InboxItem, into: HTMLElement, box: HTMLTextAreaElement): (e: KeyboardEvent) => boolean {
    const questions = parseChoices(item.message ?? '')
    if (!questions.length) return () => false
    const single = questions.length === 1
    const picks = new Map<string, string>()
    const compose = (): void => {
      box.value = questions.filter((q) => picks.has(q.id!)).map((q) => `${q.id}: ${picks.get(q.id!)}`).join('\n')
    }
    const focusEnd = (): void => {
      box.focus()
      box.setSelectionRange(box.value.length, box.value.length)
    }
    const numbered: HTMLButtonElement[] = []
    let yesButton: HTMLButtonElement | null = null

    for (const q of questions) {
      const block = el('div', 'card-choices')
      if (!single) block.append(el('p', 'card-choice-q', `${q.id} · ${q.title}`))
      const opts = el('div', 'card-options')
      const choose = (b: HTMLButtonElement, answerFor: string): void => {
        if (single) { this.reply(item.id, answerFor); return }
        picks.set(q.id!, answerFor)
        compose()
        for (const sib of Array.from(opts.querySelectorAll('.option'))) sib.classList.toggle('picked', sib === b)
      }
      const rec = q.options.find((o) => o.recommended)
      if (q.acceptsYes && rec) {
        const b = el('button', 'option yes')
        b.type = 'button'
        b.append(el('b', undefined, 'y'), el('span', undefined, 'Yes'), el('small', undefined, `Go with the recommendation, (${rec.key})`))
        b.onclick = (e) => { e.stopPropagation(); choose(b, 'yes') }
        opts.append(b)
        if (single) yesButton = b
      }
      for (const o of q.options) {
        const b = el('button', `option${o.recommended ? ' recommended' : ''}${o.other ? ' other' : ''}`)
        b.type = 'button'
        b.append(el('b', undefined, o.key), el('span', undefined, o.label))
        if (o.recommended) b.append(el('small', 'option-tag', 'Recommended'))
        b.onclick = (e) => {
          e.stopPropagation()
          if (!o.other) { choose(b, answerText(o)); return }
          // "Something else": the reply box, ready for it.
          if (!single) { picks.set(q.id!, ''); compose() }
          focusEnd()
        }
        opts.append(b)
        if (single) numbered.push(b)
      }
      block.append(opts)
      into.append(block)
    }

    return (e) => {
      if (!single) return false
      const n = Number(e.key)
      if (n >= 1 && n <= 9 && numbered[n - 1]) { numbered[n - 1]!.click(); return true }
      if (e.key === 'y' && yesButton) { yesButton.click(); return true }
      return false
    }
  }
}

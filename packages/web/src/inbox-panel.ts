import type { InboxDecision, InboxItem } from '@tring/shared/protocol'
import { age, answersFor, describe } from './inbox-view.ts'

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
  private readonly cards = new Map<string, Card>()
  private items: InboxItem[] = []
  private shown = false
  private armedAt = 0
  private ticker: ReturnType<typeof setInterval> | null = null

  constructor(cell: HTMLElement, private readonly cb: InboxCallbacks) {
    this.el.hidden = true
    this.el.tabIndex = -1
    const head = el('div', 'inbox-head')
    head.append(el('span', 'inbox-title', 'Orchestrator'), el('span', 'inbox-hint',
      'a allow · d deny · t answer in terminal · o open · 1–9 pick · ↑↓ move · Ctrl+Space then o to leave'))
    this.banner.hidden = true
    this.el.append(head, this.banner, this.list, this.empty)
    this.el.addEventListener('keydown', (e) => this.onKey(e))
    cell.append(this.el)
  }

  get isOpen(): boolean {
    return this.shown
  }

  /** Per browser: a display choice, like the ring size. */
  static wanted(): boolean {
    try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
  }

  open(): void {
    this.shown = true
    this.el.hidden = false
    try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* private mode */ }
    this.render()
    void this.checkHooks()
    this.ticker ??= setInterval(() => this.paintAges(), 5000)
    this.focusCard(0, false)
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

  /** Labels changed (rename, recolour), not the cards. */
  repaint(): void {
    for (const c of this.cards.values()) c.paintHeader()
  }

  private render(): void {
    const keep = new Set(this.items.map((i) => i.id))
    for (const [id, card] of this.cards) {
      if (!keep.has(id)) { card.root.remove(); this.cards.delete(id) }
    }
    for (const item of this.items) {
      let card = this.cards.get(item.id)
      if (!card) {
        card = this.build(item)
        this.cards.set(item.id, card)
      }
      this.list.append(card.root) // re-appending keeps the order oldest first
    }
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
      root.append(el(text.mono ? 'pre' : 'p', 'card-body', text.body))
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
        block.append(el('p', 'card-ask', q.question))
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
      root.append(el('div', 'card-message', text.body))
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

import type { SessionInfo, SessionStatus } from '@tring/shared/protocol'

/**
 * The phone view. Under this width the ring is not drawn — thumbnails are
 * unreadable at phone size and cost bandwidth the phone would rather spend on
 * the one terminal you can actually read — and this bar takes the ring's job:
 * say which session is in the centre, open the picker, jump to the next
 * finished one.
 */
export const MOBILE_QUERY = '(max-width: 720px)'

export interface SessionLabel {
  key: string
  name: string
  status: SessionStatus
}

/** The same fallback chain a tile uses, so the bar and the ring never disagree. */
export function describeSession(s: SessionInfo | null): SessionLabel {
  if (!s) return { key: '—', name: 'pick a session', status: 'idle' }
  return { key: String(s.slot), name: s.name ?? s.title ?? 'shell', status: s.status }
}

export interface SwitcherState {
  focused: SessionInfo | null
  /** Finished sessions in this project, for the "next" button's count. */
  done: number
  /** The mic is on (see dictation.ts). */
  listening: boolean
  /** Orchestrator mode: whether it is the view, and how many cards wait. */
  inbox?: { open: boolean; count: number }
  /**
   * What the centre terminal shows when it is not a tile: the orchestrator
   * agent. Its tools (Esc, paste, mic, copy) work as they do on a tile.
   */
  override?: SessionLabel | null
}

export interface SwitcherCallbacks {
  onOpen: () => void
  onNext: () => void
  /** Sends Escape to the terminal; a phone keyboard has no Esc key. */
  onEsc: () => void
  /** Reads the clipboard into the terminal; a phone has no Ctrl+V. */
  onPaste: () => void
  /** Opens the phone's file picker; a phone has nothing to drop a file from. */
  onAttach: () => void
  /** Starts or stops voice input. Left out where the browser cannot listen. */
  onMic?: () => void
  /** Opens the copy sheet; a finger cannot select text off a canvas. */
  onCopy: () => void
  /** Opens or leaves orchestrator mode; the bar's tab is easy to miss on a phone. */
  onInbox?: () => void
}

/**
 * Two rows. The first says where you are: the session in the centre, and the
 * way to the next finished one. The second holds the keys and gestures a
 * phone lacks. On a 360px phone that is too many buttons for one row: the
 * session's name was squeezed out entirely.
 */
export function renderSwitcher(container: HTMLElement, state: SwitcherState, cb: SwitcherCallbacks): void {
  const { done, listening } = state
  const label = state.override ?? describeSession(state.focused)
  // Something is in the centre to type into: a tile, or the orchestrator agent.
  const focused = state.focused !== null || !!state.override

  const nav = row('nav')
  const current = document.createElement('button')
  current.className = `current st-${label.status}`
  current.title = 'Switch session'
  current.setAttribute('aria-haspopup', 'dialog')
  const key = span('key', label.key)
  const nm = span('nm', label.name)
  const tag = span('tag', focused ? label.status : '')
  current.append(key, nm, tag, chevron())
  current.onclick = () => cb.onOpen()
  nav.append(current)

  const next = document.createElement('button')
  next.className = 'next'
  next.disabled = done === 0
  next.title = done > 0 ? `Next finished session (${done})` : 'No finished sessions'
  next.setAttribute('aria-label', next.title)
  next.innerHTML = icon('<path d="M5 3l6 5-6 5"/>')
  if (done > 0) next.append(span('badge', String(done)))
  next.onclick = () => cb.onNext()
  nav.append(next)

  if (cb.onInbox) {
    const onInbox = cb.onInbox
    const inbox = state.inbox ?? { open: false, count: 0 }
    const b = document.createElement('button')
    b.className = 'inbox-btn' + (inbox.open ? ' on' : '')
    b.title = inbox.open
      ? 'Leave orchestrator mode'
      : `Orchestrator${inbox.count ? ` (${inbox.count} waiting)` : ''}`
    b.setAttribute('aria-label', b.title)
    b.setAttribute('aria-pressed', String(inbox.open))
    b.innerHTML = icon(
      '<path d="M2 9.5l1.6-5.2a1 1 0 0 1 1-.7h6.8a1 1 0 0 1 1 .7L14 9.5V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>' +
      '<path d="M2 9.5h3.5l1 1.5h3l1-1.5H14"/>',
    )
    if (inbox.count > 0) b.append(span('badge asking', String(inbox.count)))
    b.onclick = () => onInbox()
    nav.append(b)
  }

  const tools = row('tools')
  const esc = tool('esc', 'Escape', focused ? 'Send Escape' : 'Focus a session to send Escape', !focused)
  esc.textContent = 'Esc'
  // Esc is usually pressed in the middle of typing, to interrupt Claude Code
  // or leave a menu. Moving focus to the button would hide the keyboard, so
  // the press does not take focus and the keyboard stays on the terminal.
  keepKeyboard(esc)
  esc.onclick = () => cb.onEsc()
  tools.append(esc)

  const paste = tool('paste', 'Paste', focused ? 'Paste from the clipboard' : 'Focus a session to paste', !focused)
  paste.innerHTML = icon(
    '<rect x="4" y="3" width="8" height="11" rx="1.5"/><path d="M6 3V2h4v1M6.5 7h3M6.5 10h3"/>',
  )
  paste.onclick = () => cb.onPaste()
  tools.append(paste)

  const attach = tool(
    'attach', 'Attach', focused ? 'Attach a photo or file' : 'Focus a session to attach a file', !focused,
  )
  attach.innerHTML = icon(
    '<path d="M13 7.5l-5.3 5.3a3.2 3.2 0 0 1-4.5-4.5L8.8 2.7a2.1 2.1 0 0 1 3 3L6.3 11.2a1 1 0 0 1-1.5-1.5L9.5 5"/>',
  )
  attach.onclick = () => cb.onAttach()
  tools.append(attach)

  if (cb.onMic) {
    const onMic = cb.onMic
    const mic = tool(
      'mic',
      listening ? 'Stop listening' : 'Talk',
      listening ? 'Stop listening and insert the words'
        : focused ? 'Talk: what you say is typed into the prompt' : 'Focus a session to talk',
      !focused && !listening,
    )
    mic.classList.toggle('listening', listening)
    mic.setAttribute('aria-pressed', String(listening))
    mic.innerHTML = icon(
      '<rect x="5.5" y="1.5" width="5" height="8" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15"/>',
    )
    // The words go in at the cursor, and the keyboard stays as it was.
    keepKeyboard(mic)
    mic.onclick = () => onMic()
    tools.append(mic)
  }

  const copy = tool('copy', 'Copy', focused ? 'Copy text off the screen' : 'Focus a session to copy', !focused)
  copy.innerHTML = icon(
    '<rect x="6" y="6" width="8" height="8" rx="1.5"/><path d="M4 10H3.5A1.5 1.5 0 0 1 2 8.5v-5A1.5 1.5 0 0 1 3.5 2h5A1.5 1.5 0 0 1 10 3.5V4"/>',
  )
  copy.onclick = () => cb.onCopy()
  tools.append(copy)

  container.replaceChildren(nav, tools)
}

function row(cls: string): HTMLElement {
  const el = document.createElement('div')
  el.className = `row ${cls}`
  return el
}

function tool(cls: string, label: string, title: string, disabled: boolean): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = cls
  b.disabled = disabled
  b.title = title
  b.setAttribute('aria-label', label)
  return b
}

/** A press that leaves focus, and so the phone keyboard, where it was. */
function keepKeyboard(b: HTMLButtonElement): void {
  b.onmousedown = (e) => e.preventDefault()
}

function span(cls: string, text: string): HTMLElement {
  const el = document.createElement('span')
  el.className = cls
  el.textContent = text
  return el
}

function chevron(): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'chev'
  wrap.innerHTML = icon('<path d="M4 6l4 4 4-4"/>')
  return wrap
}

function icon(body: string): string {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ` +
    `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

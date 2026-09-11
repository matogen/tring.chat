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

export interface SwitcherCallbacks {
  onOpen: () => void
  onNext: () => void
}

export function renderSwitcher(
  container: HTMLElement,
  focused: SessionInfo | null,
  done: number,
  cb: SwitcherCallbacks,
): void {
  container.replaceChildren()
  const label = describeSession(focused)

  const current = document.createElement('button')
  current.className = `current st-${label.status}`
  current.title = 'Switch session'
  current.setAttribute('aria-haspopup', 'dialog')
  const key = span('key', label.key)
  const nm = span('nm', label.name)
  const tag = span('tag', focused ? label.status : '')
  current.append(key, nm, tag, chevron())
  current.onclick = () => cb.onOpen()
  container.append(current)

  const next = document.createElement('button')
  next.className = 'next'
  next.disabled = done === 0
  next.title = done > 0 ? `Next finished session (${done})` : 'No finished sessions'
  next.setAttribute('aria-label', next.title)
  next.innerHTML = icon('<path d="M5 3l6 5-6 5"/>')
  if (done > 0) next.append(span('badge', String(done)))
  next.onclick = () => cb.onNext()
  container.append(next)
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

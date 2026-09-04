import type { ProjectInfo, UpdateInfo } from '@tring/shared/protocol'
import { isEnabled, setEnabled } from './sound.ts'
import { isEnabled as usageEnabled } from './usage-panel.ts'

export interface BarCallbacks {
  onSelect: (projectId: string) => void
  onAdd: () => void
  onContext: (projectId: string, at: { x: number; y: number }) => void
  onUpdate: (update: UpdateInfo) => void
  onSoundToggle: () => void
  onSettings: () => void
  onUsage: () => void
}

/**
 * Fixed 36px bar (spec §5.6). Never hidden: its badges are the only way a
 * finished agent in a project you are not looking at becomes visible, so the
 * permanent ambient signal is the point rather than overhead.
 */
export function renderBar(
  container: HTMLElement,
  projects: ProjectInfo[],
  viewedId: string | null,
  cb: BarCallbacks,
  update?: UpdateInfo | null,
  usageActive = false,
): void {
  container.replaceChildren()

  const logo = document.createElement('div')
  logo.className = 'logo'
  logo.title = 'tring'
  for (let i = 0; i < 9; i++) logo.append(document.createElement('i'))
  container.append(logo)

  for (const p of projects) {
    const done = p.sessions.filter((s) => s.status === 'done').length
    const tab = document.createElement('button')
    // Only one tab is active at a time, and the usage view is a tab.
    tab.className = 'tab' + (!usageActive && p.id === viewedId ? ' active' : '')
    tab.title = p.root

    const nm = document.createElement('span')
    nm.className = 'nm'
    nm.textContent = p.name
    tab.append(nm)

    if (done > 0) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = String(done)
      tab.append(badge)
    }

    tab.onclick = () => cb.onSelect(p.id)
    tab.oncontextmenu = (e) => {
      e.preventDefault()
      cb.onContext(p.id, { x: e.clientX, y: e.clientY })
    }
    container.append(tab)
  }

  // Pinned, and never a project: it owns no slots, no root and no shells.
  if (usageEnabled()) {
    const tab = document.createElement('button')
    tab.className = 'tab pinned' + (usageActive ? ' active' : '')
    tab.title = 'Claude usage'
    const nm = document.createElement('span')
    nm.className = 'nm'
    nm.textContent = 'Usage'
    tab.append(nm)
    tab.onclick = () => cb.onUsage()
    container.append(tab)
  }

  const add = document.createElement('button')
  add.className = 'add'
  add.textContent = '+'
  add.title = 'New project'
  add.onclick = () => cb.onAdd()
  container.append(add)

  const sound = document.createElement('button')
  sound.className = 'iconbtn' + (isEnabled() ? ' on' : '')
  sound.innerHTML = bellSvg(isEnabled())
  sound.title = isEnabled() ? 'Sound on — click to mute' : 'Sound off — click to unmute'
  sound.setAttribute('aria-label', sound.title)
  sound.setAttribute('aria-pressed', String(isEnabled()))
  sound.onclick = () => {
    setEnabled(!isEnabled())
    cb.onSoundToggle()
  }
  sound.style.marginLeft = update ? '0' : 'auto'
  container.append(sound)

  const settings = document.createElement('button')
  settings.className = 'iconbtn'
  settings.innerHTML = gearSvg()
  settings.title = 'Settings'
  settings.setAttribute('aria-label', settings.title)
  settings.onclick = () => cb.onSettings()
  container.append(settings)

  if (update) {
    // Deliberately not mint: this is not a finished agent, and the one colour
    // that means "done" stays reserved for that (spec §5.1).
    const notice = document.createElement('button')
    notice.className = 'update'
    notice.textContent = `v${update.latest} available`
    notice.title = `You are on ${update.current}`
    notice.onclick = () => cb.onUpdate(update)
    container.insertBefore(notice, sound)
  }
}

/**
 * A cog, not a sun. The teeth belong to the body — a circle with detached
 * radial spokes is the universal brightness icon, which is what this was.
 * Six teeth rather than eight: at this size eight turn to mush.
 */
function gearSvg(): string {
  const cog =
    'M6.09 3.71 L6.43 1.18 L9.57 1.18 L9.91 3.71 L10.76 4.2 L13.12 ' +
    '3.23 L14.69 5.95 L12.67 7.51 L12.67 8.49 L14.69 10.05 L13.12 ' +
    '12.77 L10.76 11.8 L9.91 12.29 L9.57 14.82 L6.43 14.82 L6.09 ' +
    '12.29 L5.24 11.8 L2.88 12.77 L1.31 10.05 L3.33 8.49 L3.33 ' +
    '7.51 L1.31 5.95 L2.88 3.23 L5.24 4.2 Z'
  return icon(`<path d="${cog}"/><circle cx="8" cy="8" r="2.4"/>`)
}

/**
 * Drawn 1:1 with the viewBox. At 14px a 16-unit box scales by 0.875, so every
 * coordinate and the stroke itself land between device pixels and the whole
 * icon reads soft — the cheapest sharpness there is.
 */
function icon(body: string): string {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ` +
    `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

function bellSvg(on: boolean): string {
  const bell =
    '<path d="M8 2a3 3 0 0 1 3 3v3l1.4 2.1a.5.5 0 0 1-.4.8H4a.5.5 0 0 1-.4-.8L5 8V5a3 3 0 0 1 3-3z"/>' +
    '<path d="M6.6 12.6a1.5 1.5 0 0 0 2.8 0"/>'
  const slash = on ? '' : '<path d="M2.5 2.5l11 11"/>'
  return icon(`${bell}${slash}`)
}

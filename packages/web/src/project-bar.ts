import type { ProjectInfo, UpdateInfo } from '@tring/shared/protocol'
import { isEnabled, setEnabled } from './sound.ts'

export interface BarCallbacks {
  onSelect: (projectId: string) => void
  onAdd: () => void
  onContext: (projectId: string, at: { x: number; y: number }) => void
  onUpdate: (update: UpdateInfo) => void
  onSoundToggle: () => void
  onSettings: () => void
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
    tab.className = 'tab' + (p.id === viewedId ? ' active' : '')
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

function gearSvg(): string {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" ` +
    `stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">` +
    `<circle cx="8" cy="8" r="2.3"/>` +
    `<path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8` +
    `M3.34 3.34l1.27 1.27M11.39 11.39l1.27 1.27` +
    `M12.66 3.34l-1.27 1.27M4.61 11.39l-1.27 1.27"/></svg>`
}

function bellSvg(on: boolean): string {
  const bell =
    '<path d="M8 2a3 3 0 0 1 3 3v3l1.4 2.1a.5.5 0 0 1-.4.8H4a.5.5 0 0 1-.4-.8L5 8V5a3 3 0 0 1 3-3z"/>' +
    '<path d="M6.6 12.6a1.5 1.5 0 0 0 2.8 0"/>'
  const slash = on ? '' : '<path d="M2.5 2.5l11 11"/>'
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" ` +
    `stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${bell}${slash}</svg>`
}

import type { ProjectInfo, UpdateInfo } from '@tring/shared/protocol'

export interface BarCallbacks {
  onSelect: (projectId: string) => void
  onAdd: () => void
  onContext: (projectId: string, at: { x: number; y: number }) => void
  onUpdate: (update: UpdateInfo) => void
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

  if (update) {
    // Deliberately not mint: this is not a finished agent, and the one colour
    // that means "done" stays reserved for that (spec §5.1).
    const notice = document.createElement('button')
    notice.className = 'update'
    notice.textContent = `v${update.latest} available`
    notice.title = `You are on ${update.current}`
    notice.onclick = () => cb.onUpdate(update)
    container.append(notice)
  }
}

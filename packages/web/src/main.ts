import '@fontsource/inter/400.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@xterm/xterm/css/xterm.css'
import './theme.css'
import './style.css'

import type { ProjectInfo, ServerMessage, SessionInfo } from '@tring/shared/protocol'
import { actionForEvent, isPrefix, legendForSlot, slotForEvent, SLOT_COUNT } from '@tring/shared/keymap'
import { WsClient } from './ws-client.ts'
import { FocusTerminal } from './focus-terminal.ts'
import { Thumbnail } from './thumbnail.ts'
import { placeInGrid } from './ring-layout.ts'
import { renderBar } from './project-bar.ts'
import * as ui from './overlay.ts'

const barEl = document.getElementById('bar') as HTMLElement
const ringEl = document.getElementById('ring') as HTMLElement

let projects: ProjectInfo[] = []
let viewedId: string | null = null
let focusedId: string | null = null
let prevFocusedId: string | null = null
let ringSig = ''
let askedForFirstProject = false
let overlayMode: 'picker' | 'projects' | null = null

const thumbs = new Map<string, Thumbnail>()
const tiles = new Map<number, HTMLElement>()

/* ---------- terminal ---------- */

const focusCell = document.createElement('div')
focusCell.className = 'focus-cell'
const focusTerm = new FocusTerminal(focusCell)

const ws = new WsClient({
  onOpen: () => hideToast(),
  onClose: () => showToast('daemon disconnected — reconnecting'),
  onOutput: (id, data) => { if (id === focusedId) focusTerm.write(data) },
  onMessage: handleMessage,
})

focusTerm.onInput = (data) => {
  if (focusedId) ws.send({ type: 'input', id: focusedId, data })
}
// The prefix never reaches the PTY, and nothing reaches it while an overlay
// is up (spec §5.4).
focusTerm.shouldSendKey = (e) => !ui.isOpen() && !isPrefix(e)

/* ---------- state ---------- */

const viewed = (): ProjectInfo | null => projects.find((p) => p.id === viewedId) ?? null
const sessions = (): SessionInfo[] => viewed()?.sessions ?? []
const sessionAt = (slot: number): SessionInfo | undefined => sessions().find((s) => s.slot === slot)
const sessionById = (id: string): SessionInfo | undefined =>
  projects.flatMap((p) => p.sessions).find((s) => s.id === id)

/** Global across every project: the title's job is to reach you elsewhere. */
const globalDone = (): number =>
  projects.reduce((n, p) => n + p.sessions.filter((s) => s.status === 'done').length, 0)

function handleMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'state': {
      projects = msg.projects
      viewedId = msg.activeProjectId ?? projects[0]?.id ?? null
      render()
      maybeAskForFirstProject()
      break
    }
    case 'status': {
      const s = sessionById(msg.id)
      if (s) {
        s.status = msg.status
        s.since = msg.since
        s.title = msg.title
      }
      paintStatuses()
      break
    }
    case 'screen':
      if (msg.id === focusedId) focusTerm.replay(msg.ansi)
      break
    case 'snapshot': {
      thumbs.get(msg.id)?.paint(msg.snapshot)
      break
    }
    case 'exit':
      paintStatuses()
      break
    case 'error':
      showToast(msg.message)
      break
  }
}

/* ---------- render ---------- */

function render(): void {
  renderBar(barEl, projects, viewedId, {
    onSelect: (id) => activateProject(id),
    onAdd: () => promptNewProject(false),
    onContext: (id) => projectMenu(id),
  })
  renderRing()
  paintStatuses()
}

/** Rebuild tiles only when the slot layout actually changed, so repainting a
 *  thumbnail never has its canvas pulled out from under it. */
function renderRing(): void {
  const sig = `${viewedId}|` + sessions().map((s) => `${s.slot}:${s.id}`).sort().join(',')
  if (sig === ringSig) return
  ringSig = sig

  ringEl.replaceChildren(focusCell)
  tiles.clear()
  thumbs.clear()

  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const s = sessionAt(slot)
    const tile = document.createElement('button')
    tile.className = 'tile'
    placeInGrid(tile, slot)

    if (!s) {
      tile.classList.add('empty')
      tile.textContent = `+ ${legendForSlot(slot)}`
      tile.onclick = () => promptNewSession(slot)
    } else {
      const canvas = document.createElement('canvas')
      tile.append(canvas)
      thumbs.set(s.id, new Thumbnail(canvas))

      const meta = document.createElement('div')
      meta.className = 'meta'
      const key = document.createElement('span')
      key.className = 'key'
      key.textContent = String(slot)
      const nm = document.createElement('span')
      nm.className = 'nm'
      nm.textContent = s.name ?? s.title ?? 'shell'
      const cwd = document.createElement('span')
      cwd.className = 'cwd'
      cwd.textContent = s.cwd.split('/').filter(Boolean).pop() ?? ''
      meta.append(key, nm, cwd)
      tile.append(meta)
      tile.title = `${legendForSlot(slot)} — ${s.cwd}`
      tile.onclick = () => focusSession(s.id)
    }

    tiles.set(slot, tile)
    ringEl.append(tile)
  }
  requestAnimationFrame(() => fitTerminal())
}

function paintStatuses(): void {
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const tile = tiles.get(slot)
    if (!tile) continue
    const s = sessionAt(slot)
    tile.classList.remove('st-idle', 'st-busy', 'st-done', 'st-exited', 'viewing')
    if (s) {
      tile.classList.add(`st-${s.status}`)
      if (s.id === focusedId) tile.classList.add('viewing')
    }
  }
  renderBar(barEl, projects, viewedId, {
    onSelect: (id) => activateProject(id),
    onAdd: () => promptNewProject(false),
    onContext: (id) => projectMenu(id),
  })
  const done = globalDone()
  document.title = done > 0 ? `(${done}) tring` : 'tring'
}

/* ---------- actions ---------- */

function fitTerminal(): void {
  const { cols, rows } = focusTerm.fitNow()
  if (focusedId) ws.send({ type: 'resize', cols, rows })
  for (const t of thumbs.values()) t.refresh()
}

function focusSession(id: string | null): void {
  if (id && id === focusedId) return
  if (focusedId) prevFocusedId = focusedId
  focusedId = id
  if (!id) {
    focusTerm.clear()
    paintStatuses()
    return
  }
  const { cols, rows } = focusTerm.fitNow()
  ws.send({ type: 'focus', id, cols, rows })
  focusTerm.focus()
  paintStatuses()
}

function focusSlot(slot: number): void {
  const s = sessionAt(slot)
  if (s) focusSession(s.id)
  else promptNewSession(slot)
}

function activateProject(id: string): void {
  if (id === viewedId) return
  viewedId = id
  focusedId = null
  focusTerm.clear()
  ws.send({ type: 'activateProject', projectId: id })
}

function nextDone(): void {
  const list = sessions()
  const current = sessionAt(sessionById(focusedId ?? '')?.slot ?? 0)
  const start = current?.slot ?? 0
  for (let i = 1; i <= SLOT_COUNT; i++) {
    const slot = ((start + i - 1) % SLOT_COUNT) + 1
    const s = list.find((x) => x.slot === slot)
    if (s?.status === 'done') return focusSession(s.id)
  }
}

function promptNewSession(slot: number): void {
  const project = viewed()
  if (!project) return
  ui.openNewSessionDialog({ cwd: project.root, slot }, (v) => {
    ws.send({ type: 'create', projectId: project.id, slot, cwd: v.cwd, ...(v.command ? { command: v.command } : {}), ...(v.name ? { name: v.name } : {}) })
  })
}

function promptNewProject(blocking: boolean): void {
  ui.openProjectDialog(
    { title: blocking ? 'Create your first project' : 'New project', root: '', blocking },
    (name, root) => ws.send({ type: 'createProject', name, root }),
  )
}

function projectMenu(id: string): void {
  const p = projects.find((x) => x.id === id)
  if (!p) return
  ui.openProjectDialog(
    { title: 'Rename project', name: p.name, root: p.root, rootLocked: true },
    (name) => ws.send({ type: 'renameProject', projectId: id, name }),
  )
}

function maybeAskForFirstProject(): void {
  if (projects.length > 0) { askedForFirstProject = false; return }
  if (askedForFirstProject || ui.isOpen()) return
  askedForFirstProject = true
  promptNewProject(true)
}

/* ---------- keys (spec §5.5) ---------- */

document.addEventListener('keydown', (e) => {
  if (ui.isOpen()) return pickerKey(e)

  if (isPrefix(e)) {
    e.preventDefault()
    overlayMode = 'picker'
    ui.openPicker(viewed(), projects, globalDone(), {
      onPickSlot: (slot) => focusSlot(slot),
      onPickProject: (id) => activateProject(id),
    })
  }
})

function pickerKey(e: KeyboardEvent): void {
  if (overlayMode === null) return // a dialog is up; let it have its keys

  if (overlayMode === 'projects') {
    const n = Number(e.key)
    if (n >= 1 && n <= 9 && projects[n - 1]) {
      e.preventDefault()
      const target = projects[n - 1]!
      ui.close()
      overlayMode = null
      activateProject(target.id)
      return
    }
  }

  const slot = slotForEvent(e)
  if (slot !== null && overlayMode === 'picker') {
    e.preventDefault()
    ui.close()
    overlayMode = null
    focusSlot(slot)
    return
  }

  if (isPrefix(e) || e.code === 'Space') {
    e.preventDefault()
    ui.close()
    overlayMode = null
    if (prevFocusedId) focusSession(prevFocusedId)
    return
  }

  const action = actionForEvent(e)
  if (!action) return
  e.preventDefault()
  const current = focusedId ? sessionById(focusedId) : undefined

  switch (action) {
    case 'close':
      ui.close()
      overlayMode = null
      break
    case 'next-done':
      ui.close(); overlayMode = null; nextDone()
      break
    case 'projects':
      ui.close()
      overlayMode = 'projects'
      ui.openProjectPicker(projects, (id) => { overlayMode = null; activateProject(id) })
      break
    case 'new-session': {
      ui.close(); overlayMode = null
      const empty = [...Array(SLOT_COUNT)].map((_, i) => i + 1).find((s) => !sessionAt(s))
      if (empty) promptNewSession(empty)
      else showToast('all 16 slots are full')
      break
    }
    case 'rename':
      if (!current) break
      ui.close(); overlayMode = null
      ui.openPrompt('Rename session', current.name ?? '', (name) =>
        ws.send({ type: 'rename', id: current.id, name }))
      break
    case 'kill':
      if (!current) break
      ui.close(); overlayMode = null
      ui.openConfirm('Kill session', `Slot ${current.slot} — ${current.cwd}`, () =>
        ws.send({ type: 'kill', id: current.id }))
      break
    case 'mark-seen':
      if (current) ws.send({ type: 'ack', id: current.id })
      ui.close(); overlayMode = null
      break
  }
}

/* ---------- misc ---------- */

let toast: HTMLElement | null = null
function showToast(message: string): void {
  hideToast()
  toast = document.createElement('div')
  toast.id = 'toast'
  toast.textContent = message
  document.body.append(toast)
}
function hideToast(): void {
  toast?.remove()
  toast = null
}

window.addEventListener('resize', () => fitTerminal())
ws.connect()

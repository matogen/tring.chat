import '@fontsource/inter/400.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@xterm/xterm/css/xterm.css'
import './theme.css'
import './style.css'

import type { ProjectInfo, ServerMessage, SessionInfo, UpdateInfo } from '@tring/shared/protocol'
import { actionForEvent, isPrefix, legendForSlot, slotForEvent } from '@tring/shared/keymap'
import { WsClient } from './ws-client.ts'
import { FocusTerminal } from './focus-terminal.ts'
import { Thumbnail } from './thumbnail.ts'
import {
  applyRing, placeInGrid, RING_SIZES, ringSize, setRingSize, type RingSize,
} from './ring-layout.ts'
import { renderBar } from './project-bar.ts'
import * as ui from './overlay.ts'
import { tring } from './sound.ts'

const barEl = document.getElementById('bar') as HTMLElement
const ringEl = document.getElementById('ring') as HTMLElement

let projects: ProjectInfo[] = []
let viewedId: string | null = null
let focusedId: string | null = null
let prevFocusedId: string | null = null
let ringSig = ''
let askedForFirstProject = false
let overlayMode: 'picker' | 'projects' | null = null
let update: UpdateInfo | null = null

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

/**
 * The ring you chose, grown to fit if the viewed project holds sessions in
 * higher slots. A restored project can arrive with slot 13 occupied long after
 * you picked a ring of 8, and a running session that renders nowhere — still
 * ringing, still counted in the tab badge — is the one outcome worth spending
 * code to make impossible.
 */
function effectiveSize(): RingSize {
  const highest = Math.max(0, ...sessions().map((s) => s.slot))
  return RING_SIZES.find((n) => n >= highest && n >= ringSize()) ?? RING_SIZES[RING_SIZES.length - 1]!
}

/** Global across every project: the title's job is to reach you elsewhere. */
const globalDone = (): number =>
  projects.reduce((n, p) => n + p.sessions.filter((s) => s.status === 'done').length, 0)

function handleMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'state': {
      projects = msg.projects
      update = msg.update ?? update
      viewedId = msg.activeProjectId ?? projects[0]?.id ?? null
      render()
      maybeAskForFirstProject()
      break
    }
    case 'status': {
      const s = sessionById(msg.id)
      const was = s?.status
      if (s) {
        s.status = msg.status
        s.since = msg.since
        s.title = msg.title
      }
      // Only on the transition, and only from a live `status` message — the
      // `state` sent on connect is full of already-finished sessions, and
      // chiming for those would ring on every page load. `notable` filters out
      // an app that merely finished starting up.
      if (msg.status === 'done' && was !== 'done' && msg.notable) tring()
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

const barCallbacks = () => ({
  onSelect: (id: string) => activateProject(id),
  onAdd: () => promptNewProject(false),
  onContext: (id: string) => projectMenu(id),
  onUpdate: (u: UpdateInfo) => ui.openUpdateNotice(u.current, u.latest),
  onSoundToggle: () => paintStatuses(),
  onSettings: () => ui.openSettingsDialog(ringSize(), changeRingSize),
})

function render(): void {
  renderBar(barEl, projects, viewedId, barCallbacks(), update)
  renderRing()
  paintStatuses()
}

/** Rebuild tiles only when the slot layout actually changed, so repainting a
 *  thumbnail never has its canvas pulled out from under it. */
function renderRing(): void {
  const size = effectiveSize()
  const sig = `${viewedId}|${size}|` + sessions().map((s) => `${s.slot}:${s.id}`).sort().join(',')
  if (sig === ringSig) return
  ringSig = sig

  applyRing(ringEl, focusCell, size)
  ringEl.replaceChildren(focusCell)
  tiles.clear()
  thumbs.clear()

  for (let slot = 1; slot <= size; slot++) {
    const s = sessionAt(slot)
    // A div, not a button: tiles carry their own action button, and nesting
    // buttons is invalid markup that swallows the inner click in some engines.
    const tile = document.createElement('div')
    tile.className = 'tile'
    tile.tabIndex = 0
    placeInGrid(tile, slot, size)

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

      const action = respawnAction(s)
      if (action) {
        const btn = document.createElement('button')
        btn.className = 'tile-action'
        btn.textContent = action.label
        btn.title = action.title
        btn.onclick = (e) => {
          e.stopPropagation()
          ws.send({ type: 'respawn', id: s.id })
        }
        tile.append(btn)
      }
    }

    tiles.set(slot, tile)
    ringEl.append(tile)
  }
  requestAnimationFrame(() => fitTerminal())
}

/**
 * A dead tile offers a restart in place (spec §4.2), and a session carrying a
 * command it has not run — the shape every restored session has, since restore
 * deliberately spawns a plain shell — offers that command as a one-key re-run.
 */
function respawnAction(s: SessionInfo): { label: string; title: string } | null {
  if (s.status === 'exited') {
    return {
      label: '\u21bb',
      title: s.command ? `Restart: ${s.command}` : `Restart shell (exit ${s.exitCode ?? '?'})`,
    }
  }
  if (s.command && s.status === 'idle') {
    return { label: '\u25b8', title: `Run: ${s.command}` }
  }
  return null
}

function paintStatuses(): void {
  for (let slot = 1; slot <= effectiveSize(); slot++) {
    const tile = tiles.get(slot)
    if (!tile) continue
    const s = sessionAt(slot)
    tile.classList.remove('st-idle', 'st-busy', 'st-done', 'st-exited', 'viewing')
    if (s) {
      tile.classList.add(`st-${s.status}`)
      if (s.id === focusedId) tile.classList.add('viewing')
    }
  }
  renderBar(barEl, projects, viewedId, barCallbacks(), update)
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

function changeRingSize(size: RingSize): void {
  setRingSize(size)
  render()
  const shown = effectiveSize()
  if (shown !== size) {
    showToast(`slots above ${size} are still in use — the ring stays at ${shown} until they are closed`)
  } else {
    hideToast()
  }
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
  const size = effectiveSize()
  for (let i = 1; i <= size; i++) {
    const slot = ((start + i - 1) % size) + 1
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
    {
      title: 'Project settings',
      name: p.name,
      root: p.root,
      rootLocked: true,
      onDelete: () => {
        const n = p.sessions.length
        ui.openConfirm(
          `Delete ${p.name}?`,
          n > 0
            ? `This kills ${n} session${n === 1 ? '' : 's'} in this project.`
            : 'This project has no running sessions.',
          () => ws.send({ type: 'deleteProject', projectId: id }),
        )
      },
    },
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
  // The keymap always binds all 16; a smaller ring simply has no slot 13.
  if (slot !== null && slot <= effectiveSize() && overlayMode === 'picker') {
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
      const size = effectiveSize()
      const empty = [...Array(size)].map((_, i) => i + 1).find((s) => !sessionAt(s))
      if (empty) promptNewSession(empty)
      else showToast(`all ${size} slots are full`)
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

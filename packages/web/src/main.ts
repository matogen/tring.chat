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
import * as usage from './usage-panel.ts'
import * as ui from './overlay.ts'
import { tring } from './sound.ts'

const barEl = document.getElementById('bar') as HTMLElement
const ringEl = document.getElementById('ring') as HTMLElement
const usageEl = document.getElementById('usage') as HTMLElement

let projects: ProjectInfo[] = []
let viewedId: string | null = null
let focusedId: string | null = null
let prevFocusedId: string | null = null
let ringSig = ''
let askedForFirstProject = false
let overlayMode: 'picker' | 'projects' | null = null
let update: UpdateInfo | null = null
let viewMode: 'ring' | 'usage' = 'ring'
let usageTimer: ReturnType<typeof setInterval> | null = null

const thumbs = new Map<string, Thumbnail>()
const tiles = new Map<number, HTMLElement>()
/** Project id -> the session you were last in, so switching back returns you. */
const lastFocused = new Map<string, string>()
let restoreFocusFor: string | null = null

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
      restoreProjectFocus()
      if (usage.wasActive()) showUsage()
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
  onSettings: () => openSettings(),
  onUsage: () => showUsage(),
})

const paintBar = (): void =>
  renderBar(barEl, projects, viewedId, barCallbacks(), update, viewMode === 'usage')

function render(): void {
  paintBar()
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
  // Detaching the focus cell would take the live terminal's canvas out of the
  // document; re-attaching it does not repaint, so the previous session's
  // pixels can survive a rebuild. Only the tiles are replaced.
  for (const child of Array.from(ringEl.children)) {
    if (child !== focusCell) child.remove()
  }
  if (focusCell.parentElement !== ringEl) ringEl.append(focusCell)
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

      // Only the parts that cannot change while this session holds the slot.
      // Everything else is paintTile's, or it goes stale behind this guard.
      const meta = document.createElement('div')
      meta.className = 'meta'
      const key = document.createElement('span')
      key.className = 'key'
      key.textContent = String(slot)
      meta.append(key, span('nm'), span('cwd'))
      tile.append(meta)
      tile.onclick = () => focusSession(s.id)
      tile.oncontextmenu = (e) => {
        e.preventDefault()
        sessionMenu(s.id)
      }

      const btn = document.createElement('button')
      btn.className = 'tile-action'
      btn.onclick = (e) => {
        e.stopPropagation()
        ws.send({ type: 'respawn', id: s.id })
      }
      tile.append(btn)

      paintTile(tile, s)
    }

    tiles.set(slot, tile)
    ringEl.append(tile)
  }
  requestAnimationFrame(() => fitTerminal())
}

const span = (cls: string): HTMLElement => {
  const el = document.createElement('span')
  el.className = cls
  return el
}

/**
 * Everything about a tile that can change while the session keeps its slot.
 *
 * renderRing rebuilds only when the slot layout does, so a thumbnail's canvas
 * is never pulled out from under it — which means a rename, a new window
 * title, a `cd` or an exit reach the tile through here or not at all.
 */
function paintTile(tile: HTMLElement, s: SessionInfo | undefined): void {
  tile.classList.remove('st-idle', 'st-busy', 'st-done', 'st-exited', 'viewing')
  tile.style.removeProperty('--tint')
  if (!s) return

  tile.classList.add(`st-${s.status}`)
  if (s.id === focusedId) tile.classList.add('viewing')
  if (s.color) tile.style.setProperty('--tint', s.color)

  const nm = tile.querySelector<HTMLElement>('.nm')
  if (nm) nm.textContent = s.name ?? s.title ?? 'shell'
  const cwd = tile.querySelector<HTMLElement>('.cwd')
  if (cwd) cwd.textContent = s.cwd.split('/').filter(Boolean).pop() ?? ''
  tile.title = `${legendForSlot(s.slot)} — ${s.cwd}`

  const btn = tile.querySelector<HTMLButtonElement>('.tile-action')
  const action = respawnAction(s)
  if (!btn) return
  btn.hidden = !action
  if (action) {
    btn.textContent = action.label
    btn.title = action.title
  }
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
    paintTile(tile, sessionAt(slot))
  }
  paintBar()
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
  showRing()
  if (id && id === focusedId) return
  if (focusedId) prevFocusedId = focusedId
  focusedId = id
  if (!id) {
    focusTerm.clear()
    paintStatuses()
    return
  }
  const s = sessionById(id)
  if (s) lastFocused.set(s.projectId, id)
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

/**
 * A view mode, not a project: it owns no slots, spawns nothing and persists
 * nothing on the daemon. Only the centre of the window changes.
 */
function showUsage(): void {
  if (viewMode === 'usage') return
  viewMode = 'usage'
  ringEl.hidden = true
  usageEl.hidden = false
  usage.renderUsage(usageEl, null, null)
  void refreshUsage()
  usageTimer = setInterval(() => void refreshUsage(), 30_000)
  usage.setActive(true)
  paintBar()
}

function showRing(): void {
  if (viewMode === 'ring') return
  viewMode = 'ring'
  if (usageTimer) clearInterval(usageTimer)
  usageTimer = null
  usageEl.hidden = true
  ringEl.hidden = false
  usage.setActive(false)
  paintBar()
  requestAnimationFrame(() => fitTerminal())
}

async function refreshUsage(): Promise<void> {
  if (viewMode !== 'usage') return
  try {
    usage.renderUsage(usageEl, await usage.fetchUsage(), null)
  } catch (err) {
    usage.renderUsage(usageEl, null, (err as Error).message)
  }
}

function openSettings(): void {
  ui.openSettingsDialog(
    { ring: ringSize(), usage: usage.isEnabled(), budgets: usage.getBudgets() },
    (v) => {
      if (v.usage !== usage.isEnabled()) {
        usage.setEnabled(v.usage)
        if (!v.usage) showRing()
      }
      usage.setBudgets(v.budgets)
      if (v.ring !== ringSize()) changeRingSize(v.ring)
      else { paintBar(); void refreshUsage() }
    },
  )
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
  showRing()
  if (id === viewedId) return
  viewedId = id
  focusedId = null
  focusTerm.clear()
  // The project's sessions arrive with the next `state`, so the session to
  // return to can only be chosen once they do.
  restoreFocusFor = id
  ws.send({ type: 'activateProject', projectId: id })
}

/** Puts you back in the session you were last using in this project. */
function restoreProjectFocus(): void {
  const want = restoreFocusFor
  if (!want || want !== viewedId) return
  restoreFocusFor = null
  const id = lastFocused.get(want)
  if (id && sessions().some((s) => s.id === id)) focusSession(id)
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

/** Right-clicking a tile: the two things that belong to the tile itself. */
function sessionMenu(id: string): void {
  const s = sessionById(id)
  if (!s) return
  ui.openSessionDialog(s, (v) => {
    if (v.name !== (s.name ?? '')) ws.send({ type: 'rename', id, name: v.name })
    if (v.color !== s.color) ws.send({ type: 'color', id, color: v.color })
  })
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
    showRing()
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
      sessionMenu(current.id)
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

import '@fontsource/inter/400.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@xterm/xterm/css/xterm.css'
import './theme.css'
import './style.css'

import type {
  AgentInfo, ProjectInfo, ScreenSnapshot, ServerMessage, SessionInfo, UpdateInfo,
} from '@tring/shared/protocol'
import { actionForEvent, isPrefix, legendForSlot, slotForEvent } from '@tring/shared/keymap'
import { api, apiPost, uploadFile, WsClient } from './ws-client.ts'
import { InboxPanel } from './inbox-panel.ts'
import { FocusTerminal } from './focus-terminal.ts'
import { DiffPanel } from './diff-panel.ts'
import { followFocus } from './focus-target.ts'
import { attachFileDrop, filePicker, insertFiles, refuseStrayDrops } from './drop.ts'
import { Dictation, recognitionFactory } from './dictation.ts'
import { attachTileDrag } from './tile-drag.ts'
import { attachImagePaste, pasteFromClipboard, type PasteOptions } from './paste.ts'
import { copyToClipboard, recentLinks, screenText } from './copy.ts'
import { Thumbnail } from './thumbnail.ts'
import {
  applyRing, placeInGrid, RING_SIZES, ringSize, setRingSize, type RingSize,
} from './ring-layout.ts'
import { renderBar } from './project-bar.ts'
import { MOBILE_QUERY, renderSwitcher } from './switcher.ts'
import * as usage from './usage-panel.ts'
import * as ui from './overlay.ts'
import { tring } from './sound.ts'

const barEl = document.getElementById('bar') as HTMLElement
const switcherEl = document.getElementById('switcher') as HTMLElement
const ringEl = document.getElementById('ring') as HTMLElement
const usageEl = document.getElementById('usage') as HTMLElement

let projects: ProjectInfo[] = []
let viewedId: string | null = null
let focusedId: string | null = null
/** The focused session's slot, which outlives its id across a respawn. */
let focusedSlot: number | null = null
let prevFocusedId: string | null = null
let ringSig = ''
let askedForFirstProject = false
let overlayMode: 'picker' | 'projects' | null = null
let update: UpdateInfo | null = null
let viewMode: 'ring' | 'usage' = 'ring'
let usageTimer: ReturnType<typeof setInterval> | null = null
/** The phone view: no ring, a switcher bar instead (spec §5.11). */
const mobile = window.matchMedia(MOBILE_QUERY)

const thumbs = new Map<string, Thumbnail>()
/** The last screen seen per session, so a rebuilt tile is not born blank. */
const lastShots = new Map<string, ScreenSnapshot>()
const tiles = new Map<number, HTMLElement>()
/** Project id -> the session you were last in, so switching back returns you. */
const lastFocused = new Map<string, string>()
let restoreFocusFor: string | null = null
/**
 * On a phone a session you just created has no tile to tap, so it is focused
 * the moment it arrives. Desktop keeps focus explicit: the ring never moves you.
 */
let focusOnArrival: number | null = null

/* ---------- terminal ---------- */

const focusCell = document.createElement('div')
focusCell.className = 'focus-cell'
// The terminal gets a host of its own so the diff panel can sit beside it in
// the same cell. The panel is built first: the terminal's initial fit then
// already sees the width the panel leaves it.
const termHost = document.createElement('div')
termHost.className = 'term-host'
focusCell.append(termHost)
const diffPanel = new DiffPanel(focusCell, () => fitTerminal())
const focusTerm = new FocusTerminal(termHost)
// Orchestrator mode: laid over the terminal, never instead of it, so the
// WebGL canvas stays attached and comes back exactly as it was.
const inboxPanel = new InboxPanel(focusCell, {
  label: (id) => {
    const s = sessionById(id)
    if (!s) return null
    const project = projects.find((p) => p.id === s.projectId)
    return {
      name: s.name ?? s.title ?? 'shell',
      slot: s.slot,
      color: s.color,
      elsewhere: s.projectId !== viewedId ? project?.name ?? 'another project' : null,
    }
  },
  onAnswer: (itemId, decision, extra) => ws.send({ type: 'answer', itemId, decision, ...extra }),
  onReply: (itemId, text) => ws.send({ type: 'reply', itemId, text }),
  onOpen: (id) => openFromInbox(id),
  hooks: () => api<{ installed: boolean; path: string }>('/api/hooks'),
  installHooks: async () => { await apiPost('/api/hooks') },
  onAuto: (enabled) => ws.send({ type: 'autoAnswer', enabled }),
  onAgent: (change) => ws.send({ type: 'agent', ...change }),
  onLayout: () => fitTerminal(),
})
/** The first `inbox` after connecting is the backlog, not news worth a chime. */
let inboxSeen = false

/**
 * The orchestrator agent (off unless switched on in the inbox). While
 * orchestrator mode is up and the agent is running, the centre terminal is
 * the agent's and the cards sit beside it; everything else about the ring —
 * the focused tile, its slot, the picker — carries on underneath unchanged.
 */
let agent: AgentInfo = { enabled: false, id: null, status: null, error: null }
/** The agent session the centre terminal is showing, or null for the focused tile. */
let shownAgent: string | null = null
const agentView = (): boolean => inboxPanel.isOpen && agent.enabled && agent.id !== null
/** Whose output the centre terminal shows and whose PTY its keys go to. */
const target = (): string | null => (agentView() ? agent.id : focusedId)

const ws = new WsClient({
  onOpen: () => { hideToast(); reattach() },
  onClose: () => showToast('daemon disconnected — reconnecting'),
  onOutput: (id, data) => { if (id === target()) focusTerm.write(data) },
  onMessage: handleMessage,
})

focusTerm.onInput = (data) => {
  const id = target()
  if (id) ws.send({ type: 'input', id, data })
}

// Drag a file onto the terminal and its path is typed into the prompt, the
// way dropping a file on any other terminal types one (see drop.ts).
refuseStrayDrops(window)
const pasteOpts: PasteOptions = {
  upload: uploadFile,
  ready: () => target() !== null,
  insert: (text) => { focusTerm.paste(text); focusTerm.focus() },
  onError: showToast,
}
attachFileDrop(focusCell, pasteOpts)
attachTileDrag(ringEl, {
  sessionAt: (slot) => sessionAt(slot)?.id,
  onMove: (id, slot) => ws.send({ type: 'move', id, slot }),
})
// Ctrl+V with a screenshot on the clipboard goes the same way (see paste.ts).
attachImagePaste(focusCell, pasteOpts)
// And so does a photo or file picked with the phone's attach button.
const pickFiles = filePicker((files) => { void attachFiles(files) })

/** A phone photo takes a few seconds on mobile data, so the upload says it is under way. */
async function attachFiles(files: File[]): Promise<void> {
  const [only] = files
  const note = showToast(files.length === 1 && only ? `uploading ${only.name}…` : `uploading ${files.length} files…`)
  await insertFiles(files, pasteOpts)
  // Only the note: an error raised by the upload replaced it, and stays up.
  if (toast === note) hideToast()
}

// The phone's mic button (see dictation.ts). While it listens, the words heard
// so far show over the top of the terminal.
const heardEl = document.createElement('div')
heardEl.className = 'heard'
heardEl.hidden = true
heardEl.setAttribute('aria-live', 'polite')
focusCell.append(heardEl)
const makeRecognition = recognitionFactory(window)
const dictation = makeRecognition && new Dictation(makeRecognition, {
  onListening: (on) => { heardEl.hidden = !on; paintSwitcher() },
  onHeard: (text) => { heardEl.textContent = text || 'listening… tap the mic again to finish' },
  // A trailing space, so the next words spoken or typed do not run on. Not
  // focused: the keyboard stays as it was, up or down.
  onText: (text) => { if (target()) focusTerm.paste(text + ' ') },
  onError: showToast,
}, navigator.language)
// The prefix never reaches the PTY, and nothing reaches it while an overlay
// is up (spec §5.4).
focusTerm.shouldSendKey = (e) => !ui.isOpen() && !isPrefix(e)
// Highlighting copies. The copy can borrow focus for a hidden textarea on an
// http origin, so it is handed back to the terminal afterwards.
focusTerm.onSelect = (text) => {
  void copyToClipboard(text).then((ok) => {
    if (!ok) showToast('could not copy the selection')
    focusTerm.focus()
  })
}

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
      const alive = new Set(projects.flatMap((p) => p.sessions).map((s) => s.id))
      for (const id of lastShots.keys()) if (!alive.has(id)) lastShots.delete(id)
      viewedId = msg.activeProjectId ?? projects[0]?.id ?? null
      render()
      reconcileFocus()
      restoreProjectFocus()
      focusArrival()
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
      if (msg.id === target()) focusTerm.replay(msg.ansi)
      break
    case 'snapshot': {
      lastShots.set(msg.id, msg.snapshot)
      thumbs.get(msg.id)?.paint(msg.snapshot)
      break
    }
    case 'exit':
      paintStatuses()
      break
    case 'error':
      showToast(msg.message)
      break
    case 'autoAnswer':
      inboxPanel.setAuto(msg.enabled, msg.history)
      break
    case 'agent':
      agent = msg.agent
      inboxPanel.setAgent(agent)
      applyCentre()
      paintSwitcher()
      break
    case 'inbox': {
      const fresh = inboxPanel.setItems(msg.items)
      if (inboxSeen && fresh.length > 0) tring()
      inboxSeen = true
      paintStatuses()
      break
    }
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
  onInbox: () => toggleInbox(),
})

const paintBar = (): void =>
  renderBar(barEl, projects, viewedId, barCallbacks(), update, viewMode === 'usage',
    { open: inboxPanel.isOpen, count: inboxPanel.count })

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
    // A tile is focusable so it can be tabbed to, but pressing a mouse on one
    // must not move the keyboard there — it does nothing with it, and the
    // terminal goes deaf. Cancelling the default on mousedown keeps the
    // keyboard where it belongs without the round trip through blur and back,
    // and covers the action button nested inside, whose own click is stopped
    // from bubbling and so never reaches the guard below.
    tile.onmousedown = (e) => e.preventDefault()
    placeInGrid(tile, slot, size)
    tile.dataset['slot'] = String(slot)

    if (!s) {
      tile.classList.add('empty')
      tile.textContent = `+ ${legendForSlot(slot)}`
      tile.onclick = () => promptNewSession(slot)
    } else {
      const canvas = document.createElement('canvas')
      tile.append(canvas)
      const thumb = new Thumbnail(canvas)
      thumbs.set(s.id, thumb)
      // A rebuild discards the old canvas, and the daemon only resends a
      // screen when it changes — so without this an idle session goes black
      // until it next prints something, which may be never.
      const shot = lastShots.get(s.id)
      if (shot) thumb.paint(shot)

      // The centred label: the slot number in a circle (visible only while
      // `done`, so the key to press is the biggest thing on a finished tile)
      // above the session name. `.meta` below keeps the small footer.
      const label = document.createElement('div')
      label.className = 'label'
      const badge = span('slot-badge')
      badge.textContent = String(slot)
      label.append(badge, span('big-nm'))
      tile.append(label)

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
  tile.classList.remove('st-idle', 'st-busy', 'st-done', 'st-exited', 'viewing', 'asking')
  tile.style.removeProperty('--tint')
  if (!s) return

  tile.classList.add(`st-${s.status}`)
  if (s.id === focusedId) tile.classList.add('viewing')
  if (inboxPanel.countFor(s.id) > 0) tile.classList.add('asking')
  if (s.color) tile.style.setProperty('--tint', s.color)

  const name = s.name ?? s.title ?? 'shell'
  const nm = tile.querySelector<HTMLElement>('.nm')
  if (nm) nm.textContent = name
  const bigNm = tile.querySelector<HTMLElement>('.big-nm')
  if (bigNm) bigNm.textContent = name
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
  paintSwitcher()
  inboxPanel.repaint()
  const done = globalDone()
  document.title = done > 0 ? `(${done}) tring` : 'tring'
}

/**
 * On a phone the ring is hidden by the stylesheet, so this bar is the only
 * thing that says which session is in the centre and how many have finished.
 * The count is this project's: "next finished" walks this project's slots.
 */
let switcherSig = ''
function paintSwitcher(): void {
  switcherEl.hidden = !mobile.matches || viewMode !== 'ring'
  if (switcherEl.hidden) {
    switcherSig = ''
    // The bar holds the only button that stops the mic, so the mic goes with it.
    dictation?.cancel()
    return
  }
  const focused = focusedId ? sessionById(focusedId) ?? null : null
  const done = sessions().filter((s) => s.status === 'done').length
  const listening = dictation?.listening ?? false
  const inbox = { open: inboxPanel.isOpen, count: inboxPanel.count }
  const override = agentView() ? { key: '\u25c6', name: 'Orchestrator', status: agent.status ?? 'idle' } : null
  // Rebuilt only when what it shows changes. Every status message repaints,
  // and a button replaced between finger-down and finger-up is a lost tap.
  const sig = `${focused?.id}|${focused?.status}|${focused?.name}|${focused?.title}|${done}|${listening}` +
    `|${inbox.open}|${inbox.count}|${override?.status}`
  if (sig === switcherSig) return
  switcherSig = sig
  renderSwitcher(switcherEl, { focused, done, listening, inbox, override }, {
    onOpen: openPicker, onNext: nextDone, onEsc: escFromButton,
    onPaste: pasteFromButton, onAttach: pickFiles, onCopy: copyFromButton,
    onMic: dictation ? () => dictation.toggle() : undefined,
    onInbox: toggleInbox,
  })
}

/** The switcher's Esc button: the key a phone keyboard does not have. */
function escFromButton(): void {
  const id = target()
  if (id) ws.send({ type: 'input', id, data: '\x1b' })
}

/** The switcher's paste button: the clipboard if it can be read, a sheet if not. */
function pasteFromButton(): void {
  void pasteFromClipboard({
    ...pasteOpts,
    fallback: () => ui.openPasteSheet({
      onText: pasteOpts.insert,
      onImages: (files) => { void insertFiles(files, pasteOpts) },
    }),
  })
}

/** The switcher's copy button: the screen's links and text, as a sheet to copy from. */
function copyFromButton(): void {
  if (!target()) return
  const buffer = focusTerm.term.buffer.active
  ui.openCopySheet(
    { text: screenText(buffer, focusTerm.term.rows), links: recentLinks(buffer) },
    copyToClipboard,
  )
}

/* ---------- actions ---------- */

function fitTerminal(): void {
  const { cols, rows } = focusTerm.fitNow()
  if (focusedId) ws.send({ type: 'resize', cols, rows })
  for (const t of thumbs.values()) t.refresh()
}

function focusSession(id: string | null, keepInbox = false): void {
  showRing()
  // Picking a session is leaving the inbox for it — except where the focus
  // moves on its own (a project switch restoring where you were), which must
  // not pull you out of a view you chose.
  if (!keepInbox && inboxPanel.isOpen) closeInbox()
  attachSession(id)
  // Also when the session did not change. Whatever got us here — a click on a
  // tile, a key in the picker — left the keyboard somewhere else, and
  // attachSession returns early rather than re-aiming at what it already has.
  if (focusedId && !inboxPanel.isOpen) focusTerm.focus()
}

function toggleInbox(): void {
  if (inboxPanel.isOpen) closeInbox()
  else openInbox()
}

function openInbox(): void {
  showRing()
  // With the agent running the keyboard goes to it, not to the first card.
  inboxPanel.open(!(agent.enabled && agent.id))
  applyCentre()
  paintBar()
  paintSwitcher()
}

function closeInbox(): void {
  inboxPanel.close()
  applyCentre()
  paintBar()
  paintSwitcher()
  if (focusedId) focusTerm.focus()
}

/**
 * Points the centre terminal at the agent or back at the focused tile, when
 * that changes. The socket's focus moves with it, so output, replay and
 * resizes follow; the tile's own focus is left alone to come back to.
 */
function applyCentre(): void {
  const want = agentView() ? agent.id : null
  focusCell.classList.toggle('agent-view', want !== null)
  inboxPanel.setBeside(want !== null)
  if (want === shownAgent) return
  shownAgent = want
  dictation?.cancel()
  focusTerm.clear()
  // After layout: the cards beside the terminal take width it must not count.
  requestAnimationFrame(() => {
    const { cols, rows } = focusTerm.fitNow()
    ws.send({ type: 'focus', id: target(), cols, rows })
    for (const t of thumbs.values()) t.refresh()
    if (want) focusTerm.focus()
  })
}

/** A card's Open: that session in the centre, across projects if need be. */
function openFromInbox(id: string): void {
  const s = sessionById(id)
  if (!s) return
  closeInbox()
  if (s.projectId !== viewedId) {
    lastFocused.set(s.projectId, s.id)
    activateProject(s.projectId)
    return
  }
  focusSession(s.id)
}

/**
 * Point the centre terminal at a session and tell the daemon so.
 *
 * Separate from focusSession because the two paths that re-aim the focus on
 * their own — a respawn, a reconnect — must not also drag the window back to
 * the ring from wherever the user had put it.
 */
function attachSession(id: string | null): void {
  if (id && id === focusedId) return
  // The agent has the centre: the tile becomes the one to come back to, and
  // nothing is sent or drawn for it until orchestrator mode closes.
  if (agentView()) {
    const s = id ? sessionById(id) : undefined
    if (focusedId) prevFocusedId = focusedId
    focusedId = s?.id ?? null
    focusedSlot = s?.slot ?? null
    diffPanel.setSession(focusedId)
    if (s) lastFocused.set(s.projectId, s.id)
    paintStatuses()
    return
  }
  // Words spoken to one session never land in the next one's prompt.
  dictation?.cancel()
  // Never aim at a session that is not in the state we hold — `prevFocusedId`
  // can outlive one. The daemon would take the focus, send nothing back, and
  // the centre terminal would sit frozen with nothing on screen saying why.
  const s = id ? sessionById(id) : undefined
  if (focusedId) prevFocusedId = focusedId
  focusedId = s?.id ?? null
  focusedSlot = s?.slot ?? null
  diffPanel.setSession(focusedId)
  if (!s) {
    focusTerm.clear()
    paintStatuses()
    return
  }
  lastFocused.set(s.projectId, s.id)
  const { cols, rows } = focusTerm.fitNow()
  ws.send({ type: 'focus', id: s.id, cols, rows })
  focusTerm.focus()
  paintStatuses()
}

/**
 * Re-asserts the focus on a socket that has just opened.
 *
 * The daemon records what each *socket* is watching, so a reconnect — a laptop
 * waking, a daemon restart, a background tab the browser dropped — leaves it
 * with no record of this one, and output for the focused session stops being
 * sent. Keystrokes still arrive at the PTY, and the thumbnail still updates,
 * so the only symptom is a centre terminal that answers nothing: pressing
 * enter on a question Claude is asking looks like a key that does not work.
 *
 * Re-sending `focus` also asks for a replay, which is what we want regardless
 * after a gap in which output was missed.
 */
function reattach(): void {
  const id = target()
  if (!id) return
  const { cols, rows } = focusTerm.fitNow()
  ws.send({ type: 'focus', id, cols, rows })
}

/** Follows the focus into whatever now holds its slot (see focus-target.ts). */
function reconcileFocus(): void {
  if (focusedId === null || focusedSlot === null) return
  const next = followFocus({ id: focusedId, slot: focusedSlot }, sessions())
  if (next && next.id === focusedId) {
    focusedSlot = next.slot
    return
  }
  attachSession(next?.id ?? null)
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
  paintSwitcher()
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
  paintSwitcher()
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
  ui.openSettingsDialog({ ring: ringSize(), usage: usage.isEnabled() }, (v) => {
    if (v.usage !== usage.isEnabled()) {
      usage.setEnabled(v.usage)
      if (!v.usage) showRing()
    }
    if (v.ring !== ringSize()) changeRingSize(v.ring)
    else { paintBar(); void refreshUsage() }
  })
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
  dictation?.cancel()
  focusedId = null
  focusedSlot = null
  diffPanel.setSession(null)
  if (!agentView()) focusTerm.clear()
  // The project's sessions arrive with the next `state`, so the session to
  // return to can only be chosen once they do.
  restoreFocusFor = id
  ws.send({ type: 'activateProject', projectId: id })
}

function focusArrival(): void {
  const slot = focusOnArrival
  if (slot === null) return
  const s = sessionAt(slot)
  if (!s) return
  focusOnArrival = null
  focusSession(s.id, true)
}

/** Puts you back in the session you were last using in this project. */
function restoreProjectFocus(): void {
  const want = restoreFocusFor
  if (!want || want !== viewedId) return
  restoreFocusFor = null
  const id = lastFocused.get(want)
  if (id && sessions().some((s) => s.id === id)) focusSession(id, true)
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
    if (mobile.matches) focusOnArrival = slot
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
  ui.openSessionDialog(
    s,
    (v) => {
      if (v.name !== (s.name ?? '')) ws.send({ type: 'rename', id, name: v.name })
      if (v.color !== s.color) ws.send({ type: 'color', id, color: v.color })
    },
    () => killSession(s),
    {
      open: diffPanel.isOpen,
      // The panel always describes the centre terminal, so opening it from
      // another tile brings that tile to the centre first.
      onToggle: () => {
        if (!diffPanel.isOpen) focusSession(id)
        diffPanel.toggle()
      },
    },
  )
}

/** Kills the PTY and frees the slot, so the tile goes back to `+`. */
function killSession(s: SessionInfo): void {
  ui.openConfirm(
    'Delete session',
    `Slot ${s.slot} — ${s.cwd}. The slot goes back to empty.`,
    () => ws.send({ type: 'kill', id: s.id }),
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
    openPicker()
  }
})

/**
 * The keyboard belongs to the terminal.
 *
 * Everything else on the ring is a click target that keeps the DOM focus it
 * takes — a project tab, the settings button, a tile — and the browser then
 * delivers keystrokes there instead of to the terminal. Nothing looks wrong
 * while it is happening: the tile still carries its viewing border, the
 * session is still running, output still arrives. Only the keys do nothing,
 * so answering a question Claude asked is impossible until you happen to
 * click the terminal itself.
 *
 * A panel is the exception — its fields are the one place the keyboard is
 * meant to go instead — and so is the usage view, which has no terminal.
 */
document.addEventListener('click', (e) => {
  if (ui.isOpen() || viewMode !== 'ring') return
  // Beside the agent, the cards keep the clicks made on them; anywhere else
  // goes back to typing to the agent.
  if (agentView()) {
    if (!inboxPanel.el.contains(e.target as Node)) focusTerm.focus()
    return
  }
  if (!focusedId || inboxPanel.isOpen) return
  focusTerm.focus()
})

/** Ctrl+Space on desktop, a tap on the switcher on a phone: the same picker. */
function openPicker(): void {
  if (ui.isOpen()) return
  showRing()
  overlayMode = 'picker'
  ui.openPicker(viewed(), projects, globalDone(), {
    onPickSlot: (slot) => { overlayMode = null; focusSlot(slot) },
    onPickProject: (id) => { overlayMode = null; activateProject(id) },
    onNextDone: () => { overlayMode = null; nextDone() },
    onNewSession: () => { overlayMode = null; newSessionInFirstEmptySlot() },
  })
}

function newSessionInFirstEmptySlot(): void {
  const size = effectiveSize()
  const empty = [...Array(size)].map((_, i) => i + 1).find((s) => !sessionAt(s))
  if (empty) promptNewSession(empty)
  else showToast(`all ${size} slots are full`)
}

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
    case 'new-session':
      ui.close(); overlayMode = null
      newSessionInFirstEmptySlot()
      break
    case 'rename':
      if (!current) break
      ui.close(); overlayMode = null
      sessionMenu(current.id)
      break
    case 'kill':
      if (!current) break
      ui.close(); overlayMode = null
      killSession(current)
      break
    case 'orchestrator':
      ui.close(); overlayMode = null
      toggleInbox()
      break
    case 'mark-seen':
      if (current) ws.send({ type: 'ack', id: current.id })
      ui.close(); overlayMode = null
      break
  }
}

/* ---------- misc ---------- */

let toast: HTMLElement | null = null
function showToast(message: string): HTMLElement {
  hideToast()
  toast = document.createElement('div')
  toast.id = 'toast'
  toast.textContent = message
  document.body.append(toast)
  return toast
}
function hideToast(): void {
  toast?.remove()
  toast = null
}

// Installable as an app (spec §5.12). Production only: Vite's dev server does
// not serve the worker, and a worker registered against it would shadow HMR.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* still a web page */ })
}

window.addEventListener('resize', () => fitTerminal())
// Crossing the phone breakpoint swaps ring for switcher, and the terminal
// changes size with it, so both are redone together.
mobile.addEventListener('change', () => {
  paintSwitcher()
  requestAnimationFrame(() => fitTerminal())
})
if (InboxPanel.wanted()) openInbox()
ws.connect()

import type { ProjectInfo, SessionInfo } from '@tring/shared/protocol'
import { legendForSlot, SLOT_COUNT } from '@tring/shared/keymap'

const root = document.getElementById('overlay') as HTMLElement

let onClose: (() => void) | null = null

export function isOpen(): boolean {
  return !root.hidden
}

export function close(): void {
  root.hidden = true
  root.replaceChildren()
  const cb = onClose
  onClose = null
  cb?.()
}

function open(panel: HTMLElement, opts: { dismissible?: boolean; onClosed?: () => void } = {}): void {
  onClose = opts.onClosed ?? null
  root.replaceChildren(panel)
  root.hidden = false
  if (opts.dismissible !== false) {
    root.onclick = (e) => { if (e.target === root) close() }
  } else {
    root.onclick = null
  }
  panel.querySelector<HTMLElement>('input, button')?.focus()
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/* ---------- picker (spec §5.5) ---------- */

export interface PickerCallbacks {
  onPickSlot: (slot: number) => void
  onPickProject: (projectId: string) => void
}

export function openPicker(
  project: ProjectInfo | null,
  projects: ProjectInfo[],
  doneCount: number,
  cb: PickerCallbacks,
): void {
  const panel = el('div', 'panel')
  panel.append(el('h2', undefined, project ? project.name : 'No project'))
  panel.append(el('p', 'hint',
    `${doneCount} session${doneCount === 1 ? '' : 's'} finished across all projects`))

  const rows = el('div', 'rows')
  const bySlot = new Map<number, SessionInfo>()
  for (const s of project?.sessions ?? []) bySlot.set(s.slot, s)

  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const s = bySlot.get(slot)
    const row = el('button', `row st-${s?.status ?? 'idle'}`)
    // busy sessions are dimmed but still selectable
    if (s?.status === 'busy') row.classList.add('dim')
    if (!s) row.classList.add('dim')
    row.append(el('span', 'key', legendForSlot(slot)))
    row.append(el('span', 'nm', s ? (s.name ?? s.title ?? s.cwd.split('/').pop() ?? 'shell') : '— empty'))
    if (s) row.append(el('span', 'tag', s.status))
    row.onclick = () => { close(); cb.onPickSlot(slot) }
    rows.append(row)
  }
  panel.append(rows)

  const legend = el('div', 'legend')
  legend.innerHTML =
    '<b>n</b> next finished &nbsp; <b>p</b> projects &nbsp; <b>c</b> new session &nbsp; ' +
    '<b>r</b> rename &nbsp; <b>x</b> kill &nbsp; <b>m</b> mark seen &nbsp; <b>esc</b> close'
  panel.append(legend)

  open(panel)
  // `p` switches project without leaving the picker's mental model.
  panel.dataset['projects'] = String(projects.length)
}

export function openProjectPicker(projects: ProjectInfo[], onPick: (id: string) => void): void {
  const panel = el('div', 'panel')
  panel.append(el('h2', undefined, 'Projects'))
  panel.append(el('p', 'hint', 'Each project owns its own 16 slots.'))
  const rows = el('div', 'rows')
  projects.forEach((p, i) => {
    const done = p.sessions.filter((s) => s.status === 'done').length
    const row = el('button', 'row st-done')
    row.append(el('span', 'key', i < 9 ? String(i + 1) : '—'))
    row.append(el('span', 'nm', p.name))
    row.append(el('span', 'tag', done > 0 ? `${done} done` : p.root))
    row.onclick = () => { close(); onPick(p.id) }
    rows.append(row)
  })
  panel.append(rows)
  open(panel)
}

/* ---------- dialogs (spec §5.7) ---------- */

export function openProjectDialog(
  opts: { title: string; name?: string; root?: string; rootLocked?: boolean; blocking?: boolean },
  onSubmit: (name: string, root: string) => void,
): void {
  const panel = el('div', 'panel')
  panel.append(el('h2', undefined, opts.title))
  panel.append(el('p', 'hint',
    opts.blocking
      ? 'A project is a name and a root directory. New sessions start there.'
      : 'New sessions in this project start in its root directory.'))

  const form = el('form')
  const name = el('input') as HTMLInputElement
  name.value = opts.name ?? ''
  name.placeholder = 'api-service'
  name.required = true
  const nameField = el('label', 'field')
  nameField.append(el('span', undefined, 'Project name'), name)

  const root = el('input') as HTMLInputElement
  root.value = opts.root ?? ''
  root.placeholder = '/home/you/code/api-service'
  root.required = true
  root.disabled = Boolean(opts.rootLocked)
  const rootField = el('label', 'field')
  rootField.append(el('span', undefined,
    opts.rootLocked ? 'Root directory (fixed after creation)' : 'Root directory'), root)

  form.append(nameField, rootField)

  const actions = el('div', 'actions')
  if (!opts.blocking) {
    const cancel = el('button', 'btn', 'Cancel') as HTMLButtonElement
    cancel.type = 'button'
    cancel.onclick = () => close()
    actions.append(cancel)
  }
  const ok = el('button', 'btn primary', 'Create') as HTMLButtonElement
  ok.type = 'submit'
  actions.append(ok)
  form.append(actions)

  form.onsubmit = (e) => {
    e.preventDefault()
    if (!name.value.trim() || !root.value.trim()) return
    close()
    onSubmit(name.value.trim(), root.value.trim())
  }
  panel.append(form)
  open(panel, { dismissible: !opts.blocking })
  name.focus()
  name.select()
}

export function openNewSessionDialog(
  defaults: { cwd: string; slot: number },
  onSubmit: (v: { cwd: string; command: string | null; name: string | null }) => void,
): void {
  const panel = el('div', 'panel')
  panel.append(el('h2', undefined, `New session in slot ${defaults.slot}`))
  panel.append(el('p', 'hint', 'Defaults to the project root.'))

  const form = el('form')
  const mk = (label: string, value: string, placeholder: string) => {
    const input = el('input') as HTMLInputElement
    input.value = value
    input.placeholder = placeholder
    const field = el('label', 'field')
    field.append(el('span', undefined, label), input)
    form.append(field)
    return input
  }
  const cwd = mk('Working directory', defaults.cwd, defaults.cwd)
  const command = mk('Command (optional)', '', 'claude')
  const name = mk('Name (optional)', '', 'agent')

  const actions = el('div', 'actions')
  const cancel = el('button', 'btn', 'Cancel') as HTMLButtonElement
  cancel.type = 'button'
  cancel.onclick = () => close()
  const ok = el('button', 'btn primary', 'Start') as HTMLButtonElement
  ok.type = 'submit'
  actions.append(cancel, ok)
  form.append(actions)

  form.onsubmit = (e) => {
    e.preventDefault()
    close()
    onSubmit({
      cwd: cwd.value.trim() || defaults.cwd,
      command: command.value.trim() || null,
      name: name.value.trim() || null,
    })
  }
  panel.append(form)
  open(panel)
}

export function openPrompt(
  title: string, value: string, onSubmit: (v: string) => void,
): void {
  const panel = el('div', 'panel')
  panel.append(el('h2', undefined, title))
  const form = el('form')
  const input = el('input') as HTMLInputElement
  input.value = value
  const field = el('label', 'field')
  field.append(input)
  form.append(field)
  const actions = el('div', 'actions')
  const cancel = el('button', 'btn', 'Cancel') as HTMLButtonElement
  cancel.type = 'button'
  cancel.onclick = () => close()
  const ok = el('button', 'btn primary', 'Save') as HTMLButtonElement
  ok.type = 'submit'
  actions.append(cancel, ok)
  form.append(actions)
  form.onsubmit = (e) => { e.preventDefault(); close(); onSubmit(input.value.trim()) }
  panel.append(form)
  open(panel)
  input.focus()
  input.select()
}

export function openConfirm(title: string, body: string, onYes: () => void): void {
  const panel = el('div', 'panel')
  panel.append(el('h2', undefined, title))
  panel.append(el('p', 'hint', body))
  const actions = el('div', 'actions')
  const cancel = el('button', 'btn', 'Cancel') as HTMLButtonElement
  cancel.onclick = () => close()
  const ok = el('button', 'btn primary', 'Confirm') as HTMLButtonElement
  ok.onclick = () => { close(); onYes() }
  actions.append(cancel, ok)
  panel.append(actions)
  open(panel)
}

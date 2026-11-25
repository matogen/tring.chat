import type { WorkflowSettings } from '@tring/shared/workflow'
import { api, apiPost } from './ws-client.ts'
import { workflowControls, type WorkflowControl } from './workflow-view.ts'

/**
 * "Workflow" in Settings: the multi-PR workflow's switch and, once it is on,
 * its options. Acts at once, like Voice input, since the daemon holds it.
 */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export function workflowSection(): HTMLElement {
  const box = el('div', 'notify workflow-settings')
  const state = el('p', 'hint notify-state')
  const body = el('div', 'notify-body')
  box.append(el('div', 'notify-title', 'Workflow'), state, body)

  const set = (patch: Partial<WorkflowSettings>): void => {
    void apiPost<WorkflowSettings>('/api/workflow', patch).then(paint, (err: Error) => {
      state.textContent = `Could not save: ${err.message}`
    })
  }

  const paint = (s: WorkflowSettings): void => {
    state.textContent = ''
    body.replaceChildren(...workflowControls(s).map((c) => control(c, set)))
  }

  void api<WorkflowSettings>('/api/workflow').then(paint, (err: Error) => {
    state.textContent = `Workflow settings are not available: ${err.message}`
  })
  return box
}

function control(c: WorkflowControl, set: (patch: Partial<WorkflowSettings>) => void): HTMLElement {
  const wrap = el('div', `workflow-control${c.later ? ' later' : ''}`)
  if (c.kind === 'toggle') {
    const row = el('label', 'field toggle notify-choice')
    const cb = el('input')
    cb.type = 'checkbox'
    cb.checked = c.value === true
    cb.disabled = c.disabled
    cb.onchange = () => set({ [c.key]: cb.checked })
    row.append(cb, el('span', undefined, c.label + (c.later ? ' (later)' : '')))
    wrap.append(row)
  } else if (c.kind === 'choice') {
    wrap.append(el('span', 'workflow-label', c.label))
    const group = el('div', 'choices')
    for (const o of c.options ?? []) {
      const b = el('button', 'choice' + (o.value === c.value ? ' active' : ''), o.label)
      b.type = 'button'
      b.disabled = c.disabled
      b.onclick = () => set({ [c.key]: o.value })
      group.append(b)
    }
    wrap.append(group)
  } else {
    const label = el('label', 'workflow-slider')
    const shown = el('b', undefined, c.value === null ? '—' : String(c.value))
    label.append(el('span', 'workflow-label', c.label + (c.later ? ' (later)' : '')), shown)
    const range = el('input')
    range.type = 'range'
    range.min = String(c.min ?? 0)
    range.max = String(c.max ?? 0)
    range.step = '1'
    range.disabled = c.disabled
    if (typeof c.value === 'number') range.value = String(c.value)
    range.oninput = () => { shown.textContent = range.value }
    range.onchange = () => set({ [c.key]: Number(range.value) })
    label.append(range)
    wrap.append(label)
  }
  wrap.append(el('p', 'hint', c.hint))
  return wrap
}

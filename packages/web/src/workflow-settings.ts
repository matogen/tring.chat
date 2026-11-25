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
    if (s.multiPr) body.append(forgesNote())
  }

  void api<WorkflowSettings>('/api/workflow').then(paint, (err: Error) => {
    state.textContent = `Workflow settings are not available: ${err.message}`
  })
  return box
}

/**
 * How tring opens and follows PRs: gh on GitHub; on Bitbucket, a scoped API
 * token the user puts in a file (tring never asks for it here).
 */
function forgesNote(): HTMLElement {
  const wrap = el('div', 'workflow-control')
  wrap.append(el('span', 'workflow-label', 'Pull requests'))
  const hint = el('p', 'hint', 'GitHub: tring opens and follows PRs with your gh.')
  const bb = el('p', 'hint')
  wrap.append(hint, bb)
  void api<{ bitbucket: boolean; file: string }>('/api/workflow/forges').then((f) => {
    bb.textContent = f.bitbucket
      ? 'Bitbucket: tring has an API token, so it opens PRs, retargets them and reads their builds.'
      : `Bitbucket: no API token, so you open each PR from the link tring gives, and a merge is seen once the branch is in the base. ` +
        `To let tring do it, create an Atlassian API token with the read:pullrequest:bitbucket and write:pullrequest:bitbucket scopes ` +
        `and put {"token": "…", "email": "your Atlassian email"} in ${f.file}.`
  }, () => { bb.textContent = '' })
  return wrap
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
  } else if (c.kind === 'model') {
    // A model and an effort for one role; '' sends null, Claude Code's default.
    const m = c.value as { model: string | null; effort: string | null }
    wrap.append(el('span', 'workflow-label', c.label))
    const row = el('div', 'workflow-model')
    const pick = (opts: Array<{ value: string; label: string }>, now: string | null, field: 'model' | 'effort'): HTMLSelectElement => {
      const sel = el('select')
      sel.id = `workflow-${c.role}-${field}`
      sel.setAttribute('aria-label', `${c.label} ${field}`)
      const known = opts.some((o) => o.value === (now ?? ''))
      for (const o of known ? opts : [...opts, { value: now ?? '', label: now ?? '' }]) {
        const opt = el('option', undefined, o.label)
        opt.value = o.value
        opt.selected = o.value === (now ?? '')
        sel.append(opt)
      }
      sel.disabled = c.disabled
      sel.onchange = () => set({ models: { [c.role!]: { [field]: sel.value || null } } } as unknown as Partial<WorkflowSettings>)
      return sel
    }
    row.append(pick(c.options ?? [], m.model, 'model'), pick(c.efforts ?? [], m.effort, 'effort'))
    wrap.append(row)
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

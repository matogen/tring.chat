import { api, apiPost } from './ws-client.ts'
import { DEFAULT_PREFS, detectEnv, deviceLabel, support, type Prefs } from './notify-env.ts'

/**
 * "Notifications on this device", in tring's settings: phone notifications
 * for orchestrator cards, off by default and per device.
 *
 * Turning it on walks through what the device needs — on an iPhone, being
 * opened from the Home Screen; the browser's permission; a push subscription
 * — and the daemon keeps this device's choices with its subscription, since it
 * sends while this browser is closed (see the daemon's push-store.ts).
 */

function keyBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(s.length))
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function sameKey(a: ArrayBuffer | null | undefined, b64u: string): boolean {
  if (!a) return false
  const x = new Uint8Array(a)
  const y = keyBytes(b64u)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

async function subscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}

/** This device as the daemon knows it: subscribed, and with which choices. */
async function status(): Promise<{ sub: PushSubscription | null; prefs: Prefs | null }> {
  const sub = await subscription()
  if (!sub) return { sub: null, prefs: null }
  const st = await apiPost<{ subscribed: boolean; prefs?: Prefs }>('/api/push/status', { endpoint: sub.endpoint })
  return { sub, prefs: st.subscribed ? st.prefs ?? DEFAULT_PREFS : null }
}

/**
 * Called straight from the click: Safari only shows the permission prompt for
 * a request made by a person's own tap, so it is the first thing awaited.
 */
async function enable(prefs: Prefs): Promise<'on' | 'blocked' | 'off'> {
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return perm === 'denied' ? 'blocked' : 'off'
  const { publicKey } = await api<{ publicKey: string }>('/api/push')
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  // A subscription made for another daemon's key cannot be used by this one.
  if (sub && !sameKey(sub.options.applicationServerKey, publicKey)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  await apiPost('/api/push/subscribe', { subscription: sub.toJSON(), prefs, label: deviceLabel(navigator.userAgent) })
  return 'on'
}

/** Off for this device: the browser drops the subscription and the daemon forgets it. */
async function disable(): Promise<void> {
  const sub = await subscription()
  if (!sub) return
  await apiPost('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => { /* forgotten on its next failure */ })
  await sub.unsubscribe()
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const CHOICES: Array<[keyof Prefs, string]> = [
  ['permission', 'A permission prompt is waiting'],
  ['question', 'An agent asks a question'],
  ['reply', 'An agent finished'],
  ['onlyWhenAway', 'Only when I am not using tring on any device'],
]

/**
 * The settings section. Its controls act at once rather than on Save: the
 * browser's permission prompt has to come from the tap on "Turn on" itself.
 */
export function notificationsSection(): HTMLElement {
  const box = el('div', 'notify')
  const title = el('div', 'notify-title', 'Notifications on this device')
  const state = el('p', 'hint notify-state')
  const body = el('div', 'notify-body')
  box.append(title, state, body)

  const paint = async (): Promise<void> => {
    body.replaceChildren()
    const sup = support(detectEnv())
    if (sup === 'insecure') {
      state.textContent = 'Not available: notifications need tring opened over HTTPS.'
      return
    }
    if (sup === 'needs-install') {
      state.textContent = 'On iPhone and iPad, add tring to your Home Screen first: tap Share, then ' +
        '"Add to Home Screen", and open tring from that icon. Then turn notifications on there.'
      return
    }
    if (sup === 'unsupported') {
      state.textContent = 'Not supported in this browser.'
      return
    }
    if (Notification.permission === 'denied') {
      state.textContent = 'Blocked by the browser. Allow notifications for this site in the browser\'s ' +
        'settings, then come back here.'
      return
    }
    let st: Awaited<ReturnType<typeof status>>
    try {
      st = await status()
    } catch {
      state.textContent = 'Could not reach tring to check.'
      return
    }
    if (!st.prefs) {
      state.textContent = 'Off. When it is on, a card from the orchestrator — a permission prompt, ' +
        'a question, a finished agent — notifies this device, even with tring closed.'
      const on = el('button', 'btn primary', 'Turn on')
      on.type = 'button'
      on.onclick = () => {
        on.disabled = true
        state.textContent = 'Asking the browser…'
        enable(DEFAULT_PREFS).then(() => paint(), (err: Error) => {
          state.textContent = `Could not turn on: ${err.message}`
          on.disabled = false
        })
      }
      body.append(on)
      return
    }

    state.textContent = 'On for this device. Your other devices are not affected.'
    const prefs = { ...st.prefs }
    const endpoint = st.sub!.endpoint
    for (const [key, label] of CHOICES) {
      const row = el('label', 'field toggle notify-choice')
      const cb = el('input')
      cb.type = 'checkbox'
      cb.checked = prefs[key]
      cb.onchange = () => {
        prefs[key] = cb.checked
        void apiPost('/api/push/prefs', { endpoint, prefs }).catch(() => { state.textContent = 'Could not save that.' })
      }
      row.append(cb, el('span', undefined, label))
      body.append(row)
    }
    const result = el('span', 'notify-result')
    const test = el('button', 'btn', 'Send a test')
    test.type = 'button'
    test.onclick = () => {
      result.textContent = 'Sending…'
      apiPost<{ ok: boolean; status: number }>('/api/push/test', { endpoint }).then(
        (r) => { result.textContent = r.ok ? 'Sent. It should arrive in a few seconds.' : `The push service said ${r.status}.` },
        (err: Error) => { result.textContent = `Could not send: ${err.message}` },
      )
    }
    const off = el('button', 'btn', 'Turn off')
    off.type = 'button'
    off.onclick = () => { off.disabled = true; void disable().finally(() => paint()) }
    const actions = el('div', 'notify-actions')
    actions.append(test, off, result)
    body.append(actions)
  }

  void paint()
  box.append(el('p', 'hint',
    'Off by default, and per device. A notification says which tile and what kind of card — ' +
    'never the command, code or ticket text.'))
  return box
}

import type { Notifier } from './notifier.ts'
import { cleanPrefs, type NotifyPrefs, type PushStore } from './push-store.ts'
import { validSubscription } from './web-push.ts'

/**
 * What the settings dialog's "Notifications on this device" section asks the
 * daemon. A device is its push subscription's endpoint, which only that
 * browser knows, so every call names it.
 */
export interface PushApi {
  publicKey(): string
  status(endpoint: string): { subscribed: boolean; prefs?: NotifyPrefs }
  /** False for a bad subscription, or a browser that says it is not a phone. */
  subscribe(subscription: unknown, prefs: unknown, label: unknown, phone: unknown): Promise<boolean>
  setPrefs(endpoint: string, prefs: unknown): Promise<boolean>
  unsubscribe(endpoint: string): Promise<boolean>
  /** The push service's status, or null for a device this daemon does not know. */
  test(endpoint: string): Promise<number | null>
}

export function pushApi(store: PushStore, notifier: Notifier): PushApi {
  return {
    publicKey: () => store.vapid.publicKey,
    status: (endpoint) => {
      const d = store.get(endpoint)
      return d ? { subscribed: true, prefs: d.prefs } : { subscribed: false }
    },
    subscribe: async (subscription, prefs, label, phone) => {
      const sub = validSubscription(subscription)
      // Notifications are a phone's; a desktop is not offered them, and is refused if it asks.
      if (!sub || phone === false) return false
      await store.upsert(sub, cleanPrefs(prefs), typeof label === 'string' ? label : '', Date.now(), true)
      return true
    },
    setPrefs: (endpoint, prefs) => store.setPrefs(endpoint, cleanPrefs(prefs)),
    unsubscribe: (endpoint) => store.remove(endpoint),
    test: async (endpoint) => {
      const d = store.get(endpoint)
      return d ? notifier.test(d) : null
    },
  }
}

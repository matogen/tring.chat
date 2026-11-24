/*
 * The service worker makes tring installable, and shows phone notifications
 * for orchestrator cards. It caches nothing: a terminal deck has no offline
 * mode worth having, and caching index.html would pin a stale bundle across
 * daemon upgrades, so every request goes straight to the daemon.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request))
})

/*
 * A card from the daemon (notifier.ts): which tile, and what kind of card.
 * One per tile: a newer card on the same tile replaces the notification
 * rather than stacking under it.
 */
self.addEventListener('push', (event) => {
  let msg = {}
  try { msg = event.data ? event.data.json() : {} } catch { /* not ours */ }
  event.waitUntil(self.registration.showNotification(msg.title || 'tring', {
    body: msg.body || 'An agent is waiting for you.',
    tag: msg.tag || 'tring',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: msg.url || '/?inbox=1' },
  }))
})

/* A tap: to the orchestrator, in the tring window already open if there is one. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/?inbox=1'
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of windows) {
      if (new URL(w.url).origin !== self.location.origin) continue
      w.postMessage({ type: 'open-inbox' })
      return w.focus()
    }
    return self.clients.openWindow(url)
  })())
})

/*
 * The service worker exists so every browser treats tring as installable —
 * some still refuse without one — and for nothing else. A terminal deck has
 * no offline mode worth having, and caching index.html would pin a stale
 * bundle across daemon upgrades, so every request goes straight to the daemon.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request))
})

// KILL-SWITCH service worker.
//
// WHY: the previous service worker cached the app shell, and on iOS Safari it could end
// up serving a STALE index.html that referenced deleted (content-hashed) chunk URLs.
// Those 404, nothing mounts, and the device shows a permanent blank screen it cannot
// recover from on its own — exactly the "won't load on mobile at all" report.
//
// Browsers ALWAYS re-fetch the service-worker script itself from the network (even when
// the page is served from the SW cache), so shipping this self-destructing worker is the
// one reliable way to evict a stuck install on every device: it deletes every cache,
// unregisters itself, and reloads open tabs into a clean, SW-free load.
//
// Offline/caching support is intentionally dropped for now — "loads reliably" beats
// "loads offline". Vercel's CDN + immutable hashed-asset HTTP caching already cover
// repeat visits. A carefully-scoped SW can be reintroduced later if needed.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (e) {
        /* best effort */
      }
      try {
        await self.registration.unregister();
      } catch (e) {
        /* best effort */
      }
      // Reload any open tabs so they re-fetch a fresh, uncached, SW-free document.
      try {
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) {
          client.navigate(client.url);
        }
      } catch (e) {
        /* best effort */
      }
    })(),
  );
});

// Pass through every request to the network — never serve from a cache.
self.addEventListener('fetch', () => {});

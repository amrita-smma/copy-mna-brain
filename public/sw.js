// Minimal service worker for the Investment Brain PWA PoC.
// Goal: satisfy installability (a registered SW with a fetch handler) and
// provide a basic offline fallback for navigations. This is intentionally
// conservative — it does NOT cache API responses or authenticated pages.

const CACHE = 'brain-pwa-v1';
const APP_SHELL = ['/offline.html', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET navigations; let everything else hit the network normally.
  if (request.method !== 'GET' || request.mode !== 'navigate') return;

  event.respondWith(
    fetch(request).catch(() => caches.match('/offline.html')),
  );
});

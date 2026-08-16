const CACHE = 'weblime-shell-v10';
const SHELL = [
  './', './index.html', './css/style.css', './manifest.webmanifest',
  './js/db.js', './js/lang.js', './js/zip.js', './js/backend.js',
  './js/app.js', './js/search-worker.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request).then(cached => {
      if (cached) return cached;
      if (request.mode === 'navigate') return caches.match('./index.html');
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }))
  );
});

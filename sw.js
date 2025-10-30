// sw.js
const CACHE_NAME = 'tfstream-shell-v1';
const IMAGE_CACHE = 'tfstream-thumbs-v1';
const JSON_CACHE = 'tfstream-json-v1';
const VIDEO_CACHE = 'tfstream-videos-v1';
const OFFLINE_URL = '/offline.html';
const PLACEHOLDER = '/images/placeholder-thumb.png';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  OFFLINE_URL,
  '/styles.css',
  '/main.js',
  PLACEHOLDER
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(
      PRECACHE_URLS.map(u =>
        fetch(u, { cache: 'no-cache' }).then(res => {
          if (!res || (res.status !== 200 && res.type !== 'opaque')) throw new Error(`${u} -> ${res && res.status}`);
          return cache.put(new Request(u, { credentials: 'same-origin' }), res.clone());
        }).catch(err => {
          console.warn('Precache failed for', u, err);
        })
      )
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', evt => {
  evt.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (![CACHE_NAME, IMAGE_CACHE, JSON_CACHE, VIDEO_CACHE].includes(k)) {
        return caches.delete(k);
      }
      return Promise.resolve();
    }));
    await self.clients.claim();
  })());
});

function normalizeUrl(u) {
  try { const url = new URL(u, self.location.origin); return url.href; } catch(e){ return u; }
}
function shouldBypass(request) {
  try {
    if (request.method !== 'GET') return true;
    if (request.headers && request.headers.get && request.headers.get('range')) return true;
    const dest = request.destination || '';
    if (dest === 'video' || dest === 'audio') return true;
    const url = request.url || '';
    if (/\.(mp4|webm|m3u8|mpd|mov|mkv)(\?.*)?$/i.test(url)) return true;
    return false;
  } catch(e) { return true; }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (shouldBypass(req)) { event.respondWith(fetch(req)); return; }
  if (req.mode === 'navigate' || (req.headers.get('accept')||'').includes('text/html')) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (req.destination === 'image' || /\.(png|jpg|jpeg|webp|gif)$/.test(req.url)) {
    event.respondWith(cacheFirstWithFallback(req, IMAGE_CACHE, PLACEHOLDER));
    return;
  }
  if (req.url.endsWith('.json')) {
    event.respondWith(networkFirst(req, JSON_CACHE));
    return;
  }
  event.respondWith(cacheFirst(req));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    if (resp && resp.status === 200 && resp.type !== 'opaque') {
      cache.put(request, resp.clone()).catch(()=>{});
    }
    return resp;
  } catch (e) {
    const fallback = await caches.match(request) || await caches.match(OFFLINE_URL);
    return fallback;
  }
}

async function networkFirst(request, cacheName = CACHE_NAME) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type !== 'opaque') {
      cache.put(request, response.clone()).catch(()=>{});
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request) || await caches.match(OFFLINE_URL);
    return cached;
  }
}

async function cacheFirstWithFallback(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    if (resp && (resp.status === 200 || resp.type === 'opaque')) {
      await cache.put(request, resp.clone());
      return resp;
    }
  } catch (e) {}
  const ph = await caches.match(fallbackUrl);
  return ph || Response.error();
}

/* --- PUSH handler: receive push payload from server (web-push) and show a notification */
self.addEventListener('push', function(event) {
  try {
    const data = event.data ? event.data.json() : {};
    const payload = data.payload || data;
    const title = data.title || (payload && payload.name) || 'TF-Chat';
    const body = data.body || (payload && (payload.content || payload.text)) || 'Nouveau message';
    const icon = data.icon || '/images/tf-notif.png';
    const opts = {
      body,
      icon,
      badge: icon,
      data: payload || {},
      renotify: true,
      vibrate: [100,50,100]
    };
    event.waitUntil(self.registration.showNotification(title, opts));
  } catch(e){
    console.warn('push handler parse err', e);
  }
});

/* --- notification click: open or focus the chat window (open TFID path when possible) */
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const data = event.notification.data || {};
  const tfid = data.tfid || (data.payload && data.payload.tfid) || null;
  const urlToOpen = tfid ? `${self.location.origin}/${encodeURIComponent(tfid)}` : self.location.origin;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
    for (let i = 0; i < windowClients.length; i++) {
      const client = windowClients[i];
      if (client.url === urlToOpen && 'focus' in client) return client.focus();
    }
    if (clients.openWindow) return clients.openWindow(urlToOpen);
  }));
});

// sw.js (version push + sync + safe streaming bypass)
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
    // attempt to fetch index.json thumbs/json (no videos)
    try {
      const resp = await fetch('/index.json', { cache: 'no-cache' });
      if (resp && (resp.ok || resp.type === 'opaque')) {
        const index = await resp.json();
        const imageCache = await caches.open(IMAGE_CACHE);
        const jsonCache = await caches.open(JSON_CACHE);
        const urls = new Set();
        if (Array.isArray(index)) {
          index.forEach(it => {
            if (it['Url Thumb']) urls.add(normalizeUrl(it['Url Thumb']));
            if (it.json) urls.add(normalizeUrl(it.json));
          });
        } else {
          Object.values(index).forEach(v => {
            if (typeof v === 'string' && (v.endsWith('.json') || /\.(jpg|jpeg|png|webp)$/.test(v))) urls.add(normalizeUrl(v));
          });
        }
        await Promise.allSettled(Array.from(urls).map(u => {
          if (u.endsWith('.json')) {
            return fetch(u, { cache: 'no-cache' }).then(r => {
              if (r && (r.status === 200 || r.type === 'opaque')) return jsonCache.put(u, r.clone());
            }).catch(()=>{});
          }
          if (/\.(jpg|jpeg|png|webp)$/.test(u)) {
            return fetch(u, { cache: 'no-cache' }).then(r => {
              if (r && (r.status === 200 || r.type === 'opaque')) return imageCache.put(u, r.clone());
            }).catch(()=>{});
          }
          return Promise.resolve();
        }));
      }
    } catch (e) {
      console.warn('Failed to fetch index.json during install', e);
    }
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
  try {
    const url = new URL(u, self.location.origin);
    return url.href;
  } catch(e) {
    return u;
  }
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
  } catch(e) {
    return true;
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (shouldBypass(req)) {
    event.respondWith(fetch(req));
    return;
  }

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

/* =============== Push & notifications =============== */
/*
  NOTE: server must send push using subscription stored.
  Notification icon/badge: use custom images (replace with your assets).
*/
const DEFAULT_NOTIFY_ICON = '/images/notification-128.png';
const DEFAULT_NOTIFY_BADGE = '/images/notification-badge.png';

self.addEventListener('push', event => {
  try {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'TF-Chat';
    const body = data.body || (data.message || 'Nouveau message');
    const tag = data.tag || ('tfchat-' + (data.conversation || Math.random().toString(36).slice(2)));
    const dataPayload = data.data || data;
    const options = {
      body,
      tag,
      data: dataPayload,
      icon: data.icon || DEFAULT_NOTIFY_ICON,
      badge: data.badge || DEFAULT_NOTIFY_BADGE,
      renotify: !!data.renotify,
      timestamp: Date.now()
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    console.warn('push handler error', e);
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const urlToOpen = data.url || '/';
  event.waitUntil((async () => {
    const all = await clients.matchAll({ includeUncontrolled: true, type: 'window' });
    for (const c of all) {
      try {
        const u = new URL(c.url);
        if (u.pathname === '/' || c.visibilityState === 'visible') {
          // focus a client and post message
          c.focus();
          c.postMessage({ action: 'openConversation', data });
          return;
        }
      } catch(e){}
    }
    // otherwise open a new window/tab
    await clients.openWindow(urlToOpen);
  })());
});

/* allow page -> sw message to trigger a notification (used when we have WS and page is open but want sw to show) */
self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d && d.action === 'showNotification') {
    const title = d.title || 'TF-Chat';
    const options = d.options || {};
    event.waitUntil(self.registration.showNotification(title, options));
  }
});

/* Background Sync — flush queued sends when back online */
self.addEventListener('sync', (event) => {
  if (event.tag && event.tag.startsWith('tf-send-queue')) {
    event.waitUntil((async () => {
      // read queue from IDB/localForage? We don't have IDB here in generic example.
      // recommended: implement an indexedDB queue in client and in SW read it to flush.
      // For now send a post to server endpoint that will reconcile pending messages.
      try {
        await fetch('/_background/sync-send', { method: 'POST', credentials: 'include' });
      } catch(e) { console.warn('bg sync flush failed', e); }
    })());
  }
});

/* handle pushsubscriptionchange so client can resend */
self.addEventListener('pushsubscriptionchange', (event) => {
  // Notify clients to re-subscribe
  event.waitUntil((async () => {
    const clientsList = await clients.matchAll({ includeUncontrolled: true });
    for (const c of clientsList) {
      c.postMessage({ action: 'reSubscribePush' });
    }
  })());
});

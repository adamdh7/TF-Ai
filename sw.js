const CACHE_NAME = 'tfstream-shell-v1';
const IMAGE_CACHE = 'tfstream-thumbs-v1';
const JSON_CACHE = 'tfstream-json-v1';
// on déclare VIDEO_CACHE mais on évite de mettre des vidéos dedans
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

// --- INSTALL ---
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // on tente de precacher, mais on tolère les erreurs individuelles
    await Promise.allSettled(
      PRECACHE_URLS.map(u =>
        fetch(u, { cache: 'no-cache' }).then(res => {
          if (!res || (res.status !== 200 && res.type !== 'opaque')) throw new Error(`${u} -> ${res && res.status}`);
          return cache.put(new Request(u, { credentials: 'same-origin' }), res.clone());
        }).catch(err => {
          // log, mais on n'arrête pas l'installation
          console.warn('Precache failed for', u, err);
        })
      )
    );

    // tente de précacher thumbnails/json présents dans index.json (si accessible)
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
          if (!u) return Promise.resolve();
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

// --- ACTIVATE ---
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

// --- HELPERS ---
function normalizeUrl(u) {
  try {
    const url = new URL(u, self.location.origin);
    return url.href;
  } catch(e) {
    return u;
  }
}

/*
  Decide si nou dwe BYPASS Service Worker (pa entèsepte)
  - non-GET requests => bypass
  - Range header (videostreaming partial) => bypass
  - destination video/audio => bypass
  - url with video extensions => bypass
*/
function shouldBypass(request) {
  try {
    if (request.method !== 'GET') return true;
    if (request.headers && request.headers.get && request.headers.get('range')) return true;
    const dest = request.destination || '';
    if (dest === 'video' || dest === 'audio') return true;
    const url = request.url || '';
    if (/\.(mp4|webm|m3u8|mpd|mov|mkv|flv)(\?.*)?$/i.test(url)) return true;
    return false;
  } catch(e) {
    return true;
  }
}

// --- FETCH STRATEGIES ---
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // bypass heavy/streaming requests
  if (shouldBypass(req)) {
    event.respondWith(fetch(req));
    return;
  }

  // navigation (HTML): network-first fallback to offline page
  if (req.mode === 'navigate' || (req.headers.get('accept')||'').includes('text/html')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // images: cache-first, fallback to placeholder
  if (req.destination === 'image' || /\.(png|jpg|jpeg|webp|gif)$/.test(req.url)) {
    event.respondWith(cacheFirstWithFallback(req, IMAGE_CACHE, PLACEHOLDER));
    return;
  }

  // json: network-first with cache fallback
  if (req.url.endsWith('.json')) {
    event.respondWith(networkFirst(req, JSON_CACHE));
    return;
  }

  // other static assets (css/js): cache-first then network
  event.respondWith(cacheFirst(req));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    // cache only safe responses: status 200 and non-opaque for app shell assets
    if (resp && resp.status === 200 && resp.type !== 'opaque') {
      cache.put(request, resp.clone()).catch(()=>{});
    }
    return resp;
  } catch (e) {
    // fall back to cached asset or offline page for navigations
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
  } catch (e) {
    // ignored
  }
  // fallback placeholder from global cache; if not found return Response.error()
  const ph = await caches.match(fallbackUrl);
  return ph || Response.error();
}

// --- NOTIFICATIONS / PUSH HANDLERS ---
// Note: we intentionally DO NOT set an "icon" property here to avoid a bell icon.
// You can still include 'badge' or 'image' if you want visuals from server.
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Try to find a client to focus
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        // If client already open, focus and navigate
        // Use startsWith check because client.url may include query params
        try {
          if (client.url === url || client.url.indexOf(url) !== -1) {
            return client.focus().then(c => {
              // try to navigate to the exact url (some browsers restrict navigate)
              try { return c.navigate(url); } catch(e){ return; }
            }).catch(()=>{});
          }
        } catch(e){}
      }
      // Otherwise open a new window
      return clients.openWindow(url);
    })
  );
});

self.addEventListener('notificationclose', function(event) {
  // optional: could inform server notification was dismissed
  // const data = event.notification.data || {};
  // post to analytics endpoint if desired
});

// push event from Web Push (if server configured)
self.addEventListener('push', function(event) {
  let payload = null;
  try {
    if (event.data) payload = event.data.json();
  } catch(e) {
    try { payload = { body: event.data.text() }; } catch(_){}
  }
  const title = (payload && payload.title) ? payload.title : 'TF-Chat';
  const body = (payload && payload.body) ? payload.body : (payload && payload.message) ? payload.message : 'Nouveau message';
  const tag = payload && payload.tag ? payload.tag : undefined;
  // data: we try to include a navigation target like '/TF-1234567' or '/groupe/name'
  const data = (payload && payload.data) ? payload.data : (payload && payload.url) ? { url: payload.url } : {};
  const options = Object.assign({
    body: body,
    tag: tag,
    data: data,
    renotify: true
    // Note: no icon set to avoid default bell icon
    // If you want a badge, you can set "badge: '/path/to/badge.png'"
  }, payload && payload.options ? payload.options : {});
  event.waitUntil(self.registration.showNotification(title, options));
});

// allow pages to send a message to the SW to request a notification
self.addEventListener('message', event => {
  const msg = event.data || {};
  if (msg && msg.type === 'show-notification') {
    const title = msg.title || 'TF-Chat';
    const options = Object.assign({
      body: msg.body || '',
      data: msg.data || {},
      renotify: true
    }, msg.options || {});
    // showNotification returns a promise
    event.waitUntil(self.registration.showNotification(title, options));
  }
});

// --- optional: handle fetch errors for video attempts gracefully ---
// Already bypassing most video requests; but as extra safeguard:
// if a fetch for a media resource still errors, we allow downstream to handle it.

// End of sw.js

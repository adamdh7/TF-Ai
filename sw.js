// sw.js - improved push handler with aggregation & actions
const CACHE_NAME = 'tfstream-shell-v1';
const OFFLINE_URL = '/offline.html';

// precache minimal (keep as you had)
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', evt => { evt.waitUntil(self.clients.claim()); });

self.addEventListener('push', async function(event) {
  try {
    const data = event.data ? event.data.json() : {};
    // server may send payload as { title, messages: [...], tfid, icon, badge }
    const tfid = data.tfid || (data.payload && data.payload.tfid) || 'unknown';
    const title = data.title || 'TF-Chat';
    let messages = [];
    if(Array.isArray(data.messages) && data.messages.length) {
      messages = data.messages;
    } else if(data.payload && data.payload.line) {
      messages = [data.payload.line];
    } else if(data.body) {
      messages = [data.body];
    } else if(data.payload && (data.payload.content || data.payload.text)) {
      messages = [data.payload.content || data.payload.text];
    }

    // try to get previous notifications with same tag (same conversation) and aggregate
    const tag = 'tfchat-' + tfid;
    let old = [];
    try {
      const reg = self.registration;
      const existing = await reg.getNotifications({ tag });
      existing.forEach(n => {
        if(n && n.data && n.data.lines) old = old.concat(n.data.lines || []);
        else if(n && n.body) old.push(n.body);
      });
    } catch(e){ /* ignore */ }

    // combine old and new (keep most recent up to 5)
    const combined = (old.concat(messages)).slice(-5);
    const body = combined.join('\n');

    const icon = data.icon || '/images/tf-notif.png';
    const badge = data.badge || '/images/notification-badge.png';
    const opts = {
      body,
      icon,
      badge,
      tag,
      renotify: true,
      data: { tfid, url: data.url || ('/' + encodeURIComponent(tfid)), lines: combined },
      actions: [
        { action: 'open', title: 'Ouvrir' },
        { action: 'reply', title: 'Répondre' }
      ],
      vibrate: [100,50,100],
      requireInteraction: false
    };
    event.waitUntil(self.registration.showNotification(title, opts));
  } catch(e){
    console.warn('sw push parse err', e);
  }
});

self.addEventListener('notificationclick', function(event) {
  const action = event.action;
  const data = event.notification.data || {};
  const tfid = data.tfid || null;
  event.notification.close();
  const urlToOpen = tfid ? `${self.location.origin}/${encodeURIComponent(tfid)}` : self.location.origin;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windowClients => {
    // if already open, focus and navigate
    for (let i = 0; i < windowClients.length; i++) {
      const client = windowClients[i];
      if (client.url === urlToOpen && 'focus' in client) {
        client.postMessage({ type: 'notification-click', action, tfid });
        return client.focus();
      }
    }
    if (clients.openWindow) {
      const newClient = await clients.openWindow(urlToOpen);
      if(newClient) newClient.postMessage({ type: 'notification-click', action, tfid });
    }
  }));
});

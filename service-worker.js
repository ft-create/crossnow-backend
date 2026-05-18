/**
 * Cross Now — Service Worker
 * Handles push notifications and offline caching.
 * Place this file at the ROOT of your Netlify site (same level as crossnow.html).
 * Rename crossnow.html to index.html for this to work correctly.
 */

const CACHE_NAME = 'crossnow-v1';
const OFFLINE_URLS = ['/'];

// Cache the app shell on install
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(OFFLINE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Serve from cache when offline
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Handle incoming push notifications
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try { data = event.data.json(); }
  catch { data = { title: 'Cross Now', body: event.data.text() }; }

  const options = {
    body:    data.body,
    icon:    '/icon-192.png',
    badge:   '/badge-96.png',
    vibrate: [200, 100, 200],
    tag:     'border-alert',     // replaces previous notification
    renotify: true,
    data:    { url: data.url || '/' },
    actions: [
      { action: 'open',    title: 'Open Cross Now' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Cross Now Border Alert', options)
  );
});

// Notification click — open the app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('/');
    })
  );
});

const CACHE = 'rayan-cmms-shell-7';
const SHELL = [
  '/login.html',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function noticeOptions(payload) {
  const tag = payload.tag || `cmms-${Date.now()}`;
  return {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    lang: 'ar',
    dir: 'rtl',
    tag,
    renotify: true,
    silent: false,
    requireInteraction: true,
    vibrate: [180, 80, 180, 80, 280],
    timestamp: Date.now(),
    data: { url: payload.url || '/index.html#work-orders' },
    actions: [
      { action: 'open', title: 'فتح' },
      { action: 'dismiss', title: 'إغلاق' },
    ],
  };
}

self.addEventListener('push', (event) => {
  let payload = { title: 'RAYAN CMMS', body: '', url: '/index.html#work-orders' };
  try {
    payload = { ...payload, ...(event.data ? event.data.json() : {}) };
  } catch (_) {
    payload.body = event.data ? event.data.text() : '';
  }
  event.waitUntil(Promise.all([
    self.registration.showNotification(payload.title || 'RAYAN CMMS', noticeOptions(payload)),
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      clients.forEach((client) => client.postMessage({
        type: 'cmms-push',
        title: payload.title,
        body: payload.body,
        url: payload.url,
        sound: true,
      }));
    }),
  ]));
});

self.addEventListener('notificationclick', (event) => {
  const action = event.action;
  event.notification.close();
  if (action === 'dismiss') return;
  const target = new URL(event.notification.data?.url || '/index.html#work-orders', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const open = windows.find((client) => client.url.startsWith(self.location.origin));
    if (open) {
      if ('navigate' in open) open.navigate(target);
      return open.focus();
    }
    return self.clients.openWindow(target);
  }));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === '/sw.js') return;
  const pageOrAsset = request.mode === 'navigate' || /\.(css|js|png|webmanifest|html|ico)$/.test(url.pathname);
  if (!pageOrAsset) return;

  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request).then((cached) => cached || (request.mode === 'navigate' ? caches.match('/login.html') : undefined)))
  );
});

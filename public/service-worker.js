const UBEE_CACHE = 'ubee-runtime-v1';
const UBEE_FALLBACK_URL = '/';

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(UBEE_CACHE).then(cache => cache.addAll([UBEE_FALLBACK_URL])).catch(() => undefined)
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then(keys => Promise.all(keys.filter(key => key !== UBEE_CACHE).map(key => caches.delete(key))))
    ])
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then(hit => hit || caches.match(UBEE_FALLBACK_URL)))
  );
});

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch { payload = { body: event.data ? event.data.text() : '' }; }

  const title = payload.title || 'UBee 跑腿';
  const options = {
    body: payload.body || '你有一則新的訂單訊息。',
    icon: payload.icon || '/ubee-rider-icon.png?v=1',
    badge: payload.badge || '/ubee-rider-icon.png?v=1',
    tag: payload.tag || (payload.orderId ? `ubee-order-${payload.orderId}` : 'ubee-notification'),
    renotify: true,
    data: {
      url: payload.url || (payload.orderId ? `/rider.html?orderId=${encodeURIComponent(payload.orderId)}` : '/'),
      orderId: payload.orderId || ''
    }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return clients.openWindow ? clients.openWindow(targetUrl) : undefined;
    })
  );
});

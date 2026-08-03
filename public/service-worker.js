/* UBee 跑腿用戶端 PWA｜正式營運版 */
const CACHE_NAME = 'ubee-customer-pwa-v20260803-1';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
  '/order.html',
  '/manifest-order.json',
  '/offline.html',
  '/ubee-customer-icon-192.png',
  '/ubee-customer-icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith('ubee-customer-pwa-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        return response;
      }).catch(async () => (await caches.match(request)) || caches.match(OFFLINE_URL))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok && ['style','script','image','font'].includes(request.destination)) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }))
  );
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { body: event.data ? event.data.text() : '' }; }
  const isRider = Boolean(data.orderId) || /rider|dispatch|task/i.test(String(data.type || ''));
  const orderId = String(data.orderId || '').trim().toUpperCase();
  const defaultUrl = isRider
    ? (orderId ? `/rider.html?orderId=${encodeURIComponent(orderId)}&tab=task&source=push` : '/rider.html?tab=notify&source=push')
    : '/order.html';
  event.waitUntil(self.registration.showNotification(data.title || (isRider ? 'UBee Driver' : 'UBee 跑腿'), {
    body: data.body || (isRider ? '有新的 UBee 跑腿任務等待你查看。' : '你的跑腿任務有新進度。'),
    icon: data.icon || (isRider ? '/ubee-rider-icon-192.png' : '/ubee-customer-icon-192.png'),
    badge: data.badge || (isRider ? '/ubee-rider-icon-192.png' : '/ubee-customer-icon-192.png'),
    tag: data.tag || (orderId ? `ubee-order-${orderId}` : (isRider ? 'ubee-rider' : 'ubee-customer')),
    renotify: true,
    requireInteraction: isRider && Boolean(orderId),
    vibrate: isRider ? [500, 250, 500] : [200, 100, 200],
    data: { url: data.deepLink || data.url || defaultUrl }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification?.data?.url || '/order.html', self.location.origin).href;
  event.waitUntil(clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
    for (const client of list) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) {
        client.navigate(target);
        return client.focus();
      }
    }
    return clients.openWindow ? clients.openWindow(target) : undefined;
  }));
});

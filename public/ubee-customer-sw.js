/* UBee 跑腿用戶端 PWA｜App 化＋即時訂單通知正式版 */

const CACHE_NAME = 'ubee-customer-pwa-v20260804-app-v1';
const OFFLINE_URL = '/offline.html';

const PRECACHE_URLS = [
  '/order.html',
  '/install.html',
  '/manifest-order.json',
  '/offline.html',
  '/ubee-customer-icon-192.png',
  '/ubee-customer-icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => Promise.all(
        cacheNames
          .filter(cacheName => cacheName.startsWith('ubee-customer-pwa-') && cacheName !== CACHE_NAME)
          .map(cacheName => caches.delete(cacheName))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (requestUrl.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    const isOrderPage = requestUrl.pathname === '/' || requestUrl.pathname === '/order.html';
    const isInstallPage = requestUrl.pathname === '/install.html';

    if (isOrderPage || isInstallPage) {
      event.respondWith(
        fetch(request)
          .then(response => {
            if (response && response.ok) {
              const responseCopy = response.clone();
              const cacheKey = isInstallPage ? '/install.html' : '/order.html';
              caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, responseCopy));
            }
            return response;
          })
          .catch(async () => {
            const cachedPage = await caches.match(isInstallPage ? '/install.html' : '/order.html');
            return cachedPage || caches.match(OFFLINE_URL);
          })
      );
      return;
    }
  }

  if (['style','script','image','font'].includes(request.destination)) {
    event.respondWith(
      caches.match(request).then(cachedResponse => {
        if (cachedResponse) return cachedResponse;
        return fetch(request).then(networkResponse => {
          if (networkResponse && networkResponse.ok) {
            const responseCopy = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, responseCopy));
          }
          return networkResponse;
        });
      })
    );
  }
});

self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const targetUrl = String(
    data.deepLink ||
    data.url ||
    (data.orderId
      ? `/order.html?source=push&orderId=${encodeURIComponent(data.orderId)}`
      : '/order.html?source=push')
  );

  const notificationOptions = {
    body: data.body || '你的 UBee 跑腿訂單有新的進度。',
    icon: data.icon || '/ubee-customer-icon-192.png',
    badge: data.badge || '/ubee-customer-icon-192.png',
    tag: data.tag || `ubee-customer-${data.orderId || 'notification'}`,
    renotify: false,
    vibrate: [200,100,200],
    data: {
      url: targetUrl,
      orderId: data.orderId || '',
      status: data.status || ''
    }
  };

  event.waitUntil(
    self.registration.showNotification(
      data.title || 'UBee 跑腿',
      notificationOptions
    )
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  let targetUrl;

  try {
    targetUrl = new URL(
      event.notification?.data?.url || '/order.html?source=push',
      self.location.origin
    );

    if (targetUrl.origin !== self.location.origin) {
      targetUrl = new URL('/order.html?source=push', self.location.origin);
    }
  } catch (_) {
    targetUrl = new URL('/order.html?source=push', self.location.origin);
  }

  event.waitUntil(
    self.clients.matchAll({type:'window',includeUncontrolled:true})
      .then(async windowClients => {
        const customerClient = windowClients.find(client => {
          try {
            const clientUrl = new URL(client.url);
            return clientUrl.origin === self.location.origin && clientUrl.pathname === '/order.html';
          } catch (_) {
            return false;
          }
        });

        if (customerClient) {
          if ('navigate' in customerClient) {
            await customerClient.navigate(targetUrl.href);
          }
          return customerClient.focus();
        }

        return self.clients.openWindow ? self.clients.openWindow(targetUrl.href) : undefined;
      })
  );
});

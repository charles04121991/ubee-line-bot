/* UBee 跑腿用戶端 PWA｜App 化＋即時訂單通知正式修復版
 * 版本：2026-08-06 Customer V2.3 Instant Navigation
 * 重點：
 * 1. order.html 與 install.html 使用 Network First，強制優先取得最新版本。
 * 2. Service Worker 更新後立即接管，並刪除舊版 UBee 快取。
 * 3. 靜態程式檔採 Network First；圖片與字型採 Stale While Revalidate。
 * 4. 預快取單一檔案失敗時，不會讓整個 Service Worker 安裝失敗。
 */

const CACHE_NAME = 'ubee-customer-pwa-v20260806-customer-v23-instant-nav';
const CACHE_PREFIX = 'ubee-customer-pwa-';
const APP_VERSION = '20260806-7';

const OFFLINE_URL = '/offline.html';
const ORDER_CACHE_KEY = '/order.html';
const INSTALL_CACHE_KEY = '/install.html';

const PRECACHE_ENTRIES = [
  { url: `/order.html?v=${APP_VERSION}`, key: ORDER_CACHE_KEY },
  { url: `/install.html?v=${APP_VERSION}`, key: INSTALL_CACHE_KEY },
  { url: `/manifest-order.json?v=${APP_VERSION}`, key: '/manifest-order.json' },
  { url: OFFLINE_URL, key: OFFLINE_URL },
  { url: `/stores-taichung.json?v=${APP_VERSION}`, key: '/stores-taichung.json' },
  { url: '/ubee-customer-icon-192.png', key: '/ubee-customer-icon-192.png' },
  { url: '/ubee-customer-icon-512.png', key: '/ubee-customer-icon-512.png' }
];

async function fetchFresh(request) {
  return fetch(new Request(request, {
    cache: 'no-store',
    credentials: request.credentials,
    redirect: request.redirect
  }));
}

async function putResponse(cacheKey, response) {
  if (!response || !response.ok) return;

  const cache = await caches.open(CACHE_NAME);
  await cache.put(cacheKey, response.clone());
}

async function precacheAppShell() {
  const cache = await caches.open(CACHE_NAME);

  await Promise.allSettled(
    PRECACHE_ENTRIES.map(async ({ url, key }) => {
      const response = await fetch(url, { cache: 'reload' });

      if (!response.ok) {
        throw new Error(`預快取失敗：${url}（HTTP ${response.status}）`);
      }

      await cache.put(key, response);
    })
  );
}

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      await precacheAppShell();
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();

      await Promise.all(
        cacheNames
          .filter(cacheName => (
            cacheName.startsWith(CACHE_PREFIX) &&
            cacheName !== CACHE_NAME
          ))
          .map(cacheName => caches.delete(cacheName))
      );

      if ('navigationPreload' in self.registration) {
        await self.registration.navigationPreload.enable().catch(() => {});
      }

      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

async function networkFirstPage(event, cacheKey) {
  try {
    const preloadResponse = await event.preloadResponse;

    if (preloadResponse?.ok) {
      event.waitUntil(putResponse(cacheKey, preloadResponse));
      return preloadResponse;
    }

    const networkResponse = await fetchFresh(event.request);

    if (networkResponse?.ok) {
      event.waitUntil(putResponse(cacheKey, networkResponse));
    }

    return networkResponse;
  } catch (_) {
    const cachedPage = await caches.match(cacheKey);
    if (cachedPage) return cachedPage;

    const offlinePage = await caches.match(OFFLINE_URL);
    if (offlinePage) return offlinePage;

    return new Response('目前無法連線，請稍後再試。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function networkFirstAsset(request) {
  try {
    const response = await fetchFresh(request);

    if (response?.ok) {
      await putResponse(request, response);
    }

    return response;
  } catch (_) {
    const cachedResponse = await caches.match(request);
    return cachedResponse || Response.error();
  }
}

async function staleWhileRevalidate(event) {
  const request = event.request;
  const cachedResponsePromise = caches.match(request);

  const networkResponsePromise = fetch(request, { cache: 'no-cache' })
    .then(async response => {
      if (response?.ok) {
        await putResponse(request, response);
      }
      return response;
    });

  event.waitUntil(networkResponsePromise.catch(() => {}));

  const cachedResponse = await cachedResponsePromise;
  if (cachedResponse) return cachedResponse;

  try {
    return await networkResponsePromise;
  } catch (_) {
    return Response.error();
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;

  const requestUrl = new URL(request.url);

  if (requestUrl.origin !== self.location.origin) return;
  if (requestUrl.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    const isOrderPage = (
      requestUrl.pathname === '/' ||
      requestUrl.pathname === '/order.html'
    );
    const isInstallPage = requestUrl.pathname === '/install.html';

    if (isOrderPage) {
      event.respondWith(networkFirstPage(event, ORDER_CACHE_KEY));
      return;
    }

    if (isInstallPage) {
      event.respondWith(networkFirstPage(event, INSTALL_CACHE_KEY));
      return;
    }

    return;
  }

  if (['style', 'script', 'worker', 'manifest'].includes(request.destination)) {
    event.respondWith(networkFirstAsset(request));
    return;
  }

  if (['image', 'font'].includes(request.destination)) {
    event.respondWith(staleWhileRevalidate(event));
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
    vibrate: [200, 100, 200],
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
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(async windowClients => {
        const customerClient = windowClients.find(client => {
          try {
            const clientUrl = new URL(client.url);
            return (
              clientUrl.origin === self.location.origin &&
              (clientUrl.pathname === '/order.html' || clientUrl.pathname === '/')
            );
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

        return self.clients.openWindow
          ? self.clients.openWindow(targetUrl.href)
          : undefined;
      })
  );
});

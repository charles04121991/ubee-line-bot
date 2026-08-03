/* UBee 跑腿用戶端 PWA｜正式營運版 */

const CACHE_NAME = 'ubee-customer-pwa-v20260803-1';

const OFFLINE_URL = '/offline.html';

const PRECACHE_URLS = [
  '/order.html',
  '/manifest-order.json',
  '/offline.html',
  '/ubee-customer-icon-192.png',
  '/ubee-customer-icon-512.png'
];

/* 安裝 Service Worker，預先儲存基本檔案 */
self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
  );

  self.skipWaiting();
});

/* 啟用新版並清除舊的用戶端快取 */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(cacheName => {
              return (
                cacheName.startsWith('ubee-customer-pwa-') &&
                cacheName !== CACHE_NAME
              );
            })
            .map(cacheName => caches.delete(cacheName))
        );
      })
      .then(() => self.clients.claim())
  );
});

/* 處理網頁與靜態檔案請求 */
self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(request.url);

  /* 不處理其他網站的檔案 */
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  /* API 必須永遠讀取最新資料，不進入 PWA 快取 */
  if (requestUrl.pathname.startsWith('/api/')) {
    return;
  }

  /* 用戶端頁面採用網路優先 */
  if (
    request.mode === 'navigate' &&
    (
      requestUrl.pathname === '/' ||
      requestUrl.pathname === '/order.html'
    )
  ) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.ok) {
            const responseCopy = response.clone();

            caches
              .open(CACHE_NAME)
              .then(cache => cache.put('/order.html', responseCopy));
          }

          return response;
        })
        .catch(async () => {
          const orderPage = await caches.match('/order.html');

          if (orderPage) {
            return orderPage;
          }

          return caches.match(OFFLINE_URL);
        })
    );

    return;
  }

  /* 其他用戶端靜態檔案採用快取優先 */
  if (
    ['style', 'script', 'image', 'font'].includes(
      request.destination
    )
  ) {
    event.respondWith(
      caches.match(request).then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }

        return fetch(request).then(networkResponse => {
          if (networkResponse && networkResponse.ok) {
            const responseCopy = networkResponse.clone();

            caches
              .open(CACHE_NAME)
              .then(cache => cache.put(request, responseCopy));
          }

          return networkResponse;
        });
      })
    );
  }
});

/* 接收用戶端訂單通知 */
self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {
      body: event.data ? event.data.text() : ''
    };
  }

  const targetUrl = String(
    data.deepLink ||
    data.url ||
    '/order.html?source=push'
  );

  const notificationOptions = {
    body: data.body || '你的 UBee 跑腿訂單有新的進度。',
    icon: data.icon || '/ubee-customer-icon-192.png',
    badge: data.badge || '/ubee-customer-icon-192.png',
    tag: data.tag || 'ubee-customer-notification',
    renotify: true,
    vibrate: [200, 100, 200],
    data: {
      url: targetUrl
    }
  };

  event.waitUntil(
    self.registration.showNotification(
      data.title || 'UBee 跑腿',
      notificationOptions
    )
  );
});

/* 點擊通知後開啟用戶端 */
self.addEventListener('notificationclick', event => {
  event.notification.close();

  let targetUrl;

  try {
    targetUrl = new URL(
      event.notification?.data?.url ||
      '/order.html?source=push',
      self.location.origin
    );

    if (targetUrl.origin !== self.location.origin) {
      targetUrl = new URL(
        '/order.html?source=push',
        self.location.origin
      );
    }
  } catch (_) {
    targetUrl = new URL(
      '/order.html?source=push',
      self.location.origin
    );
  }

  event.waitUntil(
    self.clients
      .matchAll({
        type: 'window',
        includeUncontrolled: true
      })
      .then(windowClients => {
        const customerClient = windowClients.find(client => {
          try {
            const clientUrl = new URL(client.url);

            return (
              clientUrl.origin === self.location.origin &&
              clientUrl.pathname === '/order.html'
            );
          } catch (_) {
            return false;
          }
        });

        if (customerClient) {
          if ('navigate' in customerClient) {
            return customerClient
              .navigate(targetUrl.href)
              .then(() => customerClient.focus());
          }

          return customerClient.focus();
        }

        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl.href);
        }

        return undefined;
      })
  );
});

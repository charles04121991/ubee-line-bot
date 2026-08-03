/* UBee 跑腿用戶端 PWA｜正式營運版 */
const CACHE_NAME = 'ubee-customer-pwa-v20260803-2';
const OFFLINE_URL = '/offline.html';

const PRECACHE = [
  '/order.html',
  '/manifest-order.json',
  '/offline.html',
  '/ubee-customer-icon-192.png',
  '/ubee-customer-icon-512.png'
];

/* 安裝：預先快取必要檔案 */
self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
  );

  self.skipWaiting();
});

/* 啟用：清除舊版 UBee 用戶端快取 */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(
              key =>
                key.startsWith('ubee-customer-pwa-') &&
                key !== CACHE_NAME
            )
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* 網路請求與離線處理 */
self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /* 不攔截外部網域資源 */
  if (url.origin !== self.location.origin) return;

  /* 頁面導覽：優先連線，失敗時使用快取或離線頁 */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();

          caches
            .open(CACHE_NAME)
            .then(cache => cache.put(request, copy));

          return response;
        })
        .catch(async () => {
          return (
            (await caches.match(request)) ||
            caches.match(OFFLINE_URL)
          );
        })
    );

    return;
  }

  /* 靜態資源：優先快取，沒有才連線 */
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        if (
          response.ok &&
          ['style', 'script', 'image', 'font'].includes(
            request.destination
          )
        ) {
          const copy = response.clone();

          caches
            .open(CACHE_NAME)
            .then(cache => cache.put(request, copy));
        }

        return response;
      });
    })
  );
});

/* 客戶端推播通知 */
self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      body: event.data ? event.data.text() : ''
    };
  }

  const orderId = String(data.orderId || '')
    .trim()
    .toUpperCase();

  const defaultUrl = orderId
    ? `/order.html?orderId=${encodeURIComponent(orderId)}&source=push`
    : '/order.html?source=push';

  event.waitUntil(
    self.registration.showNotification(
      data.title || 'UBee 跑腿',
      {
        body:
          data.body ||
          '你的跑腿任務有新進度。',

        icon:
          data.icon ||
          '/ubee-customer-icon-192.png',

        badge:
          data.badge ||
          '/ubee-customer-icon-192.png',

        tag:
          data.tag ||
          (
            orderId
              ? `ubee-customer-order-${orderId}`
              : 'ubee-customer'
          ),

        renotify: true,
        requireInteraction: false,
        vibrate: [200, 100, 200],

        data: {
          url:
            data.deepLink ||
            data.url ||
            defaultUrl,

          orderId
        }
      }
    )
  );
});

/* 點擊通知：開啟或切換到 UBee 用戶端 */
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const target = new URL(
    event.notification?.data?.url || '/order.html',
    self.location.origin
  ).href;

  event.waitUntil(
    clients
      .matchAll({
        type: 'window',
        includeUncontrolled: true
      })
      .then(list => {
        for (const client of list) {
          if (
            client.url.startsWith(self.location.origin) &&
            'focus' in client
          ) {
            if ('navigate' in client) {
              client.navigate(target);
            }

            return client.focus();
          }
        }

        return clients.openWindow
          ? clients.openWindow(target)
          : undefined;
      })
  );
});

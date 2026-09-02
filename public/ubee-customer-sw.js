/*
 * ============================================================
 * UBee 跑腿｜用戶端 Service Worker
 * Version: 2026.09.02.2 Home Live Supply V2.1 Production Flow Fix
 * File: ubee-customer-sw.js
 *
 * 2026-09-02 Home Live Supply V2.1 Production Flow Fix：同步正式 productionOrderFlow 首頁即時運力卡版本，並清除舊 Customer Cache。
 *
 * 2026-08-11 Identity V1 更新：
 * 1. 實名制 / 會員 / 訂單 API 一律 Network Only，不寫入 Cache。
 * 2. HTML / navigation 採 Network First，避免 PWA 長期停在舊版 order.html。
 * 3. 靜態資源採 Stale While Revalidate。
 * 4. 啟用新版 SW 時清除舊版 UBee Customer Cache。
 * 5. 保留 Web Push、通知點擊與 App Badge 基本能力。
 * ============================================================
 */

'use strict';

const UBEE_CUSTOMER_SW_VERSION = '2026.09.02.2-live-supply-v2-1-production-flow-fix';

const CACHE_PREFIX = 'ubee-customer-';
const STATIC_CACHE = `${CACHE_PREFIX}static-${UBEE_CUSTOMER_SW_VERSION}`;
const PAGE_CACHE = `${CACHE_PREFIX}page-${UBEE_CUSTOMER_SW_VERSION}`;

const APP_SHELL = [
  '/order.html',
  '/manifest-order.json',
  '/ubee-customer-icon-192.png',
  '/ubee-customer-icon-512.png'
];

/*
 * 這些路徑包含登入 Session、會員資料、實名狀態、訂單與即時資訊。
 * 永遠不得由 Service Worker Cache 回傳。
 */
const NETWORK_ONLY_PATH_PREFIXES = [
  '/api/',
  '/api/customer-auth/',
  '/api/customer-identity/',
  '/api/customer/',
  '/api/orders',
  '/api/order',
  '/api/quote'
];

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isNetworkOnlyRequest(request, url) {
  if (!isSameOrigin(url)) return false;

  if (request.method !== 'GET') return true;

  return NETWORK_ONLY_PATH_PREFIXES.some(prefix =>
    url.pathname === prefix ||
    url.pathname.startsWith(prefix)
  );
}

function isNavigationRequest(request) {
  return (
    request.mode === 'navigate' ||
    request.destination === 'document'
  );
}

function isStaticAssetRequest(request, url) {
  if (!isSameOrigin(url)) return false;

  if (
    ['style', 'script', 'image', 'font'].includes(request.destination)
  ) {
    return true;
  }

  return /\.(?:css|js|mjs|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf)$/i
    .test(url.pathname);
}

async function putResponse(cacheName, request, response) {
  if (!response || !response.ok) return;

  if (response.type !== 'basic' && response.type !== 'default') return;

  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  } catch (error) {
    console.warn('UBee Customer SW cache put failed:', error);
  }
}

async function networkOnly(request) {
  /*
   * API 不經 Service Worker Cache。
   * 後端實名 API 同時已使用 Cache-Control: no-store。
   */
  return fetch(request);
}

async function networkFirstPage(request) {
  try {
    const response = await fetch(request, {
      cache: 'no-store'
    });

    if (response && response.ok) {
      await putResponse(PAGE_CACHE, request, response);
    }

    return response;
  } catch (error) {
    const cached = await caches.match(request, {
      ignoreSearch: true
    });

    if (cached) return cached;

    const fallback = await caches.match('/order.html', {
      ignoreSearch: true
    });

    if (fallback) return fallback;

    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request, {
    ignoreSearch: false
  });

  const networkPromise = fetch(request)
    .then(async response => {
      if (response && response.ok) {
        await putResponse(STATIC_CACHE, request, response);
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    return cached;
  }

  const networkResponse = await networkPromise;

  if (networkResponse) {
    return networkResponse;
  }

  return new Response('', {
    status: 504,
    statusText: 'Gateway Timeout'
  });
}

/* ============================================================
 * INSTALL
 * ============================================================
 */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(STATIC_CACHE);

      /*
       * addAll 任何一項失敗會讓整批失敗，因此逐項加入，
       * 避免單一 icon 或 manifest 暫時不可用造成 SW 安裝失敗。
       */
      await Promise.all(
        APP_SHELL.map(async url => {
          try {
            const response = await fetch(url, {
              cache: 'reload'
            });

            if (response && response.ok) {
              await cache.put(url, response.clone());
            }
          } catch (_) {
            // 安裝時單項預快取失敗不阻擋新版 Service Worker。
          }
        })
      );
    } finally {
      await self.skipWaiting();
    }
  })());
});

/* ============================================================
 * ACTIVATE
 * ============================================================
 */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys.map(key => {
        if (
          key.startsWith(CACHE_PREFIX) &&
          key !== STATIC_CACHE &&
          key !== PAGE_CACHE
        ) {
          return caches.delete(key);
        }

        return Promise.resolve(false);
      })
    );

    await self.clients.claim();

    const clientList = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of clientList) {
      client.postMessage({
        type: 'UBEE_CUSTOMER_SW_UPDATED',
        version: UBEE_CUSTOMER_SW_VERSION
      });
    }
  })());
});

/* ============================================================
 * FETCH
 * ============================================================
 */
self.addEventListener('fetch', event => {
  const request = event.request;

  if (!request || !request.url) return;

  const url = new URL(request.url);

  /*
   * 非 HTTP(S) scheme 不處理。
   */
  if (!/^https?:$/.test(url.protocol)) {
    return;
  }

  /*
   * POST / PUT / PATCH / DELETE，以及 UBee API：
   * 全部直接走網路，不進 Cache。
   */
  if (isNetworkOnlyRequest(request, url)) {
    event.respondWith(networkOnly(request));
    return;
  }

  /*
   * 跨網域資源不由 UBee Customer SW 管理，
   * 例如 Google Maps、第三方服務。
   */
  if (!isSameOrigin(url)) {
    return;
  }

  /*
   * order.html / navigation：
   * 一律優先取得伺服器最新版。
   * 只有離線時才使用本機快取。
   */
  if (isNavigationRequest(request)) {
    event.respondWith(networkFirstPage(request));
    return;
  }

  /*
   * 靜態檔案：
   * 先快速回傳快取，同時背景更新。
   */
  if (request.method === 'GET' && isStaticAssetRequest(request, url)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

/* ============================================================
 * WEB PUSH
 * ============================================================
 */
self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {
      body: event.data
        ? event.data.text()
        : 'UBee 跑腿有新的通知。'
    };
  }

  const orderId = String(
    data.orderId ||
    data.id ||
    ''
  ).trim().toUpperCase();

  const fallbackUrl = orderId
    ? `/order.html?orderId=${encodeURIComponent(orderId)}&source=push`
    : '/order.html?source=push';

  const targetUrl = String(
    data.url ||
    data.deepLink ||
    fallbackUrl
  );

  const options = {
    body: data.body || 'UBee 跑腿有新的任務進度通知。',
    icon: data.icon || '/ubee-customer-icon-192.png',
    badge: data.badge || '/ubee-customer-icon-192.png',
    tag: data.tag || (
      orderId
        ? `ubee-customer-order-${orderId}`
        : 'ubee-customer-notification'
    ),
    renotify: data.renotify !== false,
    data: {
      orderId,
      url: targetUrl,
      type: data.type || 'UBEE_CUSTOMER_PUSH'
    }
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(
      data.title || 'UBee 跑腿',
      options
    );

    if (self.registration.setAppBadge) {
      await self.registration.setAppBadge(1).catch(() => {});
    }
  })());
});

/* ============================================================
 * NOTIFICATION CLICK
 * ============================================================
 */
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const data = event.notification.data || {};
  const orderId = String(data.orderId || '')
    .trim()
    .toUpperCase();

  const targetUrl = new URL(
    data.url ||
      (
        orderId
          ? `/order.html?orderId=${encodeURIComponent(orderId)}&source=push`
          : '/order.html?source=push'
      ),
    self.location.origin
  ).href;

  event.waitUntil((async () => {
    const clientList = await clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of clientList) {
      try {
        const clientUrl = new URL(client.url);

        if (clientUrl.origin === self.location.origin) {
          if ('navigate' in client) {
            await client.navigate(targetUrl);
          }

          await client.focus();

          client.postMessage({
            type: 'UBEE_CUSTOMER_OPEN_ORDER',
            orderId,
            url: targetUrl
          });

          if (self.registration.clearAppBadge) {
            await self.registration.clearAppBadge().catch(() => {});
          }

          return;
        }
      } catch (_) {
        // 繼續尋找下一個可用 client。
      }
    }

    if (clients.openWindow) {
      await clients.openWindow(targetUrl);
    }

    if (self.registration.clearAppBadge) {
      await self.registration.clearAppBadge().catch(() => {});
    }
  })());
});

/* ============================================================
 * MESSAGE
 * ============================================================
 */
self.addEventListener('message', event => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (
    data.type === 'UBEE_CLEAR_BADGE' ||
    data.type === 'UBEE_CUSTOMER_CLEAR_BADGE'
  ) {
    if (self.registration.clearAppBadge) {
      event.waitUntil(
        self.registration.clearAppBadge().catch(() => {})
      );
    }
  }
});

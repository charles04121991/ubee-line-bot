/* ============================================================
 * UBee 跑腿｜客戶端 Service Worker｜最新正式版 2026-10-07
 * Release: Customer No-Register Order Session V4 + UCoin Hard Cap V2 + Native Settings V2 + Silent Reconnect V1 + Native Clean UI V1 + Native Smooth UI V1 + My Service Smooth V1
 * Version: 20261008-customer-production-reliability-hotfix-v1
 *
 * Canonical responsibilities:
 * - Customer PWA Cache 隔離與版本更新（同步首頁／訂單／通知／我的／我的U幣）
 * - API / Auth / Orders / Quote 一律 Network Only
 * - order.html Navigation 採 Network First
 * - 靜態資源 Stale While Revalidate
 * - Web Push / Notification Center Deep Link / App Badge
 *
 * 舊 Map Restore 等歷史發版註解已移除；可視地圖不屬於目前客戶端 UI。
 * ============================================================ */
'use strict';

const UBEE_CUSTOMER_SW_VERSION = '20261008-customer-production-reliability-hotfix-v1';

const CACHE_PREFIX = 'ubee-customer-';
const STATIC_CACHE = `${CACHE_PREFIX}static-${UBEE_CUSTOMER_SW_VERSION}`;
const PAGE_CACHE = `${CACHE_PREFIX}page-${UBEE_CUSTOMER_SW_VERSION}`;

const APP_SHELL = [
  '/order.html',
  '/manifest-order.json',
  '/ubee-customer-icon-192.png',
  '/ubee-customer-icon-512.png'
];

const UBEE_CUSTOMER_STATIC_PATHS = new Set([
  '/manifest-order.json',
  '/ubee-customer-icon-192.png',
  '/ubee-customer-icon-512.png'
]);

function isUBeeCustomerClientUrl(clientUrl) {
  try {
    const url = new URL(clientUrl);
    return (
      url.origin === self.location.origin &&
      (url.pathname === '/order.html' || url.pathname.endsWith('/order.html'))
    );
  } catch (_) {
    return false;
  }
}

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

function isCustomerNavigationRequest(request, url) {
  return (
    isSameOrigin(url) &&
    isNavigationRequest(request) &&
    (url.pathname === '/order.html' || url.pathname.endsWith('/order.html'))
  );
}

function isStaticAssetRequest(request, url) {
  if (!isSameOrigin(url) || request.method !== 'GET') return false;
  return UBEE_CUSTOMER_STATIC_PATHS.has(url.pathname);
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

  if (!request || !request.url || request.method !== 'GET') return;

  const url = new URL(request.url);

  if (!/^https?:$/.test(url.protocol) || !isSameOrigin(url)) return;

  // Native Experience V2：Customer SW 只攔截 Customer App 自己的 navigation。
  // /api/*、admin、merchant、support 與其他同源 UBee 系統全部交回瀏覽器原生網路流程。
  if (isCustomerNavigationRequest(request, url)) {
    event.respondWith(networkFirstPage(request));
    return;
  }

  // 只快取 Customer 明確白名單資源，不接管同源其他系統的 CSS / JS / image。
  if (isStaticAssetRequest(request, url)) {
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
  const notificationId = String(data.notificationId || '').trim();

  const fallbackUrl = orderId
    ? `/order.html?orderId=${encodeURIComponent(orderId)}&source=push`
    : notificationId
      ? `/order.html?action=notifications&notificationId=${encodeURIComponent(notificationId)}&source=push`
      : '/order.html?action=notifications&source=push';

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
      notificationId,
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
  const notificationId = String(data.notificationId || '').trim();

  const fallbackPath = orderId
    ? `/order.html?orderId=${encodeURIComponent(orderId)}&source=push`
    : notificationId
      ? `/order.html?action=notifications&notificationId=${encodeURIComponent(notificationId)}&source=push`
      : '/order.html?action=notifications&source=push';

  let targetUrl = new URL(fallbackPath, self.location.origin).href;
  try {
    const requested = new URL(data.url || data.deepLink || fallbackPath, self.location.origin);
    if (
      requested.origin === self.location.origin &&
      (requested.pathname === '/order.html' || requested.pathname.endsWith('/order.html'))
    ) {
      targetUrl = requested.href;
    }
  } catch (_) {}

  event.waitUntil((async () => {
    const clientList = await clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of clientList) {
      try {
        const clientUrl = new URL(client.url);

        if (isUBeeCustomerClientUrl(client.url)) {
          if ('navigate' in client) {
            await client.navigate(targetUrl);
          }

          await client.focus();

          client.postMessage(orderId ? {
            type: 'UBEE_CUSTOMER_OPEN_ORDER',
            orderId,
            url: targetUrl
          } : {
            type: 'UBEE_CUSTOMER_OPEN_NOTIFICATION',
            notificationId,
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

/*
 * ============================================================
 * UBee 跑腿｜用戶端 Service Worker
 * Version: 2026.08.31.1
 * File: ubee-customer-sw.js
 *
 * Customer V2.14 Full Integration：
 * 1. 客戶 API 與所有非 GET 請求一律 Network Only。
 * 2. 僅攔截 UBee Customer 頁面導覽，避免影響同網域其他後台／頁面。
 * 3. order.html 採 Network First，且只保留一份 canonical 離線頁快取。
 * 4. Manifest／Customer Icons 採 Stale While Revalidate。
 * 5. 啟用新版 SW 時移除舊版 UBee Customer Cache。
 * 6. Web Push 只允許導向同網域的 Customer 頁面。
 * 7. 保留通知點擊、App Badge、skipWaiting 基本能力。
 * ============================================================
 */

'use strict';

const UBEE_CUSTOMER_SW_VERSION = '2026.08.31.1';

const CACHE_PREFIX = 'ubee-customer-';
const STATIC_CACHE = `${CACHE_PREFIX}static-${UBEE_CUSTOMER_SW_VERSION}`;
const PAGE_CACHE = `${CACHE_PREFIX}page-${UBEE_CUSTOMER_SW_VERSION}`;

const CUSTOMER_PAGE_PATH = '/order.html';
const CUSTOMER_HOME_PATHS = new Set(['/', CUSTOMER_PAGE_PATH]);

const STATIC_SHELL = [
  '/manifest-order.json',
  '/ubee-customer-icon-192.png',
  '/ubee-customer-icon-512.png'
];

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isCustomerPageUrl(url) {
  return isSameOrigin(url) && CUSTOMER_HOME_PATHS.has(url.pathname);
}

function isNetworkOnlyRequest(request, url) {
  if (!isSameOrigin(url)) return false;

  // 所有寫入行為永遠不進 Cache。
  if (request.method !== 'GET') return true;

  // 所有 UBee API GET 也永遠走最新後端資料。
  return url.pathname === '/api' || url.pathname.startsWith('/api/');
}

function isNavigationRequest(request) {
  return (
    request.mode === 'navigate' ||
    request.destination === 'document'
  );
}

function isCustomerStaticAsset(url) {
  if (!isSameOrigin(url)) return false;

  return (
    url.pathname === '/manifest-order.json' ||
    url.pathname === '/ubee-customer-icon-192.png' ||
    url.pathname === '/ubee-customer-icon-512.png'
  );
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
  return fetch(request);
}

async function networkFirstCustomerPage(request) {
  try {
    const response = await fetch(request, {
      cache: 'no-store'
    });

    if (response && response.ok) {
      // 不依 query string 重複儲存 order.html，避免 PWA 版本參數造成 Cache 膨脹。
      await putResponse(PAGE_CACHE, CUSTOMER_PAGE_PATH, response);
    }

    return response;
  } catch (error) {
    const cache = await caches.open(PAGE_CACHE);
    const cached = await cache.match(CUSTOMER_PAGE_PATH);

    if (cached) return cached;

    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request, {
    ignoreSearch: false
  });

  const networkPromise = fetch(request, {
    cache: 'no-cache'
  })
    .then(async response => {
      if (response && response.ok) {
        await cache.put(request, response.clone());
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

function buildFallbackOrderUrl(orderId = '') {
  const id = String(orderId || '').trim().toUpperCase();

  return id
    ? `${CUSTOMER_PAGE_PATH}?orderId=${encodeURIComponent(id)}&source=push`
    : `${CUSTOMER_PAGE_PATH}?source=push`;
}

function resolveSafeCustomerTargetUrl(rawUrl, orderId = '') {
  const fallback = buildFallbackOrderUrl(orderId);

  try {
    const target = new URL(
      String(rawUrl || fallback),
      self.location.origin
    );

    if (!isSameOrigin(target)) {
      return new URL(fallback, self.location.origin).href;
    }

    if (!CUSTOMER_HOME_PATHS.has(target.pathname)) {
      return new URL(fallback, self.location.origin).href;
    }

    return target.href;
  } catch (_) {
    return new URL(fallback, self.location.origin).href;
  }
}

/* ============================================================
 * INSTALL
 * ============================================================
 */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      const pageCache = await caches.open(PAGE_CACHE);

      try {
        const response = await fetch(CUSTOMER_PAGE_PATH, {
          cache: 'reload'
        });

        if (response && response.ok) {
          await pageCache.put(CUSTOMER_PAGE_PATH, response.clone());
        }
      } catch (_) {
        // 首頁預快取失敗不阻擋新版 Service Worker 安裝。
      }

      const staticCache = await caches.open(STATIC_CACHE);

      await Promise.all(
        STATIC_SHELL.map(async url => {
          try {
            const response = await fetch(url, {
              cache: 'reload'
            });

            if (response && response.ok) {
              await staticCache.put(url, response.clone());
            }
          } catch (_) {
            // 單一靜態資源預快取失敗不阻擋新版 Service Worker。
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

  if (!/^https?:$/.test(url.protocol)) {
    return;
  }

  // API 與所有寫入行為永遠不進 Cache。
  if (isNetworkOnlyRequest(request, url)) {
    event.respondWith(networkOnly(request));
    return;
  }

  if (!isSameOrigin(url)) {
    return;
  }

  // Root scope 保留相容性，但只接管 UBee Customer 本身的頁面導覽。
  // 同網域 dispatch/admin/support 等頁面不由 Customer SW 攔截。
  if (isNavigationRequest(request)) {
    if (isCustomerPageUrl(url)) {
      event.respondWith(networkFirstCustomerPage(request));
    }
    return;
  }

  // 只快取 Customer PWA 真正需要的靜態資源，避免同網域其他系統被放入 Customer Cache。
  if (request.method === 'GET' && isCustomerStaticAsset(url)) {
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

  const targetUrl = resolveSafeCustomerTargetUrl(
    data.url || data.deepLink,
    orderId
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

  const targetUrl = resolveSafeCustomerTargetUrl(
    data.url,
    orderId
  );

  event.waitUntil((async () => {
    const clientList = await clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    // 只重用既有 Customer 視窗，不把同網域的後台／客服視窗強制導向用戶端。
    for (const client of clientList) {
      try {
        const clientUrl = new URL(client.url);

        if (
          clientUrl.origin === self.location.origin &&
          CUSTOMER_HOME_PATHS.has(clientUrl.pathname)
        ) {
          if ('navigate' in client) {
            await client.navigate(targetUrl);
          }

          await client.focus();

          if (self.registration.clearAppBadge) {
            await self.registration.clearAppBadge().catch(() => {});
          }

          return;
        }
      } catch (_) {
        // 繼續尋找下一個可用 Customer client。
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

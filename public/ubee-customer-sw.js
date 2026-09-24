/* 2026-09-24｜Customer Platform Home V3：移除首頁城市節點 Hero；五大正式服務維持不變，首頁改為服務→地址→建立任務的外送平台式結構。 */
/* 2026-09-24｜Customer Home Dynamic Hero V2：首頁只移除 Google Map，恢復既有五大服務與內容結構；原地圖位置改城市節點 Hero／進行中任務摘要。 */
/* 2026-09-24｜Customer Service Home + Linear Progress V1：同步首頁移除大地圖、服務導向首頁與 4 節點線性進度條。 */
/* 2026-09-24｜Customer Final Delivery ETA V1：同步訂單總覽／明細／進行中任務的最終送達 ETA 與 Queue ETA 顯示。 */
/* 2026-09-23｜Customer Production Multi-stop UI V1：正式 productionOrderFlow 顯示送達點 2（選填）；同步 PWA Release，留空不影響估價與送單。 */
/* 2026-09-23｜Customer Multi-stop Delivery V1：同步一般客戶雙送達點、多點報價／建單與新版快取。 */
/* 2026-09-23｜Customer Cloud Draft V1：同步跨裝置會員雲端草稿 API；草稿 API 維持 Network Only。 */
/* 2026-09-23｜Customer Local State Fix V1：同步用戶端定位偏好、帳號本機資料隔離與草稿恢復修正。 */
/* 2026-09-20｜Customer Rider Rating V1：同步完成任務小U評價功能。 */
/* 2026-09-19｜Customer Cancel UX V1：同步訂單列表／詳情／進行中任務取消入口。 */
/* 2026-09-18｜Smart Stack V1.1：同步 QUEUED Live ETA 與 Recovery Hard Lock 客戶端。 */
/* 2026-09-17｜Profit Pricing V1 / Route Pricing V4：同步新計價核心與平台應收／已收辨識版本。 */
/* 2026-09-16｜Growth Engine V1.8 My UX：雙端「我的」二級頁統一與快取升版。 */
/*
 * ============================================================
 * UBee 跑腿｜用戶端 Service Worker
 * 2026-09-16 Growth Engine V1：同步我的 UBee／會員階級／邀請好友，並清除舊 Customer Cache。
 * 2026-09-14 Customer Native System V1.5 / Live Tracking Accept Sync V1：同步新版 order.html 主輪詢 tracking 摘要與接單即時 UI；升版後清除舊 Customer Cache。
 * 2026-09-11 Customer Native System V1.4 / Route Pricing V3：同步新版 order.html，移除舊一般配送時間費／重複費用明細並切換正式 fareMode；升版後清除舊 Customer Cache。
 * 2026-09-09 Customer Native System V1.3 / Live ETA V1：修復 Active Task ETA 狀態面板並切換至後端 traffic-aware ETA；升版後清除舊 Customer Cache。
 * Version: 2026-09-16 Native Experience V2 / Customer Isolation
 * File: ubee-customer-sw.js
 *
 * 2026-09-09 Customer Native System V1.2：任務內容／配送設定／確認訂單改為 Native Form Sections、Selection Rows、Checkout Summary；升版清除舊 Customer Cache。
 *
 * 2026-09-09 Customer Dispatch Recovery V1：建單後現金確認改為立即 Native Confirm；配合後端確認後立即啟動全區派單，升版清除舊 Customer Cache。
 *
 * 2026-09-09 Customer Native System V1：Step 5 進行中任務併入 productionOrderFlow；訂單列表／詳情／現場照片改為 Native Flat List、Grouped Detail、Timeline；升版清除舊 Customer Cache。
 *
 * 2026-09-07 Customer Advance Payment V1：客戶端最高自動代墊上限調整為 NT$1,500；升版後清除舊 Customer Cache，確保已安裝 PWA 取得最新版 order.html。
 *
 * 2026-09-03 Customer Location Bootstrap V3.3：DOM 完成即啟動定位；Map 建立仍受定位閘門保護，第一個正式地圖畫面不得先顯示城市預設中心。
 * 2026-09-03 Customer Location Lock V3.2：首頁 Map 建立前必須先完成定位嘗試；定位未完成前保持 placeholder，不再先顯示其他服務城市中心。
 * 2026-09-03 Arrival Photo Proof V1：客戶任務進度顯示小U到場照片；照片由後端以短效 signed URL 回傳。
 * 2026-09-03 Customer Task Contract V3 Full Flow：同步單點全能任務與完成回報結果；升版後清除舊 Customer Cache。
 * 2026-09-03 Customer Task Content V1：同步任務內容／細項／品項分類優化與全能跑腿結構化欄位；升版後清除舊 Customer Cache。
 * 2026-09-02 Customer Home Platform V3：同步正式首頁地圖、匿名小U運力、需求情境入口與訂單導覽文案；升版後清除舊 Customer Cache。
 *
 * 2026-08-11 Identity V1 更新：
 * 1. 實名制 / 會員 / 訂單 API 一律 Network Only，不寫入 Cache。
 * 2. HTML / navigation 採 Network First，避免 PWA 長期停在舊版 order.html。
 * 3. 靜態資源採 Stale While Revalidate。
 * 4. 啟用新版 SW 時清除舊版 UBee Customer Cache。
 * 5. 保留 Web Push、通知點擊與 App Badge 基本能力。
 * ============================================================
 */

/* 2026-09-23｜Customer Multi-stop Fee V1：同步第二送達點選填與每新增一點固定 +NT$50 的正式報價版本。 */

'use strict';

const UBEE_CUSTOMER_SW_VERSION = '20260924-customer-platform-home-v3';

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

  const fallbackPath = orderId
    ? `/order.html?orderId=${encodeURIComponent(orderId)}&source=push`
    : '/order.html?source=push';

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

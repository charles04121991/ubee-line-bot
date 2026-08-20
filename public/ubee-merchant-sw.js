/*
 * UBee Merchant PWA｜Service Worker
 * Version: 2026.08.20.3 Merchant Live Tracking V3
 * Scope: /merchant-dashboard.html
 *
 * 目的：
 * 1. 只控制 UBee Merchant 店家端，不導走同網域其他 UBee 頁面。
 * 2. 店家 API / tracking / session 全部 Network Only，不寫入 Cache。
 * 3. 保留 Merchant PWA 離線殼層與靜態資源快取。
 * 4. 支援小U接單、到店、取件、完成、GPS 異常與延誤 Web Push。
 * 5. 通知點擊只聚焦 / 導航既有 merchant-dashboard.html 視窗。
 * 6. 支援 App Badge 與指定訂單 Deep Link。
 */
'use strict';

const UBEE_MERCHANT_SW_VERSION = '2026.08.20.3-live-tracking-v3';
const CACHE_PREFIX = 'ubee-merchant-';
const STATIC_CACHE = `${CACHE_PREFIX}static-${UBEE_MERCHANT_SW_VERSION}`;
const PAGE_CACHE = `${CACHE_PREFIX}page-${UBEE_MERCHANT_SW_VERSION}`;

const APP_SHELL = [
  '/merchant-dashboard.html',
  '/merchant-manifest.json',
  '/ubee-merchant-icon-192.png',
  '/ubee-merchant-icon-512.png'
];

function isSameOrigin(url){
  return url.origin === self.location.origin;
}

function isMerchantClientUrl(clientUrl){
  try{
    const url = new URL(clientUrl);
    return (
      url.origin === self.location.origin &&
      (
        url.pathname === '/merchant-dashboard.html' ||
        url.pathname.endsWith('/merchant-dashboard.html')
      )
    );
  }catch(_){
    return false;
  }
}

function isNavigation(request){
  return request.mode === 'navigate' || request.destination === 'document';
}

function isStatic(request, url){
  if(!isSameOrigin(url)) return false;
  if(['style','script','image','font'].includes(request.destination)) return true;
  return /\.(?:css|js|mjs|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf)$/i.test(url.pathname);
}

function isNetworkOnly(request, url){
  if(!isSameOrigin(url)) return false;
  if(request.method !== 'GET') return true;
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/api/merchant/') ||
    url.pathname.startsWith('/api/support/')
  );
}

async function safePut(cacheName, request, response){
  if(!response || !response.ok || !['basic','default'].includes(response.type)) return;
  try{
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  }catch(_){ }
}

async function networkFirstPage(request){
  try{
    const response = await fetch(request, {cache:'no-store'});
    if(response?.ok){
      const url = new URL(request.url);
      if(url.pathname === '/merchant-dashboard.html'){
        const cache = await caches.open(PAGE_CACHE);
        await cache.put('/merchant-dashboard.html', response.clone());
      }else{
        await safePut(PAGE_CACHE, request, response);
      }
    }
    return response;
  }catch(error){
    const cached = await caches.match(request, {ignoreSearch:true});
    if(cached) return cached;
    const fallback = await caches.match('/merchant-dashboard.html', {ignoreSearch:true});
    if(fallback) return fallback;
    throw error;
  }
}

async function staleWhileRevalidate(request){
  const cached = await caches.match(request, {ignoreSearch:false});
  const network = fetch(request)
    .then(async response=>{
      if(response?.ok) await safePut(STATIC_CACHE, request, response);
      return response;
    })
    .catch(()=>null);

  if(cached) return cached;
  return (await network) || new Response('', {status:504, statusText:'Gateway Timeout'});
}

/* ===== INSTALL ===== */
self.addEventListener('install', event=>{
  event.waitUntil((async()=>{
    try{
      const cache = await caches.open(STATIC_CACHE);
      await Promise.all(
        APP_SHELL.map(async url=>{
          try{
            const response = await fetch(url, {cache:'reload'});
            if(response?.ok) await cache.put(url, response.clone());
          }catch(_){ }
        })
      );
    }finally{
      await self.skipWaiting();
    }
  })());
});

/* ===== ACTIVATE ===== */
self.addEventListener('activate', event=>{
  event.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(
      keys.map(key =>
        key.startsWith(CACHE_PREFIX) && ![STATIC_CACHE,PAGE_CACHE].includes(key)
          ? caches.delete(key)
          : Promise.resolve(false)
      )
    );

    await self.clients.claim();

    const clientList = await self.clients.matchAll({
      type:'window',
      includeUncontrolled:true
    });

    for(const client of clientList){
      if(!isMerchantClientUrl(client.url)) continue;
      try{
        client.postMessage({
          type:'UBEE_MERCHANT_SW_UPDATED',
          version:UBEE_MERCHANT_SW_VERSION
        });
      }catch(_){ }
    }
  })());
});

/* ===== FETCH ===== */
self.addEventListener('fetch', event=>{
  const request = event.request;
  if(!request?.url) return;

  const url = new URL(request.url);
  if(!/^https?:$/.test(url.protocol)) return;

  if(isNetworkOnly(request, url)){
    event.respondWith(fetch(request));
    return;
  }

  if(!isSameOrigin(url)) return;

  if(isNavigation(request)){
    // 這支 SW 的 client scope 已限定 Merchant，但仍只對 Merchant 頁面提供 fallback。
    if(url.pathname === '/merchant-dashboard.html'){
      event.respondWith(networkFirstPage(request));
    }
    return;
  }

  if(request.method === 'GET' && isStatic(request, url)){
    event.respondWith(staleWhileRevalidate(request));
  }
});

/* ===== WEB PUSH ===== */
self.addEventListener('push', event=>{
  let data = {};

  try{
    data = event.data ? event.data.json() : {};
  }catch(_){
    data = {
      body:event.data ? event.data.text() : 'UBee 店家端有新的配送通知。'
    };
  }

  const orderId = String(data.orderId || data.id || '')
    .trim()
    .toUpperCase();

  const fallbackUrl = orderId
    ? `/merchant-dashboard.html?action=progress&orderId=${encodeURIComponent(orderId)}&source=push`
    : '/merchant-dashboard.html?action=progress&source=push';

  let targetUrl = fallbackUrl;
  try{
    const requested = new URL(
      data.url || data.deepLink || fallbackUrl,
      self.location.origin
    );
    if(
      requested.origin === self.location.origin &&
      requested.pathname === '/merchant-dashboard.html'
    ){
      targetUrl = requested.pathname + requested.search + requested.hash;
    }
  }catch(_){ }

  const options = {
    body:data.body || 'UBee 店家端有新的配送狀態更新。',
    icon:data.icon || '/ubee-merchant-icon-192.png',
    badge:data.badge || '/ubee-merchant-icon-192.png',
    tag:data.tag || (orderId ? `ubee-merchant-${orderId}` : 'ubee-merchant-notification'),
    renotify:data.renotify !== false,
    requireInteraction:data.requireInteraction === true,
    timestamp:Number(data.timestamp || Date.now()),
    data:{
      orderId,
      url:targetUrl,
      type:data.type || 'UBEE_MERCHANT_PUSH'
    }
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(
        data.title || 'UBee 店家平台',
        options
      ),
      self.registration.setAppBadge
        ? self.registration.setAppBadge(1).catch(()=>{})
        : Promise.resolve()
    ])
  );
});

/* ===== NOTIFICATION CLICK ===== */
self.addEventListener('notificationclick', event=>{
  event.notification.close();

  const data = event.notification.data || {};
  const orderId = String(data.orderId || '')
    .trim()
    .toUpperCase();

  const fallbackUrl = orderId
    ? `/merchant-dashboard.html?action=progress&orderId=${encodeURIComponent(orderId)}&source=push`
    : '/merchant-dashboard.html?action=progress&source=push';

  let targetUrl;
  try{
    const requested = new URL(
      data.url || fallbackUrl,
      self.location.origin
    );

    if(
      requested.origin !== self.location.origin ||
      requested.pathname !== '/merchant-dashboard.html'
    ){
      targetUrl = new URL(fallbackUrl, self.location.origin).href;
    }else{
      targetUrl = requested.href;
    }
  }catch(_){
    targetUrl = new URL(fallbackUrl, self.location.origin).href;
  }

  event.waitUntil((async()=>{
    const list = await clients.matchAll({
      type:'window',
      includeUncontrolled:true
    });

    // 只找既有 Merchant 視窗；不會把 dispatch / support / admin 導走。
    const merchantClient = list.find(client => isMerchantClientUrl(client.url));

    if(merchantClient){
      try{
        let activeClient = merchantClient;
        if('navigate' in merchantClient){
          const navigated = await merchantClient.navigate(targetUrl);
          if(navigated) activeClient = navigated;
        }
        if('focus' in activeClient) await activeClient.focus();
        try{
          activeClient.postMessage({
            type:'UBEE_MERCHANT_OPEN_ORDER',
            orderId,
            url:targetUrl
          });
        }catch(_){ }

        if(self.registration.clearAppBadge){
          await self.registration.clearAppBadge().catch(()=>{});
        }
        return;
      }catch(_){ }
    }

    if(clients.openWindow){
      await clients.openWindow(targetUrl);
    }

    if(self.registration.clearAppBadge){
      await self.registration.clearAppBadge().catch(()=>{});
    }
  })());
});

/* ===== MESSAGE ===== */
self.addEventListener('message', event=>{
  const data = event.data || {};

  if(data.type === 'SKIP_WAITING' || data.type === 'UBEE_SKIP_WAITING'){
    self.skipWaiting();
    return;
  }

  if(
    data.type === 'UBEE_MERCHANT_CLEAR_BADGE' ||
    data.type === 'UBEE_CLEAR_BADGE'
  ){
    if(self.registration.clearAppBadge){
      event.waitUntil(
        self.registration.clearAppBadge().catch(()=>{})
      );
    }
  }
});

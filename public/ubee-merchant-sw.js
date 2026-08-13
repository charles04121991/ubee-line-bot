/*
 * UBee Merchant PWA｜Service Worker
 * Version: 2026.08.13.1
 * Scope: /merchant-dashboard.html
 */
'use strict';

const UBEE_MERCHANT_SW_VERSION = '2026.08.13.1';
const CACHE_PREFIX = 'ubee-merchant-';
const STATIC_CACHE = `${CACHE_PREFIX}static-${UBEE_MERCHANT_SW_VERSION}`;
const PAGE_CACHE = `${CACHE_PREFIX}page-${UBEE_MERCHANT_SW_VERSION}`;

const APP_SHELL = [
  '/merchant-dashboard.html',
  '/merchant-manifest.json',
  '/ubee-merchant-icon-192.png',
  '/ubee-merchant-icon-512.png'
];

function isSameOrigin(url){ return url.origin === self.location.origin; }
function isNavigation(request){ return request.mode === 'navigate' || request.destination === 'document'; }
function isStatic(request, url){
  if(!isSameOrigin(url)) return false;
  if(['style','script','image','font'].includes(request.destination)) return true;
  return /\.(?:css|js|mjs|png|jpg|jpeg|webp|svg|ico|woff2?|ttf)$/i.test(url.pathname);
}
function isNetworkOnly(request, url){
  if(!isSameOrigin(url)) return false;
  if(request.method !== 'GET') return true;
  return url.pathname.startsWith('/api/merchant/') || url.pathname.startsWith('/api/support/');
}
async function safePut(cacheName, request, response){
  if(!response || !response.ok || !['basic','default'].includes(response.type)) return;
  try{ const cache = await caches.open(cacheName); await cache.put(request, response.clone()); }catch(_){}
}
async function networkFirstPage(request){
  try{
    const response = await fetch(request, {cache:'no-store'});
    if(response?.ok) await safePut(PAGE_CACHE, request, response);
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
  const cached = await caches.match(request);
  const network = fetch(request).then(async response=>{ if(response?.ok) await safePut(STATIC_CACHE, request, response); return response; }).catch(()=>null);
  if(cached) return cached;
  return (await network) || new Response('', {status:504, statusText:'Gateway Timeout'});
}

self.addEventListener('install', event=>{
  event.waitUntil((async()=>{
    try{
      const cache = await caches.open(STATIC_CACHE);
      await Promise.all(APP_SHELL.map(async url=>{
        try{ const response = await fetch(url, {cache:'reload'}); if(response?.ok) await cache.put(url, response.clone()); }catch(_){}
      }));
    }finally{ await self.skipWaiting(); }
  })());
});

self.addEventListener('activate', event=>{
  event.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(keys.map(key=> key.startsWith(CACHE_PREFIX) && ![STATIC_CACHE,PAGE_CACHE].includes(key) ? caches.delete(key) : Promise.resolve(false)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event=>{
  const request = event.request;
  if(!request?.url) return;
  const url = new URL(request.url);
  if(!/^https?:$/.test(url.protocol)) return;
  if(isNetworkOnly(request, url)){ event.respondWith(fetch(request)); return; }
  if(!isSameOrigin(url)) return;
  if(isNavigation(request)){ event.respondWith(networkFirstPage(request)); return; }
  if(request.method === 'GET' && isStatic(request, url)) event.respondWith(staleWhileRevalidate(request));
});

self.addEventListener('push', event=>{
  let data={};
  try{ data=event.data?event.data.json():{}; }catch(_){ data={body:event.data?event.data.text():'UBee 店家端有新的配送通知。'}; }
  const orderId=String(data.orderId||data.id||'').trim().toUpperCase();
  const url=String(data.url||data.deepLink||(orderId?`/merchant-dashboard.html?action=orders&orderId=${encodeURIComponent(orderId)}&source=push`:'/merchant-dashboard.html?source=push'));
  event.waitUntil(self.registration.showNotification(data.title||'UBee 店家平台',{
    body:data.body||'UBee 店家端有新的配送狀態更新。',
    icon:data.icon||'/ubee-merchant-icon-192.png',
    badge:data.badge||'/ubee-merchant-icon-192.png',
    tag:data.tag||(orderId?`ubee-merchant-${orderId}`:'ubee-merchant-notification'),
    data:{orderId,url}
  }));
});

self.addEventListener('notificationclick', event=>{
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/merchant-dashboard.html', self.location.origin).href;
  event.waitUntil((async()=>{
    const list = await clients.matchAll({type:'window', includeUncontrolled:true});
    for(const client of list){
      try{
        if(new URL(client.url).origin===self.location.origin){
          if('navigate' in client) await client.navigate(target);
          await client.focus(); return;
        }
      }catch(_){}
    }
    if(clients.openWindow) await clients.openWindow(target);
  })());
});

self.addEventListener('message', event=>{
  if(event.data?.type==='SKIP_WAITING') self.skipWaiting();
});

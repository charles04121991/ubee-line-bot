/*
 * ============================================================
 * UBee 跑腿｜用戶端 Service Worker
 * Version: 2026.09.01.2
 * File: ubee-customer-sw.js
 *
 * UBee Customer V3：
 * 1. 全部 /api/ 請求一律 Network Only，不進 Cache。
 * 2. HTML / navigation 採 Network First。
 * 3. 靜態資源採 Stale While Revalidate。
 * 4. 新版啟用時清除舊版 UBee Customer Cache。
 * 5. 保留 Web Push、通知深連結與 App Badge。
 * ============================================================
 */
'use strict';

const UBEE_CUSTOMER_SW_VERSION = '2026.09.01.2';
const CACHE_PREFIX = 'ubee-customer-';
const STATIC_CACHE = `${CACHE_PREFIX}static-${UBEE_CUSTOMER_SW_VERSION}`;
const PAGE_CACHE = `${CACHE_PREFIX}page-${UBEE_CUSTOMER_SW_VERSION}`;

const APP_SHELL = [
  '/order.html',
  '/manifest-order.json',
  '/ubee-customer-icon-192.png',
  '/ubee-customer-icon-512.png'
];

const NETWORK_ONLY_PATH_PREFIXES = ['/api/'];

function isSameOrigin(url){return url.origin===self.location.origin}
function isNetworkOnlyRequest(request,url){
  if(!isSameOrigin(url))return false;
  if(request.method!=='GET')return true;
  return NETWORK_ONLY_PATH_PREFIXES.some(prefix=>url.pathname===prefix||url.pathname.startsWith(prefix));
}
function isNavigationRequest(request){return request.mode==='navigate'||request.destination==='document'}
function isStaticAssetRequest(request,url){
  if(!isSameOrigin(url))return false;
  if(['style','script','image','font'].includes(request.destination))return true;
  return /\.(?:css|js|mjs|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf)$/i.test(url.pathname);
}
async function putResponse(cacheName,request,response){
  if(!response||!response.ok)return;
  if(response.type!=='basic'&&response.type!=='default')return;
  try{const cache=await caches.open(cacheName);await cache.put(request,response.clone())}catch(error){console.warn('UBee Customer SW cache put failed:',error)}
}
async function networkOnly(request){return fetch(request,{cache:'no-store'})}
async function networkFirstPage(request){
  try{const response=await fetch(request,{cache:'no-store'});if(response&&response.ok)await putResponse(PAGE_CACHE,request,response);return response}
  catch(error){
    const cached=await caches.match(request,{ignoreSearch:true});if(cached)return cached;
    const fallback=await caches.match('/order.html',{ignoreSearch:true});if(fallback)return fallback;
    throw error;
  }
}
async function staleWhileRevalidate(request){
  const cached=await caches.match(request,{ignoreSearch:false});
  const networkPromise=fetch(request).then(async response=>{if(response&&response.ok)await putResponse(STATIC_CACHE,request,response);return response}).catch(()=>null);
  if(cached)return cached;
  const networkResponse=await networkPromise;if(networkResponse)return networkResponse;
  return new Response('',{status:504,statusText:'Gateway Timeout'});
}

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    try{
      const cache=await caches.open(STATIC_CACHE);
      await Promise.all(APP_SHELL.map(async url=>{try{const response=await fetch(url,{cache:'reload'});if(response&&response.ok)await cache.put(url,response.clone())}catch(_){}}));
    }finally{await self.skipWaiting()}
  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.map(key=>key.startsWith(CACHE_PREFIX)&&key!==STATIC_CACHE&&key!==PAGE_CACHE?caches.delete(key):Promise.resolve(false)));
    await self.clients.claim();
    const clientList=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of clientList){client.postMessage({type:'UBEE_CUSTOMER_SW_UPDATED',version:UBEE_CUSTOMER_SW_VERSION})}
  })());
});

self.addEventListener('fetch',event=>{
  const request=event.request;if(!request||!request.url)return;
  const url=new URL(request.url);if(!/^https?:$/.test(url.protocol))return;
  if(isNetworkOnlyRequest(request,url)){event.respondWith(networkOnly(request));return}
  if(!isSameOrigin(url))return;
  if(isNavigationRequest(request)){event.respondWith(networkFirstPage(request));return}
  if(request.method==='GET'&&isStaticAssetRequest(request,url))event.respondWith(staleWhileRevalidate(request));
});

self.addEventListener('push',event=>{
  let data={};
  try{data=event.data?event.data.json():{}}catch(_){data={body:event.data?event.data.text():'UBee 跑腿有新的通知。'}}
  const orderId=String(data.orderId||data.id||'').trim().toUpperCase();
  const fallbackUrl=orderId?`/order.html?orderId=${encodeURIComponent(orderId)}&source=push&v=20260901-v3-5step`:'/order.html?source=push&v=20260901-v3-5step';
  const targetUrl=String(data.url||data.deepLink||fallbackUrl);
  const options={
    body:data.body||'UBee 跑腿有新的任務進度通知。',
    icon:data.icon||'/ubee-customer-icon-192.png',
    badge:data.badge||'/ubee-customer-icon-192.png',
    tag:data.tag||(orderId?`ubee-customer-order-${orderId}`:'ubee-customer-notification'),
    renotify:data.renotify!==false,
    data:{orderId,url:targetUrl,type:data.type||'UBEE_CUSTOMER_PUSH'}
  };
  event.waitUntil((async()=>{await self.registration.showNotification(data.title||'UBee 跑腿',options);if(self.registration.setAppBadge)await self.registration.setAppBadge(1).catch(()=>{})})());
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const data=event.notification.data||{};
  const orderId=String(data.orderId||'').trim().toUpperCase();
  const targetUrl=new URL(data.url||(orderId?`/order.html?orderId=${encodeURIComponent(orderId)}&source=push&v=20260901-v3-5step`:'/order.html?source=push&v=20260901-v3-5step'),self.location.origin).href;
  event.waitUntil((async()=>{
    const clientList=await clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of clientList){
      try{
        const clientUrl=new URL(client.url);
        if(clientUrl.origin===self.location.origin){
          if('navigate' in client)await client.navigate(targetUrl);
          await client.focus();
          client.postMessage({type:'UBEE_CUSTOMER_OPEN_ORDER',orderId,url:targetUrl});
          if(self.registration.clearAppBadge)await self.registration.clearAppBadge().catch(()=>{});
          return;
        }
      }catch(_){}
    }
    if(clients.openWindow)await clients.openWindow(targetUrl);
    if(self.registration.clearAppBadge)await self.registration.clearAppBadge().catch(()=>{});
  })());
});

self.addEventListener('message',event=>{
  const data=event.data||{};
  if(data.type==='SKIP_WAITING'){self.skipWaiting();return}
  if(data.type==='UBEE_CLEAR_BADGE'||data.type==='UBEE_CUSTOMER_CLEAR_BADGE'){
    if(self.registration.clearAppBadge)event.waitUntil(self.registration.clearAppBadge().catch(()=>{}));
  }
});

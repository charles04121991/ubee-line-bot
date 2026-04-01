require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('❌ Missing CHANNEL_ACCESS_TOKEN or CHANNEL_SECRET');
  process.exit(1);
}

const client = new line.Client(config);

const PORT = process.env.PORT || 3000;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID || '';

// ===== 費率設定 =====
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const URGENT_FEE = 100;
const SERVICE_FEE = 50;
const FIXED_TAX = 15;

// ===== 系統設定 =====
const PUSH_INTERVAL_MS = 900; // push queue 節流，避免太密集
const MAX_RETRY = 4;          // 429 / 暫時性錯誤最多重試次數
const DISPATCH_DEDUPE_TTL = 30 * 1000; // 30 秒內相同派單 key 不重送
const ORDER_LOCK_TTL = 10 * 60 * 1000; // 10 分鐘內保留訂單鎖

// ===== 記憶體狀態（目前單機版） =====
const userSessions = {};          // 客戶填單流程
const riderSessions = {};         // 騎手接單 ETA 流程
const activeOrders = {};          // orderId -> order
const dispatchDedupeMap = new Map(); // 防重複派單
const orderLocks = new Map();        // 防重複接單 / 流程鎖

let orderCounter = 1;

// ===== Push Queue =====
const pushQueue = [];
let isProcessingPushQueue = false;

// ===== 工具函式 =====
function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatMoney(num) {
  return `$${Math.round(num)}`;
}

function cleanupMaps() {
  const current = now();

  for (const [key, value] of dispatchDedupeMap.entries()) {
    if (current - value > DISPATCH_DEDUPE_TTL) {
      dispatchDedupeMap.delete(key);
    }
  }

  for (const [key, value] of orderLocks.entries()) {
    if (current - value.updatedAt > ORDER_LOCK_TTL) {
      orderLocks.delete(key);
    }
  }
}

setInterval(cleanupMaps, 60 * 1000);

function normalizeText(text) {
  return (text || '').trim();
}

function isUrgentText(text) {
  const v = normalizeText(text);
  return ['急件', '是', 'yes', 'y', '急'].includes(v);
}

function isNormalText(text) {
  const v = normalizeText(text);
  return ['一般', '否', '不是', 'no', 'n'].includes(v);
}

function createOrderId() {
  const id = `ORD${String(orderCounter).padStart(5, '0')}`;
  orderCounter += 1;
  return id;
}

function getDistrict(address = '') {
  // 簡化版跨區判斷：抓「區」
  const match = address.match(/([\u4e00-\u9fa5]{1,4}區)/);
  return match ? match[1] : '';
}

function calculatePrice(pickup, dropoff, urgent) {
  // 先用簡化版距離時間估算
  // 之後你若要接 Google Maps API，我再幫你換成真實距離時間
  const fakeKm = estimateDistanceKm(pickup, dropoff);
  const fakeMin = Math.max(8, Math.round(fakeKm * 2));

  const districtA = getDistrict(pickup);
  const districtB = getDistrict(dropoff);
  const crossDistrictFee =
    districtA && districtB && districtA !== districtB ? CROSS_DISTRICT_FEE : 0;

  const deliveryFee =
    BASE_FEE +
    fakeKm * PER_KM_FEE +
    fakeMin * PER_MIN_FEE +
    crossDistrictFee;

  const urgentFee = urgent ? URGENT_FEE : 0;

  const subtotal = deliveryFee + urgentFee + SERVICE_FEE;
  const total = subtotal + FIXED_TAX;

  return {
    km: Number(fakeKm.toFixed(1)),
    minutes: fakeMin,
    crossDistrictFee,
    deliveryFee: Math.round(deliveryFee),
    urgentFee,
    serviceFee: SERVICE_FEE,
    tax: FIXED_TAX,
    total: Math.round(total),
  };
}

function estimateDistanceKm(a, b) {
  // 簡化版估算：依字串差異做一個固定 fallback
  // 真正上線你若要接 Maps，我再替換掉這段
  if (!a || !b) return 5;

  const districtA = getDistrict(a);
  const districtB = getDistrict(b);

  if (districtA && districtB) {
    if (districtA === districtB) return 4.5;
    return 12.5;
  }

  return 8.0;
}

function buildCustomerPriceText(pricing) {
  return [
    '📦 任務費用明細',
    `配送費：${formatMoney(pricing.deliveryFee)}`,
    `急件費：${formatMoney(pricing.urgentFee)}`,
    `服務費：${formatMoney(pricing.serviceFee)}`,
    `稅金：${formatMoney(pricing.tax)}`,
    `總計：${formatMoney(pricing.total)}`,
  ].join('\n');
}

function buildConfirmText(orderDraft, pricing) {
  return [
    '請確認以下任務內容：',
    '',
    `取件地點：${orderDraft.pickupAddress}`,
    `取件電話：${orderDraft.pickupPhone}`,
    `送達地點：${orderDraft.dropoffAddress}`,
    `送達電話：${orderDraft.dropoffPhone}`,
    `物品內容：${orderDraft.item}`,
    `是否急件：${orderDraft.urgent ? '急件' : '一般'}`,
    `備註：${orderDraft.note || '無'}`,
    '',
    buildCustomerPriceText(pricing),
    '',
    '請回覆：確認 / 修改 / 取消',
  ].join('\n');
}

function buildGroupDispatchText(order) {
  return [
    '📦 UBee 新任務通知',
    '',
    `費用：${formatMoney(order.pricing.total)}`,
    `距離：${order.pricing.km} 公里`,
    '',
    `取件：${order.pickupAddress}`,
    `送達：${order.dropoffAddress}`,
    `物品：${order.item}`,
    `急件：${order.urgent ? '急件' : '一般'}`,
    `備註：${order.note || '無'}`,
    '',
    '騎手請輸入：接',
  ].join('\n');
}

function buildDispatchDedupeKey(order) {
  return [
    order.userId,
    order.pickupAddress,
    order.dropoffAddress,
    order.item,
    order.urgent ? '1' : '0',
    order.note || '',
    order.pricing.total,
  ].join('|');
}

function shouldSkipDuplicateDispatch(order) {
  const key = buildDispatchDedupeKey(order);
  const ts = dispatchDedupeMap.get(key);

  if (ts && now() - ts < DISPATCH_DEDUPE_TTL) {
    return true;
  }

  dispatchDedupeMap.set(key, now());
  return false;
}

async function safeReply(replyToken, messages) {
  try {
    await client.replyMessage(replyToken, messages);
  } catch (err) {
    console.error('❌ replyMessage error:', err?.message || err);
  }
}

function enqueuePush(to, messages, meta = {}) {
  pushQueue.push({
    to,
    messages: Array.isArray(messages) ? messages : [messages],
    retryCount: 0,
    meta,
    createdAt: now(),
  });

  processPushQueue().catch(err => {
    console.error('❌ processPushQueue fatal error:', err?.message || err);
  });
}

function getRetryAfterMs(err) {
  // LINE SDK 錯誤物件格式不一定完全一致，所以多做幾層判斷
  const retryAfter =
    err?.response?.headers?.['retry-after'] ||
    err?.headers?.['retry-after'] ||
    err?.originalError?.response?.headers?.['retry-after'];

  if (!retryAfter) return null;

  const sec = Number(retryAfter);
  if (Number.isFinite(sec) && sec > 0) {
    return sec * 1000;
  }
  return null;
}

function isRetryableError(err) {
  const status =
    err?.statusCode ||
    err?.status ||
    err?.response?.status ||
    err?.originalError?.response?.status;

  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}

async function processPushQueue() {
  if (isProcessingPushQueue) return;
  isProcessingPushQueue = true;

  while (pushQueue.length > 0) {
    const job = pushQueue[0];

    try {
      await client.pushMessage(job.to, job.messages);
      pushQueue.shift();
      await sleep(PUSH_INTERVAL_MS);
    } catch (err) {
      const status =
        err?.statusCode ||
        err?.status ||
        err?.response?.status ||
        err?.originalError?.response?.status;

      console.error(`❌ pushMessage error (status=${status || 'unknown'}):`, err?.message || err);

      if (isRetryableError(err) && job.retryCount < MAX_RETRY) {
        job.retryCount += 1;

        const retryAfterMs = getRetryAfterMs(err);
        const backoffMs =
          retryAfterMs || Math.min(1500 * Math.pow(2, job.retryCount - 1), 12000);

        console.warn(`⏳ push retry #${job.retryCount} after ${backoffMs}ms`);
        await sleep(backoffMs);
      } else {
        console.error('❌ push dropped:', {
          to: job.to,
          retryCount: job.retryCount,
          meta: job.meta,
        });
        pushQueue.shift();
        await sleep(PUSH_INTERVAL_MS);
      }
    }
  }

  isProcessingPushQueue = false;
}

function createTextMessage(text) {
  return { type: 'text', text };
}

function resetUserSession(userId) {
  delete userSessions[userId];
}

function resetRiderSession(groupId, userId) {
  delete riderSessions[`${groupId}:${userId}`];
}

function getActiveWaitingOrder() {
  return Object.values(activeOrders).find(
    order => ['waiting', 'dispatched'].includes(order.status)
  );
}

function getAcceptedOrderByDriver(driverId) {
  return Object.values(activeOrders).find(
    order => order.driverId === driverId && ['accepted', 'arrived', 'picked_up', 'delivered'].includes(order.status)
  );
}

function lockOrder(orderId, patch = {}) {
  const prev = orderLocks.get(orderId) || {};
  orderLocks.set(orderId, {
    ...prev,
    ...patch,
    updatedAt: now(),
  });
}
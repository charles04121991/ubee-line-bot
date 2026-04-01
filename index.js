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
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// =========================
// 費率設定
// =========================
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const URGENT_FEE = 100;
const SERVICE_FEE = 50;
const FIXED_TAX = 15;

// =========================
// 系統設定
// =========================
const PUSH_INTERVAL_MS = 900;
const MAX_PUSH_RETRY = 4;
const DISPATCH_DEDUPE_TTL = 30 * 1000;
const EVENT_DEDUPE_TTL = 3 * 60 * 1000;
const ORDER_LOCK_TTL = 15 * 60 * 1000;
const ORDER_EXPIRE_MS = 2 * 60 * 60 * 1000;

// =========================
// 記憶體狀態
// 單機版 / Render free instance 重啟會清空
// =========================
const userSessions = {}; // userId -> { step, data, pricing }
const riderSessions = {}; // groupId:userId -> { step, orderId }
const activeOrders = {}; // orderId -> order
const pushQueue = [];
const dispatchDedupeMap = new Map();
const processedEvents = new Map();
const orderLocks = new Map();

let isProcessingPushQueue = false;
let orderCounter = 1;

// =========================
// 基本工具
// =========================
function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return String(text || '').trim();
}

function formatMoney(num) {
  return `$${Math.round(Number(num || 0))}`;
}

function createOrderId() {
  const id = `ORD${String(orderCounter).padStart(5, '0')}`;
  orderCounter += 1;
  return id;
}

function createTextMessage(text) {
  return { type: 'text', text };
}

function safeLower(text) {
  return normalizeText(text).toLowerCase();
}

function isUrgentText(text) {
  const t = normalizeText(text);
  return ['急件', '急', '是', 'yes', 'y', '需要急件'].includes(t);
}

function isNormalText(text) {
  const t = normalizeText(text);
  return ['一般', '否', '不是', 'no', 'n', '不用急件'].includes(t);
}

function getDistrict(address = '') {
  const match = String(address).match(/([\u4e00-\u9fa5]{1,4}區)/);
  return match ? match[1] : '';
}

function cleanupMaps() {
  const current = now();

  for (const [key, ts] of dispatchDedupeMap.entries()) {
    if (current - ts > DISPATCH_DEDUPE_TTL) {
      dispatchDedupeMap.delete(key);
    }
  }

  for (const [key, ts] of processedEvents.entries()) {
    if (current - ts > EVENT_DEDUPE_TTL) {
      processedEvents.delete(key);
    }
  }

  for (const [orderId, lockInfo] of orderLocks.entries()) {
    if (!lockInfo || current - lockInfo.updatedAt > ORDER_LOCK_TTL) {
      orderLocks.delete(orderId);
    }
  }

  for (const [orderId, order] of Object.entries(activeOrders)) {
    if (!order) continue;

    const age = current - (order.createdAt || current);
    const isFinished = ['completed', 'cancelled', 'expired'].includes(order.status);

    if (isFinished && age > ORDER_EXPIRE_MS) {
      delete activeOrders[orderId];
      orderLocks.delete(orderId);
    }
  }
}

setInterval(cleanupMaps, 60 * 1000);

// =========================
// Google Maps / fallback
// =========================
async function estimateDistanceAndTime(pickup, dropoff) {
  if (GOOGLE_MAPS_API_KEY) {
    try {
      const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
      url.searchParams.set('origins', pickup);
      url.searchParams.set('destinations', dropoff);
      url.searchParams.set('mode', 'driving');
      url.searchParams.set('language', 'zh-TW');
      url.searchParams.set('key', GOOGLE_MAPS_API_KEY);

      const res = await fetch(url.toString());
      const data = await res.json();

      const element = data?.rows?.[0]?.elements?.[0];
      if (element && element.status === 'OK') {
        const meters = element.distance.value || 0;
        const seconds = element.duration.value || 0;

        return {
          km: Number((meters / 1000).toFixed(1)),
          minutes: Math.max(1, Math.round(seconds / 60)),
          source: 'google_maps',
        };
      }

      console.warn('⚠️ Google Maps fallback:', element?.status || 'unknown');
    } catch (err) {
      console.warn('⚠️ Google Maps API failed, use fallback:', err?.message || err);
    }
  }

  return estimateDistanceAndTimeFallback(pickup, dropoff);
}

function estimateDistanceAndTimeFallback(pickup, dropoff) {
  const districtA = getDistrict(pickup);
  const districtB = getDistrict(dropoff);

  let km = 8.0;

  if (districtA && districtB) {
    if (districtA === districtB) {
      km = 4.5;
    } else {
      km = 12.5;
    }
  } else if (pickup && dropoff) {
    const diff = Math.abs(String(pickup).length - String(dropoff).length);
    km = Math.min(20, Math.max(5, 6 + diff * 0.8));
  }

  const minutes = Math.max(8, Math.round(km * 2));

  return {
    km: Number(km.toFixed(1)),
    minutes,
    source: 'fallback',
  };
}

// =========================
// 計價
// =========================
async function calculatePrice(pickup, dropoff, urgent) {
  const route = await estimateDistanceAndTime(pickup, dropoff);

  const districtA = getDistrict(pickup);
  const districtB = getDistrict(dropoff);
  const crossDistrictFee =
    districtA && districtB && districtA !== districtB ? CROSS_DISTRICT_FEE : 0;

  const deliveryFee =
    BASE_FEE +
    route.km * PER_KM_FEE +
    route.minutes * PER_MIN_FEE +
    crossDistrictFee;

  const urgentFee = urgent ? URGENT_FEE : 0;
  const serviceFee = SERVICE_FEE;
  const subtotal = deliveryFee + urgentFee + serviceFee;
  const total = subtotal + FIXED_TAX;

  return {
    km: Number(route.km.toFixed(1)),
    minutes: route.minutes,
    crossDistrictFee,
    deliveryFee: Math.round(deliveryFee),
    urgentFee,
    serviceFee,
    tax: FIXED_TAX,
    subtotal: Math.round(subtotal),
    total: Math.round(total),
    source: route.source,
  };
}

// =========================
// 訂單工具
// =========================
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

function buildConfirmText(draft, pricing) {
  return [
    '請確認以下任務內容：',
    '',
    `取件地點：${draft.pickupAddress}`,
    `取件電話：${draft.pickupPhone}`,
    `送達地點：${draft.dropoffAddress}`,
    `送達電話：${draft.dropoffPhone}`,
    `物品內容：${draft.item}`,
    `是否急件：${draft.urgent ? '急件' : '一般'}`,
    `備註：${draft.note || '無'}`,
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

function resetUserSession(userId) {
  delete userSessions[userId];
}

function resetRiderSession(groupId, userId) {
  delete riderSessions[`${groupId}:${userId}`];
}

function getRiderSessionKey(groupId, userId) {
  return `${groupId}:${userId}`;
}

function getActiveWaitingOrder() {
  return Object.values(activeOrders)
    .filter((order) => ['waiting', 'dispatched'].includes(order.status))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
}

function getAcceptedOrderByDriver(driverId) {
  return Object.values(activeOrders).find(
    (order) =>
      order.driverId === driverId &&
      ['accepted', 'arrived', 'picked_up', 'delivered'].includes(order.status)
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

function getOrderLock(orderId) {
  return orderLocks.get(orderId) || {};
}

function canAcceptOrder(orderId) {
  const lock = getOrderLock(orderId);
  return !lock.accepted;
}

// =========================
// Push queue / 防 429
// =========================
function enqueuePush(to, messages, meta = {}) {
  pushQueue.push({
    to,
    messages: Array.isArray(messages) ? messages : [messages],
    retryCount: 0,
    meta,
    createdAt: now(),
  });

  processPushQueue().catch((err) => {
    console.error('❌ processPushQueue fatal error:', err?.message || err);
  });
}

function isRetryableError(err) {
  const status =
    err?.statusCode ||
    err?.status ||
    err?.response?.status ||
    err?.originalError?.response?.status;

  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}

function getRetryAfterMs(err) {
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

      if (isRetryableError(err) && job.retryCount < MAX_PUSH_RETRY) {
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

async function safeReply(replyToken, messages) {
  try {
    await client.replyMessage(replyToken, Array.isArray(messages) ? messages : [messages]);
  } catch (err) {
    console.error('❌ replyMessage error:', err?.message || err);
  }
}

// =========================
// 任務建立流程
// =========================
function startCreateTaskSession(userId) {
  userSessions[userId] = {
    step: 'pickup_address',
    data: {
      pickupAddress: '',
      pickupPhone: '',
      dropoffAddress: '',
      dropoffPhone: '',
      item: '',
      urgent: false,
      note: '',
    },
    pricing: null,
  };
}

async function processCreateTaskStep(userId, text) {
  const session = userSessions[userId];
  if (!session) return null;

  const value = normalizeText(text);
  const step = session.step;

  if (step === 'pickup_address') {
    session.data.pickupAddress = value;
    session.step = 'pickup_phone';
    return '請輸入取件電話';
  }

  if (step === 'pickup_phone') {
    session.data.pickupPhone = value;
    session.step = 'dropoff_address';
    return '請輸入送達地點';
  }

  if (step === 'dropoff_address') {
    session.data.dropoffAddress = value;
    session.step = 'dropoff_phone';
    return '請輸入送達電話';
  }

  if (step === 'dropoff_phone') {
    session.data.dropoffPhone = value;
    session.step = 'item';
    return '請輸入物品內容';
  }

  if (step === 'item') {
    session.data.item = value;
    session.step = 'urgent';
    return '請輸入是否急件（一般 / 急件）';
  }

  if (step === 'urgent') {
    if (!isUrgentText(value) && !isNormalText(value)) {
      return '請輸入「一般」或「急件」';
    }

    session.data.urgent = isUrgentText(value);
    session.step = 'note';
    return '請輸入備註（若無請輸入：無）';
  }

  if (step === 'note') {
    session.data.note = value === '無' ? '' : value;

    const pricing = await calculatePrice(
      session.data.pickupAddress,
      session.data.dropoffAddress,
      session.data.urgent
    );

    session.pricing = pricing;
    session.step = 'confirm';

    return buildConfirmText(session.data, pricing);
  }

  return null;
}

async function confirmCurrentSession(userId) {
  const session = userSessions[userId];
  if (!session || session.step !== 'confirm' || !session.pricing) {
    return { ok: false, text: '目前沒有可確認的任務，請重新輸入「建立任務」' };
  }

  const orderId = createOrderId();
  const order = {
    orderId,
    userId,
    pickupAddress: session.data.pickupAddress,
    pickupPhone: session.data.pickupPhone,
    dropoffAddress: session.data.dropoffAddress,
    dropoffPhone: session.data.dropoffPhone,
    item: session.data.item,
    urgent: session.data.urgent,
    note: session.data.note,
    pricing: session.pricing,
    status: 'waiting',
    driverId: null,
    driverName: '',
    eta: null,
    createdAt: now(),
    acceptedAt: null,
    arrivedAt: null,
    pickedUpAt: null,
    deliveredAt: null,
    completedAt: null,
    dispatchCount: 0,
  };

  activeOrders[orderId] = order;
  resetUserSession(userId);

  if (!LINE_GROUP_ID) {
    console.warn('⚠️ LINE_GROUP_ID is empty. Dispatch skipped.');
    return {
      ok: true,
      text: [
        '✅ 任務建立成功',
        '',
        '但目前尚未設定群組派單 LINE_GROUP_ID',
        '請先到 Render 補上環境變數後再測試派單。',
      ].join('\n'),
    };
  }

  if (shouldSkipDuplicateDispatch(order)) {
    return {
      ok: true,
      text: '⚠️ 偵測到短時間內重複派單，系統已略過重複送出。',
    };
  }

  order.status = 'dispatched';
  order.dispatchCount += 1;

  enqueuePush(LINE_GROUP_ID, createTextMessage(buildGroupDispatchText(order)), {
    type: 'dispatch_order',
    orderId,
  });

  return {
    ok: true,
    text: [
      '✅ 您的任務已建立成功',
      '我們會立即為您派單。',
      '',
      buildCustomerPriceText(order.pricing),
    ].join('\n'),
  };
}

// =========================
// 騎手流程
// =========================
async function handleRiderAccept(groupId, userId, userName) {
  const order = getActiveWaitingOrder();

  if (!order) {
    return '目前沒有待接任務';
  }

  if (!canAcceptOrder(order.orderId)) {
    return '此任務已有人處理中';
  }

  riderSessions[getRiderSessionKey(groupId, userId)] = {
    step: 'await_eta',
    orderId: order.orderId,
    userId,
  };

  return '請輸入幾分鐘會到取件地點\n例如：8';
}

async function handleRiderEta(groupId, userId, userName, text) {
  const key = getRiderSessionKey(groupId, userId);
  const riderSession = riderSessions[key];

  if (!riderSession || riderSession.step !== 'await_eta') {
    return null;
  }

  const eta = Number(normalizeText(text));
  if (!Number.isFinite(eta) || eta <= 0 || eta > 180) {
    return '請輸入正確分鐘數，例如：8';
  }

  const order = activeOrders[riderSession.orderId];
  if (!order) {
    resetRiderSession(groupId, userId);
    return '此任務不存在或已失效';
  }

  if (!['waiting', 'dispatched'].includes(order.status)) {
    resetRiderSession(groupId, userId);
    return '此任務已無法接單';
  }

  if (!canAcceptOrder(order.orderId)) {
    resetRiderSession(groupId, userId);
    return '此任務已有人接單';
  }

  lockOrder(order.orderId, { accepted: true, acceptedBy: userId });

  order.status = 'accepted';
  order.driverId = userId;
  order.driverName = userName || '騎手';
  order.eta = eta;
  order.acceptedAt = now();

  resetRiderSession(groupId, userId);

  enqueuePush(
    order.userId,
    createTextMessage(`✅ 已有人接單\n⏱ 預計 ${eta} 分鐘抵達取件地點`),
    {
      type: 'customer_eta',
      orderId: order.orderId,
    }
  );

  return `✅ 已接單\n⏱ 預計 ${eta} 分鐘抵達取件地點`;
}

async function handleRiderStatus(userId, text) {
  const order = getAcceptedOrderByDriver(userId);

  if (!order) {
    return '你目前沒有進行中的任務';
  }

  const cmd = normalizeText(text);

  if (cmd === '已抵達') {
    if (order.status !== 'accepted') {
      return '目前狀態無法回報「已抵達」';
    }

    order.status = 'arrived';
    order.arrivedAt = now();

    enqueuePush(
      order.userId,
      createTextMessage('✅ 騎手已抵達取件地點'),
      { type: 'customer_arrived', orderId: order.orderId }
    );

    return '✅ 已回報：已抵達';
  }

  if (cmd === '已取件') {
    if (!['accepted', 'arrived'].includes(order.status)) {
      return '目前狀態無法回報「已取件」';
    }

    order.status = 'picked_up';
    order.pickedUpAt = now();

    enqueuePush(
      order.userId,
      createTextMessage('✅ 物品已取件，正前往送達地點'),
      { type: 'customer_picked_up', orderId: order.orderId }
    );

    return '✅ 已回報：已取件';
  }

  if (cmd === '已送達') {
    if (order.status !== 'picked_up') {
      return '目前狀態無法回報「已送達」';
    }

    order.status = 'delivered';
    order.deliveredAt = now();

    enqueuePush(
      order.userId,
      createTextMessage('✅ 物品已送達目的地'),
      { type: 'customer_delivered', orderId: order.orderId }
    );

    return '✅ 已回報：已送達';
  }

  if (cmd === '已完成') {
    if (!['picked_up', 'delivered'].includes(order.status)) {
      return '目前狀態無法回報「已完成」';
    }

    order.status = 'completed';
    order.completedAt = now();

    enqueuePush(
      order.userId,
      createTextMessage(
        [
          '✅ 任務完成',
          '',
          '感謝您使用 UBee 城市任務服務',
          '期待再次為您服務。',
        ].join('\n')
      ),
      { type: 'customer_completed', orderId: order.orderId }
    );

    return '✅ 已回報：任務完成';
  }

  return null;
}

// =========================
// 使用者文字事件
// =========================
async function handleUserTextMessage(event) {
  const source = event.source || {};
  const text = normalizeText(event.message?.text || '');
  const userId = source.userId;
  const groupId = source.groupId || '';
  const replyToken = event.replyToken;
  const userName = source.userId || 'user';

  if (!userId || !text) {
    return;
  }

  // 群組騎手流程
  if (source.type === 'group') {
    const riderKey = getRiderSessionKey(groupId, userId);
    const riderSession = riderSessions[riderKey];

    if (text === '接' || text === '接單') {
      const reply = await handleRiderAccept(groupId, userId, userName);
      return safeReply(replyToken, createTextMessage(reply));
    }

    if (riderSession?.step === 'await_eta') {
      const reply = await handleRiderEta(groupId, userId, userName, text);
      if (reply) {
        return safeReply(replyToken, createTextMessage(reply));
      }
    }

    if (['已抵達', '已取件', '已送達', '已完成'].includes(text)) {
      const reply = await handleRiderStatus(userId, text);
      if (reply) {
        return safeReply(replyToken, createTextMessage(reply));
      }
    }

    return;
  }

  // 一對一客戶流程
  const session = userSessions[userId];

  if (text === '建立任務') {
    startCreateTaskSession(userId);
    return safeReply(
      replyToken,
      createTextMessage('請輸入取件地點')
    );
  }

  if (session && session.step === 'confirm') {
    if (text === '確認') {
      const result = await confirmCurrentSession(userId);
      return safeReply(replyToken, createTextMessage(result.text));
    }

    if (text === '修改') {
      startCreateTaskSession(userId);
      return safeReply(replyToken, createTextMessage('好的，請重新輸入取件地點'));
    }

    if (text === '取消') {
      resetUserSession(userId);
      return safeReply(replyToken, createTextMessage('已取消本次任務建立'));
    }
  }

  if (session && session.step !== 'confirm') {
    const reply = await processCreateTaskStep(userId, text);
    if (reply) {
      return safeReply(replyToken, createTextMessage(reply));
    }
  }

  // 其他文字
  if (text === 'help' || text === '幫助') {
    return safeReply(
      replyToken,
      createTextMessage(
        [
          '可使用指令：',
          '1. 建立任務',
          '',
          '騎手群組指令：',
          '接 / 接單 / 已抵達 / 已取件 / 已送達 / 已完成',
        ].join('\n')
      )
    );
  }

  return safeReply(
    replyToken,
    createTextMessage('請輸入「建立任務」開始建立任務')
  );
}

// =========================
// Event 去重
// =========================
function getEventKey(event) {
  const source = event.source || {};
  const message = event.message || {};

  return [
    event.type || '',
    event.replyToken || '',
    source.type || '',
    source.userId || '',
    source.groupId || '',
    message.id || '',
    message.text || '',
    event.timestamp || '',
  ].join('|');
}

function isDuplicateEvent(event) {
  const key = getEventKey(event);
  if (processedEvents.has(key)) {
    return true;
  }

  processedEvents.set(key, now());
  return false;
}

// =========================
// Webhook
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee V3.1 running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ webhook error:', err?.message || err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  try {
    if (isDuplicateEvent(event)) {
      return;
    }

    if (event.type !== 'message') {
      return;
    }

    if (event.message?.type !== 'text') {
      if (event.replyToken) {
        return safeReply(event.replyToken, createTextMessage('目前僅支援文字訊息'));
      }
      return;
    }

    return handleUserTextMessage(event);
  } catch (err) {
    console.error('❌ handleEvent error:', err?.message || err);

    if (event.replyToken) {
      await safeReply(event.replyToken, createTextMessage('系統忙碌中，請稍後再試'));
    }
  }
}

app.listen(PORT, () => {
  console.log(`✅ UBee bot server running on port ${PORT}`);
});
require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');

const app = express();

// =========================
// 基本設定
// =========================
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

if (!LINE_GROUP_ID) {
  console.warn('⚠️ LINE_GROUP_ID 未設定，群組派單功能將無法正常使用');
}

if (!GOOGLE_MAPS_API_KEY) {
  console.warn('⚠️ GOOGLE_MAPS_API_KEY 未設定，地址解析 / 距離時間估算將無法正常使用');
}

// =========================
// 費率設定（Rev.C）
// =========================
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const SERVICE_FEE = 50;
const URGENT_FEE = 100;
const FIXED_TAX = 15;
const RIDER_RATE = 0.6; // 騎手抽成 = 配送費 * 0.6

// =========================
// 記憶體資料（測試營運版）
// 正式版建議改資料庫
// =========================
const userSessions = new Map(); // userId => session
const orders = new Map(); // orderId => order
const groupPendingEta = new Map(); // groupUserId => { orderId, groupId }
let orderSeq = 1;

// =========================
// 工具函式
// =========================
function genOrderId() {
  const id = `UB${String(orderSeq).padStart(6, '0')}`;
  orderSeq += 1;
  return id;
}

function nowTs() {
  return new Date().toISOString();
}

function safeText(val = '') {
  return String(val).trim();
}

function roundInt(n) {
  return Math.round(Number(n || 0));
}

function ceil1(n) {
  return Math.ceil(Number(n || 0) * 10) / 10;
}

function getDistrict(address = '') {
  // 簡易區域判斷：抓「XX區」
  const match = String(address).match(/([^\s縣市]{1,6}區)/);
  return match ? match[1] : '';
}

function buildGoogleMapsNavUrl(destination) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

function buildGoogleMapsSearchUrl(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function buildGreetingHelp() {
  return [
    '您好，歡迎使用 UBee 城市任務服務。',
    '',
    '請輸入以下指令：',
    '1. 建立任務',
    '2. 立即估價',
  ].join('\n');
}

function createButtonTemplate(altText, text, actions) {
  return {
    type: 'template',
    altText,
    template: {
      type: 'buttons',
      text,
      actions,
    },
  };
}

function createConfirmButtons(text, yesLabel = '是', noLabel = '否', yesData = 'YES', noData = 'NO') {
  return createButtonTemplate(
    '請選擇',
    text,
    [
      { type: 'postback', label: yesLabel, data: yesData },
      { type: 'postback', label: noLabel, data: noData },
    ]
  );
}

function createQuickReply(items) {
  return {
    items: items.map((item) => ({
      type: 'action',
      action: item,
    })),
  };
}

function buildCustomerSummary(order) {
  return [
    '請確認以下任務資訊：',
    '',
    `取件地點：${order.pickupAddress}`,
    `取件電話：${order.pickupPhone}`,
    '',
    `送達地點：${order.dropoffAddress}`,
    `送達電話：${order.dropoffPhone}`,
    '',
    `物品內容：${order.item}`,
    `是否急件：${order.urgent ? '急件' : '一般'}`,
    `備註：${order.note || '無'}`,
    '',
    `配送費：$${order.deliveryFee}`,
    `服務費：$${order.serviceFee}`,
    `急件費：$${order.urgentFee}`,
    `稅金：$${order.tax}`,
    `總計：$${order.total}`,
  ].join('\n');
}

function buildQuoteText(quote) {
  return [
    '以下為本次預估費用：',
    '',
    `配送費：$${quote.deliveryFee}`,
    `服務費：$${quote.serviceFee}`,
    `急件費：$${quote.urgentFee}`,
    `稅金：$${quote.tax}`,
    `總計：$${quote.total}`,
  ].join('\n');
}

function buildOrderDispatchText(order) {
  return [
    '📦 UBee 新任務通知',
    '',
    `費用：$${order.riderFee}`,
    '',
    `取件：${order.pickupAddress}`,
    `送達：${order.dropoffAddress}`,
    `物品：${order.item}`,
    `急件：${order.urgent ? '急件' : '一般'}`,
  ].join('\n');
}

function buildAcceptedNotifyToCustomer(order) {
  return [
    '✅ 已有騎手接單',
    '',
    `預計 ${order.etaMinutes} 分鐘抵達取件地點`,
  ].join('\n');
}

function buildRiderAcceptedGroupText(order, riderName) {
  return [
    '✅ 任務已接單',
    `接單人員：${riderName || '騎手'}`,
    '',
    `預計 ${order.etaMinutes} 分鐘抵達取件地點`,
  ].join('\n');
}

function buildStatusText(status) {
  switch (status) {
    case 'accepted':
      return '已接單';
    case 'arrived':
      return '已抵達';
    case 'picked':
      return '已取件';
    case 'delivered':
      return '已送達';
    case 'completed':
      return '已完成';
    default:
      return '配對中';
  }
}

function buildTaskStatusCard(order) {
  const statusText = buildStatusText(order.status);
  const riderName = order.riderName || '尚未指定';

  const actions = [];

  if (order.status === 'accepted') {
    actions.push({
      type: 'postback',
      label: '已抵達',
      data: `ORDER_ACTION|${order.orderId}|ARRIVED`,
    });
    actions.push({
      type: 'uri',
      label: '導航到取件地',
      uri: buildGoogleMapsNavUrl(order.pickupAddress),
    });
    actions.push({
      type: 'uri',
      label: '導航到送達地',
      uri: buildGoogleMapsNavUrl(order.dropoffAddress),
    });
  } else if (order.status === 'arrived') {
    actions.push({
      type: 'postback',
      label: '已取件',
      data: `ORDER_ACTION|${order.orderId}|PICKED`,
    });
    actions.push({
      type: 'uri',
      label: '導航到送達地',
      uri: buildGoogleMapsNavUrl(order.dropoffAddress),
    });
  } else if (order.status === 'picked') {
    actions.push({
      type: 'postback',
      label: '已送達',
      data: `ORDER_ACTION|${order.orderId}|DELIVERED`,
    });
    actions.push({
      type: 'uri',
      label: '導航到送達地',
      uri: buildGoogleMapsNavUrl(order.dropoffAddress),
    });
  } else if (order.status === 'delivered') {
    actions.push({
      type: 'postback',
      label: '已完成',
      data: `ORDER_ACTION|${order.orderId}|COMPLETED`,
    });
  } else if (order.status === 'completed') {
    actions.push({
      type: 'uri',
      label: '查看取件地',
      uri: buildGoogleMapsSearchUrl(order.pickupAddress),
    });
    actions.push({
      type: 'uri',
      label: '查看送達地',
      uri: buildGoogleMapsSearchUrl(order.dropoffAddress),
    });
  } else {
    actions.push({
      type: 'uri',
      label: '查看取件地',
      uri: buildGoogleMapsSearchUrl(order.pickupAddress),
    });
    actions.push({
      type: 'uri',
      label: '查看送達地',
      uri: buildGoogleMapsSearchUrl(order.dropoffAddress),
    });
  }

  return createButtonTemplate(
    'UBee 任務操作卡',
    `任務狀態：${statusText}\n接單人員：${riderName}\n費用：$${order.riderFee}`,
    actions.slice(0, 4)
  );
}

function buildDispatchButtons(order) {
  return createButtonTemplate(
    'UBee 新任務通知',
    `費用：$${order.riderFee}\n取件：${shortText(order.pickupAddress, 28)}\n送達：${shortText(order.dropoffAddress, 28)}\n物品：${shortText(order.item, 16)}\n急件：${order.urgent ? '急件' : '一般'}`,
    [
      {
        type: 'postback',
        label: '✔️接單',
        data: `ORDER_CLAIM|${order.orderId}|ACCEPT`,
      },
      {
        type: 'postback',
        label: '❌拒單',
        data: `ORDER_CLAIM|${order.orderId}|REJECT`,
      },
      {
        type: 'uri',
        label: '看取件地',
        uri: buildGoogleMapsSearchUrl(order.pickupAddress),
      },
      {
        type: 'uri',
        label: '看送達地',
        uri: buildGoogleMapsSearchUrl(order.dropoffAddress),
      },
    ]
  );
}

function shortText(str, max = 20) {
  const s = String(str || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function getOrCreateSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      mode: null, // quote / task
      step: null,
      data: {},
      fromQuote: false,
      quoteReady: false,
    });
  }
  return userSessions.get(userId);
}

function resetSession(userId) {
  userSessions.set(userId, {
    mode: null,
    step: null,
    data: {},
    fromQuote: false,
    quoteReady: false,
  });
}

async function geocodeAddress(address) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY 未設定');
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK' || !data.results || !data.results.length) {
    throw new Error(`地址查詢失敗：${data.error_message || data.status || '未知錯誤'}`);
  }

  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
}

async function getRouteInfo(originAddress, destinationAddress) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY 未設定');
  }

  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(originAddress)}&destination=${encodeURIComponent(destinationAddress)}&mode=driving&language=zh-TW&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK' || !data.routes || !data.routes.length) {
    throw new Error(`路線查詢失敗：${data.error_message || data.status || '未知錯誤'}`);
  }

  const leg = data.routes[0].legs[0];
  const distanceMeters = leg.distance.value;
  const durationSeconds = leg.duration.value;

  return {
    distanceKm: ceil1(distanceMeters / 1000),
    durationMin: Math.ceil(durationSeconds / 60),
  };
}

function calcPricing({ distanceKm, durationMin, urgent, pickupAddress, dropoffAddress }) {
  const pickupDistrict = getDistrict(pickupAddress);
  const dropoffDistrict = getDistrict(dropoffAddress);
  const isCrossDistrict =
    pickupDistrict && dropoffDistrict && pickupDistrict !== dropoffDistrict;

  const base = BASE_FEE;
  const kmFee = roundInt(distanceKm * PER_KM_FEE);
  const minFee = roundInt(durationMin * PER_MIN_FEE);
  const crossFee = isCrossDistrict ? CROSS_DISTRICT_FEE : 0;
  const urgentFee = urgent ? URGENT_FEE : 0;

  const deliveryFee = base + kmFee + minFee + crossFee;
  const serviceFee = SERVICE_FEE;
  const tax = FIXED_TAX;
  const total = deliveryFee + serviceFee + urgentFee + tax;
  const riderFee = roundInt(deliveryFee * RIDER_RATE);

  return {
    base,
    kmFee,
    minFee,
    crossFee,
    urgentFee,
    deliveryFee,
    serviceFee,
    tax,
    total,
    riderFee,
    isCrossDistrict,
    pickupDistrict,
    dropoffDistrict,
  };
}

async function buildQuoteFromInput({ pickupAddress, dropoffAddress, urgent }) {
  const route = await getRouteInfo(pickupAddress, dropoffAddress);
  const price = calcPricing({
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
    urgent,
    pickupAddress,
    dropoffAddress,
  });

  return {
    ...route,
    ...price,
  };
}

async function safeReply(replyToken, messages) {
  try {
    await client.replyMessage(replyToken, Array.isArray(messages) ? messages : [messages]);
  } catch (err) {
    console.error('❌ replyMessage error:', err.response?.data || err.message);
  }
}

async function safePush(to, messages) {
  try {
    await client.pushMessage(to, Array.isArray(messages) ? messages : [messages]);
  } catch (err) {
    console.error('❌ pushMessage error:', err.response?.data || err.message);
  }
}

function normalizeText(text) {
  return safeText(text).replace(/\s+/g, '');
}

function isNumericOnly(text) {
  return /^\d+$/.test(safeText(text));
}

async function getDisplayNameSafe(userId, source) {
  try {
    if (source.type === 'group' && source.groupId) {
      const profile = await client.getGroupMemberProfile(source.groupId, userId);
      return profile.displayName || '騎手';
    }
    if (source.type === 'room' && source.roomId) {
      const profile = await client.getRoomMemberProfile(source.roomId, userId);
      return profile.displayName || '騎手';
    }
    const profile = await client.getProfile(userId);
    return profile.displayName || '使用者';
  } catch (e) {
    return '騎手';
  }
}

// =========================
// Webhook
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee OMS V3.6.3 Rev.C Running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ webhook error:', err);
    res.status(500).send('Error');
  }
});

// =========================
// 事件處理
// =========================
async function handleEvent(event) {
  if (event.type === 'message' && event.message.type === 'text') {
    return handleTextMessage(event);
  }

  if (event.type === 'postback') {
    return handlePostback(event);
  }

  return null;
}

async function handleTextMessage(event) {
  const source = event.source;
  const userId = source.userId;
  const textRaw = event.message.text || '';
  const text = normalizeText(textRaw);

  // 群組：處理 ETA 數字輸入
  if (source.type === 'group' || source.type === 'room') {
    if (userId && isNumericOnly(textRaw) && groupPendingEta.has(userId)) {
      return handleEtaInput(event, parseInt(textRaw, 10));
    }
    return null;
  }

  // 一對一對話
  if (!userId) return null;

  const session = getOrCreateSession(userId);

  if (['hi', 'hello', '嗨', '哈囉', '您好', '你好', 'help', '幫助'].includes(text.toLowerCase()) || text === '幫助') {
    resetSession(userId);
    return safeReply(event.replyToken, { type: 'text', text: buildGreetingHelp() });
  }

  if (text === '建立任務') {
    resetSession(userId);
    const s = getOrCreateSession(userId);
    s.mode = 'task';
    s.step = 'pickup_address';
    return safeReply(event.replyToken, {
      type: 'text',
      text: '請輸入取件地點：',
    });
  }

  if (text === '立即估價') {
    resetSession(userId);
    const s = getOrCreateSession(userId);
    s.mode = 'quote';
    s.step = 'pickup_address';
    return safeReply(event.replyToken, {
      type: 'text',
      text: '請輸入取件地點：',
    });
  }

  if (!session.mode || !session.step) {
    return safeReply(event.replyToken, {
      type: 'text',
      text: buildGreetingHelp(),
    });
  }

  try {
    if (session.mode === 'quote') {
      return handleQuoteFlow(event, session, textRaw);
    }
    if (session.mode === 'task') {
      return handleTaskFlow(event, session, textRaw);
    }
  } catch (err) {
    console.error('❌ handleTextMessage flow error:', err);
    resetSession(userId);
    return safeReply(event.replyToken, {
      type: 'text',
      text: `處理失敗：${err.message || '未知錯誤'}\n\n請重新輸入「建立任務」或「立即估價」。`,
    });
  }

  return null;
}

async function handleQuoteFlow(event, session, textRaw) {
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const input = safeText(textRaw);

  switch (session.step) {
    case 'pickup_address':
      session.data.pickupAddress = input;
      session.step = 'dropoff_address';
      return safeReply(replyToken, {
        type: 'text',
        text: '請輸入送達地點：',
      });

    case 'dropoff_address':
      session.data.dropoffAddress = input;
      session.step = 'urgent';
      return safeReply(replyToken, createButtonTemplate(
        '是否急件',
        '請選擇是否急件：',
        [
          { type: 'postback', label: '一般', data: 'QUOTE_URGENT|NO' },
          { type: 'postback', label: '急件', data: 'QUOTE_URGENT|YES' },
        ]
      ));

    default:
      resetSession(userId);
      return safeReply(replyToken, {
        type: 'text',
        text: '流程已重置，請重新輸入「立即估價」。',
      });
  }
}

async function handleTaskFlow(event, session, textRaw) {
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const input = safeText(textRaw);

  switch (session.step) {
    case 'pickup_address':
      session.data.pickupAddress = input;
      session.step = 'dropoff_address';
      return safeReply(replyToken, {
        type: 'text',
        text: '請輸入送達地點：',
      });

    case 'dropoff_address':
      session.data.dropoffAddress = input;
      session.step = 'item';
      return safeReply(replyToken, {
        type: 'text',
        text: '請輸入物品內容：',
      });

    case 'item':
      session.data.item = input;
      session.step = 'urgent';
      return safeReply(replyToken, createButtonTemplate(
        '是否急件',
        '請選擇是否急件：',
        [
          { type: 'postback', label: '一般', data: 'TASK_URGENT|NO' },
          { type: 'postback', label: '急件', data: 'TASK_URGENT|YES' },
        ]
      ));

    case 'pickup_phone':
      session.data.pickupPhone = input;
      session.step = 'dropoff_phone';
      return safeReply(replyToken, {
        type: 'text',
        text: '請輸入送達電話：',
      });

    case 'dropoff_phone':
      session.data.dropoffPhone = input;
      session.step = 'note';
      return safeReply(replyToken, {
        type: 'text',
        text: '請輸入備註（沒有請輸入：無）：',
      });

    case 'note':
      session.data.note = input === '' ? '無' : input;
      return finalizeTaskPreview(replyToken, userId, session);

    default:
      resetSession(userId);
      return safeReply(replyToken, {
        type: 'text',
        text: '流程已重置，請重新輸入「建立任務」。',
      });
  }
}

async function finalizeTaskPreview(replyToken, userId, session) {
  const quote = await buildQuoteFromInput({
    pickupAddress: session.data.pickupAddress,
    dropoffAddress: session.data.dropoffAddress,
    urgent: !!session.data.urgent,
  });

  session.data.quote = quote;
  session.step = 'confirm_task';

  const previewOrder = {
    pickupAddress: session.data.pickupAddress,
    pickupPhone: session.data.pickupPhone,
    dropoffAddress: session.data.dropoffAddress,
    dropoffPhone: session.data.dropoffPhone,
    item: session.data.item,
    urgent: !!session.data.urgent,
    note: session.data.note || '無',
    deliveryFee: quote.deliveryFee,
    serviceFee: quote.serviceFee,
    urgentFee: quote.urgentFee,
    tax: quote.tax,
    total: quote.total,
  };

  return safeReply(replyToken, [
    {
      type: 'text',
      text: buildCustomerSummary(previewOrder),
    },
    createButtonTemplate(
      '確認任務資訊',
      '請確認是否建立任務：',
      [
        { type: 'postback', label: '確認建立', data: 'TASK_CONFIRM|YES' },
        { type: 'postback', label: '重新填寫', data: 'TASK_CONFIRM|RESET' },
        { type: 'postback', label: '取消', data: 'TASK_CONFIRM|CANCEL' },
      ]
    ),
  ]);
}

async function handlePostback(event) {
  const data = event.postback.data || '';
  const source = event.source;
  const userId = source.userId;

  try {
    // =========================
    // 立即估價：是否急件
    // =========================
    if (data.startsWith('QUOTE_URGENT|')) {
      const session = getOrCreateSession(userId);
      session.data.urgent = data.endsWith('|YES');
      session.step = 'quoted';

      const quote = await buildQuoteFromInput({
        pickupAddress: session.data.pickupAddress,
        dropoffAddress: session.data.dropoffAddress,
        urgent: !!session.data.urgent,
      });

      session.data.quote = quote;
      session.quoteReady = true;

      return safeReply(event.replyToken, [
        {
          type: 'text',
          text: buildQuoteText(quote),
        },
        createButtonTemplate(
          '是否建立任務',
          '是否確定建立任務？',
          [
            { type: 'postback', label: '是', data: 'QUOTE_CREATE_TASK|YES' },
            { type: 'postback', label: '否', data: 'QUOTE_CREATE_TASK|NO' },
          ]
        ),
      ]);
    }

    // =========================
    // 建立任務：是否急件
    // =========================
    if (data.startsWith('TASK_URGENT|')) {
      const session = getOrCreateSession(userId);
      session.data.urgent = data.endsWith('|YES');
      session.step = 'pickup_phone';
      return safeReply(event.replyToken, {
        type: 'text',
        text: '請輸入取件電話：',
      });
    }

    // =========================
    // 估價後是否直接建立任務
    // =========================
    if (data === 'QUOTE_CREATE_TASK|YES') {
      const session = getOrCreateSession(userId);

      if (!session.data.pickupAddress || !session.data.dropoffAddress || !session.data.quote) {
        resetSession(userId);
        return safeReply(event.replyToken, {
          type: 'text',
          text: '估價資料已失效，請重新輸入「立即估價」。',
        });
      }

      session.mode = 'task';
      session.fromQuote = true;
      session.step = 'item';

      return safeReply(event.replyToken, {
        type: 'text',
        text: [
          '好的，以下將接續您剛剛的估價內容建立任務。',
          '',
          '請輸入物品內容：',
        ].join('\n'),
      });
    }

    if (data === 'QUOTE_CREATE_TASK|NO') {
      resetSession(userId);
      return safeReply(event.replyToken, {
        type: 'text',
        text: '好的，若您之後需要服務，請再輸入「建立任務」或「立即估價」。',
      });
    }

    // =========================
    // 任務確認
    // =========================
    if (data === 'TASK_CONFIRM|RESET') {
      resetSession(userId);
      const s = getOrCreateSession(userId);
      s.mode = 'task';
      s.step = 'pickup_address';
      return safeReply(event.replyToken, {
        type: 'text',
        text: '好的，請重新輸入取件地點：',
      });
    }

    if (data === 'TASK_CONFIRM|CANCEL') {
      resetSession(userId);
      return safeReply(event.replyToken, {
        type: 'text',
        text: '本次任務已取消。',
      });
    }

    if (data === 'TASK_CONFIRM|YES') {
      const session = getOrCreateSession(userId);
      const quote = session.data.quote;

      if (!quote) {
        resetSession(userId);
        return safeReply(event.replyToken, {
          type: 'text',
          text: '任務資料已失效，請重新輸入「建立任務」。',
        });
      }

      const orderId = genOrderId();

      const order = {
        orderId,
        createdAt: nowTs(),
        customerUserId: userId,

        pickupAddress: session.data.pickupAddress,
        pickupPhone: session.data.pickupPhone,
        dropoffAddress: session.data.dropoffAddress,
        dropoffPhone: session.data.dropoffPhone,
        item: session.data.item,
        urgent: !!session.data.urgent,
        note: session.data.note || '無',

        distanceKm: quote.distanceKm,
        durationMin: quote.durationMin,
        deliveryFee: quote.deliveryFee,
        serviceFee: quote.serviceFee,
        urgentFee: quote.urgentFee,
        tax: quote.tax,
        total: quote.total,
        riderFee: quote.riderFee,

        status: 'matching',
        riderUserId: null,
        riderName: null,
        etaMinutes: null,
        rejectedRiders: [],
      };

      orders.set(orderId, order);
      resetSession(userId);

      await safeReply(event.replyToken, {
        type: 'text',
        text: [
          '✅ 任務建立成功',
          '',
          '系統正在配對中……',
        ].join('\n'),
      });

      if (!LINE_GROUP_ID) {
        await safePush(userId, {
          type: 'text',
          text: '⚠️ 系統未設定派單群組，請聯繫管理員。',
        });
        return null;
      }

      await safePush(LINE_GROUP_ID, [
        {
          type: 'text',
          text: buildOrderDispatchText(order),
        },
        buildDispatchButtons(order),
      ]);

      return null;
    }

    // =========================
    // 騎手接單 / 拒單
    // =========================
    if (data.startsWith('ORDER_CLAIM|')) {
      const [, orderId, action] = data.split('|');
      const order = orders.get(orderId);

      if (!order) {
        return safeReply(event.replyToken, {
          type: 'text',
          text: '⚠️ 找不到此任務，可能已失效。',
        });
      }

      if (!userId) {
        return safeReply(event.replyToken, {
          type: 'text',
          text: '⚠️ 無法識別騎手身份。',
        });
      }

      if (action === 'REJECT') {
        if (!order.rejectedRiders.includes(userId)) {
          order.rejectedRiders.push(userId);
        }

        return safeReply(event.replyToken, {
          type: 'text',
          text: '已記錄拒單，系統正在持續配對中……',
        });
      }

      if (action === 'ACCEPT') {
        if (order.status !== 'matching') {
          return safeReply(event.replyToken, {
            type: 'text',
            text: '⚠️ 此任務已被其他騎手接單。',
          });
        }

        groupPendingEta.set(userId, {
          orderId,
          groupId: source.groupId || source.roomId || '',
        });

        return safeReply(event.replyToken, {
          type: 'text',
          text: '請輸入預計幾分鐘抵達取件地點（請直接輸入數字，例如：20）',
        });
      }
    }

    // =========================
    // 任務狀態操作
    // =========================
    if (data.startsWith('ORDER_ACTION|')) {
      const [, orderId, action] = data.split('|');
      const order = orders.get(orderId);

      if (!order) {
        return safeReply(event.replyToken, {
          type: 'text',
          text: '⚠️ 找不到此任務，可能已失效。',
        });
      }

      if (!userId || userId !== order.riderUserId) {
        return safeReply(event.replyToken, {
          type: 'text',
          text: '⚠️ 只有接單騎手可以操作此任務。',
        });
      }

      if (action === 'ARRIVED') {
        if (order.status !== 'accepted') {
          return safeReply(event.replyToken, {
            type: 'text',
            text: '⚠️ 目前狀態不可操作「已抵達」。',
          });
        }
        order.status = 'arrived';

        await safeReply(event.replyToken, {
          type: 'text',
          text: '✅ 已更新為：已抵達',
        });

        await safePush(order.customerUserId, {
          type: 'text',
          text: '✅ 騎手已抵達取件地點。',
        });

        await safePush(LINE_GROUP_ID, buildTaskStatusCard(order));
        return null;
      }

      if (action === 'PICKED') {
        if (order.status !== 'arrived') {
          return safeReply(event.replyToken, {
            type: 'text',
            text: '⚠️ 目前狀態不可操作「已取件」。',
          });
        }
        order.status = 'picked';

        await safeReply(event.replyToken, {
          type: 'text',
          text: '✅ 已更新為：已取件',
        });

        await safePush(order.customerUserId, {
          type: 'text',
          text: '✅ 騎手已完成取件，正在前往送達地點。',
        });

        await safePush(LINE_GROUP_ID, buildTaskStatusCard(order));
        return null;
      }

      if (action === 'DELIVERED') {
        if (order.status !== 'picked') {
          return safeReply(event.replyToken, {
            type: 'text',
            text: '⚠️ 目前狀態不可操作「已送達」。',
          });
        }
        order.status = 'delivered';

        await safeReply(event.replyToken, {
          type: 'text',
          text: '✅ 已更新為：已送達',
        });

        await safePush(order.customerUserId, {
          type: 'text',
          text: '✅ 您的物品已送達。',
        });

        await safePush(LINE_GROUP_ID, buildTaskStatusCard(order));
        return null;
      }

      if (action === 'COMPLETED') {
        if (order.status !== 'delivered') {
          return safeReply(event.replyToken, {
            type: 'text',
            text: '⚠️ 目前狀態不可操作「已完成」。',
          });
        }
        order.status = 'completed';

        await safeReply(event.replyToken, {
          type: 'text',
          text: '✅ 任務已完成',
        });

        await safePush(order.customerUserId, {
          type: 'text',
          text: [
            '✅ 已抵達目的地，任務已完成。',
            '',
            '感謝您使用 UBee 城市任務跑腿服務。',
            '期待再次為您服務。',
          ].join('\n'),
        });

        await safePush(LINE_GROUP_ID, buildTaskStatusCard(order));
        return null;
      }
    }

    return safeReply(event.replyToken, {
      type: 'text',
      text: '未識別的操作，請重新嘗試。',
    });
  } catch (err) {
    console.error('❌ postback error:', err);
    return safeReply(event.replyToken, {
      type: 'text',
      text: `操作失敗：${err.message || '未知錯誤'}`,
    });
  }
}

async function handleEtaInput(event, etaMinutes) {
  const source = event.source;
  const userId = source.userId;
  const pending = groupPendingEta.get(userId);

  if (!pending) return null;

  const order = orders.get(pending.orderId);
  if (!order) {
    groupPendingEta.delete(userId);
    return safeReply(event.replyToken, {
      type: 'text',
      text: '⚠️ 找不到任務，可能已失效。',
    });
  }

  if (order.status !== 'matching') {
    groupPendingEta.delete(userId);
    return safeReply(event.replyToken, {
      type: 'text',
      text: '⚠️ 此任務已被其他騎手接單。',
    });
  }

  const riderName = await getDisplayNameSafe(userId, source);

  order.status = 'accepted';
  order.riderUserId = userId;
  order.riderName = riderName;
  order.etaMinutes = etaMinutes;

  groupPendingEta.delete(userId);

  await safeReply(event.replyToken, {
    type: 'text',
    text: `預計${etaMinutes}分鐘抵達取件地點`,
  });

  await safePush(order.customerUserId, {
    type: 'text',
    text: buildAcceptedNotifyToCustomer(order),
  });

  await safePush(LINE_GROUP_ID, [
    {
      type: 'text',
      text: buildRiderAcceptedGroupText(order, riderName),
    },
    buildTaskStatusCard(order),
  ]);

  return null;
}

// =========================
// 啟動
// =========================
app.listen(PORT, () => {
  console.log(`✅ UBee OMS V3.6.3 Rev.C running on port ${PORT}`);
});
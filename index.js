require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

const app = express();

// ===== Firebase 初始化 =====
let db = null;

try {
  if (process.env.FIREBASE_KEY) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    db = admin.firestore();
    console.log('✅ Firebase 已成功連線');
  } else {
    console.log('⚠️ 未設定 FIREBASE_KEY');
  }
} catch (error) {
  console.error('❌ Firebase 初始化失敗:', error.message);
}
// =========================
// 基本設定
// =========================
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('❌ 缺少 CHANNEL_ACCESS_TOKEN 或 CHANNEL_SECRET');
  process.exit(1);
}

const client = new line.Client(config);

const PORT = process.env.PORT || 3000;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID || '';
const LINE_FINISH_GROUP_ID = process.env.LINE_FINISH_GROUP_ID || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const PAYMENT_JKO_INFO =
  process.env.PAYMENT_JKO_INFO ||
  '街口支付\n帳號：UBee｜901871793\n付款後請按「我已付款」';

const PAYMENT_BANK_INFO =
  process.env.PAYMENT_BANK_INFO ||
  '銀行轉帳\n銀行：XXX銀行\n帳號：XXX-XXX-XXX';

const PAYMENT_VERIFY_MODE = (process.env.PAYMENT_VERIFY_MODE || 'CODE').toUpperCase();
const PAYMENT_CODE_LENGTH = Number(process.env.PAYMENT_CODE_LENGTH || 5);

const BASE_FEE = Number(process.env.BASE_FEE || 99);
const PRICE_PER_KM = Number(process.env.PRICE_PER_KM || 6);
const PRICE_PER_MIN = Number(process.env.PRICE_PER_MIN || 3);
const CROSS_DISTRICT_FEE = Number(process.env.CROSS_DISTRICT_FEE || 25);
const URGENT_FEE = Number(process.env.URGENT_FEE || 100);
const SERVICE_FEE = Number(process.env.SERVICE_FEE || 50);
const NIGHT_FEE = Number(process.env.NIGHT_FEE || 80);
const NIGHT_START_HOUR = Number(process.env.NIGHT_START_HOUR || 22);
const NIGHT_END_HOUR = Number(process.env.NIGHT_END_HOUR || 6);

const RIDER_SHARE_RATE = Number(process.env.RIDER_SHARE_RATE || 0.6);
const MIN_RIDER_PAY = Number(process.env.MIN_RIDER_PAY || 120);

// =========================
// 記憶體資料
// =========================
const orders = {};
const userSessions = {};
const pendingEtaInput = {};
const pendingPaymentCodeInput = {};

// =========================
// 工具
// =========================
function createOrderId() {
  return `UB${Date.now()}`;
}

function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

function generatePaymentCode(length = 5) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function parseDistrict(address = '') {
  const match = address.match(/(豐原區|潭子區|神岡區|大雅區|北屯區|西屯區|西區|南屯區|南區|北區|東區|中區|太平區|大里區|烏日區|霧峰區|后里區|石岡區|新社區|和平區|大甲區|外埔區|清水區|沙鹿區|龍井區|梧棲區|大肚區)/);
  return match ? match[1] : '';
}

function isCrossDistrict(pickup, dropoff) {
  const a = parseDistrict(pickup);
  const b = parseDistrict(dropoff);
  return a && b && a !== b;
}

function isNightTime(date = new Date()) {
  const hour = date.getHours();
  if (NIGHT_START_HOUR > NIGHT_END_HOUR) {
    return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
  }
  return hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR;
}

function calcRiderPay(totalPrice) {
  const pay = Math.round(totalPrice * RIDER_SHARE_RATE);
  return Math.max(pay, MIN_RIDER_PAY);
}

function calcPrice({
  distanceKm = 0,
  durationMin = 0,
  pickupAddress = '',
  dropoffAddress = '',
  isUrgent = false,
  now = new Date(),
}) {
  let price =
    BASE_FEE +
    Math.ceil(distanceKm) * PRICE_PER_KM +
    Math.ceil(durationMin) * PRICE_PER_MIN +
    SERVICE_FEE;

  const feeItems = [];
  feeItems.push(`基本費 $${BASE_FEE}`);
  feeItems.push(`距離費 $${Math.ceil(distanceKm) * PRICE_PER_KM}`);
  feeItems.push(`時間費 $${Math.ceil(durationMin) * PRICE_PER_MIN}`);
  feeItems.push(`服務費 $${SERVICE_FEE}`);

  if (isCrossDistrict(pickupAddress, dropoffAddress)) {
    price += CROSS_DISTRICT_FEE;
    feeItems.push(`跨區加成 $${CROSS_DISTRICT_FEE}`);
  }

  if (isUrgent) {
    price += URGENT_FEE;
    feeItems.push(`急件加成 $${URGENT_FEE}`);
  }

  if (isNightTime(now)) {
    price += NIGHT_FEE;
    feeItems.push(`夜間加成 $${NIGHT_FEE}`);
  }

  return {
    total: Math.round(price),
    feeItems,
  };
}

function sanitizeText(text = '') {
  return String(text).trim();
}

function getUserSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = {
      mode: null,
      step: null,
      data: {},
    };
  }
  return userSessions[userId];
}

function resetUserSession(userId) {
  userSessions[userId] = {
    mode: null,
    step: null,
    data: {},
  };
}

async function geocodeAddress(address) {
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.results || !data.results.length) {
    throw new Error(`找不到地址：${address}`);
  }

  const result = data.results[0];
  return {
    formattedAddress: result.formatted_address,
    location: result.geometry.location,
  };
}

async function getDistanceAndDuration(origin, destination) {
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&language=zh-TW&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (
    !data.rows ||
    !data.rows[0] ||
    !data.rows[0].elements ||
    !data.rows[0].elements[0] ||
    data.rows[0].elements[0].status !== 'OK'
  ) {
    throw new Error('無法計算距離與時間');
  }

  const element = data.rows[0].elements[0];
  return {
    distanceText: element.distance.text,
    durationText: element.duration.text,
    distanceKm: element.distance.value / 1000,
    durationMin: element.duration.value / 60,
  };
}

function buildNavigationUrl(address) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}&travelmode=driving`;
}

function buildMainMenuFlex() {
  return {
    type: 'flex',
    altText: 'UBee 主選單',
    contents: {
      type: 'bubble',
      hero: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        backgroundColor: '#111111',
        contents: [
          {
            type: 'text',
            text: 'UBee',
            color: '#F7C948',
            weight: 'bold',
            size: 'xxl',
          },
          {
            type: 'text',
            text: '城市任務服務',
            color: '#FFFFFF',
            size: 'sm',
            margin: 'md',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            action: {
              type: 'postback',
              label: '下單',
              data: 'action=menu_order',
              displayText: '我要下單',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: '企業',
              data: 'action=menu_business',
              displayText: '企業合作',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: '我的',
              data: 'action=menu_my',
              displayText: '我的',
            },
          },
        ],
      },
    },
  };
}

function buildOrderMenuButtons() {
  return {
    type: 'template',
    altText: '下單選單',
    template: {
      type: 'buttons',
      title: 'UBee｜下單',
      text: '請選擇服務項目',
      actions: [
        {
          type: 'postback',
          label: '建立任務',
          data: 'action=create_order_start',
          displayText: '建立任務',
        },
        {
          type: 'postback',
          label: '立即估價',
          data: 'action=quick_quote_start',
          displayText: '立即估價',
        },
        {
          type: 'message',
          label: '返回主選單',
          text: '主選單',
        },
      ],
    },
  };
}

function buildBusinessMenuButtons() {
  return {
    type: 'template',
    altText: '企業選單',
    template: {
      type: 'buttons',
      title: 'UBee｜企業',
      text: '企業合作與月結服務',
      actions: [
        {
          type: 'uri',
          label: '企業合作表單',
          uri:
            'https://docs.google.com/forms/d/e/1FAIpQLScn9AGnp4FbTGg6fZt5fpiMdNEi-yL9x595bTyVFHAoJmpYlA/viewform',
        },
        {
          type: 'message',
          label: '企業服務介紹',
          text: '企業服務介紹',
        },
        {
          type: 'message',
          label: '返回主選單',
          text: '主選單',
        },
      ],
    },
  };
}

function buildMyMenuButtons() {
  return {
    type: 'template',
    altText: '我的選單',
    template: {
      type: 'buttons',
      title: 'UBee｜我的',
      text: '會員與服務資訊',
      actions: [
        {
          type: 'uri',
          label: '合作夥伴申請',
          uri:
            'https://docs.google.com/forms/d/e/1FAIpQLSc2qdklWuSSPw39vjfrXEakBHTI3TM_NgqMxWLAZg0ej6zvMA/viewform',
        },
        {
          type: 'message',
          label: '服務說明',
          text: '服務說明',
        },
        {
          type: 'message',
          label: '返回主選單',
          text: '主選單',
        },
      ],
    },
  };
}

function buildQuoteFlex(result) {
  return {
    type: 'flex',
    altText: '估價結果',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: 'UBee｜立即估價',
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'separator',
            margin: 'md',
          },
          {
            type: 'text',
            text: `取件：${result.pickupAddress}`,
            wrap: true,
            size: 'sm',
          },
          {
            type: 'text',
            text: `送達：${result.dropoffAddress}`,
            wrap: true,
            size: 'sm',
          },
          {
            type: 'text',
            text: `距離：約 ${result.distanceKm.toFixed(1)} km`,
            size: 'sm',
          },
          {
            type: 'text',
            text: `時間：約 ${Math.ceil(result.durationMin)} 分鐘`,
            size: 'sm',
          },
          {
            type: 'text',
            text: `費用：$${result.totalPrice}`,
            weight: 'bold',
            size: 'xxl',
            margin: 'md',
          },
          {
            type: 'text',
            text: result.feeItems.join(' / '),
            wrap: true,
            size: 'xs',
            color: '#666666',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            action: {
              type: 'postback',
              label: '建立任務',
              data: 'action=create_order_start',
              displayText: '建立任務',
            },
          },
          {
            type: 'button',
            action: {
              type: 'message',
              label: '主選單',
              text: '主選單',
            },
          },
        ],
      },
    },
  };
}

function buildCustomerPaymentFlex(order) {
  return {
    type: 'flex',
    altText: '付款資訊',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: 'UBee｜付款資訊', weight: 'bold', size: 'xl' },
          { type: 'text', text: `訂單編號：${order.id}`, size: 'sm' },
          { type: 'text', text: `費用：$${order.totalPrice}`, weight: 'bold', size: 'xl' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: PAYMENT_JKO_INFO, wrap: true, size: 'sm' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: PAYMENT_BANK_INFO, wrap: true, size: 'sm' },
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: PAYMENT_VERIFY_MODE === 'CODE'
              ? `付款驗證碼：${order.paymentCode}`
              : '付款後請按下方按鈕通知系統',
            wrap: true,
            size: 'sm',
            color: '#D9480F',
            weight: 'bold',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            action: {
              type: 'postback',
              label: '我已付款',
              data: `action=paid_click&orderId=${order.id}`,
              displayText: '我已付款',
            },
          },
          {
            type: 'button',
            action: {
              type: 'message',
              label: '主選單',
              text: '主選單',
            },
          },
        ],
      },
    },
  };
}

function buildGroupDispatchFlex(order) {
  return {
    type: 'flex',
    altText: `新任務 ${order.id}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: 'UBee｜新任務', weight: 'bold', size: 'xl' },
          { type: 'text', text: `訂單編號：${order.id}`, size: 'sm', color: '#666666' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: `費用：$${order.totalPrice}`, weight: 'bold', size: 'xxl' },
          { type: 'text', text: `可領：$${order.riderPay}`, size: 'lg', color: '#0B7285', weight: 'bold' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: `取件：${order.pickupAddress}`, wrap: true, size: 'sm' },
          { type: 'text', text: `送達：${order.dropoffAddress}`, wrap: true, size: 'sm' },
          { type: 'text', text: `任務內容：${order.item}`, wrap: true, size: 'sm' },
          { type: 'text', text: `距離：約 ${order.distanceKm.toFixed(1)} km`, size: 'sm' },
          { type: 'text', text: `時間：約 ${Math.ceil(order.durationMin)} 分鐘`, size: 'sm' },
          {
            type: 'text',
            text: order.isUrgent ? '類型：急件' : '類型：一般件',
            size: 'sm',
            color: order.isUrgent ? '#C92A2A' : '#2B8A3E',
            weight: 'bold',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            action: {
              type: 'postback',
              label: '我要接單',
              data: `action=rider_accept&orderId=${order.id}`,
              displayText: `我要接 ${order.id}`,
            },
          },
          {
            type: 'button',
            action: {
              type: 'postback',
              label: '查看導航',
              data: `action=view_nav_pickup&orderId=${order.id}`,
              displayText: `查看 ${order.id} 導航`,
            },
          },
        ],
      },
    },
  };
}

function buildRiderActionButtons(order) {
  return {
    type: 'template',
    altText: `任務操作 ${order.id}`,
    template: {
      type: 'buttons',
      title: 'UBee｜任務操作',
      text: `訂單 ${order.id}`,
      actions: [
        {
          type: 'postback',
          label: '設定 ETA',
          data: `action=set_eta_prompt&orderId=${order.id}`,
          displayText: `設定 ${order.id} ETA`,
        },
        {
          type: 'uri',
          label: '導航去取件',
          uri: buildNavigationUrl(order.pickupAddress),
        },
        {
          type: 'postback',
          label: '已取件',
          data: `action=pickup_done&orderId=${order.id}`,
          displayText: `訂單 ${order.id} 已取件`,
        },
        {
          type: 'postback',
          label: '已送達',
          data: `action=delivered_done&orderId=${order.id}`,
          displayText: `訂單 ${order.id} 已送達`,
        },
      ],
    },
  };
}

async function replyText(replyToken, text) {
  return client.replyMessage(replyToken, {
    type: 'text',
    text,
  });
}

async function pushText(to, text) {
  if (!to) return;
  return client.pushMessage(to, {
    type: 'text',
    text,
  });
}

async function pushMulti(to, messages) {
  if (!to || !messages || !messages.length) return;
  return client.pushMessage(to, messages);
}

async function sendMainMenu(replyToken) {
  return client.replyMessage(replyToken, [buildMainMenuFlex()]);
}

async function dispatchOrderToGroup(order) {
  if (!LINE_GROUP_ID) {
    console.warn('⚠️ 未設定 LINE_GROUP_ID，略過群組派單');
    return;
  }

  order.status = 'WAITING_RIDER';
  order.dispatchedAt = new Date().toISOString();

  await pushMulti(LINE_GROUP_ID, [
    buildGroupDispatchFlex(order),
  ]);
}

async function notifyCustomerOrderCreated(order) {
  await pushMulti(order.userId, [
    {
      type: 'text',
      text:
        `✅ 任務建立成功\n` +
        `訂單編號：${order.id}\n` +
        `費用：$${order.totalPrice}\n` +
        `請先完成付款，系統確認後會自動派單。`,
    },
    buildCustomerPaymentFlex(order),
  ]);
}

async function markPaymentConfirmed(order) {
  if (order.paymentStatus === 'PAID') {
    return;
  }

  order.paymentStatus = 'PAID';
  order.paidAt = new Date().toISOString();
  order.status = 'PAID_WAITING_DISPATCH';

  await pushText(
    order.userId,
    `✅ 已確認收到付款\n訂單編號：${order.id}\n系統正在為您派單中……`
  );

  await dispatchOrderToGroup(order);
}

function ensureOrderExists(orderId) {
  return orders[orderId];
}

function ensureRiderAuthorized(order, userId) {
  return order.riderUserId && order.riderUserId === userId;
}

function parsePostbackData(data = '') {
  return Object.fromEntries(
    data.split('&').map((pair) => {
      const [k, v] = pair.split('=');
      return [k, v];
    })
  );
}

// =========================
// 使用者流程
// =========================
async function startQuickQuote(userId, replyToken) {
  userSessions[userId] = {
    mode: 'QUOTE',
    step: 'pickup',
    data: {},
  };

  await replyText(replyToken, '請輸入取件地址');
}

async function startCreateOrder(userId, replyToken) {
  userSessions[userId] = {
    mode: 'CREATE_ORDER',
    step: 'pickup',
    data: {},
  };

  await replyText(replyToken, '請輸入取件地址');
}

async function handleTextMessage(event) {
  const userId = event.source.userId;
  const text = sanitizeText(event.message.text);
  const replyToken = event.replyToken;

  if (!userId) {
    await replyText(replyToken, '此功能需於個人聊天中使用');
    return;
  }

  if (text === '主選單') {
    resetUserSession(userId);
    delete pendingEtaInput[userId];
    delete pendingPaymentCodeInput[userId];
    await sendMainMenu(replyToken);
    return;
  }

  if (text === '企業服務介紹') {
    await replyText(
      replyToken,
      'UBee 提供企業專屬城市任務服務，適用於文件急送、樣品遞送、臨時行政支援、同城快速送達與月結合作。'
    );
    return;
  }

  if (text === '服務說明') {
    await replyText(
      replyToken,
      'UBee 為城市任務服務，主打文件、樣品、商務物件與臨時任務支援；目前不承接餐飲、生鮮與危險物品。'
    );
    return;
  }

  if (pendingEtaInput[userId]) {
    const { orderId } = pendingEtaInput[userId];
    const order = ensureOrderExists(orderId);

    if (!order) {
      delete pendingEtaInput[userId];
      await replyText(replyToken, '找不到此訂單');
      return;
    }

    if (!ensureRiderAuthorized(order, userId)) {
      delete pendingEtaInput[userId];
      await replyText(replyToken, '你無權操作此訂單 ETA');
      return;
    }

    const eta = parseInt(text, 10);
    if (Number.isNaN(eta) || eta <= 0 || eta > 999) {
      await replyText(replyToken, '請輸入正確分鐘數，例如：20');
      return;
    }

    order.etaMin = eta;
    order.status = 'RIDER_EN_ROUTE_PICKUP';
    order.etaSetAt = new Date().toISOString();

    delete pendingEtaInput[userId];

    await replyText(replyToken, `✅ 已設定 ETA：預計 ${eta} 分鐘抵達取件地點`);

    await pushText(
      order.userId,
      `✅ 已有騎手接單\n接單人員：${order.riderName || '騎手'}\n預計 ${eta} 分鐘抵達取件地點`
    );

    await pushText(
      LINE_GROUP_ID,
      `✅ 任務已接單\n訂單：${order.id}\n接單人員：${order.riderName || '騎手'}\nETA：${eta} 分鐘`
    );
    return;
  }

  if (pendingPaymentCodeInput[userId]) {
    const { orderId } = pendingPaymentCodeInput[userId];
    const order = ensureOrderExists(orderId);

    if (!order) {
      delete pendingPaymentCodeInput[userId];
      await replyText(replyToken, '找不到此訂單');
      return;
    }

    if (order.userId !== userId) {
      delete pendingPaymentCodeInput[userId];
      await replyText(replyToken, '你無法驗證此訂單');
      return;
    }

    if (order.paymentStatus === 'PAID') {
      delete pendingPaymentCodeInput[userId];
      await replyText(replyToken, '此訂單已完成付款確認');
      return;
    }

    if (text.toUpperCase() !== order.paymentCode) {
      await replyText(replyToken, '❌ 驗證碼不正確，請重新輸入');
      return;
    }

    delete pendingPaymentCodeInput[userId];
    await replyText(replyToken, '✅ 驗證成功，系統將自動派單');
    await markPaymentConfirmed(order);
    return;
  }

  const session = getUserSession(userId);

  if (!session.mode) {
    if (text === '下單') {
      await client.replyMessage(replyToken, buildOrderMenuButtons());
      return;
    }
    if (text === '企業') {
      await client.replyMessage(replyToken, buildBusinessMenuButtons());
      return;
    }
    if (text === '我的') {
      await client.replyMessage(replyToken, buildMyMenuButtons());
      return;
    }

    await sendMainMenu(replyToken);
    return;
  }

  if (session.mode === 'QUOTE') {
    if (session.step === 'pickup') {
      session.data.pickupAddress = text;
      session.step = 'dropoff';
      await replyText(replyToken, '請輸入送達地址');
      return;
    }

    if (session.step === 'dropoff') {
      session.data.dropoffAddress = text;
      session.step = 'urgent';
      await replyText(replyToken, '是否為急件？請輸入：是 / 否');
      return;
    }

    if (session.step === 'urgent') {
      session.data.isUrgent = text === '是';

      try {
        const route = await getDistanceAndDuration(
          session.data.pickupAddress,
          session.data.dropoffAddress
        );

        const price = calcPrice({
          distanceKm: route.distanceKm,
          durationMin: route.durationMin,
          pickupAddress: session.data.pickupAddress,
          dropoffAddress: session.data.dropoffAddress,
          isUrgent: session.data.isUrgent,
          now: new Date(),
        });

        resetUserSession(userId);

        await client.replyMessage(replyToken, buildQuoteFlex({
          pickupAddress: session.data.pickupAddress,
          dropoffAddress: session.data.dropoffAddress,
          distanceKm: route.distanceKm,
          durationMin: route.durationMin,
          totalPrice: price.total,
          feeItems: price.feeItems,
        }));
        return;
      } catch (err) {
        console.error(err);
        resetUserSession(userId);
        await replyText(replyToken, `❌ 估價失敗：${err.message}`);
        return;
      }
    }
  }

  if (session.mode === 'CREATE_ORDER') {
    if (session.step === 'pickup') {
      session.data.pickupAddress = text;
      session.step = 'dropoff';
      await replyText(replyToken, '請輸入送達地址');
      return;
    }

    if (session.step === 'dropoff') {
      session.data.dropoffAddress = text;
      session.step = 'item';
      await replyText(replyToken, '請輸入任務內容 / 物品內容');
      return;
    }

    if (session.step === 'item') {
      session.data.item = text;
      session.step = 'urgent';
      await replyText(replyToken, '是否為急件？請輸入：是 / 否');
      return;
    }

    if (session.step === 'urgent') {
      session.data.isUrgent = text === '是';

      try {
        const route = await getDistanceAndDuration(
          session.data.pickupAddress,
          session.data.dropoffAddress
        );

        const price = calcPrice({
          distanceKm: route.distanceKm,
          durationMin: route.durationMin,
          pickupAddress: session.data.pickupAddress,
          dropoffAddress: session.data.dropoffAddress,
          isUrgent: session.data.isUrgent,
          now: new Date(),
        });

        const orderId = createOrderId();
        const paymentCode = generatePaymentCode(PAYMENT_CODE_LENGTH);
        const riderPay = calcRiderPay(price.total);

        orders[orderId] = {
          id: orderId,
          userId,
          pickupAddress: session.data.pickupAddress,
          dropoffAddress: session.data.dropoffAddress,
          item: session.data.item,
          isUrgent: session.data.isUrgent,
          distanceKm: route.distanceKm,
          durationMin: route.durationMin,
          totalPrice: price.total,
          feeItems: price.feeItems,
          riderPay,
          paymentCode,
          paymentStatus: 'UNPAID',
          status: 'WAITING_PAYMENT',
          riderUserId: '',
          riderName: '',
          etaMin: null,
          createdAt: new Date().toISOString(),
        };
if (db) {
  await db.collection('orders').doc(orderId).set({
    orderId,
    userId,
    pickup: session.data.pickupAddress,
    dropoff: session.data.dropoffAddress,
    item: session.data.item,
    isUrgent: session.data.isUrgent,
    totalFee: price.total,
    status: 'pending',
    createdAt: new Date()
  });
}
        resetUserSession(userId);

        await replyText(
          replyToken,
          `✅ 任務已建立\n訂單編號：${orderId}\n費用：$${price.total}`
        );

        await notifyCustomerOrderCreated(orders[orderId]);
        return;
      } catch (err) {
        console.error(err);
        resetUserSession(userId);
        await replyText(replyToken, `❌ 建立任務失敗：${err.message}`);
        return;
      }
    }
  }

  resetUserSession(userId);
  await sendMainMenu(replyToken);
}

async function handlePostback(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const postback = parsePostbackData(event.postback.data || '');
  const action = postback.action;

  if (!userId) {
    await replyText(replyToken, '此功能需於個人聊天中使用');
    return;
  }

  if (action === 'menu_order') {
    await client.replyMessage(replyToken, buildOrderMenuButtons());
    return;
  }

  if (action === 'menu_business') {
    await client.replyMessage(replyToken, buildBusinessMenuButtons());
    return;
  }

  if (action === 'menu_my') {
    await client.replyMessage(replyToken, buildMyMenuButtons());
    return;
  }

  if (action === 'quick_quote_start') {
    await startQuickQuote(userId, replyToken);
    return;
  }

  if (action === 'create_order_start') {
    await startCreateOrder(userId, replyToken);
    return;
  }

  if (action === 'paid_click') {
    const order = ensureOrderExists(postback.orderId);
    if (!order) {
      await replyText(replyToken, '找不到此訂單');
      return;
    }

    if (order.userId !== userId) {
      await replyText(replyToken, '你無法操作此訂單');
      return;
    }

    if (order.paymentStatus === 'PAID') {
      await replyText(replyToken, '此訂單已確認付款');
      return;
    }

    if (PAYMENT_VERIFY_MODE === 'CODE') {
      pendingPaymentCodeInput[userId] = { orderId: order.id };
      await replyText(
        replyToken,
        `請輸入付款驗證碼\n訂單：${order.id}\n驗證碼長度：${PAYMENT_CODE_LENGTH} 碼`
      );
      return;
    }

    await replyText(replyToken, '✅ 系統收到付款通知，正在派單中');
    await markPaymentConfirmed(order);
    return;
  }

  if (action === 'rider_accept') {
    const order = ensureOrderExists(postback.orderId);
    if (!order) {
      await replyText(replyToken, '找不到此訂單');
      return;
    }

    if (order.paymentStatus !== 'PAID') {
      await replyText(replyToken, '此訂單尚未完成付款，暫不可接單');
      return;
    }

    if (order.riderUserId) {
      await replyText(replyToken, '❌ 此訂單已被其他騎手接走');
      return;
    }

    const riderName =
      event.source.type === 'user'
        ? (await client.getProfile(userId).catch(() => null))?.displayName || '騎手'
        : '騎手';

    order.riderUserId = userId;
    order.riderName = riderName;
    order.status = 'RIDER_ACCEPTED';
    order.acceptedAt = new Date().toISOString();

    await client.replyMessage(replyToken, [
      {
        type: 'text',
        text:
          `✅ 接單成功\n` +
          `訂單：${order.id}\n` +
          `可領：$${order.riderPay}\n` +
          `請先設定 ETA`,
      },
      buildRiderActionButtons(order),
    ]);

    await pushText(
      order.userId,
      `✅ 已有騎手接單\n接單人員：${order.riderName}\n系統將通知預計抵達時間`
    );
    return;
  }

  if (action === 'set_eta_prompt') {
    const order = ensureOrderExists(postback.orderId);
    if (!order) {
      await replyText(replyToken, '找不到此訂單');
      return;
    }

    if (!ensureRiderAuthorized(order, userId)) {
      await replyText(replyToken, '你無權操作此訂單');
      return;
    }

    pendingEtaInput[userId] = { orderId: order.id };
    await replyText(replyToken, '請直接輸入 ETA 分鐘數，例如：20');
    return;
  }

  if (action === 'view_nav_pickup') {
    const order = ensureOrderExists(postback.orderId);
    if (!order) {
      await replyText(replyToken, '找不到此訂單');
      return;
    }

    await replyText(
      replyToken,
      `取件導航：\n${buildNavigationUrl(order.pickupAddress)}`
    );
    return;
  }

  if (action === 'pickup_done') {
    const order = ensureOrderExists(postback.orderId);
    if (!order) {
      await replyText(replyToken, '找不到此訂單');
      return;
    }

    if (!ensureRiderAuthorized(order, userId)) {
      await replyText(replyToken, '你無權操作此訂單');
      return;
    }

    order.status = 'PICKED_UP';
    order.pickedUpAt = new Date().toISOString();

    await replyText(replyToken, `✅ 已標記取件完成\n訂單：${order.id}`);

    await pushText(
      order.userId,
      `✅ 騎手已完成取件\n訂單：${order.id}\n物品正前往送達地點`
    );
    return;
  }

  if (action === 'delivered_done') {
    const order = ensureOrderExists(postback.orderId);
    if (!order) {
      await replyText(replyToken, '找不到此訂單');
      return;
    }

    if (!ensureRiderAuthorized(order, userId)) {
      await replyText(replyToken, '你無權操作此訂單');
      return;
    }

    order.status = 'DELIVERED';
    order.deliveredAt = new Date().toISOString();

    await replyText(replyToken, `✅ 已標記送達完成\n訂單：${order.id}`);

    await pushText(
      order.userId,
      `✅ 任務已完成\n訂單：${order.id}\n感謝使用 UBee 城市任務服務`
    );

    if (LINE_FINISH_GROUP_ID) {
      await pushText(
        LINE_FINISH_GROUP_ID,
        `✅ 任務完成\n訂單：${order.id}\n接單人員：${order.riderName}\n費用：$${order.totalPrice}\n騎手可領：$${order.riderPay}`
      );
    }

    await pushText(
      LINE_GROUP_ID,
      `✅ 任務已完成\n訂單：${order.id}\n接單人員：${order.riderName}`
    );
    return;
  }

  await replyText(replyToken, '未識別操作');
}

// =========================
// LINE webhook
// =========================
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(
      req.body.events.map(async (event) => {
        if (event.type === 'message' && event.message.type === 'text') {
          await handleTextMessage(event);
        } else if (event.type === 'postback') {
          await handlePostback(event);
        }
      })
    );
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(500).send('Error');
  }
});

// =========================
// 健康檢查
// =========================
app.get('/', (req, res) => {
  res.send('UBee OMS V3.8.7 PRO MAX is running');
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

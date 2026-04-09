require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

const app = express();

// =========================
// Firebase 初始化
// =========================
let db = null;

try {
  if (process.env.FIREBASE_KEY) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }

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

function generatePaymentCode(length = 5) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function sanitizeText(text = '') {
  return String(text).trim();
}

function parseDistrict(address = '') {
  const match = address.match(
    /(豐原區|潭子區|神岡區|大雅區|北屯區|西屯區|西區|南屯區|南區|北區|東區|中區|太平區|大里區|烏日區|霧峰區|后里區|石岡區|新社區|和平區|大甲區|外埔區|清水區|沙鹿區|龍井區|梧棲區|大肚區)/
  );
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

function formatTaskType(order) {
  return order.isUrgent ? '急件' : '一般件';
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

function buildNavigationUrl(address) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}&travelmode=driving`;
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

function getFeeBreakdown(order) {
  const distanceKm = Number(order.distanceKm || 0);
  const durationMin = Number(order.durationMin || 0);

  const baseIncome =
    BASE_FEE +
    Math.ceil(distanceKm) * PRICE_PER_KM +
    Math.ceil(durationMin) * PRICE_PER_MIN;

  const urgentFee = order.isUrgent ? URGENT_FEE : 0;
  const crossDistrictFee = isCrossDistrict(order.pickupAddress, order.dropoffAddress)
    ? CROSS_DISTRICT_FEE
    : 0;
  const nightFee =
    order.createdAt && isNightTime(new Date(order.createdAt)) ? NIGHT_FEE : 0;

  const serviceFee = SERVICE_FEE;
  const extraFeeTotal = urgentFee + crossDistrictFee + nightFee + serviceFee;
  const platformIncome = Math.max((order.totalPrice || 0) - (order.riderPay || 0), 0);

  return {
    baseIncome,
    urgentFee,
    crossDistrictFee,
    nightFee,
    serviceFee,
    extraFeeTotal,
    platformIncome,
  };
}

async function syncOrderToFirebase(orderId, payload) {
  if (!db) return;
  await db.collection('orders').doc(orderId).set(payload, { merge: true });
}

// =========================
// Flex / Template UI
// =========================
function buildMainMenuFlex() {
  return {
    type: 'flex',
    altText: 'UBee 主選單',
    contents: {
      type: 'bubble',
      hero: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '20px',
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

function buildOrderMenuFlex() {
  return {
    type: 'flex',
    altText: '下單選單',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: 'UBee｜下單',
            weight: 'bold',
            size: 'xl',
            color: '#F7C948',
          },
          {
            type: 'text',
            text: '請選擇服務項目',
            size: 'sm',
            color: '#FFFFFF',
            margin: 'sm',
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
            action: {
              type: 'postback',
              label: '建立任務',
              data: 'action=create_order_start',
              displayText: '建立任務',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: '立即估價',
              data: 'action=quick_quote_start',
              displayText: '立即估價',
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

function buildBusinessMenuFlex() {
  return {
    type: 'flex',
    altText: '企業選單',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: 'UBee｜企業',
            weight: 'bold',
            size: 'xl',
            color: '#F7C948',
          },
          {
            type: 'text',
            text: '企業合作與月結服務',
            size: 'sm',
            color: '#FFFFFF',
            margin: 'sm',
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
            action: {
              type: 'uri',
              label: '企業合作表單',
              uri:
                'https://docs.google.com/forms/d/e/1FAIpQLScn9AGnp4FbTGg6fZt5fpiMdNEi-yL9x595bTyVFHAoJmpYlA/viewform',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'message',
              label: '企業服務介紹',
              text: '企業服務介紹',
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

function buildMyMenuFlex() {
  return {
    type: 'flex',
    altText: '我的選單',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: 'UBee｜我的',
            weight: 'bold',
            size: 'xl',
            color: '#F7C948',
          },
          {
            type: 'text',
            text: '會員與服務資訊',
            size: 'sm',
            color: '#FFFFFF',
            margin: 'sm',
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
            action: {
              type: 'uri',
              label: '合作夥伴申請',
              uri:
                'https://docs.google.com/forms/d/e/1FAIpQLSc2qdklWuSSPw39vjfrXEakBHTI3TM_NgqMxWLAZg0ej6zvMA/viewform',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'message',
              label: '服務說明',
              text: '服務說明',
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

function buildInfoFlex(title, lines = []) {
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: title,
            weight: 'bold',
            size: 'xl',
            color: '#F7C948',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: lines.map((line) => ({
          type: 'text',
          text: line,
          wrap: true,
          size: 'sm',
          color: '#333333',
        })),
      },
    },
  };
}

function buildPromptFlex(title, desc) {
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: title,
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'text',
            text: desc,
            wrap: true,
            size: 'sm',
            color: '#666666',
          },
        ],
      },
    },
  };
}

function buildQuoteFlex(result) {
  return {
    type: 'flex',
    altText: '估價結果',
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
            text: '立即估價',
            color: '#FFFFFF',
            size: 'md',
            margin: 'md',
            weight: 'bold',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
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
            type: 'separator',
            margin: 'md',
          },
          {
            type: 'text',
            text: `費用：$${result.totalPrice}`,
            weight: 'bold',
            size: 'xxl',
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

function buildOrderCreatedFlex(order) {
  return {
    type: 'flex',
    altText: '任務建立成功',
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
            text: '任務建立成功',
            color: '#FFFFFF',
            size: 'md',
            margin: 'md',
            weight: 'bold',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: `訂單編號：${order.id}`,
            size: 'sm',
            color: '#666666',
          },
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: `取件：${order.pickupAddress}`,
            wrap: true,
            size: 'sm',
          },
          {
            type: 'text',
            text: `送達：${order.dropoffAddress}`,
            wrap: true,
            size: 'sm',
          },
          {
            type: 'text',
            text: `任務內容：${order.item}`,
            wrap: true,
            size: 'sm',
          },
          {
            type: 'text',
            text: `類型：${formatTaskType(order)}`,
            size: 'sm',
            weight: 'bold',
            color: order.isUrgent ? '#C92A2A' : '#2B8A3E',
          },
          {
            type: 'text',
            text: `距離：約 ${order.distanceKm.toFixed(1)} km`,
            size: 'sm',
          },
          {
            type: 'text',
            text: `時間：約 ${Math.ceil(order.durationMin)} 分鐘`,
            size: 'sm',
          },
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: `費用：$${order.totalPrice}`,
            weight: 'bold',
            size: 'xxl',
          },
          {
            type: 'text',
            text: '請先完成付款，系統確認後會自動派單。',
            wrap: true,
            size: 'sm',
            color: '#666666',
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
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: 'UBee｜付款資訊',
            color: '#F7C948',
            weight: 'bold',
            size: 'xl',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: `訂單編號：${order.id}`, size: 'sm' },
          { type: 'text', text: `費用：$${order.totalPrice}`, weight: 'bold', size: 'xl' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: PAYMENT_JKO_INFO, wrap: true, size: 'sm' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: PAYMENT_BANK_INFO, wrap: true, size: 'sm' },
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text:
              PAYMENT_VERIFY_MODE === 'CODE'
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
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: 'UBee｜新任務',
            color: '#F7C948',
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'text',
            text: `訂單編號：${order.id}`,
            color: '#FFFFFF',
            size: 'sm',
            margin: 'sm',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: `本單可領：$${order.riderPay}`,
            weight: 'bold',
            size: 'xxl',
            color: '#0B7285',
          },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: `取件：${order.pickupAddress}`, wrap: true, size: 'sm' },
          { type: 'text', text: `送達：${order.dropoffAddress}`, wrap: true, size: 'sm' },
          { type: 'text', text: `任務內容：${order.item}`, wrap: true, size: 'sm' },
          {
            type: 'text',
            text: `類型：${formatTaskType(order)}`,
            size: 'sm',
            color: order.isUrgent ? '#C92A2A' : '#2B8A3E',
            weight: 'bold',
          },
          {
            type: 'text',
            text: `距離：約 ${Number(order.distanceKm || 0).toFixed(1)} km`,
            size: 'sm',
          },
          {
            type: 'text',
            text: `時間：約 ${Math.ceil(Number(order.durationMin || 0))} 分鐘`,
            size: 'sm',
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
              label: '接受訂單',
              data: `action=rider_accept&orderId=${order.id}`,
              displayText: `接受訂單 ${order.id}`,
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: '放棄任務',
              data: `action=abandon_order&orderId=${order.id}`,
              displayText: `放棄任務 ${order.id}`,
            },
          },
        ],
      },
    },
  };
}

function buildRiderActionFlex(order) {
  return {
    type: 'flex',
    altText: `任務操作 ${order.id}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: 'UBee｜任務操作',
            color: '#F7C948',
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'text',
            text: `訂單 ${order.id}`,
            color: '#FFFFFF',
            size: 'sm',
            margin: 'sm',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            action: {
              type: 'postback',
              label: '設定 ETA',
              data: `action=set_eta_prompt&orderId=${order.id}`,
              displayText: `設定 ${order.id} ETA`,
            },
          },
          {
            type: 'button',
            action: {
              type: 'uri',
              label: '導航去取件',
              uri: buildNavigationUrl(order.pickupAddress),
            },
          },
          {
            type: 'button',
            action: {
              type: 'postback',
              label: '已取件',
              data: `action=pickup_done&orderId=${order.id}`,
              displayText: `訂單 ${order.id} 已取件`,
            },
          },
          {
            type: 'button',
            action: {
              type: 'postback',
              label: '已送達',
              data: `action=delivered_done&orderId=${order.id}`,
              displayText: `訂單 ${order.id} 已送達`,
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: '放棄任務',
              data: `action=abandon_order&orderId=${order.id}`,
              displayText: `放棄任務 ${order.id}`,
            },
          },
        ],
      },
    },
  };
}

function buildRiderAcceptedFlex(order) {
  return {
    type: 'flex',
    altText: '接單成功',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '✅ 接單成功', weight: 'bold', size: 'xl' },
          { type: 'text', text: `訂單：${order.id}`, size: 'sm' },
          { type: 'text', text: `本單可領：$${order.riderPay}`, weight: 'bold', size: 'xl' },
          {
            type: 'text',
            text: '請先設定 ETA，再前往取件。',
            wrap: true,
            size: 'sm',
            color: '#666666',
          },
        ],
      },
    },
  };
}

function buildEtaSetFlex(order) {
  return {
    type: 'flex',
    altText: 'ETA 已設定',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '✅ ETA 已設定', weight: 'bold', size: 'xl' },
          { type: 'text', text: `訂單：${order.id}`, size: 'sm' },
          { type: 'text', text: `預計 ${order.etaMin} 分鐘抵達取件地點`, wrap: true, size: 'md' },
        ],
      },
    },
  };
}

function buildPickupDoneFlex(order) {
  return {
    type: 'flex',
    altText: '取件完成',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '✅ 已完成取件', weight: 'bold', size: 'xl' },
          { type: 'text', text: `訂單：${order.id}`, size: 'sm' },
          { type: 'text', text: '物品正前往送達地點', wrap: true, size: 'sm', color: '#666666' },
        ],
      },
    },
  };
}

function buildDeliveredFlex(order) {
  return {
    type: 'flex',
    altText: '任務完成',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '✅ 任務已完成', weight: 'bold', size: 'xl' },
          { type: 'text', text: `訂單：${order.id}`, size: 'sm' },
          { type: 'text', text: '感謝使用 UBee 城市任務服務', wrap: true, size: 'sm', color: '#666666' },
        ],
      },
    },
  };
}

function buildAbandonSuccessFlex(orderId) {
  return {
    type: 'flex',
    altText: '已放棄任務',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '⚠️ 已放棄任務', weight: 'bold', size: 'xl' },
          { type: 'text', text: `訂單：${orderId}`, size: 'sm' },
          { type: 'text', text: '系統將重新釋出任務。', size: 'sm', color: '#666666' },
        ],
      },
    },
  };
}

function buildSkipOrderFlex(orderId) {
  return {
    type: 'flex',
    altText: '已略過任務',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '已略過任務', weight: 'bold', size: 'xl' },
          { type: 'text', text: `訂單：${orderId}`, size: 'sm' },
          { type: 'text', text: '此操作不會影響訂單狀態。', size: 'sm', color: '#666666' },
        ],
      },
    },
  };
}

function buildSimpleResultFlex(title, bodyText) {
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'xl' },
          { type: 'text', text: bodyText, wrap: true, size: 'sm', color: '#666666' },
        ],
      },
    },
  };
}

function buildFinishGroupFinanceFlex(order) {
  const fee = getFeeBreakdown(order);

  return {
    type: 'flex',
    altText: `財務明細 ${order.id}`,
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '20px',
        contents: [
          {
            type: 'text',
            text: '💰 財務明細',
            color: '#F7C948',
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'text',
            text: `訂單編號：${order.id}`,
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
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#EAE4D3',
            cornerRadius: '12px',
            paddingAll: '14px',
            contents: [
              {
                type: 'text',
                text: `客戶支付：$${order.totalPrice || 0}`,
                weight: 'bold',
                size: 'xl',
                color: '#111111',
              },
            ],
          },

          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '取件地址', size: 'sm', color: '#777777', flex: 3 },
              { type: 'text', text: order.pickupAddress || '-', size: 'sm', wrap: true, flex: 7 },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '送達地址', size: 'sm', color: '#777777', flex: 3 },
              { type: 'text', text: order.dropoffAddress || '-', size: 'sm', wrap: true, flex: 7 },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '物品內容', size: 'sm', color: '#777777', flex: 3 },
              { type: 'text', text: order.item || '-', size: 'sm', wrap: true, flex: 7 },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '任務類型', size: 'sm', color: '#777777', flex: 3 },
              { type: 'text', text: formatTaskType(order), size: 'sm', flex: 7 },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '距離', size: 'sm', color: '#777777', flex: 3 },
              {
                type: 'text',
                text: `${Number(order.distanceKm || 0).toFixed(1)} 公里`,
                size: 'sm',
                flex: 7,
              },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '時間', size: 'sm', color: '#777777', flex: 3 },
              {
                type: 'text',
                text: `${Math.ceil(Number(order.durationMin || 0))} 分鐘`,
                size: 'sm',
                flex: 7,
              },
            ],
          },

          { type: 'separator', margin: 'md' },

          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '騎手收入', size: 'md', color: '#333333', flex: 6 },
              {
                type: 'text',
                text: `$${order.riderPay || 0}`,
                size: 'md',
                weight: 'bold',
                align: 'end',
                flex: 4,
              },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '平台收入', size: 'md', color: '#333333', flex: 6 },
              {
                type: 'text',
                text: `$${fee.platformIncome}`,
                size: 'md',
                weight: 'bold',
                align: 'end',
                flex: 4,
              },
            ],
          },

          { type: 'separator', margin: 'md' },

          {
            type: 'text',
            text: '附加費明細',
            weight: 'bold',
            size: 'md',
          },
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '急件費', size: 'sm', color: '#555555', flex: 6 },
              {
                type: 'text',
                text: `$${fee.urgentFee}`,
                size: 'sm',
                align: 'end',
                flex: 4,
              },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '跨區加成', size: 'sm', color: '#555555', flex: 6 },
              {
                type: 'text',
                text: `$${fee.crossDistrictFee}`,
                size: 'sm',
                align: 'end',
                flex: 4,
              },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '夜間加成', size: 'sm', color: '#555555', flex: 6 },
              {
                type: 'text',
                text: `$${fee.nightFee}`,
                size: 'sm',
                align: 'end',
                flex: 4,
              },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '服務費', size: 'sm', color: '#555555', flex: 6 },
              {
                type: 'text',
                text: `$${fee.serviceFee}`,
                size: 'sm',
                align: 'end',
                flex: 4,
              },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '附加費總額', size: 'sm', color: '#C92A2A', flex: 6 },
              {
                type: 'text',
                text: `$${fee.extraFeeTotal}`,
                size: 'sm',
                weight: 'bold',
                color: '#C92A2A',
                align: 'end',
                flex: 4,
              },
            ],
          },

          { type: 'separator', margin: 'md' },

          {
            type: 'text',
            text: '收入拆解',
            weight: 'bold',
            size: 'md',
          },
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '基礎收入', size: 'sm', color: '#555555', flex: 6 },
              {
                type: 'text',
                text: `$${fee.baseIncome}`,
                size: 'sm',
                align: 'end',
                flex: 4,
              },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '附加收入', size: 'sm', color: '#555555', flex: 6 },
              {
                type: 'text',
                text: `$${fee.extraFeeTotal}`,
                size: 'sm',
                align: 'end',
                flex: 4,
              },
            ],
          },
        ],
      },
    },
  };
}

// =========================
// 訊息工具
// =========================
async function replyFlex(replyToken, messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  return client.replyMessage(replyToken, arr);
}

async function replyText(replyToken, text) {
  return client.replyMessage(replyToken, {
    type: 'text',
    text,
  });
}

async function pushMulti(to, messages) {
  if (!to || !messages || !messages.length) return;
  return client.pushMessage(to, messages);
}

async function sendMainMenu(replyToken) {
  return replyFlex(replyToken, buildMainMenuFlex());
}

async function dispatchOrderToGroup(order) {
  if (!LINE_GROUP_ID) {
    console.warn('⚠️ 未設定 LINE_GROUP_ID，略過群組派單');
    return;
  }

  order.status = 'WAITING_RIDER';
  order.dispatchedAt = new Date().toISOString();

  await syncOrderToFirebase(order.id, {
    status: order.status,
    dispatchedAt: order.dispatchedAt,
  });

  await pushMulti(LINE_GROUP_ID, [buildGroupDispatchFlex(order)]);
}

async function markPaymentConfirmed(order) {
  if (order.paymentStatus === 'PAID') return;

  order.paymentStatus = 'PAID';
  order.paidAt = new Date().toISOString();
  order.status = 'PAID_WAITING_DISPATCH';

  await syncOrderToFirebase(order.id, {
    paymentStatus: order.paymentStatus,
    paidAt: order.paidAt,
    status: order.status,
  });

  await pushMulti(order.userId, [
    buildSimpleResultFlex(
      '✅ 已確認收到付款',
      `訂單編號：${order.id}\n系統正在為您派單中……`
    ),
  ]);

  await dispatchOrderToGroup(order);
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

  await replyFlex(replyToken, buildPromptFlex('立即估價', '請輸入取件地址'));
}

async function startCreateOrder(userId, replyToken) {
  userSessions[userId] = {
    mode: 'CREATE_ORDER',
    step: 'pickup',
    data: {},
  };

  await replyFlex(replyToken, buildPromptFlex('建立任務', '請輸入取件地址'));
}

async function handleTextMessage(event) {
  const userId = event.source.userId;
  const text = sanitizeText(event.message.text);
  const replyToken = event.replyToken;

  if (!userId) {
    await replyFlex(replyToken, buildSimpleResultFlex('提醒', '此功能需於個人聊天中使用'));
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
    await replyFlex(
      replyToken,
      buildInfoFlex('企業服務介紹', [
        'UBee 提供企業專屬城市任務服務。',
        '適用於文件急送、樣品遞送、臨時行政支援、同城快速送達與月結合作。',
      ])
    );
    return;
  }

  if (text === '服務說明') {
    await replyFlex(
      replyToken,
      buildInfoFlex('服務說明', [
        'UBee 為城市任務服務。',
        '主打文件、樣品、商務物件與臨時任務支援。',
        '目前不承接餐飲、生鮮與危險物品。',
      ])
    );
    return;
  }

  if (pendingEtaInput[userId]) {
    const { orderId } = pendingEtaInput[userId];
    const order = ensureOrderExists(orderId);

    if (!order) {
      delete pendingEtaInput[userId];
      await replyFlex(replyToken, buildSimpleResultFlex('找不到訂單', '請重新操作'));
      return;
    }

    if (!ensureRiderAuthorized(order, userId)) {
      delete pendingEtaInput[userId];
      await replyFlex(replyToken, buildSimpleResultFlex('無法操作', '你無權設定此訂單 ETA'));
      return;
    }

    const eta = parseInt(text, 10);
    if (Number.isNaN(eta) || eta <= 0 || eta > 999) {
      await replyFlex(replyToken, buildSimpleResultFlex('ETA 格式錯誤', '請輸入正確分鐘數，例如：20'));
      return;
    }

    order.etaMin = eta;
    order.status = 'RIDER_EN_ROUTE_PICKUP';
    order.etaSetAt = new Date().toISOString();

    await syncOrderToFirebase(order.id, {
      etaMin: order.etaMin,
      status: order.status,
      etaSetAt: order.etaSetAt,
    });

    delete pendingEtaInput[userId];

    await replyFlex(replyToken, buildEtaSetFlex(order));

    await pushMulti(order.userId, [
      buildSimpleResultFlex(
        '✅ 已有騎手接單',
        `接單人員：${order.riderName || '騎手'}\n預計 ${eta} 分鐘抵達取件地點`
      ),
    ]);

    await pushMulti(LINE_GROUP_ID, [
      buildSimpleResultFlex(
        '✅ 任務已接單',
        `訂單：${order.id}\n接單人員：${order.riderName || '騎手'}\nETA：${eta} 分鐘`
      ),
    ]);
    return;
  }

  if (pendingPaymentCodeInput[userId]) {
    const { orderId } = pendingPaymentCodeInput[userId];
    const order = ensureOrderExists(orderId);

    if (!order) {
      delete pendingPaymentCodeInput[userId];
      await replyFlex(replyToken, buildSimpleResultFlex('找不到訂單', '請重新操作'));
      return;
    }

    if (order.userId !== userId) {
      delete pendingPaymentCodeInput[userId];
      await replyFlex(replyToken, buildSimpleResultFlex('無法驗證', '你無法驗證此訂單'));
      return;
    }

    if (order.paymentStatus === 'PAID') {
      delete pendingPaymentCodeInput[userId];
      await replyFlex(replyToken, buildSimpleResultFlex('已完成付款確認', `訂單：${order.id}`));
      return;
    }

    if (text.toUpperCase() !== order.paymentCode) {
      await replyFlex(replyToken, buildSimpleResultFlex('❌ 驗證碼不正確', '請重新輸入付款驗證碼'));
      return;
    }

    delete pendingPaymentCodeInput[userId];
    await replyFlex(replyToken, buildSimpleResultFlex('✅ 驗證成功', '系統將自動派單'));
    await markPaymentConfirmed(order);
    return;
  }

  const session = getUserSession(userId);

  if (!session.mode) {
    if (text === '下單') {
      await replyFlex(replyToken, buildOrderMenuFlex());
      return;
    }
    if (text === '企業') {
      await replyFlex(replyToken, buildBusinessMenuFlex());
      return;
    }
    if (text === '我的') {
      await replyFlex(replyToken, buildMyMenuFlex());
      return;
    }

    await sendMainMenu(replyToken);
    return;
  }

  if (session.mode === 'QUOTE') {
    if (session.step === 'pickup') {
      session.data.pickupAddress = text;
      session.step = 'dropoff';
      await replyFlex(replyToken, buildPromptFlex('立即估價', '請輸入送達地址'));
      return;
    }

    if (session.step === 'dropoff') {
      session.data.dropoffAddress = text;
      session.step = 'urgent';
      await replyFlex(replyToken, buildPromptFlex('立即估價', '是否為急件？請輸入：是 / 否'));
      return;
    }

    if (session.step === 'urgent') {
      session.data.isUrgent = text === '是';

      try {
        const pickupAddress = session.data.pickupAddress;
        const dropoffAddress = session.data.dropoffAddress;
        const isUrgent = session.data.isUrgent;

        const route = await getDistanceAndDuration(pickupAddress, dropoffAddress);

        const price = calcPrice({
          distanceKm: route.distanceKm,
          durationMin: route.durationMin,
          pickupAddress,
          dropoffAddress,
          isUrgent,
          now: new Date(),
        });

        resetUserSession(userId);

        await replyFlex(
          replyToken,
          buildQuoteFlex({
            pickupAddress,
            dropoffAddress,
            distanceKm: route.distanceKm,
            durationMin: route.durationMin,
            totalPrice: price.total,
            feeItems: price.feeItems,
          })
        );
        return;
      } catch (err) {
        console.error(err);
        resetUserSession(userId);
        await replyFlex(replyToken, buildSimpleResultFlex('❌ 估價失敗', err.message));
        return;
      }
    }
  }

  if (session.mode === 'CREATE_ORDER') {
    if (session.step === 'pickup') {
      session.data.pickupAddress = text;
      session.step = 'dropoff';
      await replyFlex(replyToken, buildPromptFlex('建立任務', '請輸入送達地址'));
      return;
    }

    if (session.step === 'dropoff') {
      session.data.dropoffAddress = text;
      session.step = 'item';
      await replyFlex(replyToken, buildPromptFlex('建立任務', '請輸入任務內容 / 物品內容'));
      return;
    }

    if (session.step === 'item') {
      session.data.item = text;
      session.step = 'urgent';
      await replyFlex(replyToken, buildPromptFlex('建立任務', '是否為急件？請輸入：是 / 否'));
      return;
    }

    if (session.step === 'urgent') {
      session.data.isUrgent = text === '是';

      try {
        const pickupAddress = session.data.pickupAddress;
        const dropoffAddress = session.data.dropoffAddress;
        const item = session.data.item;
        const isUrgent = session.data.isUrgent;

        const route = await getDistanceAndDuration(pickupAddress, dropoffAddress);

        const price = calcPrice({
          distanceKm: route.distanceKm,
          durationMin: route.durationMin,
          pickupAddress,
          dropoffAddress,
          isUrgent,
          now: new Date(),
        });

        const orderId = createOrderId();
        const paymentCode = generatePaymentCode(PAYMENT_CODE_LENGTH);
        const riderPay = calcRiderPay(price.total);

        orders[orderId] = {
          id: orderId,
          userId,
          pickupAddress,
          dropoffAddress,
          item,
          isUrgent,
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

        await syncOrderToFirebase(orderId, {
          orderId,
          userId,
          pickupAddress,
          dropoffAddress,
          item,
          isUrgent,
          distanceKm: route.distanceKm,
          durationMin: route.durationMin,
          totalPrice: price.total,
          feeItems: price.feeItems,
          riderPay,
          paymentCode,
          paymentStatus: 'UNPAID',
          status: 'WAITING_PAYMENT',
          createdAt: new Date(),
        });

        const createdOrder = orders[orderId];
        resetUserSession(userId);

        await replyFlex(replyToken, [
          buildOrderCreatedFlex(createdOrder),
          buildCustomerPaymentFlex(createdOrder),
        ]);
        return;
      } catch (err) {
        console.error(err);
        resetUserSession(userId);
        await replyFlex(replyToken, buildSimpleResultFlex('❌ 建立任務失敗', err.message));
        return;
      }
    }
  }

  resetUserSession(userId);
  await sendMainMenu(replyToken);
}

// =========================
// Postback 流程
// =========================
async function handlePostback(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const postback = parsePostbackData(event.postback.data || '');
  const action = postback.action;

  if (!userId) {
    await replyFlex(replyToken, buildSimpleResultFlex('提醒', '此功能需於個人聊天中使用'));
    return;
  }

  if (action === 'menu_order') {
    await replyFlex(replyToken, buildOrderMenuFlex());
    return;
  }

  if (action === 'menu_business') {
    await replyFlex(replyToken, buildBusinessMenuFlex());
    return;
  }

  if (action === 'menu_my') {
    await replyFlex(replyToken, buildMyMenuFlex());
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
      await replyFlex(replyToken, buildSimpleResultFlex('找不到訂單', '請重新操作'));
      return;
    }

    if (order.userId !== userId) {
      await replyFlex(replyToken, buildSimpleResultFlex('無法操作', '你無法操作此訂單'));
      return;
    }

    if (order.paymentStatus === 'PAID') {
      await replyFlex(replyToken, buildSimpleResultFlex('已確認付款', `訂單：${order.id}`));
      return;
    }

    if (PAYMENT_VERIFY_MODE === 'CODE') {
      pendingPaymentCodeInput[userId] = { orderId: order.id };
      await replyFlex(
        replyToken,
        buildPromptFlex(
          '付款驗證',
          `請輸入付款驗證碼\n訂單：${order.id}\n驗證碼長度：${PAYMENT_CODE_LENGTH} 碼`
        )
      );
      return;
    }

    await replyFlex(replyToken, buildSimpleResultFlex('✅ 系統收到付款通知', '正在派單中'));
    await markPaymentConfirmed(order);
    return;
  }

  if (action === 'rider_accept') {
    const order = ensureOrderExists(postback.orderId);
    if (!order) {
      await replyFlex(replyToken, buildSimpleResultFlex('找不到訂單', '請重新操作'));
      return;
    }

    if (order.paymentStatus !== 'PAID') {
      await replyFlex(replyToken, buildSimpleResultFlex('尚未完成付款', '此訂單暫不可接單'));
      return;
    }

    if (order.riderUserId) {
      await replyFlex(replyToken, buildSimpleResultFlex('❌ 已被接走', '此訂單已被其他騎手接單'));
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

    await syncOrderToFirebase(order.id, {
      riderUserId: order.riderUserId,
      riderName: order.riderName,
      status: order.status,
      acceptedAt: order.acceptedAt,
    });

    await replyFlex(replyToken, [buildRiderAcceptedFlex(order), buildRiderActionFlex(order)]);

    await pushMulti(order.userId, [
      buildSimpleResultFlex(
        '✅ 已有騎手接單',
        `接單人員：${order.riderName}\n系統將通知預計抵達時間`
      ),
    ]);
    return;
  }

  if (action === 'abandon_order') {
    const order = ensureOrderExists(postback.orderId);
    if (!order) {
      await replyFlex(replyToken, buildSimpleResultFlex('找不到訂單', '請重新操作'));
      return;
    }

    if (!order.riderUserId) {
      await replyFlex(replyToken, buildSkipOrderFlex(order.id));
      return;
    }

    if (!ensureRiderAuthorized(order, userId)) {
      await replyFlex(replyToken, buildSimpleResultFlex('無法操作', '你無權放棄此訂單'));
      return;
    }

    if (order.status === 'PICKED_UP' || order.status === 'DELIVERED') {
      await replyFlex(replyToken, buildSimpleResultFlex('無法放棄', '此訂單目前不可放棄'));
      return;
    }

    const oldRiderName = order.riderName || '騎手';

    order.riderUserId = '';
    order.riderName = '';
    order.etaMin = null;
    order.status = 'WAITING_RIDER';
    order.abandonedAt = new Date().toISOString();

    await syncOrderToFirebase(order.id, {
      riderUserId: '',
      riderName: '',
      etaMin: null,
      status: order.status,
      abandonedAt: order.abandonedAt,
    });

    await replyFlex(replyToken, buildAbandonSuccessFlex(order.id));

    await pushMulti(order.userId, [
      buildSimpleResultFlex(
        '⚠️ 騎手已放棄任務',
        `訂單：${order.id}\n原接單人員：${oldRiderName}\n系統將重新為您配對騎手`
      ),
    ]);

    if (LINE_GROUP_ID) {
      await pushMulti(LINE_GROUP_ID, [
        buildSimpleResultFlex(
          '⚠️ 任務重新釋出',
          `訂單：${order.id}\n原接單人員：${oldRiderName}`
        ),
        buildGroupDispatchFlex(order),
      ]);
    }
    return;
  }

  if (action === 'set_eta_prompt') {
    const order = ensureOrderExists(postback.orderId);
    if (!order) {
      await replyFlex(replyToken, buildSimpleResultFlex('找不到訂單', '請重新操作'));
      return;
    }

    if (!ensureRiderAuthorized(order, userId)) {
      await replyFlex(replyToken, buildSimpleResultFlex('無法操作', '你無權操作此訂單'));
      return;
    }

    pendingEtaInput[userId] = { orderId: order.id };
    await replyFlex(replyToken, buildPromptFlex('設定 ETA', '請直接輸入 ETA 分鐘數，例如：20'));
    return;
  }

  if (action === 'pickup_done') {
    const order = ensureOrderExists(postback.orderId);
    if (!order) {
      await replyFlex(replyToken, buildSimpleResultFlex('找不到訂單', '請重新操作'));
      return;
    }

    if (!ensureRiderAuthorized(order, userId)) {
      await replyFlex(replyToken, buildSimpleResultFlex('無法操作', '你無權操作此訂單'));
      return;
    }

    order.status = 'PICKED_UP';
    order.pickedUpAt = new Date().toISOString();

    await syncOrderToFirebase(order.id, {
      status: order.status,
      pickedUpAt: order.pickedUpAt,
    });

    await replyFlex(replyToken, buildPickupDoneFlex(order));

    await pushMulti(order.userId, [buildPickupDoneFlex(order)]);
    return;
  }

  if (action === 'delivered_done') {
    const order = ensureOrderExists(postback.orderId);
    if (!order) {
      await replyFlex(replyToken, buildSimpleResultFlex('找不到訂單', '請重新操作'));
      return;
    }

    if (!ensureRiderAuthorized(order, userId)) {
      await replyFlex(replyToken, buildSimpleResultFlex('無法操作', '你無權操作此訂單'));
      return;
    }

    order.status = 'DELIVERED';
    order.deliveredAt = new Date().toISOString();

    await syncOrderToFirebase(order.id, {
      status: order.status,
      deliveredAt: order.deliveredAt,
    });

    await replyFlex(replyToken, buildDeliveredFlex(order));
    await pushMulti(order.userId, [buildDeliveredFlex(order)]);

    if (LINE_FINISH_GROUP_ID) {
      await pushMulti(LINE_FINISH_GROUP_ID, [buildFinishGroupFinanceFlex(order)]);
    }

    await pushMulti(LINE_GROUP_ID, [
      buildSimpleResultFlex(
        '✅ 任務已完成',
        `訂單：${order.id}\n接單人員：${order.riderName || '騎手'}`
      ),
    ]);
    return;
  }

  await replyFlex(replyToken, buildSimpleResultFlex('未識別操作', '請重新操作'));
}

// =========================
// Webhook
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
  res.send('UBee OMS V3.8.7 PRO MAX 完整正式版 is running');
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

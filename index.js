require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();

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

const PAYMENT_JKO_INFO = (process.env.PAYMENT_JKO_INFO || '').replace(/\\n/g, '\n');
const PAYMENT_BANK_INFO = (process.env.PAYMENT_BANK_INFO || '').replace(/\\n/g, '\n');
const PAYMENT_VERIFY_MODE = (process.env.PAYMENT_VERIFY_MODE || 'CODE').trim().toUpperCase();
const PAYMENT_CODE_LENGTH = Number(process.env.PAYMENT_CODE_LENGTH || 5);
const PAYMENT_MAX_ATTEMPTS = Number(process.env.PAYMENT_MAX_ATTEMPTS || 3);

// =========================
// 資料庫（JSON）
// =========================
const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadJson(file, fallback) {
  try {
    ensureDataDir();
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`讀取 ${file} 失敗`, err);
    return fallback;
  }
}

function saveJson(file, data) {
  try {
    ensureDataDir();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`寫入 ${file} 失敗`, err);
  }
}

const orders = loadJson(ORDERS_FILE, {});
const sessions = loadJson(SESSIONS_FILE, {});

function saveOrders() {
  saveJson(ORDERS_FILE, orders);
}

function saveSessions() {
  saveJson(SESSIONS_FILE, sessions);
}

// =========================
// 表單
// =========================
const BUSINESS_FORM =
  'https://docs.google.com/forms/d/e/1FAIpQLScn9AGnp4FbTGg6fZt5fpiMdNEi-yL9x595bTyVFHAoJmpYlA/viewform';
const PARTNER_FORM =
  'https://docs.google.com/forms/d/e/1FAIpQLSc2qdklWuSSPw39vjfrXEakBHTI3TM_NgqMxWLAZg0ej6zvMA/viewform';

// =========================
// 計價
// =========================
const PRICING = {
  baseFee: 99,
  perKm: 8,
  perMinute: 2,
  serviceFee: 50,
  urgentFee: 100,
  waitingFee: 60,
  driverRate: 0.6,
};

// =========================
// 工具
// =========================
const createOrderId = () =>
  'OD' +
  Date.now() +
  Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0');

function runAsync(taskName, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      console.error(`❌ ${taskName} error:`, err?.originalError || err);
    });
}

function safeReply(replyToken, message) {
  return client.replyMessage(replyToken, message).catch((err) => {
    console.error('replyMessage error:', err?.originalError || err);
  });
}

function safePush(to, message) {
  return client.pushMessage(to, message).catch((err) => {
    console.error('pushMessage error:', err?.originalError || err);
  });
}

async function replyAndRun(replyToken, message, taskName, fn) {
  await safeReply(replyToken, message);
  runAsync(taskName, fn);
}

function textMessage(text) {
  return { type: 'text', text };
}

function createQuickReplyMessage(text, items) {
  return {
    type: 'text',
    text,
    quickReply: { items },
  };
}

function qrMessage(label, text) {
  return {
    type: 'action',
    action: {
      type: 'message',
      label,
      text,
    },
  };
}

function normalizePhone(input) {
  return (input || '').trim().replace(/[\s-]/g, '');
}

function isValidTaiwanPhone(phone) {
  return /^0\d{8,9}$/.test(phone);
}

function formatCurrency(num) {
  return `$${Math.round(Number(num || 0))}`;
}

function formatKm(km) {
  return `${Number(km || 0).toFixed(1)} 公里`;
}

function formatMinutes(min) {
  return `${Math.round(Number(min || 0))} 分鐘`;
}

function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

function getOrder(orderId) {
  return orders[orderId] || null;
}

function getSession(userId) {
  return sessions[userId] || null;
}

function setSession(userId, value) {
  sessions[userId] = value;
  saveSessions();
}

function clearSession(userId) {
  delete sessions[userId];
  saveSessions();
}

function updateOrder(orderId, patch) {
  if (!orders[orderId]) return null;
  orders[orderId] = { ...orders[orderId], ...patch };
  saveOrders();
  return orders[orderId];
}

function getStatusText(status) {
  switch (status) {
    case 'pending':
      return '待接單';
    case 'accepted':
      return '已接單';
    case 'arrived_pickup':
      return '已抵達取件地點';
    case 'picked_up':
      return '已取件';
    case 'arrived_dropoff':
      return '已抵達送達地點';
    case 'completed':
      return '已完成';
    case 'cancelled':
      return '已取消';
    default:
      return '未知狀態';
  }
}

function getPaymentStatusText(paymentStatus) {
  switch (paymentStatus) {
    case 'unpaid':
      return '待付款';
    case 'pending_verify':
      return '待驗證';
    case 'paid':
      return '已付款';
    case 'locked':
      return '已鎖定';
    default:
      return '未知';
  }
}

function getPaymentMethodText(method) {
  if (method === 'jko') return '街口支付';
  if (method === 'bank') return '銀行轉帳';
  return '尚未選擇';
}

function getPaymentInfoByMethod(method) {
  if (method === 'jko') return PAYMENT_JKO_INFO || '尚未設定街口付款資訊';
  if (method === 'bank') return PAYMENT_BANK_INFO || '尚未設定銀行付款資訊';
  return '尚未選擇付款方式';
}

function getPaymentCode(orderId) {
  return String(orderId || '').slice(-PAYMENT_CODE_LENGTH);
}

function buildGoogleMapSearchUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function buildGoogleMapDirectionsUrl(origin, destination) {
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
    origin
  )}&destination=${encodeURIComponent(destination)}&travelmode=driving`;
}

function requireOrder(replyToken, orderId) {
  const order = getOrder(orderId);
  if (!order) {
    safeReply(replyToken, textMessage('❌ 訂單不存在、已失效，或系統已重置。'));
    return null;
  }
  return order;
}

function isDriverAuthorized(order, userId) {
  return !!(order && order.driverId && order.driverId === userId);
}

function isPendingDriverAuthorized(order, userId) {
  return !!(order && order.pendingDriverId && order.pendingDriverId === userId);
}

function requireDriver(replyToken, order, userId) {
  if (!isDriverAuthorized(order, userId)) {
    safeReply(replyToken, textMessage('⚠️ 此操作僅限接單騎手執行。'));
    return false;
  }
  return true;
}

function requireStatus(replyToken, order, allowedStatuses, actionName) {
  if (!allowedStatuses.includes(order.status)) {
    safeReply(
      replyToken,
      textMessage(
        `⚠️ 目前訂單狀態為「${getStatusText(order.status)}」，暫時無法執行「${actionName}」。`
      )
    );
    return false;
  }
  return true;
}

function getCancelRuleText(status) {
  switch (status) {
    case 'pending':
      return '尚未接單，免費取消';
    case 'accepted':
      return '騎手已接單，取消費為配送費 30%（最低 $60，最高 $200）';
    case 'arrived_pickup':
      return '騎手已抵達取件地點，取消費為配送費 50%（最低 $100，最高 $300）';
    case 'picked_up':
      return '訂單已取件，無法取消';
    case 'arrived_dropoff':
      return '訂單已進入送達階段，無法取消';
    case 'completed':
      return '訂單已完成，無法取消';
    case 'cancelled':
      return '訂單已取消';
    default:
      return '目前無法取消';
  }
}

function calculateCancelFee(order) {
  if (!order) return null;
  if (order.status === 'pending') return 0;
  if (order.status === 'accepted') {
    return Math.round(Math.min(Math.max(order.deliveryFee * 0.3, 60), 200));
  }
  if (order.status === 'arrived_pickup') {
    return Math.round(Math.min(Math.max(order.deliveryFee * 0.5, 100), 300));
  }
  return null;
}

// =========================
// Google Maps
// =========================
async function getDistanceAndDuration(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('缺少 GOOGLE_MAPS_API_KEY');
  }

  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(
      origin
    )}` +
    `&destinations=${encodeURIComponent(destination)}` +
    `&mode=driving&language=zh-TW&region=tw&key=${GOOGLE_MAPS_API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Google Maps 連線失敗（HTTP ${response.status}）`);
  }

  const data = await response.json();

  if (data.status !== 'OK') {
    throw new Error(`Google Maps API 錯誤：${data.status}`);
  }

  const element = data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK') {
    throw new Error(`地址查詢失敗：${element?.status || 'UNKNOWN'}`);
  }

  return {
    distanceKm: element.distance.value / 1000,
    durationMin: element.duration.value / 60,
    distanceText: element.distance.text,
    durationText: element.duration.text,
  };
}

async function calculateFees(session) {
  const route = await getDistanceAndDuration(session.pickup, session.dropoff);

  const distanceFee = Math.ceil(route.distanceKm) * PRICING.perKm;
  const timeFee = Math.ceil(route.durationMin) * PRICING.perMinute;
  const deliveryFee = PRICING.baseFee + distanceFee + timeFee;
  const serviceFee = PRICING.serviceFee;
  const urgentFee = session.isUrgent === '急件' ? PRICING.urgentFee : 0;
  const waitingFee = 0;
  const totalFee = deliveryFee + serviceFee + urgentFee + waitingFee;
  const driverFee = Math.round(totalFee * PRICING.driverRate);

  return {
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
    distanceText: route.distanceText,
    durationText: route.durationText,
    baseFee: PRICING.baseFee,
    distanceFee,
    timeFee,
    deliveryFee,
    serviceFee,
    urgentFee,
    waitingFee,
    totalFee,
    driverFee,
  };
}

// =========================
// Session
// =========================
function createEmptySession(userId, type) {
  return {
    type,
    step: 'pickup',
    userId,
    pickup: '',
    pickupPhone: '',
    dropoff: '',
    dropoffPhone: '',
    item: '',
    isUrgent: '',
    note: '',

    distanceKm: 0,
    durationMin: 0,
    distanceText: '',
    durationText: '',

    baseFee: 0,
    distanceFee: 0,
    timeFee: 0,
    deliveryFee: 0,
    serviceFee: 0,
    urgentFee: 0,
    waitingFee: 0,
    totalFee: 0,
    driverFee: 0,
  };
}

// =========================
// Flex 共用
// =========================
function createActionButton(label, data, style = 'primary', color) {
  const btn = {
    type: 'button',
    style,
    height: 'sm',
    action: {
      type: 'postback',
      label,
      data,
      displayText: label,
    },
  };
  if (color) btn.color = color;
  return btn;
}

function createUriButton(label, uri, style = 'primary', color) {
  const btn = {
    type: 'button',
    style,
    height: 'sm',
    action: {
      type: 'uri',
      label,
      uri,
    },
  };
  if (color) btn.color = color;
  return btn;
}

function createMessageButton(label, text, style = 'secondary', color) {
  const btn = {
    type: 'button',
    style,
    height: 'sm',
    action: {
      type: 'message',
      label,
      text,
    },
  };
  if (color) btn.color = color;
  return btn;
}

function createInfoRow(label, value, valueColor = '#111111') {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'md',
    contents: [
      {
        type: 'text',
        text: label,
        size: 'sm',
        color: '#8A8A8A',
        flex: 3,
      },
      {
        type: 'text',
        text: value || '無',
        size: 'sm',
        wrap: true,
        color: valueColor,
        flex: 7,
      },
    ],
  };
}

function createPriceRow(label, value, color = '#111111', weight = 'regular') {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      {
        type: 'text',
        text: label,
        size: 'sm',
        color: '#666666',
        flex: 6,
      },
      {
        type: 'text',
        text: value,
        size: 'sm',
        color,
        weight,
        align: 'end',
        flex: 4,
      },
    ],
  };
}

function createSimpleFlex(title, subtitle, buttons = [], accentColor = '#111111') {
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: accentColor,
        paddingAll: '18px',
        contents: [
          { type: 'text', text: title, color: '#FFFFFF', weight: 'bold', size: 'lg' },
          { type: 'text', text: subtitle, color: '#E8E8E8', size: 'sm', margin: 'sm', wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: buttons,
      },
    },
  };
}

// =========================
// 華麗 Flex
// =========================
function createMainMenuFlex() {
  return {
    type: 'flex',
    altText: 'UBee 主選單',
    contents: {
      type: 'bubble',
      size: 'giga',
      hero: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '24px',
        contents: [
          { type: 'text', text: 'UBee', color: '#FFFFFF', weight: 'bold', size: 'xxl' },
          { type: 'text', text: '城市任務服務', color: '#F4C542', size: 'sm', margin: 'sm' },
          {
            type: 'text',
            text: '專注商務急送、文件任務、即時在地支援',
            color: '#D9D9D9',
            size: 'xs',
            margin: 'md',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: '請選擇您要使用的功能',
            size: 'sm',
            color: '#555555',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createMessageButton('下單', '下單', 'primary', '#111111'),
          createMessageButton('企業', '企業', 'secondary'),
          createMessageButton('我的', '我的', 'secondary'),
        ],
      },
    },
  };
}

function createOrderMenuFlex() {
  return {
    type: 'flex',
    altText: 'UBee｜下單服務',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: 'UBee｜下單服務', color: '#FFFFFF', weight: 'bold', size: 'lg' },
          { type: 'text', text: '建立任務或立即估價', color: '#D9D9D9', size: 'sm', margin: 'sm' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createActionButton('建立任務', 'action=create', 'primary', '#111111'),
          createActionButton('立即估價', 'action=quote', 'secondary'),
          createMessageButton('計費說明', '計費說明', 'secondary'),
          createMessageButton('取消規則', '取消規則', 'secondary'),
          createMessageButton('查詢訂單', '查詢訂單', 'secondary'),
        ],
      },
    },
  };
}

function createEnterpriseMenuFlex() {
  return {
    type: 'flex',
    altText: 'UBee｜企業服務',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: 'UBee｜企業服務', color: '#FFFFFF', weight: 'bold', size: 'lg' },
          { type: 'text', text: '企業合作與服務資訊', color: '#D9D9D9', size: 'sm', margin: 'sm' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createUriButton('企業合作申請', BUSINESS_FORM, 'primary', '#111111'),
          createMessageButton('企業服務說明', '企業服務說明', 'secondary'),
          createMessageButton('服務區域', '服務區域', 'secondary'),
          createMessageButton('聯絡我們', '聯絡我們', 'secondary'),
        ],
      },
    },
  };
}

function createMyMenuFlex() {
  return {
    type: 'flex',
    altText: 'UBee｜我的',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: 'UBee｜我的', color: '#FFFFFF', weight: 'bold', size: 'lg' },
          { type: 'text', text: '服務說明與夥伴申請', color: '#D9D9D9', size: 'sm', margin: 'sm' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createMessageButton('服務說明', '服務說明', 'primary', '#111111'),
          createMessageButton('常見問題', '常見問題', 'secondary'),
          createUriButton('加入夥伴', PARTNER_FORM, 'secondary'),
          createMessageButton('查詢訂單', '查詢訂單', 'secondary'),
          createMessageButton('聯絡我們', '聯絡我們', 'secondary'),
        ],
      },
    },
  };
}

function createUrgentChoiceFlex() {
  return {
    type: 'flex',
    altText: '是否為急件',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [{ type: 'text', text: '是否為急件？', color: '#FFFFFF', weight: 'bold', size: 'xl' }],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: '請選擇本次任務是否為急件', wrap: true, size: 'sm', color: '#333333' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createMessageButton('一般', '一般', 'secondary'),
          createMessageButton('急件', '急件', 'primary', '#111111'),
        ],
      },
    },
  };
}

function createConfirmCardFlex(session, mode = 'create') {
  const confirmData = mode === 'quote' ? 'action=confirmQuoteCreate' : 'action=confirmCreate';
  const restartData = mode === 'quote' ? 'action=restartQuote' : 'action=restartCreate';
  const cancelData = mode === 'quote' ? 'action=cancelQuote' : 'action=cancelCreate';

  return {
    type: 'flex',
    altText: '請確認任務資訊',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: '任務資訊確認', color: '#FFFFFF', weight: 'bold', size: 'xl' },
          { type: 'text', text: '請確認內容與費用', color: '#D9D9D9', size: 'sm', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'lg',
        paddingAll: '18px',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              createInfoRow('取件地點', session.pickup),
              createInfoRow('取件電話', session.pickupPhone),
              createInfoRow('送達地點', session.dropoff),
              createInfoRow('送達電話', session.dropoffPhone),
              createInfoRow('物品內容', session.item),
              createInfoRow('任務類型', session.isUrgent),
              createInfoRow('備註', session.note),
              createInfoRow('預估距離', session.distanceText || formatKm(session.distanceKm)),
              createInfoRow('預估時間', session.durationText || formatMinutes(session.durationMin)),
            ],
          },
          { type: 'separator' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              createPriceRow('基本費', formatCurrency(session.baseFee)),
              createPriceRow('距離費', formatCurrency(session.distanceFee)),
              createPriceRow('時間費', formatCurrency(session.timeFee)),
              createPriceRow('配送費', formatCurrency(session.deliveryFee), '#111111', 'bold'),
              createPriceRow('服務費', formatCurrency(session.serviceFee)),
              createPriceRow(
                '急件費',
                formatCurrency(session.urgentFee),
                session.urgentFee > 0 ? '#D32F2F' : '#111111'
              ),
            ],
          },
          { type: 'separator' },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '總計', weight: 'bold', size: 'lg', color: '#111111' },
              {
                type: 'text',
                text: formatCurrency(session.totalFee),
                weight: 'bold',
                size: 'xl',
                color: '#111111',
                align: 'end',
              },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createActionButton(
            mode === 'quote' ? '確認並建立任務' : '確認送出',
            confirmData,
            'primary',
            '#111111'
          ),
          createActionButton('重新填寫', restartData, 'secondary'),
          createActionButton('取消', cancelData, 'secondary'),
        ],
      },
    },
  };
}

function createOrderPendingPaymentFlex(order) {
  return {
    type: 'flex',
    altText: '任務已建立，等待付款',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: '✅ 任務已建立', color: '#FFFFFF', weight: 'bold', size: 'xl' },
          {
            type: 'text',
            text: '請先完成付款，驗證成功後系統才會自動派單',
            color: '#D9D9D9',
            size: 'sm',
            margin: 'sm',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          createInfoRow('訂單編號', order.orderId),
          createInfoRow('取件地點', order.pickup),
          createInfoRow('送達地點', order.dropoff),
          createInfoRow('物品內容', order.item),
          createInfoRow('總計', formatCurrency(order.totalFee)),
          createInfoRow('付款狀態', getPaymentStatusText(order.paymentStatus)),
          { type: 'text', text: `付款識別碼：${order.paymentCode}`, size: 'sm', weight: 'bold', color: '#D32F2F' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createActionButton('選擇付款方式', `paymentMethodMenu=${order.orderId}`, 'primary', '#111111'),
          createActionButton('取消任務', `cancelRequest=${order.orderId}`, 'secondary'),
        ],
      },
    },
  };
}

function createPaymentMethodFlex(order) {
  return {
    type: 'flex',
    altText: '請選擇付款方式',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: '付款方式', color: '#FFFFFF', weight: 'bold', size: 'xl' },
          { type: 'text', text: '請選擇本次付款方式', color: '#D9D9D9', size: 'sm', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '18px',
        contents: [
          createInfoRow('訂單編號', order.orderId),
          createInfoRow('應付金額', formatCurrency(order.totalFee)),
          createInfoRow('付款識別碼', order.paymentCode, '#D32F2F'),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createActionButton('街口支付', `paymentMethod=${order.orderId}=jko`, 'primary', '#111111'),
          createActionButton('銀行轉帳', `paymentMethod=${order.orderId}=bank`, 'secondary'),
          createActionButton('取消任務', `cancelRequest=${order.orderId}`, 'secondary'),
        ],
      },
    },
  };
}

function createPaymentInfoFlex(order) {
  return {
    type: 'flex',
    altText: '付款資訊',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: '付款資訊', color: '#FFFFFF', weight: 'bold', size: 'xl' },
          { type: 'text', text: '付款完成後請按下方按鈕', color: '#D9D9D9', size: 'sm', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          createInfoRow('訂單編號', order.orderId),
          createInfoRow('付款方式', getPaymentMethodText(order.paymentMethod)),
          createInfoRow('應付金額', formatCurrency(order.totalFee)),
          createInfoRow('付款識別碼', order.paymentCode, '#D32F2F'),
          { type: 'separator' },
          { type: 'text', text: getPaymentInfoByMethod(order.paymentMethod), wrap: true, size: 'sm', color: '#333333' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createActionButton('我已付款', `paymentPaid=${order.orderId}`, 'primary', '#111111'),
          createActionButton('重新選擇付款方式', `paymentMethodMenu=${order.orderId}`, 'secondary'),
          createActionButton('取消任務', `cancelRequest=${order.orderId}`, 'secondary'),
        ],
      },
    },
  };
}

function createPaymentVerifiedFlex(order) {
  return {
    type: 'flex',
    altText: '付款已驗證成功',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: '✅ 付款已驗證', color: '#FFFFFF', weight: 'bold', size: 'xl' },
          { type: 'text', text: '系統已自動派單，正在安排騎手', color: '#D9D9D9', size: 'sm', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          createInfoRow('訂單編號', order.orderId),
          createInfoRow('付款方式', getPaymentMethodText(order.paymentMethod)),
          createInfoRow('付款狀態', getPaymentStatusText(order.paymentStatus)),
          createInfoRow('總計', formatCurrency(order.totalFee)),
        ],
      },
    },
  };
}

function createPriceSummaryFlex(order, title = '訂單費用更新', subtitle = '以下為目前最新費用明細') {
  const showCancelFee = (order.cancelFee || 0) > 0;
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: title, color: '#FFFFFF', weight: 'bold', size: 'xl' },
          { type: 'text', text: subtitle, color: '#D9D9D9', size: 'sm', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'lg',
        paddingAll: '18px',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              createInfoRow('訂單編號', order.orderId),
              createInfoRow('取件地點', order.pickup),
              createInfoRow('送達地點', order.dropoff),
              createInfoRow('物品內容', order.item),
              createInfoRow('任務類型', order.isUrgent),
            ],
          },
          { type: 'separator' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              createPriceRow('配送費', formatCurrency(order.deliveryFee), '#111111', 'bold'),
              createPriceRow('服務費', formatCurrency(order.serviceFee)),
              createPriceRow('急件費', formatCurrency(order.urgentFee), order.urgentFee > 0 ? '#D32F2F' : '#111111'),
              createPriceRow('等候費', formatCurrency(order.waitingFee), order.waitingFee > 0 ? '#D32F2F' : '#111111'),
              ...(showCancelFee
                ? [createPriceRow('取消費', formatCurrency(order.cancelFee), '#D32F2F', 'bold')]
                : []),
            ],
          },
          { type: 'separator' },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '總計', weight: 'bold', size: 'lg', color: '#111111' },
              {
                type: 'text',
                text: formatCurrency(order.totalFee),
                weight: 'bold',
                size: 'xl',
                color: '#111111',
                align: 'end',
              },
            ],
          },
        ],
      },
    },
  };
}

function createGroupTaskFlex(orderId) {
  const order = orders[orderId];
  return {
    type: 'flex',
    altText: 'UBee 新任務通知',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: '📦 UBee 新任務', color: '#FFFFFF', weight: 'bold', size: 'xl' },
          { type: 'text', text: `訂單編號：${order.orderId}`, color: '#D9D9D9', size: 'sm', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#FFF8E1',
            cornerRadius: '10px',
            paddingAll: '12px',
            contents: [
              {
                type: 'text',
                text: `騎手可得：${formatCurrency(order.driverFee)}`,
                weight: 'bold',
                size: 'lg',
                color: '#111111',
              },
            ],
          },
          createInfoRow('取件地點', order.pickup),
          createInfoRow('送達地點', order.dropoff),
          createInfoRow('物品內容', order.item),
          createInfoRow('任務類型', order.isUrgent),
          createInfoRow('備註', order.note),
          createInfoRow('距離', order.distanceText || formatKm(order.distanceKm)),
          createInfoRow('時間', order.durationText || formatMinutes(order.durationMin)),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createActionButton('接單', `accept=${orderId}`, 'primary', '#111111'),
          createActionButton('放棄任務', `reject=${orderId}`, 'secondary'),
        ],
      },
    },
  };
}

function createETAFlex(orderId, page) {
  const map = {
    1: [
      createActionButton('5 分鐘', `eta=${orderId}=5`, 'secondary'),
      createActionButton('7 分鐘', `eta=${orderId}=7`, 'secondary'),
      createActionButton('8 分鐘', `eta=${orderId}=8`, 'secondary'),
      createActionButton('下一頁', `etaPage2=${orderId}`, 'primary', '#111111'),
      createActionButton('取消接單', `acceptCancel=${orderId}`, 'secondary'),
    ],
    2: [
      createActionButton('10 分鐘', `eta=${orderId}=10`, 'secondary'),
      createActionButton('12 分鐘', `eta=${orderId}=12`, 'secondary'),
      createActionButton('15 分鐘', `eta=${orderId}=15`, 'secondary'),
      createActionButton('下一頁', `etaPage3=${orderId}`, 'primary', '#111111'),
      createActionButton('取消接單', `acceptCancel=${orderId}`, 'secondary'),
    ],
    3: [
      createActionButton('17 分鐘', `eta=${orderId}=17`, 'secondary'),
      createActionButton('18 分鐘', `eta=${orderId}=18`, 'secondary'),
      createActionButton('20 分鐘', `eta=${orderId}=20`, 'secondary'),
      createActionButton('下一頁', `etaPage4=${orderId}`, 'primary', '#111111'),
      createActionButton('取消接單', `acceptCancel=${orderId}`, 'secondary'),
    ],
    4: [
      createActionButton('22 分鐘', `eta=${orderId}=22`, 'secondary'),
      createActionButton('25 分鐘', `eta=${orderId}=25`, 'secondary'),
      createActionButton('上一頁', `etaPage3=${orderId}`, 'primary', '#111111'),
      createActionButton('取消接單', `acceptCancel=${orderId}`, 'secondary'),
    ],
  };
  return createSimpleFlex(`選擇 ETA（${page}/4）`, '請選擇預計抵達取件地點時間', map[page], '#111111');
}

function createPickupActionFlex(orderId) {
  const order = orders[orderId];
  return createSimpleFlex(
    '取件操作',
    `請前往取件地點\n\n取件：${order.pickup}`,
    [
      createUriButton('導航取件地點', buildGoogleMapSearchUrl(order.pickup), 'primary', '#111111'),
      createActionButton('已抵達取件地點', `arrivePickup=${orderId}`, 'secondary'),
      createActionButton('取消接單', `releaseOrder=${orderId}`, 'secondary'),
    ],
    '#111111'
  );
}

function createPickupArrivedActionFlex(orderId) {
  return createSimpleFlex(
    '現場操作',
    '如需等待，可先申請等候費；完成取件後請按下方按鈕。',
    [
      createActionButton('⏳ 申請等候費', `waitingFeeRequest=${orderId}`, 'secondary'),
      createActionButton('已取件', `picked=${orderId}`, 'primary', '#111111'),
    ],
    '#111111'
  );
}

function createDropoffActionFlex(orderId) {
  const order = orders[orderId];
  return createSimpleFlex(
    '送達操作',
    `請前往送達地點\n\n送達：${order.dropoff}`,
    [
      createUriButton('導航送達地點', buildGoogleMapDirectionsUrl(order.pickup, order.dropoff), 'primary', '#111111'),
      createActionButton('已抵達送達地點', `arriveDropoff=${orderId}`, 'secondary'),
    ],
    '#111111'
  );
}

function createDropoffArrivedFlex(orderId) {
  const order = orders[orderId];
  return createSimpleFlex(
    '送達地點操作',
    `請先聯絡收件人，再完成任務\n\n送達電話：${order.dropoffPhone}`,
    [
      createActionButton('撥打收件人', `call=${orderId}=${order.dropoffPhone}`, 'secondary'),
      createActionButton('已完成', `complete=${orderId}`, 'primary', '#111111'),
    ],
    '#111111'
  );
}

function createCallFlex(phone) {
  return createSimpleFlex('聯絡收件人', `請點擊下方按鈕撥打電話\n\n電話：${phone}`, [
    createUriButton('📞 撥打', `tel:${phone}`, 'primary', '#111111'),
  ]);
}

function createWaitingFeeConfirmFlex(orderId, currentTotal) {
  return {
    type: 'flex',
    altText: '等候費確認',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: '等候費確認', color: '#FFFFFF', weight: 'bold', size: 'xl' },
          { type: 'text', text: '請確認是否同意本次等候費申請', color: '#D9D9D9', size: 'sm', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: '騎手目前於現場等候中，申請加收等候費 $60。', wrap: true, size: 'sm', color: '#333333' },
          { type: 'text', text: `目前訂單金額：${formatCurrency(currentTotal)}`, weight: 'bold', size: 'md', margin: 'md' },
          {
            type: 'text',
            text: `確認加收後金額：${formatCurrency(currentTotal + PRICING.waitingFee)}`,
            weight: 'bold',
            size: 'lg',
            color: '#D32F2F',
            margin: 'sm',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createActionButton('同意加收', `waitingFeeApprove=${orderId}`, 'primary', '#111111'),
          createActionButton('不同意加收', `waitingFeeReject=${orderId}`, 'secondary'),
        ],
      },
    },
  };
}

function createCancelConfirmFlex(order) {
  const cancelFee = calculateCancelFee(order);
  return {
    type: 'flex',
    altText: '取消任務確認',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: '取消任務確認', color: '#FFFFFF', weight: 'bold', size: 'xl' },
          { type: 'text', text: '請確認是否要取消本次任務', color: '#D9D9D9', size: 'sm', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          createInfoRow('訂單編號', order.orderId),
          createInfoRow('目前狀態', getStatusText(order.status)),
          createInfoRow('取件地點', order.pickup),
          createInfoRow('送達地點', order.dropoff),
          { type: 'text', text: getCancelRuleText(order.status), wrap: true, size: 'sm', color: '#333333' },
          {
            type: 'text',
            text: cancelFee === null ? '此階段無法取消' : `本次取消費：${formatCurrency(cancelFee)}`,
            weight: 'bold',
            size: 'lg',
            color: cancelFee > 0 ? '#D32F2F' : '#111111',
            margin: 'md',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents:
          cancelFee === null
            ? [createActionButton('返回', `cancelBack=${order.orderId}`, 'secondary')]
            : [
                createActionButton('確認取消任務', `cancelConfirm=${order.orderId}`, 'primary', '#111111'),
                createActionButton('返回', `cancelBack=${order.orderId}`, 'secondary'),
              ],
      },
    },
  };
}

function createCancelledFlex(order) {
  return {
    type: 'flex',
    altText: '任務已取消',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: '⚠️ 任務已取消', color: '#FFFFFF', weight: 'bold', size: 'xl' },
          { type: 'text', text: '以下為本次取消資訊', color: '#D9D9D9', size: 'sm', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          createInfoRow('訂單編號', order.orderId),
          createInfoRow('取消階段', getStatusText(order.cancelStage || order.status)),
          createInfoRow('取件地點', order.pickup),
          createInfoRow('送達地點', order.dropoff),
          createInfoRow('取消費', formatCurrency(order.cancelFee), '#D32F2F'),
        ],
      },
    },
  };
}

function createCompletedFlex(order) {
  return {
    type: 'flex',
    altText: '任務已完成',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: '✅ 任務已完成', color: '#FFFFFF', weight: 'bold', size: 'xl' },
          { type: 'text', text: '感謝您使用 UBee 城市任務服務', color: '#D9D9D9', size: 'sm', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          createInfoRow('訂單編號', order.orderId),
          createInfoRow('取件地點', order.pickup),
          createInfoRow('送達地點', order.dropoff),
          createInfoRow('物品內容', order.item),
          createInfoRow('最終金額', formatCurrency(order.totalFee)),
        ],
      },
    },
  };
}

function createFinishReportFlex(order) {
  const extraFee = (order.urgentFee || 0) + (order.waitingFee || 0);
  const platformIncome = (order.totalFee || 0) - (order.driverFee || 0);
  const baseRevenue = (order.deliveryFee || 0) + (order.serviceFee || 0);

  return {
    type: 'flex',
    altText: `財務明細｜${order.orderId}`,
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: '💰 財務明細', color: '#FFFFFF', weight: 'bold', size: 'xl' },
          { type: 'text', text: `訂單編號：${order.orderId}`, color: '#D9D9D9', size: 'sm', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'lg',
        paddingAll: '18px',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F4EFD8',
            cornerRadius: '10px',
            paddingAll: '12px',
            contents: [{ type: 'text', text: `客戶支付：${formatCurrency(order.totalFee)}`, weight: 'bold', size: 'xl', color: '#111111' }],
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              createInfoRow('取件地點', order.pickup),
              createInfoRow('送達地點', order.dropoff),
              createInfoRow('物品內容', order.item),
              createInfoRow('任務類型', order.isUrgent),
              createInfoRow('備註', order.note || '無'),
              createInfoRow('距離', order.distanceText || formatKm(order.distanceKm)),
              createInfoRow('時間', order.durationText || formatMinutes(order.durationMin)),
            ],
          },
          { type: 'separator' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              createPriceRow('騎手收入', formatCurrency(order.driverFee), '#111111', 'bold'),
              createPriceRow('平台收入', formatCurrency(platformIncome), '#111111', 'bold'),
            ],
          },
          { type: 'separator' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              { type: 'text', text: '附加費明細', weight: 'bold', size: 'md', color: '#111111' },
              createPriceRow('急件費', formatCurrency(order.urgentFee || 0)),
              createPriceRow('等候費', formatCurrency(order.waitingFee || 0)),
              createPriceRow('附加費總額', formatCurrency(extraFee), '#D32F2F', 'bold'),
            ],
          },
          { type: 'separator' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              { type: 'text', text: '收入拆解', weight: 'bold', size: 'md', color: '#111111' },
              createPriceRow('基礎收入', formatCurrency(baseRevenue)),
              createPriceRow('附加收入', formatCurrency(extraFee)),
            ],
          },
        ],
      },
    },
  };
}

// =========================
// 查單文字：客戶/騎手隔離
// =========================
function createCustomerOrderStatusText(order) {
  const driverPart = order.driverId ? '\n接單騎手：已指派' : '\n接單騎手：尚未指派';
  const etaPart = order.etaMinutes ? `\nETA：${order.etaMinutes} 分鐘` : '';
  const waitingPart = order.waitingFeeAdded ? `\n等候費：${formatCurrency(order.waitingFee)}` : '';
  const cancelPart = order.status === 'cancelled' ? `\n取消費：${formatCurrency(order.cancelFee)}` : '';
  const paymentPart =
    `\n付款狀態：${getPaymentStatusText(order.paymentStatus)}` +
    `\n付款方式：${getPaymentMethodText(order.paymentMethod)}`;

  return (
    `📦 訂單查詢結果\n\n` +
    `訂單編號：${order.orderId}\n` +
    `目前狀態：${getStatusText(order.status)}\n` +
    `取件地點：${order.pickup}\n` +
    `送達地點：${order.dropoff}\n` +
    `物品內容：${order.item}\n` +
    `任務類型：${order.isUrgent}\n` +
    `訂單總額：${formatCurrency(order.totalFee)}` +
    paymentPart +
    driverPart +
    etaPart +
    waitingPart +
    cancelPart
  );
}

function createDriverOrderStatusText(order) {
  const etaPart = order.etaMinutes ? `\nETA：${order.etaMinutes} 分鐘` : '';
  const waitingPart = order.waitingFeeAdded ? '\n等候費狀態：已加收' : '';
  const cancelPart = order.status === 'cancelled' ? '\n取消狀態：此訂單已取消' : '';

  return (
    `📦 任務查詢結果\n\n` +
    `訂單編號：${order.orderId}\n` +
    `目前狀態：${getStatusText(order.status)}\n` +
    `取件地點：${order.pickup}\n` +
    `送達地點：${order.dropoff}\n` +
    `物品內容：${order.item}\n` +
    `任務類型：${order.isUrgent}\n` +
    `騎手可得：${formatCurrency(order.driverFee)}` +
    etaPart +
    waitingPart +
    cancelPart
  );
}

// =========================
// 派單
// =========================
async function dispatchOrder(orderId) {
  const order = getOrder(orderId);
  if (!order) return;
  if (order.dispatchedAt) return;
  if (order.paymentStatus !== 'paid') return;
  if (!LINE_GROUP_ID) return;

  updateOrder(orderId, { dispatchedAt: new Date().toISOString() });
  await safePush(LINE_GROUP_ID, createGroupTaskFlex(orderId));
}

// =========================
// 建立訂單
// =========================
async function createOrderFromSession(event, session) {
  const orderId = createOrderId();

  orders[orderId] = {
    orderId,
    userId: session.userId,
    pickup: session.pickup,
    pickupPhone: session.pickupPhone,
    dropoff: session.dropoff,
    dropoffPhone: session.dropoffPhone,
    item: session.item,
    isUrgent: session.isUrgent,
    note: session.note,

    distanceKm: session.distanceKm,
    durationMin: session.durationMin,
    distanceText: session.distanceText,
    durationText: session.durationText,

    baseFee: session.baseFee,
    distanceFee: session.distanceFee,
    timeFee: session.timeFee,
    deliveryFee: session.deliveryFee,
    serviceFee: session.serviceFee,
    urgentFee: session.urgentFee,

    waitingFee: 0,
    waitingFeeAdded: false,
    waitingFeeRequested: false,

    totalFee: session.totalFee,
    driverFee: session.driverFee,

    paymentStatus: 'unpaid',
    paymentMethod: '',
    paymentCode: getPaymentCode(orderId),
    paymentAttempts: 0,
    paidAt: null,
    dispatchedAt: null,

    cancelFee: 0,
    cancelledAt: null,
    cancelledBy: null,
    cancelStage: null,

    status: 'pending',
    driverId: null,
    pendingDriverId: null,
    pendingAcceptedAt: null,
    etaMinutes: null,
    releasedCount: 0,
    createdAt: new Date().toISOString(),
    acceptedAt: null,
    arrivedPickupAt: null,
    pickedUpAt: null,
    arrivedDropoffAt: null,
    completedAt: null,
    archived: false,
    abandonedBy: [],
  };

  saveOrders();
  clearSession(session.userId);

  return safeReply(event.replyToken, [
    createOrderPendingPaymentFlex(orders[orderId]),
    createPaymentMethodFlex(orders[orderId]),
  ]);
}

// =========================
// Webhook
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee OMS V3.8.7 PRO MAX 華麗版 Running');
});

app.post('/webhook', line.middleware(config), (req, res) => {
  res.sendStatus(200);
  Promise.allSettled(req.body.events.map(handleEvent)).catch((err) => {
    console.error('webhook async error:', err);
  });
});

// =========================
// Event
// =========================
async function handleEvent(event) {
  try {
    if (event.type === 'postback') {
      return handlePostback(event);
    }

    if (event.type !== 'message' || event.message.type !== 'text') return;

    const text = (event.message.text || '').trim();
    const userId = event.source.userId;

    if (text === '主選單') return safeReply(event.replyToken, createMainMenuFlex());
    if (text === '下單') return safeReply(event.replyToken, createOrderMenuFlex());
    if (text === '企業') return safeReply(event.replyToken, createEnterpriseMenuFlex());
    if (text === '我的') return safeReply(event.replyToken, createMyMenuFlex());

    if (text === '企業服務說明') {
      return safeReply(
        event.replyToken,
        textMessage(
          'UBee 企業服務說明\n\n' +
            '適用對象：公司、工廠、中小企業、事務所與門市單位。\n' +
            '服務內容：文件急送、商務跑腿、樣品收送、臨時行政支援。\n' +
            '服務方式：建立任務後，由系統派送至群組，媒合合適騎手執行。'
        )
      );
    }

    if (text === '服務說明') {
      return safeReply(
        event.replyToken,
        textMessage(
          'UBee 服務說明\n\n' +
            'UBee 提供城市任務服務，包含文件急送、商務跑腿與即時在地支援。\n' +
            '建立任務後，系統會媒合騎手執行，並在任務過程中同步通知進度。\n' +
            '若任務進入派送階段後取消，系統將依訂單狀態酌收取消費。'
        )
      );
    }

    if (text === '計費說明') {
      return safeReply(
        event.replyToken,
        textMessage(
          'UBee 計費說明\n\n' +
            `基本費：${formatCurrency(PRICING.baseFee)}\n` +
            `每公里：${formatCurrency(PRICING.perKm)}\n` +
            `每分鐘：${formatCurrency(PRICING.perMinute)}\n` +
            `服務費：${formatCurrency(PRICING.serviceFee)}\n` +
            `急件費：${formatCurrency(PRICING.urgentFee)}\n` +
            `等候費：${formatCurrency(PRICING.waitingFee)}\n\n` +
            '實際金額將依取送地點距離、時間與任務狀態計算。'
        )
      );
    }

    if (text === '取消規則') {
      return safeReply(
        event.replyToken,
        textMessage(
          'UBee 取消規則\n\n' +
            '待接單：免費取消\n' +
            '已接單：取消費為配送費 30%（最低 $60，最高 $200）\n' +
            '已抵達取件地點：取消費為配送費 50%（最低 $100，最高 $300）\n' +
            '已取件後：無法取消'
        )
      );
    }

    if (text === '服務區域') {
      return safeReply(
        event.replyToken,
        textMessage(
          'UBee 服務區域\n\n' +
            '我們以豐原為中心，服務區域包含：\n' +
            '豐原、潭子、神岡、大雅、北屯、北區、中區、東區、西屯、西區、南屯、南區。\n\n' +
            '其他地區請先詢問。'
        )
      );
    }

    if (text === '聯絡我們') {
      return safeReply(
        event.replyToken,
        textMessage('聯絡我們\n\n如需企業合作、任務協助或其他問題，請直接透過本官方帳號留言。')
      );
    }

    if (text === '常見問題') {
      return safeReply(
        event.replyToken,
        textMessage(
          '常見問題\n\n' +
            '1. UBee 是什麼服務？\n' +
            'UBee 提供城市任務服務，包含文件急送、商務跑腿與即時在地支援。\n\n' +
            '2. 目前服務範圍有哪些？\n' +
            '以豐原為中心，服務豐原、潭子、神岡、大雅、北屯、北區、中區、東區、西屯、西區、南屯、南區。\n\n' +
            '3. 是否可以配送餐飲？\n' +
            '目前不提供餐飲外送平台型服務。\n\n' +
            '4. 如何建立任務？\n' +
            '點選「下單」後，可選擇建立任務或立即估價。'
        )
      );
    }

    if (text === '查詢訂單') {
      setSession(userId, { type: 'order_query', step: 'orderId', userId });
      return safeReply(event.replyToken, textMessage('請輸入訂單編號，例如：OD1712345678901'));
    }

    if (text.startsWith('查單 ')) {
      const orderId = text.replace('查單 ', '').trim();
      const order = getOrder(orderId);
      if (!order) return safeReply(event.replyToken, textMessage('❌ 查無此訂單。'));

      if (isAdmin(userId) || order.userId === userId) {
        return safeReply(event.replyToken, textMessage(createCustomerOrderStatusText(order)));
      }

      if (order.driverId === userId || order.pendingDriverId === userId) {
        return safeReply(event.replyToken, textMessage(createDriverOrderStatusText(order)));
      }

      return safeReply(event.replyToken, textMessage('⚠️ 您無權查看此訂單。'));
    }

    const session = getSession(userId);

    if (session && (session.type === 'create_order' || session.type === 'quote_order')) {
      return handleOrderInput(event, session, text);
    }

    if (session && session.type === 'order_query') {
      return handleOrderQueryInput(event, session, text);
    }

    if (session && session.type === 'payment_verify' && session.step === 'code') {
      return handlePaymentVerifyInput(event, session, text);
    }
  } catch (err) {
    console.error('handleEvent error:', err);
    return safeReply(event.replyToken, textMessage('⚠️ 系統發生錯誤，請稍後再試。'));
  }
}

// =========================
// 文字流程
// =========================
async function handleOrderInput(event, session, text) {
  const userId = event.source.userId;

  if (session.step === 'pickup') {
    session.pickup = text;
    session.step = 'pickupPhone';
    return safeReply(event.replyToken, textMessage('請輸入取件電話：'));
  }

  if (session.step === 'pickupPhone') {
    const phone = normalizePhone(text);
    if (!isValidTaiwanPhone(phone)) {
      return safeReply(event.replyToken, textMessage('⚠️ 取件電話格式不正確，請重新輸入正確電話：'));
    }
    session.pickupPhone = phone;
    session.step = 'dropoff';
    setSession(userId, session);
    return safeReply(event.replyToken, textMessage('請輸入送達地點：'));
  }

  if (session.step === 'dropoff') {
    session.dropoff = text;
    session.step = 'dropoffPhone';
    setSession(userId, session);
    return safeReply(event.replyToken, textMessage('請輸入送達電話：'));
  }

  if (session.step === 'dropoffPhone') {
    const phone = normalizePhone(text);
    if (!isValidTaiwanPhone(phone)) {
      return safeReply(event.replyToken, textMessage('⚠️ 送達電話格式不正確，請重新輸入正確電話：'));
    }
    session.dropoffPhone = phone;
    session.step = 'item';
    setSession(userId, session);
    return safeReply(event.replyToken, textMessage('請輸入物品內容：'));
  }

  if (session.step === 'item') {
    session.item = text;
    session.step = 'urgent';
    setSession(userId, session);
    return safeReply(event.replyToken, createUrgentChoiceFlex());
  }

  if (session.step === 'urgent') {
    if (text !== '一般' && text !== '急件') {
      return safeReply(event.replyToken, createUrgentChoiceFlex());
    }
    session.isUrgent = text;
    session.step = 'note';
    setSession(userId, session);
    return safeReply(event.replyToken, textMessage('請輸入備註，若無請輸入「無」：'));
  }

  if (session.step === 'note') {
    session.note = text || '無';
    setSession(userId, session);

    await safeReply(event.replyToken, textMessage('⏳ 正在計算距離與費用，請稍候...'));

    runAsync('calculateFeesAndPushConfirm', async () => {
      try {
        const latestSession = getSession(userId);
        if (!latestSession || latestSession.step !== 'note') return;

        const fees = await calculateFees(latestSession);
        Object.assign(latestSession, fees);
        latestSession.step = 'confirm';
        setSession(userId, latestSession);

        const isQuote = latestSession.type === 'quote_order';
        await safePush(userId, createConfirmCardFlex(latestSession, isQuote ? 'quote' : 'create'));
      } catch (err) {
        console.error('calculateFees error:', err);
        clearSession(userId);
        await safePush(userId, textMessage(`⚠️ 地址查詢失敗：${err.message}\n請重新開始建立任務。`));
      }
    });

    return;
  }

  if (session.step === 'confirm') {
    return safeReply(event.replyToken, textMessage('請直接使用下方按鈕進行確認、重新填寫或取消。'));
  }

  clearSession(userId);
  return safeReply(event.replyToken, textMessage('⚠️ 流程已重置，請重新開始。'));
}

async function handleOrderQueryInput(event, session, text) {
  const userId = event.source.userId;
  const orderId = (text || '').trim();
  const order = getOrder(orderId);

  clearSession(userId);

  if (!order) {
    return safeReply(event.replyToken, textMessage('❌ 查無此訂單，請確認訂單編號是否正確。'));
  }

  if (isAdmin(userId) || order.userId === userId) {
    return safeReply(event.replyToken, textMessage(createCustomerOrderStatusText(order)));
  }

  if (order.driverId === userId || order.pendingDriverId === userId) {
    return safeReply(event.replyToken, textMessage(createDriverOrderStatusText(order)));
  }

  return safeReply(event.replyToken, textMessage('⚠️ 您無權查看此訂單。'));
}

async function handlePaymentVerifyInput(event, session, text) {
  const userId = event.source.userId;
  const order = getOrder(session.orderId);

  if (!order) {
    clearSession(userId);
    return safeReply(event.replyToken, textMessage('❌ 訂單不存在或已失效。'));
  }

  if (order.userId !== userId) {
    clearSession(userId);
    return safeReply(event.replyToken, textMessage('⚠️ 只有此訂單客戶可以操作。'));
  }

  if (order.paymentStatus === 'paid') {
    clearSession(userId);
    return safeReply(event.replyToken, textMessage('⚠️ 此訂單已完成付款，不可重複驗證。'));
  }

  if (order.paymentStatus === 'locked') {
    clearSession(userId);
    return safeReply(event.replyToken, textMessage('⚠️ 此訂單付款驗證已鎖定，請聯繫管理者處理。'));
  }

  if (PAYMENT_VERIFY_MODE !== 'CODE') {
    clearSession(userId);
    return safeReply(event.replyToken, textMessage('⚠️ 目前付款驗證模式設定錯誤。'));
  }

  const inputCode = String(text || '').trim();
  const correctCode = String(order.paymentCode || '').trim();

  if (inputCode === correctCode) {
    clearSession(userId);
    updateOrder(order.orderId, {
      paymentStatus: 'paid',
      paidAt: new Date().toISOString(),
    });

    return replyAndRun(
      event.replyToken,
      textMessage('✅ 付款驗證成功，系統已自動派單。'),
      'paymentVerifiedDispatch',
      async () => {
        await dispatchOrder(order.orderId);
        await safePush(order.userId, createPaymentVerifiedFlex(getOrder(order.orderId)));
      }
    );
  }

  const attempts = (order.paymentAttempts || 0) + 1;
  updateOrder(order.orderId, { paymentAttempts: attempts });

  if (attempts >= PAYMENT_MAX_ATTEMPTS) {
    updateOrder(order.orderId, { paymentStatus: 'locked' });
    clearSession(userId);
    return safeReply(event.replyToken, textMessage('⚠️ 驗證失敗次數過多，此訂單已鎖定。'));
  }

  return safeReply(
    event.replyToken,
    textMessage(`⚠️ 識別碼不正確，請重新輸入。\n剩餘次數：${PAYMENT_MAX_ATTEMPTS - attempts}`)
  );
}

// =========================
// Postback
// =========================
async function handlePostback(event) {
  const data = event.postback.data || '';
  const userId = event.source.userId;

  if (data === 'action=create') {
    setSession(userId, createEmptySession(userId, 'create_order'));
    return safeReply(event.replyToken, textMessage('請輸入取件地點：'));
  }

  if (data === 'action=quote') {
    setSession(userId, createEmptySession(userId, 'quote_order'));
    return safeReply(event.replyToken, textMessage('請輸入取件地點：'));
  }

  if (data === 'action=confirmCreate') {
    const session = getSession(userId);
    if (!session || session.type !== 'create_order' || session.step !== 'confirm') {
      return safeReply(event.replyToken, textMessage('⚠️ 目前沒有可送出的任務資料。'));
    }
    return createOrderFromSession(event, session);
  }

  if (data === 'action=confirmQuoteCreate') {
    const session = getSession(userId);
    if (!session || session.type !== 'quote_order' || session.step !== 'confirm') {
      return safeReply(event.replyToken, textMessage('⚠️ 目前沒有可送出的估價資料。'));
    }
    return createOrderFromSession(event, session);
  }

  if (data === 'action=restartCreate') {
    setSession(userId, createEmptySession(userId, 'create_order'));
    return safeReply(event.replyToken, textMessage('請重新輸入取件地點：'));
  }

  if (data === 'action=restartQuote') {
    setSession(userId, createEmptySession(userId, 'quote_order'));
    return safeReply(event.replyToken, textMessage('請重新輸入取件地點：'));
  }

  if (data === 'action=cancelCreate') {
    clearSession(userId);
    return safeReply(event.replyToken, textMessage('✅ 已取消本次建立任務。'));
  }

  if (data === 'action=cancelQuote') {
    clearSession(userId);
    return safeReply(event.replyToken, textMessage('✅ 已取消本次立即估價。'));
  }

  // 付款
  if (data.startsWith('paymentMethodMenu=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;

    if (order.userId !== userId) {
      return safeReply(event.replyToken, textMessage('⚠️ 只有此訂單客戶可以操作。'));
    }
    if (order.paymentStatus === 'paid') {
      return safeReply(event.replyToken, createPaymentVerifiedFlex(order));
    }
    if (order.paymentStatus === 'locked') {
      return safeReply(event.replyToken, textMessage('⚠️ 此訂單付款驗證已鎖定。'));
    }
    return safeReply(event.replyToken, createPaymentMethodFlex(order));
  }

  if (data.startsWith('paymentMethod=')) {
    const [, orderId, method] = data.split('=');
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (order.userId !== userId) {
      return safeReply(event.replyToken, textMessage('⚠️ 只有此訂單客戶可以操作。'));
    }
    if (order.paymentStatus === 'paid') {
      return safeReply(event.replyToken, createPaymentVerifiedFlex(order));
    }
    updateOrder(orderId, { paymentMethod: method, paymentStatus: 'unpaid' });
    return safeReply(event.replyToken, createPaymentInfoFlex(getOrder(orderId)));
  }

  if (data.startsWith('paymentPaid=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (order.userId !== userId) {
      return safeReply(event.replyToken, textMessage('⚠️ 只有此訂單客戶可以操作。'));
    }
    if (!order.paymentMethod) {
      return safeReply(event.replyToken, textMessage('⚠️ 請先選擇付款方式。'));
    }
    if (order.paymentStatus === 'paid') {
      return safeReply(event.replyToken, createPaymentVerifiedFlex(order));
    }
    if (order.paymentStatus === 'locked') {
      return safeReply(event.replyToken, textMessage('⚠️ 此訂單付款驗證已鎖定。'));
    }

    updateOrder(orderId, { paymentStatus: 'pending_verify' });
    setSession(userId, { type: 'payment_verify', step: 'code', userId, orderId });

    return safeReply(
      event.replyToken,
      textMessage(`請輸入付款識別碼（訂單後 ${PAYMENT_CODE_LENGTH} 碼）。`)
    );
  }

  // 取消任務
  if (data.startsWith('cancelRequest=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (order.userId !== userId) {
      return safeReply(event.replyToken, textMessage('⚠️ 只有此訂單客戶可以操作。'));
    }
    if (order.status === 'cancelled') {
      return safeReply(event.replyToken, textMessage('⚠️ 此訂單已取消。'));
    }
    return safeReply(event.replyToken, createCancelConfirmFlex(order));
  }

  if (data.startsWith('cancelBack=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (order.userId !== userId) {
      return safeReply(event.replyToken, textMessage('⚠️ 只有此訂單客戶可以操作。'));
    }
    if (order.status === 'cancelled') {
      return safeReply(event.replyToken, createCancelledFlex(order));
    }
    if (order.paymentStatus !== 'paid') {
      return safeReply(event.replyToken, createOrderPendingPaymentFlex(order));
    }
    if (order.status === 'pending') {
      return safeReply(event.replyToken, createPaymentVerifiedFlex(order));
    }
    return safeReply(event.replyToken, createPaymentVerifiedFlex(order));
  }

  if (data.startsWith('cancelConfirm=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (order.userId !== userId) {
      return safeReply(event.replyToken, textMessage('⚠️ 只有此訂單客戶可以操作。'));
    }
    if (order.status === 'cancelled') {
      return safeReply(event.replyToken, textMessage('⚠️ 此訂單已取消。'));
    }

    const cancelFee = calculateCancelFee(order);
    if (cancelFee === null) {
      return safeReply(event.replyToken, textMessage(`⚠️ 目前訂單狀態為「${getStatusText(order.status)}」，無法取消。`));
    }

    updateOrder(orderId, {
      cancelStage: order.status,
      cancelFee,
      cancelledAt: new Date().toISOString(),
      cancelledBy: userId,
      status: 'cancelled',
      archived: true,
    });

    return replyAndRun(
      event.replyToken,
      createCancelledFlex(getOrder(orderId)),
      'cancelNotify',
      async () => {
        await safePush(
          LINE_GROUP_ID,
          textMessage(
            `⚠️ 訂單已由客戶取消\n\n訂單編號：${orderId}\n取消費：${formatCurrency(cancelFee)}\n請勿再執行此任務。`
          )
        );
        if (order.driverId) {
          await safePush(order.driverId, textMessage(`⚠️ 此單已取消\n訂單編號：${orderId}\n請停止執行此任務。`));
        }
      }
    );
  }

  // 騎手接單
  if (data.startsWith('accept=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;

    if (order.paymentStatus !== 'paid') {
      return safeReply(event.replyToken, textMessage('⚠️ 此訂單尚未完成付款驗證，暫時無法接單。'));
    }
    if (!requireStatus(event.replyToken, order, ['pending'], '接單')) return;
    if (order.abandonedBy.includes(userId)) {
      return safeReply(event.replyToken, textMessage('⚠️ 您已放棄此任務，無法再次接單。'));
    }
    if (order.driverId) {
      return safeReply(event.replyToken, textMessage('⚠️ 此任務已被其他騎手正式接單。'));
    }
    if (order.pendingDriverId && order.pendingDriverId !== userId) {
      return safeReply(event.replyToken, textMessage('⚠️ 此任務目前已有其他騎手正在確認 ETA。'));
    }

    updateOrder(orderId, {
      pendingDriverId: userId,
      pendingAcceptedAt: new Date().toISOString(),
    });

    return safeReply(event.replyToken, createETAFlex(orderId, 1));
  }

  if (data.startsWith('acceptCancel=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!isPendingDriverAuthorized(order, userId)) {
      return safeReply(event.replyToken, textMessage('⚠️ 此操作僅限目前保留中的騎手執行。'));
    }
    if (order.status !== 'pending') {
      return safeReply(event.replyToken, textMessage('⚠️ 目前狀態無法取消此次接單。'));
    }

    const abandonedBy = Array.isArray(order.abandonedBy) ? order.abandonedBy : [];
    if (!abandonedBy.includes(userId)) abandonedBy.push(userId);

    updateOrder(orderId, {
      pendingDriverId: null,
      pendingAcceptedAt: null,
      abandonedBy,
    });

    return safeReply(event.replyToken, textMessage('✅ 您已取消本次接單，訂單將繼續等待其他騎手。'));
  }

  if (data.startsWith('reject=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireStatus(event.replyToken, order, ['pending'], '放棄任務')) return;

    const abandonedBy = Array.isArray(order.abandonedBy) ? order.abandonedBy : [];
    if (!abandonedBy.includes(userId)) abandonedBy.push(userId);
    updateOrder(orderId, { abandonedBy });

    return safeReply(event.replyToken, textMessage('✅ 您已放棄此任務。'));
  }

  if (data.startsWith('etaPage2=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!isPendingDriverAuthorized(order, userId)) return safeReply(event.replyToken, textMessage('⚠️ 僅限目前保留中的騎手執行。'));
    return safeReply(event.replyToken, createETAFlex(orderId, 2));
  }

  if (data.startsWith('etaPage3=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!isPendingDriverAuthorized(order, userId)) return safeReply(event.replyToken, textMessage('⚠️ 僅限目前保留中的騎手執行。'));
    return safeReply(event.replyToken, createETAFlex(orderId, 3));
  }

  if (data.startsWith('etaPage4=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!isPendingDriverAuthorized(order, userId)) return safeReply(event.replyToken, textMessage('⚠️ 僅限目前保留中的騎手執行。'));
    return safeReply(event.replyToken, createETAFlex(orderId, 4));
  }

  if (data.startsWith('eta=')) {
    const [, orderId, min] = data.split('=');
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!isPendingDriverAuthorized(order, userId)) {
      return safeReply(event.replyToken, textMessage('⚠️ 此操作僅限目前保留中的騎手執行。'));
    }
    if (!requireStatus(event.replyToken, order, ['pending'], '設定 ETA')) return;

    updateOrder(orderId, {
      driverId: userId,
      pendingDriverId: null,
      pendingAcceptedAt: null,
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
      etaMinutes: Number(min),
    });

    return replyAndRun(
      event.replyToken,
      textMessage(`✅ 已設定 ETA，預計 ${min} 分鐘抵達取件地點。`),
      'etaNotify',
      async () => {
        await safePush(order.userId, textMessage(`✅ 已有騎手接單，預計 ${min} 分鐘抵達取件地點。`));
        await safePush(LINE_GROUP_ID, textMessage(`✅ 任務已正式接單，騎手已設定 ETA：${min} 分鐘。`));
        await safePush(LINE_GROUP_ID, createPickupActionFlex(orderId));
      }
    );
  }

  if (data.startsWith('releaseOrder=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '取消接單')) return;

    const abandonedBy = Array.isArray(order.abandonedBy) ? order.abandonedBy : [];
    if (!abandonedBy.includes(userId)) abandonedBy.push(userId);

    updateOrder(orderId, {
      driverId: null,
      pendingDriverId: null,
      pendingAcceptedAt: null,
      status: 'pending',
      etaMinutes: null,
      acceptedAt: null,
      releasedCount: (order.releasedCount || 0) + 1,
      abandonedBy,
    });

    return replyAndRun(
      event.replyToken,
      textMessage('✅ 您已取消接單，系統已重新釋出此任務。'),
      'releaseOrderNotify',
      async () => {
        await safePush(order.userId, textMessage('⚠️ 原接單騎手已取消接單，系統將重新為您安排騎手。'));
        await safePush(LINE_GROUP_ID, textMessage(`⚠️ 任務重新釋單\n訂單編號：${orderId}\n系統已重新開放派單`));
        await safePush(LINE_GROUP_ID, createGroupTaskFlex(orderId));
      }
    );
  }

  // 等候費
  if (data.startsWith('waitingFeeRequest=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (order.waitingFeeAdded) {
      return safeReply(event.replyToken, textMessage('⚠️ 此訂單已加收過等候費。'));
    }
    if (order.waitingFeeRequested) {
      return safeReply(event.replyToken, textMessage('⚠️ 此訂單已送出等候費申請，請等待客戶確認。'));
    }
    if (!['arrived_pickup'].includes(order.status)) {
      return safeReply(event.replyToken, textMessage('⚠️ 請於抵達取件地點後再申請等候費。'));
    }

    updateOrder(orderId, { waitingFeeRequested: true });

    return replyAndRun(
      event.replyToken,
      textMessage('✅ 已送出等候費申請，等待客戶確認。'),
      'waitingFeeRequestNotify',
      async () => {
        await safePush(order.userId, createWaitingFeeConfirmFlex(orderId, order.totalFee));
      }
    );
  }

  if (data.startsWith('waitingFeeApprove=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (order.userId !== userId) {
      return safeReply(event.replyToken, textMessage('⚠️ 只有此訂單客戶可以操作。'));
    }
    if (order.waitingFeeAdded) {
      return safeReply(event.replyToken, textMessage('⚠️ 此訂單已加收過等候費。'));
    }
    if (!order.waitingFeeRequested) {
      return safeReply(event.replyToken, textMessage('⚠️ 目前沒有待確認的等候費申請。'));
    }

    const newTotal = (order.totalFee || 0) + PRICING.waitingFee;
    const newDriverFee = Math.round(newTotal * PRICING.driverRate);

    updateOrder(orderId, {
      waitingFee: PRICING.waitingFee,
      totalFee: newTotal,
      driverFee: newDriverFee,
      waitingFeeAdded: true,
      waitingFeeRequested: false,
    });

    return replyAndRun(
      event.replyToken,
      createPriceSummaryFlex(getOrder(orderId), '等候費已成功加收', '以下為最新訂單費用明細'),
      'waitingFeeApproveNotify',
      async () => {
        if (order.driverId) {
          await safePush(order.driverId, textMessage('✅ 客戶已同意本次等候費申請。'));
        }
      }
    );
  }

  if (data.startsWith('waitingFeeReject=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (order.userId !== userId) {
      return safeReply(event.replyToken, textMessage('⚠️ 只有此訂單客戶可以操作。'));
    }
    if (!order.waitingFeeRequested) {
      return safeReply(event.replyToken, textMessage('⚠️ 目前沒有待確認的等候費申請。'));
    }

    updateOrder(orderId, { waitingFeeRequested: false });

    return replyAndRun(
      event.replyToken,
      textMessage('已送出：您不同意本次等候費申請。'),
      'waitingFeeRejectNotify',
      async () => {
        if (order.driverId) {
          await safePush(order.driverId, textMessage('⚠️ 客戶未同意本次等候費申請。'));
        }
      }
    );
  }

  // 任務流程
  if (data.startsWith('arrivePickup=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '已抵達')) return;

    updateOrder(orderId, {
      status: 'arrived_pickup',
      arrivedPickupAt: new Date().toISOString(),
    });

    return replyAndRun(
      event.replyToken,
      createPickupArrivedActionFlex(orderId),
      'arrivePickupNotify',
      async () => {
        await safePush(order.userId, textMessage('📍 騎手已抵達取件地點。'));
      }
    );
  }

  if (data.startsWith('picked=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['arrived_pickup'], '已取件')) return;

    updateOrder(orderId, {
      status: 'picked_up',
      pickedUpAt: new Date().toISOString(),
    });

    return replyAndRun(
      event.replyToken,
      createDropoffActionFlex(orderId),
      'pickedNotify',
      async () => {
        await safePush(order.userId, textMessage('✅ 騎手已完成取件，正在前往送達地點。'));
      }
    );
  }

  if (data.startsWith('arriveDropoff=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['picked_up'], '已抵達送達地點')) return;

    updateOrder(orderId, {
      status: 'arrived_dropoff',
      arrivedDropoffAt: new Date().toISOString(),
    });

    return replyAndRun(
      event.replyToken,
      createDropoffArrivedFlex(orderId),
      'arriveDropoffNotify',
      async () => {
        await safePush(order.userId, textMessage('📍 騎手已抵達送達地點。'));
      }
    );
  }

  if (data.startsWith('call=')) {
    const [, orderId, phone] = data.split('=');
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    return safeReply(event.replyToken, createCallFlex(phone));
  }

  if (data.startsWith('complete=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['arrived_dropoff'], '已完成')) return;

    updateOrder(orderId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      archived: true,
    });

    return replyAndRun(
      event.replyToken,
      textMessage('✅ 任務已完成。'),
      'completeNotify',
      async () => {
        await safePush(order.userId, createCompletedFlex(getOrder(orderId)));
        if (LINE_FINISH_GROUP_ID) {
          await safePush(LINE_FINISH_GROUP_ID, createFinishReportFlex(getOrder(orderId)));
        }
      }
    );
  }

  return safeReply(event.replyToken, textMessage('⚠️ 無法辨識此操作，請重新再試。'));
}

app.listen(PORT, () => {
  console.log(`✅ UBee OMS V3.8.7 PRO MAX 華麗版 running on ${PORT}`);
});
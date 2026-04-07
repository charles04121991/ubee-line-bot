require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');

const app = express();

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
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!LINE_GROUP_ID) {
  console.error('❌ 缺少 LINE_GROUP_ID');
  process.exit(1);
}

if (!GOOGLE_MAPS_API_KEY) {
  console.error('❌ 缺少 GOOGLE_MAPS_API_KEY');
  process.exit(1);
}

// ===== 表單 =====
const BUSINESS_FORM =
  'https://docs.google.com/forms/d/e/1FAIpQLScn9AGnp4FbTGg6fZt5fpiMdNEi-yL9x595bTyVFHAoJmpYlA/viewform';
const PARTNER_FORM =
  'https://docs.google.com/forms/d/e/1FAIpQLSc2qdklWuSSPw39vjfrXEakBHTI3TM_NgqMxWLAZg0ej6zvMA/viewform';

// ===== 訂單 / 會話 =====
const orders = {};
const sessions = {};

// ===== 計價設定 =====
const PRICING = {
  baseFee: 99,
  perKm: 8,
  perMinute: 2,
  serviceFee: 50,
  urgentFee: 100,
  waitingFee: 60,
};

// ===== 工具 =====
const createOrderId = () => 'OD' + Date.now();

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

function getOrder(orderId) {
  return orders[orderId] || null;
}

function getSession(userId) {
  return sessions[userId] || null;
}

function clearSession(userId) {
  delete sessions[userId];
}

function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

function isDriverAuthorized(order, userId) {
  return !!(order && order.driverId && order.driverId === userId);
}

function isPendingDriverAuthorized(order, userId) {
  return !!(order && order.pendingDriverId && order.pendingDriverId === userId);
}

function textMessage(text) {
  return { type: 'text', text };
}

function createQuickReplyMessage(text, items) {
  return {
    type: 'text',
    text,
    quickReply: {
      items,
    },
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

function qrPostback(label, data, displayText = label) {
  return {
    type: 'action',
    action: {
      type: 'postback',
      label,
      data,
      displayText,
    },
  };
}

function qrUri(label, uri) {
  return {
    type: 'action',
    action: {
      type: 'uri',
      label,
      uri,
    },
  };
}

function normalizePhone(input) {
  return (input || '').trim().replace(/[\s-]/g, '');
}

function isValidTaiwanPhone(phone) {
  return /^0\d{8,9}$/.test(phone);
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

function requireOrder(replyToken, orderId) {
  const order = getOrder(orderId);
  if (!order) {
    safeReply(replyToken, textMessage('❌ 訂單不存在、已失效，或系統已重置。'));
    return null;
  }
  return order;
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

function buildGoogleMapSearchUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function buildGoogleMapDirectionsUrl(origin, destination) {
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
    origin
  )}&destination=${encodeURIComponent(destination)}&travelmode=driving`;
}

function formatCurrency(num) {
  return `$${Math.round(num || 0)}`;
}

function formatKm(km) {
  return `${Number(km).toFixed(1)} 公里`;
}

function formatMinutes(min) {
  return `${Math.round(min)} 分鐘`;
}

function getCancelStageText(cancelStage) {
  switch (cancelStage) {
    case 'pending':
      return '待接單';
    case 'accepted':
      return '已接單';
    case 'arrived_pickup':
      return '已抵達取件地點';
    default:
      return '未知階段';
  }
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

  if (order.status === 'pending') {
    return 0;
  }

  if (order.status === 'accepted') {
    return Math.round(Math.min(Math.max(order.deliveryFee * 0.3, 60), 200));
  }

  if (order.status === 'arrived_pickup') {
    return Math.round(Math.min(Math.max(order.deliveryFee * 0.5, 100), 300));
  }

  return null;
}

function createOrderStatusText(order) {
  const driverPart = order.driverId ? `\n接單騎手：已指派` : '\n接單騎手：尚未指派';
  const etaPart = order.etaMinutes ? `\nETA：${order.etaMinutes} 分鐘` : '';
  const waitingPart = order.waitingFeeAdded ? `\n等候費：${formatCurrency(order.waitingFee)}` : '';
  const cancelPart = order.status === 'cancelled' ? `\n取消費：${formatCurrency(order.cancelFee)}` : '';

  return (
    `📦 訂單查詢結果\n\n` +
    `訂單編號：${order.orderId}\n` +
    `目前狀態：${getStatusText(order.status)}\n` +
    `取件地點：${order.pickup}\n` +
    `送達地點：${order.dropoff}\n` +
    `物品內容：${order.item}\n` +
    `任務類型：${order.isUrgent}\n` +
    `訂單總額：${formatCurrency(order.totalFee)}` +
    driverPart +
    etaPart +
    waitingPart +
    cancelPart
  );
}

async function getDistanceAndDuration(origin, destination) {
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

  const distanceMeters = element.distance.value;
  const durationSeconds = element.duration.value;

  const distanceKm = distanceMeters / 1000;
  const durationMin = durationSeconds / 60;

  return {
    distanceKm,
    durationMin,
    distanceText: element.distance.text,
    durationText: element.duration.text,
  };
}

// ===== 計價 =====
async function calculateFees(session) {
  const route = await getDistanceAndDuration(session.pickup, session.dropoff);

  const distanceFee = Math.ceil(route.distanceKm) * PRICING.perKm;
  const timeFee = Math.ceil(route.durationMin) * PRICING.perMinute;
  const deliveryFee = PRICING.baseFee + distanceFee + timeFee;
  const serviceFee = PRICING.serviceFee;
  const urgentFee = session.isUrgent === '急件' ? PRICING.urgentFee : 0;
  const waitingFee = session.needWaitingFee ? PRICING.waitingFee : 0;
  const totalFee = deliveryFee + serviceFee + urgentFee + waitingFee;
  const driverFee = Math.round(totalFee * 0.6);

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
    needWaitingFee: false,

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

// ===== Flex 共用 =====
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
        color: '#7A7A7A',
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
        align: 'end',
        color,
        weight,
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
          {
            type: 'text',
            text: title,
            color: '#FFFFFF',
            weight: 'bold',
            size: 'lg',
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
            text: subtitle,
            wrap: true,
            size: 'sm',
            color: '#333333',
          },
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
          {
            type: 'text',
            text: title,
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'text',
            text: subtitle,
            color: '#D9D9D9',
            size: 'sm',
            margin: 'sm',
          },
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
              createPriceRow(
                '急件費',
                formatCurrency(order.urgentFee),
                order.urgentFee > 0 ? '#D32F2F' : '#111111'
              ),
              createPriceRow(
                '等候費',
                formatCurrency(order.waitingFee),
                order.waitingFee > 0 ? '#D32F2F' : '#111111'
              ),
              ...(showCancelFee
                ? [
                    createPriceRow(
                      '取消費',
                      formatCurrency(order.cancelFee),
                      '#D32F2F',
                      'bold'
                    ),
                  ]
                : []),
            ],
          },
          { type: 'separator' },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: '總計',
                weight: 'bold',
                size: 'lg',
                color: '#111111',
              },
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
          {
            type: 'text',
            text: '✅ 任務已完成',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'text',
            text: '感謝您使用 UBee 城市任務服務',
            color: '#D9D9D9',
            size: 'sm',
            margin: 'sm',
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
          createInfoRow('最終金額', formatCurrency(order.totalFee), '#111111'),
        ],
      },
    },
  };
}

function createOrderCreatedFlex(order) {
  return {
    type: 'flex',
    altText: '任務已建立成功',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: '✅ 任務已建立',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'text',
            text: '系統正在安排騎手',
            color: '#D9D9D9',
            size: 'sm',
            margin: 'sm',
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
          {
            type: 'text',
            text: '提醒：若任務進入派送階段後取消，系統將依訂單狀態酌收取消費。',
            wrap: true,
            size: 'xs',
            color: '#D32F2F',
            margin: 'md',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [createActionButton('取消任務', `cancelRequest=${order.orderId}`, 'secondary')],
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
          {
            type: 'text',
            text: '取消任務確認',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'text',
            text: '請確認是否要取消本次任務',
            color: '#D9D9D9',
            size: 'sm',
            margin: 'sm',
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
          createInfoRow('目前狀態', getStatusText(order.status)),
          createInfoRow('取件地點', order.pickup),
          createInfoRow('送達地點', order.dropoff),
          {
            type: 'text',
            text: getCancelRuleText(order.status),
            wrap: true,
            size: 'sm',
            color: '#333333',
          },
          {
            type: 'text',
            text:
              cancelFee === null
                ? '此階段無法取消'
                : `本次取消費：${formatCurrency(cancelFee)}`,
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
          {
            type: 'text',
            text: '⚠️ 任務已取消',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'text',
            text: '以下為本次取消資訊',
            color: '#D9D9D9',
            size: 'sm',
            margin: 'sm',
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
          createInfoRow('取消階段', getCancelStageText(order.cancelStage)),
          createInfoRow('取件地點', order.pickup),
          createInfoRow('送達地點', order.dropoff),
          createInfoRow('取消費', formatCurrency(order.cancelFee), '#D32F2F'),
        ],
      },
    },
  };
}

// ===== Flex 畫面 =====
function createMainMenuFlex() {
  return {
    type: 'flex',
    altText: 'UBee 主選單',
    contents: {
      type: 'bubble',
      size: 'mega',
      hero: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '20px',
        contents: [
          {
            type: 'text',
            text: 'UBee',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xxl',
          },
          {
            type: 'text',
            text: '城市任務服務',
            color: '#F4C542',
            size: 'sm',
            margin: 'sm',
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
    altText: 'UBee｜任務建立',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: 'UBee｜任務建立',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'lg',
          },
          {
            type: 'text',
            text: '快速建立您的城市任務',
            color: '#D9D9D9',
            size: 'sm',
            margin: 'sm',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: '請選擇您要進行的操作',
            wrap: true,
            size: 'sm',
            color: '#333333',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createActionButton('建立任務', 'action=create', 'primary', '#111111'),
          createActionButton('立即估價', 'action=quote', 'secondary'),
          createMessageButton('查詢訂單', '查詢訂單', 'secondary'),
          createMessageButton('計費說明', '計費說明', 'secondary'),
          createMessageButton('取消規則', '取消規則', 'secondary'),
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
          {
            type: 'text',
            text: 'UBee｜企業服務',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'lg',
          },
          {
            type: 'text',
            text: '企業合作與服務資訊',
            color: '#D9D9D9',
            size: 'sm',
            margin: 'sm',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: '專為企業打造的城市任務解決方案',
            wrap: true,
            size: 'sm',
            color: '#333333',
          },
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
    altText: 'UBee｜個人中心',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: 'UBee｜個人中心',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'lg',
          },
          {
            type: 'text',
            text: '查看服務資訊與夥伴申請',
            color: '#D9D9D9',
            size: 'sm',
            margin: 'sm',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: '請選擇您要查看的內容',
            wrap: true,
            size: 'sm',
            color: '#333333',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createMessageButton('查詢訂單', '查詢訂單', 'primary', '#111111'),
          createMessageButton('服務說明', '服務說明', 'secondary'),
          createMessageButton('常見問題', '常見問題', 'secondary'),
          createUriButton('加入夥伴', PARTNER_FORM, 'secondary'),
          createMessageButton('聯絡我們', '聯絡我們', 'secondary'),
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
          {
            type: 'text',
            text: '任務資訊確認',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'text',
            text: '請確認內容與費用',
            color: '#D9D9D9',
            size: 'sm',
            margin: 'sm',
          },
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
          {
            type: 'separator',
          },
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
              createPriceRow(
                '等候費',
                formatCurrency(session.waitingFee),
                session.waitingFee > 0 ? '#D32F2F' : '#111111'
              ),
            ],
          },
          {
            type: 'separator',
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: '總計',
                weight: 'bold',
                size: 'lg',
                color: '#111111',
              },
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
          {
            type: 'text',
            text: '📦 UBee 新任務',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'text',
            text: `訂單編號：${order.orderId}`,
            color: '#D9D9D9',
            size: 'sm',
            margin: 'sm',
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
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#FFF8E1',
            cornerRadius: '10px',
            paddingAll: '12px',
            contents: [
              {
                type: 'text',
                text: `費用：${formatCurrency(order.driverFee)}`,
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
  const pageMap = {
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

  return createSimpleFlex(
    `選擇 ETA（${page}/4）`,
    '請選擇預計抵達取件地點時間',
    pageMap[page],
    '#111111'
  );
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
        contents: [
          {
            type: 'text',
            text: '是否為急件？',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: '請選擇本次任務是否為急件',
            wrap: true,
            size: 'sm',
            color: '#333333',
          },
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
      createUriButton(
        '導航送達地點',
        buildGoogleMapDirectionsUrl(order.pickup, order.dropoff),
        'primary',
        '#111111'
      ),
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
  return createSimpleFlex(
    '聯絡收件人',
    `請點擊下方按鈕撥打電話\n\n電話：${phone}`,
    [createUriButton('📞 撥打', `tel:${phone}`, 'primary', '#111111')],
    '#111111'
  );
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
          {
            type: 'text',
            text: '等候費確認',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'text',
            text: '請確認是否同意本次等候費申請',
            color: '#D9D9D9',
            size: 'sm',
            margin: 'sm',
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
            text: '騎手目前於現場等候中，申請加收等候費 $60。',
            wrap: true,
            size: 'sm',
            color: '#333333',
          },
          {
            type: 'text',
            text: `目前訂單金額：${formatCurrency(currentTotal)}`,
            weight: 'bold',
            size: 'md',
            margin: 'md',
          },
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

// ===== 建立正式訂單 =====
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
    needWaitingFee: session.needWaitingFee,

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

    waitingFee: session.waitingFee,
    waitingFeeAdded: false,
    waitingFeeRequested: false,

    totalFee: session.totalFee,
    driverFee: session.driverFee,

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
    abandonedBy: [],
  };

  clearSession(session.userId);

  await safePush(LINE_GROUP_ID, createGroupTaskFlex(orderId));

  return safeReply(event.replyToken, createOrderCreatedFlex(orders[orderId]));
}

// ===== 路由 =====
app.get('/', (req, res) => {
  res.status(200).send('UBee OMS V3.8.5 FAST PRO Running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error('webhook error:', err);
    res.sendStatus(500);
  }
});

// ===== 主邏輯 =====
async function handleEvent(event) {
  try {
    if (event.type === 'postback') {
      return handlePostback(event);
    }

    if (event.type !== 'message' || event.message.type !== 'text') {
      return;
    }

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
        textMessage(
          '聯絡我們\n\n' +
            '如需企業合作、任務協助或其他問題，請直接透過本官方帳號留言，我們將儘快與您聯繫。'
        )
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
      sessions[userId] = {
        type: 'order_query',
        step: 'orderId',
        userId,
      };
      return safeReply(event.replyToken, textMessage('請輸入訂單編號，例如：OD1712345678901'));
    }

    if (text.startsWith('查單 ')) {
      const orderId = text.replace('查單 ', '').trim();
      const order = getOrder(orderId);

      if (!isAdmin(userId)) {
        return safeReply(event.replyToken, textMessage('⚠️ 此功能僅限管理者使用。'));
      }

      if (!order) {
        return safeReply(event.replyToken, textMessage('❌ 查無此訂單。'));
      }

      return safeReply(event.replyToken, textMessage(createOrderStatusText(order)));
    }

    const session = getSession(userId);

    if (session && (session.type === 'create_order' || session.type === 'quote_order')) {
      return handleOrderInput(event, session, text);
    }

    if (session && session.type === 'order_query') {
      return handleOrderQueryInput(event, session, text);
    }
  } catch (err) {
    console.error('handleEvent error:', err);
    return safeReply(event.replyToken, textMessage('⚠️ 系統發生錯誤，請稍後再試。'));
  }
}

// ===== 建立任務 / 立即估價 共用引導 =====
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
      return safeReply(
        event.replyToken,
        textMessage('⚠️ 取件電話格式不正確，請重新輸入正確電話：')
      );
    }

    session.pickupPhone = phone;
    session.step = 'dropoff';
    return safeReply(event.replyToken, textMessage('請輸入送達地點：'));
  }

  if (session.step === 'dropoff') {
    session.dropoff = text;
    session.step = 'dropoffPhone';
    return safeReply(event.replyToken, textMessage('請輸入送達電話：'));
  }

  if (session.step === 'dropoffPhone') {
    const phone = normalizePhone(text);
    if (!isValidTaiwanPhone(phone)) {
      return safeReply(
        event.replyToken,
        textMessage('⚠️ 送達電話格式不正確，請重新輸入正確電話：')
      );
    }

    session.dropoffPhone = phone;
    session.step = 'item';
    return safeReply(event.replyToken, textMessage('請輸入物品內容：'));
  }

  if (session.step === 'item') {
    session.item = text;
    session.step = 'urgent';
    return safeReply(event.replyToken, createUrgentChoiceFlex());
  }

  if (session.step === 'urgent') {
    if (text !== '一般' && text !== '急件') {
      return safeReply(event.replyToken, createUrgentChoiceFlex());
    }

    session.isUrgent = text;
    session.step = 'note';
    return safeReply(event.replyToken, textMessage('請輸入備註，若無請輸入「無」：'));
  }

  if (session.step === 'note') {
    session.note = text || '無';

    try {
      const fees = await calculateFees(session);
      session.distanceKm = fees.distanceKm;
      session.durationMin = fees.durationMin;
      session.distanceText = fees.distanceText;
      session.durationText = fees.durationText;
      session.baseFee = fees.baseFee;
      session.distanceFee = fees.distanceFee;
      session.timeFee = fees.timeFee;
      session.deliveryFee = fees.deliveryFee;
      session.serviceFee = fees.serviceFee;
      session.urgentFee = fees.urgentFee;
      session.waitingFee = fees.waitingFee;
      session.totalFee = fees.totalFee;
      session.driverFee = fees.driverFee;
      session.step = 'confirm';

      const isQuote = session.type === 'quote_order';

      return safeReply(
        event.replyToken,
        createConfirmCardFlex(session, isQuote ? 'quote' : 'create')
      );
    } catch (err) {
      console.error('calculateFees error:', err);
      clearSession(userId);
      return safeReply(
        event.replyToken,
        textMessage(`⚠️ 地址查詢失敗：${err.message}\n請重新開始建立任務。`)
      );
    }
  }

  if (session.step === 'confirm') {
    return safeReply(
      event.replyToken,
      textMessage('請直接使用下方按鈕進行確認、重新填寫或取消。')
    );
  }

  clearSession(userId);
  return safeReply(event.replyToken, textMessage('⚠️ 流程已重置，請重新開始。'));
}

async function handleOrderQueryInput(event, session, text) {
  const userId = event.source.userId;
  const orderId = (text || '').trim();
  const order = getOrder(orderId);

  if (!order) {
    clearSession(userId);
    return safeReply(event.replyToken, textMessage('❌ 查無此訂單，請確認訂單編號是否正確。'));
  }

  const canView =
    order.userId === userId ||
    order.driverId === userId ||
    order.pendingDriverId === userId ||
    isAdmin(userId);

  clearSession(userId);

  if (!canView) {
    return safeReply(event.replyToken, textMessage('⚠️ 您無權查看此訂單。'));
  }

  return safeReply(event.replyToken, textMessage(createOrderStatusText(order)));
}

// ===== Postback =====
async function handlePostback(event) {
  const data = event.postback.data || '';
  const userId = event.source.userId;

  if (data === 'action=create') {
    sessions[userId] = createEmptySession(userId, 'create_order');
    return safeReply(event.replyToken, textMessage('請輸入取件地點：'));
  }

  if (data === 'action=quote') {
    sessions[userId] = createEmptySession(userId, 'quote_order');
    return safeReply(event.replyToken, textMessage('請輸入取件地點：'));
  }

  if (data === 'action=confirmCreate') {
    const session = getSession(userId);
    if (!session || session.type !== 'create_order' || session.step !== 'confirm') {
      return safeReply(event.replyToken, textMessage('⚠️ 目前沒有可送出的任務資料，請重新建立任務。'));
    }
    return createOrderFromSession(event, session);
  }

  if (data === 'action=confirmQuoteCreate') {
    const session = getSession(userId);
    if (!session || session.type !== 'quote_order' || session.step !== 'confirm') {
      return safeReply(event.replyToken, textMessage('⚠️ 目前沒有可送出的估價資料，請重新操作。'));
    }
    return createOrderFromSession(event, session);
  }

  if (data === 'action=restartCreate') {
    sessions[userId] = createEmptySession(userId, 'create_order');
    return safeReply(event.replyToken, textMessage('請重新輸入取件地點：'));
  }

  if (data === 'action=restartQuote') {
    sessions[userId] = createEmptySession(userId, 'quote_order');
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

  // ===== 客戶取消任務 =====
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

    return safeReply(event.replyToken, createOrderCreatedFlex(order));
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

    const originalStatus = order.status;
    const cancelFee = calculateCancelFee(order);

    if (cancelFee === null) {
      return safeReply(
        event.replyToken,
        textMessage(`⚠️ 目前訂單狀態為「${getStatusText(order.status)}」，無法取消。`)
      );
    }

    order.cancelStage = originalStatus;
    order.cancelFee = cancelFee;
    order.cancelledAt = new Date().toISOString();
    order.cancelledBy = userId;
    order.status = 'cancelled';

    await safePush(
      LINE_GROUP_ID,
      textMessage(
        `⚠️ 訂單已由客戶取消\n\n` +
          `訂單編號：${order.orderId}\n` +
          `取消階段：${getCancelStageText(order.cancelStage)}\n` +
          `取消費：${formatCurrency(order.cancelFee)}\n` +
          `請勿再執行此任務。`
      )
    );

    if (order.driverId) {
      await safePush(
        order.driverId,
        textMessage(
          `⚠️ 此單已取消\n` +
            `訂單編號：${order.orderId}\n` +
            `取消費：${formatCurrency(order.cancelFee)}\n` +
            `請停止前往或停止執行此任務。`
        )
      );
    }

    return safeReply(event.replyToken, createCancelledFlex(order));
  }

  // ===== 騎手接單（先保留，再選 ETA，選完才正式接單）=====
  if (data.startsWith('accept=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;

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

    order.pendingDriverId = userId;
    order.pendingAcceptedAt = new Date().toISOString();

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

    order.pendingDriverId = null;
    order.pendingAcceptedAt = null;

    if (!order.abandonedBy.includes(userId)) {
      order.abandonedBy.push(userId);
    }

    return safeReply(event.replyToken, textMessage('✅ 您已取消本次接單，訂單將繼續等待其他騎手。'));
  }

  if (data.startsWith('reject=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;

    if (!requireStatus(event.replyToken, order, ['pending'], '放棄任務')) return;

    if (!order.abandonedBy.includes(userId)) {
      order.abandonedBy.push(userId);
    }

    return safeReply(event.replyToken, textMessage('✅ 您已放棄此任務。'));
  }

  if (data.startsWith('etaPage2=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;

    if (!isPendingDriverAuthorized(order, userId)) {
      return safeReply(event.replyToken, textMessage('⚠️ 此操作僅限目前保留中的騎手執行。'));
    }

    if (!requireStatus(event.replyToken, order, ['pending'], '查看 ETA')) return;

    return safeReply(event.replyToken, createETAFlex(orderId, 2));
  }

  if (data.startsWith('etaPage3=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;

    if (!isPendingDriverAuthorized(order, userId)) {
      return safeReply(event.replyToken, textMessage('⚠️ 此操作僅限目前保留中的騎手執行。'));
    }

    if (!requireStatus(event.replyToken, order, ['pending'], '查看 ETA')) return;

    return safeReply(event.replyToken, createETAFlex(orderId, 3));
  }

  if (data.startsWith('etaPage4=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;

    if (!isPendingDriverAuthorized(order, userId)) {
      return safeReply(event.replyToken, textMessage('⚠️ 此操作僅限目前保留中的騎手執行。'));
    }

    if (!requireStatus(event.replyToken, order, ['pending'], '查看 ETA')) return;

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

    order.driverId = userId;
    order.pendingDriverId = null;
    order.pendingAcceptedAt = null;
    order.status = 'accepted';
    order.acceptedAt = new Date().toISOString();
    order.etaMinutes = min;

    await safePush(order.userId, textMessage(`✅ 已有騎手接單，預計 ${min} 分鐘抵達取件地點。`));
    await safePush(LINE_GROUP_ID, textMessage(`✅ 任務已正式接單，騎手已設定 ETA：${min} 分鐘。`));
    await safePush(LINE_GROUP_ID, createPickupActionFlex(orderId));

    return safeReply(event.replyToken, textMessage(`✅ 已設定 ETA，預計 ${min} 分鐘抵達取件地點。`));
  }

  if (data.startsWith('releaseOrder=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;

    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '取消接單')) return;

    order.driverId = null;
    order.pendingDriverId = null;
    order.pendingAcceptedAt = null;
    order.status = 'pending';
    order.etaMinutes = null;
    order.acceptedAt = null;
    order.releasedCount = (order.releasedCount || 0) + 1;

    if (!order.abandonedBy.includes(userId)) {
      order.abandonedBy.push(userId);
    }

    await safePush(
      order.userId,
      textMessage('⚠️ 原接單騎手已取消接單，系統將重新為您安排騎手。')
    );

    await safePush(
      LINE_GROUP_ID,
      textMessage(
        `⚠️ 任務重新釋單\n` +
          `訂單編號：${order.orderId}\n` +
          `原因：原接單騎手取消接單\n` +
          `系統已重新開放派單`
      )
    );

    await safePush(LINE_GROUP_ID, createGroupTaskFlex(orderId));

    return safeReply(event.replyToken, textMessage('✅ 您已取消接單，系統已重新釋出此任務。'));
  }

  // ===== 等候費 =====
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

    order.waitingFeeRequested = true;

    await safePush(order.userId, createWaitingFeeConfirmFlex(orderId, order.totalFee));

    return safeReply(event.replyToken, textMessage('✅ 已送出等候費申請，等待客戶確認。'));
  }

  if (data.startsWith('waitingFeeApprove=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;

    if (event.source.userId !== order.userId) {
      return safeReply(event.replyToken, textMessage('⚠️ 只有此訂單客戶可以操作。'));
    }

    if (order.waitingFeeAdded) {
      return safeReply(event.replyToken, textMessage('⚠️ 此訂單已加收過等候費。'));
    }

    if (!order.waitingFeeRequested) {
      return safeReply(event.replyToken, textMessage('⚠️ 目前沒有待確認的等候費申請。'));
    }

    order.waitingFee = PRICING.waitingFee;
    order.totalFee += PRICING.waitingFee;
    order.driverFee = Math.round(order.totalFee * 0.6);
    order.waitingFeeAdded = true;
    order.waitingFeeRequested = false;

    await safePush(
      LINE_GROUP_ID,
      textMessage(`✅ 客戶已同意加收等候費 $60\n目前訂單總金額：${formatCurrency(order.totalFee)}`)
    );

    await safeReply(
      event.replyToken,
      textMessage(`✅ 等候費 $60 已成功加收\n目前訂單總金額：${formatCurrency(order.totalFee)}`)
    );

    return safePush(
      order.userId,
      createPriceSummaryFlex(order, '等候費已成功加收', '以下為最新訂單費用明細')
    );
  }

  if (data.startsWith('waitingFeeReject=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;

    if (event.source.userId !== order.userId) {
      return safeReply(event.replyToken, textMessage('⚠️ 只有此訂單客戶可以操作。'));
    }

    if (!order.waitingFeeRequested) {
      return safeReply(event.replyToken, textMessage('⚠️ 目前沒有待確認的等候費申請。'));
    }

    order.waitingFeeRequested = false;

    await safePush(LINE_GROUP_ID, textMessage('⚠️ 客戶未同意本次等候費申請。'));

    return safeReply(event.replyToken, textMessage('已送出：您不同意本次等候費申請。'));
  }

  // ===== 任務流程 =====
  if (data.startsWith('arrivePickup=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '已抵達')) return;

    order.status = 'arrived_pickup';
    order.arrivedPickupAt = new Date().toISOString();

    await safePush(order.userId, textMessage('📍 騎手已抵達取件地點。'));

    return safeReply(event.replyToken, createPickupArrivedActionFlex(orderId));
  }

  if (data.startsWith('picked=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['arrived_pickup'], '已取件')) return;

    order.status = 'picked_up';
    order.pickedUpAt = new Date().toISOString();

    await safePush(order.userId, textMessage('✅ 騎手已完成取件，正在前往送達地點。'));

    return safeReply(event.replyToken, createDropoffActionFlex(orderId));
  }

  if (data.startsWith('arriveDropoff=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['picked_up'], '抵達送達地點')) return;

    order.status = 'arrived_dropoff';
    order.arrivedDropoffAt = new Date().toISOString();

    return safeReply(event.replyToken, createDropoffArrivedFlex(orderId));
  }

  if (data.startsWith('call=')) {
    const [, orderId, phone] = data.split('=');
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['arrived_dropoff'], '撥打電話')) return;

    return safeReply(event.replyToken, createCallFlex(phone));
  }

  if (data.startsWith('complete=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['arrived_dropoff'], '完成任務')) return;

    order.status = 'completed';
    order.completedAt = new Date().toISOString();

    await safePush(order.userId, createCompletedFlex(order));
    await safePush(
      LINE_GROUP_ID,
      textMessage(
        `✅ 任務已完成\n\n` +
          `訂單編號：${order.orderId}\n` +
          `取件地點：${order.pickup}\n` +
          `送達地點：${order.dropoff}\n` +
          `總計：${formatCurrency(order.totalFee)}`
      )
    );

    return safeReply(event.replyToken, textMessage('✅ 任務已完成。'));
  }
}

app.listen(PORT, () => {
  console.log(`✅ UBee OMS V3.8.5 FAST PRO running on port ${PORT}`);
});

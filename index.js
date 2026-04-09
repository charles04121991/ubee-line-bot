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
app.use(line.middleware(config));

const PORT = process.env.PORT || 3000;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID || '';
const LINE_FINISH_GROUP_ID = process.env.LINE_FINISH_GROUP_ID || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

const BUSINESS_FORM =
  'https://docs.google.com/forms/d/e/1FAIpQLScn9AGnp4FbTGg6fZt5fpiMdNEi-yL9x595bTyVFHAoJmpYlA/viewform';
const PARTNER_FORM =
  'https://docs.google.com/forms/d/e/1FAIpQLSc2qdklWuSSPw39vjfrXEakBHTI3TM_NgqMxWLAZg0ej6zvMA/viewform';

const CONTACT_TEXT =
  '📞 UBee 聯絡我們\n\n若有合作、任務、月結或其他問題，請直接透過本 LINE 官方帳號與我們聯繫。';
const SERVICE_AREA_TEXT =
  '📍 服務區域\n\n目前服務區域：\n• 豐原\n• 潭子\n• 神岡\n• 大雅\n• 北屯部分區域\n\n若超出區域，可另行評估與報價。';
const SERVICE_DESC_TEXT =
  '📘 服務說明\n\nUBee 是城市任務服務，提供文件急送、商務跑腿、行政代辦、即時配送等服務。\n\n目前不承接：餐飲外送、生鮮、危險物、違法物品。';
const ENTERPRISE_DESC_TEXT =
  '🏢 企業服務說明\n\nUBee 提供企業專屬城市任務服務，適用於：\n• 文件急送\n• 商務快送\n• 樣品遞送\n• 行政代辦\n• 固定配合配送\n\n可搭配單次任務或企業月結。';
const PRICE_DESC_TEXT =
  '💰 計費說明\n\n費用由以下項目組成：\n• 基本費\n• 距離費\n• 時間費\n• 服務費\n• 急件加價（如有）\n• 系統服務費\n• 等候費（如有）\n\n實際價格以系統估價為準。';
const CANCEL_RULE_TEXT =
  '📌 取消規則\n\n1. 任務建立後，如尚未付款，可直接取消。\n2. 付款完成後，如已派單或已有騎手接單，取消將依實際狀況評估是否收取作業費。\n3. 若騎手已到場、已取件或任務執行中取消，可能衍生等候費、空趟費或其他處理費用。';
const FAQ_TEXT =
  '❓ 常見問題\n\n1. UBee 是什麼服務？\n城市任務與商務跑腿服務。\n\n2. 目前服務區域有哪些？\n豐原、潭子、神岡、大雅、北屯部分區域。\n\n3. 如何建立任務？\n點選【下單】→【建立任務】。\n\n4. 是否可配送餐飲？\n目前不提供餐飲外送。';

const PRICING = {
  baseFee: 99,
  perKm: 6,
  perMin: 3,
  serviceFee: 50,
  urgentFee: 100,
  systemServiceFeeRate: 0.3, // 客戶端顯示為系統服務費；財務顯示為平台維護費
  waitFee: 50,
  waitMinutesThreshold: Number(process.env.WAIT_FEE_MINUTES || 3),
};

const orders = {};   // orderId -> order
const sessions = {}; // userId -> session

function nowTaipeiString() {
  return new Date().toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour12: false,
  });
}

function createOrderId() {
  const ts = Date.now().toString().slice(-10);
  const rand = Math.floor(Math.random() * 900 + 100);
  return `OD${ts}${rand}`;
}

function getUserId(event) {
  return event.source.userId || event.source.groupId || event.source.roomId || 'unknown';
}

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = {
      mode: null,
      step: null,
      data: {},
    };
  }
  return sessions[userId];
}

function resetSession(userId) {
  sessions[userId] = {
    mode: null,
    step: null,
    data: {},
  };
}

function safePhone(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function isValidTaiwanMobile(phone) {
  return /^09\d{8}$/.test(phone);
}

function roundCurrency(num) {
  return Math.round(num);
}

function calcSystemServiceFee(baseFee) {
  return roundCurrency(baseFee * PRICING.systemServiceFeeRate);
}

function calcPrice({ distanceKm, durationMin, isUrgent, crossZoneFee = 0, waitFee = 0 }) {
  const baseFee = PRICING.baseFee;
  const distanceFee = roundCurrency(distanceKm * PRICING.perKm);
  const timeFee = roundCurrency(durationMin * PRICING.perMin);
  const serviceFee = PRICING.serviceFee;
  const urgentFee = isUrgent ? PRICING.urgentFee : 0;
  const systemServiceFee = calcSystemServiceFee(baseFee);

  const subtotal =
    baseFee + distanceFee + timeFee + serviceFee + urgentFee + crossZoneFee + systemServiceFee;

  const total = subtotal + waitFee;

  return {
    baseFee,
    distanceFee,
    timeFee,
    serviceFee,
    urgentFee,
    crossZoneFee,
    systemServiceFee,       // 客戶端顯示名稱
    platformMaintenanceFee: systemServiceFee, // 財務端顯示名稱
    subtotal,
    waitFee,
    total,
  };
}

async function getDistanceAndDuration(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    // 沒有 Maps API Key 時的 fallback，避免流程中斷
    return {
      distanceKm: 5,
      durationMin: 15,
      source: 'fallback',
    };
  }

  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(destination)}` +
    `&mode=driving&language=zh-TW&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (
    !data.rows ||
    !data.rows[0] ||
    !data.rows[0].elements ||
    !data.rows[0].elements[0] ||
    data.rows[0].elements[0].status !== 'OK'
  ) {
    throw new Error('Google Maps 距離計算失敗');
  }

  const element = data.rows[0].elements[0];
  const distanceKm = Number((element.distance.value / 1000).toFixed(1));
  const durationMin = Math.ceil(element.duration.value / 60);

  return {
    distanceKm,
    durationMin,
    source: 'google',
  };
}

function buildMainMenuFlex() {
  return {
    type: 'flex',
    altText: 'UBee 主選單',
    contents: {
      type: 'bubble',
      size: 'giga',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '🐝 UBee 城市任務服務',
            weight: 'bold',
            size: 'xl',
            color: '#111111',
          },
          {
            type: 'separator',
            margin: 'md',
          },
          {
            type: 'text',
            text: '【下單】',
            weight: 'bold',
            size: 'md',
            margin: 'lg',
            color: '#F59E0B',
          },
          {
            type: 'text',
            text: '建立任務 / 立即估價 / 計費說明 / 取消規則 / 查詢訂單',
            wrap: true,
            size: 'sm',
            color: '#444444',
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              buildMenuButton('📦 下單', 'MENU_ORDER'),
            ],
          },
          {
            type: 'text',
            text: '【企業】',
            weight: 'bold',
            size: 'md',
            margin: 'lg',
            color: '#F59E0B',
          },
          {
            type: 'text',
            text: '企業合作申請 / 企業服務說明 / 服務區域 / 聯絡我們',
            wrap: true,
            size: 'sm',
            color: '#444444',
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              buildMenuButton('🏢 企業', 'MENU_ENTERPRISE'),
            ],
          },
          {
            type: 'text',
            text: '【我的】',
            weight: 'bold',
            size: 'md',
            margin: 'lg',
            color: '#F59E0B',
          },
          {
            type: 'text',
            text: '服務說明 / 聯絡我們 / 常見問題 / 加入夥伴',
            wrap: true,
            size: 'sm',
            color: '#444444',
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              buildMenuButton('👤 我的', 'MENU_MY'),
            ],
          },
        ],
      },
    },
  };
}

function buildMenuButton(label, data) {
  return {
    type: 'button',
    style: 'primary',
    height: 'sm',
    color: '#111111',
    action: {
      type: 'postback',
      label,
      data,
      displayText: label,
    },
  };
}

function buildOrderMenuFlex() {
  return {
    type: 'flex',
    altText: '下單功能',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '📦 下單服務', weight: 'bold', size: 'xl' },
          { type: 'text', text: '請選擇您要使用的功能', size: 'sm', color: '#666666' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              buildMenuButton('建立任務', 'START_CREATE_ORDER'),
              buildMenuButton('立即估價', 'START_QUOTE'),
              buildMenuButton('計費說明', 'SHOW_PRICE_DESC'),
              buildMenuButton('取消規則', 'SHOW_CANCEL_RULE'),
              buildMenuButton('查詢訂單', 'START_QUERY_ORDER'),
            ],
          },
        ],
      },
    },
  };
}

function buildEnterpriseMenuFlex() {
  return {
    type: 'flex',
    altText: '企業專區',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '🏢 企業專區', weight: 'bold', size: 'xl' },
          { type: 'text', text: '企業合作與服務資訊', size: 'sm', color: '#666666' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#111111',
                action: {
                  type: 'uri',
                  label: '企業合作申請',
                  uri: BUSINESS_FORM,
                },
              },
              buildMenuButton('企業服務說明', 'SHOW_ENTERPRISE_DESC'),
              buildMenuButton('服務區域', 'SHOW_SERVICE_AREA'),
              buildMenuButton('聯絡我們', 'SHOW_CONTACT'),
            ],
          },
        ],
      },
    },
  };
}

function buildMyMenuFlex() {
  return {
    type: 'flex',
    altText: '我的功能',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '👤 我的', weight: 'bold', size: 'xl' },
          { type: 'text', text: '服務資訊與加入夥伴', size: 'sm', color: '#666666' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              buildMenuButton('服務說明', 'SHOW_SERVICE_DESC'),
              buildMenuButton('聯絡我們', 'SHOW_CONTACT'),
              buildMenuButton('常見問題', 'SHOW_FAQ'),
              {
                type: 'button',
                style: 'primary',
                color: '#111111',
                action: {
                  type: 'uri',
                  label: '加入夥伴',
                  uri: PARTNER_FORM,
                },
              },
            ],
          },
        ],
      },
    },
  };
}

function buildUrgentFlex(mode = 'create') {
  return {
    type: 'flex',
    altText: '是否急件',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '⚡ 是否為急件？', weight: 'bold', size: 'xl' },
          { type: 'text', text: '請選擇任務類型', size: 'sm', color: '#666666' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              buildMenuButton('一般件', `SET_URGENT:${mode}:NO`),
              buildMenuButton('急件 +$100', `SET_URGENT:${mode}:YES`),
            ],
          },
        ],
      },
    },
  };
}

function buildQuoteFlex(data, pricing) {
  return {
    type: 'flex',
    altText: '任務估價明細',
    contents: {
      type: 'bubble',
      size: 'giga',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '📊 任務估價明細', weight: 'bold', size: 'xl' },

          { type: 'separator', margin: 'md' },

          infoText(`取件地點：${data.pickupAddress}`),
          ...(data.pickupPhone ? [infoText(`取件電話：${data.pickupPhone}`)] : []),
          infoText(`送達地址：${data.deliveryAddress}`),
          ...(data.deliveryPhone ? [infoText(`送達電話：${data.deliveryPhone}`)] : []),
          ...(data.itemName ? [infoText(`物品內容：${data.itemName}`)] : []),
          infoText(`是否急件：${data.isUrgent ? '是' : '否'}`),
          infoText(`距離：約 ${data.distanceKm} km`),
          infoText(`時間：約 ${data.durationMin} 分鐘`),

          { type: 'separator', margin: 'md' },

          infoText(`基本費：$${pricing.baseFee}`),
          infoText(`距離費：$${pricing.distanceFee}`),
          infoText(`時間費：$${pricing.timeFee}`),
          infoText(`服務費：$${pricing.serviceFee}`),
          ...(pricing.urgentFee > 0 ? [infoText(`急件加價：$${pricing.urgentFee}`)] : []),
          infoText(`系統服務費：$${pricing.systemServiceFee}`),

          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: `總金額：$${pricing.total}`,
            weight: 'bold',
            size: 'xl',
            color: '#F59E0B',
            margin: 'md',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          buildFooterButton('確認下單', 'CONFIRM_CREATE_ORDER'),
          buildFooterButton('重新輸入', 'RESTART_ORDER'),
        ],
      },
    },
  };
}

function infoText(text) {
  return {
    type: 'text',
    text,
    wrap: true,
    size: 'sm',
    color: '#333333',
  };
}

function buildFooterButton(label, data) {
  return {
    type: 'button',
    style: 'primary',
    height: 'sm',
    color: '#111111',
    action: {
      type: 'postback',
      label,
      data,
      displayText: label,
    },
  };
}

function buildPaymentFlex(order) {
  return {
    type: 'flex',
    altText: '請完成付款',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '💳 請完成付款', weight: 'bold', size: 'xl' },
          { type: 'text', text: `訂單編號：${order.id}`, size: 'sm', color: '#555555' },
          { type: 'text', text: `任務金額：$${order.totalAmount}`, weight: 'bold', size: 'lg', color: '#F59E0B' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              infoText('街口支付：UBee｜901871793'),
              infoText('銀行轉帳：請依您設定的帳戶資訊收款'),
              infoText('完成付款後，請點下方【我已付款】'),
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          buildFooterButton('我已付款', `PAYMENT_DONE:${order.id}`),
        ],
      },
    },
  };
}

function buildDispatchFlex(order) {
  return {
    type: 'flex',
    altText: 'UBee 任務通知',
    contents: {
      type: 'bubble',
      size: 'giga',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '📦 UBee 任務通知', weight: 'bold', size: 'xl' },
          infoText(`訂單編號：${order.id}`),
          { type: 'separator', margin: 'md' },
          infoText(`取件地點：${order.pickupAddress}`),
          infoText(`取件電話：${order.pickupPhone}`),
          infoText(`送達地址：${order.deliveryAddress}`),
          infoText(`送達電話：${order.deliveryPhone}`),
          infoText(`物品內容：${order.itemName}`),
          infoText(`是否急件：${order.isUrgent ? '是' : '否'}`),
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: `💰 任務費用：$${order.totalAmount}`,
            weight: 'bold',
            size: 'lg',
            color: '#F59E0B',
            margin: 'md',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          buildFooterButton('✅ 接受訂單', `ACCEPT_ORDER:${order.id}`),
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: '❌ 放棄任務',
              data: `REJECT_ORDER:${order.id}`,
              displayText: '❌ 放棄任務',
            },
          },
        ],
      },
    },
  };
}

function buildEtaFlex(orderId) {
  const options = [5, 10, 15, 20, 30, 45];
  return {
    type: 'flex',
    altText: 'ETA 抵達時間選擇',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '⏱ ETA 抵達時間選擇', weight: 'bold', size: 'xl' },
          { type: 'text', text: '請選擇預計幾分鐘到達取件地點', size: 'sm', color: '#666666', wrap: true },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: options.map((m) => buildMenuButton(`${m} 分鐘`, `SET_ETA:${orderId}:${m}`)),
          },
        ],
      },
    },
  };
}

function buildOrderActionFlex(orderId) {
  return {
    type: 'flex',
    altText: '任務操作',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '🛵 任務操作', weight: 'bold', size: 'xl' },
          { type: 'text', text: '請選擇任務狀態操作', size: 'sm', color: '#666666' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              buildMenuButton('📍 已抵達取件地點', `ARRIVED_PICKUP:${orderId}`),
              buildMenuButton('💰 申請等候費', `APPLY_WAIT_FEE:${orderId}`),
              buildMenuButton('📦 已取件', `PICKED_UP:${orderId}`),
              buildMenuButton('📞 聯絡取件人', `CALL_PICKUP:${orderId}`),
              buildMenuButton('📞 聯絡收件人', `CALL_RECEIVER:${orderId}`),
              buildMenuButton('✅ 已送達', `DELIVERED:${orderId}`),
            ],
          },
        ],
      },
    },
  };
}

function buildFinanceFlex(order) {
  const pricing = order.pricing;
  return {
    type: 'flex',
    altText: '任務完成明細',
    contents: {
      type: 'bubble',
      size: 'giga',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '📊 任務完成明細', weight: 'bold', size: 'xl' },
          infoText(`訂單編號：${order.id}`),
          { type: 'separator', margin: 'md' },
          infoText(`原始費用：$${pricing.subtotal}`),
          ...(pricing.urgentFee > 0 ? [infoText(`急件加價：$${pricing.urgentFee}`)] : []),
          infoText(`等候費：$${pricing.waitFee}`),
          infoText(`平台維護費：$${pricing.platformMaintenanceFee}`),
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: `總金額：$${order.totalAmount}`,
            weight: 'bold',
            size: 'lg',
            color: '#F59E0B',
          },
          infoText(`騎手收入：$${order.riderPayout}`),
          infoText(`平台收益：$${order.platformRevenue}`),
          infoText(`完成時間：${order.completedAt || nowTaipeiString()}`),
        ],
      },
    },
  };
}

async function replyText(replyToken, text) {
  return client.replyMessage(replyToken, [{ type: 'text', text }]);
}

async function replyMessages(replyToken, messages) {
  return client.replyMessage(replyToken, messages);
}

async function pushToUser(userId, messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  return client.pushMessage(userId, arr);
}

async function pushToGroup(groupId, messages) {
  if (!groupId) return;
  const arr = Array.isArray(messages) ? messages : [messages];
  return client.pushMessage(groupId, arr);
}

function buildOrderStatusText(order) {
  return [
    '📦 訂單查詢結果',
    '',
    `訂單編號：${order.id}`,
    `目前狀態：${order.statusText || order.status}`,
    `接單人員：${order.riderName || '尚未接單'}`,
    `是否急件：${order.isUrgent ? '是' : '否'}`,
    `目前費用：$${order.totalAmount}`,
  ].join('\n');
}

async function handleFollow(event) {
  return replyMessages(event.replyToken, [
    { type: 'text', text: '歡迎加入 UBee 🐝' },
    buildMainMenuFlex(),
  ]);
}

async function handlePostback(event) {
  const data = event.postback.data || '';
  const userId = getUserId(event);

  if (data === 'MENU_ORDER') {
    return replyMessages(event.replyToken, [buildOrderMenuFlex()]);
  }

  if (data === 'MENU_ENTERPRISE') {
    return replyMessages(event.replyToken, [buildEnterpriseMenuFlex()]);
  }

  if (data === 'MENU_MY') {
    return replyMessages(event.replyToken, [buildMyMenuFlex()]);
  }

  if (data === 'SHOW_PRICE_DESC') {
    return replyText(event.replyToken, PRICE_DESC_TEXT);
  }

  if (data === 'SHOW_CANCEL_RULE') {
    return replyText(event.replyToken, CANCEL_RULE_TEXT);
  }

  if (data === 'SHOW_ENTERPRISE_DESC') {
    return replyText(event.replyToken, ENTERPRISE_DESC_TEXT);
  }

  if (data === 'SHOW_SERVICE_AREA') {
    return replyText(event.replyToken, SERVICE_AREA_TEXT);
  }

  if (data === 'SHOW_CONTACT') {
    return replyText(event.replyToken, CONTACT_TEXT);
  }

  if (data === 'SHOW_SERVICE_DESC') {
    return replyText(event.replyToken, SERVICE_DESC_TEXT);
  }

  if (data === 'SHOW_FAQ') {
    return replyText(event.replyToken, FAQ_TEXT);
  }

  if (data === 'START_CREATE_ORDER') {
    const s = getSession(userId);
    s.mode = 'create';
    s.step = 'pickupAddress';
    s.data = {};
    return replyText(event.replyToken, '請輸入取件地點');
  }

  if (data === 'START_QUOTE') {
    const s = getSession(userId);
    s.mode = 'quote';
    s.step = 'pickupAddress';
    s.data = {};
    return replyText(event.replyToken, '請輸入取件地點');
  }

  if (data === 'START_QUERY_ORDER') {
    const s = getSession(userId);
    s.mode = 'query';
    s.step = 'orderId';
    s.data = {};
    return replyText(event.replyToken, '請輸入訂單編號');
  }

  if (data.startsWith('SET_URGENT:')) {
    const [, mode, flag] = data.split(':');
    const s = getSession(userId);
    s.data.isUrgent = flag === 'YES';

    try {
      const route = await getDistanceAndDuration(s.data.pickupAddress, s.data.deliveryAddress);
      s.data.distanceKm = route.distanceKm;
      s.data.durationMin = route.durationMin;

      const pricing = calcPrice({
        distanceKm: s.data.distanceKm,
        durationMin: s.data.durationMin,
        isUrgent: s.data.isUrgent,
        waitFee: 0,
      });

      s.data.pricing = pricing;

      if (mode === 'quote') {
        resetSession(userId);
        return replyMessages(event.replyToken, [buildQuoteFlex(s.data, pricing)]);
      }

      if (mode === 'create') {
        s.step = 'confirmCreate';
        return replyMessages(event.replyToken, [buildQuoteFlex(s.data, pricing)]);
      }
    } catch (err) {
      console.error(err);
      return replyText(event.replyToken, '⚠️ 距離計算失敗，請確認地址後重新嘗試。');
    }
  }

  if (data === 'RESTART_ORDER') {
    const s = getSession(userId);
    s.mode = 'create';
    s.step = 'pickupAddress';
    s.data = {};
    return replyText(event.replyToken, '請重新輸入取件地點');
  }

  if (data === 'CONFIRM_CREATE_ORDER') {
    const s = getSession(userId);
    if (!s.data || !s.data.pricing) {
      return replyText(event.replyToken, '⚠️ 找不到建立任務資料，請重新操作。');
    }

    const orderId = createOrderId();
    const order = {
      id: orderId,
      customerUserId: userId,
      pickupAddress: s.data.pickupAddress,
      pickupPhone: s.data.pickupPhone,
      deliveryAddress: s.data.deliveryAddress,
      deliveryPhone: s.data.deliveryPhone,
      itemName: s.data.itemName,
      isUrgent: !!s.data.isUrgent,
      distanceKm: s.data.distanceKm,
      durationMin: s.data.durationMin,
      pricing: { ...s.data.pricing },
      totalAmount: s.data.pricing.total,
      status: 'pending_payment',
      statusText: '等待付款',
      riderUserId: '',
      riderName: '',
      etaMinutes: null,
      arrivedPickupAt: null,
      waitFeeApplied: false,
      createdAt: nowTaipeiString(),
      completedAt: '',
      riderPayout: 0,
      platformRevenue: 0,
    };

    orders[orderId] = order;
    resetSession(userId);

    return replyMessages(event.replyToken, [
      { type: 'text', text: `✅ 已建立訂單\n訂單編號：${orderId}\n狀態：等待付款` },
      buildPaymentFlex(order),
    ]);
  }

  if (data.startsWith('PAYMENT_DONE:')) {
    const [, orderId] = data.split(':');
    const order = orders[orderId];
    if (!order) {
      return replyText(event.replyToken, '⚠️ 找不到此訂單。');
    }

    order.status = 'dispatching';
    order.statusText = '派單中';

    const messages = [
      { type: 'text', text: `✅ 付款確認成功\n🚀 正在為您派遣騎手` },
    ];

    if (LINE_GROUP_ID) {
      await pushToGroup(LINE_GROUP_ID, [buildDispatchFlex(order)]);
    }

    return replyMessages(event.replyToken, messages);
  }

  if (data.startsWith('ACCEPT_ORDER:')) {
    const [, orderId] = data.split(':');
    const order = orders[orderId];
    if (!order) {
      return replyText(event.replyToken, '⚠️ 找不到此訂單。');
    }

    if (order.riderUserId) {
      return replyText(event.replyToken, '⚠️ 此任務已被其他騎手接單。');
    }

    order.riderUserId = userId;

    try {
      const profile = await client.getProfile(userId);
      order.riderName = profile.displayName || '騎手';
    } catch (e) {
      order.riderName = '騎手';
    }

    order.status = 'accepted';
    order.statusText = '已接單';

    await pushToUser(order.customerUserId, {
      type: 'text',
      text: `🚀 已有騎手接單\n\n接單人員：${order.riderName}\n請稍候前往取件地點`,
    });

    return replyMessages(event.replyToken, [
      { type: 'text', text: `✅ 任務已接單\n接單人員：${order.riderName}` },
      buildEtaFlex(orderId),
      buildOrderActionFlex(orderId),
    ]);
  }

  if (data.startsWith('REJECT_ORDER:')) {
    const [, orderId] = data.split(':');
    const order = orders[orderId];
    if (!order) {
      return replyText(event.replyToken, '⚠️ 找不到此訂單。');
    }
    return replyText(event.replyToken, `❌ 已放棄任務\n訂單編號：${orderId}`);
  }

  if (data.startsWith('SET_ETA:')) {
    const [, orderId, minText] = data.split(':');
    const order = orders[orderId];
    if (!order) {
      return replyText(event.replyToken, '⚠️ 找不到此訂單。');
    }

    order.etaMinutes = Number(minText);
    await pushToUser(order.customerUserId, {
      type: 'text',
      text: `🚀 騎手預計 ${order.etaMinutes} 分鐘抵達取件地點`,
    });

    return replyText(event.replyToken, `⏱ ETA 已設定：${order.etaMinutes} 分鐘`);
  }

  if (data.startsWith('ARRIVED_PICKUP:')) {
    const [, orderId] = data.split(':');
    const order = orders[orderId];
    if (!order) {
      return replyText(event.replyToken, '⚠️ 找不到此訂單。');
    }

    if (order.riderUserId !== userId) {
      return replyText(event.replyToken, '⚠️ 只有接單騎手可以操作此任務。');
    }

    order.arrivedPickupAt = Date.now();
    order.status = 'arrived_pickup';
    order.statusText = '已抵達取件地點';

    await pushToUser(order.customerUserId, {
      type: 'text',
      text: '📍 騎手已抵達取件地點，正在等待取件',
    });

    return replyText(event.replyToken, '📍 騎手已抵達取件地點');
  }

  if (data.startsWith('APPLY_WAIT_FEE:')) {
    const [, orderId] = data.split(':');
    const order = orders[orderId];
    if (!order) {
      return replyText(event.replyToken, '⚠️ 找不到此訂單。');
    }

    if (order.riderUserId !== userId) {
      return replyText(event.replyToken, '⚠️ 只有接單騎手可以操作此任務。');
    }

    if (!order.arrivedPickupAt) {
      return replyText(event.replyToken, '⚠️ 請先按「已抵達取件地點」後再申請等候費。');
    }

    if (order.waitFeeApplied) {
      return replyText(event.replyToken, '⚠️ 本訂單已申請過等候費。');
    }

    if (order.status === 'picked_up' || order.status === 'delivered') {
      return replyText(event.replyToken, '⚠️ 目前任務狀態不可申請等候費。');
    }

    const waitedMinutes = (Date.now() - order.arrivedPickupAt) / 1000 / 60;
    if (waitedMinutes < PRICING.waitMinutesThreshold) {
      return replyText(
        event.replyToken,
        `⚠️ 尚未達到等候費申請條件，目前需等待超過 ${PRICING.waitMinutesThreshold} 分鐘。`
      );
    }

    order.waitFeeApplied = true;
    order.pricing.waitFee = PRICING.waitFee;
    order.totalAmount = order.pricing.subtotal + PRICING.waitFee;

    await pushToUser(order.customerUserId, {
      type: 'text',
      text: `⚠️ 騎手已在取件地點等待超過 ${PRICING.waitMinutesThreshold} 分鐘\n本次任務已加收等候費 $${PRICING.waitFee}`,
    });

    return replyText(event.replyToken, `💰 已申請等候費 $${PRICING.waitFee}`);
  }

  if (data.startsWith('PICKED_UP:')) {
    const [, orderId] = data.split(':');
    const order = orders[orderId];
    if (!order) {
      return replyText(event.replyToken, '⚠️ 找不到此訂單。');
    }

    if (order.riderUserId !== userId) {
      return replyText(event.replyToken, '⚠️ 只有接單騎手可以操作此任務。');
    }

    order.status = 'picked_up';
    order.statusText = '已取件';

    await pushToUser(order.customerUserId, {
      type: 'text',
      text: '📦 您的物品已完成取件，正在配送中',
    });

    return replyText(event.replyToken, '📦 已完成取件，前往送達地點中');
  }

  if (data.startsWith('CALL_PICKUP:')) {
    const [, orderId] = data.split(':');
    const order = orders[orderId];
    if (!order) return replyText(event.replyToken, '⚠️ 找不到此訂單。');
    return replyText(event.replyToken, `📞 取件電話：${order.pickupPhone}`);
  }

  if (data.startsWith('CALL_RECEIVER:')) {
    const [, orderId] = data.split(':');
    const order = orders[orderId];
    if (!order) return replyText(event.replyToken, '⚠️ 找不到此訂單。');
    return replyText(event.replyToken, `📞 送達電話：${order.deliveryPhone}`);
  }

  if (data.startsWith('DELIVERED:')) {
    const [, orderId] = data.split(':');
    const order = orders[orderId];
    if (!order) {
      return replyText(event.replyToken, '⚠️ 找不到此訂單。');
    }

    if (order.riderUserId !== userId) {
      return replyText(event.replyToken, '⚠️ 只有接單騎手可以操作此任務。');
    }

    order.status = 'delivered';
    order.statusText = '已完成';
    order.completedAt = nowTaipeiString();

    // 簡化版分潤邏輯：騎手收入先抓總金額的 65%
    order.riderPayout = roundCurrency(order.totalAmount * 0.65);
    order.platformRevenue = order.totalAmount - order.riderPayout;

    await pushToUser(order.customerUserId, {
      type: 'text',
      text: '🎉 任務已完成\n感謝使用 UBee',
    });

    if (LINE_FINISH_GROUP_ID) {
      await pushToGroup(LINE_FINISH_GROUP_ID, [buildFinanceFlex(order)]);
    }

    return replyText(event.replyToken, '✅ 任務已完成');
  }

  return replyText(event.replyToken, '收到操作指令。');
}

async function handleTextMessage(event) {
  const userId = getUserId(event);
  const text = (event.message.text || '').trim();
  const s = getSession(userId);

  if (text === '主選單' || text === 'menu' || text === 'MENU') {
    return replyMessages(event.replyToken, [buildMainMenuFlex()]);
  }

  if (!s.mode) {
    return replyMessages(event.replyToken, [
      { type: 'text', text: '請由主選單開始操作。' },
      buildMainMenuFlex(),
    ]);
  }

  if (s.mode === 'query' && s.step === 'orderId') {
    const order = orders[text];
    resetSession(userId);

    if (!order) {
      return replyText(event.replyToken, '⚠️ 找不到此訂單編號。');
    }
    return replyText(event.replyToken, buildOrderStatusText(order));
  }

  if (s.mode === 'create') {
    if (s.step === 'pickupAddress') {
      s.data.pickupAddress = text;
      s.step = 'pickupPhone';
      return replyText(event.replyToken, '請輸入取件電話');
    }

    if (s.step === 'pickupPhone') {
      const phone = safePhone(text);
      if (!isValidTaiwanMobile(phone)) {
        return replyText(event.replyToken, '⚠️ 取件電話格式不正確，請輸入 09 開頭的手機號碼。');
      }
      s.data.pickupPhone = phone;
      s.step = 'deliveryAddress';
      return replyText(event.replyToken, '請輸入送達地址');
    }

    if (s.step === 'deliveryAddress') {
      s.data.deliveryAddress = text;
      s.step = 'deliveryPhone';
      return replyText(event.replyToken, '請輸入送達電話');
    }

    if (s.step === 'deliveryPhone') {
      const phone = safePhone(text);
      if (!isValidTaiwanMobile(phone)) {
        return replyText(event.replyToken, '⚠️ 送達電話格式不正確，請輸入 09 開頭的手機號碼。');
      }
      s.data.deliveryPhone = phone;
      s.step = 'itemName';
      return replyText(event.replyToken, '請輸入物品內容');
    }

    if (s.step === 'itemName') {
      s.data.itemName = text;
      s.step = 'isUrgent';
      return replyMessages(event.replyToken, [buildUrgentFlex('create')]);
    }
  }

  if (s.mode === 'quote') {
    if (s.step === 'pickupAddress') {
      s.data.pickupAddress = text;
      s.step = 'deliveryAddress';
      return replyText(event.replyToken, '請輸入送達地址');
    }

    if (s.step === 'deliveryAddress') {
      s.data.deliveryAddress = text;
      s.step = 'itemName';
      return replyText(event.replyToken, '請輸入物品內容');
    }

    if (s.step === 'itemName') {
      s.data.itemName = text;
      s.step = 'isUrgent';
      return replyMessages(event.replyToken, [buildUrgentFlex('quote')]);
    }
  }

  return replyText(event.replyToken, '⚠️ 目前流程無法辨識，請重新從主選單操作。');
}

async function handleEvent(event) {
  try {
    if (event.type === 'follow') {
      return handleFollow(event);
    }

    if (event.type === 'postback') {
      return handlePostback(event);
    }

    if (event.type === 'message' && event.message.type === 'text') {
      return handleTextMessage(event);
    }

    return Promise.resolve(null);
  } catch (error) {
    console.error('❌ handleEvent error:', error);
    if (event.replyToken) {
      return replyText(event.replyToken, '⚠️ 系統忙碌中，請稍後再試。');
    }
    return null;
  }
}

app.post('/webhook', (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error('❌ webhook error:', err);
      res.status(500).end();
    });
});

app.get('/', (_, res) => {
  res.send('UBee OMS V3.8.7 PRO MAX is running');
});

app.listen(PORT, () => {
  console.log(`✅ UBee OMS V3.8.7 PRO MAX running on port ${PORT}`);
});

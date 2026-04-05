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

const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const PORT = process.env.PORT || 3000;

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

// ===== 品牌色 =====
const BRAND = {
  black: '#111111',
  gold: '#F4B400',
  goldDark: '#D89B00',
  white: '#FFFFFF',
  text: '#222222',
  subtext: '#777777',
  border: '#EAEAEA',
  bgSoft: '#FFF8E8',
  green: '#16A34A',
  red: '#DC2626',
};

// ===== 工具 =====
const createOrderId = () => 'OD' + Date.now();

function safeReply(replyToken, message) {
  return client.replyMessage(replyToken, message).catch(err => {
    console.error('replyMessage error:', err?.originalError || err);
  });
}

function safePush(to, message) {
  return client.pushMessage(to, message).catch(err => {
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

function isDriverAuthorized(order, userId) {
  return !!(order && order.driverId && order.driverId === userId);
}

function textMessage(text) {
  return { type: 'text', text };
}

function normalizePhone(input) {
  return (input || '').trim();
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
    safeReply(replyToken, textMessage('❌ 訂單不存在或已失效'));
    return null;
  }
  return order;
}

function requireDriver(replyToken, order, userId) {
  if (!isDriverAuthorized(order, userId)) {
    safeReply(replyToken, textMessage('⚠️ 只有接單騎手可以操作此按鈕'));
    return false;
  }
  return true;
}

function requireStatus(replyToken, order, allowedStatuses, actionName) {
  if (!allowedStatuses.includes(order.status)) {
    safeReply(
      replyToken,
      textMessage(`⚠️ 目前訂單狀態為「${getStatusText(order.status)}」，不能執行${actionName}`)
    );
    return false;
  }
  return true;
}

function buildGoogleMapSearchUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function formatKm(km) {
  return Number(km || 0).toFixed(1);
}

function formatMinutes(min) {
  return String(Math.max(1, Math.round(Number(min || 0))));
}

function formatMoney(num) {
  return `$${Math.round(Number(num || 0))}`;
}

// ===== Google Maps API =====
async function geocodeAddress(address) {
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.results || !data.results.length) {
    throw new Error('找不到此地址，請輸入更完整的地址');
  }

  return {
    formattedAddress: data.results[0].formatted_address,
    location: data.results[0].geometry.location,
  };
}

async function getDistanceAndDuration(origin, destination) {
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&language=zh-TW&units=metric&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  const row = data.rows && data.rows[0];
  const element = row && row.elements && row.elements[0];

  if (!element || element.status !== 'OK') {
    throw new Error('距離計算失敗，請確認地址是否完整');
  }

  const distanceMeters = element.distance.value || 0;
  const durationSeconds = element.duration.value || 0;

  return {
    distanceKm: distanceMeters / 1000,
    durationMinutes: durationSeconds / 60,
    distanceText: element.distance.text,
    durationText: element.duration.text,
  };
}

// ===== 計價 =====
async function calculateFees(session) {
  const route = await getDistanceAndDuration(session.pickup, session.dropoff);

  const distanceKm = Math.max(1, Math.ceil(route.distanceKm));
  const durationMinutes = Math.max(1, Math.ceil(route.durationMinutes));

  const baseFee = PRICING.baseFee;
  const distanceFee = distanceKm * PRICING.perKm;
  const timeFee = durationMinutes * PRICING.perMinute;
  const serviceFee = PRICING.serviceFee;
  const urgentFee = session.isUrgent === '急件' ? PRICING.urgentFee : 0;
  const waitingFee = session.needWaiting === '需要等候' ? PRICING.waitingFee : 0;

  const deliveryFee = baseFee + distanceFee + timeFee;
  const totalFee = deliveryFee + serviceFee + urgentFee + waitingFee;

  // 可自行再調整騎手拆帳比例
  const driverFee = Math.round(totalFee * 0.65);

  return {
    baseFee,
    distanceFee,
    timeFee,
    deliveryFee,
    serviceFee,
    urgentFee,
    waitingFee,
    totalFee,
    driverFee,
    distanceKm,
    durationMinutes,
    distanceText: route.distanceText,
    durationText: route.durationText,
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
    needWaiting: '',
    note: '',
    baseFee: 0,
    distanceFee: 0,
    timeFee: 0,
    deliveryFee: 0,
    serviceFee: 0,
    urgentFee: 0,
    waitingFee: 0,
    totalFee: 0,
    driverFee: 0,
    distanceKm: 0,
    durationMinutes: 0,
    distanceText: '',
    durationText: '',
  };
}

// ===== Flex 共用元件 =====
function createActionButton(label, data, style = 'primary', color) {
  const btn = {
    type: 'button',
    style,
    height: 'sm',
    action: {
      type: 'postback',
      label,
      data
    }
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
      uri
    }
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
      text
    }
  };
  if (color) btn.color = color;
  return btn;
}

function createInfoRow(label, value, color = BRAND.text) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'md',
    contents: [
      {
        type: 'text',
        text: label,
        size: 'sm',
        color: BRAND.subtext,
        flex: 3
      },
      {
        type: 'text',
        text: value || '無',
        size: 'sm',
        color,
        wrap: true,
        flex: 7
      }
    ]
  };
}

function createPriceRow(label, value, isBold = false, color = BRAND.text) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      {
        type: 'text',
        text: label,
        size: 'sm',
        color: isBold ? BRAND.black : BRAND.subtext,
        weight: isBold ? 'bold' : 'regular',
        flex: 6
      },
      {
        type: 'text',
        text: value,
        size: 'sm',
        color,
        weight: isBold ? 'bold' : 'regular',
        align: 'end',
        flex: 4
      }
    ]
  };
}

function createTag(text, color = BRAND.gold) {
  return {
    type: 'box',
    layout: 'vertical',
    cornerRadius: '12px',
    paddingTop: '4px',
    paddingBottom: '4px',
    paddingStart: '10px',
    paddingEnd: '10px',
    backgroundColor: color,
    contents: [
      {
        type: 'text',
        text,
        size: 'xs',
        color: '#000000',
        weight: 'bold',
        align: 'center'
      }
    ]
  };
}

function createPrettyCard({
  altText,
  title,
  subtitle,
  bodyContents = [],
  footerButtons = [],
  tagText = 'UBee',
  tagColor = BRAND.gold
}) {
  return {
    type: 'flex',
    altText,
    contents: {
      type: 'bubble',
      size: 'giga',
      styles: {
        body: {
          backgroundColor: '#FFFFFF'
        },
        footer: {
          separator: true
        }
      },
      hero: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '18px',
        backgroundColor: BRAND.black,
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              createTag(tagText, tagColor)
            ]
          },
          {
            type: 'text',
            text: title,
            color: BRAND.white,
            weight: 'bold',
            size: 'xl',
            margin: 'md',
            wrap: true
          },
          {
            type: 'text',
            text: subtitle,
            color: '#E5E5E5',
            size: 'sm',
            margin: 'sm',
            wrap: true
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: bodyContents
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '14px',
        contents: footerButtons
      }
    }
  };
}

// ===== Flex 畫面 =====
function createMainMenuFlex() {
  return createPrettyCard({
    altText: 'UBee 主選單',
    title: 'UBee 主選單',
    subtitle: '城市任務服務入口',
    bodyContents: [
      {
        type: 'text',
        text: '請選擇您要使用的功能',
        size: 'sm',
        color: BRAND.text,
        wrap: true
      }
    ],
    footerButtons: [
      createMessageButton('下單', '下單', 'primary', BRAND.goldDark),
      createMessageButton('企業', '企業', 'secondary'),
      createMessageButton('我的', '我的', 'secondary')
    ]
  });
}

function createOrderMenuFlex() {
  return createPrettyCard({
    altText: '下單',
    title: '任務下單',
    subtitle: '建立任務或先快速估價',
    bodyContents: [
      createInfoRow('基本費', formatMoney(PRICING.baseFee)),
      createInfoRow('每公里', formatMoney(PRICING.perKm)),
      createInfoRow('每分鐘', formatMoney(PRICING.perMinute)),
      createInfoRow('服務費', formatMoney(PRICING.serviceFee)),
      createInfoRow('急件費', formatMoney(PRICING.urgentFee)),
      createInfoRow('等候費', formatMoney(PRICING.waitingFee))
    ],
    footerButtons: [
      createActionButton('建立任務', 'action=create', 'primary', BRAND.goldDark),
      createActionButton('立即估價', 'action=quote', 'secondary')
    ]
  });
}

function createEnterpriseFlex() {
  return createPrettyCard({
    altText: '企業合作',
    title: 'UBee 企業合作',
    subtitle: '文件急送・樣品收送・臨時行政支援',
    bodyContents: [
      {
        type: 'text',
        text:
          '我們提供企業專屬城市任務支援，適用公司、工廠、中小企業、事務所與門市單位。',
        wrap: true,
        size: 'sm',
        color: BRAND.text
      }
    ],
    footerButtons: [
      createUriButton('填寫企業合作申請', BUSINESS_FORM, 'primary', BRAND.goldDark),
      createMessageButton('企業服務說明', '企業服務說明', 'secondary')
    ]
  });
}

function createMeFlex() {
  return createPrettyCard({
    altText: '我的選單',
    title: '我的選單',
    subtitle: '服務資訊與夥伴加入入口',
    bodyContents: [
      {
        type: 'text',
        text: '您可以查看服務說明，或申請加入夥伴，一起參與城市任務服務。',
        wrap: true,
        size: 'sm',
        color: BRAND.text
      }
    ],
    footerButtons: [
      createMessageButton('服務說明', '服務說明', 'secondary'),
      createUriButton('加入夥伴', PARTNER_FORM, 'primary', BRAND.goldDark)
    ]
  });
}

function createUrgentChoiceFlex() {
  return createPrettyCard({
    altText: '是否為急件',
    title: '是否為急件？',
    subtitle: `急件費固定 ${formatMoney(PRICING.urgentFee)}`,
    bodyContents: [
      {
        type: 'text',
        text: '請選擇本次任務是否需要急件處理',
        wrap: true,
        size: 'sm',
        color: BRAND.text
      }
    ],
    footerButtons: [
      createMessageButton('一般', '一般', 'secondary'),
      createMessageButton('急件', '急件', 'primary', BRAND.goldDark)
    ]
  });
}

function createWaitingChoiceFlex() {
  return createPrettyCard({
    altText: '是否需要等候',
    title: '是否需要等候？',
    subtitle: `等候費固定 ${formatMoney(PRICING.waitingFee)}`,
    bodyContents: [
      {
        type: 'text',
        text: '若本次任務需要現場等待，請選擇「需要等候」',
        wrap: true,
        size: 'sm',
        color: BRAND.text
      }
    ],
    footerButtons: [
      createMessageButton('不需要等候', '不需要等候', 'secondary'),
      createMessageButton('需要等候', '需要等候', 'primary', BRAND.goldDark)
    ]
  });
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
      styles: {
        body: { backgroundColor: '#FFFFFF' },
        footer: { separator: true }
      },
      hero: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: BRAND.black,
        paddingAll: '18px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [createTag('CONFIRM', BRAND.gold)]
          },
          {
            type: 'text',
            text: '請確認任務資訊',
            color: BRAND.white,
            weight: 'bold',
            size: 'xl',
            margin: 'md'
          },
          {
            type: 'text',
            text: 'UBee 將依此內容建立任務',
            color: '#E5E5E5',
            size: 'sm',
            margin: 'sm'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'lg',
        paddingAll: '16px',
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
              createInfoRow('急件', session.isUrgent),
              createInfoRow('等候', session.needWaiting),
              createInfoRow('備註', session.note)
            ]
          },
          {
            type: 'separator'
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              createPriceRow('基本費', formatMoney(session.baseFee)),
              createPriceRow(`里程費（${formatKm(session.distanceKm)} km）`, formatMoney(session.distanceFee)),
              createPriceRow(`時間費（${formatMinutes(session.durationMinutes)} 分）`, formatMoney(session.timeFee)),
              createPriceRow('配送費小計', formatMoney(session.deliveryFee), true),
              createPriceRow('服務費', formatMoney(session.serviceFee)),
              createPriceRow('急件費', formatMoney(session.urgentFee)),
              createPriceRow('等候費', formatMoney(session.waitingFee))
            ]
          },
          {
            type: 'separator'
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              createInfoRow('預估距離', session.distanceText || `${formatKm(session.distanceKm)} km`),
              createInfoRow('預估時間', session.durationText || `${formatMinutes(session.durationMinutes)} 分`)
            ]
          },
          {
            type: 'box',
            layout: 'horizontal',
            margin: 'lg',
            paddingAll: '12px',
            backgroundColor: BRAND.bgSoft,
            cornerRadius: '12px',
            contents: [
              {
                type: 'text',
                text: '總計',
                weight: 'bold',
                size: 'lg',
                color: BRAND.black,
                flex: 5
              },
              {
                type: 'text',
                text: formatMoney(session.totalFee),
                weight: 'bold',
                size: 'xl',
                color: BRAND.goldDark,
                align: 'end',
                flex: 5
              }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '14px',
        contents: [
          createActionButton(
            mode === 'quote' ? '確認並建立任務' : '確認送出',
            confirmData,
            'primary',
            BRAND.goldDark
          ),
          createActionButton('重新填寫', restartData, 'secondary'),
          createActionButton('取消', cancelData, 'secondary')
        ]
      }
    }
  };
}

function createGroupTaskFlex(orderId) {
  const order = orders[orderId];

  return createPrettyCard({
    altText: 'UBee 新任務通知',
    title: '📦 UBee 新任務通知',
    subtitle: `訂單編號：${orderId}`,
    bodyContents: [
      createInfoRow('費用', formatMoney(order.driverFee), BRAND.goldDark),
      createInfoRow('取件地點', order.pickup),
      createInfoRow('送達地點', order.dropoff),
      createInfoRow('物品', order.item),
      createInfoRow('急件', order.isUrgent),
      createInfoRow('等候', order.needWaiting),
      createInfoRow('備註', order.note),
      createInfoRow('總距離', order.distanceText || `${formatKm(order.distanceKm)} km`),
      createInfoRow('預估時間', order.durationText || `${formatMinutes(order.durationMinutes)} 分`)
    ],
    footerButtons: [
      createActionButton('接單', `accept=${orderId}`, 'primary', BRAND.goldDark),
      createActionButton('放棄任務', `reject=${orderId}`, 'secondary')
    ],
    tagText: 'NEW ORDER'
  });
}

function createETAFlex(orderId, page) {
  const pageMap = {
    1: [
      createActionButton('5 分鐘', `eta=${orderId}=5`, 'secondary'),
      createActionButton('7 分鐘', `eta=${orderId}=7`, 'secondary'),
      createActionButton('8 分鐘', `eta=${orderId}=8`, 'secondary'),
      createActionButton('下一頁', `etaPage2=${orderId}`, 'primary', BRAND.goldDark')
    ],
    2: [
      createActionButton('10 分鐘', `eta=${orderId}=10`, 'secondary'),
      createActionButton('12 分鐘', `eta=${orderId}=12`, 'secondary'),
      createActionButton('15 分鐘', `eta=${orderId}=15`, 'secondary'),
      createActionButton('下一頁', `etaPage3=${orderId}`, 'primary', BRAND.goldDark)
    ],
    3: [
      createActionButton('17 分鐘', `eta=${orderId}=17`, 'secondary'),
      createActionButton('18 分鐘', `eta=${orderId}=18`, 'secondary'),
      createActionButton('20 分鐘', `eta=${orderId}=20`, 'secondary'),
      createActionButton('下一頁', `etaPage4=${orderId}`, 'primary', BRAND.goldDark)
    ],
    4: [
      createActionButton('22 分鐘', `eta=${orderId}=22`, 'secondary'),
      createActionButton('25 分鐘', `eta=${orderId}=25`, 'secondary'),
      createActionButton('上一頁', `etaPage3=${orderId}`, 'primary', BRAND.goldDark)
    ]
  };

  return createPrettyCard({
    altText: '選擇 ETA',
    title: `選擇 ETA（${page}/4）`,
    subtitle: '請選擇預計抵達取件地點時間',
    bodyContents: [
      {
        type: 'text',
        text: '接單後請設定 ETA，系統會同步通知客人。',
        wrap: true,
        size: 'sm',
        color: BRAND.text
      }
    ],
    footerButtons: pageMap[page],
    tagText: 'ETA'
  });
}

function createPickupActionFlex(orderId) {
  const order = orders[orderId];
  return createPrettyCard({
    altText: '取件操作',
    title: '取件操作',
    subtitle: '請前往取件地點',
    bodyContents: [
      createInfoRow('取件地點', order.pickup),
      createInfoRow('取件電話', order.pickupPhone)
    ],
    footerButtons: [
      createUriButton('導航取件地點', buildGoogleMapSearchUrl(order.pickup), 'primary', BRAND.goldDark),
      createActionButton('已抵達取件地點', `arrivePickup=${orderId}`, 'secondary')
    ],
    tagText: 'PICKUP'
  });
}

function createPickedActionFlex(orderId) {
  return createPrettyCard({
    altText: '已取件操作',
    title: '已取件操作',
    subtitle: '請確認完成取件後再進入下一步',
    bodyContents: [
      {
        type: 'text',
        text: '若物品已完成交接，請點擊下方按鈕。',
        wrap: true,
        size: 'sm',
        color: BRAND.text
      }
    ],
    footerButtons: [
      createActionButton('已取件', `picked=${orderId}`, 'primary', BRAND.goldDark)
    ],
    tagText: 'IN HAND'
  });
}

function createDropoffActionFlex(orderId) {
  const order = orders[orderId];
  return createPrettyCard({
    altText: '送達操作',
    title: '送達操作',
    subtitle: '請前往送達地點',
    bodyContents: [
      createInfoRow('送達地點', order.dropoff),
      createInfoRow('送達電話', order.dropoffPhone)
    ],
    footerButtons: [
      createUriButton('導航送達地點', buildGoogleMapSearchUrl(order.dropoff), 'primary', BRAND.goldDark),
      createActionButton('已抵達送達地點', `arriveDropoff=${orderId}`, 'secondary')
    ],
    tagText: 'DROPOFF'
  });
}

function createDropoffArrivedFlex(orderId) {
  const order = orders[orderId];
  return createPrettyCard({
    altText: '送達地點操作',
    title: '送達地點操作',
    subtitle: '請先聯絡收件人，再完成任務',
    bodyContents: [
      createInfoRow('送達電話', order.dropoffPhone)
    ],
    footerButtons: [
      createActionButton('撥打收件人', `call=${orderId}=${order.dropoffPhone}`, 'secondary'),
      createActionButton('已完成', `complete=${orderId}`, 'primary', BRAND.goldDark)
    ],
    tagText: 'ARRIVED'
  });
}

function createCallFlex(phone) {
  return createPrettyCard({
    altText: '聯絡收件人',
    title: '聯絡收件人',
    subtitle: `電話：${phone}`,
    bodyContents: [
      {
        type: 'text',
        text: '請點擊下方按鈕直接撥打電話。',
        wrap: true,
        size: 'sm',
        color: BRAND.text
      }
    ],
    footerButtons: [
      createUriButton('📞 撥打', `tel:${phone}`, 'primary', BRAND.goldDark)
    ],
    tagText: 'CALL'
  });
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
    needWaiting: session.needWaiting,
    note: session.note,
    baseFee: session.baseFee,
    distanceFee: session.distanceFee,
    timeFee: session.timeFee,
    deliveryFee: session.deliveryFee,
    serviceFee: session.serviceFee,
    urgentFee: session.urgentFee,
    waitingFee: session.waitingFee,
    totalFee: session.totalFee,
    driverFee: session.driverFee,
    distanceKm: session.distanceKm,
    durationMinutes: session.durationMinutes,
    distanceText: session.distanceText,
    durationText: session.durationText,
    status: 'pending',
    driverId: null,
    etaMinutes: null,
    createdAt: new Date().toISOString(),
    acceptedAt: null,
    arrivedPickupAt: null,
    pickedUpAt: null,
    arrivedDropoffAt: null,
    completedAt: null,
    abandonedBy: []
  };

  clearSession(session.userId);

  await safePush(LINE_GROUP_ID, createGroupTaskFlex(orderId));

  return safeReply(event.replyToken, textMessage('✅ 任務已建立成功，系統正在尋找騎手'));
}

// ===== 路由 =====
app.get('/', (req, res) => {
  res.status(200).send('UBee OMS V3.8 Flex Pricing Running');
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
    if (text === '企業') return safeReply(event.replyToken, createEnterpriseFlex());
    if (text === '我的') return safeReply(event.replyToken, createMeFlex());

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
            '建立任務後，系統會媒合騎手執行，並在任務過程中同步通知進度。'
        )
      );
    }

    const session = getSession(userId);
    if (session && (session.type === 'create_order' || session.type === 'quote_order')) {
      return handleOrderInput(event, session, text);
    }
  } catch (err) {
    console.error('handleEvent error:', err);
    return safeReply(event.replyToken, textMessage('⚠️ 系統發生錯誤，請稍後再試'));
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
      return safeReply(event.replyToken, textMessage('⚠️ 取件電話格式不正確，請重新輸入正確電話：'));
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
      return safeReply(event.replyToken, textMessage('⚠️ 送達電話格式不正確，請重新輸入正確電話：'));
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
    session.step = 'waiting';
    return safeReply(event.replyToken, createWaitingChoiceFlex());
  }

  if (session.step === 'waiting') {
    if (text !== '不需要等候' && text !== '需要等候') {
      return safeReply(event.replyToken, createWaitingChoiceFlex());
    }

    session.needWaiting = text;
    session.step = 'note';
    return safeReply(event.replyToken, textMessage('請輸入備註，若無請輸入「無」：'));
  }

  if (session.step === 'note') {
    session.note = text || '無';

    try {
      const fees = await calculateFees(session);

      session.baseFee = fees.baseFee;
      session.distanceFee = fees.distanceFee;
      session.timeFee = fees.timeFee;
      session.deliveryFee = fees.deliveryFee;
      session.serviceFee = fees.serviceFee;
      session.urgentFee = fees.urgentFee;
      session.waitingFee = fees.waitingFee;
      session.totalFee = fees.totalFee;
      session.driverFee = fees.driverFee;
      session.distanceKm = fees.distanceKm;
      session.durationMinutes = fees.durationMinutes;
      session.distanceText = fees.distanceText;
      session.durationText = fees.durationText;
      session.step = 'confirm';

      const isQuote = session.type === 'quote_order';

      return safeReply(
        event.replyToken,
        createConfirmCardFlex(session, isQuote ? 'quote' : 'create')
      );
    } catch (err) {
      console.error('calculateFees error:', err);
      return safeReply(
        event.replyToken,
        textMessage(`⚠️ 地址查詢或費用計算失敗：${err.message}`)
      );
    }
  }

  if (session.step === 'confirm') {
    return safeReply(event.replyToken, textMessage('請直接使用下方按鈕進行確認、重新填寫或取消。'));
  }

  clearSession(userId);
  return safeReply(event.replyToken, textMessage('⚠️ 流程已重置，請重新開始。'));
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
    return safeReply(event.replyToken, textMessage('✅ 已取消本次建立任務'));
  }

  if (data === 'action=cancelQuote') {
    clearSession(userId);
    return safeReply(event.replyToken, textMessage('✅ 已取消本次立即估價'));
  }

  if (data.startsWith('accept=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;

    if (!requireStatus(event.replyToken, order, ['pending'], '接單')) return;

    if (order.abandonedBy.includes(userId)) {
      return safeReply(event.replyToken, textMessage('⚠️ 您已放棄此任務，無法再次接單'));
    }

    if (order.driverId) {
      return safeReply(event.replyToken, textMessage('⚠️ 此任務已被其他騎手接單'));
    }

    order.driverId = userId;
    order.status = 'accepted';
    order.acceptedAt = new Date().toISOString();

    return safeReply(event.replyToken, createETAFlex(orderId, 1));
  }

  if (data.startsWith('reject=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;

    if (!requireStatus(event.replyToken, order, ['pending'], '放棄任務')) return;

    if (!order.abandonedBy.includes(userId)) {
      order.abandonedBy.push(userId);
    }

    return safeReply(event.replyToken, textMessage('✅ 您已放棄此任務'));
  }

  if (data.startsWith('etaPage2=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '查看 ETA')) return;

    return safeReply(event.replyToken, createETAFlex(orderId, 2));
  }

  if (data.startsWith('etaPage3=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '查看 ETA')) return;

    return safeReply(event.replyToken, createETAFlex(orderId, 3));
  }

  if (data.startsWith('etaPage4=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '查看 ETA')) return;

    return safeReply(event.replyToken, createETAFlex(orderId, 4));
  }

  if (data.startsWith('eta=')) {
    const [, orderId, min] = data.split('=');
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '設定 ETA')) return;

    order.etaMinutes = min;

    await safePush(order.userId, textMessage(`✅ 已有騎手接單，預計 ${min} 分鐘抵達取件地點`));
    await safePush(LINE_GROUP_ID, textMessage(`✅ 任務已接單，預計 ${min} 分鐘抵達取件地點`));
    await safePush(LINE_GROUP_ID, createPickupActionFlex(orderId));

    return safeReply(event.replyToken, textMessage(`✅ 已設定 ETA，預計 ${min} 分鐘抵達取件地點`));
  }

  if (data.startsWith('arrivePickup=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '已抵達')) return;

    order.status = 'arrived_pickup';
    order.arrivedPickupAt = new Date().toISOString();

    await safePush(order.userId, textMessage('📍 騎手已抵達取件地點'));

    return safeReply(event.replyToken, createPickedActionFlex(orderId));
  }

  if (data.startsWith('picked=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['arrived_pickup'], '已取件')) return;

    order.status = 'picked_up';
    order.pickedUpAt = new Date().toISOString();

    await safePush(order.userId, textMessage('✅ 騎手已完成取件，正在前往送達地點'));

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

    await safePush(order.userId, textMessage('✅ 任務已完成，感謝您使用 UBee'));

    return safeReply(event.replyToken, textMessage('✅ 任務已完成'));
  }

  return safeReply(event.replyToken, textMessage('⚠️ 無法辨識此操作'));
}

// ===== 啟動 =====
app.listen(PORT, () => {
  console.log('UBee OMS V3.8 Flex Pricing Running');
});
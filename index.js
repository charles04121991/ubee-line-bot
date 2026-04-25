require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');

const app = express();
app.use(express.static('public'));
const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});

const db = admin.firestore();
let eventQueue = [];

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
const LINE_FINISH_GROUP_ID = process.env.LINE_FINISH_GROUP_ID || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const PAYMENT_JKO_INFO =
  (process.env.PAYMENT_JKO_INFO || '街口支付\n帳號：請填入你的街口帳號').replace(/\\n/g, '\n');

const PAYMENT_BANK_INFO =
  (process.env.PAYMENT_BANK_INFO || '銀行轉帳\n銀行：請填入銀行名稱\n帳號：請填入銀行帳號').replace(/\\n/g, '\n');

// ===== 連結設定 =====
const BUSINESS_FORM_URL =
  process.env.BUSINESS_FORM_URL ||
  'https://docs.google.com/forms/d/e/1FAIpQLScn9AGnp4FbTGg6fZt5fpiMdNEi-yL9x595bTyVFHAoJmpYlA/viewform';

const PARTNER_FORM_URL =
  process.env.PARTNER_FORM_URL || 'https://forms.gle/your-partner-form';

if (!LINE_GROUP_ID) {
  console.error('❌ 缺少 LINE_GROUP_ID');
  process.exit(1);
}
app.use(express.json());

app.post('/api/orders', async (req, res) => {
  try {
    const {
  service,
  pickup,
  dropoff,
  pickupPhone,
  dropoffPhone,
  item,
  note,
  urgent
} = req.body;

    const message = `
📦【UBee 新訂單】

📌 服務類型：${service}
📍 取件：${pickup}
📍 送達：${dropoff}

📞 取件電話：${pickupPhone}
📞 收件電話：${dropoffPhone}

📦 物品：${item}
📝 備註：${note || '無'}
    `;

    const orderId = 'UB' + Date.now().toString().slice(-6);
let driverFee = 99 + 50; // 基本費 + 服務費

// 急件加價
if (urgent) {
  driverFee += 100;
}

// 騎手抽成（60%）
driverFee = Math.floor(driverFee * 0.6);

await client.pushMessage(LINE_GROUP_ID, {
  type: 'flex',
  altText: '📦 UBee 新訂單',
  contents: {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '📦 UBee 新訂單',
          weight: 'bold',
          size: 'lg'
        },
        {
          type: 'text',
          text: `訂單編號：${orderId}`,
          size: 'sm',
          color: '#888888'
        },
        {
          type: 'text',
          text: '🟡 狀態：待接單',
          size: 'sm',
          color: '#ff9500'
        },
        {
          type: 'separator',
          margin: 'md'
        },
        {
          type: 'text',
          text: `💰 騎手收入：${driverFee}`,
          weight: 'bold',
          color: '#00a000',
          margin: 'md'
        },
        {
          type: 'text',
          text: `服務：${service}`,
          margin: 'md'
        },
        {
          type: 'text',
          text: `取件：${pickup}`,
          wrap: true
        },
        {
          type: 'text',
          text: `送達：${dropoff}`,
          wrap: true
        },
        {
          type: 'text',
          text: `📞 取件電話：${pickupPhone}`
        },
        {
          type: 'text',
          text: `📞 收件電話：${dropoffPhone}`
        },
        {
          type: 'text',
          text: `📦 物品：${item}`
        },
        {
          type: 'text',
          text: `📝 備註：${note || '無'}`
        }
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'primary',
          action: {
            type: 'postback',
            label: '接單',
            data: `accept_${orderId}`
          }
        }
      ]
    }
  }
});

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

if (!GOOGLE_MAPS_API_KEY) {
  console.error('❌ 缺少 GOOGLE_MAPS_API_KEY');
  process.exit(1);
}

// ===== 計價設定 =====
const PRICING = {
  baseFee: 99,
  perKm: 8,
  perMinute: 2,
  serviceFee: 50,
  urgentFee: 100,
  driverRatio: 0.6,
};

// ===== ETA 設定 =====
const ETA_OPTIONS = [5, 7, 8, 10, 12, 15, 17, 20, 25];

// ===== 暫存資料（重啟會清空）=====
const userSessions = {};
const orders = {};
let orderCounter = 1;

// ===== Google Maps 快取 =====
const distanceCache = new Map();

function normalizeAddress(address) {
  return String(address || '').trim().replace(/\s+/g, '');
}

function getDistanceCacheKey(origin, destination) {
  return `${normalizeAddress(origin)}=>${normalizeAddress(destination)}`;
}

// ===== 工具函式 =====
function generateOrderId() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const no = String(orderCounter++).padStart(4, '0');
  return `UB${yyyy}${mm}${dd}${no}`;
}

function formatCurrency(value) {
  return `NT$${Math.round(Number(value || 0))}`;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '');
}

function buildGoogleMapDirectionsUrl(address) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address || '')}`;
}

function getPaymentMethodLabel(method) {
  return (
    {
      jko: '街口支付',
      bank: '銀行轉帳',
    }[method] || '未選擇'
  );
}

function createTextMessage(text) {
  return { type: 'text', text };
}

function createActionButton(label, data, style = 'primary') {
  return {
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
}

function createUriButton(label, uri, style = 'secondary') {
  return {
    type: 'button',
    style,
    height: 'sm',
    action: {
      type: 'uri',
      label,
      uri,
    },
  };
}

function createQuickReplyMessage(text, items) {
  return {
    type: 'text',
    text,
    quickReply: {
      items: items.map((item) => ({
        type: 'action',
        action: item,
      })),
    },
  };
}

function createInfoRow(label, value, wrap = true) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      {
        type: 'text',
        text: label,
        size: 'sm',
        color: '#666666',
        flex: 3,
      },
      {
        type: 'text',
        text: String(value || '-'),
        size: 'sm',
        color: '#111111',
        wrap,
        flex: 7,
      },
    ],
  };
}

function createBubble(title, bodyContents, footerContents = []) {
  const bubble = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: title,
          weight: 'bold',
          size: 'lg',
          color: '#111111',
        },
      ],
      paddingAll: '16px',
      backgroundColor: '#FFF4CC',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: bodyContents,
    },
  };

  if (footerContents.length > 0) {
    bubble.footer = {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: footerContents,
    };
  }

  return bubble;
}

function createFlexMessage(altText, bubble) {
  return {
    type: 'flex',
    altText,
    contents: bubble,
  };
}

function getStatusLabel(status) {
  return (
    {
      draft_confirm: '📝 待確認',
      pending_payment: '💳 待付款',
      paid_pending_dispatch: '💰 已付款待派單',
      pending_dispatch: '🟡 待派單',
      accepted: '🟢 已接單',
      arrived_pickup: '🟠 已抵達取件地點',
      picked_up: '🔵 已取件',
      completed: '✅ 已完成',
      quote_only: '💰 估價完成',
    }[status] || status
  );
}

function getOrCreateSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = {
      mode: null,
      step: null,
      draft: {},
    };
  }
  return userSessions[userId];
}

function resetUserSession(userId) {
  delete userSessions[userId];
}

async function pushToUser(userId, messages) {
  if (!userId) return;
  const list = Array.isArray(messages) ? messages : [messages];
  await client.pushMessage(userId, list);
}

async function pushToGroup(groupId, messages) {
  if (!groupId) return;
  const list = Array.isArray(messages) ? messages : [messages];
  await client.pushMessage(groupId, list);
}

// ===== Google Maps 距離時間 =====
async function getDistanceMatrix(origin, destination) {
  const url =
    'https://maps.googleapis.com/maps/api/distancematrix/json' +
    `?origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(destination)}` +
    `&language=zh-TW&units=metric&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK') {
    throw new Error(`Distance Matrix API 錯誤：${data.status}`);
  }

  const element = data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK') {
    throw new Error(`距離計算失敗：${element?.status || 'UNKNOWN'}`);
  }

  return {
    distanceMeters: element.distance.value,
    durationSeconds: element.duration.value,
    distanceText: element.distance.text,
    durationText: element.duration.text,
  };
}

async function getDistanceMatrixCached(origin, destination) {
  const key = getDistanceCacheKey(origin, destination);

  if (distanceCache.has(key)) {
    return distanceCache.get(key);
  }

  const distance = await getDistanceMatrix(origin, destination);
  distanceCache.set(key, distance);
  return distance;
}

function calculatePrice({ distanceMeters, durationSeconds, isUrgent }) {
  const km = distanceMeters / 1000;
  const minutes = durationSeconds / 60;

  const deliveryFee =
    PRICING.baseFee + km * PRICING.perKm + minutes * PRICING.perMinute;

  const serviceFee = PRICING.serviceFee;
  const urgentFee = isUrgent ? PRICING.urgentFee : 0;
  const total = Math.round(deliveryFee + serviceFee + urgentFee);
  const driverFee = Math.round(total * PRICING.driverRatio);
  const platformFee = total - driverFee;

  return {
    deliveryFee: Math.round(deliveryFee),
    serviceFee,
    urgentFee,
    total,
    driverFee,
    platformFee,
  };
}

// ===== 主選單 / 子選單 =====
function createMainMenuFlex() {
  const bubble = createBubble(
    'UBee 主選單',
    [
      {
        type: 'text',
        text: '請選擇你要使用的功能',
        size: 'sm',
        color: '#666666',
        wrap: true,
      },
    ],
    [
      createActionButton('立即下單', 'menu=order'),
      createActionButton('商務合作', 'menu=business', 'secondary'),
      createActionButton('我的任務', 'menu=info', 'secondary'),
    ]
  );

  return createFlexMessage('UBee 主選單', bubble);
}

function createOrderMenuFlex() {
  const bubble = createBubble(
    '立即下單',
    [
      {
        type: 'text',
        text: '請選擇你要的服務',
        size: 'sm',
        color: '#666666',
        wrap: true,
      },
    ],
    [
      createActionButton('建立任務', 'submenu=createOrder'),
      createActionButton('立即估價', 'submenu=quoteOnly', 'secondary'),
    ]
  );

  return createFlexMessage('立即下單', bubble);
}

function createBusinessMenuFlex() {
  const bubble = createBubble(
    '商務合作',
    [
      {
        type: 'text',
        text: '請選擇合作相關資訊',
        size: 'sm',
        color: '#666666',
        wrap: true,
      },
    ],
    [
      createUriButton('合作表單', BUSINESS_FORM_URL),
      createActionButton('合作說明', 'submenu=businessIntro', 'secondary'),
    ]
  );

  return createFlexMessage('商務合作', bubble);
}

function createInfoMenuFlex() {
  const bubble = createBubble(
    '我的任務',
    [
      {
        type: 'text',
        text: '請選擇你要查看的內容',
        size: 'sm',
        color: '#666666',
        wrap: true,
      },
    ],
    [
      createActionButton('取消規則', 'submenu=cancelRules'),
      createActionButton('常見問題', 'submenu=faq', 'secondary'),
      createActionButton('查詢訂單', 'submenu=queryOrder', 'secondary'),
      createUriButton('加入合作夥伴', PARTNER_FORM_URL, 'secondary'),
    ]
  );

  return createFlexMessage('我的任務', bubble);
}

// ===== 說明文字 =====
function getBusinessIntroText() {
  return [
    createTextMessage(
      'UBee 提供企業與商務跑腿服務\n\n' +
      '✓ 文件急送（合約、發票）\n\n' +
      '✓ 樣品配送\n\n' +
      '✓ 臨時行政支援\n\n' +
      '✓ 個人物品\n\n' +
      '✓ 安全代送\n\n' +
      '✓ 私人物件\n\n' +
      '平均 35 分鐘完成任務。\n\n' +
      '如需長期合作，歡迎填寫合作表單。'
    ),
  ];
}

function getCancelRulesText() {
  return [
    createTextMessage(
      '取消規則說明：\n\n' +
      '未付款前：可取消\n' +
      '已付款待派單：請聯繫客服協助\n' +
      '已接單後：原則上不可取消\n\n' +
      '請確認任務內容後再下單，若有特殊情況請聯繫客服。'
    ),
  ];
}

function getFaqText() {
  return [
    createTextMessage(
      '常見問題：\n\n' +
      'Q：多久會有人接單？\n\n' +
      'A：通常 10～15 分鐘內會有騎手接單。\n\n\n' +
      'Q：可以送什麼？\n\n' +
      'A：文件、樣品、商務物品、個人物品、安全代送、私人物件。\n\n\n' +
      'Q：可以送餐嗎？\n\n' +
      'A：目前不提供餐飲代購服務。\n\n\n' +
      'Q：有沒有不能接的項目？\n\n' +
      'A：違法、危險品或涉及個資之項目恕不承接，其餘任務歡迎先私訊確認。\n\n\n' +
      'Q：有開發票或收據嗎？\n\n' +
      'A：目前提供收據或交易紀錄，暫不提供統一發票。\n\n'
    ),
  ];
}

// ===== Flex 卡片 =====
function createOrderConfirmFlex(order) {
  const bubble = createBubble(
    '確認建立任務',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('取件電話', order.pickupPhone),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('送達電話', order.dropoffPhone),
      createInfoRow('急件', order.isUrgent ? '是' : '否'),
      createInfoRow('備註', order.note || '無'),
      { type: 'separator', margin: 'md' },
      createInfoRow('距離', order.distanceText),
      createInfoRow('時間', order.durationText),
      createInfoRow('配送費', formatCurrency(order.deliveryFee)),
      createInfoRow('服務費', formatCurrency(order.serviceFee)),
      createInfoRow('急件費', formatCurrency(order.urgentFee)),
      createInfoRow('總金額', formatCurrency(order.total)),
    ],
    [
      createActionButton('確認並前往付款', `confirmCreate=${order.id}`),
      createActionButton('取消', `cancelCreate=${order.id}`, 'secondary'),
    ]
  );

  return createFlexMessage('確認建立任務', bubble);
}

function createQuoteFlex(order) {
  const bubble = createBubble(
    '立即估價結果',
    [
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('急件', order.isUrgent ? '是' : '否'),
      { type: 'separator', margin: 'md' },
      createInfoRow('距離', order.distanceText),
      createInfoRow('時間', order.durationText),
      createInfoRow('配送費', formatCurrency(order.deliveryFee)),
      createInfoRow('服務費', formatCurrency(order.serviceFee)),
      createInfoRow('急件費', formatCurrency(order.urgentFee)),
      createInfoRow('預估總金額', formatCurrency(order.total)),
    ],
    [createActionButton('建立任務', 'submenu=createOrder')]
  );

  return createFlexMessage('立即估價結果', bubble);
}

function createDispatchGroupFlex(order) {
  const bubble = createBubble(
    'UBee 新任務通知',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('狀態', getStatusLabel(order.status)),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('備註', order.note || '無'),
      createInfoRow('收入', formatCurrency(order.driverFee)),
    ],
    [
      createActionButton('接受訂單', `accept=${order.id}`),
      createUriButton('導航到取件地點', buildGoogleMapDirectionsUrl(order.pickupAddress)),
    ]
  );

  return createFlexMessage('UBee 新任務通知', bubble);
}

function createEtaRow(orderId, minutesList) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: minutesList.map((minutes) =>
      createActionButton(`${minutes}分鐘`, `eta=${orderId}=${minutes}`, 'primary')
    ),
  };
}

function createETAFlex(order) {
  const bubble = createBubble(
    '請選擇 ETA',
    [
      {
        type: 'text',
        text: '請選擇預計抵達取件地點時間',
        size: 'sm',
        color: '#666666',
        wrap: true,
      },
      createInfoRow('訂單編號', order.id),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('送達地址', order.dropoffAddress),
      { type: 'separator', margin: 'md' },
      createEtaRow(order.id, [5, 7, 8]),
      createEtaRow(order.id, [10, 12, 15]),
      createEtaRow(order.id, [17, 20, 25]),
    ]
  );

  return createFlexMessage('請選擇 ETA', bubble);
}

function createRiderControlFlex(order) {
  const bubble = createBubble(
    '騎手任務操作',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('狀態', getStatusLabel(order.status)),
      createInfoRow('ETA', order.etaMinutes ? `${order.etaMinutes} 分鐘` : '尚未設定'),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('備註', order.note || '無'),
      createInfoRow('收入', formatCurrency(order.driverFee)),
    ],
    [
      createActionButton('重新設定ETA', `showEta=${order.id}`, 'secondary'),
      createActionButton('已抵達取件地點', `arrivedPickup=${order.id}`),
      createActionButton('已取件', `pickedUp=${order.id}`),
      createUriButton('導航到送達地點', buildGoogleMapDirectionsUrl(order.dropoffAddress)),
      createActionButton('已送達', `completed=${order.id}`),
    ]
  );

  return createFlexMessage('騎手任務操作', bubble);
}

function createPaymentMethodFlex(order) {
  const bubble = createBubble(
    '請選擇付款方式',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('總金額', formatCurrency(order.total)),
      {
        type: 'text',
        text: '請先完成付款，再按「我已付款」，系統才會派單。',
        size: 'sm',
        color: '#666666',
        wrap: true,
      },
    ],
    [
      createActionButton('街口支付', `payment=jko=${order.id}`),
      createActionButton('銀行轉帳', `payment=bank=${order.id}`, 'secondary'),
      createActionButton('取消此訂單', `cancelCreate=${order.id}`, 'secondary'),
    ]
  );

  return createFlexMessage('請選擇付款方式', bubble);
}

function createPaymentInfoFlex(order) {
  const paymentInfo =
    order.paymentMethod === 'jko' ? PAYMENT_JKO_INFO : PAYMENT_BANK_INFO;

  const bubble = createBubble(
    order.paymentMethod === 'jko' ? '街口支付資訊' : '銀行轉帳資訊',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('付款方式', getPaymentMethodLabel(order.paymentMethod)),
      createInfoRow('應付金額', formatCurrency(order.total)),
      { type: 'separator', margin: 'md' },
      {
        type: 'text',
        text: paymentInfo,
        size: 'sm',
        color: '#111111',
        wrap: true,
      },
      {
        type: 'text',
        text: '完成付款後，請按下方「我已付款」，系統才會通知騎手接單。',
        size: 'sm',
        color: '#666666',
        wrap: true,
      },
    ],
    [
      createActionButton('我已付款', `confirmPayment=${order.id}`),
      createActionButton('重新選付款方式', `showPaymentMethod=${order.id}`, 'secondary'),
    ]
  );

  return createFlexMessage('付款資訊', bubble);
}

function createFinanceFlex(order) {
  const bubble = createBubble(
    'UBee 財務明細',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('付款方式', getPaymentMethodLabel(order.paymentMethod)),
      createInfoRow('付款狀態', order.isPaid ? '已付款' : '未付款'),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('ETA', order.etaMinutes ? `${order.etaMinutes} 分鐘` : '未設定'),
      { type: 'separator', margin: 'md' },
      createInfoRow('配送費', formatCurrency(order.deliveryFee)),
      createInfoRow('服務費', formatCurrency(order.serviceFee)),
      createInfoRow('急件費', formatCurrency(order.urgentFee)),
      createInfoRow('等候費', formatCurrency(order.waitingFee || 0)),
      createInfoRow('總金額', formatCurrency(order.total)),
      createInfoRow('騎手收入', formatCurrency(order.driverFee)),
      createInfoRow('平台收入', formatCurrency(order.platformFee)),
    ]
  );

  return createFlexMessage('UBee 財務明細', bubble);
}

// ===== 流程啟動 =====
async function startCreateOrder(replyToken, userId) {
  const session = getOrCreateSession(userId);
  session.mode = 'createOrder';
  session.step = 'pickupAddress';
  session.draft = {};

  await client.replyMessage(replyToken, [
    createTextMessage('請輸入取件地址'),
  ]);
}

async function startQuoteOnly(replyToken, userId) {
  const session = getOrCreateSession(userId);
  session.mode = 'quoteOnly';
  session.step = 'pickupAddress';
  session.draft = {};

  await client.replyMessage(replyToken, [
    createTextMessage('請輸入取件地址（立即估價）'),
  ]);
}

async function finishQuoteOnly(event, userId, draft) {
  await client.replyMessage(event.replyToken, [
    createTextMessage('正在計算中，請稍候...')
  ]);

  (async () => {
    try {
      const distance = await getDistanceMatrixCached(
        draft.pickupAddress,
        draft.dropoffAddress
      );

      const price = calculatePrice({
        distanceMeters: distance.distanceMeters,
        durationSeconds: distance.durationSeconds,
        isUrgent: !!draft.isUrgent,
      });

      const order = {
        id: 'QUOTE',
        status: 'quote_only',
        pickupAddress: draft.pickupAddress,
        dropoffAddress: draft.dropoffAddress,
        isUrgent: !!draft.isUrgent,
        note: '',
        distanceText: distance.distanceText,
        durationText: distance.durationText,
        deliveryFee: price.deliveryFee,
        serviceFee: price.serviceFee,
        urgentFee: price.urgentFee,
        total: price.total,
      };

      resetUserSession(userId);
      await pushToUser(userId, [createQuoteFlex(order)]);
    } catch (error) {
      console.error('❌ 立即估價背景計算失敗：', error);
      resetUserSession(userId);
      await pushToUser(userId, createTextMessage('計算失敗，請重新操作'));
    }
  })();

  return;
}
  
async function finishCreateOrder(event, userId, draft) {
  const orderId = generateOrderId();
  const isUrgent = !!draft.isUrgent;

  await client.replyMessage(event.replyToken, [
    createTextMessage('正在建立任務，系統計算費用中...')
  ]);

  (async () => {
    try {
      const distance = await getDistanceMatrixCached(
        draft.pickupAddress,
        draft.dropoffAddress
      );

      const price = calculatePrice({
        distanceMeters: distance.distanceMeters,
        durationSeconds: distance.durationSeconds,
        isUrgent,
      });

      const order = {
        id: orderId,
        customerId: userId,
        riderId: '',
        riderName: '',
        status: 'pending',

        pickupAddress: draft.pickupAddress,
        pickupPhone: draft.pickupPhone,
        dropoffAddress: draft.dropoffAddress,
        dropoffPhone: draft.dropoffPhone,
        isUrgent,
        note: draft.note || '',

        distanceMeters: distance.distanceMeters,
        durationSeconds: distance.durationSeconds,
        distanceText: distance.distanceText,
        durationText: distance.durationText,

        deliveryFee: price.deliveryFee,
        serviceFee: price.serviceFee,
        urgentFee: price.urgentFee,
        waitingFee: 0,
        total: price.total,
        driverFee: price.driverFee,
        platformFee: price.platformFee,
        etaMinutes: null,

        paymentMethod: '',
        isPaid: false,
        paidAt: null,

        createdAt: Date.now(),
        acceptedAt: null,
        arrivedPickupAt: null,
        pickedUpAt: null,
        completedAt: null,
      };
await db.collection('orders').doc(order.id).set({
  ...order
});

      orders[order.id] = order;
      resetUserSession(userId);

      await pushToUser(userId, [createOrderConfirmFlex(order)]);
    } catch (error) {
      console.error('❌ 建立任務背景計算失敗：', error);
      resetUserSession(userId);

      await pushToUser(
        userId,
        createTextMessage('抱歉，地址計算失敗，請重新輸入「建立任務」再試一次。')
      );
    }
  })();

  return;
}

// ===== 文字訊息流程 =====
async function handleTextStep(event, userId, text) {
  const session = getOrCreateSession(userId);
  const normalized = text.trim();

  if (!session.step) {
    if (normalized === '主選單') {
      return client.replyMessage(event.replyToken, [createMainMenuFlex()]);
    }

    if (normalized === '立即下單') {
      return client.replyMessage(event.replyToken, [createOrderMenuFlex()]);
    }

    if (normalized === '商務合作') {
      return client.replyMessage(event.replyToken, [createBusinessMenuFlex()]);
    }

    if (normalized === '我的任務' || normalized === '我的資訊') {
      return client.replyMessage(event.replyToken, [createInfoMenuFlex()]);
    }

    if (normalized === '建立任務') {
      return startCreateOrder(event.replyToken, userId);
    }

    if (normalized === '立即估價') {
      return startQuoteOnly(event.replyToken, userId);
    }

    if (normalized === '合作說明') {
      return client.replyMessage(event.replyToken, getBusinessIntroText());
    }

    if (normalized === '取消規則') {
      return client.replyMessage(event.replyToken, getCancelRulesText());
    }

    if (normalized === '常見問題') {
      return client.replyMessage(event.replyToken, getFaqText());
    }

    return client.replyMessage(event.replyToken, [
      createTextMessage('歡迎使用 UBee'),
      createMainMenuFlex(),
    ]);
  }

  if (session.step === 'pickupAddress') {
    session.draft.pickupAddress = normalized;

    if (session.mode === 'quoteOnly') {
      session.step = 'dropoffAddress';
      return client.replyMessage(event.replyToken, [
        createTextMessage('請輸入送達地址'),
      ]);
    }

    session.step = 'pickupPhone';
    return client.replyMessage(event.replyToken, [
      createTextMessage('請輸入取件電話'),
    ]);
  }

  if (session.step === 'pickupPhone') {
    session.draft.pickupPhone = normalizePhone(normalized);
    session.step = 'dropoffAddress';
    return client.replyMessage(event.replyToken, [
      createTextMessage('請輸入送達地址'),
    ]);
  }

  if (session.step === 'dropoffAddress') {
    session.draft.dropoffAddress = normalized;

    if (session.mode === 'quoteOnly') {
      session.step = 'urgent';
      return client.replyMessage(event.replyToken, [
        createQuickReplyMessage('請選擇是否急件', [
          { type: 'postback', label: '是', data: 'urgent=yes', displayText: '是' },
          { type: 'postback', label: '否', data: 'urgent=no', displayText: '否' },
        ]),
      ]);
    }

    session.step = 'dropoffPhone';
    return client.replyMessage(event.replyToken, [
      createTextMessage('請輸入送達電話'),
    ]);
  }

  if (session.step === 'dropoffPhone') {
    session.draft.dropoffPhone = normalizePhone(normalized);
    session.step = 'urgent';
    return client.replyMessage(event.replyToken, [
      createQuickReplyMessage('請選擇是否急件', [
        { type: 'postback', label: '是', data: 'urgent=yes', displayText: '是' },
        { type: 'postback', label: '否', data: 'urgent=no', displayText: '否' },
      ]),
    ]);
  }

  if (session.step === 'note') {
    session.draft.note = normalized === '無' ? '' : normalized;
    session.step = null;
    return finishCreateOrder(event, userId, session.draft);
  }

  return client.replyMessage(event.replyToken, [
    createTextMessage('流程異常，請重新從主選單開始。'),
  ]);
}

// ===== Postback =====
async function handlePostback(event) {
  const data = event.postback.data || '';
  const userId = event.source.userId;

  if (data === 'menu=order') {
    return client.replyMessage(event.replyToken, [createOrderMenuFlex()]);
  }

  if (data === 'menu=business') {
    return client.replyMessage(event.replyToken, [createBusinessMenuFlex()]);
  }

  if (data === 'menu=info') {
    return client.replyMessage(event.replyToken, [createInfoMenuFlex()]);
  }

  if (data === 'submenu=createOrder') {
    return startCreateOrder(event.replyToken, userId);
  }

  if (data === 'submenu=quoteOnly') {
    return startQuoteOnly(event.replyToken, userId);
  }

  if (data === 'submenu=businessIntro') {
    return client.replyMessage(event.replyToken, getBusinessIntroText());
  }

  if (data === 'submenu=cancelRules') {
    return client.replyMessage(event.replyToken, getCancelRulesText());
  }

  if (data === 'submenu=faq') {
    return client.replyMessage(event.replyToken, getFaqText());
  }

  if (data === 'submenu=queryOrder') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '請輸入你的訂單編號，例如：UB202604240001',
    });
  }

  if (data === 'urgent=yes' || data === 'urgent=no') {
    const session = getOrCreateSession(userId);
    session.draft.isUrgent = data === 'urgent=yes';

    if (session.mode === 'quoteOnly') {
      session.step = null;
      return finishQuoteOnly(event, userId, session.draft);
    }

    session.step = 'note';
    return client.replyMessage(event.replyToken, [
      createTextMessage('請輸入備註；若沒有請輸入「無」'),
    ]);
  }

  if (data.startsWith('cancelCreate=')) {
    const orderId = data.split('=')[1];
    const order = orders[orderId];

    if (!order) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('找不到此訂單。'),
      ]);
    }

    if (order.customerId !== userId) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('這不是你的訂單。'),
      ]);
    }

    if (['accepted', 'arrived_pickup', 'picked_up', 'completed'].includes(order.status)) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('此訂單已進入配送流程，無法直接取消。'),
      ]);
    }

    delete orders[orderId];
    return client.replyMessage(event.replyToken, [
      createTextMessage('已取消本次訂單。'),
    ]);
  }

  if (data.startsWith('confirmCreate=')) {
    const orderId = data.split('=')[1];
    const order = orders[orderId];

    if (!order) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('找不到此訂單，請重新建立。'),
      ]);
    }

    if (order.customerId !== userId) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('這張確認卡不是你的訂單。'),
      ]);
    }

    order.status = 'pending_payment';

    return client.replyMessage(event.replyToken, [
      createTextMessage('任務資料已確認，請先完成付款。'),
      createPaymentMethodFlex(order),
    ]);
  }

  if (data.startsWith('showPaymentMethod=')) {
    const orderId = data.split('=')[1];
    const order = orders[orderId];

    if (!order) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('找不到此訂單。'),
      ]);
    }

    if (order.customerId !== userId) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('這不是你的訂單。'),
      ]);
    }

    return client.replyMessage(event.replyToken, [createPaymentMethodFlex(order)]);
  }

  if (data.startsWith('payment=')) {
    const parts = data.split('=');
    const method = parts[1];
    const orderId = parts[2];
    const order = orders[orderId];

    if (!order) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('找不到此訂單。'),
      ]);
    }

    if (order.customerId !== userId) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('這不是你的付款卡片。'),
      ]);
    }

    if (!['pending_payment', 'paid_pending_dispatch'].includes(order.status)) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('目前狀態不能選擇付款方式。'),
      ]);
    }

    if (!['jko', 'bank'].includes(method)) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('未識別的付款方式。'),
      ]);
    }

    order.paymentMethod = method;

    return client.replyMessage(event.replyToken, [createPaymentInfoFlex(order)]);
  }

  if (data.startsWith('confirmPayment=')) {
    const orderId = data.split('=')[1];
    const order = orders[orderId];

    if (!order) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('找不到此訂單。'),
      ]);
    }

    if (order.customerId !== userId) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('這不是你的訂單。'),
      ]);
    }

    if (!order.paymentMethod) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('請先選擇付款方式。'),
      ]);
    }

    if (order.isPaid) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('此訂單已經標記為付款完成，系統正在處理中。'),
      ]);
    }

    order.isPaid = true;
    order.paidAt = Date.now();
    order.status = 'pending_dispatch';

await db.collection('orders').doc(order.id).update({
  isPaid: true,
  paidAt: order.paidAt,
  status: 'pending_dispatch'
});
    await client.replyMessage(event.replyToken, [
      createTextMessage(
        `已收到你的付款通知。\n\n訂單編號：${order.id}\n付款方式：${getPaymentMethodLabel(order.paymentMethod)}\n系統正在通知騎手接單。`
      ),
    ]);

    await pushToGroup(LINE_GROUP_ID, createDispatchGroupFlex(order));
    return;
  }

  if (data.startsWith('accept=')) {
    const orderId = data.split('=')[1];

let order = orders[orderId];

if (!order) {
  const doc = await db.collection('orders').doc(orderId).get();
  if (doc.exists) {
    order = doc.data();
    orders[orderId] = order;
  }
}

    if (!order) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('找不到此訂單。'),
      ]);
    }

    if (order.status !== 'pending_dispatch') {
      return client.replyMessage(event.replyToken, [
        createTextMessage('此單已被接走或目前不可接單。'),
      ]);
    }

    order.status = 'accepted';
    order.riderId = userId;
    order.acceptedAt = Date.now();

await db.collection('orders').doc(orderId).update({
  status: 'accepted',
  riderId: userId,
  acceptedAt: Date.now()
});

    await client.replyMessage(event.replyToken, [
      createTextMessage(`你已成功接單：${order.id}`),
      createETAFlex(order),
    ]);
    return;
  }

  if (data.startsWith('showEta=')) {
    const orderId = data.split('=')[1];
    const order = orders[orderId];

    if (!order) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('找不到此訂單。'),
      ]);
    }

    if (order.riderId !== userId) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('只有接單騎手可以重新設定 ETA。'),
      ]);
    }

    return client.replyMessage(event.replyToken, [createETAFlex(order)]);
  }

  if (data.startsWith('eta=')) {
  const parts = data.split('=');
  const orderId = parts[1];
  const etaMinutes = Number(parts[2]);

  let order = orders[orderId];

  if (!order) {
    const doc = await db.collection('orders').doc(orderId).get();
    if (doc.exists) {
      order = doc.data();
      orders[orderId] = order;
    }
  }

    if (!order) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('找不到此訂單。'),
      ]);
    }

    if (order.riderId !== userId) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('只有接單騎手可以設定 ETA。'),
      ]);
    }

    if (!ETA_OPTIONS.includes(etaMinutes)) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('ETA 選項無效。'),
      ]);
    }

    if (!['accepted', 'arrived_pickup'].includes(order.status)) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('目前狀態不能設定 ETA。'),
      ]);
    }

    order.etaMinutes = etaMinutes;

    await client.replyMessage(event.replyToken, [
      createTextMessage(`已設定 ETA：${etaMinutes} 分鐘`),
      createRiderControlFlex(order),
    ]);

    await pushToUser(
      order.customerId,
      createTextMessage(`你的任務已由騎手接單，預計 ${etaMinutes} 分鐘抵達取件地點。`)
    );
    return;
  }

  if (data.startsWith('arrivedPickup=')) {
    const orderId = data.split('=')[1];
    const order = orders[orderId];

    if (!order) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('找不到此訂單。'),
      ]);
    }

    if (order.riderId !== userId) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('只有接單騎手可以操作此訂單。'),
      ]);
    }

    if (order.status !== 'accepted') {
      return client.replyMessage(event.replyToken, [
        createTextMessage('目前狀態不能操作「已抵達取件地點」。'),
      ]);
    }

    order.status = 'arrived_pickup';
    order.arrivedPickupAt = Date.now();

    await client.replyMessage(event.replyToken, [
      createTextMessage('已更新為：已抵達取件地點'),
      createRiderControlFlex(order),
    ]);

    await pushToUser(
      order.customerId,
      createTextMessage('騎手已抵達取件地點，請準備交件。')
    );
    return;
  }

  if (data.startsWith('pickedUp=')) {
    const orderId = data.split('=')[1];
    const order = orders[orderId];

    if (!order) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('找不到此訂單。'),
      ]);
    }

    if (order.riderId !== userId) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('只有接單騎手可以操作此訂單。'),
      ]);
    }

    if (!['accepted', 'arrived_pickup'].includes(order.status)) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('目前狀態不能操作「已取件」。'),
      ]);
    }

    order.status = 'picked_up';
    order.pickedUpAt = Date.now();

    await client.replyMessage(event.replyToken, [
      createTextMessage('已更新為：已取件'),
      createRiderControlFlex(order),
    ]);

    await pushToUser(
      order.customerId,
      createTextMessage('騎手已完成取件，正前往送達地點。')
    );
    return;
  }

  if (data.startsWith('completed=')) {
    const orderId = data.split('=')[1];
    const order = orders[orderId];

    if (!order) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('找不到此訂單。'),
      ]);
    }

    if (order.riderId !== userId) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('只有接單騎手可以操作此訂單。'),
      ]);
    }

    if (!['accepted', 'arrived_pickup', 'picked_up'].includes(order.status)) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('目前狀態不能操作「已送達」。'),
      ]);
    }

    order.status = 'completed';
    order.completedAt = Date.now();

    await client.replyMessage(event.replyToken, [
      createTextMessage(`任務 ${order.id} 已完成。`),
    ]);

    await pushToUser(order.customerId, [
      createTextMessage('你的任務已送達完成，感謝使用 UBee。'),
    ]);

    if (LINE_FINISH_GROUP_ID) {
      await pushToGroup(LINE_FINISH_GROUP_ID, createFinanceFlex(order));
    }
    return;
  }

  return client.replyMessage(event.replyToken, [
    createTextMessage('未識別的操作。'),
  ]);
}

// ===== Event =====
async function handleEvent(event) {
  try {
    if (event.type === 'follow') {
      return client.replyMessage(event.replyToken, [
        createTextMessage('歡迎使用 UBee'),
        createMainMenuFlex(),
      ]);
    }

    if (event.type === 'postback') {
      return handlePostback(event);
    }

    if (event.type === 'message' && event.message.type === 'text') {
      if (event.source.type === 'group') {
        return;
      }

      const userId = event.source.userId;
      const text = (event.message.text || '').trim();

      if (/^UB\d+/i.test(text)) {
        const orderId = text.toUpperCase();
        const order = orders[orderId];

        if (!order) {
          return client.replyMessage(
            event.replyToken,
            createTextMessage('查無此訂單，請確認訂單編號是否正確。')
          );
        }

        return client.replyMessage(
          event.replyToken,
          createTextMessage(
            `📦 訂單查詢結果\n\n` +
            `訂單編號：${orderId}\n` +
            `狀態：${getStatusLabel(order.status)}\n` +
            `取件地址：${order.pickupAddress || '未填寫'}\n` +
            `送達地址：${order.dropoffAddress || '未填寫'}`
          )
        );
      }

      return handleTextStep(event, userId, text);
    }

    if (event.replyToken) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('目前僅支援文字與按鈕操作。'),
      ]);
    }
  } catch (error) {
    console.error('❌ handleEvent 錯誤：', error);

    if (event.replyToken) {
      try {
        await client.replyMessage(event.replyToken, [
          createTextMessage('系統忙碌中，請稍後再試。'),
        ]);
      } catch (replyError) {
        console.error('❌ replyMessage 錯誤：', replyError);
      }
    }
  }
}

// ===== Webhook =====
app.get('/', (req, res) => {
  res.send('UBee OMS 主選單精簡版（完整付款版）運作中');
});
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});
app.get('/test-firebase', async (req, res) => {
  try {
    await db.collection('test').add({
      message: 'Firebase 連線成功',
      time: new Date(),
    });

    res.send('✅ Firebase OK');
  } catch (error) {
    console.error(error);
    res.send('❌ Firebase 失敗');
  }
});
app.head('/', (req, res) => {
  res.sendStatus(200);
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  res.status(200).send('OK');

  const events = req.body.events || [];

  try {
    await Promise.all(events.map(handleEvent));
  } catch (error) {
    console.error('❌ webhook 錯誤，加入補處理：', error);
    eventQueue.push(...events);
  }
});

setInterval(async () => {
  if (eventQueue.length === 0) return;

  console.log(`🔄 補處理事件：${eventQueue.length} 筆`);

  const queue = [...eventQueue];
  eventQueue = [];

  try {
    await Promise.all(queue.map(handleEvent));
  } catch (err) {
  console.error('❌ 補處理錯誤：', err);
  eventQueue.push(...queue);
}
}, 10000);

app.listen(PORT, () => {
  console.log(`✅ UBee OMS 主選單精簡版（完整付款版）啟動成功，PORT: ${PORT}`);
});

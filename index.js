require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');
const path = require('path');

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
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
const LINE_FINISH_GROUP_ID = process.env.LINE_FINISH_GROUP_ID || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const LIFF_ID = process.env.LIFF_ID || '';

const PAYMENT_JKO_INFO =
  (process.env.PAYMENT_JKO_INFO || '街口支付\n帳號：請填入你的街口帳號').replace(/\\n/g, '\n');

const PAYMENT_BANK_INFO =
  (process.env.PAYMENT_BANK_INFO || '銀行轉帳\n銀行：請填入銀行名稱\n帳號：請填入銀行帳號\n戶名：請填入戶名').replace(/\\n/g, '\n');

const BUSINESS_FORM_URL =
  process.env.BUSINESS_FORM_URL ||
  'https://docs.google.com/forms/d/e/1FAIpQLScn9AGnp4FbTGg6fZt5fpiMdNEi-yL9x595bTyVFHAoJmpYlA/viewform';

const PARTNER_FORM_URL = process.env.PARTNER_FORM_URL || BUSINESS_FORM_URL;

if (!LINE_GROUP_ID) {
  console.error('❌ 缺少 LINE_GROUP_ID');
  process.exit(1);
}

if (!GOOGLE_MAPS_API_KEY) {
  console.error('❌ 缺少 GOOGLE_MAPS_API_KEY');
  process.exit(1);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get('/order.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

const PRICING = {
  baseFee: 99,
  perKm: 8,
  perMinute: 2,
  serviceFee: 50,
  waitingFee: 60,
  driverRatio: 0.6,
};

const SPEED_OPTIONS = {
  standard: { label: '一般件', time: '60–120 分鐘', fee: 0, riderText: '一般配送' },
  priority: { label: '快速件', time: '45–60 分鐘', fee: 50, riderText: '優先派單' },
  express: { label: '急件', time: '30–45 分鐘', fee: 100, riderText: '急件優先' },
  rush: { label: '極速件', time: '20–30 分鐘', fee: 200, riderText: '專人專送' },
};

const ETA_OPTIONS = [5, 7, 8, 10, 12, 15, 17, 20, 25];

const orders = {};
const userSessions = {};
const distanceCache = new Map();
let orderCounter = 1;

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

function normalizeAddress(address) {
  return String(address || '').trim().replace(/\s+/g, '');
}

function getDistanceCacheKey(origin, destination) {
  return `${normalizeAddress(origin)}=>${normalizeAddress(destination)}`;
}

function getPublicUrl(fileName) {
  return BASE_URL ? `${BASE_URL}/${fileName}` : `/${fileName}`;
}

function buildGoogleMapDirectionsUrl(address) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address || '')}`;
}

function buildTelUrl(phone) {
  const clean = normalizePhone(phone);
  return clean ? `tel:${clean}` : 'tel:';
}

function getSpeedOption(speedType) {
  return SPEED_OPTIONS[speedType] || SPEED_OPTIONS.standard;
}

function getPaymentMethodLabel(method) {
  return ({ jko: '街口支付', bank: '銀行轉帳' }[method] || '未選擇');
}

function getStatusLabel(status) {
  return ({
    draft_confirm: '📝 待確認',
    pending_payment: '💳 待付款',
    pending_dispatch: '🟡 待派單',
    accepted: '🟢 已接單',
    arrived_pickup: '🟠 已抵達取件地點',
    picked_up: '🔵 已取件',
    completed: '✅ 已完成',
    cancelled: '⚪ 已取消',
    quote_only: '💰 估價完成',
  }[status] || status);
}

function createTextMessage(text) {
  return { type: 'text', text };
}

function createFlexMessage(altText, bubble) {
  return { type: 'flex', altText, contents: bubble };
}

function createActionButton(label, data, style = 'primary') {
  return {
    type: 'button',
    style,
    height: 'sm',
    action: { type: 'postback', label, data },
  };
}

function createUriButton(label, uri, style = 'secondary') {
  return {
    type: 'button',
    style,
    height: 'sm',
    action: { type: 'uri', label, uri },
  };
}

function createInfoRow(label, value, wrap = true) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#666666', flex: 3 },
      { type: 'text', text: String(value || '-'), size: 'sm', color: '#111111', wrap, flex: 7 },
    ],
  };
}

function createTextBlock(title, text) {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'xs',
    paddingAll: '12px',
    backgroundColor: '#F7F7F7',
    cornerRadius: '12px',
    contents: [
      { type: 'text', text: title, weight: 'bold', size: 'sm', color: '#111111', wrap: true },
      { type: 'text', text, size: 'sm', color: '#555555', wrap: true, margin: 'xs' },
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
      contents: [{ type: 'text', text: title, weight: 'bold', size: 'lg', color: '#111111' }],
      paddingAll: '16px',
      backgroundColor: '#FFF4CC',
    },
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: bodyContents },
  };

  if (footerContents.length > 0) {
    bubble.footer = { type: 'box', layout: 'vertical', spacing: 'sm', contents: footerContents };
  }

  return bubble;
}

async function pushToUser(userId, messages) {
  if (!userId || userId === 'web-order') return;
  const list = Array.isArray(messages) ? messages : [messages];
  await client.pushMessage(userId, list);
}

async function notifyCustomer(order, messages) {
  try {
    if (!order || !order.customerId || order.customerId === 'web-order') {
      console.log(`⚠️ 訂單 ${order?.id || 'UNKNOWN'} 沒有綁定客人 LINE userId`);
      return false;
    }

    await pushToUser(order.customerId, messages);
    return true;
  } catch (err) {
    console.error(`❌ 通知客人失敗：${order?.id || 'UNKNOWN'}`, err);
    return false;
  }
}

async function pushToGroup(groupId, messages) {
  if (!groupId) return;
  const list = Array.isArray(messages) ? messages : [messages];
  await client.pushMessage(groupId, list);
}

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
  if (distanceCache.has(key)) return distanceCache.get(key);
  const distance = await getDistanceMatrix(origin, destination);
  distanceCache.set(key, distance);
  return distance;
}

function calculatePrice({ distanceMeters, durationSeconds, speedType }) {
  const km = distanceMeters / 1000;
  const minutes = durationSeconds / 60;
  const speed = getSpeedOption(speedType);

  const deliveryFee = Math.round(
    PRICING.baseFee + km * PRICING.perKm + minutes * PRICING.perMinute
  );

  const total = deliveryFee + PRICING.serviceFee + speed.fee;
  const driverFee = Math.round(total * PRICING.driverRatio);

  return {
    deliveryFee,
    serviceFee: PRICING.serviceFee,
    speedFee: speed.fee,
    waitingFee: 0,
    total,
    driverFee,
    platformFee: total - driverFee,
  };
}

function recalculateOrderFinancials(order) {
  const total =
    Number(order.deliveryFee || 0) +
    Number(order.serviceFee || 0) +
    Number(order.speedFee || 0) +
    Number(order.waitingFee || 0);

  order.total = Math.round(total);
  order.driverFee = Math.round(order.total * PRICING.driverRatio);
  order.platformFee = order.total - order.driverFee;
  return order;
}

function createMainMenuFlex() {
  return createFlexMessage('UBee 主選單', createBubble(
    'UBee 主選單',
    [{ type: 'text', text: '請選擇你要使用的功能。', size: 'sm', color: '#666666', wrap: true }],
    [
      createUriButton('立即下單', getPublicUrl('order.html'), 'primary'),
      createUriButton('商務合作', getPublicUrl('business.html'), 'secondary'),
      createActionButton('我的資訊', 'menu=info', 'secondary'),
    ]
  ));
}

function createInfoMenuFlex() {
  return createFlexMessage('我的資訊', {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [{ type: 'text', text: '📋 UBee｜我的資訊', weight: 'bold', size: 'lg', color: '#111111' }],
      paddingAll: '16px',
      backgroundColor: '#FFF4CC',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [{ type: 'text', text: '請選擇你要查看的內容👇', size: 'sm', color: '#666666', wrap: true }],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        createActionButton('取消規則', 'submenu=cancelRules'),
        createActionButton('常見問題', 'submenu=faq', 'secondary'),
        createActionButton('查詢訂單', 'submenu=queryOrder', 'secondary'),
        createUriButton('加入夥伴', PARTNER_FORM_URL, 'secondary'),
      ],
    },
  });
}

function createCancelRulesFlex() {
  return createFlexMessage('取消規則', createBubble(
    '取消規則',
    [
      createTextBlock('① 未接單', '可免費取消。'),
      createTextBlock('② 已接單', '酌收配送費 30%，最低 NT$60，最高 NT$200。'),
      createTextBlock('③ 騎手已抵達取件地點', '酌收配送費 50%，最低 NT$100，最高 NT$300。'),
      createTextBlock('④ 已取件後', '原則上不可取消，若有特殊狀況請聯繫 UBee。'),
    ],
    [createActionButton('返回我的資訊', 'menu=info', 'secondary')]
  ));
}

function createFaqFlex() {
  return createFlexMessage('常見問題', createBubble(
    '常見問題',
    [
      createTextBlock('Q1：UBee 可以送什麼？', '文件、合約、發票、樣品、商務物品、個人物品、安全代送與私人物件。'),
      createTextBlock('Q2：UBee 不接哪些項目？', '違法物品、危險品、易燃物、活體動物、高價未保管物、高度個資風險或需特殊證照的項目恕不承接。'),
      createTextBlock('Q3：多久可以送達？', '依距離、路況與速度選項而定。一般件約 60–120 分鐘，快速件約 45–60 分鐘，急件約 30–45 分鐘，極速件約 20–30 分鐘。'),
      createTextBlock('Q4：費用怎麼計算？', '費用依 Google Maps 距離與時間計算，並加上服務費與速度費。'),
      createTextBlock('Q5：付款方式有哪些？', '目前支援街口支付與銀行轉帳。'),
      createTextBlock('Q6：什麼是等候費？', '騎手抵達現場後，若需要額外等候超過 3–5 分鐘，可能會申請等候費 NT$60。客人同意後才會加收。'),
      createTextBlock('Q7：可以查詢訂單嗎？', '可以。點選「查詢訂單」後，輸入訂單編號即可查看目前狀態。'),
      createTextBlock('Q8：有開發票或收據嗎？', '目前提供收據或交易紀錄，暫不開立統一發票。'),
    ],
    [createActionButton('返回我的資訊', 'menu=info', 'secondary')]
  ));
}

function createQueryOrderFlex() {
  return createFlexMessage('查詢訂單', createBubble(
    '查詢訂單',
    [
      { type: 'text', text: '請直接在聊天室輸入你的訂單編號，系統會回覆目前狀態。', size: 'sm', color: '#666666', wrap: true },
      createTextBlock('輸入範例', 'UB202604270001'),
    ],
    [createActionButton('返回我的資訊', 'menu=info', 'secondary')]
  ));
}

function createOrderStatusFlex(order) {
  const waitingStatus = order.waitingFeeApproved
    ? '已同意等候費'
    : order.waitingFeeRejected
      ? '不同意等候費'
      : order.waitingFeeRequested
        ? '等待客人確認'
        : '尚未申請';

  return createFlexMessage('訂單查詢結果', createBubble(
    '訂單查詢結果',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('目前狀態', getStatusLabel(order.status)),
      createInfoRow('配送速度', getSpeedOption(order.speedType).label),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('ETA', order.etaMinutes ? `${order.etaMinutes} 分鐘` : '尚未設定'),
      createInfoRow('付款狀態', order.isPaid ? '已付款' : '尚未付款'),
      createInfoRow('付款方式', getPaymentMethodLabel(order.paymentMethod)),
      createInfoRow('等候費狀態', waitingStatus),
      createInfoRow('目前總金額', formatCurrency(order.total)),
    ],
    [createActionButton('返回我的資訊', 'menu=info', 'secondary')]
  ));
}

function createOrderConfirmFlex(order) {
  const speed = getSpeedOption(order.speedType);
  return createFlexMessage('確認建立任務', createBubble(
    '確認建立任務',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('服務類型', order.serviceType),
      createInfoRow('配送速度', `${speed.label}｜${speed.time}`),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('取件電話', order.pickupPhone),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('送達電話', order.dropoffPhone),
      createInfoRow('物品內容', order.item),
      createInfoRow('備註', order.note || '無'),
      { type: 'separator', margin: 'md' },
      createInfoRow('距離', order.distanceText),
      createInfoRow('時間', order.durationText),
      createInfoRow('配送費', formatCurrency(order.deliveryFee)),
      createInfoRow('服務費', formatCurrency(order.serviceFee)),
      createInfoRow('速度費', formatCurrency(order.speedFee)),
      createInfoRow('總金額', formatCurrency(order.total)),
    ],
    [
      createActionButton('確認並前往付款', `confirmCreate=${order.id}`),
      createActionButton('取消', `cancelCreate=${order.id}`, 'secondary'),
    ]
  ));
}

function createQuoteFlex(order) {
  const speed = getSpeedOption(order.speedType);
  return createFlexMessage('立即估價結果', createBubble(
    '立即估價結果',
    [
      createInfoRow('配送速度', `${speed.label}｜${speed.time}`),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('距離', order.distanceText),
      createInfoRow('時間', order.durationText),
      createInfoRow('預估總金額', formatCurrency(order.total)),
    ],
    [createUriButton('建立任務', getPublicUrl('order.html'), 'primary')]
  ));
}

function createDispatchGroupFlex(order) {
  const speed = getSpeedOption(order.speedType);
  return createFlexMessage('UBee 新任務通知', createBubble(
    'UBee 新任務通知',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('狀態', getStatusLabel(order.status)),
      createInfoRow('配送速度', `${speed.label}｜${speed.riderText}`),
      createInfoRow('服務類型', order.serviceType),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('物品內容', order.item),
      createInfoRow('備註', order.note || '無'),
      createInfoRow('騎手收入', formatCurrency(order.driverFee)),
    ],
    [
      createActionButton('接受訂單', `accept=${order.id}`),
      createUriButton('導航到取件地點', buildGoogleMapDirectionsUrl(order.pickupAddress)),
    ]
  ));
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
  return createFlexMessage('請選擇 ETA', createBubble(
    '請選擇 ETA',
    [
      { type: 'text', text: '請選擇預計抵達取件地點時間。', size: 'sm', color: '#666666', wrap: true },
      createInfoRow('訂單編號', order.id),
      createInfoRow('取件地址', order.pickupAddress),
      createEtaRow(order.id, [5, 7, 8]),
      createEtaRow(order.id, [10, 12, 15]),
      createEtaRow(order.id, [17, 20, 25]),
    ]
  ));
}

function createRiderControlFlex(order) {
  const waitingLabel = order.waitingFeeApproved
    ? '已同意等候費'
    : order.waitingFeeRejected
      ? '客人不同意等候費'
      : order.waitingFeeRequested
        ? '已申請，等待客人確認'
        : '尚未申請';

  return createFlexMessage('騎手任務操作', createBubble(
    '騎手任務操作',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('狀態', getStatusLabel(order.status)),
      createInfoRow('ETA', order.etaMinutes ? `${order.etaMinutes} 分鐘` : '尚未設定'),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('取件電話', order.pickupPhone),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('送達電話', order.dropoffPhone),
      createInfoRow('等候費', waitingLabel),
      createInfoRow('騎手收入', formatCurrency(order.driverFee)),
    ],
    [
      createActionButton('重新設定 ETA', `showEta=${order.id}`, 'secondary'),
      createActionButton('已抵達取件地點', `arrivedPickup=${order.id}`),
      createActionButton('申請等候費 $60', `requestWaitingFee=${order.id}`, 'secondary'),
      createActionButton('已取件', `pickedUp=${order.id}`),
      createUriButton('導航到送達地點', buildGoogleMapDirectionsUrl(order.dropoffAddress)),
      createUriButton('撥打取件電話', buildTelUrl(order.pickupPhone), 'secondary'),
      createUriButton('撥打送達電話', buildTelUrl(order.dropoffPhone), 'secondary'),
      createActionButton('已送達', `completed=${order.id}`),
    ]
  ));
}

function createPaymentMethodFlex(order) {
  return createFlexMessage('請選擇付款方式', createBubble(
    '請選擇付款方式',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('總金額', formatCurrency(order.total)),
      { type: 'text', text: '請先完成付款，再按「我已付款」。系統收到付款通知後，才會通知騎手接單。', size: 'sm', color: '#666666', wrap: true },
    ],
    [
      createActionButton('街口支付', `payment=jko=${order.id}`),
      createActionButton('銀行轉帳', `payment=bank=${order.id}`, 'secondary'),
      createActionButton('取消此訂單', `cancelCreate=${order.id}`, 'secondary'),
    ]
  ));
}

function createPaymentInfoFlex(order) {
  const paymentInfo = order.paymentMethod === 'jko' ? PAYMENT_JKO_INFO : PAYMENT_BANK_INFO;

  return createFlexMessage('付款資訊', createBubble(
    order.paymentMethod === 'jko' ? '街口支付資訊' : '銀行轉帳資訊',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('付款方式', getPaymentMethodLabel(order.paymentMethod)),
      createInfoRow('應付金額', formatCurrency(order.total)),
      { type: 'separator', margin: 'md' },
      { type: 'text', text: paymentInfo, size: 'sm', color: '#111111', wrap: true },
      { type: 'text', text: '完成付款後，請按下方「我已付款」。', size: 'sm', color: '#666666', wrap: true },
    ],
    [
      createActionButton('我已付款', `confirmPayment=${order.id}`),
      createActionButton('重新選付款方式', `showPaymentMethod=${order.id}`, 'secondary'),
    ]
  ));
}

function createWaitingFeeConfirmFlex(order) {
  return createFlexMessage('等候費確認', createBubble(
    '等候費確認',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('申請金額', formatCurrency(PRICING.waitingFee)),
      { type: 'text', text: '騎手已抵達現場並等候超過 3–5 分鐘，將申請等候費 NT$60。請問是否同意加收？', size: 'sm', color: '#333333', wrap: true },
    ],
    [
      createActionButton('同意加收 $60', `waitingApprove=${order.id}`),
      createActionButton('不同意加收', `waitingReject=${order.id}`, 'secondary'),
    ]
  ));
}

function createFinanceFlex(order) {
  const speed = getSpeedOption(order.speedType);
  return createFlexMessage('UBee 財務明細', createBubble(
    'UBee 財務明細',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('付款方式', getPaymentMethodLabel(order.paymentMethod)),
      createInfoRow('付款狀態', order.isPaid ? '已付款' : '未付款'),
      createInfoRow('配送速度', speed.label),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('ETA', order.etaMinutes ? `${order.etaMinutes} 分鐘` : '未設定'),
      createInfoRow('配送費', formatCurrency(order.deliveryFee)),
      createInfoRow('服務費', formatCurrency(order.serviceFee)),
      createInfoRow('速度費', formatCurrency(order.speedFee)),
      createInfoRow('等候費', formatCurrency(order.waitingFee || 0)),
      createInfoRow('總金額', formatCurrency(order.total)),
      createInfoRow('騎手收入', formatCurrency(order.driverFee)),
      createInfoRow('平台收入', formatCurrency(order.platformFee)),
    ]
  ));
}

function getOrCreateSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = { mode: null, step: null, draft: {} };
  }
  return userSessions[userId];
}

function resetUserSession(userId) {
  delete userSessions[userId];
}

async function startCreateOrder(replyToken, userId) {
  const session = getOrCreateSession(userId);
  session.mode = 'createOrder';
  session.step = 'pickupAddress';
  session.draft = {};
  await client.replyMessage(replyToken, [createTextMessage('請輸入取件地址')]);
}

async function startQuoteOnly(replyToken, userId) {
  const session = getOrCreateSession(userId);
  session.mode = 'quoteOnly';
  session.step = 'pickupAddress';
  session.draft = {};
  await client.replyMessage(replyToken, [createTextMessage('請輸入取件地址（立即估價）')]);
}

async function finishQuoteOnly(event, userId, draft) {
  await client.replyMessage(event.replyToken, [createTextMessage('正在計算中，請稍候...')]);

  (async () => {
    try {
      const distance = await getDistanceMatrixCached(draft.pickupAddress, draft.dropoffAddress);
      const price = calculatePrice({
        distanceMeters: distance.distanceMeters,
        durationSeconds: distance.durationSeconds,
        speedType: draft.speedType || 'standard',
      });

      const order = {
        id: 'QUOTE',
        status: 'quote_only',
        pickupAddress: draft.pickupAddress,
        dropoffAddress: draft.dropoffAddress,
        speedType: draft.speedType || 'standard',
        distanceText: distance.distanceText,
        durationText: distance.durationText,
        ...price,
      };

      resetUserSession(userId);
      await pushToUser(userId, [createQuoteFlex(order)]);
    } catch (error) {
      console.error('❌ 立即估價背景計算失敗：', error);
      resetUserSession(userId);
      await pushToUser(userId, createTextMessage('計算失敗，請重新操作'));
    }
  })();
}

async function finishCreateOrder(event, userId, draft) {
  const orderId = generateOrderId();

  await client.replyMessage(event.replyToken, [
    createTextMessage('正在建立任務，系統計算費用中...'),
  ]);

  (async () => {
    try {
      const distance = await getDistanceMatrixCached(draft.pickupAddress, draft.dropoffAddress);
      const price = calculatePrice({
        distanceMeters: distance.distanceMeters,
        durationSeconds: distance.durationSeconds,
        speedType: draft.speedType || 'standard',
      });

      const order = {
        id: orderId,
        customerId: userId,
        riderId: '',
        status: 'draft_confirm',
        serviceType: draft.serviceType || '文件急送',
        item: draft.item || '',
        pickupAddress: draft.pickupAddress,
        pickupPhone: draft.pickupPhone,
        dropoffAddress: draft.dropoffAddress,
        dropoffPhone: draft.dropoffPhone,
        speedType: draft.speedType || 'standard',
        note: draft.note || '',
        distanceMeters: distance.distanceMeters,
        durationSeconds: distance.durationSeconds,
        distanceText: distance.distanceText,
        durationText: distance.durationText,
        ...price,
        etaMinutes: null,
        paymentMethod: '',
        isPaid: false,
        paidAt: null,
        waitingFeeRequested: false,
        waitingFeeApproved: false,
        waitingFeeRejected: false,
        waitingFeeRequestedAt: null,
        createdAt: Date.now(),
        acceptedAt: null,
        arrivedPickupAt: null,
        pickedUpAt: null,
        completedAt: null,
      };

      orders[order.id] = order;
      resetUserSession(userId);
      await pushToUser(userId, [createOrderConfirmFlex(order)]);
    } catch (error) {
      console.error('❌ 建立任務背景計算失敗：', error);
      resetUserSession(userId);
      await pushToUser(userId, createTextMessage('抱歉，地址計算失敗，請重新輸入「建立任務」再試一次。'));
    }
  })();
}

async function handleTextStep(event, userId, text) {
  const session = getOrCreateSession(userId);
  const normalized = text.trim();

  if (!session.step) {
    if (normalized === '主選單') return client.replyMessage(event.replyToken, [createMainMenuFlex()]);
    if (normalized === '立即下單') return client.replyMessage(event.replyToken, [createMainMenuFlex()]);
    if (normalized === '商務合作') return client.replyMessage(event.replyToken, [createTextMessage('請點選商務合作頁面或填寫合作表單。')]);
    if (normalized === '我的資訊' || normalized === '我的任務') return client.replyMessage(event.replyToken, [createInfoMenuFlex()]);
    if (normalized === '建立任務') return startCreateOrder(event.replyToken, userId);
    if (normalized === '立即估價') return startQuoteOnly(event.replyToken, userId);
    if (normalized === '取消規則') return client.replyMessage(event.replyToken, [createCancelRulesFlex()]);
    if (normalized === '常見問題') return client.replyMessage(event.replyToken, [createFaqFlex()]);
    if (normalized === '查詢訂單') return client.replyMessage(event.replyToken, [createQueryOrderFlex()]);

    return client.replyMessage(event.replyToken, [
      createTextMessage('歡迎使用 UBee'),
      createMainMenuFlex(),
    ]);
  }

  if (session.step === 'pickupAddress') {
    session.draft.pickupAddress = normalized;
    if (session.mode === 'quoteOnly') {
      session.step = 'dropoffAddress';
      return client.replyMessage(event.replyToken, [createTextMessage('請輸入送達地址')]);
    }
    session.step = 'pickupPhone';
    return client.replyMessage(event.replyToken, [createTextMessage('請輸入取件電話')]);
  }

  if (session.step === 'pickupPhone') {
    session.draft.pickupPhone = normalizePhone(normalized);
    session.step = 'dropoffAddress';
    return client.replyMessage(event.replyToken, [createTextMessage('請輸入送達地址')]);
  }

  if (session.step === 'dropoffAddress') {
    session.draft.dropoffAddress = normalized;
    if (session.mode === 'quoteOnly') {
      session.step = 'speed';
      return client.replyMessage(event.replyToken, [createTextMessage('請輸入配送速度：一般件 / 快速件 / 急件 / 極速件')]);
    }
    session.step = 'dropoffPhone';
    return client.replyMessage(event.replyToken, [createTextMessage('請輸入送達電話')]);
  }

  if (session.step === 'dropoffPhone') {
    session.draft.dropoffPhone = normalizePhone(normalized);
    session.step = 'serviceType';
    return client.replyMessage(event.replyToken, [createTextMessage('請輸入服務類型，例如：文件急送、商務物品、個人物品、安全代送')]);
  }

  if (session.step === 'serviceType') {
    session.draft.serviceType = normalized;
    session.step = 'item';
    return client.replyMessage(event.replyToken, [createTextMessage('請輸入物品內容，例如：合約、樣品、文件袋')]);
  }

  if (session.step === 'item') {
    session.draft.item = normalized;
    session.step = 'speed';
    return client.replyMessage(event.replyToken, [createTextMessage('請輸入配送速度：一般件 / 快速件 / 急件 / 極速件')]);
  }

  if (session.step === 'speed') {
    const map = {
      一般件: 'standard',
      一般: 'standard',
      快速件: 'priority',
      快速: 'priority',
      急件: 'express',
      極速件: 'rush',
      極速: 'rush',
    };
    session.draft.speedType = map[normalized] || 'standard';

    if (session.mode === 'quoteOnly') {
      session.step = null;
      return finishQuoteOnly(event, userId, session.draft);
    }

    session.step = 'note';
    return client.replyMessage(event.replyToken, [createTextMessage('請輸入備註；若沒有請輸入「無」')]);
  }

  if (session.step === 'note') {
    session.draft.note = normalized === '無' ? '' : normalized;
    session.step = null;
    return finishCreateOrder(event, userId, session.draft);
  }

  return client.replyMessage(event.replyToken, [createTextMessage('流程異常，請重新從主選單開始。')]);
}

async function handlePostback(event) {
  const data = event.postback.data || '';
  const userId = event.source.userId;
  
  console.log('========== POSTBACK 進來了 ==========');
  console.log('data:', data);
  console.log('userId:', userId);
  console.log('source:', event.source);

  if (data === 'menu=info') return client.replyMessage(event.replyToken, [createInfoMenuFlex()]);
  if (data === 'submenu=cancelRules') return client.replyMessage(event.replyToken, [createCancelRulesFlex()]);
  if (data === 'submenu=faq') return client.replyMessage(event.replyToken, [createFaqFlex()]);
  if (data === 'submenu=queryOrder') return client.replyMessage(event.replyToken, [createQueryOrderFlex()]);
  if (data === 'submenu=createOrder') return startCreateOrder(event.replyToken, userId);
  if (data === 'submenu=quoteOnly') return startQuoteOnly(event.replyToken, userId);

  if (data.startsWith('cancelCreate=')) {
    const orderId = data.split('=')[1];
    const order = orders[orderId];

    if (!order) return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單。')]);
    if (order.customerId !== userId) return client.replyMessage(event.replyToken, [createTextMessage('這不是你的訂單。')]);

    if (['accepted', 'arrived_pickup', 'picked_up', 'completed'].includes(order.status)) {
      return client.replyMessage(event.replyToken, [createTextMessage('此訂單已進入配送流程，無法直接取消。')]);
    }

    order.status = 'cancelled';
    delete orders[orderId];

    return client.replyMessage(event.replyToken, [createTextMessage('已取消本次訂單。')]);
  }

  if (data.startsWith('confirmCreate=')) {
    const orderId = data.split('=')[1];
    const order = orders[orderId];

    if (!order) return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單，請重新建立。')]);
    if (order.customerId !== userId) return client.replyMessage(event.replyToken, [createTextMessage('這張確認卡不是你的訂單。')]);

    order.status = 'pending_payment';

    return client.replyMessage(event.replyToken, [
      createTextMessage('任務資料已確認，請先完成付款。'),
      createPaymentMethodFlex(order),
    ]);
  }

  if (data.startsWith('showPaymentMethod=')) {
    const orderId = data.split('=')[1];
    const order = orders[orderId];

    if (!order) return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單。')]);
    if (order.customerId !== userId) return client.replyMessage(event.replyToken, [createTextMessage('這不是你的訂單。')]);

    return client.replyMessage(event.replyToken, [createPaymentMethodFlex(order)]);
  }

  if (data.startsWith('payment=')) {
    const parts = data.split('=');
    const method = parts[1];
    const orderId = parts[2];
    const order = orders[orderId];

    if (!order) return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單。')]);
    if (order.customerId !== userId) return client.replyMessage(event.replyToken, [createTextMessage('這不是你的付款卡片。')]);
    if (order.status !== 'pending_payment') return client.replyMessage(event.replyToken, [createTextMessage('目前狀態不能選擇付款方式。')]);
    if (!['jko', 'bank'].includes(method)) return client.replyMessage(event.replyToken, [createTextMessage('未識別的付款方式。')]);

    order.paymentMethod = method;
    return client.replyMessage(event.replyToken, [createPaymentInfoFlex(order)]);
  }

  if (data.startsWith('confirmPayment=')) {
    const orderId = data.split('=')[1];
    const order = orders[orderId];

    if (!order) return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單。')]);
    if (order.customerId !== userId) return client.replyMessage(event.replyToken, [createTextMessage('這不是你的訂單。')]);
    if (!order.paymentMethod) return client.replyMessage(event.replyToken, [createTextMessage('請先選擇付款方式。')]);

    if (order.isPaid) {
      return client.replyMessage(event.replyToken, [createTextMessage('此訂單已經標記為付款完成，系統正在處理中。')]);
    }

    order.isPaid = true;
    order.paidAt = Date.now();
    order.status = 'pending_dispatch';

    await client.replyMessage(event.replyToken, [
      createTextMessage(
        `已收到你的付款通知。\n\n訂單編號：${order.id}\n付款方式：${getPaymentMethodLabel(order.paymentMethod)}\n\n🚀 系統正在為你配對騎手，請稍候...`
      ),
    ]);

    await pushToGroup(LINE_GROUP_ID, createDispatchGroupFlex(order));
    return;
  }

if (data.startsWith('accept=')) {
  const orderId = data.split('=')[1];
  const order = orders[orderId];

  if (!order) {
    return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單。')]);
  }

  if (order.status !== 'pending_dispatch') {
    return client.replyMessage(event.replyToken, [createTextMessage('此單已被接走或目前不可接單。')]);
  }

  // ✅ 先改狀態（最重要）
  order.status = 'accepted';
  order.riderId = userId;
  order.acceptedAt = Date.now();

  // ✅ 先回覆騎手（避免卡住）
  await client.replyMessage(event.replyToken, [
    createTextMessage(`✅ 你已成功接單：${order.id}`)
  ]);

  // ✅ 再通知客人（防炸）
  try {
    if (order.customerId && order.customerId !== 'web-order') {
      await pushToUser(order.customerId, [
        createTextMessage('✅ 已有騎手接單，正在前往取件地點。')
      ]);
    }
  } catch (err) {
    console.error('❌ 客人通知失敗（接單）', err);
  }

  // ✅ 推 ETA（防炸）
try {
  await pushToGroup(LINE_GROUP_ID, createETAFlex(order));
} catch (err) {
  console.error('❌ ETA 卡推送失敗', err);
}

  return;
}

if (data.startsWith('showEta=')) {
  const orderId = data.split('=')[1];
  const order = orders[orderId];

  if (!order) return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單。')]);
  if (order.riderId !== userId) {
    return client.replyMessage(event.replyToken, [createTextMessage('只有接單騎手可以重新設定 ETA。')]);
  }

  return client.replyMessage(event.replyToken, [createETAFlex(order)]);
}

if (data.startsWith('eta=')) {
  const parts = data.split('=');
  const orderId = parts[1];
  const etaMinutes = Number(parts[2]);
  const order = orders[orderId];

  if (!order) return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單。')]);
  if (order.riderId !== userId) {
    return client.replyMessage(event.replyToken, [createTextMessage('只有接單騎手可以設定 ETA。')]);
  }
  if (!ETA_OPTIONS.includes(etaMinutes)) {
    return client.replyMessage(event.replyToken, [createTextMessage('ETA 選項無效。')]);
  }
  if (!['accepted', 'arrived_pickup'].includes(order.status)) {
    return client.replyMessage(event.replyToken, [createTextMessage('目前狀態不能設定 ETA。')]);
  }

  order.etaMinutes = etaMinutes;

  await client.replyMessage(event.replyToken, [
    createTextMessage(`已設定 ETA：${etaMinutes} 分鐘`),
    createRiderControlFlex(order),
  ]);

  await notifyCustomer(
    order,
    createTextMessage(`你的任務已由騎手接單，預計 ${etaMinutes} 分鐘抵達取件地點。`)
  );

  return;
}

if (data.startsWith('arrivedPickup=')) {
  const orderId = data.split('=')[1];
  const order = orders[orderId];

  if (!order) return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單。')]);
  if (order.riderId !== userId) {
    return client.replyMessage(event.replyToken, [createTextMessage('只有接單騎手可以操作此訂單。')]);
  }
  if (order.status !== 'accepted') {
    return client.replyMessage(event.replyToken, [createTextMessage('目前狀態不能操作「已抵達取件地點」。')]);
  }

  order.status = 'arrived_pickup';
  order.arrivedPickupAt = Date.now();

  await client.replyMessage(event.replyToken, [
    createTextMessage('已更新為：已抵達取件地點'),
    createRiderControlFlex(order),
  ]);

  await notifyCustomer(order, createTextMessage('📍 騎手已抵達取件地點，請準備交件。'));
  return;
}

if (data.startsWith('requestWaitingFee=')) {
  const orderId = data.split('=')[1];
  const order = orders[orderId];

  if (!order) return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單。')]);
  if (order.riderId !== userId) {
    return client.replyMessage(event.replyToken, [createTextMessage('只有接單騎手可以申請等候費。')]);
  }
  if (!['arrived_pickup', 'picked_up'].includes(order.status)) {
    return client.replyMessage(event.replyToken, [createTextMessage('需抵達現場後，才可以申請等候費。')]);
  }
  if (order.waitingFeeApproved) {
    return client.replyMessage(event.replyToken, [createTextMessage('此訂單已同意等候費，不需重複申請。')]);
  }
  if (order.waitingFeeRequested && !order.waitingFeeRejected) {
    return client.replyMessage(event.replyToken, [createTextMessage('已送出等候費申請，正在等待客人確認。')]);
  }

  order.waitingFeeRequested = true;
  order.waitingFeeRejected = false;
  order.waitingFeeRequestedAt = Date.now();

  await client.replyMessage(event.replyToken, [
    createTextMessage('已送出等候費申請，等待客人確認。'),
    createRiderControlFlex(order),
  ]);

  await notifyCustomer(order, createWaitingFeeConfirmFlex(order));
  return;
}

if (data.startsWith('pickedUp=')) {
  const orderId = data.split('=')[1];
  const order = orders[orderId];

  if (!order) return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單。')]);
  if (order.riderId !== userId) {
    return client.replyMessage(event.replyToken, [createTextMessage('只有接單騎手可以操作此訂單。')]);
  }
  if (!['accepted', 'arrived_pickup'].includes(order.status)) {
    return client.replyMessage(event.replyToken, [createTextMessage('目前狀態不能操作「已取件」。')]);
  }

  order.status = 'picked_up';
  order.pickedUpAt = Date.now();

  await client.replyMessage(event.replyToken, [
    createTextMessage('已更新為：已取件'),
    createRiderControlFlex(order),
  ]);

  await notifyCustomer(order, createTextMessage('📦 騎手已完成取件，正前往送達地點。'));
  return;
}

if (data.startsWith('completed=')) {
  const orderId = data.split('=')[1];
  const order = orders[orderId];

  if (!order) return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單。')]);
  if (order.riderId !== userId) {
    return client.replyMessage(event.replyToken, [createTextMessage('只有接單騎手可以操作此訂單。')]);
  }
  if (!['accepted', 'arrived_pickup', 'picked_up'].includes(order.status)) {
    return client.replyMessage(event.replyToken, [createTextMessage('目前狀態不能操作「已送達」。')]);
  }

  order.status = 'completed';
  order.completedAt = Date.now();

  await client.replyMessage(event.replyToken, [createTextMessage(`任務 ${order.id} 已完成。`)]);
  await notifyCustomer(order, createTextMessage('✅ 你的任務已送達完成，感謝使用 UBee。'));

  if (LINE_FINISH_GROUP_ID) {
    await pushToGroup(LINE_FINISH_GROUP_ID, createFinanceFlex(order));
  }

  return;
}

  return client.replyMessage(event.replyToken, [createTextMessage('未識別的操作。')]);
}

function createOrderFromApi(data) {
  return {
    serviceType: data.serviceType || data.service || '文件急送',
    item: data.item || '',
    pickupAddress: data.pickup || data.pickupAddress || '',
    pickupPhone: normalizePhone(data.pickupPhone || ''),
    dropoffAddress: data.dropoff || data.dropoffAddress || '',
    dropoffPhone: normalizePhone(data.dropoffPhone || ''),
    speedType: data.speedType || data.speed || 'standard',
    note: data.note || '',
    customerId: data.userId || 'web-order',
  };
}

app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    liffId: LIFF_ID,
    businessFormUrl: BUSINESS_FORM_URL,
    partnerFormUrl: PARTNER_FORM_URL,
  });
});

app.get('/api/quote', async (req, res) => {
  try {
    const from = req.query.from || req.query.pickup;
    const to = req.query.to || req.query.dropoff;
    const speedType = req.query.speed || req.query.speedType || 'standard';

    if (!from || !to) {
      return res.status(400).json({ success: false, error: '請輸入取件地址與送達地址' });
    }

    const distance = await getDistanceMatrixCached(from, to);
    const price = calculatePrice({
      distanceMeters: distance.distanceMeters,
      durationSeconds: distance.durationSeconds,
      speedType,
    });

    res.json({
      success: true,
      distanceText: distance.distanceText,
      durationText: distance.durationText,
      distanceMeters: distance.distanceMeters,
      durationSeconds: distance.durationSeconds,
      speedType,
      speedLabel: getSpeedOption(speedType).label,
      ...price,
    });
  } catch (error) {
    console.error('❌ API 估價失敗：', error);
    res.status(500).json({ success: false, error: '估價失敗，請確認地址是否正確' });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const data = createOrderFromApi(req.body);

    if (!data.pickupAddress || !data.dropoffAddress || !data.pickupPhone || !data.dropoffPhone || !data.item) {
      return res.status(400).json({
        success: false,
        error: '請完整填寫取件地址、送達地址、電話與物品內容',
      });
    }

    const distance = await getDistanceMatrixCached(data.pickupAddress, data.dropoffAddress);
    const price = calculatePrice({
      distanceMeters: distance.distanceMeters,
      durationSeconds: distance.durationSeconds,
      speedType: data.speedType,
    });

    const id = generateOrderId();

    const order = {
      id,
      customerId: data.customerId,
      riderId: '',
      status: 'draft_confirm',
      serviceType: data.serviceType,
      item: data.item,
      pickupAddress: data.pickupAddress,
      pickupPhone: data.pickupPhone,
      dropoffAddress: data.dropoffAddress,
      dropoffPhone: data.dropoffPhone,
      speedType: data.speedType,
      note: data.note,
      distanceMeters: distance.distanceMeters,
      durationSeconds: distance.durationSeconds,
      distanceText: distance.distanceText,
      durationText: distance.durationText,
      ...price,
      etaMinutes: null,
      paymentMethod: '',
      isPaid: false,
      paidAt: null,
      waitingFeeRequested: false,
      waitingFeeApproved: false,
      waitingFeeRejected: false,
      waitingFeeRequestedAt: null,
      createdAt: Date.now(),
      acceptedAt: null,
      arrivedPickupAt: null,
      pickedUpAt: null,
      completedAt: null,
    };

    orders[id] = order;

    await notifyCustomer(order, [
  createTextMessage('你的訂單已建立，請確認任務內容與費用。'),
  createOrderConfirmFlex(order),
]);
    res.json({
      success: true,
      orderId: id,
      order,
      paymentOptions: {
        jko: PAYMENT_JKO_INFO,
        bank: PAYMENT_BANK_INFO,
      },
      message: '訂單已建立，請在頁面下方選擇付款方式。',
    });
  } catch (error) {
    console.error('❌ API 建立訂單失敗：', error);
    res.status(500).json({ success: false, error: '建立訂單失敗，請稍後再試' });
  }
});

app.post('/api/orders/:orderId/payment-method', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').toUpperCase();
    const { paymentMethod } = req.body;
    const order = orders[orderId];

    if (!order) return res.status(404).json({ success: false, error: '找不到此訂單' });
    if (!['jko', 'bank'].includes(paymentMethod)) return res.status(400).json({ success: false, error: '付款方式錯誤' });

    order.paymentMethod = paymentMethod;
    order.status = 'pending_payment';

    res.json({
      success: true,
      orderId,
      paymentMethod,
      paymentMethodLabel: getPaymentMethodLabel(paymentMethod),
      paymentInfo: paymentMethod === 'jko' ? PAYMENT_JKO_INFO : PAYMENT_BANK_INFO,
      total: order.total,
    });
  } catch (error) {
    console.error('❌ 設定付款方式失敗：', error);
    res.status(500).json({ success: false, error: '設定付款方式失敗' });
  }
});

app.post('/api/orders/:orderId/paid', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').toUpperCase();
    const order = orders[orderId];

    if (!order) return res.status(404).json({ success: false, error: '找不到此訂單' });
    if (!order.paymentMethod) return res.status(400).json({ success: false, error: '請先選擇付款方式' });

    if (order.isPaid) {
      return res.json({ success: true, orderId, message: '此訂單已標記付款完成' });
    }

    order.isPaid = true;
    order.paidAt = Date.now();
    order.status = 'pending_dispatch';

    await pushToGroup(LINE_GROUP_ID, createDispatchGroupFlex(order));

    await notifyCustomer(
  order,
  createTextMessage(`已收到你的付款通知。\n\n訂單編號：${order.id}\n🚀 系統正在為你配對騎手，請稍候...`)
);

    res.json({
      success: true,
      orderId,
      message: '已收到付款通知，系統已自動派單到騎手群組',
    });
  } catch (error) {
    console.error('❌ H5 確認付款失敗：', error);
    res.status(500).json({ success: false, error: '確認付款失敗，請稍後再試' });
  }
});

app.get('/api/orders/:orderId', (req, res) => {
  const orderId = String(req.params.orderId || '').toUpperCase();
  const order = orders[orderId];

  if (!order) {
    return res.status(404).json({ success: false, error: '查無此訂單' });
  }

  res.json({
    success: true,
    order: {
      id: order.id,
      status: order.status,
      statusLabel: getStatusLabel(order.status),
      speedType: order.speedType,
      speedLabel: getSpeedOption(order.speedType).label,
      pickupAddress: order.pickupAddress,
      dropoffAddress: order.dropoffAddress,
      etaMinutes: order.etaMinutes,
      total: order.total,
      isPaid: order.isPaid,
      paymentMethod: order.paymentMethod,
      paymentMethodLabel: getPaymentMethodLabel(order.paymentMethod),
      waitingFeeStatus: order.waitingFeeApproved
        ? '已同意等候費'
        : order.waitingFeeRejected
          ? '不同意等候費'
          : order.waitingFeeRequested
            ? '等待客人確認'
            : '尚未申請',
    },
  });
});

async function handleEvent(event) {
  try {
    if (event.type === 'follow') {
      return client.replyMessage(event.replyToken, [
        createTextMessage('歡迎使用 UBee｜城市任務服務 🐝'),
        createMainMenuFlex(),
      ]);
    }

    if (event.type === 'postback') {
      return handlePostback(event);
    }

    if (event.type === 'message' && event.message.type === 'text') {
      if (event.source.type === 'group') return;

      const userId = event.source.userId;
      const text = (event.message.text || '').trim();

      if (/^UB\d+/i.test(text)) {
        const orderId = text.toUpperCase();
        const order = orders[orderId];

        if (!order) {
          return client.replyMessage(event.replyToken, createTextMessage('查無此訂單，請確認訂單編號是否正確。'));
        }

        return client.replyMessage(event.replyToken, [createOrderStatusFlex(order)]);
      }

      return handleTextStep(event, userId, text);
    }

    if (event.replyToken) {
      return client.replyMessage(event.replyToken, [createTextMessage('目前僅支援文字與按鈕操作。')]);
    }
  } catch (error) {
    console.error('❌ handleEvent 錯誤：', error);

    if (event.replyToken) {
      try {
        await client.replyMessage(event.replyToken, [createTextMessage('系統忙碌中，請稍後再試。')]);
      } catch (replyError) {
        console.error('❌ replyMessage 錯誤：', replyError);
      }
    }
  }
}

app.get('/', (req, res) => {
  res.send('UBee OMS V3.9.1 PRO FLOW（H5自動派單｜速度分級｜付款｜等候費）運作中');
});

app.head('/', (req, res) => {
  res.sendStatus(200);
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ webhook 錯誤：', error);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log(`✅ UBee OMS V3.9.1 PRO FLOW 啟動成功，PORT: ${PORT}`);
});

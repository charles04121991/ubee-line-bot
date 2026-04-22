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
const LINE_FINISH_GROUP_ID = process.env.LINE_FINISH_GROUP_ID || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

if (!LINE_GROUP_ID) {
  console.error('❌ 缺少 LINE_GROUP_ID');
  process.exit(1);
}

if (!GOOGLE_MAPS_API_KEY) {
  console.error('❌ 缺少 GOOGLE_MAPS_API_KEY');
  process.exit(1);
}

// ===== 計價設定（可自行調整）=====
const PRICING = {
  baseFee: 99,
  perKm: 8,
  perMinute: 2,
  serviceFee: 50,
  urgentFee: 100,
  driverRatio: 0.6,
};

// ===== 暫存資料（重啟後會清空）=====
const userSessions = {}; // userId -> session
const orders = {}; // orderId -> order
let orderCounter = 1;

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
  const num = Number(value || 0);
  return `NT$${Math.round(num)}`;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '');
}

function buildGoogleMapDirectionsUrl(address) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address || '')}`;
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

function createTextMessage(text) {
  return { type: 'text', text };
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

function getStatusLabel(status) {
  return {
    pending_dispatch: '🟡 待派單',
    accepted: '🟢 已接單',
    arrived_pickup: '🟠 已抵達取件地點',
    picked_up: '🔵 已取件',
    completed: '✅ 已完成',
  }[status] || status;
}

function createBubble(title, bodyContents, footerContents = []) {
  return {
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
    footer: footerContents.length
      ? {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: footerContents,
        }
      : undefined,
  };
}

function createFlexMessage(altText, bubble) {
  return {
    type: 'flex',
    altText,
    contents: bubble,
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

// ===== 地圖距離時間 =====
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

  const distanceMeters = element.distance.value;
  const durationSeconds = element.duration.value;

  return {
    distanceMeters,
    durationSeconds,
    distanceText: element.distance.text,
    durationText: element.duration.text,
  };
}

function calculatePrice({ distanceMeters, durationSeconds, isUrgent }) {
  const km = distanceMeters / 1000;
  const minutes = durationSeconds / 60;

  const deliveryFee =
    PRICING.baseFee +
    km * PRICING.perKm +
    minutes * PRICING.perMinute;

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
      createActionButton('確定建立任務', `confirmCreate=${order.id}`),
      createActionButton('取消', `cancelCreate=${order.id}`, 'secondary'),
    ]
  );

  return createFlexMessage('確認建立任務', bubble);
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
      createUriButton(
        '導航到取件地點',
        buildGoogleMapDirectionsUrl(order.pickupAddress)
      ),
    ]
  );

  return createFlexMessage('UBee 新任務通知', bubble);
}

function createRiderControlFlex(order) {
  const bubble = createBubble(
    '騎手任務操作',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('狀態', getStatusLabel(order.status)),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('備註', order.note || '無'),
      createInfoRow('收入', formatCurrency(order.driverFee)),
    ],
    [
      createActionButton('已抵達取件地點', `arrivedPickup=${order.id}`),
      createActionButton('已取件', `pickedUp=${order.id}`),
      createUriButton(
        '導航到送達地點',
        buildGoogleMapDirectionsUrl(order.dropoffAddress)
      ),
      createActionButton('已送達', `completed=${order.id}`),
    ]
  );

  return createFlexMessage('騎手任務操作', bubble);
}

function createFinanceFlex(order) {
  const bubble = createBubble(
    'UBee 財務明細',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('送達地址', order.dropoffAddress),
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

// ===== Session =====
function resetUserSession(userId) {
  delete userSessions[userId];
}

function getOrCreateSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = {
      step: null,
      draft: {},
    };
  }
  return userSessions[userId];
}

// ===== 發送 =====
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

// ===== 建立訂單流程 =====
async function startCreateOrder(replyToken, userId) {
  const session = getOrCreateSession(userId);
  session.step = 'pickupAddress';
  session.draft = {};

  await client.replyMessage(replyToken, [
    createTextMessage('請輸入取件完整地址'),
  ]);
}

async function handleTextStep(event, userId, text) {
  const session = getOrCreateSession(userId);

  if (!session.step) {
    if (
      ['立即下單', '下單', '建立任務', '開始下單'].includes(text.trim())
    ) {
      return startCreateOrder(event.replyToken, userId);
    }

    return client.replyMessage(event.replyToken, [
      createTextMessage(
        '歡迎使用 UBee\n\n請輸入「立即下單」開始建立任務。'
      ),
    ]);
  }

  if (session.step === 'pickupAddress') {
    session.draft.pickupAddress = text.trim();
    session.step = 'pickupPhone';
    return client.replyMessage(event.replyToken, [
      createTextMessage('請輸入取件電話'),
    ]);
  }

  if (session.step === 'pickupPhone') {
    session.draft.pickupPhone = normalizePhone(text.trim());
    session.step = 'dropoffAddress';
    return client.replyMessage(event.replyToken, [
      createTextMessage('請輸入送達完整地址'),
    ]);
  }

  if (session.step === 'dropoffAddress') {
    session.draft.dropoffAddress = text.trim();
    session.step = 'dropoffPhone';
    return client.replyMessage(event.replyToken, [
      createTextMessage('請輸入送達電話'),
    ]);
  }

  if (session.step === 'dropoffPhone') {
    session.draft.dropoffPhone = normalizePhone(text.trim());
    session.step = 'urgent';
    return client.replyMessage(event.replyToken, [
      createQuickReplyMessage('請選擇是否急件', [
        { type: 'postback', label: '是', data: 'urgent=yes', displayText: '是' },
        { type: 'postback', label: '否', data: 'urgent=no', displayText: '否' },
      ]),
    ]);
  }

  if (session.step === 'note') {
    session.draft.note = text.trim();
    session.step = null;

    const orderId = generateOrderId();
    const isUrgent = !!session.draft.isUrgent;

    try {
      const distance = await getDistanceMatrix(
        session.draft.pickupAddress,
        session.draft.dropoffAddress
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
        status: 'draft_confirm',

        pickupAddress: session.draft.pickupAddress,
        pickupPhone: session.draft.pickupPhone,
        dropoffAddress: session.draft.dropoffAddress,
        dropoffPhone: session.draft.dropoffPhone,
        isUrgent,
        note: session.draft.note || '',

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

        createdAt: Date.now(),
        acceptedAt: null,
        arrivedPickupAt: null,
        pickedUpAt: null,
        completedAt: null,
      };

      orders[order.id] = order;
      resetUserSession(userId);

      return client.replyMessage(event.replyToken, [
        createOrderConfirmFlex(order),
      ]);
    } catch (error) {
      console.error('❌ 建立任務計價失敗：', error);
      resetUserSession(userId);
      return client.replyMessage(event.replyToken, [
        createTextMessage('抱歉，地址計算失敗，請重新輸入「立即下單」再試一次。'),
      ]);
    }
  }

  return client.replyMessage(event.replyToken, [
    createTextMessage('流程異常，請重新輸入「立即下單」開始。'),
  ]);
}

// ===== Postback 處理 =====
async function handlePostback(event) {
  const data = event.postback.data || '';
  const userId = event.source.userId;

  if (data === 'urgent=yes' || data === 'urgent=no') {
    const session = getOrCreateSession(userId);
    session.draft.isUrgent = data === 'urgent=yes';
    session.step = 'note';

    return client.replyMessage(event.replyToken, [
      createTextMessage('請輸入備註；若沒有請輸入「無」'),
    ]);
  }

  if (data.startsWith('cancelCreate=')) {
    const orderId = data.split('=')[1];
    delete orders[orderId];
    return client.replyMessage(event.replyToken, [
      createTextMessage('已取消本次建立任務。'),
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

    order.status = 'pending_dispatch';

    await client.replyMessage(event.replyToken, [
      createTextMessage('任務已建立成功，系統正在通知騎手接單。'),
    ]);

    await pushToGroup(LINE_GROUP_ID, createDispatchGroupFlex(order));
    return;
  }

  if (data.startsWith('accept=')) {
    const orderId = data.split('=')[1];
    const order = orders[orderId];

    if (!order) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('找不到此訂單。'),
      ]);
    }

    if (order.status !== 'pending_dispatch') {
      return client.replyMessage(event.replyToken, [
        createTextMessage('此單已被接走。'),
      ]);
    }

    order.status = 'accepted';
    order.riderId = userId;
    order.acceptedAt = Date.now();

    await client.replyMessage(event.replyToken, [
      createTextMessage(`你已成功接單：${order.id}`),
      createRiderControlFlex(order),
    ]);

    await pushToUser(
      order.customerId,
      createTextMessage('你的任務已由騎手接單，騎手正前往取件地點。')
    );
    return;
  }

  if (data.startsWith('arrivedPickup=')) {
    const orderId = data.split('=')[1];
    const order = orders[orderId];

    if (!order) {
      return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單。')]);
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
      return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單。')]);
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
      return client.replyMessage(event.replyToken, [createTextMessage('找不到此訂單。')]);
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

    await pushToUser(
      order.customerId,
      createTextMessage('你的任務已送達完成，感謝使用 UBee。')
    );

    if (LINE_FINISH_GROUP_ID) {
      await pushToGroup(LINE_FINISH_GROUP_ID, createFinanceFlex(order));
    }
    return;
  }

  return client.replyMessage(event.replyToken, [
    createTextMessage('未識別的操作。'),
  ]);
}

// ===== Event 處理 =====
async function handleEvent(event) {
  try {
    if (event.type === 'follow') {
      return client.replyMessage(event.replyToken, [
        createTextMessage('歡迎使用 UBee\n\n請輸入「立即下單」開始建立任務。'),
      ]);
    }

    if (event.type === 'postback') {
      return handlePostback(event);
    }

    if (event.type === 'message' && event.message.type === 'text') {
      const userId = event.source.userId;
      const text = (event.message.text || '').trim();
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
  res.send('UBee OMS 精簡自動派單版運作中');
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
  console.log(`✅ UBee OMS 精簡自動派單版啟動成功，PORT: ${PORT}`);
});
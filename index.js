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
  console.error('❌ 缺少 CHANNEL_ACCESS_TOKEN 或 CHANNEL_SECRET');
  process.exit(1);
}

const client = new line.Client(config);

const PORT = process.env.PORT || 3000;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// =========================
// 費率設定
// =========================
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const SERVICE_FEE = 50;
const URGENT_FEE = 100;
const FIXED_TAX = 15;

// =========================
// 記憶體資料
// =========================
const userSessions = {};   // 客戶端流程狀態
const orders = {};         // 訂單資料
const riderPendingEta = {}; // 等待騎手輸入 ETA

// =========================
// Express
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee OMS V3.6.3 Running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log(`✅ UBee OMS V3.6.3 已啟動，PORT: ${PORT}`);
});

// =========================
// 工具函式
// =========================
function getUserId(event) {
  return event.source.userId || event.source.groupId || event.source.roomId;
}

function createOrderId() {
  return 'UB' + Date.now().toString().slice(-8);
}

function isGroupEvent(event) {
  return event.source.type === 'group' || event.source.type === 'room';
}

function safeTrim(v) {
  return (v || '').toString().trim();
}

function parseDistrict(address) {
  // 台灣常見區名抓取
  const match = address.match(/([^\s]{1,6}[區鄉鎮市])/);
  return match ? match[1] : '';
}

function calcPrice({ distanceKm, durationMin, isUrgent, crossDistrict }) {
  const deliveryFee =
    BASE_FEE +
    Math.ceil(distanceKm) * PER_KM_FEE +
    Math.ceil(durationMin) * PER_MIN_FEE +
    (crossDistrict ? CROSS_DISTRICT_FEE : 0);

  const urgentFee = isUrgent ? URGENT_FEE : 0;
  const total = deliveryFee + SERVICE_FEE + urgentFee + FIXED_TAX;

  return {
    deliveryFee,
    serviceFee: SERVICE_FEE,
    urgentFee,
    tax: FIXED_TAX,
    total,
  };
}

function buildGoogleMapNavUrl(destination) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`;
}

function buildTelUrl(phone) {
  return `tel:${phone}`;
}

async function geocodeAddress(address) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK' || !data.results || !data.results.length) {
    throw new Error(`地址查詢失敗：${data.error_message || data.status}`);
  }

  return data.results[0];
}

async function getDistanceAndDuration(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('尚未設定 GOOGLE_MAPS_API_KEY');
  }

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&mode=driving&language=zh-TW&region=tw&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK') {
    throw new Error(`距離查詢失敗：${data.error_message || data.status}`);
  }

  const row = data.rows && data.rows[0];
  const elem = row && row.elements && row.elements[0];

  if (!elem || elem.status !== 'OK') {
    throw new Error(`地址查詢失敗：${elem?.status || '未知錯誤'}`);
  }

  const distanceMeters = elem.distance.value;
  const durationSeconds = elem.duration.value;

  return {
    distanceKm: distanceMeters / 1000,
    durationMin: durationSeconds / 60,
  };
}

async function getProfileName(userId) {
  try {
    const profile = await client.getProfile(userId);
    return profile.displayName || '騎手';
  } catch (err) {
    return '騎手';
  }
}

function resetUserSession(userId) {
  delete userSessions[userId];
}

function buildMainMenuFlex() {
  return {
    type: 'flex',
    altText: 'UBee 功能選單',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: 'UBee 城市任務服務',
            weight: 'bold',
            size: 'xl',
          },
          {
            type: 'text',
            text: '請選擇您需要的服務',
            size: 'sm',
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
              type: 'message',
              label: '建立任務',
              text: '建立任務',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'message',
              label: '立即估價',
              text: '立即估價',
            },
          },
        ],
      },
    },
  };
}

function buildQuoteFlex(quoteInput, priceResult, estimateMeta = {}) {
  return {
    type: 'flex',
    altText: 'UBee 估價結果',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: 'UBee 立即估價', weight: 'bold', size: 'xl' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              { type: 'text', text: `取件地點：${quoteInput.pickupAddress}`, wrap: true, size: 'sm' },
              { type: 'text', text: `送達地點：${quoteInput.dropoffAddress}`, wrap: true, size: 'sm' },
              { type: 'text', text: `物品內容：${quoteInput.item}`, wrap: true, size: 'sm' },
              { type: 'text', text: `是否急件：${quoteInput.isUrgent ? '急件' : '一般'}`, size: 'sm' },
              ...(estimateMeta.distanceKm != null
                ? [{ type: 'text', text: `預估距離：約 ${estimateMeta.distanceKm.toFixed(1)} 公里`, size: 'sm', color: '#666666' }]
                : []),
              ...(estimateMeta.durationMin != null
                ? [{ type: 'text', text: `預估時間：約 ${Math.ceil(estimateMeta.durationMin)} 分鐘`, size: 'sm', color: '#666666' }]
                : []),
            ],
          },
          {
            type: 'separator',
            margin: 'md',
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              { type: 'text', text: `配送費：$${priceResult.deliveryFee}`, size: 'sm' },
              { type: 'text', text: `服務費：$${priceResult.serviceFee}`, size: 'sm' },
              { type: 'text', text: `急件費：$${priceResult.urgentFee}`, size: 'sm' },
              { type: 'text', text: `稅金：$${priceResult.tax}`, size: 'sm' },
              { type: 'text', text: `總計：$${priceResult.total}`, weight: 'bold', size: 'md' },
            ],
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
              label: '確定建立任務',
              data: 'action=quote_confirm_create',
              displayText: '確定建立任務',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'message',
              label: '重新估價',
              text: '立即估價',
            },
          },
        ],
      },
    },
  };
}

function buildConfirmTaskFlex(order) {
  return {
    type: 'flex',
    altText: '請確認任務資訊',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '請確認以下任務資訊', weight: 'bold', size: 'lg' },
          { type: 'text', text: `取件地點：${order.pickupAddress}`, wrap: true, size: 'sm' },
          { type: 'text', text: `取件電話：${order.pickupPhone}`, size: 'sm' },
          { type: 'text', text: `送達地點：${order.dropoffAddress}`, wrap: true, size: 'sm' },
          { type: 'text', text: `送達電話：${order.dropoffPhone}`, size: 'sm' },
          { type: 'text', text: `物品內容：${order.item}`, wrap: true, size: 'sm' },
          { type: 'text', text: `是否急件：${order.isUrgent ? '急件' : '一般'}`, size: 'sm' },
          { type: 'text', text: `備註：${order.remark || '無'}`, wrap: true, size: 'sm' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: `配送費：$${order.price.deliveryFee}`, size: 'sm' },
          { type: 'text', text: `服務費：$${order.price.serviceFee}`, size: 'sm' },
          { type: 'text', text: `急件費：$${order.price.urgentFee}`, size: 'sm' },
          { type: 'text', text: `稅金：$${order.price.tax}`, size: 'sm' },
          { type: 'text', text: `總計：$${order.price.total}`, weight: 'bold', size: 'md' },
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
              label: '確認送出',
              data: `action=customer_submit_order&orderId=${order.id}`,
              displayText: '確認送出',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'message',
              label: '重新填寫',
              text: '建立任務',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: '取消',
              data: `action=customer_cancel_order&orderId=${order.id}`,
              displayText: '取消',
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
    altText: 'UBee 新任務通知',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '📦 UBee 新任務通知', weight: 'bold', size: 'xl' },
          { type: 'text', text: `費用：$${order.price.total}`, weight: 'bold', size: 'lg' },
          { type: 'text', text: `取件：${order.pickupAddress}`, wrap: true, size: 'sm' },
          { type: 'text', text: `送達：${order.dropoffAddress}`, wrap: true, size: 'sm' },
          { type: 'text', text: `物品：${order.item}`, wrap: true, size: 'sm' },
          { type: 'text', text: `急件：${order.isUrgent ? '急件' : '一般'}`, size: 'sm' },
          { type: 'text', text: `備註：${order.remark || '無'}`, wrap: true, size: 'sm' },
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
              label: '✔️ 接單',
              data: `action=rider_accept&orderId=${order.id}`,
              displayText: '接單',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: '❌ 拒單',
              data: `action=rider_reject&orderId=${order.id}`,
              displayText: '拒單',
            },
          },
        ],
      },
    },
  };
}

function buildEtaFlex(orderId) {
  return {
    type: 'flex',
    altText: '請設定 ETA',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '請設定抵達取件地點時間', weight: 'bold', size: 'lg' },
          { type: 'text', text: '可直接按下方分鐘按鈕，或手動輸入分鐘數。', size: 'sm', color: '#666666', wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [5, 10].map((m) => ({
              type: 'button',
              style: 'primary',
              action: {
                type: 'postback',
                label: `${m} 分鐘`,
                data: `action=set_eta&orderId=${orderId}&minutes=${m}`,
                displayText: `${m}`,
              },
            })),
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [15, 20].map((m) => ({
              type: 'button',
              style: 'secondary',
              action: {
                type: 'postback',
                label: `${m} 分鐘`,
                data: `action=set_eta&orderId=${orderId}&minutes=${m}`,
                displayText: `${m}`,
              },
            })),
          },
        ],
      },
    },
  };
}

function buildTaskActionFlex(order) {
  const contents = [];

  if (order.status === 'accepted' || order.status === 'eta_set') {
    contents.push({
      type: 'button',
      style: 'primary',
      action: {
        type: 'postback',
        label: '已抵達',
        data: `action=arrived_pickup&orderId=${order.id}`,
        displayText: '已抵達',
      },
    });
  }

  if (order.status === 'arrived_pickup') {
    contents.push({
      type: 'button',
      style: 'primary',
      action: {
        type: 'postback',
        label: '已取件',
        data: `action=picked_up&orderId=${order.id}`,
        displayText: '已取件',
      },
    });
  }

  if (order.status === 'picked_up') {
    contents.push({
      type: 'button',
      style: 'primary',
      action: {
        type: 'postback',
        label: '已送達',
        data: `action=arrived_dropoff&orderId=${order.id}`,
        displayText: '已送達',
      },
    });
  }

  if (order.status === 'arrived_dropoff') {
    contents.push({
      type: 'button',
      style: 'secondary',
      action: {
        type: 'uri',
        label: '撥打收件人',
        uri: buildTelUrl(order.dropoffPhone),
      },
    });
    contents.push({
      type: 'button',
      style: 'primary',
      action: {
        type: 'postback',
        label: '已完成',
        data: `action=completed&orderId=${order.id}`,
        displayText: '已完成',
      },
    });
  }

  if (!contents.length) {
    contents.push({
      type: 'text',
      text: '目前沒有可操作按鈕',
      size: 'sm',
      color: '#999999',
    });
  }

  return {
    type: 'flex',
    altText: '任務操作卡',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '任務操作', weight: 'bold', size: 'lg' },
          { type: 'text', text: `目前狀態：${getStatusText(order.status)}`, size: 'sm' },
          { type: 'text', text: `取件：${order.pickupAddress}`, wrap: true, size: 'sm' },
          { type: 'text', text: `送達：${order.dropoffAddress}`, wrap: true, size: 'sm' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents,
      },
    },
  };
}

function getStatusText(status) {
  switch (status) {
    case 'pending_dispatch': return '待派單';
    case 'dispatched': return '已派單';
    case 'accepted': return '已接單';
    case 'eta_set': return '已設定 ETA';
    case 'arrived_pickup': return '已抵達取件地';
    case 'picked_up': return '已取件';
    case 'arrived_dropoff': return '已送達目的地';
    case 'completed': return '已完成';
    case 'cancelled': return '已取消';
    default: return status || '未知';
  }
}

function parsePostbackData(data) {
  const result = {};
  const params = new URLSearchParams(data);
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

async function replyText(replyToken, text) {
  return client.replyMessage(replyToken, {
    type: 'text',
    text,
  });
}

async function pushText(to, text) {
  return client.pushMessage(to, {
    type: 'text',
    text,
  });
}

// =========================
// 客戶流程
// =========================
function startCreateTaskSession(userId, fromQuote = false) {
  userSessions[userId] = {
    mode: 'create_task',
    step: fromQuote ? 'pickup_phone' : 'pickup_address',
    data: fromQuote
      ? {
          pickupAddress: userSessions[userId]?.quoteData?.pickupAddress || '',
          dropoffAddress: userSessions[userId]?.quoteData?.dropoffAddress || '',
          item: userSessions[userId]?.quoteData?.item || '',
          isUrgent: userSessions[userId]?.quoteData?.isUrgent || false,
        }
      : {},
  };
}

function startQuoteSession(userId) {
  userSessions[userId] = {
    mode: 'quote',
    step: 'pickup_address',
    quoteData: {},
  };
}

async function handleCustomerText(event, text) {
  const userId = getUserId(event);

  if (text === 'menu' || text === '選單' || text === '開始') {
    return client.replyMessage(event.replyToken, buildMainMenuFlex());
  }

  if (text === '建立任務') {
    startCreateTaskSession(userId, false);
    return replyText(event.replyToken, '請輸入取件地點：');
  }

  if (text === '立即估價') {
    startQuoteSession(userId);
    return replyText(event.replyToken, '請輸入取件地點：');
  }

  const session = userSessions[userId];
  if (!session) {
    return client.replyMessage(event.replyToken, buildMainMenuFlex());
  }

  // ===== 立即估價 =====
  if (session.mode === 'quote') {
    if (session.step === 'pickup_address') {
      session.quoteData.pickupAddress = text;
      session.step = 'dropoff_address';
      return replyText(event.replyToken, '請輸入送達地點：');
    }

    if (session.step === 'dropoff_address') {
      session.quoteData.dropoffAddress = text;
      session.step = 'item';
      return replyText(event.replyToken, '請輸入物品內容：');
    }

    if (session.step === 'item') {
      session.quoteData.item = text;
      session.step = 'urgent';
      return client.replyMessage(event.replyToken, {
        type: 'template',
        altText: '是否為急件',
        template: {
          type: 'buttons',
          text: '請問是否為急件？',
          actions: [
            {
              type: 'postback',
              label: '一般',
              data: 'action=quote_set_urgent&value=0',
              displayText: '一般',
            },
            {
              type: 'postback',
              label: '急件',
              data: 'action=quote_set_urgent&value=1',
              displayText: '急件',
            },
          ],
        },
      });
    }
  }

  // ===== 建立任務 =====
  if (session.mode === 'create_task') {
    const data = session.data;

    if (session.step === 'pickup_address') {
      data.pickupAddress = text;
      session.step = 'pickup_phone';
      return replyText(event.replyToken, '請輸入取件電話：');
    }

    if (session.step === 'pickup_phone') {
      data.pickupPhone = text;
      session.step = 'dropoff_address';
      return replyText(event.replyToken, '請輸入送達地點：');
    }

    if (session.step === 'dropoff_address') {
      data.dropoffAddress = text;
      session.step = 'dropoff_phone';
      return replyText(event.replyToken, '請輸入送達電話：');
    }

    if (session.step === 'dropoff_phone') {
      data.dropoffPhone = text;
      session.step = 'item';
      return replyText(event.replyToken, '請輸入物品內容：');
    }

    if (session.step === 'item') {
      data.item = text;
      session.step = 'urgent';
      return client.replyMessage(event.replyToken, {
        type: 'template',
        altText: '是否為急件',
        template: {
          type: 'buttons',
          text: '請問是否為急件？',
          actions: [
            {
              type: 'postback',
              label: '一般',
              data: 'action=create_set_urgent&value=0',
              displayText: '一般',
            },
            {
              type: 'postback',
              label: '急件',
              data: 'action=create_set_urgent&value=1',
              displayText: '急件',
            },
          ],
        },
      });
    }

    if (session.step === 'remark') {
      data.remark = text;
      return await finalizeDraftOrder(event, userId, data);
    }
  }

  return replyText(event.replyToken, '請輸入「建立任務」或「立即估價」。');
}

async function finalizeDraftOrder(event, userId, data) {
  try {
    const { distanceKm, durationMin } = await getDistanceAndDuration(
      data.pickupAddress,
      data.dropoffAddress
    );

    const pickupDistrict = parseDistrict(data.pickupAddress);
    const dropoffDistrict = parseDistrict(data.dropoffAddress);
    const crossDistrict = pickupDistrict && dropoffDistrict && pickupDistrict !== dropoffDistrict;

    const price = calcPrice({
      distanceKm,
      durationMin,
      isUrgent: !!data.isUrgent,
      crossDistrict,
    });

    const orderId = createOrderId();
    const order = {
      id: orderId,
      customerUserId: userId,
      pickupAddress: data.pickupAddress,
      pickupPhone: data.pickupPhone,
      dropoffAddress: data.dropoffAddress,
      dropoffPhone: data.dropoffPhone,
      item: data.item,
      isUrgent: !!data.isUrgent,
      remark: data.remark || '無',
      distanceKm,
      durationMin,
      crossDistrict,
      price,
      status: 'pending_dispatch',
      riderUserId: null,
      riderName: null,
      etaMin: null,
      rejectedRiders: [],
      createdAt: Date.now(),
    };

    orders[orderId] = order;
    resetUserSession(userId);

    return client.replyMessage(event.replyToken, buildConfirmTaskFlex(order));
  } catch (err) {
    console.error('finalizeDraftOrder error:', err);
    resetUserSession(userId);
    return replyText(event.replyToken, `⚠️ ${err.message}\n\n請重新輸入「建立任務」再試一次。`);
  }
}

// =========================
// 派單 / 群組
// =========================
async function dispatchOrder(order) {
  if (!LINE_GROUP_ID) {
    throw new Error('尚未設定 LINE_GROUP_ID');
  }

  order.status = 'dispatched';

  await client.pushMessage(LINE_GROUP_ID, [
    buildGroupDispatchFlex(order),
    buildTaskActionFlex(order),
  ]);
}

async function pushGroupTaskAction(order) {
  if (!LINE_GROUP_ID) return;
  await client.pushMessage(LINE_GROUP_ID, buildTaskActionFlex(order));
}

// =========================
// 事件處理
// =========================
async function handleEvent(event) {
  try {
    if (event.type === 'message' && event.message.type === 'text') {
      const text = safeTrim(event.message.text);

      if (isGroupEvent(event)) {
        return await handleGroupText(event, text);
      } else {
        return await handleCustomerText(event, text);
      }
    }

    if (event.type === 'postback') {
      if (isGroupEvent(event)) {
        return await handleGroupPostback(event);
      } else {
        return await handleCustomerPostback(event);
      }
    }

    return null;
  } catch (err) {
    console.error('handleEvent error:', err);

    if (event.replyToken) {
      try {
        return await replyText(event.replyToken, `⚠️ 系統發生錯誤：${err.message}`);
      } catch (_) {}
    }
    return null;
  }
}

// =========================
// 客戶 Postback
// =========================
async function handleCustomerPostback(event) {
  const userId = getUserId(event);
  const data = parsePostbackData(event.postback.data || '');
  const session = userSessions[userId];

  if (data.action === 'quote_set_urgent') {
    if (!session || session.mode !== 'quote') {
      return replyText(event.replyToken, '請重新輸入「立即估價」。');
    }

    session.quoteData.isUrgent = data.value === '1';

    try {
      const { distanceKm, durationMin } = await getDistanceAndDuration(
        session.quoteData.pickupAddress,
        session.quoteData.dropoffAddress
      );

      const pickupDistrict = parseDistrict(session.quoteData.pickupAddress);
      const dropoffDistrict = parseDistrict(session.quoteData.dropoffAddress);
      const crossDistrict = pickupDistrict && dropoffDistrict && pickupDistrict !== dropoffDistrict;

      const price = calcPrice({
        distanceKm,
        durationMin,
        isUrgent: session.quoteData.isUrgent,
        crossDistrict,
      });

      session.quoteData.crossDistrict = crossDistrict;
      session.quoteData.estimatedDistanceKm = distanceKm;
      session.quoteData.estimatedDurationMin = durationMin;
      session.quoteData.price = price;

      return client.replyMessage(
        event.replyToken,
        buildQuoteFlex(session.quoteData, price, { distanceKm, durationMin })
      );
    } catch (err) {
      console.error(err);
      resetUserSession(userId);
      return replyText(event.replyToken, `⚠️ ${err.message}\n\n請重新輸入「立即估價」再試一次。`);
    }
  }

  if (data.action === 'quote_confirm_create') {
    if (!session || !session.quoteData) {
      return replyText(event.replyToken, '估價資料已失效，請重新輸入「立即估價」。');
    }

    startCreateTaskSession(userId, true);
    return replyText(event.replyToken, '請輸入取件電話：');
  }

  if (data.action === 'create_set_urgent') {
    if (!session || session.mode !== 'create_task') {
      return replyText(event.replyToken, '請重新輸入「建立任務」。');
    }

    session.data.isUrgent = data.value === '1';
    session.step = 'remark';
    return replyText(event.replyToken, '請輸入備註（若無請輸入：無）：');
  }

  if (data.action === 'customer_submit_order') {
    const order = orders[data.orderId];
    if (!order) {
      return replyText(event.replyToken, '找不到此任務資料。');
    }

    try {
      await dispatchOrder(order);

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text:
          `✅ 任務建立成功\n\n` +
          `系統正在為您配對騎手，請稍候。`,
      });
    } catch (err) {
      console.error('dispatchOrder error:', err);
      return replyText(event.replyToken, `⚠️ 派單失敗：${err.message}`);
    }
  }

  if (data.action === 'customer_cancel_order') {
    const order = orders[data.orderId];
    if (order) {
      order.status = 'cancelled';
    }
    return replyText(event.replyToken, '已取消本次任務。');
  }

  return null;
}

// =========================
// 群組 Postback
// =========================
async function handleGroupPostback(event) {
  const userId = getUserId(event);
  const operatorId = event.source.userId;
  const data = parsePostbackData(event.postback.data || '');

  if (!operatorId) {
    return replyText(event.replyToken, '⚠️ 無法辨識操作人員。');
  }

  const order = orders[data.orderId];
  if (!order) {
    return replyText(event.replyToken, '⚠️ 找不到此任務。');
  }

  if (data.action === 'rider_reject') {
    if (!order.rejectedRiders.includes(operatorId)) {
      order.rejectedRiders.push(operatorId);
    }
    return replyText(event.replyToken, '系統正在配對中……');
  }

  if (data.action === 'rider_accept') {
    if (order.riderUserId && order.riderUserId !== operatorId) {
      return replyText(event.replyToken, `⚠️ 此任務已由 ${order.riderName || '其他騎手'} 接單。`);
    }

    if (!order.riderUserId) {
      order.riderUserId = operatorId;
      order.riderName = await getProfileName(operatorId);
      order.status = 'accepted';
    }

    riderPendingEta[operatorId] = order.id;

    await client.replyMessage(event.replyToken, [
      {
        type: 'text',
        text: `✅ 任務已接單   接單人員：${order.riderName}`,
      },
      buildEtaFlex(order.id),
      {
        type: 'template',
        altText: '導航到取件地點',
        template: {
          type: 'buttons',
          text: '可直接導航至取件地點',
          actions: [
            {
              type: 'uri',
              label: '導航到取件地點',
              uri: buildGoogleMapNavUrl(order.pickupAddress),
            },
          ],
        },
      },
    ]);

    await pushText(
      order.customerUserId,
      `✅ 已有騎手接單\n\n騎手：${order.riderName}`
    );

    return null;
  }

  // 以下操作都只允許接單本人
  if (order.riderUserId !== operatorId) {
    return replyText(event.replyToken, '⚠️ 只有接單的騎手可以操作此任務。');
  }

  if (data.action === 'set_eta') {
    const minutes = parseInt(data.minutes, 10);
    if (!minutes || minutes <= 0) {
      return replyText(event.replyToken, '⚠️ ETA 分鐘數不正確。');
    }

    order.etaMin = minutes;
    order.status = 'eta_set';
    delete riderPendingEta[operatorId];

    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: `預計${minutes}分鐘抵達取件地點`,
    });

    await pushText(
      order.customerUserId,
      `✅ 已有騎手接單\n\n預計 ${minutes} 分鐘抵達取件地點`
    );

    await pushGroupTaskAction(order);
    return null;
  }

  if (data.action === 'arrived_pickup') {
    order.status = 'arrived_pickup';

    await client.replyMessage(event.replyToken, { type: 'text', text: '✅ 已抵達取件地點' });
    await pushText(order.customerUserId, '✅ 騎手已抵達取件地點');
    await pushGroupTaskAction(order);
    return null;
  }

  if (data.action === 'picked_up') {
    order.status = 'picked_up';

    await client.replyMessage(event.replyToken, [
      { type: 'text', text: '✅ 已取件' },
      {
        type: 'template',
        altText: '導航到送達地點',
        template: {
          type: 'buttons',
          text: '可直接導航至送達地點',
          actions: [
            {
              type: 'uri',
              label: '導航到送達地點',
              uri: buildGoogleMapNavUrl(order.dropoffAddress),
            },
          ],
        },
      },
    ]);

    await pushText(order.customerUserId, '✅ 騎手已取件，正在前往送達地點');
    await pushGroupTaskAction(order);
    return null;
  }

  if (data.action === 'arrived_dropoff') {
    order.status = 'arrived_dropoff';

    await client.replyMessage(event.replyToken, [
      { type: 'text', text: '✅ 已送達' },
      buildTaskActionFlex(order),
    ]);

    await pushText(order.customerUserId, '✅ 騎手已抵達送達地點，正準備交付');
    return null;
  }

  if (data.action === 'completed') {
    order.status = 'completed';

    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: '✅ 任務已完成',
    });

    await pushText(
      order.customerUserId,
      `✅ 已抵達目的地，任務已完成。\n\n感謝您使用 UBee 城市任務服務。\n期待再次為您服務。`
    );

    return null;
  }

  return null;
}

// =========================
// 群組文字輸入（手動 ETA 支援）
// =========================
async function handleGroupText(event, text) {
  const operatorId = event.source.userId;
  if (!operatorId) return null;

  // 騎手接單後，手動輸入分鐘數
  if (/^\d+$/.test(text) && riderPendingEta[operatorId]) {
    const orderId = riderPendingEta[operatorId];
    const order = orders[orderId];

    if (!order) {
      delete riderPendingEta[operatorId];
      return replyText(event.replyToken, '⚠️ 找不到對應任務。');
    }

    if (order.riderUserId !== operatorId) {
      delete riderPendingEta[operatorId];
      return replyText(event.replyToken, '⚠️ 此任務不是由您接單。');
    }

    const minutes = parseInt(text, 10);
    if (minutes <= 0) {
      return replyText(event.replyToken, '請輸入正確分鐘數。');
    }

    order.etaMin = minutes;
    order.status = 'eta_set';
    delete riderPendingEta[operatorId];

    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: `預計${minutes}分鐘抵達取件地點`,
    });

    await pushText(
      order.customerUserId,
      `✅ 已有騎手接單\n\n預計 ${minutes} 分鐘抵達取件地點`
    );

    await pushGroupTaskAction(order);
    return null;
  }

  return null;
}
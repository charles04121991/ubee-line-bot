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
  console.error('❌ Missing CHANNEL_ACCESS_TOKEN or CHANNEL_SECRET');
  process.exit(1);
}

const client = new line.Client(config);

const PORT = process.env.PORT || 3000;
const LINE_GROUP_ID = (process.env.LINE_GROUP_ID || '').trim();
const GOOGLE_MAPS_API_KEY = (process.env.GOOGLE_MAPS_API_KEY || '').trim();

// ===== 費率設定 =====
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const URGENT_FEE = 100;
const SERVICE_FEE = 50;
const FIXED_TAX = 15;

// 騎手分潤（配送費 * 0.6）
const RIDER_PERCENT = 0.6;

// ===== 暫存記憶 =====
const userSessions = {};   // 使用者填單流程
const activeOrders = {};   // 目前可接任務
const groupStates = {};    // 群組等待 ETA 狀態

// ===== 共用工具 =====
function getSourceId(event) {
  return event.source.userId || event.source.groupId || event.source.roomId || 'unknown';
}

function isUserEvent(event) {
  return event.source.type === 'user';
}

function isGroupEvent(event) {
  return event.source.type === 'group' || event.source.type === 'room';
}

function normalizeText(text) {
  return (text || '').trim();
}

function safeNumber(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function newOrderId() {
  return `order_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

function resetUserSession(userId) {
  delete userSessions[userId];
}

function extractDistrict(address = '') {
  const cleaned = address.replace(/台灣|臺灣|台中市|臺中市/g, '').trim();
  const match = cleaned.match(
    /(中區|東區|西區|南區|北區|西屯區|南屯區|北屯區|豐原區|東勢區|大甲區|清水區|沙鹿區|梧棲區|后里區|神岡區|潭子區|大雅區|新社區|石岡區|外埔區|大安區|烏日區|大肚區|龍井區|霧峰區|太平區|大里區|和平區)/
  );
  return match ? match[1] : '';
}

function isCrossDistrict(pickup, dropoff) {
  const d1 = extractDistrict(pickup);
  const d2 = extractDistrict(dropoff);
  if (!d1 || !d2) return false;
  return d1 !== d2;
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

async function getDistanceAndDuration(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn('⚠️ GOOGLE_MAPS_API_KEY not set, using fallback distance/duration');
    return {
      distanceKm: 5,
      durationMin: 15,
      source: 'fallback',
    };
  }

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(
    origin
  )}&destinations=${encodeURIComponent(destination)}&mode=driving&language=zh-TW&key=${GOOGLE_MAPS_API_KEY}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (
      data.status !== 'OK' ||
      !data.rows ||
      !data.rows[0] ||
      !data.rows[0].elements ||
      !data.rows[0].elements[0] ||
      data.rows[0].elements[0].status !== 'OK'
    ) {
      console.error('❌ Google Maps API error:', JSON.stringify(data, null, 2));
      return {
        distanceKm: 5,
        durationMin: 15,
        source: 'fallback',
      };
    }

    const element = data.rows[0].elements[0];
    const distanceKm = Math.max(1, Math.ceil((element.distance.value || 0) / 1000));
    const durationMin = Math.max(1, Math.ceil((element.duration.value || 0) / 60));

    console.log('✅ Google Maps distance result:', {
      origin,
      destination,
      distanceKm,
      durationMin,
    });

    return {
      distanceKm,
      durationMin,
      source: 'google',
    };
  } catch (error) {
    console.error('❌ getDistanceAndDuration failed:', error.message);
    return {
      distanceKm: 5,
      durationMin: 15,
      source: 'fallback',
    };
  }
}

function calculateCustomerPrice({ distanceKm, durationMin, urgent, pickup, dropoff }) {
  const distanceFee = safeNumber(distanceKm) * PER_KM_FEE;
  const timeFee = safeNumber(durationMin) * PER_MIN_FEE;
  const crossFee = isCrossDistrict(pickup, dropoff) ? CROSS_DISTRICT_FEE : 0;
  const urgentFee = urgent === '急件' ? URGENT_FEE : 0;

  const deliveryFee = BASE_FEE + distanceFee + timeFee + crossFee;
  const serviceFee = SERVICE_FEE;
  const subtotal = deliveryFee + serviceFee + urgentFee;
  const total = subtotal + FIXED_TAX;

  return {
    distanceFee,
    timeFee,
    crossFee,
    urgentFee,
    deliveryFee,
    serviceFee,
    subtotal,
    tax: FIXED_TAX,
    total,
  };
}

function calculateRiderPay(customerPrice) {
  return Math.round(customerPrice.deliveryFee * RIDER_PERCENT);
}

function createQuoteOnlySummary(data) {
  return (
`📍 立即估價結果

取件地點：${data.pickup}
送達地點：${data.dropoff}
物品內容：${data.item}
是否急件：${data.urgent}

配送費：$${data.price.deliveryFee}
服務費：$${data.price.serviceFee}
稅金：$${data.price.tax}
總計：$${data.price.total}`
  );
}

function createTaskSummaryForCustomer(order) {
  return (
`✅ 您的任務資訊如下：

取件地點：${order.pickup}
取件電話：${order.pickupPhone}

送達地點：${order.dropoff}
送達電話：${order.dropoffPhone}

物品內容：${order.item}
是否急件：${order.urgent}
備註：${order.note || '無'}

配送費：$${order.price.deliveryFee}
服務費：$${order.price.serviceFee}
稅金：$${order.price.tax}
總計：$${order.price.total}`
  );
}

function createDispatchMessage(order) {
  return (
`📦 UBee 新任務通知

費用：$${order.riderPay}
距離：${order.distanceKm} 公里

取件：${order.pickup}
送達：${order.dropoff}
物品：${order.item}
急件：${order.urgent}
備註：${order.note || '無'}`
  );
}

async function dispatchOrderToGroup(order) {
  if (!LINE_GROUP_ID) {
    console.warn('⚠️ LINE_GROUP_ID not set, dispatch skipped.');
    return false;
  }

  const dispatchText = createDispatchMessage(order);

  try {
    console.log('📤 準備派單到群組...');
    console.log('LINE_GROUP_ID =', LINE_GROUP_ID);
    console.log('order.id =', order.id);
    console.log('dispatchText =', dispatchText);

    await pushText(LINE_GROUP_ID, dispatchText);

    console.log('✅ 派單成功送到群組');
    return true;
  } catch (error) {
    console.error('❌ 派單失敗');
    console.error('error.message =', error.message);

    if (error && error.originalError && error.originalError.response) {
      try {
        console.error(
          'error.response.data =',
          JSON.stringify(error.originalError.response.data, null, 2)
        );
      } catch (e) {
        console.error('error.response.data parse failed');
      }
    }

    return false;
  }
}

async function getDisplayNameSafe(event) {
  try {
    if (event.source.type === 'group' && event.source.groupId && event.source.userId) {
      const profile = await client.getGroupMemberProfile(
        event.source.groupId,
        event.source.userId
      );
      return profile.displayName || '跑腿人員';
    }

    if (event.source.type === 'room' && event.source.roomId && event.source.userId) {
      const profile = await client.getRoomMemberProfile(
        event.source.roomId,
        event.source.userId
      );
      return profile.displayName || '跑腿人員';
    }

    if (event.source.type === 'user' && event.source.userId) {
      const profile = await client.getProfile(event.source.userId);
      return profile.displayName || '用戶';
    }

    return '跑腿人員';
  } catch (error) {
    return '跑腿人員';
  }
}

function findAcceptedOrderByRider(riderId) {
  return Object.values(activeOrders).find(
    (order) =>
      order.riderId === riderId &&
      ['accepted', 'arrived', 'picked', 'delivered'].includes(order.status)
  );
}

// ===== 流程開始 =====
function startTaskFlow(userId, type) {
  userSessions[userId] = {
    type, // task / quote
    step: 'pickup',
    data: {
      pickup: '',
      pickupPhone: '',
      dropoff: '',
      dropoffPhone: '',
      item: '',
      urgent: '',
      note: '',
    },
  };
}

// ===== 使用者流程 =====
async function handleUserFlow(event, text) {
  const userId = getSourceId(event);
  const session = userSessions[userId];

  if (!session) return false;

  const value = normalizeText(text);

  if (value === '取消') {
    resetUserSession(userId);
    await replyText(event.replyToken, '✅ 已取消本次流程。');
    return true;
  }

  if (session.type === 'task') {
    return handleTaskFlow(event, session, value);
  }

  if (session.type === 'quote') {
    return handleQuoteFlow(event, session, value);
  }

  return false;
}

async function handleTaskFlow(event, session, value) {
  const userId = getSourceId(event);

  switch (session.step) {
    case 'pickup':
      session.data.pickup = value;
      session.step = 'pickupPhone';
      await replyText(event.replyToken, '請輸入取件電話：');
      return true;

    case 'pickupPhone':
      session.data.pickupPhone = value;
      session.step = 'dropoff';
      await replyText(event.replyToken, '請輸入送達地點：');
      return true;

    case 'dropoff':
      session.data.dropoff = value;
      session.step = 'dropoffPhone';
      await replyText(event.replyToken, '請輸入送達電話：');
      return true;

    case 'dropoffPhone':
      session.data.dropoffPhone = value;
      session.step = 'item';
      await replyText(event.replyToken, '請輸入物品內容：');
      return true;

    case 'item':
      session.data.item = value;
      session.step = 'urgent';
      await replyText(event.replyToken, '請輸入是否急件（一般 / 急件）：');
      return true;

    case 'urgent':
      if (value !== '一般' && value !== '急件') {
        await replyText(event.replyToken, '請輸入「一般」或「急件」。');
        return true;
      }
      session.data.urgent = value;
      session.step = 'note';
      await replyText(event.replyToken, '請輸入備註（沒有可輸入：無）：');
      return true;

    case 'note': {
      session.data.note = value || '無';

      const distanceInfo = await getDistanceAndDuration(
        session.data.pickup,
        session.data.dropoff
      );

      const price = calculateCustomerPrice({
        distanceKm: distanceInfo.distanceKm,
        durationMin: distanceInfo.durationMin,
        urgent: session.data.urgent,
        pickup: session.data.pickup,
        dropoff: session.data.dropoff,
      });

      const riderPay = calculateRiderPay(price);
      const orderId = newOrderId();

      const order = {
        id: orderId,
        customerId: userId,
        status: 'pending',
        pickup: session.data.pickup,
        pickupPhone: session.data.pickupPhone,
        dropoff: session.data.dropoff,
        dropoffPhone: session.data.dropoffPhone,
        item: session.data.item,
        urgent: session.data.urgent,
        note: session.data.note,
        distanceKm: distanceInfo.distanceKm,
        durationMin: distanceInfo.durationMin,
        price,
        riderPay,
        riderId: '',
        riderName: '',
        eta: '',
        createdAt: new Date().toISOString(),
      };

      activeOrders[orderId] = order;
      resetUserSession(userId);

      const customerText =
        createTaskSummaryForCustomer(order) +
        '\n\n✅ 您的任務已建立成功，我們會立即為您派單。';

      await replyText(event.replyToken, customerText);

      const dispatchSuccess = await dispatchOrderToGroup(order);

      if (!dispatchSuccess) {
        console.warn(`⚠️ 訂單 ${order.id} 已建立，但派單到群組失敗`);
      }

      return true;
    }

    default:
      resetUserSession(userId);
      await replyText(event.replyToken, '系統流程已重置，請重新輸入「建立任務」。');
      return true;
  }
}

async function handleQuoteFlow(event, session, value) {
  const userId = getSourceId(event);

  switch (session.step) {
    case 'pickup':
      session.data.pickup = value;
      session.step = 'dropoff';
      await replyText(event.replyToken, '請輸入送達地點：');
      return true;

    case 'dropoff':
      session.data.dropoff = value;
      session.step = 'item';
      await replyText(event.replyToken, '請輸入物品內容：');
      return true;

    case 'item':
      session.data.item = value;
      session.step = 'urgent';
      await replyText(event.replyToken, '請輸入是否急件（一般 / 急件）：');
      return true;

    case 'urgent': {
      if (value !== '一般' && value !== '急件') {
        await replyText(event.replyToken, '請輸入「一般」或「急件」。');
        return true;
      }

      session.data.urgent = value;

      const distanceInfo = await getDistanceAndDuration(
        session.data.pickup,
        session.data.dropoff
      );

      const price = calculateCustomerPrice({
        distanceKm: distanceInfo.distanceKm,
        durationMin: distanceInfo.durationMin,
        urgent: session.data.urgent,
        pickup: session.data.pickup,
        dropoff: session.data.dropoff,
      });

      const result = {
        ...session.data,
        price,
      };

      resetUserSession(userId);
      await replyText(event.replyToken, createQuoteOnlySummary(result));
      return true;
    }

    default:
      resetUserSession(userId);
      await replyText(event.replyToken, '系統流程已重置，請重新輸入「立即估價」。');
      return true;
  }
}

// ===== 群組接單流程 =====
async function handleGroupCommands(event, text) {
  const groupId = getSourceId(event);
  const trimmed = normalizeText(text);

  const acceptMatch = trimmed.match(/^接單\s*(\d+)?$/);

  if (acceptMatch) {
    const eta = acceptMatch[1];

    const pendingOrder = Object.values(activeOrders).find(
      (order) => order.status === 'pending'
    );

    if (!pendingOrder) {
      await replyText(event.replyToken, '目前沒有可接的任務。');
      return true;
    }

    if (!eta) {
      groupStates[groupId] = {
        action: 'awaiting_eta',
        orderId: pendingOrder.id,
      };
      await replyText(event.replyToken, '✅ 已收到接單，請回覆幾分鐘會到取件地點\n例如：8');
      return true;
    }

    const profileName = await getDisplayNameSafe(event);

    pendingOrder.status = 'accepted';
    pendingOrder.riderId = event.source.userId || 'group-member';
    pendingOrder.riderName = profileName;
    pendingOrder.eta = eta;

    await replyText(event.replyToken, `✅ 已接單，預計 ${eta} 分鐘到取件地點`);

    if (pendingOrder.customerId) {
      try {
        await pushText(
          pendingOrder.customerId,
          `✅ 已有人接單\n⏱ 預計 ${eta} 分鐘抵達取件地點`
        );
      } catch (error) {
        console.error('❌ 通知客戶接單失敗:', error.message);
      }
    }

    return true;
  }

  if (groupStates[groupId]?.action === 'awaiting_eta' && /^\d+$/.test(trimmed)) {
    const state = groupStates[groupId];
    const order = activeOrders[state.orderId];

    delete groupStates[groupId];

    if (!order || order.status !== 'pending') {
      await replyText(event.replyToken, '此任務目前已不可接。');
      return true;
    }

    const profileName = await getDisplayNameSafe(event);

    order.status = 'accepted';
    order.riderId = event.source.userId || 'group-member';
    order.riderName = profileName;
    order.eta = trimmed;

    await replyText(event.replyToken, `✅ 已接單，預計 ${trimmed} 分鐘到取件地點`);

    if (order.customerId) {
      try {
        await pushText(
          order.customerId,
          `✅ 已有人接單\n⏱ 預計 ${trimmed} 分鐘抵達取件地點`
        );
      } catch (error) {
        console.error('❌ 通知客戶接單失敗:', error.message);
      }
    }

    return true;
  }

  if (trimmed === '已抵達') {
    const order = findAcceptedOrderByRider(event.source.userId);
    if (!order) {
      await replyText(event.replyToken, '目前沒有您已接下的任務。');
      return true;
    }

    order.status = 'arrived';
    await replyText(event.replyToken, '✅ 已回報抵達取件地點');

    if (order.customerId) {
      try {
        await pushText(order.customerId, '✅ 跑腿人員已抵達取件地點。');
      } catch (error) {
        console.error('❌ 通知客戶已抵達失敗:', error.message);
      }
    }

    return true;
  }

  if (trimmed === '已取件') {
    const order = findAcceptedOrderByRider(event.source.userId);
    if (!order) {
      await replyText(event.replyToken, '目前沒有您已接下的任務。');
      return true;
    }

    order.status = 'picked';
    await replyText(event.replyToken, '✅ 已回報取件完成');

    if (order.customerId) {
      try {
        await pushText(order.customerId, '✅ 您的物品已取件，正在送達中。');
      } catch (error) {
        console.error('❌ 通知客戶已取件失敗:', error.message);
      }
    }

    return true;
  }

  if (trimmed === '已送達') {
    const order = findAcceptedOrderByRider(event.source.userId);
    if (!order) {
      await replyText(event.replyToken, '目前沒有您已接下的任務。');
      return true;
    }

    order.status = 'delivered';
    await replyText(event.replyToken, '✅ 已回報送達完成');

    if (order.customerId) {
      try {
        await pushText(order.customerId, '✅ 您的任務已送達。');
      } catch (error) {
        console.error('❌ 通知客戶已送達失敗:', error.message);
      }
    }

    return true;
  }

  if (trimmed === '已完成') {
    const order = findAcceptedOrderByRider(event.source.userId);
    if (!order) {
      await replyText(event.replyToken, '目前沒有您已接下的任務。');
      return true;
    }

    order.status = 'completed';
    await replyText(event.replyToken, '✅ 任務已完成');

    if (order.customerId) {
      try {
        await pushText(
          order.customerId,
`✅ 已抵達目的地，任務已完成。

感謝您使用 UBee 城市任務跑腿服務。
期待再次為您服務。`
        );
      } catch (error) {
        console.error('❌ 通知客戶已完成失敗:', error.message);
      }
    }

    delete activeOrders[order.id];
    return true;
  }

  return false;
}

// ===== 主邏輯 =====
async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') {
      return null;
    }

    const text = normalizeText(event.message.text);
    console.log('📩 Incoming message:', {
      sourceType: event.source.type,
      userId: event.source.userId || '',
      groupId: event.source.groupId || '',
      roomId: event.source.roomId || '',
      text,
    });

    if (isUserEvent(event)) {
      const handledFlow = await handleUserFlow(event, text);
      if (handledFlow) return null;
    }

    if (isGroupEvent(event)) {
      const handledGroup = await handleGroupCommands(event, text);
      if (handledGroup) return null;
    }

    if (isUserEvent(event)) {
      if (text === '建立任務') {
        startTaskFlow(getSourceId(event), 'task');
        await replyText(event.replyToken, '請輸入取件地點：');
        return null;
      }

      if (text === '立即估價') {
        startTaskFlow(getSourceId(event), 'quote');
        await replyText(event.replyToken, '請輸入取件地點：');
        return null;
      }

      if (text === '幫助' || text.toLowerCase() === 'help') {
        await replyText(
          event.replyToken,
`您可以輸入以下功能：

建立任務
立即估價
取消`
        );
        return null;
      }

      await replyText(
        event.replyToken,
`您好，請輸入以下功能：

1. 建立任務
2. 立即估價`
      );
      return null;
    }

    return null;
  } catch (error) {
    console.error('❌ handleEvent error:', error);
    return null;
  }
}

// ===== 路由 =====
app.get('/', (req, res) => {
  res.status(200).send('UBee bot v2.5 debug');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (error) {
    console.error('❌ webhook error:', error);
    res.status(500).end();
  }
});

// ===== 啟動 =====
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log('===== UBee ENV CHECK =====');
  console.log('CHANNEL_ACCESS_TOKEN:', config.channelAccessToken ? 'SET' : 'MISSING');
  console.log('CHANNEL_SECRET:', config.channelSecret ? 'SET' : 'MISSING');
  console.log('LINE_GROUP_ID:', LINE_GROUP_ID ? LINE_GROUP_ID : 'MISSING');
  console.log('GOOGLE_MAPS_API_KEY:', GOOGLE_MAPS_API_KEY ? 'SET' : 'MISSING');
  console.log('==========================');
});

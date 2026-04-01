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
const LINE_GROUP_ID = process.env.LINE_GROUP_ID || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// =========================
// UBee V3 正式計價參數
// =========================
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const URGENT_FEE = 100;
const SERVICE_FEE = 50;
const TAX_FEE = 15;

const DISTANCE_ADJUST_RATE = 1.15;
const LONG_DISTANCE_THRESHOLD = 15;
const LONG_DISTANCE_EXTRA_PER_KM = 3;

const MIN_DELIVERY_FEE = 150;
const MIN_RIDER_FEE = 120;

// =========================
// 記憶體暫存
// =========================
const userStates = new Map();      // userId -> { mode: 'create' | 'quote' }
const tasks = new Map();           // taskId -> task
const processedEvents = new Set(); // 避免 webhook 重複
const greetedUsers = new Map();    // userId -> timestamp
let taskCounter = 1;

// =========================
// 基本工具
// =========================
function now() {
  return new Date().toISOString();
}

function generateTaskId() {
  const id = String(taskCounter).padStart(4, '0');
  taskCounter += 1;
  return id;
}

function safeTrim(text = '') {
  return String(text).trim();
}

function isUrgentText(text = '') {
  return /急件/.test(text);
}

function getDistrict(address = '') {
  const districtList = [
    '中區', '東區', '南區', '西區', '北區',
    '西屯區', '南屯區', '北屯區',
    '豐原區', '東勢區', '大甲區', '清水區',
    '沙鹿區', '梧棲區', '后里區', '神岡區',
    '潭子區', '大雅區', '新社區', '石岡區',
    '外埔區', '大安區', '烏日區', '大肚區',
    '龍井區', '霧峰區', '太平區', '大里區',
    '和平區'
  ];

  for (const district of districtList) {
    if (address.includes(district)) return district;
  }
  return '';
}

function isCrossDistrict(pickupAddress = '', dropoffAddress = '') {
  const pickupDistrict = getDistrict(pickupAddress);
  const dropoffDistrict = getDistrict(dropoffAddress);

  if (!pickupDistrict || !dropoffDistrict) return false;
  return pickupDistrict !== dropoffDistrict;
}

function shouldSuppressGreeting(userId) {
  const last = greetedUsers.get(userId);
  const nowTs = Date.now();

  if (!last) {
    greetedUsers.set(userId, nowTs);
    return false;
  }

  if (nowTs - last < 10 * 60 * 1000) {
    return true;
  }

  greetedUsers.set(userId, nowTs);
  return false;
}

// =========================
// Google Maps 距離
// =========================
async function getDistanceAndDuration(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('Missing GOOGLE_MAPS_API_KEY');
  }

  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(destination)}` +
    `&mode=driving` +
    `&language=zh-TW` +
    `&region=tw` +
    `&departure_time=now` +
    `&key=${GOOGLE_MAPS_API_KEY}`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.status !== 'OK') {
    throw new Error(`Google Maps API error: ${data.status}`);
  }

  const element = data.rows?.[0]?.elements?.[0];

  if (!element || element.status !== 'OK') {
    throw new Error(`Distance Matrix element error: ${element?.status || 'UNKNOWN'}`);
  }

  const rawDistanceKm = element.distance.value / 1000;
  const durationMin = Math.ceil(element.duration.value / 60);

  return {
    rawDistanceKm: Number(rawDistanceKm.toFixed(1)),
    durationMin
  };
}

// =========================
// V3 計價邏輯
// =========================
function calculateV3Price({
  rawDistanceKm,
  durationMin,
  isUrgent,
  crossDistrict
}) {
  const adjustedDistanceKm = Number((rawDistanceKm * DISTANCE_ADJUST_RATE).toFixed(1));

  let deliveryFee =
    BASE_FEE +
    (adjustedDistanceKm * PER_KM_FEE) +
    (durationMin * PER_MIN_FEE) +
    (crossDistrict ? CROSS_DISTRICT_FEE : 0);

  if (adjustedDistanceKm > LONG_DISTANCE_THRESHOLD) {
    deliveryFee += (adjustedDistanceKm - LONG_DISTANCE_THRESHOLD) * LONG_DISTANCE_EXTRA_PER_KM;
  }

  deliveryFee = Math.round(deliveryFee);

  if (deliveryFee < MIN_DELIVERY_FEE) {
    deliveryFee = MIN_DELIVERY_FEE;
  }

  const urgentFee = isUrgent ? URGENT_FEE : 0;
  const subtotal = deliveryFee + urgentFee + SERVICE_FEE;
  const total = subtotal + TAX_FEE;

  let riderFee =
    (deliveryFee * 0.6) +
    (isUrgent ? URGENT_FEE * 0.6 : 0);

  riderFee = Math.round(riderFee);

  if (riderFee < MIN_RIDER_FEE) {
    riderFee = MIN_RIDER_FEE;
  }

  const platformProfit = total - riderFee;

  return {
    rawDistanceKm: Number(rawDistanceKm.toFixed(1)),
    adjustedDistanceKm,
    durationMin,
    deliveryFee,
    urgentFee,
    serviceFee: SERVICE_FEE,
    taxFee: TAX_FEE,
    subtotal,
    total,
    riderFee,
    platformProfit
  };
}

// =========================
// 訊息格式
// =========================
function buildFormTemplate(mode = 'create') {
  const title =
    mode === 'quote'
      ? '請直接貼上以下格式，我立即幫您估價：'
      : '請直接貼上以下格式，我立即幫您建立任務：';

  return `${title}

取件地點：
取件電話：

送達地點：
送達電話：

物品內容：
是否急件（一般 / 急件）：
備註：`;
}

function buildCustomerQuoteMessage(task) {
  return `✅ 已為您完成估價

配送費：$${task.deliveryFee}
急件費：$${task.urgentFee}
服務費：$${task.serviceFee}
稅金：$${task.taxFee}
總計：$${task.total}`;
}

function buildTaskCreatedMessage(task) {
  return `✅ 您的任務已建立成功

配送費：$${task.deliveryFee}
急件費：$${task.urgentFee}
服務費：$${task.serviceFee}
稅金：$${task.taxFee}
總計：$${task.total}

我們會立即為您派單。`;
}

function buildGroupDispatchMessage(task) {
  return `📦 UBee 新任務通知

費用：$${task.riderFee}
距離：${task.adjustedDistanceKm} 公里

取件：${task.pickupAddress}
送達：${task.dropoffAddress}
物品：${task.item}
急件：${task.isUrgent ? '急件' : '一般'}`;
}

function buildCustomerAcceptedMessage(task) {
  return `✅ 已有人接單
⏱ 預計 ${task.etaMin} 分鐘抵達取件地點`;
}

// =========================
// 表單解析
// =========================
function parseTaskForm(text) {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const result = {
    pickupAddress: '',
    pickupPhone: '',
    dropoffAddress: '',
    dropoffPhone: '',
    item: '',
    isUrgent: false,
    note: ''
  };

  for (const line of lines) {
    if (line.startsWith('取件地點')) {
      result.pickupAddress = line.split('：').slice(1).join('：').trim();
    } else if (line.startsWith('取件電話')) {
      result.pickupPhone = line.split('：').slice(1).join('：').trim();
    } else if (line.startsWith('送達地點')) {
      result.dropoffAddress = line.split('：').slice(1).join('：').trim();
    } else if (line.startsWith('送達電話')) {
      result.dropoffPhone = line.split('：').slice(1).join('：').trim();
    } else if (line.startsWith('物品內容')) {
      result.item = line.split('：').slice(1).join('：').trim();
    } else if (line.startsWith('是否急件')) {
      const urgentText = line.split('：').slice(1).join('：').trim();
      result.isUrgent = isUrgentText(urgentText);
    } else if (line.startsWith('備註')) {
      result.note = line.split('：').slice(1).join('：').trim();
    }
  }

  const isValid =
    !!result.pickupAddress &&
    !!result.dropoffAddress &&
    !!result.item &&
    (!!result.pickupPhone || !!result.dropoffPhone);

  return {
    ...result,
    isValid
  };
}

// =========================
// 任務整合
// =========================
async function enrichTaskWithPricing(baseTask) {
  const distanceResult = await getDistanceAndDuration(
    baseTask.pickupAddress,
    baseTask.dropoffAddress
  );

  const crossDistrict = isCrossDistrict(
    baseTask.pickupAddress,
    baseTask.dropoffAddress
  );

  const priceResult = calculateV3Price({
    rawDistanceKm: distanceResult.rawDistanceKm,
    durationMin: distanceResult.durationMin,
    isUrgent: baseTask.isUrgent,
    crossDistrict
  });

  return {
    ...baseTask,
    rawDistanceKm: priceResult.rawDistanceKm,
    adjustedDistanceKm: priceResult.adjustedDistanceKm,
    durationMin: priceResult.durationMin,
    crossDistrict,
    deliveryFee: priceResult.deliveryFee,
    urgentFee: priceResult.urgentFee,
    serviceFee: priceResult.serviceFee,
    taxFee: priceResult.taxFee,
    subtotal: priceResult.subtotal,
    total: priceResult.total,
    riderFee: priceResult.riderFee,
    platformProfit: priceResult.platformProfit
  };
}

function getLatestWaitingTask() {
  const allTasks = Array.from(tasks.values())
    .filter(task => task.status === 'waiting')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return allTasks[0] || null;
}

function getLatestAcceptedTaskByRider(riderId) {
  const allTasks = Array.from(tasks.values())
    .filter(task => task.status !== 'completed')
    .filter(task => task.riderId === riderId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  return allTasks[0] || null;
}

// =========================
// LINE 回覆工具
// =========================
async function safeReply(replyToken, text) {
  if (!replyToken) return;
  await client.replyMessage(replyToken, {
    type: 'text',
    text
  });
}

async function safePush(to, text) {
  if (!to) return;
  await client.pushMessage(to, {
    type: 'text',
    text
  });
}

// =========================
// Server
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee bot v3 running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('❌ Webhook Error:', err);
    res.status(500).end();
  }
});

// =========================
// 事件總入口
// =========================
async function handleEvent(event) {
  try {
    const webhookEventId = event.webhookEventId;
    if (webhookEventId) {
      if (processedEvents.has(webhookEventId)) {
        return null;
      }
      processedEvents.add(webhookEventId);

      if (processedEvents.size > 5000) {
        const first = processedEvents.values().next().value;
        processedEvents.delete(first);
      }
    }

    if (event.type === 'follow') {
      const userId = event.source?.userId;
      if (userId && !shouldSuppressGreeting(userId)) {
        await safeReply(
          event.replyToken,
          '您好，歡迎使用 UBee 城市任務服務。\n\n您可以輸入：\n建立任務\n立即估價'
        );
      }
      return null;
    }

    if (event.type !== 'message' || event.message.type !== 'text') {
      return null;
    }

    const text = safeTrim(event.message.text);
    const sourceType = event.source?.type;

    if (sourceType === 'group') {
      return await handleGroupText(event, text);
    }

    return await handleUserText(event, text);
  } catch (err) {
    console.error('❌ handleEvent error:', err);
    if (event.replyToken) {
      await safeReply(event.replyToken, '系統忙碌中，請稍後再試一次。');
    }
    return null;
  }
}

// =========================
// 使用者私聊邏輯
// =========================
async function handleUserText(event, text) {
  const userId = event.source?.userId;
  if (!userId) return null;

  if (text === '建立任務') {
    userStates.set(userId, { mode: 'create' });
    await safeReply(event.replyToken, buildFormTemplate('create'));
    return null;
  }

  if (text === '立即估價') {
    userStates.set(userId, { mode: 'quote' });
    await safeReply(event.replyToken, buildFormTemplate('quote'));
    return null;
  }

  if (text === '謝謝' || text === '感謝' || text === '感恩') {
    await safeReply(event.replyToken, '不客氣，感謝您使用 UBee 城市任務服務。');
    return null;
  }

  const state = userStates.get(userId);
  const parsed = parseTaskForm(text);

  if (state && parsed.isValid) {
    const baseTask = {
      id: generateTaskId(), // 系統內部使用，不對外顯示
      customerUserId: userId,
      pickupAddress: parsed.pickupAddress,
      pickupPhone: parsed.pickupPhone,
      dropoffAddress: parsed.dropoffAddress,
      dropoffPhone: parsed.dropoffPhone,
      item: parsed.item,
      isUrgent: parsed.isUrgent,
      note: parsed.note || '無',
      status: state.mode === 'quote' ? 'quoted' : 'waiting',
      createdAt: now(),
      updatedAt: now(),
      riderId: '',
      riderName: '',
      etaMin: 0
    };

    const fullTask = await enrichTaskWithPricing(baseTask);

    if (state.mode === 'quote') {
      userStates.delete(userId);
      await safeReply(event.replyToken, buildCustomerQuoteMessage(fullTask));
      return null;
    }

    tasks.set(fullTask.id, fullTask);
    userStates.delete(userId);

    await safeReply(event.replyToken, buildTaskCreatedMessage(fullTask));

    if (LINE_GROUP_ID) {
      await safePush(LINE_GROUP_ID, buildGroupDispatchMessage(fullTask));
    }

    return null;
  }

  if (state && !parsed.isValid) {
    await safeReply(
      event.replyToken,
      '資料格式還不完整，請依照以下格式重新貼上：\n\n' + buildFormTemplate(state.mode)
    );
    return null;
  }

  await safeReply(
    event.replyToken,
    '您好，請輸入以下其中一個指令：\n\n建立任務\n立即估價'
  );

  return null;
}

// =========================
// 群組邏輯
// =========================
async function handleGroupText(event, text) {
  const groupId = event.source?.groupId;
  if (LINE_GROUP_ID && groupId !== LINE_GROUP_ID) {
    return null;
  }

  const riderId = event.source?.userId || '';
  let riderName = '騎手';

  try {
    if (riderId) {
      const profile = await client.getGroupMemberProfile(groupId, riderId);
      riderName = profile?.displayName || riderName;
    }
  } catch (err) {
    console.warn('⚠️ 無法取得群組成員名稱，改用預設名稱');
  }

  const acceptMatch = text.match(/^接單\s*(\d{1,3})$/);
  if (acceptMatch) {
    const etaMin = Number(acceptMatch[1]);
    const task = getLatestWaitingTask();

    if (!task) {
      await safeReply(event.replyToken, '目前沒有等待中的任務。');
      return null;
    }

    task.status = 'accepted';
    task.etaMin = etaMin;
    task.riderId = riderId;
    task.riderName = riderName;
    task.updatedAt = now();
    tasks.set(task.id, task);

    await safeReply(event.replyToken, `✅ 已接單，ETA ${etaMin} 分鐘`);

    if (task.customerUserId) {
      await safePush(task.customerUserId, buildCustomerAcceptedMessage(task));
    }

    return null;
  }

  if (text === '已抵達') {
    const task = getLatestAcceptedTaskByRider(riderId);
    if (!task) {
      await safeReply(event.replyToken, '目前找不到您已接下但尚未完成的任務。');
      return null;
    }

    task.status = 'arrived';
    task.updatedAt = now();
    tasks.set(task.id, task);

    await safeReply(event.replyToken, '✅ 已回報抵達');
    await safePush(task.customerUserId, '✅ 騎手已抵達取件地點。');
    return null;
  }

  if (text === '已取件') {
    const task = getLatestAcceptedTaskByRider(riderId);
    if (!task) {
      await safeReply(event.replyToken, '目前找不到您已接下但尚未完成的任務。');
      return null;
    }

    task.status = 'picked';
    task.updatedAt = now();
    tasks.set(task.id, task);

    await safeReply(event.replyToken, '✅ 已回報取件完成');
    await safePush(task.customerUserId, '✅ 騎手已完成取件，正在前往送達地點。');
    return null;
  }

  if (text === '已送達') {
    const task = getLatestAcceptedTaskByRider(riderId);
    if (!task) {
      await safeReply(event.replyToken, '目前找不到您已接下但尚未完成的任務。');
      return null;
    }

    task.status = 'delivered';
    task.updatedAt = now();
    tasks.set(task.id, task);

    await safeReply(event.replyToken, '✅ 已回報送達');
    await safePush(task.customerUserId, '✅ 物品已送達目的地。');
    return null;
  }

  if (text === '已完成') {
    const task = getLatestAcceptedTaskByRider(riderId);
    if (!task) {
      await safeReply(event.replyToken, '目前找不到您已接下但尚未完成的任務。');
      return null;
    }

    task.status = 'completed';
    task.updatedAt = now();
    tasks.set(task.id, task);

    await safeReply(event.replyToken, '✅ 任務已完成');

    await safePush(
      task.customerUserId,
      `✅ 已抵達目的地，任務已完成。

感謝您使用 UBee 城市任務跑腿服務。
期待再次為您服務。`
    );

    return null;
  }

  return null;
}

app.listen(PORT, () => {
  console.log(`✅ UBee bot v3 running on port ${PORT}`);
});

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
// 費率設定
// =========================
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const URGENT_FEE = 100;
const TAX_FEE = 15;

// =========================
// 系統記憶體資料
// =========================
const userSessions = {}; // 使用者填單狀態
const tasks = {}; // 任務資料
let taskCounter = 1;

// 防 webhook 重複事件
const processedEvents = new Set();

// 防同一任務重複派單
const dispatchedTasks = new Set();

// =========================
// 工具函式
// =========================
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getDistrict(address = '') {
  const match = address.match(/(台中市)?(.+?[區鄉鎮市])/);
  return match ? match[2] : '';
}

function generateTaskId() {
  const id = String(taskCounter).padStart(4, '0');
  taskCounter += 1;
  return id;
}

function formatCurrency(num) {
  return `$${Math.round(num)}`;
}

function cleanupProcessedEvents() {
  // 避免 Set 無限增長
  if (processedEvents.size > 1000) {
    processedEvents.clear();
    console.log('🧹 processedEvents 已清空');
  }
}

function cleanupDispatchedTasks() {
  if (dispatchedTasks.size > 1000) {
    dispatchedTasks.clear();
    console.log('🧹 dispatchedTasks 已清空');
  }
}

async function geocodeAddress(address) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('缺少 GOOGLE_MAPS_API_KEY');
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.results || data.results.length === 0) {
    throw new Error(`地址無法解析：${address}`);
  }

  return data.results[0].geometry.location;
}

async function getDistanceAndDuration(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('缺少 GOOGLE_MAPS_API_KEY');
  }

  const originGeo = await geocodeAddress(origin);
  const destGeo = await geocodeAddress(destination);

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${originGeo.lat},${originGeo.lng}&destinations=${destGeo.lat},${destGeo.lng}&mode=driving&language=zh-TW&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  const element = data?.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK') {
    throw new Error('無法取得距離與時間');
  }

  const distanceKm = element.distance.value / 1000;
  const durationMin = element.duration.value / 60;

  return {
    distanceKm,
    durationMin,
  };
}

function calculatePrice({ distanceKm, durationMin, pickupAddress, deliveryAddress, urgent }) {
  const pickupDistrict = getDistrict(pickupAddress);
  const deliveryDistrict = getDistrict(deliveryAddress);
  const isCrossDistrict =
    pickupDistrict &&
    deliveryDistrict &&
    pickupDistrict !== deliveryDistrict;

  const distanceFee = distanceKm * PER_KM_FEE;
  const timeFee = durationMin * PER_MIN_FEE;
  const crossDistrictFee = isCrossDistrict ? CROSS_DISTRICT_FEE : 0;
  const urgentFee = urgent ? URGENT_FEE : 0;

  const deliveryFee = BASE_FEE + distanceFee + timeFee + crossDistrictFee + urgentFee;
  const total = deliveryFee + TAX_FEE;

  return {
    baseFee: BASE_FEE,
    distanceFee: Math.round(distanceFee),
    timeFee: Math.round(timeFee),
    crossDistrictFee,
    urgentFee,
    deliveryFee: Math.round(deliveryFee),
    taxFee: TAX_FEE,
    total: Math.round(total),
    isCrossDistrict,
    pickupDistrict,
    deliveryDistrict,
  };
}

async function safeReply(replyToken, messages) {
  try {
    await client.replyMessage(replyToken, messages);
  } catch (err) {
    console.error('❌ replyMessage 失敗:', err?.response?.data || err.message);
  }
}

async function safePushMessage(to, messages, retryCount = 2) {
  for (let attempt = 1; attempt <= retryCount + 1; attempt++) {
    try {
      await delay(400);
      await client.pushMessage(to, messages);
      console.log(`✅ pushMessage 成功，目標: ${to}`);
      return true;
    } catch (err) {
      const statusCode = err?.statusCode || err?.response?.status;
      const errorData = err?.response?.data || err.message;

      console.error(`❌ pushMessage 失敗，第 ${attempt} 次:`, errorData);

      if (statusCode === 429 && attempt <= retryCount) {
        console.log('⚠️ 遇到 429，準備延遲重試...');
        await delay(1500 * attempt);
        continue;
      }

      return false;
    }
  }

  return false;
}

function createTaskTextForCustomer(task) {
  return `✅ 任務建立成功

配送費：${formatCurrency(task.pricing.deliveryFee)}
稅金：${formatCurrency(task.pricing.taxFee)}
總計：${formatCurrency(task.pricing.total)}

取件地點：${task.pickupAddress}
送達地點：${task.deliveryAddress}
物品內容：${task.item}
是否急件：${task.urgent ? '急件' : '一般'}

我們會立即為您派單。`;
}

function createTaskTextForGroup(task) {
  return `📦 UBee 新任務通知

費用：${formatCurrency(task.pricing.deliveryFee)}
距離：${task.distanceKm.toFixed(1)} 公里

取件：${task.pickupAddress}
送達：${task.deliveryAddress}
物品：${task.item}
急件：${task.urgent ? '急件' : '一般'}`;
}

async function dispatchTaskToGroup(taskId) {
  cleanupDispatchedTasks();

  if (dispatchedTasks.has(taskId)) {
    console.log(`⚠️ 任務 ${taskId} 已派單過，略過`);
    return true;
  }

  const task = tasks[taskId];
  if (!task) {
    console.error(`❌ dispatchTaskToGroup 找不到任務 ${taskId}`);
    return false;
  }

  if (!LINE_GROUP_ID) {
    console.error('❌ 缺少 LINE_GROUP_ID');
    return false;
  }

  dispatchedTasks.add(taskId);

  console.log(`✅ 任務 ${taskId} 已加入派單佇列，群組 ${LINE_GROUP_ID}`);

  const success = await safePushMessage(LINE_GROUP_ID, {
    type: 'text',
    text: createTaskTextForGroup(task),
  });

  if (!success) {
    // 若失敗，讓之後仍可重派
    dispatchedTasks.delete(taskId);
    return false;
  }

  task.status = 'waiting_driver';
  return true;
}

function parseTaskForm(text) {
  const pickupAddress = (text.match(/取件地點[:：]\s*(.+)/) || [])[1]?.trim();
  const pickupPhone = (text.match(/取件電話[:：]\s*(.+)/) || [])[1]?.trim();
  const deliveryAddress = (text.match(/送達地點[:：]\s*(.+)/) || [])[1]?.trim();
  const deliveryPhone = (text.match(/送達電話[:：]\s*(.+)/) || [])[1]?.trim();
  const item = (text.match(/物品內容[:：]\s*(.+)/) || [])[1]?.trim();
  const urgentText = (text.match(/是否急件（一般\s*\/\s*急件）[:：]\s*(.+)/) || text.match(/是否急件[:：]\s*(.+)/) || [])[1]?.trim();
  const note = (text.match(/備註[:：]\s*(.*)/) || [])[1]?.trim() || '無';

  if (!pickupAddress || !pickupPhone || !deliveryAddress || !deliveryPhone || !item || !urgentText) {
    return null;
  }

  const urgent = urgentText.includes('急件');

  return {
    pickupAddress,
    pickupPhone,
    deliveryAddress,
    deliveryPhone,
    item,
    urgent,
    note,
  };
}

// =========================
// 群組騎手操作
// =========================
function getLatestWaitingTask() {
  const taskIds = Object.keys(tasks).sort((a, b) => Number(a) - Number(b));
  for (let i = taskIds.length - 1; i >= 0; i--) {
    const task = tasks[taskIds[i]];
    if (task.status === 'waiting_driver') {
      return task;
    }
  }
  return null;
}

async function handleGroupMessage(event, text) {
  const source = event.source;
  if (!source || source.type !== 'group') return null;

  const latestTask = getLatestWaitingTask();
  const driverName = event.source.userId ? '騎手' : '騎手';

  if (!latestTask) {
    if (text.startsWith('接單')) {
      return safeReply(event.replyToken, {
        type: 'text',
        text: '目前沒有等待中的任務。',
      });
    }
    return null;
  }

  if (/^接單\s*\d+$/i.test(text)) {
    if (latestTask.driverAssigned) {
      return safeReply(event.replyToken, {
        type: 'text',
        text: `此任務已有人接單。`,
      });
    }

    const eta = parseInt(text.replace(/[^\d]/g, ''), 10);
    latestTask.driverAssigned = driverName;
    latestTask.status = 'accepted';
    latestTask.eta = eta;

    await safeReply(event.replyToken, {
      type: 'text',
      text: `✅ 已接單\n⏱ 預計 ${eta} 分鐘抵達取件地`,
    });

    await safePushMessage(latestTask.userId, {
      type: 'text',
      text: `✅ 已有人接單\n⏱ 預計 ${eta} 分鐘抵達取件地`,
    });

    return;
  }

  if (text === '已抵達') {
    if (!latestTask.driverAssigned) return null;
    latestTask.status = 'arrived_pickup';

    await safeReply(event.replyToken, {
      type: 'text',
      text: '✅ 已回報抵達取件地',
    });

    await safePushMessage(latestTask.userId, {
      type: 'text',
      text: '✅ 騎手已抵達取件地點。',
    });
    return;
  }

  if (text === '已取件') {
    if (!latestTask.driverAssigned) return null;
    latestTask.status = 'picked_up';

    await safeReply(event.replyToken, {
      type: 'text',
      text: '✅ 已回報取件完成',
    });

    await safePushMessage(latestTask.userId, {
      type: 'text',
      text: '✅ 物品已取件，正在送達中。',
    });
    return;
  }

  if (text === '已送達') {
    if (!latestTask.driverAssigned) return null;
    latestTask.status = 'delivered';

    await safeReply(event.replyToken, {
      type: 'text',
      text: '✅ 已回報送達',
    });

    await safePushMessage(latestTask.userId, {
      type: 'text',
      text: '✅ 物品已送達目的地。',
    });
    return;
  }

  if (text === '已完成') {
    if (!latestTask.driverAssigned) return null;
    latestTask.status = 'completed';

    await safeReply(event.replyToken, {
      type: 'text',
      text: '✅ 任務已完成',
    });

    await safePushMessage(latestTask.userId, {
      type: 'text',
      text: `✅ 已抵達目的地，任務已完成。

感謝您使用 UBee 城市任務跑腿服務。
期待再次為您服務。`,
    });
    return;
  }
}

// =========================
// 使用者訊息邏輯
// =========================
async function handleUserMessage(event, text) {
  const userId = event.source.userId;
  if (!userId) return null;

  console.log('📩 使用者訊息:', text);

  if (text === '建立任務') {
    userSessions[userId] = { mode: 'awaiting_form' };

    return safeReply(event.replyToken, {
      type: 'text',
      text: `請依以下格式填寫任務資訊：

取件地點：
取件電話：

送達地點：
送達電話：

物品內容：
是否急件（一般 / 急件）：
備註：`,
    });
  }

  if (text === '立即估價') {
    return safeReply(event.replyToken, {
      type: 'text',
      text: `請依以下格式填寫，我們會立即幫您估價：

取件地點：
取件電話：

送達地點：
送達電話：

物品內容：
是否急件（一般 / 急件）：
備註：`,
    });
  }

  const formData = parseTaskForm(text);
  if (formData) {
    try {
      console.log('📦 收到完整任務表單:', formData);

      const { distanceKm, durationMin } = await getDistanceAndDuration(
        formData.pickupAddress,
        formData.deliveryAddress
      );

      const pricing = calculatePrice({
        distanceKm,
        durationMin,
        pickupAddress: formData.pickupAddress,
        deliveryAddress: formData.deliveryAddress,
        urgent: formData.urgent,
      });

      const taskId = generateTaskId();

      tasks[taskId] = {
        id: taskId,
        userId,
        pickupAddress: formData.pickupAddress,
        pickupPhone: formData.pickupPhone,
        deliveryAddress: formData.deliveryAddress,
        deliveryPhone: formData.deliveryPhone,
        item: formData.item,
        urgent: formData.urgent,
        note: formData.note,
        distanceKm,
        durationMin,
        pricing,
        status: 'created',
        driverAssigned: null,
        eta: null,
        createdAt: new Date().toISOString(),
      };

      await safeReply(event.replyToken, {
        type: 'text',
        text: createTaskTextForCustomer(tasks[taskId]),
      });

      const dispatchSuccess = await dispatchTaskToGroup(taskId);

      if (!dispatchSuccess) {
        console.error(`❌ 任務 ${taskId} 群組派單失敗`);
      }

      delete userSessions[userId];
      return;
    } catch (err) {
      console.error('❌ 任務建立失敗:', err?.response?.data || err.message);

      return safeReply(event.replyToken, {
        type: 'text',
        text: `❌ 任務建立失敗

可能原因：
1. 地址格式有誤
2. Google Maps API 未正確設定
3. 系統暫時忙碌

請重新確認地址後再試一次。`,
      });
    }
  }

  // 一般回覆，不做重複機器回音
  return safeReply(event.replyToken, {
    type: 'text',
    text: `您好，請輸入以下其中一項：

1. 建立任務
2. 立即估價`,
  });
}

// =========================
// LINE webhook
// =========================
async function handleEvent(event) {
  try {
    if (!event || event.type !== 'message' || event.message?.type !== 'text') {
      return null;
    }

    const eventId =
      event.webhookEventId ||
      `${event.timestamp}-${event.source?.type}-${event.source?.userId || event.source?.groupId || 'unknown'}-${event.message?.id || 'noid'}`;

    cleanupProcessedEvents();

    if (processedEvents.has(eventId)) {
      console.log('⚠️ 重複 webhook 事件，略過:', eventId);
      return null;
    }

    processedEvents.add(eventId);

    const text = (event.message.text || '').trim();

    console.log('📨 event.source =', JSON.stringify(event.source, null, 2));
    console.log('📨 event.text =', text);

    // 群組訊息
    if (event.source?.type === 'group') {
      return await handleGroupMessage(event, text);
    }

    // 個人訊息
    if (event.source?.type === 'user') {
      return await handleUserMessage(event, text);
    }

    return null;
  } catch (err) {
    console.error('❌ handleEvent 錯誤:', err?.response?.data || err.message);
    return null;
  }
}

// =========================
// Express routes
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee bot v3 stable running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('❌ webhook 錯誤:', err?.response?.data || err.message);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log(`✅ UBee bot listening on port ${PORT}`);
});
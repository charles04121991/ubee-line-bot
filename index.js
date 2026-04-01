require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');

const app = express();

// =========================
// LINE 基本設定
// =========================
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
const SERVICE_FEE = 50;
const FIXED_TAX = 15;

// 急件費有 60% 給騎手
const RIDER_URGENT_SHARE_RATE = 0.6;

// =========================
// 系統狀態（V2.5 先用記憶體）
// =========================
let taskCounter = 1;

// 所有任務
// taskId -> task
const tasks = new Map();

// 使用者目前模式
// userId -> { mode: 'create' | 'quote' }
const userModes = new Map();

// 群組內等待 ETA
// riderUserId -> { taskId }
const pendingEta = new Map();

// =========================
// 工具函式
// =========================
function toText(value) {
  return String(value || '').trim();
}

function formatMoney(num) {
  return `$${Math.round(Number(num) || 0)}`;
}

function createTaskId() {
  const id = String(taskCounter).padStart(4, '0');
  taskCounter += 1;
  return id;
}

function getDistrict(address = '') {
  const text = toText(address);
  const match = text.match(/(豐原區|潭子區|神岡區|大雅區|北屯區|西屯區|西區|南屯區|南區|東區|北區|中區|太平區|大里區|烏日區|清水區|沙鹿區|梧棲區|龍井區|大肚區|后里區|石岡區|新社區|和平區|霧峰區|大安區|外埔區|東勢區)/);
  if (match) return match[1];

  const fallback = text.match(/(.{1,6}[區鄉鎮市])/);
  return fallback ? fallback[1] : '';
}

function isCrossDistrict(fromAddress, toAddress) {
  const fromDistrict = getDistrict(fromAddress);
  const toDistrict = getDistrict(toAddress);

  if (!fromDistrict || !toDistrict) return false;
  return fromDistrict !== toDistrict;
}

function isUrgentText(text) {
  const t = toText(text);
  return t.includes('急件');
}

function buildTaskGuide(mode = 'create') {
  if (mode === 'quote') {
    return `請直接貼上以下格式，我會立即幫您估價：

取件地點：
取件電話：

送達地點：
送達電話：

物品內容：
是否急件（一般 / 急件）：
備註：`;
  }

  return `請直接貼上以下格式，我會為您建立任務並立即報價：

取件地點：
取件電話：

送達地點：
送達電話：

物品內容：
是否急件（一般 / 急件）：
備註：`;
}

function parseTaskForm(text) {
  const lines = String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const data = {
    pickupAddress: '',
    pickupPhone: '',
    deliveryAddress: '',
    deliveryPhone: '',
    item: '',
    urgency: '',
    note: '',
  };

  for (const line of lines) {
    if (line.startsWith('取件地點：')) {
      data.pickupAddress = toText(line.replace('取件地點：', ''));
    } else if (line.startsWith('取件電話：')) {
      data.pickupPhone = toText(line.replace('取件電話：', ''));
    } else if (line.startsWith('送達地點：')) {
      data.deliveryAddress = toText(line.replace('送達地點：', ''));
    } else if (line.startsWith('送達電話：')) {
      data.deliveryPhone = toText(line.replace('送達電話：', ''));
    } else if (line.startsWith('物品內容：')) {
      data.item = toText(line.replace('物品內容：', ''));
    } else if (line.startsWith('是否急件')) {
      const parts = line.split('：');
      data.urgency = toText(parts.slice(1).join('：'));
    } else if (line.startsWith('備註：')) {
      data.note = toText(line.replace('備註：', ''));
    }
  }

  const isComplete =
    data.pickupAddress &&
    data.pickupPhone &&
    data.deliveryAddress &&
    data.deliveryPhone &&
    data.item &&
    data.urgency;

  return { isComplete, data };
}

async function getDistanceAndDuration(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY 未設定');
  }

  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(destination)}` +
    `&language=zh-TW&region=tw&key=${GOOGLE_MAPS_API_KEY}`;

  const response = await fetch(url);
  const json = await response.json();

  if (
    !json ||
    !json.rows ||
    !json.rows[0] ||
    !json.rows[0].elements ||
    !json.rows[0].elements[0]
  ) {
    throw new Error('Google Maps 回傳資料異常');
  }

  const element = json.rows[0].elements[0];

  if (element.status !== 'OK') {
    throw new Error(`Google Maps 無法取得距離資料：${element.status}`);
  }

  const distanceMeters = element.distance.value;
  const durationSeconds = element.duration.value;

  const km = Math.ceil(distanceMeters / 1000);
  const minutes = Math.ceil(durationSeconds / 60);

  return {
    km,
    minutes,
    distanceText: element.distance.text,
    durationText: element.duration.text,
  };
}

function calculateFees({ km, minutes, urgent, crossDistrict }) {
  const distanceFee = km * PER_KM_FEE;
  const timeFee = minutes * PER_MIN_FEE;
  const crossFee = crossDistrict ? CROSS_DISTRICT_FEE : 0;
  const urgentFee = urgent ? URGENT_FEE : 0;

  // 客人看的配送費
  const deliveryFee = Math.round(
    BASE_FEE +
    distanceFee +
    timeFee +
    crossFee +
    urgentFee +
    SERVICE_FEE
  );

  const total = deliveryFee + FIXED_TAX;

  // 騎手實拿
  const riderFee = Math.round(
    BASE_FEE +
    distanceFee +
    timeFee +
    crossFee +
    (urgent ? URGENT_FEE * RIDER_URGENT_SHARE_RATE : 0)
  );

  return {
    baseFee: BASE_FEE,
    distanceFee,
    timeFee,
    crossFee,
    urgentFee,
    serviceFee: SERVICE_FEE,
    tax: FIXED_TAX,
    deliveryFee,
    total,
    riderFee,
  };
}

function buildQuoteMessage(task) {
  return `已為您完成報價 ✅

配送費：${formatMoney(task.fees.deliveryFee)}
稅金：${formatMoney(task.fees.tax)}
總計：${formatMoney(task.fees.total)}

若確認要安排，可直接再輸入「建立任務」並貼上完整資料。`;
}

function buildTaskCreatedMessage(task) {
  return `您的任務已建立成功 ✅

配送費：${formatMoney(task.fees.deliveryFee)}
稅金：${formatMoney(task.fees.tax)}
總計：${formatMoney(task.fees.total)}

我們會立即為您派單。`;
}

function buildGroupTaskMessage(task) {
  return `📦 UBee 新任務通知

費用：${formatMoney(task.fees.riderFee)}
距離：${task.km} 公里

取件：${task.pickupAddress}
送達：${task.deliveryAddress}
物品：${task.item}
急件：${task.urgent ? '急件' : '一般'}`;
}

function buildCustomerStatusMessage(type, eta = null) {
  switch (type) {
    case 'accepted':
      return `✅ 已有人接單
⏱ 預計 ${eta} 分鐘抵達取件地點`;

    case 'arrived':
      return '✅ 騎手已抵達取件地點';

    case 'picked':
      return '✅ 騎手已完成取件，正前往送達地點';

    case 'delivered':
      return '✅ 物品已送達';

    case 'completed':
      return `✅ 任務已完成

感謝您使用 UBee 城市任務跑腿服務。
期待再次為您服務。`;

    default:
      return '任務狀態已更新';
  }
}

function getLatestBroadcastedTask() {
  const list = Array.from(tasks.values())
    .filter(task => task.status === 'broadcasted' && !task.assignedRiderId)
    .sort((a, b) => b.createdAt - a.createdAt);

  return list[0] || null;
}

function getLatestActiveTaskByRider(riderUserId) {
  const list = Array.from(tasks.values())
    .filter(task =>
      task.assignedRiderId === riderUserId &&
      ['accepted', 'arrived', 'picked', 'delivered'].includes(task.status)
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  return list[0] || null;
}

function getLatestCompletedTaskByCustomer(customerUserId) {
  const list = Array.from(tasks.values())
    .filter(task => task.customerUserId === customerUserId && task.status === 'completed')
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

  return list[0] || null;
}

async function replyText(replyToken, text) {
  return client.replyMessage(replyToken, [
    {
      type: 'text',
      text,
    },
  ]);
}

async function pushText(to, text) {
  if (!to) return;
  return client.pushMessage(to, [
    {
      type: 'text',
      text,
    },
  ]);
}

async function getGroupMemberName(groupId, userId) {
  try {
    const profile = await client.getGroupMemberProfile(groupId, userId);
    return profile.displayName || '騎手';
  } catch (error) {
    console.warn('⚠️ 無法取得群組成員名稱:', error.message);
    return '騎手';
  }
}

// =========================
// 客戶端流程
// =========================
async function handleCustomerCommand(event, text) {
  const userId = event.source.userId;

  if (text === '建立任務') {
    userModes.set(userId, { mode: 'create' });
    await replyText(event.replyToken, buildTaskGuide('create'));
    return true;
  }

  if (text === '立即估價') {
    userModes.set(userId, { mode: 'quote' });
    await replyText(event.replyToken, buildTaskGuide('quote'));
    return true;
  }

  return false;
}

async function handleCustomerForm(event, text) {
  const userId = event.source.userId;
  const modeInfo = userModes.get(userId);

  if (!modeInfo) return false;

  const parsed = parseTaskForm(text);

  if (!parsed.isComplete) {
    await replyText(
      event.replyToken,
      `資料格式不完整，請依照以下格式填寫：

${buildTaskGuide(modeInfo.mode)}`
    );
    return true;
  }

  try {
    const form = parsed.data;
    const mapData = await getDistanceAndDuration(form.pickupAddress, form.deliveryAddress);
    const urgent = isUrgentText(form.urgency);
    const crossDistrict = isCrossDistrict(form.pickupAddress, form.deliveryAddress);
    const fees = calculateFees({
      km: mapData.km,
      minutes: mapData.minutes,
      urgent,
      crossDistrict,
    });

    // 只估價，不建立任務
    if (modeInfo.mode === 'quote') {
      const tempTask = {
        pickupAddress: form.pickupAddress,
        pickupPhone: form.pickupPhone,
        deliveryAddress: form.deliveryAddress,
        deliveryPhone: form.deliveryPhone,
        item: form.item,
        note: form.note || '無',
        urgent,
        km: mapData.km,
        minutes: mapData.minutes,
        fees,
      };

      userModes.delete(userId);
      await replyText(event.replyToken, buildQuoteMessage(tempTask));
      return true;
    }

    // 建立正式任務
    const taskId = createTaskId();

    const task = {
      taskId,
      customerUserId: userId,
      pickupAddress: form.pickupAddress,
      pickupPhone: form.pickupPhone,
      deliveryAddress: form.deliveryAddress,
      deliveryPhone: form.deliveryPhone,
      item: form.item,
      note: form.note || '無',
      urgent,
      km: mapData.km,
      minutes: mapData.minutes,
      distanceText: mapData.distanceText,
      durationText: mapData.durationText,
      fees,
      status: 'created',
      createdAt: Date.now(),
      assignedRiderId: null,
      assignedRiderName: null,
      etaMinutes: null,
      completedAt: null,
    };

    tasks.set(taskId, task);
    userModes.delete(userId);

    await replyText(event.replyToken, buildTaskCreatedMessage(task));

    if (!LINE_GROUP_ID) {
      console.warn('⚠️ LINE_GROUP_ID 未設定，任務無法派到群組');
      return true;
    }

    await pushText(LINE_GROUP_ID, buildGroupTaskMessage(task));
    task.status = 'broadcasted';

    return true;
  } catch (error) {
    console.error('❌ 客戶表單處理失敗:', error.message);
    userModes.delete(userId);

    await replyText(
      event.replyToken,
      '系統暫時無法完成報價，請稍後再試一次。'
    );
    return true;
  }
}

async function handleCustomerAfterCompleted(event, text) {
  const userId = event.source.userId;
  const task = getLatestCompletedTaskByCustomer(userId);

  if (!task) return false;

  if (/^(謝謝|感謝|thanks|thank you|3q)$/i.test(text)) {
    await replyText(
      event.replyToken,
      '不客氣，感謝您使用 UBee，期待下次再為您服務。'
    );
    return true;
  }

  return false;
}

// =========================
// 群組端流程
// =========================
async function acceptTask(event, task, etaMinutes) {
  if (!task) {
    await replyText(event.replyToken, '目前沒有可接的任務。');
    return true;
  }

  if (task.assignedRiderId || task.status !== 'broadcasted') {
    await replyText(event.replyToken, '此任務已被其他騎手接走。');
    return true;
  }

  const groupId = event.source.groupId;
  const riderUserId = event.source.userId;
  const riderName = await getGroupMemberName(groupId, riderUserId);

  task.assignedRiderId = riderUserId;
  task.assignedRiderName = riderName;
  task.etaMinutes = etaMinutes;
  task.status = 'accepted';

  await replyText(
    event.replyToken,
    `✅ 接單成功
⏱ ETA ${etaMinutes} 分鐘`
  );

  await pushText(
    task.customerUserId,
    buildCustomerStatusMessage('accepted', etaMinutes)
  );

  return true;
}

async function handleGroupAccept(event, text) {
  // 直接：接單 8
  const match = text.match(/^接單\s*(\d{1,3})$/);
  if (match) {
    const eta = parseInt(match[1], 10);
    const task = getLatestBroadcastedTask();
    return acceptTask(event, task, eta);
  }

  // 先打：接
  if (text === '接') {
    const task = getLatestBroadcastedTask();

    if (!task) {
      await replyText(event.replyToken, '目前沒有可接的任務。');
      return true;
    }

    pendingEta.set(event.source.userId, { taskId: task.taskId });
    await replyText(event.replyToken, '請輸入幾分鐘可抵達取件地點，例如：8');
    return true;
  }

  // 上一步輸入接後，只打數字
  if (/^\d{1,3}$/.test(text)) {
    const pending = pendingEta.get(event.source.userId);
    if (!pending) return false;

    pendingEta.delete(event.source.userId);

    const task = tasks.get(pending.taskId);
    if (!task || task.assignedRiderId || task.status !== 'broadcasted') {
      await replyText(event.replyToken, '此任務目前已不可接單。');
      return true;
    }

    const eta = parseInt(text, 10);
    return acceptTask(event, task, eta);
  }

  return false;
}

async function handleGroupStatus(event, text) {
  const riderUserId = event.source.userId;
  const task = getLatestActiveTaskByRider(riderUserId);

  if (!task) return false;

  if (text === '已抵達') {
    task.status = 'arrived';
    await replyText(event.replyToken, '✅ 已回報：抵達取件地點');
    await pushText(task.customerUserId, buildCustomerStatusMessage('arrived'));
    return true;
  }

  if (text === '已取件') {
    task.status = 'picked';
    await replyText(event.replyToken, '✅ 已回報：完成取件');
    await pushText(task.customerUserId, buildCustomerStatusMessage('picked'));
    return true;
  }

  if (text === '已送達') {
    task.status = 'delivered';
    await replyText(event.replyToken, '✅ 已回報：物品已送達');
    await pushText(task.customerUserId, buildCustomerStatusMessage('delivered'));
    return true;
  }

  if (text === '已完成') {
    task.status = 'completed';
    task.completedAt = Date.now();

    await replyText(event.replyToken, '✅ 已回報：任務完成');
    await pushText(task.customerUserId, buildCustomerStatusMessage('completed'));
    return true;
  }

  return false;
}

// =========================
// help 指令
// =========================
async function handleHelp(event, text) {
  if (!['help', '幫助', '功能'].includes(text)) return false;

  if (event.source.type === 'group') {
    await replyText(
      event.replyToken,
      `群組可用指令：

接單 8
接
已抵達
已取件
已送達
已完成`
    );
    return true;
  }

  await replyText(
    event.replyToken,
    `您可以使用以下功能：

建立任務
立即估價`
  );
  return true;
}

// =========================
// 主事件處理
// =========================
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const text = toText(event.message.text);

  // 群組
  if (event.source.type === 'group') {
    if (await handleHelp(event, text)) return;
    if (await handleGroupAccept(event, text)) return;
    if (await handleGroupStatus(event, text)) return;
    return;
  }

  // 1 對 1 客戶
  if (await handleHelp(event, text)) return;
  if (await handleCustomerCommand(event, text)) return;
  if (await handleCustomerForm(event, text)) return;
  if (await handleCustomerAfterCompleted(event, text)) return;

  await replyText(
    event.replyToken,
    '請輸入「建立任務」或「立即估價」。'
  );
}

// =========================
// 路由
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee bot v2.5 running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Webhook Error:', error);
    res.status(500).send('Webhook Error');
  }
});

// =========================
// 啟動
// =========================
app.listen(PORT, () => {
  console.log(`✅ UBee V2.5 running on port ${PORT}`);
});
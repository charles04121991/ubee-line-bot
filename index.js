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

// ====== 費率設定 ======
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const URGENT_FEE = 100;
const SERVICE_FEE = 50;
const TAX_FEE = 15;

// 騎手分潤：任務費 * 0.6
const RIDER_SHARE_RATIO = 0.6;

// ====== 系統資料 ======
const userSessions = new Map();      // userId -> session
const tasks = new Map();             // taskId -> task
const riderPendingEta = new Map();   // riderUserId -> { taskId, riderUserId, riderName }

let taskCounter = 1;

// ====== 健康檢查 ======
app.get('/', (req, res) => {
  res.status(200).send('UBee bot v2 running');
});

// ====== LINE Webhook ======
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log(`✅ UBee bot v2 listening on port ${PORT}`);
});

// =====================================================
// 主事件處理
// =====================================================
async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') {
      return null;
    }

    const text = (event.message.text || '').trim();
    const sourceType = event.source.type;
    const userId = event.source.userId || '';
    const replyToken = event.replyToken;

    if (sourceType === 'group') {
      return await handleGroupMessage(event, text, replyToken);
    }

    if (sourceType === 'user') {
      return await handleUserMessage(event, text, userId, replyToken);
    }

    return null;
  } catch (err) {
    console.error('❌ handleEvent error:', err);
    return null;
  }
}

// =====================================================
// 使用者私訊流程
// =====================================================
async function handleUserMessage(event, text, userId, replyToken) {
  const normalized = normalizeText(text);
  const session = userSessions.get(userId) || {};

  if (isThanksMessage(normalized)) {
    await replyText(
      replyToken,
      `不客氣 🙌\n\n感謝您使用 UBee 城市任務跑腿服務。\n期待再次為您服務。`
    );
    return;
  }

  if (normalized === '建立任務') {
    userSessions.set(userId, { mode: 'awaiting_task_form' });

    await replyText(
      replyToken,
      `請直接複製以下格式填寫並回傳：\n\n` +
      `取件地點：\n` +
      `取件電話：\n\n` +
      `送達地點：\n` +
      `送達電話：\n\n` +
      `物品內容：\n` +
      `是否急件：一般\n` +
      `備註：無\n\n` +
      `※ 不配送食品、違禁品、危險物品`
    );
    return;
  }

  if (normalized === '立即估價') {
    userSessions.set(userId, { mode: 'awaiting_quote_form' });

    await replyText(
      replyToken,
      `請直接複製以下格式填寫並回傳，我們會立即幫您估價：\n\n` +
      `取件地點：\n` +
      `送達地點：\n` +
      `物品內容：\n` +
      `是否急件：一般\n\n` +
      `※ 不配送食品、違禁品、危險物品`
    );
    return;
  }

  if (session.mode === 'awaiting_task_form') {
    const parsed = parseTaskForm(text);

    if (!parsed.ok) {
      await replyText(
        replyToken,
        `資料格式不完整，請依以下格式重新填寫：\n\n` +
        `取件地點：\n` +
        `取件電話：\n\n` +
        `送達地點：\n` +
        `送達電話：\n\n` +
        `物品內容：\n` +
        `是否急件：一般\n` +
        `備註：無`
      );
      return;
    }

    if (!GOOGLE_MAPS_API_KEY) {
      await replyText(replyToken, '❌ 系統尚未設定 GOOGLE_MAPS_API_KEY');
      return;
    }

    try {
      const quote = await getQuoteFromGoogleMaps(
        parsed.data.pickupAddress,
        parsed.data.deliveryAddress,
        parsed.data.isUrgent
      );

      const taskId = generateTaskId();

      const task = {
        id: taskId,
        customerLineUserId: userId,

        pickupAddress: parsed.data.pickupAddress,
        pickupPhone: parsed.data.pickupPhone,
        deliveryAddress: parsed.data.deliveryAddress,
        deliveryPhone: parsed.data.deliveryPhone,
        itemContent: parsed.data.itemContent,
        isUrgent: parsed.data.isUrgent,
        note: parsed.data.note || '無',

        distanceKm: quote.distanceKm,
        durationMin: quote.durationMin,

        baseFee: quote.baseFee,
        distanceFee: quote.distanceFee,
        timeFee: quote.timeFee,
        crossDistrictFee: quote.crossDistrictFee,
        urgentFee: quote.urgentFee,
        taskFee: quote.taskFee,
        serviceFee: quote.serviceFee,
        subtotal: quote.subtotal,
        taxFee: quote.taxFee,
        totalFee: quote.totalFee,
        riderFee: quote.riderFee,

        status: 'pending_dispatch',
        assignedRiderName: '',
        assignedRiderUserId: '',
        etaToPickupMin: null,

        createdAt: new Date().toISOString(),
      };

      tasks.set(taskId, task);
      userSessions.delete(userId);

      await replyText(
        replyToken,
        `✅ 您的任務已建立成功，我們會立即為您派單。\n\n` +
        `【本次報價】\n` +
        `任務費：$${task.taskFee}\n` +
        `服務費：$${task.serviceFee}\n` +
        `小計：$${task.subtotal}\n` +
        `稅金：$${task.taxFee}\n` +
        `總計：$${task.totalFee}`
      );

      await pushDispatchToGroup(task);
      return;
    } catch (err) {
      console.error('❌ 建立任務報價失敗:', err);
      await replyText(replyToken, '❌ 目前無法取得距離與報價，請稍後再試。');
      return;
    }
  }

  if (session.mode === 'awaiting_quote_form') {
    const parsed = parseQuoteForm(text);

    if (!parsed.ok) {
      await replyText(
        replyToken,
        `資料格式不完整，請依以下格式重新填寫：\n\n` +
        `取件地點：\n` +
        `送達地點：\n` +
        `物品內容：\n` +
        `是否急件：一般`
      );
      return;
    }

    if (!GOOGLE_MAPS_API_KEY) {
      await replyText(replyToken, '❌ 系統尚未設定 GOOGLE_MAPS_API_KEY');
      return;
    }

    try {
      const quote = await getQuoteFromGoogleMaps(
        parsed.data.pickupAddress,
        parsed.data.deliveryAddress,
        parsed.data.isUrgent
      );

      userSessions.delete(userId);

      await replyText(
        replyToken,
        `【立即估價結果】\n` +
        `任務費：$${quote.taskFee}\n` +
        `服務費：$${quote.serviceFee}\n` +
        `小計：$${quote.subtotal}\n` +
        `稅金：$${quote.taxFee}\n` +
        `總計：$${quote.totalFee}`
      );
      return;
    } catch (err) {
      console.error('❌ 立即估價失敗:', err);
      await replyText(replyToken, '❌ 目前無法取得距離與報價，請稍後再試。');
      return;
    }
  }

  await replyText(
    replyToken,
    `您好，歡迎使用 UBee 城市任務服務。\n\n請輸入以下指令：\n1. 建立任務\n2. 立即估價`
  );
}

// =====================================================
// 群組流程
// =====================================================
async function handleGroupMessage(event, text, replyToken) {
  const normalized = normalizeText(text);
  const riderUserId = event.source.userId || '';
  const riderName = await getDisplayNameSafe(event);

  // 第一段：騎手表達要接單
  if (
    normalized === '接' ||
    normalized === '+1' ||
    normalized === '＋1' ||
    normalized === '接單'
  ) {
    const pendingTask = findLatestPendingTask();

    if (!pendingTask) {
      await replyText(replyToken, '目前沒有可接任務。');
      return;
    }

    if (pendingTask.status !== 'pending_dispatch') {
      await replyText(replyToken, '此任務已有人接單或正在確認中。');
      return;
    }

    pendingTask.status = 'awaiting_eta';
    pendingTask.assignedRiderUserId = riderUserId;
    pendingTask.assignedRiderName = riderName || '騎手';
    tasks.set(pendingTask.id, pendingTask);

    riderPendingEta.set(riderUserId, {
      taskId: pendingTask.id,
      riderUserId,
      riderName: riderName || '騎手',
    });

    await replyText(
      replyToken,
      `✅ 已收到接單\n請回覆幾分鐘會到取件地點\n例如：8`
    );

    await pushText(
      pendingTask.customerLineUserId,
      `✅ 已有夥伴正在確認接單中，稍後回覆您預計抵達時間。`
    );
    return;
  }

  // 第二段：騎手輸入 ETA 數字
  if (/^\d{1,3}$/.test(normalized)) {
    const pendingEtaRecord = riderPendingEta.get(riderUserId);

    if (!pendingEtaRecord) {
      return null;
    }

    const task = tasks.get(pendingEtaRecord.taskId);

    if (!task) {
      riderPendingEta.delete(riderUserId);
      await replyText(replyToken, '找不到對應任務，請重新接單。');
      return;
    }

    if (task.status !== 'awaiting_eta') {
      riderPendingEta.delete(riderUserId);
      await replyText(replyToken, '此任務目前無法更新 ETA。');
      return;
    }

    const eta = parseInt(normalized, 10);

    task.status = 'accepted';
    task.etaToPickupMin = eta;
    task.assignedRiderUserId = riderUserId;
    task.assignedRiderName = pendingEtaRecord.riderName;
    tasks.set(task.id, task);

    riderPendingEta.delete(riderUserId);

    await replyText(
      replyToken,
      `✅ 此任務已由 ${task.assignedRiderName} 接單\n⏱ 預計 ${task.etaToPickupMin} 分鐘抵達取件地點`
    );

    await pushText(
      task.customerLineUserId,
      `✅ 已有夥伴為您接單\n⏱ 預計 ${task.etaToPickupMin} 分鐘抵達取件地點`
    );
    return;
  }

  if (normalized === '已抵達') {
    const task = findLatestAcceptedTaskByRider(riderUserId);
    if (!task) {
      await replyText(replyToken, '找不到您目前進行中的任務。');
      return;
    }

    task.status = 'arrived_pickup';
    tasks.set(task.id, task);

    await replyText(replyToken, '✅ 已回報抵達取件地點');
    await pushText(task.customerLineUserId, '✅ 夥伴已抵達取件地點，準備取件。');
    return;
  }

  if (normalized === '已取件') {
    const task = findLatestTaskByRiderForProgress(riderUserId);
    if (!task) {
      await replyText(replyToken, '找不到您目前進行中的任務。');
      return;
    }

    task.status = 'picked_up';
    tasks.set(task.id, task);

    await replyText(replyToken, '✅ 已回報取件完成');
    await pushText(task.customerLineUserId, '✅ 您的物品已取件，正前往送達地點。');
    return;
  }

  if (normalized === '已送達' || normalized === '已完成') {
    const task = findLatestTaskByRiderForProgress(riderUserId);
    if (!task) {
      await replyText(replyToken, '找不到您目前進行中的任務。');
      return;
    }

    task.status = 'completed';
    tasks.set(task.id, task);

    await replyText(replyToken, '✅ 已回報任務完成');

    await pushText(
      task.customerLineUserId,
      `✅ 已抵達目的地，任務已完成。\n\n` +
      `感謝您使用 UBee 城市任務跑腿服務。\n` +
      `期待再次為您服務。\n\n` +
      `若您願意，歡迎至我們的粉絲專頁留下使用心得，\n` +
      `您的支持與回饋對我們非常重要。\n\n` +
      `Facebook：\n` +
      `https://www.facebook.com/profile.php?id=61584959752879`
    );
    return;
  }

  return null;
}

// =====================================================
// 派單到群組
// =====================================================
async function pushDispatchToGroup(task) {
  if (!LINE_GROUP_ID) {
    console.warn('⚠️ LINE_GROUP_ID 未設定，無法派單到群組');
    return;
  }

  const urgentText = task.isUrgent ? '急件' : '一般';

  const message =
    `📦 UBee 新任務通知\n\n` +
    `費用：$${task.riderFee}\n` +
    `距離：${task.distanceKm} 公里\n\n` +
    `取件：${task.pickupAddress}\n` +
    `送達：${task.deliveryAddress}\n` +
    `物品：${task.itemContent}\n` +
    `急件：${urgentText}`;

  await pushText(LINE_GROUP_ID, message);
}

// =====================================================
// Google Maps 報價
// =====================================================
async function getQuoteFromGoogleMaps(origin, destination, isUrgent) {
  const matrixUrl =
    `https://maps.googleapis.com/maps/api/distancematrix/json?` +
    `origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(destination)}` +
    `&mode=driving&language=zh-TW&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(matrixUrl);
  const data = await res.json();

  if (data.status !== 'OK') {
    console.error('❌ Google Maps API error:', data);
    throw new Error('Google Maps API error');
  }

  const row = data.rows && data.rows[0];
  const element = row && row.elements && row.elements[0];

  if (!element || element.status !== 'OK') {
    console.error('❌ Distance Matrix element error:', element);
    throw new Error('無法取得距離與時間');
  }

  const meters = element.distance.value || 0;
  const seconds = element.duration.value || 0;

  const distanceKm = Math.ceil((meters / 1000) * 10) / 10;
  const durationMin = Math.ceil(seconds / 60);

  const crossDistrictFee = isCrossDistrict(origin, destination) ? CROSS_DISTRICT_FEE : 0;
  const urgentFee = isUrgent ? URGENT_FEE : 0;

  const distanceFee = Math.ceil(distanceKm * PER_KM_FEE);
  const timeFee = Math.ceil(durationMin * PER_MIN_FEE);

  const taskFee = BASE_FEE + distanceFee + timeFee + crossDistrictFee + urgentFee;
  const serviceFee = SERVICE_FEE;
  const subtotal = taskFee + serviceFee;
  const taxFee = TAX_FEE;
  const totalFee = subtotal + taxFee;

  const riderFee = Math.round(taskFee * RIDER_SHARE_RATIO);

  return {
    distanceKm,
    durationMin,
    baseFee: BASE_FEE,
    distanceFee,
    timeFee,
    crossDistrictFee,
    urgentFee,
    taskFee,
    serviceFee,
    subtotal,
    taxFee,
    totalFee,
    riderFee,
  };
}

// =====================================================
// 表單解析
// =====================================================
function parseTaskForm(text) {
  const pickupAddress = matchField(text, '取件地點');
  const pickupPhone = matchField(text, '取件電話');
  const deliveryAddress = matchField(text, '送達地點');
  const deliveryPhone = matchField(text, '送達電話');
  const itemContent = matchField(text, '物品內容');
  const urgentRaw = matchField(text, '是否急件');
  const note = matchField(text, '備註') || '無';

  const required = [
    pickupAddress,
    pickupPhone,
    deliveryAddress,
    deliveryPhone,
    itemContent,
    urgentRaw,
  ];

  if (required.some(v => !v)) {
    return { ok: false };
  }

  return {
    ok: true,
    data: {
      pickupAddress,
      pickupPhone,
      deliveryAddress,
      deliveryPhone,
      itemContent,
      isUrgent: parseUrgent(urgentRaw),
      note,
    },
  };
}

function parseQuoteForm(text) {
  const pickupAddress = matchField(text, '取件地點');
  const deliveryAddress = matchField(text, '送達地點');
  const itemContent = matchField(text, '物品內容');
  const urgentRaw = matchField(text, '是否急件');

  const required = [pickupAddress, deliveryAddress, itemContent, urgentRaw];

  if (required.some(v => !v)) {
    return { ok: false };
  }

  return {
    ok: true,
    data: {
      pickupAddress,
      deliveryAddress,
      itemContent,
      isUrgent: parseUrgent(urgentRaw),
    },
  };
}

function matchField(text, label) {
  const regex = new RegExp(`${label}\\s*[：:]\\s*(.+)`);
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

function parseUrgent(value) {
  const v = normalizeText(value);
  return v.includes('急件');
}

// =====================================================
// 工具函式
// =====================================================
function generateTaskId() {
  const id = `TASK${String(taskCounter).padStart(6, '0')}`;
  taskCounter += 1;
  return id;
}

function normalizeText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/　/g, ' ');
}

function isThanksMessage(text) {
  const t = text.toLowerCase();
  return [
    '謝謝',
    '感謝',
    'thanks',
    'thank you',
    'thankyou',
    '3q',
    '謝啦',
    '感恩',
  ].includes(t);
}

function getDistrict(address) {
  const districts = [
    '中區', '東區', '西區', '南區', '北區',
    '北屯區', '西屯區', '南屯區',
    '太平區', '大里區', '霧峰區', '烏日區',
    '豐原區', '后里區', '石岡區', '東勢區', '和平區',
    '新社區', '潭子區', '大雅區', '神岡區',
    '大肚區', '沙鹿區', '龍井區', '梧棲區', '清水區',
    '大甲區', '外埔區', '大安區'
  ];

  for (const d of districts) {
    if (address.includes(d)) return d;
  }
  return '';
}

function isCrossDistrict(origin, destination) {
  const d1 = getDistrict(origin);
  const d2 = getDistrict(destination);
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

async function getDisplayNameSafe(event) {
  try {
    const source = event.source || {};
    const userId = source.userId || '';

    if (!userId) return '騎手';

    if (source.type === 'group' && source.groupId) {
      const profile = await client.getGroupMemberProfile(source.groupId, userId);
      return profile.displayName || '騎手';
    }

    if (source.type === 'room' && source.roomId) {
      const profile = await client.getRoomMemberProfile(source.roomId, userId);
      return profile.displayName || '騎手';
    }

    const profile = await client.getProfile(userId);
    return profile.displayName || '騎手';
  } catch (err) {
    return '騎手';
  }
}

function findLatestPendingTask() {
  const allTasks = Array.from(tasks.values())
    .filter(t => t.status === 'pending_dispatch')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return allTasks[0] || null;
}

function findLatestAcceptedTaskByRider(riderUserId) {
  const allTasks = Array.from(tasks.values())
    .filter(t => t.assignedRiderUserId === riderUserId && t.status === 'accepted')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return allTasks[0] || null;
}

function findLatestTaskByRiderForProgress(riderUserId) {
  const allowedStatuses = ['accepted', 'arrived_pickup', 'picked_up'];

  const allTasks = Array.from(tasks.values())
    .filter(t => t.assignedRiderUserId === riderUserId && allowedStatuses.includes(t.status))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return allTasks[0] || null;
}

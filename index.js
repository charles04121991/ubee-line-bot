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

// ===== 費率設定 =====
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const URGENT_FEE = 100;
const SERVICE_FEE = 50;
const FIXED_TAX = 15;

// 騎手急件分潤比例（急件費 60% 給騎手）
const RIDER_URGENT_SHARE_RATE = 0.6;

// ===== 記憶體資料 =====
const tasks = new Map(); // taskId -> task
const userModes = new Map(); // userId -> { mode: 'create' | 'quote' }
const pendingGroupEta = new Map(); // groupUserId -> { taskId }
let taskSeq = 1;

// ===== 基本工具 =====
function round(num) {
  return Math.round(Number(num) || 0);
}

function safeText(text) {
  return (text || '').trim();
}

function getSourceId(event) {
  if (!event || !event.source) return '';
  return event.source.userId || event.source.groupId || event.source.roomId || '';
}

function getDistrict(address = '') {
  const match = address.match(/(.{1,6}[區鄉鎮市])/);
  return match ? match[1] : '';
}

function isCrossDistrict(from, to) {
  const a = getDistrict(from);
  const b = getDistrict(to);
  if (!a || !b) return false;
  return a !== b;
}

function createTaskId() {
  const id = String(taskSeq).padStart(4, '0');
  taskSeq += 1;
  return id;
}

function getLatestOpenTask() {
  const arr = Array.from(tasks.values())
    .filter(t => t.status === 'broadcasted' && !t.assignedRiderId)
    .sort((a, b) => b.createdAt - a.createdAt);
  return arr[0] || null;
}

function formatCurrency(num) {
  return `$${round(num)}`;
}

function buildCustomerGuide(type = 'create') {
  const title = type === 'quote' ? '請直接貼上以下格式，我會立即幫您估價：' : '請直接貼上以下格式，我會為您建立任務並立即報價：';

  return `${title}

取件地點：
取件電話：

送達地點：
送達電話：

物品內容：
是否急件（一般 / 急件）：
備註：`;
}

function parseTaskForm(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);

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
    if (line.startsWith('取件地點：')) data.pickupAddress = safeText(line.replace('取件地點：', ''));
    else if (line.startsWith('取件電話：')) data.pickupPhone = safeText(line.replace('取件電話：', ''));
    else if (line.startsWith('送達地點：')) data.deliveryAddress = safeText(line.replace('送達地點：', ''));
    else if (line.startsWith('送達電話：')) data.deliveryPhone = safeText(line.replace('送達電話：', ''));
    else if (line.startsWith('物品內容：')) data.item = safeText(line.replace('物品內容：', ''));
    else if (line.startsWith('是否急件')) {
      const parts = line.split('：');
      data.urgency = safeText(parts.slice(1).join('：'));
    } else if (line.startsWith('備註：')) data.note = safeText(line.replace('備註：', ''));
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

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&language=zh-TW&region=tw&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(url);
  const json = await res.json();

  if (
    !json.rows ||
    !json.rows[0] ||
    !json.rows[0].elements ||
    !json.rows[0].elements[0] ||
    json.rows[0].elements[0].status !== 'OK'
  ) {
    throw new Error('Google Maps 無法取得距離資料');
  }

  const element = json.rows[0].elements[0];
  const distanceMeters = element.distance.value;
  const durationSeconds = element.duration.value;

  const km = distanceMeters / 1000;
  const minutes = durationSeconds / 60;

  return {
    km: Math.ceil(km),
    minutes: Math.ceil(minutes),
    distanceText: element.distance.text,
    durationText: element.duration.text,
  };
}

function calculateFees({ km, minutes, isUrgent, crossDistrict }) {
  const basePart = BASE_FEE;
  const kmPart = km * PER_KM_FEE;
  const minPart = minutes * PER_MIN_FEE;
  const crossPart = crossDistrict ? CROSS_DISTRICT_FEE : 0;
  const urgentPart = isUrgent ? URGENT_FEE : 0;

  const riderFee = round(
    basePart +
    kmPart +
    minPart +
    crossPart +
    (isUrgent ? URGENT_FEE * RIDER_URGENT_SHARE_RATE : 0)
  );

  const deliveryFee = round(
    basePart +
    kmPart +
    minPart +
    crossPart +
    urgentPart +
    SERVICE_FEE
  );

  const total = round(deliveryFee + FIXED_TAX);

  return {
    basePart,
    kmPart,
    minPart,
    crossPart,
    urgentPart,
    riderFee,
    deliveryFee,
    tax: FIXED_TAX,
    total,
  };
}

function buildCustomerQuoteMessage(task) {
  return `已為您完成報價 ✅

配送費：${formatCurrency(task.fees.deliveryFee)}
稅金：${formatCurrency(task.fees.tax)}
總計：${formatCurrency(task.fees.total)}

若確認要安排，系統將立即為您派單。`;
}

function buildCustomerTaskCreatedMessage(task) {
  return `您的任務已建立成功 ✅

配送費：${formatCurrency(task.fees.deliveryFee)}
稅金：${formatCurrency(task.fees.tax)}
總計：${formatCurrency(task.fees.total)}

我們會立即為您派單。`;
}

function buildGroupTaskMessage(task) {
  return `📦 UBee 新任務通知

費用：${formatCurrency(task.fees.riderFee)}
距離：${task.km} 公里

取件：${task.pickupAddress}
送達：${task.deliveryAddress}
物品：${task.item}
急件：${task.isUrgent ? '急件' : '一般'}`;
}

function buildStatusMessage(status, extra = '') {
  const base = {
    accepted: `✅ 已有人接單\n⏱ 預計 ${extra} 分鐘抵達取件地點`,
    arrived: '✅ 騎手已抵達取件地點',
    picked: '✅ 騎手已完成取件，正前往送達地點',
    delivered: '✅ 物品已送達',
    completed: `✅ 任務已完成

感謝您使用 UBee 城市任務跑腿服務。
期待再次為您服務。`,
    cancelled: '⚠️ 此任務已取消',
  };

  return base[status] || '任務狀態已更新';
}

async function pushText(to, text) {
  if (!to) return;
  return client.pushMessage(to, [{ type: 'text', text }]);
}

async function replyText(replyToken, text) {
  return client.replyMessage(replyToken, [{ type: 'text', text }]);
}

async function getDisplayName(userId, groupId = null) {
  try {
    if (groupId) {
      const profile = await client.getGroupMemberProfile(groupId, userId);
      return profile.displayName || '騎手';
    }
    const profile = await client.getProfile(userId);
    return profile.displayName || '用戶';
  } catch (err) {
    return '騎手';
  }
}

async function handleCreateOrQuote(event, mode) {
  const userId = event.source.userId;
  const text = safeText(event.message.text);

  if (text === '建立任務') {
    userModes.set(userId, { mode: 'create' });
    return replyText(event.replyToken, buildCustomerGuide('create'));
  }

  if (text === '立即估價') {
    userModes.set(userId, { mode: 'quote' });
    return replyText(event.replyToken, buildCustomerGuide('quote'));
  }

  const userMode = userModes.get(userId);
  if (!userMode || !['create', 'quote'].includes(userMode.mode)) return false;

  const parsed = parseTaskForm(text);
  if (!parsed.isComplete) {
    return replyText(event.replyToken, `資料格式不完整，請依照以下格式填寫：

${buildCustomerGuide(userMode.mode)}`);
  }

  try {
    const form = parsed.data;
    const mapData = await getDistanceAndDuration(form.pickupAddress, form.deliveryAddress);
    const urgentText = form.urgency.replace(/[（）()]/g, '').trim();
    const isUrgent = /急件/.test(urgentText);
    const crossDistrict = isCrossDistrict(form.pickupAddress, form.deliveryAddress);
    const fees = calculateFees({
      km: mapData.km,
      minutes: mapData.minutes,
      isUrgent,
      crossDistrict,
    });

    if (userMode.mode === 'quote') {
      const tempTask = {
        ...form,
        km: mapData.km,
        minutes: mapData.minutes,
        distanceText: mapData.distanceText,
        durationText: mapData.durationText,
        isUrgent,
        crossDistrict,
        fees,
      };
      userModes.delete(userId);
      return replyText(event.replyToken, buildCustomerQuoteMessage(tempTask));
    }

    const taskId = createTaskId();
    const task = {
      taskId,
      customerUserId: userId,
      customerSourceId: userId,
      pickupAddress: form.pickupAddress,
      pickupPhone: form.pickupPhone,
      deliveryAddress: form.deliveryAddress,
      deliveryPhone: form.deliveryPhone,
      item: form.item,
      note: form.note || '無',
      urgencyText: form.urgency,
      isUrgent,
      crossDistrict,
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
    };

    tasks.set(taskId, task);
    userModes.delete(userId);

    await replyText(event.replyToken, buildCustomerTaskCreatedMessage(task));

    if (LINE_GROUP_ID) {
      await pushText(LINE_GROUP_ID, buildGroupTaskMessage(task));
      task.status = 'broadcasted';
    } else {
      console.warn('⚠️ LINE_GROUP_ID 未設定，無法派單到群組');
    }

    return;
  } catch (err) {
    console.error('❌ 建立任務/估價失敗:', err.message);
    userModes.delete(userId);
    return replyText(event.replyToken, '系統暫時無法完成報價，請稍後再試一次。');
  }
}

async function handleGroupAccept(event, text) {
  const groupId = event.source.groupId;
  const riderUserId = event.source.userId;
  const latestTask = getLatestOpenTask();

  if (!latestTask) {
    return replyText(event.replyToken, '目前沒有可接的任務。');
  }

  // 格式：接單 8
  const directMatch = text.match(/^接單\s*(\d{1,3})$/);
  if (directMatch) {
    const eta = parseInt(directMatch[1], 10);
    return acceptTask(event, latestTask, eta, groupId, riderUserId);
  }

  // 格式：接
  if (text === '接') {
    pendingGroupEta.set(riderUserId, { taskId: latestTask.taskId });
    return replyText(event.replyToken, '請輸入幾分鐘可抵達取件地點，例如：8');
  }

  // 若前一步有接，下一句只輸入數字也可
  if (/^\d{1,3}$/.test(text) && pendingGroupEta.has(riderUserId)) {
    const pending = pendingGroupEta.get(riderUserId);
    const task = tasks.get(pending.taskId);

    pendingGroupEta.delete(riderUserId);

    if (!task || task.assignedRiderId || task.status !== 'broadcasted') {
      return replyText(event.replyToken, '此任務目前已不可接單。');
    }

    const eta = parseInt(text, 10);
    return acceptTask(event, task, eta, groupId, riderUserId);
  }

  return false;
}

async function acceptTask(event, task, eta, groupId, riderUserId) {
  if (task.assignedRiderId || task.status !== 'broadcasted') {
    return replyText(event.replyToken, '此任務已被其他騎手接走。');
  }

  const riderName = await getDisplayName(riderUserId, groupId);

  task.assignedRiderId = riderUserId;
  task.assignedRiderName = riderName;
  task.etaMinutes = eta;
  task.status = 'accepted';

  await replyText(event.replyToken, `✅ 接單成功\n⏱ ETA ${eta} 分鐘`);

  await pushText(task.customerSourceId, buildStatusMessage('accepted', eta));

  return;
}

async function handleGroupStatusUpdate(event, text) {
  const riderUserId = event.source.userId;

  const activeTask = Array.from(tasks.values())
    .filter(t => t.assignedRiderId === riderUserId && ['accepted', 'arrived', 'picked', 'delivered'].includes(t.status))
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  if (!activeTask) return false;

  if (text === '已抵達') {
    activeTask.status = 'arrived';
    await replyText(event.replyToken, '✅ 已回報：抵達取件地點');
    await pushText(activeTask.customerSourceId, buildStatusMessage('arrived'));
    return true;
  }

  if (text === '已取件') {
    activeTask.status = 'picked';
    await replyText(event.replyToken, '✅ 已回報：完成取件');
    await pushText(activeTask.customerSourceId, buildStatusMessage('picked'));
    return true;
  }

  if (text === '已送達') {
    activeTask.status = 'delivered';
    await replyText(event.replyToken, '✅ 已回報：物品已送達');
    await pushText(activeTask.customerSourceId, buildStatusMessage('delivered'));
    return true;
  }

  if (text === '已完成') {
    activeTask.status = 'completed';
    activeTask.completedAt = Date.now();
    await replyText(event.replyToken, '✅ 已回報：任務完成');
    await pushText(activeTask.customerSourceId, buildStatusMessage('completed'));
    return true;
  }

  return false;
}

async function handleCustomerAfterComplete(event, text) {
  const userId = event.source.userId;
  const latestCompletedTask = Array.from(tasks.values())
    .filter(t => t.customerUserId === userId && t.status === 'completed')
    .sort((a, b) => b.completedAt - a.completedAt)[0];

  if (!latestCompletedTask) return false;

  if (/^(謝謝|感謝|3Q|thanks|thank you)$/i.test(text)) {
    return replyText(event.replyToken, '不客氣，感謝您使用 UBee，期待下次再為您服務。');
  }

  return false;
}

async function handleHelp(event, text) {
  if (text !== 'help' && text !== '幫助' && text !== '功能') return false;

  const sourceType = event.source.type;

  if (sourceType === 'group') {
    return replyText(
      event.replyToken,
      `群組可用指令：

接單 8
接
已抵達
已取件
已送達
已完成`
    );
  }

  return replyText(
    event.replyToken,
    `您可以使用以下功能：

建立任務
立即估價`
  );
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = safeText(event.message.text);
  const sourceType = event.source.type;

  // 群組端
  if (sourceType === 'group') {
    if (await handleHelp(event, text)) return;
    if (await handleGroupAccept(event, text)) return;
    if (await handleGroupStatusUpdate(event, text)) return;
    return;
  }

  // 客戶端
  if (await handleHelp(event, text)) return;
  const result = await handleCreateOrQuote(event, text);
  if (result !== false) return result;
  if (await handleCustomerAfterComplete(event, text)) return;

  return replyText(
    event.replyToken,
    '請輸入「建立任務」或「立即估價」。'
  );
}

// ===== 路由 =====
app.get('/', (req, res) => {
  res.status(200).send('UBee bot v2.5 running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Webhook Error:', err);
    res.status(500).end();
  }
});

// ===== 啟動 =====
app.listen(PORT, () => {
  console.log(`✅ UBee V2.5 running on port ${PORT}`);
});
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

if (!LINE_GROUP_ID) {
  console.warn('⚠️ LINE_GROUP_ID is empty. 群組派單將無法發送。');
}

if (!GOOGLE_MAPS_API_KEY) {
  console.warn('⚠️ GOOGLE_MAPS_API_KEY is empty. Google Maps 距離計算將無法使用。');
}

// =========================
// 固定費率
// =========================
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const SERVICE_FEE = 50;
const URGENT_FEE = 100;
const FIXED_TAX = 15;

// 騎手實拿比例（依你前面邏輯：配送費 * 0.6）
const RIDER_SHARE_RATE = 0.6;

// =========================
// 記憶體狀態（V3.5 單機版）
// =========================
// 客戶填完表單、等待確認
const pendingOrdersByUser = {}; // userId -> order

// 已送到群組、等待接單
const activeOrders = {}; // internalTaskId -> order
let latestOpenTaskId = null; // 單群組目前主任務（MVP 版）

// 騎手輸入「接 / 接單 / +1」後，等待輸入 ETA 分鐘
const riderWaitingEta = {}; // riderUserId -> { taskId }

// 簡單流水號（只給系統內部用，不顯示給客戶 / 群組）
let taskCounter = 1;

// =========================
// 工具函式
// =========================
function createInternalTaskId() {
  const id = `TASK_${Date.now()}_${taskCounter}`;
  taskCounter += 1;
  return id;
}

function normalizeText(text) {
  return String(text || '').trim();
}

function isUrgentText(text) {
  const t = normalizeText(text);
  return t.includes('急件');
}

function floorNumber(n) {
  return Math.floor(Number(n) || 0);
}

function roundNumber(n) {
  return Math.round(Number(n) || 0);
}

function parseMinutesInput(text) {
  const t = normalizeText(text);
  if (!/^\d+$/.test(t)) return null;
  const value = parseInt(t, 10);
  if (value <= 0 || value > 300) return null;
  return value;
}

function extractDistrict(address) {
  if (!address) return '';
  const text = String(address).replace(/\s/g, '');

  // 常見台灣地址抓法：XX區 / XX市 / XX鄉 / XX鎮
  const match =
    text.match(/([\u4e00-\u9fa5]{1,4}區)/) ||
    text.match(/([\u4e00-\u9fa5]{1,4}市)/) ||
    text.match(/([\u4e00-\u9fa5]{1,4}鄉)/) ||
    text.match(/([\u4e00-\u9fa5]{1,4}鎮)/);

  return match ? match[1] : '';
}

function isCrossDistrict(pickupAddress, dropoffAddress) {
  const pickupDistrict = extractDistrict(pickupAddress);
  const dropoffDistrict = extractDistrict(dropoffAddress);

  if (!pickupDistrict || !dropoffDistrict) return false;
  return pickupDistrict !== dropoffDistrict;
}

function calcPricing({ distanceKm, durationMin, pickupAddress, dropoffAddress, urgent }) {
  const km = Math.max(0, floorNumber(distanceKm));
  const min = Math.max(0, floorNumber(durationMin));
  const crossDistrict = isCrossDistrict(pickupAddress, dropoffAddress);

  const distanceFee = km * PER_KM_FEE;
  const timeFee = min * PER_MIN_FEE;
  const crossDistrictFee = crossDistrict ? CROSS_DISTRICT_FEE : 0;
  const urgentFee = urgent ? URGENT_FEE : 0;

  // 配送費 = 基本費 + 公里費 + 時間費 + 跨區費
  const deliveryFee = BASE_FEE + distanceFee + timeFee + crossDistrictFee;

  // 客戶總計 = 配送費 + 服務費 + 急件費 + 稅金
  const total = deliveryFee + SERVICE_FEE + urgentFee + FIXED_TAX;

  // 騎手實拿 = 配送費 * 0.6
  const riderFee = roundNumber(deliveryFee * RIDER_SHARE_RATE);

  return {
    km,
    min,
    crossDistrict,
    distanceFee,
    timeFee,
    crossDistrictFee,
    urgentFee,
    deliveryFee,
    serviceFee: SERVICE_FEE,
    tax: FIXED_TAX,
    total,
    riderFee,
  };
}

async function getDistanceAndDuration(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('Missing GOOGLE_MAPS_API_KEY');
  }

  const url =
    'https://maps.googleapis.com/maps/api/distancematrix/json' +
    `?origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(destination)}` +
    `&mode=driving` +
    `&language=zh-TW` +
    `&region=tw` +
    `&key=${GOOGLE_MAPS_API_KEY}`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.status !== 'OK') {
    throw new Error(`Google API error: ${data.status}`);
  }

  const element = data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK') {
    throw new Error(`Distance Matrix element error: ${element?.status || 'UNKNOWN'}`);
  }

  const distanceMeters = element.distance.value;
  const durationSeconds = element.duration.value;

  const distanceKm = distanceMeters / 1000;
  const durationMin = durationSeconds / 60;

  return {
    distanceKm,
    durationMin,
  };
}

function parseTaskForm(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const lines = raw.split('\n');

  let pickupAddress = '';
  let pickupPhone = '';
  let dropoffAddress = '';
  let dropoffPhone = '';
  let item = '';
  let urgentText = '';
  let note = '';

  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('取件地點：')) pickupAddress = l.replace('取件地點：', '').trim();
    if (l.startsWith('取件電話：')) pickupPhone = l.replace('取件電話：', '').trim();
    if (l.startsWith('送達地點：')) dropoffAddress = l.replace('送達地點：', '').trim();
    if (l.startsWith('送達電話：')) dropoffPhone = l.replace('送達電話：', '').trim();
    if (l.startsWith('物品內容：')) item = l.replace('物品內容：', '').trim();
    if (l.startsWith('是否急件：')) urgentText = l.replace('是否急件：', '').trim();
    if (l.startsWith('備註：')) note = l.replace('備註：', '').trim();
  }

  const valid =
    pickupAddress &&
    pickupPhone &&
    dropoffAddress &&
    dropoffPhone &&
    item &&
    urgentText;

  return {
    valid: Boolean(valid),
    data: {
      pickupAddress,
      pickupPhone,
      dropoffAddress,
      dropoffPhone,
      item,
      urgentText,
      urgent: isUrgentText(urgentText),
      note: note || '無',
    },
  };
}

function buildTaskFormMessage() {
  return {
    type: 'text',
    text:
      '請填寫任務資訊：\n\n' +
      '取件地點：\n' +
      '取件電話：\n\n' +
      '送達地點：\n' +
      '送達電話：\n\n' +
      '物品內容：\n\n' +
      '是否急件（一般 / 急件）：\n\n' +
      '備註：',
  };
}

function buildCustomerConfirmMessage(order) {
  const urgentText = order.urgent ? '是' : '否';

  return {
    type: 'text',
    text:
      '📦 任務資訊確認\n\n' +
      `取件：${order.pickupAddress}\n` +
      `送達：${order.dropoffAddress}\n` +
      `物品：${order.item}\n` +
      `急件：${urgentText}\n\n` +
      '———\n\n' +
      `配送費：$${order.pricing.deliveryFee}\n` +
      `服務費：$${order.pricing.serviceFee}\n` +
      `急件費：$${order.pricing.urgentFee}\n` +
      `稅金：$${order.pricing.tax}\n` +
      `總計：$${order.pricing.total}\n\n` +
      '請確認是否送出任務。',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'message',
            label: '確認',
            text: '確認',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '修改',
            text: '修改',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '取消',
            text: '取消',
          },
        },
      ],
    },
  };
}

function buildGroupDispatchMessage(order) {
  const urgentText = order.urgent ? '急件' : '一般';

  return {
    type: 'text',
    text:
      '📦 UBee 新任務通知\n\n' +
      `費用：$${order.pricing.riderFee}\n` +
      `距離：${order.pricing.km} 公里\n\n` +
      `取件：${order.pickupAddress}\n` +
      `送達：${order.dropoffAddress}\n\n` +
      `物品：${order.item}\n` +
      `急件：${urgentText}\n` +
      `備註：${order.note}`,
  };
}

function buildNoOpenTaskMessage() {
  return {
    type: 'text',
    text: '目前沒有可接的任務。',
  };
}

function buildAskEtaMessage() {
  return {
    type: 'text',
    text: '⏱ 請輸入多久抵達取件地點？\n請直接回覆分鐘數，例如：5、10',
  };
}

function buildTaskAcceptedGroupMessage(riderName, etaMin) {
  return {
    type: 'text',
    text:
      `✅ 此任務已由${riderName}接單\n` +
      `⏱ 預計 ${etaMin} 分鐘抵達取件地點`,
  };
}

function buildTaskAcceptedCustomerMessage(etaMin) {
  return {
    type: 'text',
    text:
      '✅ 已有跑腿人員接單\n' +
      `⏱ 預計 ${etaMin} 分鐘抵達取件地點`,
  };
}

function buildSimpleText(text) {
  return {
    type: 'text',
    text,
  };
}

function getRiderDisplayName(event) {
  // 群組事件通常可拿到 userId；若無法拿到，就用「跑腿人員」
  const userId = event.source?.userId;
  if (userId) return '跑腿人員';
  return '跑腿人員';
}

async function safeReply(replyToken, messages) {
  try {
    const msgArray = Array.isArray(messages) ? messages : [messages];
    await client.replyMessage(replyToken, msgArray);
  } catch (error) {
    console.error('❌ replyMessage error:', error?.response?.data || error.message);
  }
}

async function safePush(to, messages) {
  try {
    const msgArray = Array.isArray(messages) ? messages : [messages];
    await client.pushMessage(to, msgArray);
    return true;
  } catch (error) {
    console.error('❌ pushMessage error:', error?.response?.data || error.message);
    return false;
  }
}

// =========================
// 核心流程
// =========================
async function handleCustomerText(event, text) {
  const userId = event.source.userId;
  const cleanText = normalizeText(text);

  // 1. 建立任務
  if (cleanText === '建立任務') {
    await safeReply(event.replyToken, buildTaskFormMessage());
    return;
  }

  // 2. 確認 / 修改 / 取消（針對 pending order）
  if (cleanText === '確認') {
    const pendingOrder = pendingOrdersByUser[userId];
    if (!pendingOrder) {
      await safeReply(event.replyToken, buildSimpleText('目前沒有待確認的任務，請先輸入「建立任務」。'));
      return;
    }

    const internalTaskId = createInternalTaskId();
    pendingOrder.internalTaskId = internalTaskId;
    pendingOrder.status = 'open';

    activeOrders[internalTaskId] = pendingOrder;
    latestOpenTaskId = internalTaskId;

    delete pendingOrdersByUser[userId];

    await safeReply(event.replyToken, buildSimpleText('✅ 任務已確認，我們正在為您媒合跑腿人員'));

    if (!LINE_GROUP_ID) {
      await safePush(
        userId,
        buildSimpleText('⚠️ 系統未設定派單群組，請先完成 LINE_GROUP_ID 設定。')
      );
      return;
    }

    const pushed = await safePush(LINE_GROUP_ID, buildGroupDispatchMessage(pendingOrder));
    if (!pushed) {
      await safePush(
        userId,
        buildSimpleText('⚠️ 派單到群組失敗，請稍後再試一次。')
      );
    }

    return;
  }

  if (cleanText === '修改') {
    const pendingOrder = pendingOrdersByUser[userId];
    if (!pendingOrder) {
      await safeReply(event.replyToken, buildSimpleText('目前沒有可修改的任務，請先輸入「建立任務」。'));
      return;
    }

    delete pendingOrdersByUser[userId];

    await safeReply(
      event.replyToken,
      [
        buildSimpleText('請重新填寫任務資訊：'),
        buildTaskFormMessage(),
      ]
    );
    return;
  }

  if (cleanText === '取消') {
    const pendingOrder = pendingOrdersByUser[userId];
    if (!pendingOrder) {
      await safeReply(event.replyToken, buildSimpleText('目前沒有可取消的任務。'));
      return;
    }

    delete pendingOrdersByUser[userId];
    await safeReply(event.replyToken, buildSimpleText('✅ 任務已取消。'));
    return;
  }

  // 3. 嘗試解析任務表單
  const parsed = parseTaskForm(cleanText);
  if (parsed.valid) {
    try {
      const form = parsed.data;
      const { distanceKm, durationMin } = await getDistanceAndDuration(
        form.pickupAddress,
        form.dropoffAddress
      );

      const pricing = calcPricing({
        distanceKm,
        durationMin,
        pickupAddress: form.pickupAddress,
        dropoffAddress: form.dropoffAddress,
        urgent: form.urgent,
      });

      const order = {
        customerUserId: userId,
        customerReplyToken: event.replyToken,
        pickupAddress: form.pickupAddress,
        pickupPhone: form.pickupPhone,
        dropoffAddress: form.dropoffAddress,
        dropoffPhone: form.dropoffPhone,
        item: form.item,
        urgent: form.urgent,
        urgentText: form.urgentText,
        note: form.note,
        distanceKm,
        durationMin,
        pricing,
        status: 'pending_confirm',
        createdAt: Date.now(),
        riderUserId: null,
        riderName: null,
        etaMin: null,
      };

      pendingOrdersByUser[userId] = order;

      await safeReply(event.replyToken, buildCustomerConfirmMessage(order));
      return;
    } catch (error) {
      console.error('❌ quote error:', error.message);
      await safeReply(
        event.replyToken,
        buildSimpleText('⚠️ 無法計算距離與報價，請確認地址是否完整，或稍後再試。')
      );
      return;
    }
  }

  // 4. 其他文字
  await safeReply(
    event.replyToken,
    buildSimpleText('請輸入「建立任務」開始建立任務。')
  );
}

async function handleGroupText(event, text) {
  const riderUserId = event.source.userId || `group_rider_${Date.now()}`;
  const cleanText = normalizeText(text);

  // 先判斷是否在等待 ETA
  const waiting = riderWaitingEta[riderUserId];
  if (waiting) {
    const etaMin = parseMinutesInput(cleanText);
    if (etaMin === null) {
      await safeReply(event.replyToken, buildSimpleText('請直接輸入分鐘數，例如：5、10'));
      return;
    }

    const task = activeOrders[waiting.taskId];
    delete riderWaitingEta[riderUserId];

    if (!task || task.status !== 'open') {
      await safeReply(event.replyToken, buildSimpleText('⚠️ 此任務目前已無法接單。'));
      return;
    }

    task.status = 'accepted';
    task.riderUserId = riderUserId;
    task.riderName = getRiderDisplayName(event);
    task.etaMin = etaMin;

    if (latestOpenTaskId === waiting.taskId) {
      latestOpenTaskId = null;
    }

    await safeReply(
      event.replyToken,
      buildTaskAcceptedGroupMessage(task.riderName, etaMin)
    );

    await safePush(
      task.customerUserId,
      buildTaskAcceptedCustomerMessage(etaMin)
    );

    return;
  }

  // 騎手輸入 接 / 接單 / +1
  if (cleanText === '接' || cleanText === '接單' || cleanText === '+1') {
    if (!latestOpenTaskId) {
      await safeReply(event.replyToken, buildNoOpenTaskMessage());
      return;
    }

    const task = activeOrders[latestOpenTaskId];
    if (!task || task.status !== 'open') {
      await safeReply(event.replyToken, buildNoOpenTaskMessage());
      return;
    }

    riderWaitingEta[riderUserId] = { taskId: latestOpenTaskId };
    await safeReply(event.replyToken, buildAskEtaMessage());
    return;
  }

  // 後續狀態回報（只允許接單者）
  const acceptedTask = Object.values(activeOrders).find(
    (order) => order && order.riderUserId === riderUserId && ['accepted', 'arrived', 'picked_up', 'delivered'].includes(order.status)
  );

  if (!acceptedTask) {
    // 群組裡其他閒聊不回
    return;
  }

  if (cleanText === '已抵達') {
    acceptedTask.status = 'arrived';
    await safeReply(event.replyToken, buildSimpleText('✅ 已通知客戶：跑腿人員已抵達取件地點。'));
    await safePush(
      acceptedTask.customerUserId,
      buildSimpleText('✅ 跑腿人員已抵達取件地點。')
    );
    return;
  }

  if (cleanText === '已取件') {
    acceptedTask.status = 'picked_up';
    await safeReply(event.replyToken, buildSimpleText('✅ 已通知客戶：物品已取件，正在配送中。'));
    await safePush(
      acceptedTask.customerUserId,
      buildSimpleText('✅ 您的物品已取件，正在配送中。')
    );
    return;
  }

  if (cleanText === '已送達') {
    acceptedTask.status = 'delivered';
    await safeReply(event.replyToken, buildSimpleText('✅ 已通知客戶：物品已送達目的地。'));
    await safePush(
      acceptedTask.customerUserId,
      buildSimpleText('✅ 您的物品已送達目的地。')
    );
    return;
  }

  if (cleanText === '完成') {
    acceptedTask.status = 'completed';
    await safeReply(event.replyToken, buildSimpleText('✅ 任務已完成。'));
    await safePush(
      acceptedTask.customerUserId,
      buildSimpleText(
        '✅ 任務已完成。\n\n感謝您使用 UBee 城市任務服務。\n期待再次為您服務。'
      )
    );

    if (acceptedTask.internalTaskId && activeOrders[acceptedTask.internalTaskId]) {
      delete activeOrders[acceptedTask.internalTaskId];
    }
    return;
  }
}

async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') {
      return null;
    }

    const text = event.message.text || '';
    const sourceType = event.source?.type;

    // 客戶端：user
    if (sourceType === 'user') {
      await handleCustomerText(event, text);
      return null;
    }

    // 群組端：group
    if (sourceType === 'group') {
      await handleGroupText(event, text);
      return null;
    }

    return null;
  } catch (error) {
    console.error('❌ handleEvent error:', error);
    return null;
  }
}

// =========================
// 路由
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee OMS V3.5 Running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (error) {
    console.error('❌ webhook error:', error);
    res.status(500).end();
  }
});

// =========================
// 啟動
// =========================
app.listen(PORT, () => {
  console.log(`✅ UBee server running on port ${PORT}`);
});

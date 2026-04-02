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
  console.warn('⚠️ Missing LINE_GROUP_ID');
}
if (!GOOGLE_MAPS_API_KEY) {
  console.warn('⚠️ Missing GOOGLE_MAPS_API_KEY');
}

// =========================
// 固定費率
// =========================
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const SERVICE_FEE = 50;
const URGENT_FEE = 100;
const CROSS_DISTRICT_FEE = 25;
const FIXED_TAX = 15;

// 騎手任務費 = 配送費 * 0.6（四捨五入）
const RIDER_PERCENTAGE = 0.6;

// =========================
// 記憶體資料
// =========================
const userSessions = {}; // 客人流程
const tasks = {}; // taskId -> 任務資料
let currentTaskId = 1;

// 騎手群組接單暫存
const groupStates = {}; // groupId -> { waitingEta: true, taskId }

// =========================
// 工具函式
// =========================
function getUserId(event) {
  return event.source.userId || event.source.groupId || event.source.roomId;
}

function normalizeText(text) {
  return (text || '').trim();
}

function isUrgent(text) {
  const value = normalizeText(text);
  return value === '急件';
}

function formatMoney(num) {
  return `$${Math.round(num)}`;
}

function safeNumber(n, fallback = 0) {
  return Number.isFinite(Number(n)) ? Number(n) : fallback;
}

function createQuickReply(items) {
  return {
    items: items.map((item) => ({
      type: 'action',
      action: {
        type: 'message',
        label: item.label,
        text: item.text,
      },
    })),
  };
}

function extractDistrict(address = '') {
  // 抓台中常見格式：XX區
  const match = address.match(/([\u4e00-\u9fa5]{1,4}區)/);
  return match ? match[1] : '';
}

function calcPrice({ distanceKm, durationMin, urgent, pickupAddress, deliveryAddress }) {
  const km = safeNumber(distanceKm, 0);
  const min = safeNumber(durationMin, 0);

  const pickupDistrict = extractDistrict(pickupAddress);
  const deliveryDistrict = extractDistrict(deliveryAddress);

  const deliveryFee = Math.round(
    BASE_FEE +
    km * PER_KM_FEE +
    min * PER_MIN_FEE +
    (pickupDistrict && deliveryDistrict && pickupDistrict !== deliveryDistrict ? CROSS_DISTRICT_FEE : 0)
  );

  const urgentFee = urgent ? URGENT_FEE : 0;
  const total = deliveryFee + SERVICE_FEE + urgentFee + FIXED_TAX;
  const riderFee = Math.round(deliveryFee * RIDER_PERCENTAGE);

  return {
    deliveryFee,
    serviceFee: SERVICE_FEE,
    urgentFee,
    tax: FIXED_TAX,
    total,
    riderFee,
    pickupDistrict,
    deliveryDistrict,
  };
}

async function geocodeAddress(address) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK' || !data.results || !data.results.length) {
    throw new Error(`Geocode failed for address: ${address}`);
  }

  return data.results[0].formatted_address;
}

async function getDistanceAndDuration(origin, destination) {
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&mode=driving&language=zh-TW&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (
    data.status !== 'OK' ||
    !data.rows ||
    !data.rows[0] ||
    !data.rows[0].elements ||
    !data.rows[0].elements[0] ||
    data.rows[0].elements[0].status !== 'OK'
  ) {
    throw new Error('Distance Matrix API failed');
  }

  const element = data.rows[0].elements[0];
  const distanceMeters = element.distance.value;
  const durationSeconds = element.duration.value;

  return {
    distanceKm: Number((distanceMeters / 1000).toFixed(1)),
    durationMin: Math.ceil(durationSeconds / 60),
  };
}

async function estimateTaskPrice(pickupAddress, deliveryAddress, urgentText) {
  const urgent = isUrgent(urgentText);

  const normalizedPickup = await geocodeAddress(pickupAddress);
  const normalizedDelivery = await geocodeAddress(deliveryAddress);

  const { distanceKm, durationMin } = await getDistanceAndDuration(normalizedPickup, normalizedDelivery);

  const price = calcPrice({
    distanceKm,
    durationMin,
    urgent,
    pickupAddress,
    deliveryAddress,
  });

  return {
    normalizedPickup,
    normalizedDelivery,
    distanceKm,
    durationMin,
    urgent,
    ...price,
  };
}

function buildEstimateMessage(quote) {
  return {
    type: 'text',
    text:
`📊 UBee 即時報價

配送費：${formatMoney(quote.deliveryFee)}
服務費：${formatMoney(quote.serviceFee)}
急件費：${formatMoney(quote.urgentFee)}
稅金：${formatMoney(quote.tax)}

💰 總計：${formatMoney(quote.total)}

若您確認要安排，請點選下方按鈕【開始建立任務】
我們將立即為您安排人員處理。`,
    quickReply: createQuickReply([
      { label: '開始建立任務', text: '開始建立任務' },
    ]),
  };
}

function buildTaskConfirmMessage(task) {
  return {
    type: 'text',
    text:
`請確認以下任務資訊：

取件地點：${task.pickupAddress}
取件電話：${task.pickupPhone}

送達地點：${task.deliveryAddress}
送達電話：${task.deliveryPhone}

物品內容：${task.item}
是否急件：${task.urgentText}
備註：${task.note}

配送費：${formatMoney(task.quote.deliveryFee)}
服務費：${formatMoney(task.quote.serviceFee)}
急件費：${formatMoney(task.quote.urgentFee)}
稅金：${formatMoney(task.quote.tax)}
總計：${formatMoney(task.quote.total)}`,
    quickReply: createQuickReply([
      { label: '確認送出', text: '確認送出' },
      { label: '重新填寫', text: '重新填寫' },
      { label: '取消任務', text: '取消任務' },
    ]),
  };
}

function buildGroupTaskMessage(taskId, task) {
  return `📦 UBee 新任務通知

騎手任務費：${formatMoney(task.quote.riderFee)}
距離：${task.quote.distanceKm} 公里

取件地點：${task.pickupAddress}
送達地點：${task.deliveryAddress}
送達電話：${task.deliveryPhone}

物品內容：${task.item}
急件：${task.urgentText}
備註：${task.note}

任務編號：#${taskId}

請輸入「接」開始接單`;
}

async function pushToUser(userId, text) {
  if (!userId) return;
  try {
    await client.pushMessage(userId, { type: 'text', text });
  } catch (error) {
    console.error('❌ pushToUser failed:', error.message);
  }
}

async function pushToGroup(groupId, text) {
  if (!groupId) return;
  try {
    await client.pushMessage(groupId, { type: 'text', text });
  } catch (error) {
    console.error('❌ pushToGroup failed:', error.message);
  }
}

function resetUserSession(userId) {
  delete userSessions[userId];
}

function startEstimateSession(userId) {
  userSessions[userId] = {
    mode: 'estimate',
    step: 'pickupAddress',
    data: {},
  };
}

function startTaskFormSession(userId) {
  userSessions[userId] = {
    mode: 'taskForm',
    step: 'pickupAddress',
    data: {},
  };
}

function getLatestPendingTask() {
  const ids = Object.keys(tasks).map(Number).sort((a, b) => b - a);
  for (const id of ids) {
    if (tasks[id] && tasks[id].status === 'pending') {
      return { taskId: id, task: tasks[id] };
    }
  }
  return null;
}

// =========================
// 客人流程處理
// =========================
async function handleEstimateFlow(event, userId, text, session) {
  const data = session.data;

  try {
    if (session.step === 'pickupAddress') {
      data.pickupAddress = text;
      session.step = 'deliveryAddress';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入送達地點：',
      });
    }

    if (session.step === 'deliveryAddress') {
      data.deliveryAddress = text;
      session.step = 'item';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入物品內容：',
      });
    }

    if (session.step === 'item') {
      data.item = text;
      session.step = 'urgent';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入是否急件（一般 / 急件）：',
        quickReply: createQuickReply([
          { label: '一般', text: '一般' },
          { label: '急件', text: '急件' },
        ]),
      });
    }

    if (session.step === 'urgent') {
      if (!['一般', '急件'].includes(text)) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '請輸入正確格式：一般 或 急件',
          quickReply: createQuickReply([
            { label: '一般', text: '一般' },
            { label: '急件', text: '急件' },
          ]),
        });
      }

      data.urgentText = text;

      const quote = await estimateTaskPrice(
        data.pickupAddress,
        data.deliveryAddress,
        data.urgentText
      );

      session.quote = quote;
      session.latestEstimate = {
        pickupAddress: data.pickupAddress,
        deliveryAddress: data.deliveryAddress,
        item: data.item,
        urgentText: data.urgentText,
        quote,
      };

      resetUserSession(userId);

      return client.replyMessage(event.replyToken, buildEstimateMessage(quote));
    }
  } catch (error) {
    console.error('❌ handleEstimateFlow error:', error.message);
    resetUserSession(userId);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⚠️ 估價失敗，請確認地址是否正確後再試一次。',
    });
  }
}

async function handleTaskFormFlow(event, userId, text, session) {
  const data = session.data;

  try {
    if (session.step === 'pickupAddress') {
      data.pickupAddress = text;
      session.step = 'pickupPhone';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '第二步，請輸入取件電話：',
      });
    }

    if (session.step === 'pickupPhone') {
      data.pickupPhone = text;
      session.step = 'deliveryAddress';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '第三步，請輸入送達地點：',
      });
    }

    if (session.step === 'deliveryAddress') {
      data.deliveryAddress = text;
      session.step = 'deliveryPhone';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '第四步，請輸入送達電話：',
      });
    }

    if (session.step === 'deliveryPhone') {
      data.deliveryPhone = text;
      session.step = 'item';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '第五步，請輸入物品內容：',
      });
    }

    if (session.step === 'item') {
      data.item = text;
      session.step = 'urgent';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '第六步，請輸入是否急件（一般 / 急件）：',
        quickReply: createQuickReply([
          { label: '一般', text: '一般' },
          { label: '急件', text: '急件' },
        ]),
      });
    }

    if (session.step === 'urgent') {
      if (!['一般', '急件'].includes(text)) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '請輸入正確格式：一般 或 急件',
          quickReply: createQuickReply([
            { label: '一般', text: '一般' },
            { label: '急件', text: '急件' },
          ]),
        });
      }

      data.urgentText = text;
      session.step = 'note';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '第七步，請輸入備註：\n若無備註，請輸入：無',
      });
    }

    if (session.step === 'note') {
      data.note = text || '無';

      const quote = await estimateTaskPrice(
        data.pickupAddress,
        data.deliveryAddress,
        data.urgentText
      );

      session.step = 'confirm';
      session.finalTask = {
        pickupAddress: data.pickupAddress,
        pickupPhone: data.pickupPhone,
        deliveryAddress: data.deliveryAddress,
        deliveryPhone: data.deliveryPhone,
        item: data.item,
        urgentText: data.urgentText,
        note: data.note || '無',
        quote,
      };

      return client.replyMessage(event.replyToken, buildTaskConfirmMessage(session.finalTask));
    }

    if (session.step === 'confirm') {
      if (text === '確認送出') {
        const task = session.finalTask;
        const taskId = currentTaskId++;

        tasks[taskId] = {
          ...task,
          customerUserId: userId,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };

        resetUserSession(userId);

        await pushToGroup(LINE_GROUP_ID, buildGroupTaskMessage(taskId, tasks[taskId]));

        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '✅ 您的任務已建立成功，我們將立即為您安排人員處理。',
        });
      }

      if (text === '重新填寫') {
        startTaskFormSession(userId);
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '好的，請重新開始填寫。\n\n第一步，請輸入取件地點：',
        });
      }

      if (text === '取消任務') {
        resetUserSession(userId);
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '已取消本次任務建立。',
        });
      }

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請點選下方按鈕進行操作。',
        quickReply: createQuickReply([
          { label: '確認送出', text: '確認送出' },
          { label: '重新填寫', text: '重新填寫' },
          { label: '取消任務', text: '取消任務' },
        ]),
      });
    }
  } catch (error) {
    console.error('❌ handleTaskFormFlow error:', error.message);
    resetUserSession(userId);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⚠️ 任務建立失敗，請確認地址是否正確後重新操作。',
    });
  }
}

// =========================
// 群組騎手流程
// =========================
async function handleGroupMessage(event, text) {
  const groupId = event.source.groupId;
  if (!groupId) return null;

  const normalized = normalizeText(text);
  const state = groupStates[groupId] || {};

  // 接單入口
  if (normalized === '接' || normalized === '接單' || normalized === '+1') {
    const latest = getLatestPendingTask();

    if (!latest) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '目前沒有可接的待接任務。',
      });
    }

    groupStates[groupId] = {
      waitingEta: true,
      taskId: latest.taskId,
      riderUserId: event.source.userId || '',
    };

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '請輸入多久抵達取件地點（分鐘）：',
    });
  }

  // 等待 ETA
  if (state.waitingEta) {
    const eta = parseInt(normalized, 10);

    if (Number.isNaN(eta) || eta <= 0) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入正確分鐘數，例如：8',
      });
    }

    const task = tasks[state.taskId];
    if (!task || task.status !== 'pending') {
      delete groupStates[groupId];
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '此任務目前不可接單，請重新操作。',
      });
    }

    task.status = 'accepted';
    task.eta = eta;
    task.acceptedAt = new Date().toISOString();
    task.riderUserId = event.source.userId || '';

    delete groupStates[groupId];

    await pushToUser(
      task.customerUserId,
      `✅ 已有人接單\n⏱ 預計 ${eta} 分鐘抵達取件地點`
    );

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 此任務已成功接單\n⏱ 預計 ${eta} 分鐘抵達取件地點`,
    });
  }

  // 已抵達
  if (normalized === '已抵達') {
    const latestAccepted = Object.entries(tasks)
      .map(([taskId, task]) => ({ taskId, task }))
      .reverse()
      .find(({ task }) => task.status === 'accepted');

    if (!latestAccepted) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '目前沒有進行中的已接單任務。',
      });
    }

    latestAccepted.task.status = 'arrived';

    await pushToUser(
      latestAccepted.task.customerUserId,
      '騎手已抵達取件地點'
    );

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '已通知客人：騎手已抵達取件地點',
    });
  }

  // 已取件
  if (normalized === '已取件') {
    const latestTask = Object.entries(tasks)
      .map(([taskId, task]) => ({ taskId, task }))
      .reverse()
      .find(({ task }) => ['accepted', 'arrived'].includes(task.status));

    if (!latestTask) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '目前沒有可更新為已取件的任務。',
      });
    }

    latestTask.task.status = 'picked';

    await pushToUser(
      latestTask.task.customerUserId,
      '物品已取件，正在送達中'
    );

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '已通知客人：物品已取件，正在送達中',
    });
  }

  // 已送達
  if (normalized === '已送達') {
    const latestTask = Object.entries(tasks)
      .map(([taskId, task]) => ({ taskId, task }))
      .reverse()
      .find(({ task }) => ['picked', 'arrived', 'accepted'].includes(task.status));

    if (!latestTask) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '目前沒有可更新為已送達的任務。',
      });
    }

    latestTask.task.status = 'delivered';

    await pushToUser(
      latestTask.task.customerUserId,
      '物品已送達目的地'
    );

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '已通知客人：物品已送達目的地',
    });
  }

  // 已完成
  if (normalized === '已完成') {
    const latestTask = Object.entries(tasks)
      .map(([taskId, task]) => ({ taskId, task }))
      .reverse()
      .find(({ task }) => ['delivered', 'picked', 'arrived', 'accepted'].includes(task.status));

    if (!latestTask) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '目前沒有可完成的任務。',
      });
    }

    latestTask.task.status = 'completed';
    latestTask.task.completedAt = new Date().toISOString();

    await pushToUser(
      latestTask.task.customerUserId,
      '✅ 任務已完成。\n\n感謝您使用 UBee 城市任務服務，期待再次為您服務。'
    );

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '已通知客人：任務已完成',
    });
  }

  return null;
}

// =========================
// 主要事件處理
// =========================
async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') {
      return null;
    }

    const text = normalizeText(event.message.text);
    const userId = getUserId(event);

    // 群組訊息優先處理騎手流程
    if (event.source.type === 'group') {
      const groupHandled = await handleGroupMessage(event, text);
      if (groupHandled) return groupHandled;
      return null;
    }

    const session = userSessions[userId];

    // 正在估價流程
    if (session && session.mode === 'estimate') {
      return handleEstimateFlow(event, userId, text, session);
    }

    // 正在建立任務流程
    if (session && session.mode === 'taskForm') {
      return handleTaskFormFlow(event, userId, text, session);
    }

    // 指令：立即估價
    if (text === '立即估價') {
      startEstimateSession(userId);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請依序提供以下資訊。\n\n第一步，請輸入取件地點：',
      });
    }

    // 指令：建立任務 / 開始建立任務
    if (text === '建立任務' || text === '開始建立任務') {
      startTaskFormSession(userId);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '好的，請依序提供以下資訊。\n\n第一步，請輸入取件地點：',
      });
    }

    // 其他常用關鍵字
    if (text === '取消任務') {
      resetUserSession(userId);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '已取消目前流程。',
      });
    }

    // 預設選單
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '請選擇您要使用的功能：',
      quickReply: createQuickReply([
        { label: '立即估價', text: '立即估價' },
        { label: '建立任務', text: '建立任務' },
      ]),
    });
  } catch (error) {
    console.error('❌ handleEvent error:', error);
    return null;
  }
}

// =========================
// Webhook
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee OMS V3.6.1 Running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ webhook error:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});

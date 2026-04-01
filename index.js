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

// ===== 費率設定（V3）=====
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const URGENT_FEE = 100;
const SERVICE_FEE = 50;
const FIXED_TAX = 15;

// 騎手抽成：配送費 * 0.6
const RIDER_RATE = 0.6;

// ===== 記憶體資料 =====
const userSessions = new Map(); // 客戶流程狀態
const tasks = new Map(); // 所有任務
const riderSessions = new Map(); // 騎手接單狀態

let taskCounter = 1;

// ===== 首頁 =====
app.get('/', (req, res) => {
  res.status(200).send('UBee bot v3');
});

// ===== Webhook =====
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('❌ Webhook Error:', err);
    res.status(500).end();
  }
});

// ===== 工具函式 =====
function getSourceId(source) {
  return source.userId || source.groupId || source.roomId || 'unknown';
}

function getUserSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      mode: null, // create_task / quote
      step: null,
      data: {},
    });
  }
  return userSessions.get(userId);
}

function resetUserSession(userId) {
  userSessions.set(userId, {
    mode: null,
    step: null,
    data: {},
  });
}

function getDistrict(address = '') {
  const match = address.match(/([^\s]+區)/);
  return match ? match[1] : '';
}

function isCrossDistrict(pickup, dropoff) {
  const pickupDistrict = getDistrict(pickup);
  const dropoffDistrict = getDistrict(dropoff);

  if (!pickupDistrict || !dropoffDistrict) return false;
  return pickupDistrict !== dropoffDistrict;
}

async function getDistanceAndDuration(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('Missing GOOGLE_MAPS_API_KEY');
  }

  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(
    origin
  )}&destination=${encodeURIComponent(destination)}&mode=driving&language=zh-TW&key=${GOOGLE_MAPS_API_KEY}`;

  const response = await fetch(url);
  const data = await response.json();

  if (
    data.status !== 'OK' ||
    !data.routes ||
    !data.routes[0] ||
    !data.routes[0].legs ||
    !data.routes[0].legs[0]
  ) {
    console.error('❌ Google Maps API error:', data);
    throw new Error(`Google Maps API error: ${data.status || 'UNKNOWN'}`);
  }

  const leg = data.routes[0].legs[0];
  const distanceKm = leg.distance.value / 1000;
  const durationMin = Math.ceil(leg.duration.value / 60);

  return {
    distanceKm: Number(distanceKm.toFixed(1)),
    durationMin,
  };
}

function calculatePrice({ distanceKm, durationMin, urgent, crossDistrict }) {
  const distanceFee = Math.round(distanceKm * PER_KM_FEE);
  const durationFee = Math.round(durationMin * PER_MIN_FEE);
  const crossFee = crossDistrict ? CROSS_DISTRICT_FEE : 0;
  const urgentFee = urgent === '急件' ? URGENT_FEE : 0;

  const deliveryFee =
    BASE_FEE +
    distanceFee +
    durationFee +
    SERVICE_FEE +
    crossFee +
    urgentFee;

  const total = deliveryFee + FIXED_TAX;
  const riderFee = Math.round(deliveryFee * RIDER_RATE);

  return {
    deliveryFee,
    tax: FIXED_TAX,
    total,
    riderFee,
    breakdown: {
      baseFee: BASE_FEE,
      distanceFee,
      durationFee,
      serviceFee: SERVICE_FEE,
      crossFee,
      urgentFee,
    },
  };
}

async function safeGetProfile(userId) {
  try {
    const profile = await client.getProfile(userId);
    return profile.displayName || '騎手';
  } catch (err) {
    return '騎手';
  }
}

function createTask(data) {
  const taskId = `TASK_${taskCounter++}`;

  const task = {
    taskId,
    status: 'pending',
    customerUserId: data.customerUserId,
    pickupAddress: data.pickupAddress,
    pickupPhone: data.pickupPhone,
    dropoffAddress: data.dropoffAddress,
    dropoffPhone: data.dropoffPhone,
    item: data.item,
    urgent: data.urgent,
    remark: data.remark || '無',
    distanceKm: data.distanceKm,
    durationMin: data.durationMin,
    deliveryFee: data.deliveryFee,
    tax: data.tax,
    total: data.total,
    riderFee: data.riderFee,
    riderUserId: null,
    riderName: null,
    eta: null,
    createdAt: new Date(),
  };

  tasks.set(taskId, task);
  return task;
}

function getLatestPendingTask() {
  const allTasks = Array.from(tasks.values())
    .filter((t) => t.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt);

  return allTasks[0] || null;
}

function getTaskByRider(userId) {
  return Array.from(tasks.values()).find(
    (t) => t.riderUserId === userId && t.status !== 'completed'
  );
}

async function dispatchTaskToGroup(task) {
  if (!LINE_GROUP_ID) {
    console.error('❌ Missing LINE_GROUP_ID');
    return;
  }

  const message = `📦 UBee 新任務通知

費用：$${task.riderFee}
距離：${task.distanceKm} 公里

取件：${task.pickupAddress}
送達：${task.dropoffAddress}
物品：${task.item}
急件：${task.urgent}`;

  await client.pushMessage(LINE_GROUP_ID, {
    type: 'text',
    text: message,
  });
}

async function notifyCustomerTaskCreated(task) {
  const text = `✅ 您的任務已建立成功

配送費：$${task.deliveryFee}
稅金：$${task.tax}
總計：$${task.total}

我們會立即為您派單。`;

  await client.pushMessage(task.customerUserId, {
    type: 'text',
    text,
  });
}

async function notifyCustomerRiderAccepted(task) {
  const text = `✅ 已有人接單
⏱ 預計 ${task.eta} 分鐘抵達取件地點`;

  await client.pushMessage(task.customerUserId, {
    type: 'text',
    text,
  });
}

async function notifyCustomerStatus(task, statusText) {
  await client.pushMessage(task.customerUserId, {
    type: 'text',
    text: statusText,
  });
}

// ===== 客戶流程 =====
async function startCreateTask(replyToken, userId) {
  resetUserSession(userId);
  const session = getUserSession(userId);
  session.mode = 'create_task';
  session.step = 'pickup_address';

  await client.replyMessage(replyToken, {
    type: 'text',
    text: '請輸入取件地點',
  });
}

async function startQuote(replyToken, userId) {
  resetUserSession(userId);
  const session = getUserSession(userId);
  session.mode = 'quote';
  session.step = 'pickup_address';

  await client.replyMessage(replyToken, {
    type: 'text',
    text: '請輸入取件地點',
  });
}

async function handleCreateTaskFlow(event, text, userId) {
  const session = getUserSession(userId);

  switch (session.step) {
    case 'pickup_address':
      session.data.pickupAddress = text;
      session.step = 'pickupPhone';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入取件電話',
      });

    case 'pickupPhone':
      session.data.pickupPhone = text;
      session.step = 'dropoffAddress';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入送達地點',
      });

    case 'dropoffAddress':
      session.data.dropoffAddress = text;
      session.step = 'dropoffPhone';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入送達電話',
      });

    case 'dropoffPhone':
      session.data.dropoffPhone = text;
      session.step = 'item';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入物品內容',
      });

    case 'item':
      session.data.item = text;
      session.step = 'urgent';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入是否急件（一般 / 急件）',
      });

    case 'urgent':
      session.data.urgent = text.includes('急件') ? '急件' : '一般';
      session.step = 'remark';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入備註（沒有可輸入：無）',
      });

    case 'remark':
      session.data.remark = text || '無';

      try {
        const { distanceKm, durationMin } = await getDistanceAndDuration(
          session.data.pickupAddress,
          session.data.dropoffAddress
        );

        const crossDistrict = isCrossDistrict(
          session.data.pickupAddress,
          session.data.dropoffAddress
        );

        const price = calculatePrice({
          distanceKm,
          durationMin,
          urgent: session.data.urgent,
          crossDistrict,
        });

        const task = createTask({
          customerUserId: userId,
          pickupAddress: session.data.pickupAddress,
          pickupPhone: session.data.pickupPhone,
          dropoffAddress: session.data.dropoffAddress,
          dropoffPhone: session.data.dropoffPhone,
          item: session.data.item,
          urgent: session.data.urgent,
          remark: session.data.remark,
          distanceKm,
          durationMin,
          deliveryFee: price.deliveryFee,
          tax: price.tax,
          total: price.total,
          riderFee: price.riderFee,
        });

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ 任務建立成功

配送費：$${task.deliveryFee}
稅金：$${task.tax}
總計：$${task.total}

我們會立即為您派單。`,
        });

        await dispatchTaskToGroup(task);

        resetUserSession(userId);
      } catch (err) {
        console.error('❌ Create task error:', err);
        resetUserSession(userId);

        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '❌ 建立任務失敗，請確認地址是否正確，稍後再試一次。',
        });
      }
      return;
  }
}

async function handleQuoteFlow(event, text, userId) {
  const session = getUserSession(userId);

  switch (session.step) {
    case 'pickup_address':
      session.data.pickupAddress = text;
      session.step = 'dropoffAddress';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入送達地點',
      });

    case 'dropoffAddress':
      session.data.dropoffAddress = text;
      session.step = 'urgent';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入是否急件（一般 / 急件）',
      });

    case 'urgent':
      session.data.urgent = text.includes('急件') ? '急件' : '一般';

      try {
        const { distanceKm, durationMin } = await getDistanceAndDuration(
          session.data.pickupAddress,
          session.data.dropoffAddress
        );

        const crossDistrict = isCrossDistrict(
          session.data.pickupAddress,
          session.data.dropoffAddress
        );

        const price = calculatePrice({
          distanceKm,
          durationMin,
          urgent: session.data.urgent,
          crossDistrict,
        });

        resetUserSession(userId);

        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `📦 立即估價結果

配送費：$${price.deliveryFee}
稅金：$${price.tax}
總計：$${price.total}`,
        });
      } catch (err) {
        console.error('❌ Quote error:', err);
        resetUserSession(userId);

        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '❌ 估價失敗，請確認地址是否正確，稍後再試一次。',
        });
      }
  }
}

// ===== 騎手流程（保留 V2 / V2.5 手感）=====
async function handleRiderCommand(event, text, source) {
  const userId = source.userId;
  if (!userId) return null;

  const trimmed = text.trim();

  // 直接接單：接單 8
  const matchDirectAccept = trimmed.match(/^接單\s*(\d{1,3})$/);
  if (matchDirectAccept) {
    const eta = parseInt(matchDirectAccept[1], 10);
    const task = getLatestPendingTask();

    if (!task) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '目前沒有可接任務',
      });
    }

    if (task.status !== 'pending') {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '此任務已被接走',
      });
    }

    const riderName = await safeGetProfile(userId);

    task.status = 'accepted';
    task.riderUserId = userId;
    task.riderName = riderName;
    task.eta = eta;

    await notifyCustomerRiderAccepted(task);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 已收到接單
⏱ 你預計 ${eta} 分鐘抵達取件地點`,
    });
  }

  // 先輸入 接，再輸入分鐘
  if (trimmed === '接') {
    const task = getLatestPendingTask();

    if (!task) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '目前沒有可接任務',
      });
    }

    if (task.status !== 'pending') {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '此任務已被接走',
      });
    }

    riderSessions.set(userId, {
      step: 'awaiting_eta',
      taskId: task.taskId,
    });

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '✅ 已收到接單\n請回覆幾分鐘會到取件地點\n例如：8',
    });
  }

  // 騎手輸入數字 ETA
  const riderSession = riderSessions.get(userId);
  if (riderSession && riderSession.step === 'awaiting_eta' && /^\d{1,3}$/.test(trimmed)) {
    const eta = parseInt(trimmed, 10);
    const task = tasks.get(riderSession.taskId);

    if (!task || task.status !== 'pending') {
      riderSessions.delete(userId);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '此任務已無法接單',
      });
    }

    const riderName = await safeGetProfile(userId);

    task.status = 'accepted';
    task.riderUserId = userId;
    task.riderName = riderName;
    task.eta = eta;

    riderSessions.delete(userId);
    await notifyCustomerRiderAccepted(task);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 已收到接單
⏱ 你預計 ${eta} 分鐘抵達取件地點`,
    });
  }

  // 狀態更新
  const currentTask = getTaskByRider(userId);

  if (!currentTask) return null;

  if (trimmed === '已抵達') {
    currentTask.status = 'arrived_pickup';
    await notifyCustomerStatus(currentTask, '✅ 騎手已抵達取件地點');
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '✅ 已回報：抵達取件地點',
    });
  }

  if (trimmed === '已取件') {
    currentTask.status = 'picked_up';
    await notifyCustomerStatus(currentTask, '✅ 騎手已完成取件，正在前往送達地點');
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '✅ 已回報：完成取件',
    });
  }

  if (trimmed === '已送達') {
    currentTask.status = 'delivered';
    await notifyCustomerStatus(currentTask, '✅ 物品已送達');
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '✅ 已回報：物品已送達',
    });
  }

  if (trimmed === '已完成') {
    currentTask.status = 'completed';
    await notifyCustomerStatus(
      currentTask,
      `✅ 已抵達目的地，任務已完成。

感謝您使用 UBee 城市任務服務。
期待再次為您服務。`
    );

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '✅ 已回報：任務完成',
    });
  }

  return null;
}

// ===== 主事件處理 =====
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const text = event.message.text.trim();
  const source = event.source;
  const sourceType = source.type;
  const userId = source.userId || getSourceId(source);

  // ===== 群組內：優先處理騎手指令 =====
  if (sourceType === 'group' || sourceType === 'room') {
    const riderHandled = await handleRiderCommand(event, text, source);
    if (riderHandled) return riderHandled;
    return null; // 群組不做其他自動回覆，避免干擾
  }

  // ===== 單聊：客戶流程 =====
  const session = getUserSession(userId);

  // 指令：建立任務
  if (text === '建立任務') {
    return startCreateTask(event.replyToken, userId);
  }

  // 指令：立即估價
  if (text === '立即估價') {
    return startQuote(event.replyToken, userId);
  }

  // 指令：取消
  if (text === '取消') {
    resetUserSession(userId);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '✅ 已取消目前流程',
    });
  }

  // 建立任務流程
  if (session.mode === 'create_task') {
    return handleCreateTaskFlow(event, text, userId);
  }

  // 立即估價流程
  if (session.mode === 'quote') {
    return handleQuoteFlow(event, text, userId);
  }

  // 一般預設回覆
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `您好，請輸入以下功能：

1. 建立任務
2. 立即估價

若要中止流程，請輸入：取消`,
  });
}

// ===== 啟動 =====
app.listen(PORT, () => {
  console.log(`✅ UBee bot running on port ${PORT}`);
});

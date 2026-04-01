require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');

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
const FIXED_TAX = 15;

// 騎手分潤：配送費 * 0.6
const RIDER_RATIO = 0.6;

// ====== 記憶體暫存 ======
const userSessions = new Map();      // 客戶填單狀態
const orders = new Map();            // orderId -> 訂單資料
const groupPendingQueue = [];        // 尚未接單的訂單順序
const riderPendingEta = new Map();   // 群組騎手等待輸入 ETA

// ====== 工具 ======
function nowId() {
  return 'U' + Date.now().toString().slice(-8);
}

function cleanText(text = '') {
  return text.trim();
}

function getDistrict(address = '') {
  const match = address.match(/([^\s縣市區鄉鎮]+[區鄉鎮市])/);
  return match ? match[1] : '';
}

function isCrossDistrict(pickup, dropoff) {
  const p = getDistrict(pickup);
  const d = getDistrict(dropoff);
  if (!p || !d) return false;
  return p !== d;
}

async function getDistanceAndDuration(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('Missing GOOGLE_MAPS_API_KEY');
  }

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
    throw new Error('Google Maps distance lookup failed');
  }

  const element = data.rows[0].elements[0];
  const distanceMeters = element.distance.value;
  const durationSeconds = element.duration.value;

  return {
    km: Math.ceil(distanceMeters / 1000),
    minutes: Math.ceil(durationSeconds / 60),
  };
}

function calculatePrice({ km, minutes, urgent, pickup, dropoff }) {
  const distanceFee = km * PER_KM_FEE;
  const timeFee = minutes * PER_MIN_FEE;
  const crossDistrictFee = isCrossDistrict(pickup, dropoff) ? CROSS_DISTRICT_FEE : 0;
  const urgentFee = urgent === '急件' ? URGENT_FEE : 0;

  const deliveryFee = BASE_FEE + distanceFee + timeFee + crossDistrictFee;
  const subtotal = deliveryFee + SERVICE_FEE + urgentFee;
  const total = subtotal + FIXED_TAX;

  const riderPay = Math.round(deliveryFee * RIDER_RATIO);

  return {
    deliveryFee,
    serviceFee: SERVICE_FEE,
    urgentFee,
    tax: FIXED_TAX,
    total,
    riderPay,
    crossDistrictFee,
    distanceFee,
    timeFee,
  };
}

function buildCustomerSummary(order) {
  return (
    `📦 UBee 任務確認\n\n` +
    `取件地點：${order.pickupAddress}\n` +
    `取件電話：${order.pickupPhone}\n\n` +
    `送達地點：${order.dropoffAddress}\n` +
    `送達電話：${order.dropoffPhone}\n\n` +
    `物品內容：${order.item}\n` +
    `急件：${order.urgent}\n` +
    `備註：${order.note || '無'}\n\n` +
    `配送費：$${order.price.deliveryFee}\n` +
    `服務費：$${order.price.serviceFee}\n` +
    `急件費：$${order.price.urgentFee}\n` +
    `稅金：$${order.price.tax}\n` +
    `總計：$${order.price.total}`
  );
}

function buildGroupMessage(order) {
  return (
    `📦 UBee 新任務通知\n\n` +
    `費用：$${order.price.riderPay}\n` +
    `距離：${order.km} 公里\n\n` +
    `取件：${order.pickupAddress}\n` +
    `送達：${order.dropoffAddress}\n` +
    `物品：${order.item}\n` +
    `急件：${order.urgent}\n` +
    `備註：${order.note || '無'}`
  );
}

function makeQuickReply(items) {
  return {
    items: items.map((label) => ({
      type: 'action',
      action: {
        type: 'message',
        label,
        text: label,
      },
    })),
  };
}

function resetUserSession(userId) {
  userSessions.delete(userId);
}

function startTaskSession(userId) {
  userSessions.set(userId, {
    mode: 'create_task',
    step: 'pickupAddress',
    data: {},
  });
}

function getUserSession(userId) {
  return userSessions.get(userId);
}

function createOrderFromSession(userId, sessionData, route, price) {
  const orderId = nowId();
  const order = {
    orderId,
    customerUserId: userId,
    status: 'pending',
    riderUserId: null,
    riderName: null,
    etaMinutes: null,

    pickupAddress: sessionData.pickupAddress,
    pickupPhone: sessionData.pickupPhone,
    dropoffAddress: sessionData.dropoffAddress,
    dropoffPhone: sessionData.dropoffPhone,
    item: sessionData.item,
    urgent: sessionData.urgent,
    note: sessionData.note || '無',

    km: route.km,
    minutes: route.minutes,
    price,
    createdAt: new Date().toISOString(),
  };

  orders.set(orderId, order);
  return order;
}

function getLatestPendingOrder() {
  while (groupPendingQueue.length > 0) {
    const orderId = groupPendingQueue[0];
    const order = orders.get(orderId);
    if (!order || order.status !== 'pending') {
      groupPendingQueue.shift();
      continue;
    }
    return order;
  }
  return null;
}

// ====== Web ======
app.get('/', (req, res) => {
  res.status(200).send('UBee V3.1 running');
});

// ====== Webhook ======
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.status(500).end();
  }
});

// ====== 事件處理 ======
async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') {
      return null;
    }

    const text = cleanText(event.message.text);

    if (event.source.type === 'group') {
      return handleGroupMessage(event, text);
    }

    if (event.source.type === 'user') {
      return handleUserMessage(event, text);
    }

    return null;
  } catch (err) {
    console.error('❌ handleEvent error:', err);

    if (event.replyToken) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '系統目前發生錯誤，請稍後再試一次。',
      });
    }

    return null;
  }
}

// ====== 客戶端 ======
async function handleUserMessage(event, text) {
  const userId = event.source.userId;
  const session = getUserSession(userId);

  // ===== 常用入口 =====
  if (text === '取消任務') {
    resetUserSession(userId);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '已取消本次任務。',
    });
  }

  if (text === '重新填寫') {
    startTaskSession(userId);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '好的，重新開始建立任務。\n\n請輸入取件地點：',
    });
  }

  if (text === '建立任務') {
    startTaskSession(userId);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '請輸入取件地點：',
    });
  }

  // ===== 確認送出 =====
  if (text === '確認送出') {
    if (!session || session.step !== 'confirm' || !session.data.readyToSubmit) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '目前沒有可送出的任務，請先輸入「建立任務」。',
      });
    }

    const order = session.data.order;
    order.status = 'waiting_dispatch';

    if (!LINE_GROUP_ID) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'LINE_GROUP_ID 尚未設定，請先到 Render 環境變數設定。',
      });
    }

    const groupMsg = buildGroupMessage(order);

    await client.pushMessage(LINE_GROUP_ID, {
      type: 'text',
      text: groupMsg,
    });

    order.status = 'pending';
    groupPendingQueue.push(order.orderId);

    resetUserSession(userId);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 您的任務已建立成功，我們會立即為您派單。\n\n應付總計：$${order.price.total}`,
    });
  }

  // ===== 沒有 session 時的預設 =====
  if (!session) {
    if (text === '立即估價') {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text:
          '目前 V3.1 正式版先以「建立任務」引導式填寫為主。\n\n請輸入「建立任務」開始。',
      });
    }

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        '您好，歡迎使用 UBee。\n\n您可以輸入：\n' +
        '1. 建立任務\n' +
        '2. 取消任務',
    });
  }

  // ===== 有 session，進入引導填寫 =====
  const data = session.data;

  switch (session.step) {
    case 'pickupAddress':
      data.pickupAddress = text;
      session.step = 'pickupPhone';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入取件電話：',
      });

    case 'pickupPhone':
      data.pickupPhone = text;
      session.step = 'dropoffAddress';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入送達地點：',
      });

    case 'dropoffAddress':
      data.dropoffAddress = text;
      session.step = 'dropoffPhone';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入送達電話：',
      });

    case 'dropoffPhone':
      data.dropoffPhone = text;
      session.step = 'item';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入物品內容：',
      });

    case 'item':
      data.item = text;
      session.step = 'urgent';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請選擇是否急件：',
        quickReply: makeQuickReply(['一般', '急件']),
      });

    case 'urgent':
      if (text !== '一般' && text !== '急件') {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '請直接選擇「一般」或「急件」。',
          quickReply: makeQuickReply(['一般', '急件']),
        });
      }
      data.urgent = text;
      session.step = 'note';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請輸入備註（沒有可輸入：無）：',
      });

    case 'note':
      data.note = text || '無';

      try {
        const route = await getDistanceAndDuration(data.pickupAddress, data.dropoffAddress);
        const price = calculatePrice({
          km: route.km,
          minutes: route.minutes,
          urgent: data.urgent,
          pickup: data.pickupAddress,
          dropoff: data.dropoffAddress,
        });

        const order = createOrderFromSession(userId, data, route, price);

        session.step = 'confirm';
        session.data.readyToSubmit = true;
        session.data.order = order;

        return client.replyMessage(event.replyToken, {
          type: 'text',
          text:
            buildCustomerSummary(order) +
            `\n\n請選擇下一步：`,
          quickReply: makeQuickReply(['確認送出', '重新填寫', '取消任務']),
        });
      } catch (err) {
        console.error('❌ pricing error:', err);
        resetUserSession(userId);

        return client.replyMessage(event.replyToken, {
          type: 'text',
          text:
            '目前無法取得距離與時間，請確認地址是否完整，稍後再重新建立任務。',
        });
      }

    case 'confirm':
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請直接選擇「確認送出」、「重新填寫」或「取消任務」。',
        quickReply: makeQuickReply(['確認送出', '重新填寫', '取消任務']),
      });

    default:
      resetUserSession(userId);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '流程已重置，請重新輸入「建立任務」。',
      });
  }
}

// ====== 群組端 / 騎手端 ======
async function handleGroupMessage(event, text) {
  const riderUserId = event.source.userId || 'unknown';
  const replyToken = event.replyToken;

  // 抓 groupId log
  if (event.source.groupId) {
    console.log('GROUP_ID=' + event.source.groupId);
  }

  // 接 或 接單（不帶 ETA）
  if (text === '接' || text === '接單') {
    const order = getLatestPendingOrder();
    if (!order) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '目前沒有可接的任務。',
      });
    }

    riderPendingEta.set(riderUserId, order.orderId);

    return client.replyMessage(replyToken, {
      type: 'text',
      text: '✅ 已收到接單\n請回覆幾分鐘會到取件地點\n例如：8',
    });
  }

  // 如果騎手上一句是接，下一句直接回數字
  if (/^\d+$/.test(text) && riderPendingEta.has(riderUserId)) {
    const orderId = riderPendingEta.get(riderUserId);
    riderPendingEta.delete(riderUserId);

    const order = orders.get(orderId);
    if (!order || order.status !== 'pending') {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '此任務目前已不可接。',
      });
    }

    order.status = 'accepted';
    order.riderUserId = riderUserId;
    order.etaMinutes = Number(text);

    // 從待接佇列移除
    const index = groupPendingQueue.indexOf(orderId);
    if (index >= 0) groupPendingQueue.splice(index, 1);

    await client.pushMessage(order.customerUserId, {
      type: 'text',
      text:
        `✅ 已有人接單\n` +
        `預計 ${order.etaMinutes} 分鐘抵達取件地點`,
    });

    return client.replyMessage(replyToken, {
      type: 'text',
      text: `✅ 接單成功\n⏱ 已回報 ETA ${order.etaMinutes} 分鐘`,
    });
  }

  // 接 8 / 接單 8
  const acceptMatch = text.match(/^(接|接單)\s*(\d+)$/);
  if (acceptMatch) {
    const eta = Number(acceptMatch[2]);
    const order = getLatestPendingOrder();

    if (!order) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '目前沒有可接的任務。',
      });
    }

    order.status = 'accepted';
    order.riderUserId = riderUserId;
    order.etaMinutes = eta;

    const index = groupPendingQueue.indexOf(order.orderId);
    if (index >= 0) groupPendingQueue.splice(index, 1);

    await client.pushMessage(order.customerUserId, {
      type: 'text',
      text:
        `✅ 已有人接單\n` +
        `預計 ${eta} 分鐘抵達取件地點`,
    });

    return client.replyMessage(replyToken, {
      type: 'text',
      text: `✅ 接單成功\n⏱ 已回報 ETA ${eta} 分鐘`,
    });
  }

  // 已抵達
  if (text === '已抵達') {
    const order = [...orders.values()].find(
      (o) => o.riderUserId === riderUserId && o.status === 'accepted'
    );

    if (!order) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '目前沒有可回報「已抵達」的任務。',
      });
    }

    order.status = 'arrived';

    await client.pushMessage(order.customerUserId, {
      type: 'text',
      text: '✅ 騎手已抵達取件地點。',
    });

    return client.replyMessage(replyToken, {
      type: 'text',
      text: '✅ 已回報：已抵達',
    });
  }

  // 已取件
  if (text === '已取件') {
    const order = [...orders.values()].find(
      (o) =>
        o.riderUserId === riderUserId &&
        (o.status === 'accepted' || o.status === 'arrived')
    );

    if (!order) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '目前沒有可回報「已取件」的任務。',
      });
    }

    order.status = 'picked_up';

    await client.pushMessage(order.customerUserId, {
      type: 'text',
      text: '✅ 物品已取件，正在配送中。',
    });

    return client.replyMessage(replyToken, {
      type: 'text',
      text: '✅ 已回報：已取件',
    });
  }

  // 已送達
  if (text === '已送達') {
    const order = [...orders.values()].find(
      (o) =>
        o.riderUserId === riderUserId &&
        (o.status === 'picked_up' || o.status === 'arrived' || o.status === 'accepted')
    );

    if (!order) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '目前沒有可回報「已送達」的任務。',
      });
    }

    order.status = 'delivered';

    await client.pushMessage(order.customerUserId, {
      type: 'text',
      text: '✅ 物品已送達。',
    });

    return client.replyMessage(replyToken, {
      type: 'text',
      text: '✅ 已回報：已送達',
    });
  }

  // 已完成
  if (text === '已完成') {
    const order = [...orders.values()].find(
      (o) =>
        o.riderUserId === riderUserId &&
        ['accepted', 'arrived', 'picked_up', 'delivered'].includes(o.status)
    );

    if (!order) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '目前沒有可回報「已完成」的任務。',
      });
    }

    order.status = 'completed';

    await client.pushMessage(order.customerUserId, {
      type: 'text',
      text:
        `✅ 已抵達目的地，任務已完成。\n\n` +
        `感謝您使用 UBee 城市任務跑腿服務。\n` +
        `期待再次為您服務。`,
    });

    return client.replyMessage(replyToken, {
      type: 'text',
      text: '✅ 已回報：任務完成',
    });
  }

  return null;
}

// ====== Start ======
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
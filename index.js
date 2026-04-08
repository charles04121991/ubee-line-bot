require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

const PORT = process.env.PORT || 3000;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
const LINE_FINISH_GROUP_ID = process.env.LINE_FINISH_GROUP_ID || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ===== 記憶體 =====
const orders = {};
const sessions = {};
const distanceCache = {};

// ===== 計價 =====
const PRICING = {
  baseFee: 99,
  perKm: 8,
  perMinute: 2,
  serviceFee: 50,
  urgentFee: 100,
  waitingFee: 60,
  nightFee: 50,
};

// ===== 工具 =====
const createOrderId = () => 'OD' + Date.now();

function safeReply(token, msg) {
  if (!token) return;
  return client.replyMessage(token, msg).catch(() => {});
}
function safePush(to, msg) {
  return client.pushMessage(to, msg).catch(() => {});
}

// ===== 夜間 =====
function isNightTime() {
  const now = new Date();
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= 1110 && m <= 1350;
}

// ===== timeout =====
async function fetchWithTimeout(url, timeout = 8000) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeout);
  return fetch(url, { signal: controller.signal });
}

// ===== 距離 cache =====
async function getDistance(origin, destination) {
  const key = origin + destination;

  if (distanceCache[key]) return distanceCache[key];

  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(destination)}&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetchWithTimeout(url);
  const data = await res.json();

  const el = data.rows[0].elements[0];

  const result = {
    km: el.distance.value / 1000,
    min: el.duration.value / 60,
  };

  distanceCache[key] = result;
  return result;
}

// ===== 計價 =====
async function calculate(session) {
  const r = await getDistance(session.pickup, session.dropoff);

  const delivery =
    PRICING.baseFee +
    Math.ceil(r.km) * PRICING.perKm +
    Math.ceil(r.min) * PRICING.perMinute;

  const urgent = session.isUrgent === '急件' ? PRICING.urgentFee : 0;
  const night = isNightTime() ? PRICING.nightFee : 0;

  const total =
    delivery +
    PRICING.serviceFee +
    urgent +
    night;

  return {
    delivery,
    total,
    night,
  };
}

// ===== webhook =====
app.post('/webhook', line.middleware(config), (req, res) => {
  res.sendStatus(200);

  for (const event of req.body.events) {
    handleEvent(event);
  }
});

// ===== 主流程 =====
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();
  const userId = event.source.userId;

  if (text === '下單') {
    sessions[userId] = { step: 'pickup' };
    return safeReply(event.replyToken, { type: 'text', text: '請輸入取件地點' });
  }

  const s = sessions[userId];

  if (s?.step === 'pickup') {
    s.pickup = text;
    s.step = 'dropoff';
    return safeReply(event.replyToken, { type: 'text', text: '請輸入送達地點' });
  }

  if (s?.step === 'dropoff') {
    s.dropoff = text;
    s.step = 'urgent';
    return safeReply(event.replyToken, { type: 'text', text: '請輸入 一般 / 急件' });
  }

  if (s?.step === 'urgent') {
    s.isUrgent = text;

    await safeReply(event.replyToken, { type: 'text', text: '計算中...' });

    const fee = await calculate(s);

    const orderId = createOrderId();

    orders[orderId] = {
      ...s,
      ...fee,
      orderId,
      status: 'pending',
      createdAt: new Date(),
    };

    delete sessions[userId];

    await safePush(userId, {
      type: 'text',
      text:
        `✅ 訂單建立成功\n金額：${fee.total}\n` +
        (fee.night ? '🌙 含夜間加成\n' : ''),
    });

    await safePush(LINE_GROUP_ID, {
      type: 'text',
      text: `📦 新任務\n金額：${fee.total}`,
    });
  }
}

// ===== 等候費（騎手不可見）=====
function applyWaitingFee(order) {
  order.total += PRICING.waitingFee;
  order.waitingFeeAdded = true;
}

// ===== 自動清理 =====
setInterval(() => {
  const now = Date.now();

  for (const id in orders) {
    if (now - orders[id].createdAt.getTime() > 86400000) {
      delete orders[id];
    }
  }

  for (const u in sessions) {
    delete sessions[u];
  }
}, 3600000);

// ===== 啟動 =====
app.listen(PORT, () => {
  console.log('🔥 UBee OMS V3.8.7 FULL PRO MAX running');
});
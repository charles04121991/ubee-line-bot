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
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ===== 資料 =====
const orders = {};
const sessions = {};

// ===== 計價 =====
const PRICING = {
  base: 99,
  perKm: 8,
  perMin: 2,
  service: 50,
  urgent: 100,
  waiting: 60,
  night: 50,
};

// ===== 工具 =====
const safeReply = (t, m) => client.replyMessage(t, m).catch(()=>{});
const safePush = (to, m) => client.pushMessage(to, m).catch(()=>{});
const createId = () => 'OD' + Date.now();
const $ = (n) => `$${Math.round(n)}`;

// ===== 夜間 =====
function isNight() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  return (h > 18 || (h === 18 && m >= 30)) && h < 22;
}

// ===== 距離 =====
async function getDistance(o, d) {
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(o)}&destinations=${encodeURIComponent(d)}&key=${GOOGLE_MAPS_API_KEY}`;
  const r = await fetch(url);
  const j = await r.json();
  const e = j.rows[0].elements[0];

  return {
    km: e.distance.value / 1000,
    min: e.duration.value / 60,
  };
}

// ===== 計價 =====
async function calc(s) {
  const r = await getDistance(s.pickup, s.dropoff);

  let total =
    PRICING.base +
    Math.ceil(r.km) * PRICING.perKm +
    Math.ceil(r.min) * PRICING.perMin +
    PRICING.service;

  if (s.urgent === '急件') total += PRICING.urgent;
  if (isNight()) total += PRICING.night;

  return total;
}

// ===== Flex UI =====
function flexTask(o) {
  return {
    type: 'flex',
    altText: '新任務',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📦 新任務', weight: 'bold', size: 'lg' },
          { type: 'text', text: `費用 ${$(o.total)}`, color: '#D32F2F', size: 'lg' },
          { type: 'text', text: o.pickup, wrap: true },
          { type: 'text', text: '↓' },
          { type: 'text', text: o.dropoff, wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            action: {
              type: 'postback',
              label: '接單',
              data: `accept=${o.orderId}`,
            },
          },
        ],
      },
    },
  };
}

function flexDone(o) {
  return {
    type: 'flex',
    altText: '完成',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '✅ 任務完成', weight: 'bold', size: 'lg' },
          { type: 'text', text: `金額 ${$(o.total)}`, size: 'xl' },
        ],
      },
    },
  };
}

// ===== webhook =====
app.post('/webhook', line.middleware(config), (req, res) => {
  res.sendStatus(200);
  req.body.events.forEach(handleEvent);
});

// ===== 主流程 =====
async function handleEvent(e) {
  if (e.type === 'postback') return handlePostback(e);
  if (e.type !== 'message') return;

  const t = e.message.text;
  const uid = e.source.userId;

  // ===== 建立 =====
  if (t === '下單') {
    sessions[uid] = { step: 1 };
    return safeReply(e.replyToken, { type: 'text', text: '輸入取件地點' });
  }

  const s = sessions[uid];
  if (!s) return;

  if (s.step === 1) {
    s.pickup = t;
    s.step = 2;
    return safeReply(e.replyToken, { type: 'text', text: '輸入送達地點' });
  }

  if (s.step === 2) {
    s.dropoff = t;
    s.step = 3;
    return safeReply(e.replyToken, { type: 'text', text: '一般 / 急件' });
  }

  if (s.step === 3) {
    s.urgent = t;

    await safeReply(e.replyToken, { type: 'text', text: '計算中...' });

    // 🔥 背景跑（不卡關鍵）
    (async () => {
      const total = await calc(s);
      s.total = total;
      s.step = 4;

      await safePush(uid, {
        type: 'text',
        text: `費用 ${$(total)}\n輸入「確認」建立`,
      });
    })();
  }

  if (t === '確認') {
    const id = createId();

    orders[id] = {
      ...s,
      orderId: id,
      userId: uid,
      total: s.total,
      status: 'pending',
      paymentCode: id.slice(-5),
    };

    delete sessions[uid];

    return safeReply(e.replyToken, {
      type: 'text',
      text: `建立成功\n付款碼 ${orders[id].paymentCode}`,
    });
  }

  // ===== 付款 =====
  if (/^\d{5}$/.test(t)) {
    const o = Object.values(orders).find(x => x.userId === uid && !x.paid);

    if (!o) return;

    if (t === o.paymentCode) {
      o.paid = true;

      await safeReply(e.replyToken, { type: 'text', text: '付款成功' });

      return safePush(LINE_GROUP_ID, flexTask(o));
    }
  }
}

// ===== Postback =====
async function handlePostback(e) {
  const data = e.postback.data;
  const uid = e.source.userId;

  if (data.startsWith('accept=')) {
    const id = data.split('=')[1];
    const o = orders[id];

    if (!o || o.status !== 'pending') return;

    o.driverId = uid;
    o.status = 'accepted';

    return safeReply(e.replyToken, { type: 'text', text: '已接單' });
  }

  if (data.startsWith('complete=')) {
    const id = data.split('=')[1];
    const o = orders[id];

    o.status = 'done';

    await safePush(o.userId, flexDone(o));
  }
}

app.listen(PORT, () => {
  console.log('🔥 UBee PRO UI RUNNING');
});
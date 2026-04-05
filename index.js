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
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;

// ===== 基本工具 =====
const orders = {};
const sessions = {};

const createOrderId = () => 'OD' + Date.now();

function safeReply(token, msg) {
  return client.replyMessage(token, msg).catch(console.error);
}

function safePush(to, msg) {
  return client.pushMessage(to, msg).catch(console.error);
}

// ===== Google 距離 =====
async function getDistanceAndDuration(origin, destination) {
  try {
    const url =
      `https://maps.googleapis.com/maps/api/distancematrix/json` +
      `?origins=${encodeURIComponent(origin)}` +
      `&destinations=${encodeURIComponent(destination)}` +
      `&key=${process.env.GOOGLE_MAPS_API_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    const el = data.rows?.[0]?.elements?.[0];
    if (!el || el.status !== 'OK') throw new Error('distance error');

    return {
      km: el.distance.value / 1000,
      min: el.duration.value / 60
    };
  } catch (e) {
    console.log('Google error fallback');
    return { km: 3, min: 8 };
  }
}

// ===== 計價 =====
async function calculateFees(session) {
  const base = 99;
  const perKm = 8;
  const perMin = 2;
  const service = 50;
  const wait = 60;
  const urgent = session.isUrgent === '急件' ? 100 : 0;

  const result = await getDistanceAndDuration(session.pickup, session.dropoff);

  const distanceFee = result.km * perKm;
  const timeFee = result.min * perMin;

  const delivery = Math.round(base + distanceFee + timeFee);
  const total = delivery + service + wait + urgent;
  const driver = Math.round(total * 0.6);

  return {
    km: result.km.toFixed(1),
    min: Math.round(result.min),
    delivery,
    service,
    wait,
    urgent,
    total,
    driver
  };
}

// ===== Flex（簡化商務版）=====
function flex(title, body, buttons = []) {
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        contents: [
          { type: 'text', text: title, color: '#fff', weight: 'bold', size: 'lg' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'text', text: body, wrap: true }]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: buttons
      }
    }
  };
}

// ===== Webhook =====
app.post('/webhook', line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('UBee OMS V3.8.1 Running');
});

// ===== 主流程 =====
async function handleEvent(event) {
  if (event.type === 'postback') return handlePostback(event);
  if (event.type !== 'message') return;

  const text = event.message.text;
  const userId = event.source.userId;

  if (text === '下單') {
    return safeReply(event.replyToken,
      flex('UBee 下單', '請選擇功能', [
        { type: 'button', action: { type: 'postback', label: '建立任務', data: 'create' } },
        { type: 'button', action: { type: 'postback', label: '立即估價', data: 'quote' } }
      ])
    );
  }

  const session = sessions[userId];
  if (session) return handleInput(event, session, text);
}

// ===== 引導 =====
async function handleInput(event, session, text) {
  const userId = event.source.userId;

  if (session.step === 'pickup') {
    session.pickup = text;
    session.step = 'dropoff';
    return safeReply(event.replyToken, { type: 'text', text: '輸入送達地點' });
  }

  if (session.step === 'dropoff') {
    session.dropoff = text;
    session.step = 'urgent';
    return safeReply(event.replyToken,
      flex('是否急件', '請選擇', [
        { type: 'button', action: { type: 'message', label: '一般', text: '一般' } },
        { type: 'button', action: { type: 'message', label: '急件', text: '急件' } }
      ])
    );
  }

  if (session.step === 'urgent') {
    session.isUrgent = text;
    const fees = await calculateFees(session);

    session.fees = fees;

    return safeReply(event.replyToken,
      flex('報價結果',
        `距離：${fees.km} km\n時間：${fees.min} 分鐘\n\n` +
        `配送費：$${fees.delivery}\n服務費：$50\n等候費：$60\n急件費：$${fees.urgent}\n\n總計：$${fees.total}`,
        [
          { type: 'button', action: { type: 'postback', label: '確認建立任務', data: 'confirm' } }
        ]
      )
    );
  }
}

// ===== Postback =====
async function handlePostback(event) {
  const data = event.postback.data;
  const userId = event.source.userId;

  if (data === 'create' || data === 'quote') {
    sessions[userId] = { step: 'pickup' };
    return safeReply(event.replyToken, { type: 'text', text: '輸入取件地點' });
  }

  if (data === 'confirm') {
    const session = sessions[userId];
    const orderId = createOrderId();

    orders[orderId] = session;

    await safePush(LINE_GROUP_ID,
      flex('新任務',
        `費用：$${session.fees.driver}\n取件：${session.pickup}\n送達：${session.dropoff}`,
        [
          { type: 'button', action: { type: 'postback', label: '接單', data: `accept=${orderId}` } }
        ]
      )
    );

    delete sessions[userId];

    return safeReply(event.replyToken, { type: 'text', text: '已建立任務' });
  }

  if (data.startsWith('accept=')) {
    return safeReply(event.replyToken, { type: 'text', text: '你已接單' });
  }
}

// ===== 啟動 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('UBee OMS V3.8.1 Running'));
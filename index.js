require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();

// ===== 資料庫 =====
const DB_FILE = './orders.json';

function loadOrders() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE));
    }
  } catch (e) {
    console.error(e);
  }
  return {};
}

function saveOrders() {
  fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2));
}

const orders = loadOrders();
const sessions = {};

// ===== LINE =====
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

// ===== 設定 =====
const PORT = process.env.PORT || 3000;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ===== 工具 =====
const createOrderId = () =>
  'OD' + Date.now() + Math.floor(Math.random() * 1000);

function textMessage(text) {
  return { type: 'text', text };
}

function safeReply(token, msg) {
  return client.replyMessage(token, msg);
}

function safePush(to, msg) {
  return client.pushMessage(to, msg);
}

// ===== Flex =====
function mainMenu() {
  return {
    type: 'flex',
    altText: 'UBee',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: 'UBee 城市任務', weight: 'bold', size: 'xl' },
          {
            type: 'button',
            action: { type: 'message', label: '下單', text: '下單' },
          },
        ],
      },
    },
  };
}

function driverCard(order) {
  return {
    type: 'flex',
    altText: '新任務',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📦 新任務', weight: 'bold' },
          { type: 'text', text: order.pickup },
          { type: 'text', text: order.dropoff },
          {
            type: 'text',
            text: `💰 可得：$${order.driverFee}`,
            weight: 'bold',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            action: {
              type: 'postback',
              label: '接單',
              data: `accept=${order.orderId}`,
            },
          },
        ],
      },
    },
  };
}

// ===== 距離 =====
async function getDistance(origin, destination) {
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(
    origin
  )}&destinations=${encodeURIComponent(
    destination
  )}&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  return data.rows[0].elements[0].distance.value / 1000;
}

// ===== 建立訂單 =====
async function createOrder(event, session) {
  const orderId = createOrderId();

  const total = session.totalFee;
  const driverFee = Math.round(total * 0.6);

  orders[orderId] = {
    orderId,
    userId: event.source.userId,
    pickup: session.pickup,
    dropoff: session.dropoff,
    totalFee: total,
    driverFee: driverFee,
    status: 'pending',
    paymentStatus: 'unpaid',
    paymentCode: orderId.slice(-5),
  };

  saveOrders();

  await safePush(LINE_GROUP_ID, driverCard(orders[orderId]));

  return safeReply(
    event.replyToken,
    textMessage(`✅ 任務已建立\n訂單編號：${orderId}\n金額：$${total}`)
  );
}

// ===== 主流程 =====
async function handleEvent(event) {
  const text = event.message?.text;
  const userId = event.source.userId;

  if (text === '主選單') {
    return safeReply(event.replyToken, mainMenu());
  }

  if (text === '下單') {
    sessions[userId] = { step: 'pickup' };
    return safeReply(event.replyToken, textMessage('請輸入取件地點'));
  }

  const session = sessions[userId];

  if (session) {
    if (session.step === 'pickup') {
      session.pickup = text;
      session.step = 'dropoff';
      return safeReply(event.replyToken, textMessage('請輸入送達地點'));
    }

    if (session.step === 'dropoff') {
      session.dropoff = text;

      const km = await getDistance(session.pickup, session.dropoff);
      session.totalFee = Math.round(100 + km * 10);

      return createOrder(event, session);
    }
  }

  // ===== 騎手接單 =====
  if (event.type === 'postback') {
    const data = event.postback.data;

    if (data.startsWith('accept=')) {
      const orderId = data.split('=')[1];
      const order = orders[orderId];

      if (!order || order.status !== 'pending') {
        return safeReply(event.replyToken, textMessage('⚠️ 已被接單'));
      }

      order.status = 'accepted';
      order.driverId = userId;

      saveOrders();

      await safePush(order.userId, textMessage('✅ 已有騎手接單'));

      return safeReply(event.replyToken, textMessage('✅ 接單成功'));
    }
  }
}

// ===== webhook =====
app.post('/webhook', line.middleware(config), (req, res) => {
  res.sendStatus(200);
  Promise.all(req.body.events.map(handleEvent));
});

app.listen(PORT, () => {
  console.log('🚀 UBee V3.8.7 PRO MAX running');
});
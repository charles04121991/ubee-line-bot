require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');

// ✅ Firebase
const admin = require('firebase-admin');

let db = null;

try {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString()
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  db = admin.firestore();
  console.log('✅ Firebase 初始化成功');
} catch (e) {
  console.error('❌ Firebase 初始化失敗', e);
  process.exit(1);
}

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('❌ 缺少 LINE 設定');
  process.exit(1);
}

const client = new line.Client(config);

const PORT = process.env.PORT || 3000;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
const LINE_FINISH_GROUP_ID = process.env.LINE_FINISH_GROUP_ID || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ===== Firebase collections =====
const COL_ORDERS = 'orders';
const COL_SESSIONS = 'sessions';
const COL_SYSTEM = 'system';

// ===== 快取（仍保留，但同步Firebase）=====
const userSessions = {};
const orders = {};
let orderCounter = 1;

// ===== 初始化讀取 Firebase =====
async function loadFromFirebase() {
  const snapshot = await db.collection(COL_ORDERS).get();
  snapshot.forEach(doc => {
    orders[doc.id] = doc.data();
  });

  const sys = await db.collection(COL_SYSTEM).doc('counter').get();
  if (sys.exists) {
    orderCounter = sys.data().value || 1;
  }

  console.log('✅ Firebase 資料載入完成');
}

// ===== 工具 =====
async function saveOrder(order) {
  await db.collection(COL_ORDERS).doc(order.id).set(order);
}

async function saveSession(userId, session) {
  await db.collection(COL_SESSIONS).doc(userId).set(session);
}

async function deleteSession(userId) {
  await db.collection(COL_SESSIONS).doc(userId).delete();
}

async function generateOrderId() {
  const ref = db.collection(COL_SYSTEM).doc('counter');

  const result = await db.runTransaction(async (t) => {
    const doc = await t.get(ref);
    let value = 1;

    if (doc.exists) {
      value = doc.data().value + 1;
    }

    t.set(ref, { value });

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');

    return `UB${yyyy}${mm}${dd}${String(value).padStart(4, '0')}`;
  });

  return result;
}

function createTextMessage(text) {
  return { type: 'text', text };
}

// ===== Google Maps =====
async function getDistanceMatrix(origin, destination) {
  const url =
    'https://maps.googleapis.com/maps/api/distancematrix/json' +
    `?origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(destination)}` +
    `&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  const el = data.rows?.[0]?.elements?.[0];

  return {
    distance: el.distance.value,
    duration: el.duration.value,
  };
}

// ===== 建立任務（簡化版核心）=====
async function createOrder(userId, draft) {
  const orderId = await generateOrderId();

  const distance = await getDistanceMatrix(
    draft.pickupAddress,
    draft.dropoffAddress
  );

  const order = {
    id: orderId,
    customerId: userId,
    status: 'pending',
    ...draft,
    createdAt: Date.now(),
  };

  orders[orderId] = order;
  await saveOrder(order);

  return order;
}

// ===== Event =====
async function handleEvent(event) {
  if (event.type === 'message') {
    const text = event.message.text;
    const userId = event.source.userId;

    if (text === '建立任務') {
      userSessions[userId] = { step: 'pickup' };
      await saveSession(userId, userSessions[userId]);

      return client.replyMessage(event.replyToken, [
        createTextMessage('請輸入取件地址'),
      ]);
    }

    const session = userSessions[userId];

    if (!session) {
      return client.replyMessage(event.replyToken, [
        createTextMessage('請輸入「建立任務」開始'),
      ]);
    }

    if (session.step === 'pickup') {
      session.pickupAddress = text;
      session.step = 'dropoff';
      await saveSession(userId, session);

      return client.replyMessage(event.replyToken, [
        createTextMessage('請輸入送達地址'),
      ]);
    }

    if (session.step === 'dropoff') {
      session.dropoffAddress = text;

      const order = await createOrder(userId, session);

      await deleteSession(userId);
      delete userSessions[userId];

      await client.replyMessage(event.replyToken, [
        createTextMessage(`訂單已建立：${order.id}`),
      ]);

      await client.pushMessage(LINE_GROUP_ID, [
        createTextMessage(`新任務：${order.id}`),
      ]);
    }
  }
}

// ===== Webhook =====
app.post('/webhook', line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.send('OK');
});

app.listen(PORT, async () => {
  await loadFromFirebase();
  console.log('✅ 系統啟動成功');
});

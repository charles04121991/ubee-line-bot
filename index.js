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

const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const URGENT_FEE = 100;
const SERVICE_FEE = 50;
const FIXED_TAX = 15;

const userSessions = new Map();

// ===== Web =====
app.get('/', (req, res) => {
  res.status(200).send('UBee V3.1 DEBUG VERSION');
});

// ===== Webhook =====
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

// ===== 主流程 =====
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();

  if (event.source.type === 'user') {
    return handleUser(event, text);
  }
}

// ===== 客戶端 =====
async function handleUser(event, text) {
  const userId = event.source.userId;
  const session = userSessions.get(userId) || {};

  if (text === '建立任務') {
    userSessions.set(userId, { step: 'pickup' });
    return reply(event, '請輸入取件地點：');
  }

  if (!session.step) {
    return reply(event, '請輸入「建立任務」開始');
  }

  // ===== 流程 =====
  if (session.step === 'pickup') {
    session.pickup = text;
    session.step = 'pickupPhone';
    return reply(event, '請輸入取件電話：');
  }

  if (session.step === 'pickupPhone') {
    session.pickupPhone = text;
    session.step = 'drop';
    return reply(event, '請輸入送達地點：');
  }

  if (session.step === 'drop') {
    session.drop = text;
    session.step = 'dropPhone';
    return reply(event, '請輸入送達電話：');
  }

  if (session.step === 'dropPhone') {
    session.dropPhone = text;
    session.step = 'item';
    return reply(event, '請輸入物品內容：');
  }

  if (session.step === 'item') {
    session.item = text;
    session.step = 'urgent';
    return reply(event, '請輸入：一般 / 急件');
  }

  if (session.step === 'urgent') {
    session.urgent = text;
    session.step = 'note';
    return reply(event, '備註（沒有輸入：無）：');
  }

  if (session.step === 'note') {
    session.note = text;

    const deliveryFee = 200;
    const urgentFee = session.urgent === '急件' ? URGENT_FEE : 0;
    const total = deliveryFee + SERVICE_FEE + urgentFee + FIXED_TAX;

    session.price = total;
    session.step = 'confirm';

    userSessions.set(userId, session);

    return reply(
      event,
      `📦 UBee 任務確認

取件：${session.pickup}
送達：${session.drop}
物品：${session.item}
急件：${session.urgent}
備註：${session.note}

總計：$${total}

請輸入「確認送出」`
    );
  }

  // ===== 🔥 核心：確認送出 =====
  if (text === '確認送出') {
    console.log('================ DISPATCH START =================');
    console.log('LINE_GROUP_ID:', LINE_GROUP_ID);

    const groupMsg = `📦 UBee 新任務

取件：${session.pickup}
送達：${session.drop}
物品：${session.item}
急件：${session.urgent}`;

    console.log('groupMsg:', groupMsg);

    try {
      await client.pushMessage(LINE_GROUP_ID, {
        type: 'text',
        text: groupMsg,
      });

      console.log('✅ pushMessage success');

      userSessions.delete(userId);

      return reply(event, '✅ 已派單到群組');
    } catch (err) {
      console.error('❌ pushMessage failed:');
      console.error(JSON.stringify(err, null, 2));

      return reply(event, '❌ 派單失敗，請看 Render logs');
    }
  }
}

// ===== 工具 =====
function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text,
  });
}

// ===== Start =====
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
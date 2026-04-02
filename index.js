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

// ===== 計費 =====
const BASE_FEE = 99;
const URGENT_FEE = 100;
const TAX = 15;

// ===== 任務暫存（V1 用記憶體）=====
let tasks = [];
let taskIdCounter = 1;

// ===== Webhook =====
app.post('/webhook', line.middleware(config), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch(err => {
      console.error(err);
      res.status(500).end();
    });
});

// ===== 主處理 =====
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();

  // ===== 建立任務 =====
  if (text === '建立任務') {
    return reply(event.replyToken,
`請填寫以下資訊：

取件地點：
送達地點：
物品內容：
是否急件（一般/急件）`);
  }

  // ===== 任務解析 + 報價 =====
  if (text.includes('取件地點') && text.includes('送達地點')) {
    const isUrgent = text.includes('急件');

    let fee = BASE_FEE;
    if (isUrgent) fee += URGENT_FEE;

    const total = fee + TAX;

    // 暫存任務
    const task = {
      id: taskIdCounter++,
      content: text,
      fee,
      total,
      status: 'pending_confirm'
    };

    tasks.push(task);

    return reply(event.replyToken,
`📦 預估報價

配送費：$${fee}
稅金：$${TAX}
總計：$${total}

請回覆「確認」建立任務`);
  }

  // ===== 客戶確認 =====
  if (text === '確認') {
    const task = tasks.find(t => t.status === 'pending_confirm');
    if (!task) return reply(event.replyToken, '❌ 沒有待確認任務');

    task.status = 'waiting_dispatch';

    return reply(event.replyToken,
`✅ 任務已建立成功
🕓 等待派單中`);
  }

  // ===== 派單（你用）=====
  if (text.startsWith('派單')) {
    const id = parseInt(text.split(' ')[1]);
    const task = tasks.find(t => t.id === id);

    if (!task) return reply(event.replyToken, '❌ 找不到任務');

    task.status = 'dispatched';

    try {
      await client.pushMessage(LINE_GROUP_ID, {
        type: 'text',
        text:
`📦 UBee 任務

任務編號：${task.id}
費用：$${task.fee}

${task.content}

👉 回覆：接單 10`
      });

      return reply(event.replyToken, '✅ 已派單');
    } catch (err) {
      console.error(err);
      return reply(event.replyToken, '❌ 派單失敗');
    }
  }

  // ===== 騎手接單 =====
  if (text.startsWith('接單')) {
    const eta = text.split(' ')[1] || '10';

    const task = tasks.find(t => t.status === 'dispatched');
    if (!task) return;

    task.status = 'accepted';

    await client.pushMessage(LINE_GROUP_ID, {
      type: 'text',
      text: `✅ 任務 ${task.id} 已接單\n⏱ ETA ${eta} 分鐘`
    });

    return;
  }

  // ===== 狀態更新 =====
  if (['已抵達', '已取件', '已送達'].includes(text)) {
    const task = tasks.find(t => t.status === 'accepted');
    if (!task) return;

    await client.pushMessage(LINE_GROUP_ID, {
      type: 'text',
      text: `📍 任務 ${task.id}：${text}`
    });

    return;
  }

  // ===== 完成 =====
  if (text === '完成') {
    const task = tasks.find(t => t.status === 'accepted');
    if (!task) return;

    task.status = 'done';

    await client.pushMessage(LINE_GROUP_ID, {
      type: 'text',
      text: `🎉 任務 ${task.id} 已完成`
    });

    return;
  }
}

// ===== 安全回覆（防429）=====
async function reply(token, text) {
  try {
    await client.replyMessage(token, {
      type: 'text',
      text
    });
  } catch (err) {
    console.error('Reply Error:', err.message);
  }
}

// ===== 首頁 =====
app.get('/', (req, res) => {
  res.send('UBee OMS V1 Running');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});

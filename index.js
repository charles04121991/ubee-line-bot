const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

// ===== LINE 設定 =====
const config = {
  channelAccessToken: 'YOUR_CHANNEL_ACCESS_TOKEN',
  channelSecret: 'YOUR_CHANNEL_SECRET'
};

const client = new line.Client(config);

// 👉 換成你的群組ID（之後拿）
const GROUP_ID = 'YOUR_GROUP_ID';

// ===== 使用者狀態 =====
const userState = {};

// ===== Webhook =====
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => {
      console.error(err);
      res.status(500).end();
    });
});

// ===== 主邏輯 =====
function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userId = event.source.userId;
  const text = event.message.text;

  // 👉 取得群組ID（只會在群組觸發）
  if (event.source.type === 'group') {
    console.log('群組ID:', event.source.groupId);
  }

  if (!userState[userId]) {
    userState[userId] = { mode: null, step: null, data: {} };
  }

  let state = userState[userId];

  // ======================
  // 建立任務
  // ======================
  if (text === '建立任務') {
    state.mode = 'order';
    state.step = 'pickup_address';
    return reply(event.replyToken, '請輸入【取件地點】');
  }

  // ======================
  // 立即估價
  // ======================
  if (text === '立即估價') {
    state.mode = 'estimate';
    state.step = 'pickup_address';
    return reply(event.replyToken, `
您可以先快速取得任務費用估算，請提供：

📍取件地點：
    `);
  }

  // ======================
  // 表單流程
  // ======================

  if (state.step === 'pickup_address') {
    state.data.pickup = text;
    state.step = 'delivery_address';
    return reply(event.replyToken, '請輸入【送達地點】');
  }

  if (state.step === 'delivery_address') {
    state.data.delivery = text;
    state.step = 'item';
    return reply(event.replyToken, '請輸入【物品內容】');
  }

  if (state.step === 'item') {
    state.data.item = text;
    state.step = 'urgent';
    return reply(event.replyToken, '是否為急件？（是 / 否）');
  }

  if (state.step === 'urgent') {
    state.data.urgent = text;

    // 👉 估價模式
    if (state.mode === 'estimate') {
      const result = calculatePrice(state.data);

      userState[userId] = null;

      return reply(event.replyToken, `
📌 預估費用

💰費用：$${result.fee}
📏距離：${result.distance}

（此為預估，實際以最終報價為準）
      `);
    }

    // 👉 下單模式繼續
    state.step = 'pickup_phone';
    return reply(event.replyToken, '請輸入【取件電話】');
  }

  if (state.step === 'pickup_phone') {
    state.data.pickup_phone = text;
    state.step = 'delivery_phone';
    return reply(event.replyToken, '請輸入【送達電話】');
  }

  if (state.step === 'delivery_phone') {
    state.data.delivery_phone = text;
    state.step = 'note';
    return reply(event.replyToken, '請輸入【備註】（沒有可輸入 無）');
  }

  if (state.step === 'note') {
    state.data.note = text;

    const order = state.data;
    const result = calculatePrice(order);

    // 👉 客戶訊息
    const customerMsg = `
✅ 任務建立完成

📍取件：${order.pickup}
📍送達：${order.delivery}
📦物品：${order.item}
⚡急件：${order.urgent}

💰費用：$${result.fee}
    `;

    // 👉 騎手群訊息
    const riderMsg = `
🚨 UBee 派單

💰費用：$${result.fee}
📏距離：${result.distance}

📍取件地點：${order.pickup}
📍送達地點：${order.delivery}

📦物品：${order.item}
⚡急件：${order.urgent}
    `;

    userState[userId] = null;

    return Promise.all([
      reply(event.replyToken, customerMsg),
      pushToGroup(riderMsg)
    ]);
  }

  return reply(event.replyToken, '請輸入：建立任務 或 立即估價');
}

// ===== 回覆函數 =====
function reply(token, text) {
  return client.replyMessage(token, {
    type: 'text',
    text: text
  });
}

// ===== 推送群組 =====
function pushToGroup(message) {
  if (GROUP_ID === 'YOUR_GROUP_ID') return Promise.resolve();
  return client.pushMessage(GROUP_ID, {
    type: 'text',
    text: message
  });
}

// ===== 計價系統 =====
function calculatePrice(data) {
  let base = 100;
  let distanceFee = 80;
  let timeFee = 50;
  let urgentFee = data.urgent === '是' ? 100 : 0;

  const total = base + distanceFee + timeFee + urgentFee;

  return {
    fee: total,
    distance: '5公里 / 12分鐘'
  };
}

// ===== 啟動 =====
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('Server running on ' + port);
});
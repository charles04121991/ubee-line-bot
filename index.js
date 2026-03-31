require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

app.get('/', (req, res) => {
  res.status(200).send('UBee bot v8');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const rawText = event.message.text || '';
  const text = rawText.trim();

  console.log('收到文字=', JSON.stringify(text));

  // ===== 1️⃣ 立即估價 =====
  if (text.includes('立即估價')) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
`請依照以下格式填寫估價資訊：

取件地點：
送達地點：
物品內容：
是否急件（一般 / 急件）：
備註：`
    });
  }

  // ===== 2️⃣ 建立任務 =====
  if (text.includes('建立任務')) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
`請依照以下格式填寫任務資料：

取件地點：
取件電話：

送達地點：
送達電話：

物品內容：
是否急件（一般 / 急件）：
備註：

※ 不配送食品、違禁品或危險物品`
    });
  }

  // ===== 3️⃣ 判斷表單 =====
  const isQuoteForm =
    text.includes('取件地點：') &&
    text.includes('送達地點：') &&
    text.includes('物品內容：') &&
    text.includes('是否急件：');

  const isTaskForm =
    text.includes('取件地點：') &&
    text.includes('取件電話：') &&
    text.includes('送達地點：') &&
    text.includes('送達電話：') &&
    text.includes('物品內容：') &&
    text.includes('是否急件：');

  // ===== 4️⃣ 任務建立 =====
  if (isTaskForm) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
`您的任務已建立成功，我們會立即為您派單。

如需再次建立任務或立即估價，請輸入：
・建立任務
・立即估價`
    });
  }

  // ===== 5️⃣ 估價系統 =====
  if (isQuoteForm) {
    const formData = parseForm(text);

    const urgentText = formData['是否急件'] || '';

    // ✅ 修正急件判斷（不會再誤判）
    const isUrgent =
      urgentText.includes('急件') && !urgentText.includes('一般');

    // ===== 正式費率 =====
    const baseFee = 99;
    const perKmFee = 6;
    const perMinuteFee = 3;
    const urgentFee = isUrgent ? 100 : 0;
    const crossZoneFee = 25;

    // ⚠️ 目前測試值（下一步會換成 Google Maps）
    const distanceKm = 10;
    const durationMin = 12;
    const isCrossZone = true;

    const distanceFee = distanceKm * perKmFee;
    const timeFee = durationMin * perMinuteFee;
    const zoneFee = isCrossZone ? crossZoneFee : 0;

    const deliveryFee =
      baseFee + distanceFee + timeFee + urgentFee + zoneFee;

    // ✅ 稅金固定
    const tax = 15;
    const total = deliveryFee + tax;

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
`配送費：$${deliveryFee}
稅金：$${tax}
總計：$${total}`
    });
  }

  // ===== 6️⃣ 其他訊息 =====
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `你剛剛說：${text}`
  });
}

// ===== 表單解析 =====
function parseForm(text) {
  const result = {};
  const lines = text.split('\n');

  for (const line of lines) {
    const idx = line.indexOf('：');
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    result[key] = value;
  }

  return result;
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

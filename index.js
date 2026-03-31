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
  res.status(200).send('UBee bot v6');
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

  // ===== 1) 關鍵字：立即估價 =====
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

  // ===== 2) 關鍵字：建立任務 =====
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

  // ===== 3) 使用者貼上「估價表單」後，自動報價 =====
  const isQuoteForm =
    text.includes('取件地點：') &&
    text.includes('送達地點：') &&
    text.includes('物品內容：') &&
    text.includes('是否急件');

  const isTaskForm =
    text.includes('取件地點：') &&
    text.includes('取件電話：') &&
    text.includes('送達地點：') &&
    text.includes('送達電話：') &&
    text.includes('物品內容：') &&
    text.includes('是否急件');

  // 先判斷任務單，因為任務單欄位比較完整
  if (isTaskForm) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
`您的任務已建立成功，我們會立即為您派單。

如需再次建立任務或立即估價，請直接輸入：
・建立任務
・立即估價`
    });
  }

  // 再判斷估價單
  if (isQuoteForm) {
    const urgent = text.includes('急件');
    const deliveryFee = urgent ? 400 : 300;
    const tax = Math.round(deliveryFee * 0.05);
    const total = deliveryFee + tax;

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
`配送費：$${deliveryFee}
稅金：$${tax}
總計：$${total}`
    });
  }

  // ===== 4) 其他訊息 =====
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `你剛剛說：${text}`
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

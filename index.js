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
  res.status(200).send('UBee bot v5');
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

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `你剛剛說：${text}`
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

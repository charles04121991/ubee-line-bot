const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

// 👉 測試首頁（Render用）
app.get('/', (req, res) => {
  res.send('UBee bot running');
});

// 👉 Webhook
app.post('/webhook', line.middleware(config), (req, res) => {
  console.log('收到 webhook');

  res.status(200).send('OK'); // 👉 先強制回200

  req.body.events.forEach(event => {
    handleEvent(event);
  });
});

// 👉 處理訊息
function handleEvent(event) {
  console.log('event:', event);

  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  client.replyMessage(event.replyToken, {
    type: 'text',
    text: '我有收到！'
  }).catch(err => console.error('reply錯誤:', err));
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('Server running on ' + port);
});
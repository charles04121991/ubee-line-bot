const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

// 測試首頁（Render會用）
app.get('/', (req, res) => {
  res.send('UBee Webhook OK');
});

// Webhook
app.post('/webhook', line.middleware(config), (req, res) => {
  res.status(200).send('OK'); // 👉 一定先回200

  req.body.events.forEach(event => {
    handleEvent(event);
  });
});

function handleEvent(event) {
  if (event.type !== 'message') return;

  client.replyMessage(event.replyToken, {
    type: 'text',
    text: '我有收到！'
  }).catch(err => console.error(err));
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('Server running on ' + port);
});
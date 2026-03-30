const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

app.get('/', (req, res) => {
  res.send('UBee Webhook OK');
});

app.post('/webhook', line.middleware(config), (req, res) => {
  res.status(200).send('OK');

  req.body.events.forEach((event) => {
    handleEvent(event);
  });
});

function handleEvent(event) {
  console.log('收到 event:', JSON.stringify(event, null, 2));

  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  client.replyMessage(event.replyToken, {
    type: 'text',
    text: '我有收到！'
  }).catch((err) => {
    console.error('reply error:', err);
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('Server running on ' + port);
});
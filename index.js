require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('❌ 缺少 CHANNEL_ACCESS_TOKEN 或 CHANNEL_SECRET');
  process.exit(1);
}

const client = new line.Client(config);
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.status(200).send('UBee groupId finder v2');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.source && event.source.type === 'group') {
        console.log('GROUP_ID=' + event.source.groupId);
      }

      if (event.type === 'message' && event.message.type === 'text') {
        await handleEvent(event);
      }
    }

    res.status(200).end();
  } catch (err) {
    console.error('WEBHOOK_ERROR:', err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.source.type === 'group') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        `✅ 已收到群組訊息\n` +
        `你剛剛說的是：${event.message.text}\n\n` +
        `groupId 已經寫進 Render log\n` +
        `請去 Render 的 Logs 查看`,
    });
  }

  if (event.source.type === 'user') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '這支程式目前是用來抓 groupId 的，請到群組內傳訊息。',
    });
  }

  return null;
}

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
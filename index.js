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

// 首頁測試
app.get('/', (req, res) => {
  res.status(200).send('UBee groupId finder is running');
});

// Webhook
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    console.log('================ WEBHOOK START ================');
    console.log('📦 完整 webhook body：');
    console.log(JSON.stringify(req.body, null, 2));

    const events = req.body.events || [];

    for (const event of events) {
      console.log('---------------- EVENT START ----------------');
      console.log('event.type =', event.type);
      console.log('event.source =', JSON.stringify(event.source, null, 2));

      if (event.source) {
        if (event.source.type === 'group') {
          console.log('✅ 抓到 GROUP ID：', event.source.groupId);
        }

        if (event.source.type === 'room') {
          console.log('✅ 抓到 ROOM ID：', event.source.roomId);
        }

        if (event.source.userId) {
          console.log('👤 userId =', event.source.userId);
        }
      }

      await handleEvent(event);
      console.log('---------------- EVENT END ----------------');
    }

    console.log('================ WEBHOOK END =================');
    res.status(200).end();
  } catch (err) {
    console.error('❌ Webhook 錯誤:', err);
    res.status(500).end();
  }
});

// 事件處理
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const text = event.message.text.trim();

  // 只要有人在群組講話，就回覆一段簡單訊息
  if (event.source.type === 'group') {
    const groupId = event.source.groupId || '找不到 groupId';

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        `✅ 已收到群組訊息\n` +
        `你剛剛說的是：${text}\n\n` +
        `groupId 已經寫進 Render log\n` +
        `請去 Render 的 Logs 查看`,
    });
  }

  // 如果是 1 對 1 聊天
  if (event.source.type === 'user') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '這支程式目前是用來抓 groupId 的，請把官方帳號拉進群組後，在群組內傳訊息。',
    });
  }

  // 如果是多人聊天室 room
  if (event.source.type === 'room') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '已收到 room 訊息，roomId 已寫入 Render log。',
    });
  }

  return null;
}

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
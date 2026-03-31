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

// ===== 工具函式 =====
function normalizeText(text) {
  return text.replace(/\r/g, '').trim();
}

function extractField(text, labels) {
  for (const label of labels) {
    const regex = new RegExp(`${label}\\s*[:：]\\s*(.+)`);
    const match = text.match(regex);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return '';
}

function isTaskForm(text) {
  return (
    text.includes('取件地點') &&
    text.includes('送達地點') &&
    text.includes('物品內容') &&
    text.includes('是否急件')
  );
}

function parseTaskForm(text) {
  const pickupAddress = extractField(text, ['取件地點']);
  const pickupPhone = extractField(text, ['取件電話', '取件人 / 電話', '取件人/電話']);
  const deliveryAddress = extractField(text, ['送達地點']);
  const deliveryPhone = extractField(text, ['送達電話', '收件人 / 電話', '收件人/電話']);
  const item = extractField(text, ['物品內容']);
  const urgent = extractField(text, ['是否急件']);
  const note = extractField(text, ['備註']);

  return {
    pickupAddress,
    pickupPhone,
    deliveryAddress,
    deliveryPhone,
    item,
    urgent,
    note,
  };
}

function buildDispatchMessage(task) {
  const urgentText = task.urgent || '一般';

  return `【UBee 派單通知】

取件：
${task.pickupAddress || '未填寫'}

送達：
${task.deliveryAddress || '未填寫'}

物品：
${task.item || '未填寫'}

急件：
${urgentText}

取件電話：
${task.pickupPhone || '未填寫'}

送達電話：
${task.deliveryPhone || '未填寫'}

備註：
${task.note || '無'}`;
}

// ===== 路由 =====
app.get('/', (req, res) => {
  res.status(200).send('UBee bot v1 running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.status(500).end();
  }
});

// ===== 核心處理 =====
async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') {
      return null;
    }

    const userText = normalizeText(event.message.text);

    // 1. 建立任務
    if (userText === '建立任務') {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text:
`請填寫以下資料：

取件地點：
取件電話：

送達地點：
送達電話：

物品內容：
是否急件（一般 / 急件）：

備註：`
      });
    }

    // 2. 立即估價
    if (userText === '立即估價') {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text:
`請填寫以下資訊，我們立即為您估價：

取件地點：
送達地點：
物品內容：
是否急件（一般 / 急件）：`
      });
    }

    // 3. 使用者送出任務表單
    if (isTaskForm(userText)) {
      const task = parseTaskForm(userText);

      // 派送到群組
      if (LINE_GROUP_ID) {
        const dispatchMessage = buildDispatchMessage(task);

        try {
          await client.pushMessage(LINE_GROUP_ID, {
            type: 'text',
            text: dispatchMessage,
          });
          console.log('✅ 派單成功推送到群組');
        } catch (pushErr) {
          console.error('❌ 派單推送失敗:', pushErr);
        }
      } else {
        console.warn('⚠️ 未設定 LINE_GROUP_ID，略過群組派單');
      }

      // 回覆客人
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '您的任務已建立成功，我們會立即為您派單。'
      });
    }

    return null;
  } catch (err) {
    console.error('❌ handleEvent error:', err);
    return null;
  }
}

// ===== 啟動 =====
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

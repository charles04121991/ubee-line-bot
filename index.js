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
const LINE_GROUP_ID = process.env.LINE_GROUP_ID || '';

// =========================
// 基本首頁
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee debug bot running');
});

// =========================
// Webhook
// =========================
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    console.log('📩 收到 webhook events 數量:', events.length);

    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('❌ webhook 處理失敗:', err);
    res.status(500).end();
  }
});

// =========================
// 主事件處理
// =========================
async function handleEvent(event) {
  try {
    console.log('==============================');
    console.log('📌 收到事件 raw:');
    console.log(JSON.stringify(event, null, 2));
    console.log('==============================');

    if (event.type !== 'message' || event.message.type !== 'text') {
      console.log('ℹ️ 非文字訊息，略過');
      return null;
    }

    const userText = event.message.text.trim();
    const sourceType = event.source?.type || 'unknown';

    console.log('📝 使用者訊息:', userText);
    console.log('📍 source.type:', sourceType);

    if (sourceType === 'group') {
      console.log('🟡 偵測到群組訊息');
      console.log('🟡 groupId =', event.source.groupId || '(抓不到)');
    }

    if (sourceType === 'room') {
      console.log('🟡 偵測到多人聊天室訊息');
      console.log('🟡 roomId =', event.source.roomId || '(抓不到)');
    }

    // =========================
    // 指令：測試群組ID
    // =========================
    if (userText === '測試群組ID') {
      let replyText = `source.type：${sourceType}\n`;

      if (event.source.groupId) {
        replyText += `groupId：${event.source.groupId}`;
      } else if (event.source.roomId) {
        replyText += `roomId：${event.source.roomId}`;
      } else {
        replyText += '這不是群組/多人聊天室，抓不到群組ID';
      }

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: replyText,
      });
    }

    // =========================
    // 指令：測試回覆
    // =========================
    if (userText === '測試回覆') {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '✅ webhook 正常，官方帳號可正常回覆',
      });
    }

    // =========================
    // 指令：測試派單
    // =========================
    if (userText === '測試派單') {
      // 先回客人
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '✅ 已收到測試指令，正在嘗試派單到群組',
      });

      // 再派送到群組
      await pushDebugOrderToGroup();

      return null;
    }

    // =========================
    // 一般訊息
    // =========================
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        '請輸入以下任一指令測試：\n\n' +
        '1. 測試回覆\n' +
        '2. 測試群組ID\n' +
        '3. 測試派單',
    });
  } catch (err) {
    console.error('❌ handleEvent 錯誤:', err?.response?.data || err.message || err);
    return null;
  }
}

// =========================
// 派單到群組
// =========================
async function pushDebugOrderToGroup() {
  try {
    if (!LINE_GROUP_ID) {
      console.error('❌ LINE_GROUP_ID 沒有設定');
      return;
    }

    const message = {
      type: 'text',
      text:
        '📦 UBee 測試派單通知\n\n' +
        '費用：$250\n' +
        '距離：5.2 公里\n\n' +
        '取件：豐原區中正路100號\n' +
        '送達：北屯區崇德路二段88號\n' +
        '物品：文件\n' +
        '急件：一般',
    };

    console.log('🚀 準備 pushMessage 到群組...');
    console.log('📍 LINE_GROUP_ID =', LINE_GROUP_ID);

    const result = await client.pushMessage(LINE_GROUP_ID, message);

    console.log('✅ 派單成功');
    console.log('📨 LINE API 回傳:', result);
  } catch (err) {
    console.error('❌ 派單失敗');
    console.error('❌ 錯誤內容:', err?.response?.data || err.message || err);
  }
}

// =========================
// 啟動伺服器
// =========================
app.listen(PORT, () => {
  console.log(`🚀 UBee debug bot running on port ${PORT}`);
  console.log('✅ CHANNEL_ACCESS_TOKEN:', config.channelAccessToken ? '已設定' : '未設定');
  console.log('✅ CHANNEL_SECRET:', config.channelSecret ? '已設定' : '未設定');
  console.log('✅ LINE_GROUP_ID:', LINE_GROUP_ID || '未設定');
});

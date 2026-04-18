require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');

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
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
const LINE_FINISH_GROUP_ID = process.env.LINE_FINISH_GROUP_ID || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ⭐ 管理員（你之後會用到）
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

// ===== 基本工具 =====
function safeReply(replyToken, message) {
  return client.replyMessage(replyToken, message).catch((err) => {
    console.error(err);
  });
}

function textMessage(text) {
  return { type: 'text', text };
}

// ===== 主選單 =====
function createMainMenuQuickReply() {
  return {
    type: 'text',
    text: '請選擇功能 👇',
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'message', label: '下單', text: '下單' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '企業', text: '企業' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '我的', text: '我的' },
        },
      ],
    },
  };
}

// ===== 路由 =====
app.get('/', (req, res) => {
  res.send('UBee Running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ===== 主邏輯 =====
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = (event.message.text || '').trim();
  const userId = event.source.userId;

  // =========================
  // ⭐⭐ 查詢自己的 userId ⭐⭐
  // =========================
  if (text === '我的ID') {
    return safeReply(
      event.replyToken,
      textMessage(`你的 userId 是：\n${userId}`)
    );
  }

  // ===== 主選單 =====
  if (text === '主選單' || text === 'menu' || text === '開始') {
    return safeReply(event.replyToken, createMainMenuQuickReply());
  }

  if (text === '下單') {
    return safeReply(event.replyToken, textMessage('這裡是下單流程（略）'));
  }

  if (text === '企業') {
    return safeReply(event.replyToken, textMessage('這裡是企業介紹（略）'));
  }

  if (text === '我的') {
    return safeReply(event.replyToken, textMessage('這裡是會員功能（略）'));
  }

  return safeReply(event.replyToken, createMainMenuQuickReply());
}

// ===== 啟動 =====
app.listen(PORT, () => {
  console.log(`✅ Server running on ${PORT}`);
});
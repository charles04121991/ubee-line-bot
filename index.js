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
const LINE_GROUP_ID = (process.env.LINE_GROUP_ID || '').trim();

// ===== 計費 =====
const BASE_FEE = 99;
const URGENT_FEE = 100;
const TAX = 15;

// ===== 任務暫存（V1 記憶體版）=====
let tasks = [];
let taskIdCounter = 1;

// ===== 派單冷卻（避免 429）=====
let lastPushTime = 0;
const PUSH_COOLDOWN_MS = 5000;

// ===== Webhook =====
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('❌ Webhook Error:', err);
    res.status(500).end();
  }
});

// ===== 主處理 =====
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();

  // ===== 建立任務 =====
  if (text === '建立任務') {
    return safeReply(
      event.replyToken,
      `請填寫以下資訊：

取件地點：
送達地點：
物品內容：
是否急件（一般/急件）`
    );
  }

  // ===== 任務解析 + 報價 =====
  if (text.includes('取件地點') && text.includes('送達地點')) {
    const isUrgent = text.includes('急件');
    let fee = BASE_FEE;

    if (isUrgent) fee += URGENT_FEE;

    const total = fee + TAX;

    const task = {
      id: taskIdCounter++,
      content: text,
      fee,
      total,
      status: 'pending_confirm',
      createdAt: new Date().toISOString(),
      acceptedEta: null,
    };

    tasks.push(task);

    console.log(`🆕 新任務建立：#${task.id}`);

    return safeReply(
      event.replyToken,
      `📦 預估報價

配送費：$${fee}
稅金：$${TAX}
總計：$${total}

請回覆「確認」建立任務`
    );
  }

  // ===== 客戶確認 =====
  if (text === '確認') {
    const task = [...tasks].reverse().find(t => t.status === 'pending_confirm');

    if (!task) {
      return safeReply(event.replyToken, '❌ 沒有待確認任務');
    }

    task.status = 'waiting_dispatch';
    console.log(`✅ 任務確認成功：#${task.id}`);

    return safeReply(
      event.replyToken,
      `✅ 任務已建立成功
🕓 等待派單中`
    );
  }

  // ===== 查詢任務 =====
  if (text === '任務列表') {
    if (tasks.length === 0) {
      return safeReply(event.replyToken, '目前沒有任務');
    }

    const listText = tasks
      .slice(-10)
      .map(t => `#${t.id}｜${t.status}｜$${t.total}`)
      .join('\n');

    return safeReply(
      event.replyToken,
      `📋 最近任務列表

${listText}`
    );
  }

  // ===== 派單 =====
  if (text.startsWith('派單')) {
    const parts = text.split(' ');
    const id = parseInt(parts[1], 10);

    if (!id) {
      return safeReply(event.replyToken, '❌ 請輸入正確格式，例如：派單 1');
    }

    const task = tasks.find(t => t.id === id);

    if (!task) {
      return safeReply(event.replyToken, '❌ 找不到任務');
    }

    if (task.status === 'dispatched') {
      return safeReply(event.replyToken, `⚠️ 任務 ${task.id} 已經派過單了`);
    }

    if (task.status === 'accepted' || task.status === 'picked_up' || task.status === 'delivered' || task.status === 'done') {
      return safeReply(event.replyToken, `⚠️ 任務 ${task.id} 已進入後續流程，不能重新派單`);
    }

    if (task.status !== 'waiting_dispatch') {
      return safeReply(event.replyToken, `⚠️ 任務 ${task.id} 目前狀態為 ${task.status}，不能派單`);
    }

    const now = Date.now();
    if (now - lastPushTime < PUSH_COOLDOWN_MS) {
      return safeReply(event.replyToken, '⚠️ 請不要連續派單太快，請稍等 5 秒再試一次');
    }

    if (!LINE_GROUP_ID) {
      return safeReply(event.replyToken, '❌ 未設定 LINE_GROUP_ID');
    }

    try {
      console.log('=== 派單開始 ===');
      console.log('Task ID:', task.id);
      console.log('LINE_GROUP_ID:', LINE_GROUP_ID);

      await client.pushMessage(LINE_GROUP_ID, {
        type: 'text',
        text:
`📦 UBee 任務

任務編號：${task.id}
費用：$${task.fee}

${task.content}

👉 回覆：接單 10`
      });

      lastPushTime = Date.now();
      task.status = 'dispatched';

      console.log(`✅ 任務 #${task.id} 已派單到群組`);

      return safeReply(event.replyToken, `✅ 任務 ${task.id} 已派單到群組`);
    } catch (err) {
      const statusCode =
        err?.statusCode ||
        err?.originalError?.response?.status ||
        err?.response?.status;

      console.error('❌ 派單失敗:', err?.originalError || err?.message || err);

      if (statusCode === 429) {
        return safeReply(event.replyToken, '⚠️ LINE 暫時限制發送（429），請先等幾分鐘再重新派單一次');
      }

      return safeReply(event.replyToken, '❌ 派單失敗，請查看 Render Logs');
    }
  }

  // ===== 群組接單 =====
  if (text.startsWith('接單')) {
    const parts = text.split(' ');
    const eta = parts[1] || '10';

    const task = tasks.find(t => t.status === 'dispatched');

    if (!task) return;

    task.status = 'accepted';
    task.acceptedEta = eta;

    try {
      await client.pushMessage(LINE_GROUP_ID, {
        type: 'text',
        text: `✅ 任務 ${task.id} 已接單\n⏱ ETA ${eta} 分鐘`
      });

      console.log(`✅ 任務 #${task.id} 已接單，ETA ${eta}`);
    } catch (err) {
      console.error('❌ 接單推播失敗:', err?.originalError || err?.message || err);
    }

    return;
  }

  // ===== 狀態更新 =====
  if (text === '已抵達') {
    const task = tasks.find(t => t.status === 'accepted');
    if (!task) return;

    task.status = 'arrived';

    try {
      await client.pushMessage(LINE_GROUP_ID, {
        type: 'text',
        text: `📍 任務 ${task.id}：已抵達`
      });
    } catch (err) {
      console.error('❌ 已抵達推播失敗:', err?.originalError || err?.message || err);
    }

    return;
  }

  if (text === '已取件') {
    const task = tasks.find(t => t.status === 'arrived' || t.status === 'accepted');
    if (!task) return;

    task.status = 'picked_up';

    try {
      await client.pushMessage(LINE_GROUP_ID, {
        type: 'text',
        text: `📦 任務 ${task.id}：已取件`
      });
    } catch (err) {
      console.error('❌ 已取件推播失敗:', err?.originalError || err?.message || err);
    }

    return;
  }

  if (text === '已送達') {
    const task = tasks.find(t => t.status === 'picked_up');
    if (!task) return;

    task.status = 'delivered';

    try {
      await client.pushMessage(LINE_GROUP_ID, {
        type: 'text',
        text: `🚚 任務 ${task.id}：已送達`
      });
    } catch (err) {
      console.error('❌ 已送達推播失敗:', err?.originalError || err?.message || err);
    }

    return;
  }

  // ===== 完成 =====
  if (text === '完成') {
    const task = tasks.find(t => t.status === 'delivered' || t.status === 'picked_up' || t.status === 'accepted');

    if (!task) return;

    task.status = 'done';

    try {
      await client.pushMessage(LINE_GROUP_ID, {
        type: 'text',
        text: `🎉 任務 ${task.id} 已完成`
      });

      console.log(`🎉 任務 #${task.id} 已完成`);
    } catch (err) {
      console.error('❌ 完成推播失敗:', err?.originalError || err?.message || err);
    }

    return;
  }
}

// ===== 安全回覆 =====
async function safeReply(replyToken, text) {
  try {
    await client.replyMessage(replyToken, {
      type: 'text',
      text
    });
  } catch (err) {
    const statusCode =
      err?.statusCode ||
      err?.originalError?.response?.status ||
      err?.response?.status;

    console.error('❌ Reply Error:', err?.originalError || err?.message || err);

    if (statusCode === 429) {
      console.error('⚠️ Reply 被 LINE 限流（429）');
    }
  }
}

// ===== 首頁 =====
app.get('/', (req, res) => {
  res.status(200).send('UBee OMS V1 Running');
});

// ===== 啟動 =====
app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});

require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

// 首頁測試
app.get('/', (req, res) => {
  res.status(200).send('UBee bot v1');
});

// Webhook
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(500).end();
  }
});

// 主邏輯
async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') {
      return null;
    }

    const text = (event.message.text || '').trim();

    // 🔍 Debug
    console.log('Event source type:', event.source?.type);
    console.log('Event groupId:', event.source?.groupId || '');
    console.log('Event userId:', event.source?.userId || '');

    // 建立任務
    if (text === '建立任務') {
      return replyText(event.replyToken, createTaskTemplate());
    }

    // 立即估價
    if (text === '立即估價') {
      return replyText(event.replyToken, quoteTemplate());
    }

    const parsed = parseUserInput(text);

    // 建立任務流程
    if (isCreateTaskInput(parsed)) {
      const quote = calculateQuote(parsed);

      const message = [
        '您的任務已建立成功，我們會立即為您派單。',
        '',
        `配送費：$${quote.deliveryFee}`,
        `稅金：$${quote.tax}`,
        `總計：$${quote.total}`,
      ].join('\n');

      await replyText(event.replyToken, message);

      // 🚀 派單到群組（含偵錯）
      const groupId = process.env.LINE_GROUP_ID;

      if (groupId) {
        try {
          const riderFee = Math.round(quote.deliveryFee * 0.6);

          const dispatchMessage = [
            '【UBee 派單通知】',
            '',
            `費用：$${riderFee}`,
            '',
            `取件：${parsed.pickupAddress}`,
            `送達：${parsed.dropoffAddress}`,
            `物品：${parsed.item}`,
            `急件：${quote.urgentText}`,
            parsed.note ? `備註：${parsed.note}` : null,
          ]
            .filter(Boolean)
            .join('\n');

          console.log('Trying push groupId:', groupId);
          console.log('Dispatch message:', dispatchMessage);

          await client.pushMessage(groupId, {
            type: 'text',
            text: dispatchMessage,
          });

          console.log('Push to group success');
        } catch (pushErr) {
          console.error(
            'Push to group failed:',
            pushErr?.response?.data || pushErr.message || pushErr
          );
        }
      } else {
        console.log('LINE_GROUP_ID not set, skip push');
      }

      return null;
    }

    // 立即估價流程
    if (isQuoteInput(parsed)) {
      const quote = calculateQuote(parsed);

      const message = [
        '以下為本次預估費用：',
        '',
        `配送費：$${quote.deliveryFee}`,
        `稅金：$${quote.tax}`,
        `總計：$${quote.total}`,
      ].join('\n');

      return replyText(event.replyToken, message);
    }

    return null;
  } catch (err) {
    console.error('handleEvent Error:', err);
    return replyText(event.replyToken, '系統暫時忙碌中，請稍後再試一次。');
  }
}

// 建立任務模板
function createTaskTemplate() {
  return [
    '請填寫以下資料：',
    '',
    '取件地點：',
    '取件電話：',
    '',
    '送達地點：',
    '送達電話：',
    '',
    '物品內容：',
    '是否急件：一般',
    '備註：',
  ].join('\n');
}

// 估價模板
function quoteTemplate() {
  return [
    '請填寫以下資訊，我們立即為您估價：',
    '',
    '取件地點：',
    '送達地點：',
    '物品內容：',
    '是否急件：一般',
  ].join('\n');
}

// 解析使用者輸入
function parseUserInput(text) {
  const result = {
    pickupAddress: '',
    pickupPhone: '',
    dropoffAddress: '',
    dropoffPhone: '',
    item: '',
    urgent: '',
    note: '',
  };

  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const normalized = line.replace(/：/g, ':');
    const idx = normalized.indexOf(':');
    if (idx === -1) continue;

    const rawKey = normalized.slice(0, idx).trim();
    const value = normalized.slice(idx + 1).trim();
    const key = rawKey.replace(/\s+/g, '');

    if (key.includes('取件地點')) result.pickupAddress = value;
    else if (key.includes('取件電話')) result.pickupPhone = value;
    else if (key.includes('送達地點')) result.dropoffAddress = value;
    else if (key.includes('送達電話')) result.dropoffPhone = value;
    else if (key.includes('物品內容')) result.item = value;
    else if (key.includes('是否急件')) result.urgent = value;
    else if (key.includes('備註')) result.note = value;
  }

  return result;
}

// 判斷建立任務
function isCreateTaskInput(data) {
  return Boolean(
    data.pickupAddress &&
      data.pickupPhone &&
      data.dropoffAddress &&
      data.dropoffPhone &&
      data.item &&
      data.urgent
  );
}

// 判斷估價
function isQuoteInput(data) {
  return Boolean(
    data.pickupAddress &&
      data.dropoffAddress &&
      data.item &&
      data.urgent &&
      !data.pickupPhone &&
      !data.dropoffPhone
  );
}

// 計算費用
function calculateQuote(data) {
  const baseFee = 99;
  const crossDistrictFee =
    isCrossDistrict(data.pickupAddress, data.dropoffAddress) ? 25 : 0;
  const urgentFee = isUrgent(data.urgent) ? 100 : 0;
  const tax = 15;

  const deliveryFee = baseFee + crossDistrictFee + urgentFee;

  return {
    deliveryFee,
    tax,
    total: deliveryFee + tax,
    urgentText: isUrgent(data.urgent) ? '急件' : '一般',
  };
}

// 是否急件
function isUrgent(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('急') || text === '是';
}

// 是否跨區
function isCrossDistrict(from, to) {
  const a = extractDistrict(from);
  const b = extractDistrict(to);
  return a && b && a !== b;
}

// 抓區域
function extractDistrict(addr) {
  const match = String(addr || '').match(/([\u4e00-\u9fff]{1,4}[區市鄉鎮])/);
  return match ? match[1] : '';
}

// 回覆訊息
function replyText(replyToken, text) {
  return client.replyMessage(replyToken, {
    type: 'text',
    text,
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`UBee bot running on ${port}`);
});

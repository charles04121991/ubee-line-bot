require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('Missing CHANNEL_ACCESS_TOKEN or CHANNEL_SECRET');
}

const client = new line.Client(config);

app.get('/', (req, res) => {
  res.status(200).send('UBee bot v1');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') {
      return null;
    }

    const text = (event.message.text || '').trim();

    // 建立任務
    if (text === '建立任務') {
      return replyText(event.replyToken, createTaskTemplate());
    }

    // 立即估價
    if (text === '立即估價') {
      return replyText(event.replyToken, quoteTemplate());
    }

    // 解析使用者輸入
    const parsed = parseUserInput(text);

    // 使用者填的是建立任務資料
    if (isCreateTaskInput(parsed)) {
      const quote = calculateQuote(parsed);

      const customerMessage = [
        '您的任務已建立成功，我們會立即為您派單。',
        '',
        `配送費：$${quote.deliveryFee}`,
        `稅金：$${quote.tax}`,
        `總計：$${quote.total}`,
      ].join('\n');

      await replyText(event.replyToken, customerMessage);

      // 如果有設定群組 ID，就派單到群組
      if (process.env.LINE_GROUP_ID) {
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

        await client.pushMessage(process.env.LINE_GROUP_ID, {
          type: 'text',
          text: dispatchMessage,
        });
      }

      return null;
    }

    // 使用者填的是立即估價資料
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

function calculateQuote(data) {
  const baseFee = 99;
  const crossDistrictFee = isCrossDistrict(data.pickupAddress, data.dropoffAddress) ? 25 : 0;
  const urgentFee = isUrgent(data.urgent) ? 100 : 0;
  const tax = 15;
  const deliveryFee = baseFee + crossDistrictFee + urgentFee;

  return {
    baseFee,
    crossDistrictFee,
    urgentFee,
    tax,
    deliveryFee,
    total: deliveryFee + tax,
    urgentText: isUrgent(data.urgent) ? '急件' : '一般',
  };
}

function isUrgent(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === '急件' || text === '是' || text === 'yes' || text === 'y' || text === 'urgent';
}

function isCrossDistrict(from, to) {
  const fromDistrict = extractDistrict(from);
  const toDistrict = extractDistrict(to);
  return Boolean(fromDistrict && toDistrict && fromDistrict !== toDistrict);
}

function extractDistrict(address) {
  const match = String(address || '').match(/([\u4e00-\u9fff]{1,4}[區市鄉鎮])/);
  return match ? match[1] : '';
}

function replyText(replyToken, text) {
  return client.replyMessage(replyToken, {
    type: 'text',
    text,
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`UBee bot listening on ${port}`);
});

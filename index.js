const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);
const GROUP_ID = process.env.GROUP_ID || '';

app.get('/', (req, res) => {
  res.send('UBee Webhook OK');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.source && event.source.type === 'group') {
    console.log('群組ID:', event.source.groupId);
  }

  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const text = event.message.text.trim();

  // ===== 建立任務：顯示表單 =====
  if (text === '建立任務') {
    return replyText(
      event.replyToken,
      `請依下列格式填寫並送出：

取件地點：
取件電話：

送達地點：
送達電話：

物品內容：
是否急件：
備註：`
    );
  }

  // ===== 立即估價：顯示表單 =====
  if (text === '立即估價') {
    return replyText(
      event.replyToken,
      `請依下列格式填寫並送出：

取件地點：
送達地點：
物品內容：
是否急件：`
    );
  }

  // ===== 建立任務：解析完整表單 =====
  if (looksLikeTaskForm(text)) {
    const form = parseTaskForm(text);

    const missingFields = getMissingFields(form, [
      'pickup_address',
      'pickup_phone',
      'delivery_address',
      'delivery_phone',
      'item_content',
      'is_urgent'
    ]);

    if (missingFields.length > 0) {
      return replyText(
        event.replyToken,
        `以下欄位尚未完整填寫：
${missingFields.join('\n')}

請補齊後重新送出。`
      );
    }

    const result = calculatePrice(form);

    const customerMessage = `✅ 任務建立完成

取件地點：${form.pickup_address}
取件電話：${form.pickup_phone}

送達地點：${form.delivery_address}
送達電話：${form.delivery_phone}

物品內容：${form.item_content}
是否急件：${form.is_urgent}
備註：${form.note || '無'}

配送費：$${result.fee}
稅金：$${result.tax}
總計：$${result.total}`;

    const groupMessage = `🚨 UBee 派單

費用：$${result.fee}
距離：${result.distance}

取件地點：${form.pickup_address}
送達地點：${form.delivery_address}
物品：${form.item_content}
急件：${form.is_urgent}`;

    await replyText(event.replyToken, customerMessage);

    if (GROUP_ID) {
      await pushToGroup(groupMessage);
    }

    return null;
  }

  // ===== 立即估價：解析簡化表單 =====
  if (looksLikeEstimateForm(text)) {
    const form = parseEstimateForm(text);

    const missingFields = getMissingFields(form, [
      'pickup_address',
      'delivery_address',
      'item_content',
      'is_urgent'
    ]);

    if (missingFields.length > 0) {
      return replyText(
        event.replyToken,
        `以下欄位尚未完整填寫：
${missingFields.join('\n')}

請補齊後重新送出。`
      );
    }

    const result = calculatePrice(form);

    return replyText(
      event.replyToken,
      `📌 預估報價如下（非最終報價）

取件地點：${form.pickup_address}
送達地點：${form.delivery_address}
物品內容：${form.item_content}
是否急件：${form.is_urgent}

配送費：$${result.fee}
稅金：$${result.tax}
總計：$${result.total}`
    );
  }

  return replyText(
    event.replyToken,
    '請點選選單功能，或輸入「建立任務」／「立即估價」。'
  );
}

// ===== 判斷是否為建立任務表單 =====
function looksLikeTaskForm(text) {
  return (
    text.includes('取件地點：') &&
    text.includes('取件電話：') &&
    text.includes('送達地點：') &&
    text.includes('送達電話：') &&
    text.includes('物品內容：') &&
    text.includes('是否急件：')
  );
}

// ===== 判斷是否為立即估價表單 =====
function looksLikeEstimateForm(text) {
  return (
    text.includes('取件地點：') &&
    text.includes('送達地點：') &&
    text.includes('物品內容：') &&
    text.includes('是否急件：') &&
    !text.includes('取件電話：') &&
    !text.includes('送達電話：')
  );
}

// ===== 解析建立任務表單 =====
function parseTaskForm(text) {
  return {
    pickup_address: extractField(text, '取件地點'),
    pickup_phone: extractField(text, '取件電話'),
    delivery_address: extractField(text, '送達地點'),
    delivery_phone: extractField(text, '送達電話'),
    item_content: extractField(text, '物品內容'),
    is_urgent: extractField(text, '是否急件'),
    note: extractField(text, '備註')
  };
}

// ===== 解析立即估價表單 =====
function parseEstimateForm(text) {
  return {
    pickup_address: extractField(text, '取件地點'),
    delivery_address: extractField(text, '送達地點'),
    item_content: extractField(text, '物品內容'),
    is_urgent: extractField(text, '是否急件')
  };
}

// ===== 抓欄位值 =====
function extractField(text, label) {
  const regex = new RegExp(`${label}：\\s*(.+)`);
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

// ===== 檢查缺少欄位 =====
function getMissingFields(data, requiredKeys) {
  const labels = {
    pickup_address: '取件地點',
    pickup_phone: '取件電話',
    delivery_address: '送達地點',
    delivery_phone: '送達電話',
    item_content: '物品內容',
    is_urgent: '是否急件'
  };

  return requiredKeys
    .filter((key) => !data[key] || data[key].trim() === '')
    .map((key) => `- ${labels[key]}`);
}

// ===== 回覆使用者 =====
function replyText(replyToken, text) {
  return client.replyMessage(replyToken, {
    type: 'text',
    text: text
  });
}

// ===== 推送到群組 =====
function pushToGroup(text) {
  return client.pushMessage(GROUP_ID, {
    type: 'text',
    text: text
  });
}

// ===== 計價邏輯（目前測試版） =====
function calculatePrice(data) {
  const baseFee = 100;
  const distanceFee = 80;
  const timeFee = 50;
  const urgentFee =
    data.is_urgent && data.is_urgent.includes('急') ? 100 : 0;

  const fee = baseFee + distanceFee + timeFee + urgentFee;
  const tax = Math.round(fee * 0.05);
  const total = fee + tax;

  return {
    fee: fee,
    tax: tax,
    total: total,
    distance: '5公里 / 12分鐘'
  };
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);
const GROUP_ID = process.env.GROUP_ID || '';

const userState = {};

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
  console.log('收到 event:', JSON.stringify(event, null, 2));

  if (event.source && event.source.type === 'group') {
    console.log('群組ID:', event.source.groupId);
  }

  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const userId = event.source.userId;
  const text = event.message.text.trim();

  if (!userId) {
    return replyText(event.replyToken, '目前僅支援使用者私訊操作');
  }

  if (!userState[userId]) {
    userState[userId] = {
      mode: null,
      step: null,
      data: {}
    };
  }

  const state = userState[userId];

  if (text === '建立任務') {
    state.mode = 'order';
    state.step = 'pickup_address';
    state.data = {};
    return replyText(event.replyToken, '請輸入【取件地點】');
  }

  if (text === '立即估價') {
    state.mode = 'estimate';
    state.step = 'pickup_address';
    state.data = {};
    return replyText(
      event.replyToken,
      '您可以先快速取得任務費用估算，請提供：\n\n取件地點：'
    );
  }

  if (state.step === 'pickup_address') {
    state.data.pickup_address = text;

    if (state.mode === 'order') {
      state.step = 'pickup_phone';
      return replyText(event.replyToken, '請輸入【取件電話】');
    }

    if (state.mode === 'estimate') {
      state.step = 'delivery_address';
      return replyText(event.replyToken, '請輸入【送達地點】');
    }
  }

  if (state.step === 'pickup_phone') {
    state.data.pickup_phone = text;
    state.step = 'delivery_address';
    return replyText(event.replyToken, '請輸入【送達地點】');
  }

  if (state.step === 'delivery_address') {
    state.data.delivery_address = text;

    if (state.mode === 'order') {
      state.step = 'delivery_phone';
      return replyText(event.replyToken, '請輸入【送達電話】');
    }

    if (state.mode === 'estimate') {
      state.step = 'item_content';
      return replyText(event.replyToken, '請輸入【物品內容】');
    }
  }

  if (state.step === 'delivery_phone') {
    state.data.delivery_phone = text;
    state.step = 'item_content';
    return replyText(event.replyToken, '請輸入【物品內容】');
  }

  if (state.step === 'item_content') {
    state.data.item_content = text;
    state.step = 'is_urgent';
    return replyText(event.replyToken, '請輸入【是否急件】（是 / 否）');
  }

  if (state.step === 'is_urgent') {
    state.data.is_urgent = text;

    if (state.mode === 'estimate') {
      const result = calculatePrice(state.data);
      delete userState[userId];

      return replyText(
        event.replyToken,
        `您可以先快速取得任務費用估算，請參考：\n
取件地點：${state.data.pickup_address}
送達地點：${state.data.delivery_address}
物品內容：${state.data.item_content}
是否急件：${state.data.is_urgent}

———

📌 我們將為您即時計算預估費用（非最終報價）

費用：$${result.fee}
距離：${result.distance}`
      );
    }

    state.step = 'note';
    return replyText(event.replyToken, '請輸入【備註】（沒有可輸入 無）');
  }

  if (state.step === 'note') {
    state.data.note = text;

    const result = calculatePrice(state.data);

    const customerMessage = `✅ 任務建立完成

取件地點：${state.data.pickup_address}
取件電話：${state.data.pickup_phone}

送達地點：${state.data.delivery_address}
送達電話：${state.data.delivery_phone}

物品內容：${state.data.item_content}
是否急件：${state.data.is_urgent}
備註：${state.data.note}

費用：$${result.fee}
距離：${result.distance}`;

    const groupMessage = `🚨 UBee 派單

費用：$${result.fee}
距離：${result.distance}

取件地點：${state.data.pickup_address}
送達地點：${state.data.delivery_address}
物品：${state.data.item_content}
急件：${state.data.is_urgent}`;

    delete userState[userId];

    await replyText(event.replyToken, customerMessage);

    if (GROUP_ID) {
      await pushToGroup(groupMessage);
    }

    return null;
  }

  return replyText(event.replyToken, '請輸入「建立任務」或「立即估價」');
}

function replyText(replyToken, text) {
  return client.replyMessage(replyToken, {
    type: 'text',
    text: text
  });
}

function pushToGroup(text) {
  return client.pushMessage(GROUP_ID, {
    type: 'text',
    text: text
  });
}

function calculatePrice(data) {
  const baseFee = 100;
  const distanceFee = 80;
  const timeFee = 50;
  const urgentFee = data.is_urgent === '是' ? 100 : 0;

  return {
    fee: baseFee + distanceFee + timeFee + urgentFee,
    distance: '5公里 / 12分鐘'
  };
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
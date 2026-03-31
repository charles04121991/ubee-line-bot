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
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// ===== 固定費率 =====
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const URGENT_FEE = 100;
const FIXED_TAX = 15;
const RIDER_SHARE_RATE = 0.6;

// ===== 工具函式 =====
function normalizeText(text = '') {
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

function isEstimateForm(text) {
  return (
    text.includes('取件地點') &&
    text.includes('送達地點') &&
    text.includes('物品內容') &&
    text.includes('是否急件') &&
    !text.includes('取件電話') &&
    !text.includes('送達電話')
  );
}

function isTaskForm(text) {
  return (
    text.includes('取件地點') &&
    text.includes('送達地點') &&
    text.includes('物品內容') &&
    text.includes('是否急件') &&
    text.includes('取件電話') &&
    text.includes('送達電話')
  );
}

function parseEstimateForm(text) {
  return {
    pickupAddress: extractField(text, ['取件地點']),
    deliveryAddress: extractField(text, ['送達地點']),
    item: extractField(text, ['物品內容']),
    urgent: extractField(text, ['是否急件']),
  };
}

function parseTaskForm(text) {
  return {
    pickupAddress: extractField(text, ['取件地點']),
    pickupPhone: extractField(text, ['取件電話', '取件人 / 電話', '取件人/電話']),
    deliveryAddress: extractField(text, ['送達地點']),
    deliveryPhone: extractField(text, ['送達電話', '收件人 / 電話', '收件人/電話']),
    item: extractField(text, ['物品內容']),
    urgent: extractField(text, ['是否急件']),
    note: extractField(text, ['備註']),
  };
}

function isUrgent(urgentText = '') {
  return urgentText.includes('急件');
}

function extractDistrict(address = '') {
  const match = address.match(/([^\s縣市區路段巷弄號樓之]{1,6}區)/);
  return match ? match[1] : '';
}

function isCrossDistrict(pickupAddress, deliveryAddress) {
  const pickupDistrict = extractDistrict(pickupAddress);
  const deliveryDistrict = extractDistrict(deliveryAddress);

  if (!pickupDistrict || !deliveryDistrict) return false;
  return pickupDistrict !== deliveryDistrict;
}

function parseGoogleDurationToMinutes(durationStr = '') {
  // Google Routes API duration 例如 "1234s"
  const seconds = parseFloat(String(durationStr).replace('s', ''));
  if (!Number.isFinite(seconds)) return 0;
  return Math.ceil(seconds / 60);
}

async function getRouteInfo(originAddress, destinationAddress) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('Missing GOOGLE_MAPS_API_KEY');
  }

  const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
    },
    body: JSON.stringify({
      origin: {
        address: originAddress,
      },
      destination: {
        address: destinationAddress,
      },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      languageCode: 'zh-TW',
      units: 'METRIC',
      regionCode: 'TW',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Routes API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  if (!data.routes || !data.routes.length) {
    throw new Error('No route found');
  }

  const route = data.routes[0];
  const distanceMeters = route.distanceMeters || 0;
  const duration = route.duration || '0s';

  return {
    distanceMeters,
    distanceKm: Math.ceil(distanceMeters / 1000),
    durationMinutes: parseGoogleDurationToMinutes(duration),
  };
}

function calculatePrice({ distanceKm, durationMinutes, urgent, pickupAddress, deliveryAddress }) {
  const distanceFee = distanceKm * PER_KM_FEE;
  const timeFee = durationMinutes * PER_MIN_FEE;
  const crossDistrictFee = isCrossDistrict(pickupAddress, deliveryAddress) ? CROSS_DISTRICT_FEE : 0;
  const urgentFee = isUrgent(urgent) ? URGENT_FEE : 0;

  const deliveryFee = Math.round(
    BASE_FEE + distanceFee + timeFee + crossDistrictFee + urgentFee
  );

  const tax = FIXED_TAX;
  const total = deliveryFee + tax;
  const riderFee = Math.round(deliveryFee * RIDER_SHARE_RATE);

  return {
    baseFee: BASE_FEE,
    distanceFee,
    timeFee,
    crossDistrictFee,
    urgentFee,
    deliveryFee,
    tax,
    total,
    riderFee,
  };
}

function buildCustomerQuoteMessage(pricing) {
  return `配送費：$${pricing.deliveryFee}
稅金：$${pricing.tax}
總計：$${pricing.total}`;
}

function buildDispatchMessage(task, routeInfo, pricing) {
  return `【UBee 派單通知】

費用：$${pricing.riderFee}
距離：${routeInfo.distanceKm} 公里 / ${routeInfo.durationMinutes} 分鐘

取件：
${task.pickupAddress || '未填寫'}

送達：
${task.deliveryAddress || '未填寫'}

物品：
${task.item || '未填寫'}

急件：
${isUrgent(task.urgent) ? '是' : '否'}`;
}

function validateAddresses(pickupAddress, deliveryAddress) {
  if (!pickupAddress || !deliveryAddress) {
    return '取件地點或送達地點未填寫完整。';
  }
  return '';
}

// ===== 路由 =====
app.get('/', (req, res) => {
  res.status(200).send('UBee bot pricing version running');
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

    // 1) 建立任務
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

    // 2) 立即估價
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

    // 3) 立即估價表單
    if (isEstimateForm(userText)) {
      const form = parseEstimateForm(userText);

      const addressError = validateAddresses(form.pickupAddress, form.deliveryAddress);
      if (addressError) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `❌ ${addressError}`,
        });
      }

      const routeInfo = await getRouteInfo(form.pickupAddress, form.deliveryAddress);
      const pricing = calculatePrice({
        distanceKm: routeInfo.distanceKm,
        durationMinutes: routeInfo.durationMinutes,
        urgent: form.urgent,
        pickupAddress: form.pickupAddress,
        deliveryAddress: form.deliveryAddress,
      });

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: buildCustomerQuoteMessage(pricing),
      });
    }

    // 4) 建立任務表單
    if (isTaskForm(userText)) {
      const task = parseTaskForm(userText);

      const addressError = validateAddresses(task.pickupAddress, task.deliveryAddress);
      if (addressError) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `❌ ${addressError}`,
        });
      }

      const routeInfo = await getRouteInfo(task.pickupAddress, task.deliveryAddress);
      const pricing = calculatePrice({
        distanceKm: routeInfo.distanceKm,
        durationMinutes: routeInfo.durationMinutes,
        urgent: task.urgent,
        pickupAddress: task.pickupAddress,
        deliveryAddress: task.deliveryAddress,
      });

      // 推送派單到群組
      if (LINE_GROUP_ID) {
        const dispatchMessage = buildDispatchMessage(task, routeInfo, pricing);

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
        text:
`${buildCustomerQuoteMessage(pricing)}

您的任務已建立成功，我們會立即為您派單。`,
      });
    }

    return null;
  } catch (err) {
    console.error('❌ handleEvent error:', err);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '系統暫時忙碌中，請稍後再試一次。',
    });
  }
}

// ===== 啟動 =====
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

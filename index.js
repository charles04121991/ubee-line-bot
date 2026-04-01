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
  console.error('❌ Missing CHANNEL_ACCESS_TOKEN or CHANNEL_SECRET');
  process.exit(1);
}

const client = new line.Client(config);

const PORT = process.env.PORT || 3000;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// =========================
// UBee 正式版費率設定
// =========================
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const URGENT_FEE = 100;
const SERVICE_FEE = 50;
const FIXED_TAX = 15;
const MIN_TASK_FEE = 149;
const RIDER_SHARE_RATE = 0.6;

// 使用者暫存狀態（記憶體版）
// 正式大規模上線後可改 Redis / DB
const userSessions = new Map();

// =========================
// 基本首頁
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee bot pricing version running');
});

// =========================
// LINE Webhook
// =========================
app.post('/callback', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('❌ Webhook Error:', err);
    res.status(500).end();
  }
});

// =========================
// 主要事件處理
// =========================
async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') {
      return null;
    }

    const userId = event.source.userId || event.source.groupId || event.source.roomId;
    const rawText = (event.message.text || '').trim();
    const text = normalizeText(rawText);

    // 取消流程
    if (['取消', '取消任務', '取消建立', '取消估價'].includes(text)) {
      userSessions.delete(userId);
      return replyText(event.replyToken, '已取消目前流程。');
    }

    // 啟動立即估價
    if (text === '立即估價') {
      userSessions.set(userId, { mode: 'estimate' });
      return replyText(
        event.replyToken,
        [
          '請依以下格式填寫，我將立即為您估價：',
          '',
          '取件地點：',
          '取件電話：',
          '',
          '送達地點：',
          '送達電話：',
          '',
          '物品內容：',
          '是否急件（一般 / 急件）：',
          '是否代墊（無 / 有）：',
          '備註：',
        ].join('\n')
      );
    }

    // 啟動建立任務
    if (text === '建立任務') {
      userSessions.set(userId, { mode: 'create' });
      return replyText(
        event.replyToken,
        [
          '請依以下格式填寫任務資料，我會先為您報價；您確認後才會正式建立並派單：',
          '',
          '取件地點：',
          '取件電話：',
          '',
          '送達地點：',
          '送達電話：',
          '',
          '物品內容：',
          '是否急件（一般 / 急件）：',
          '是否代墊（無 / 有）：',
          '備註：',
        ].join('\n')
      );
    }

    // 客人確認建立任務
    if (text === '確認建立') {
      const session = userSessions.get(userId);

      if (!session || session.mode !== 'await_confirm_create' || !session.taskData) {
        return replyText(event.replyToken, '目前沒有可建立的任務，請先輸入「建立任務」。');
      }

      const taskData = session.taskData;
      const groupMessage = buildRiderDispatchMessage(taskData);

      if (!LINE_GROUP_ID) {
        console.error('❌ Missing LINE_GROUP_ID');
        return replyText(
          event.replyToken,
          '任務資料已確認，但目前系統尚未設定派單群組，請先檢查環境變數 LINE_GROUP_ID。'
        );
      }

      await client.pushMessage(LINE_GROUP_ID, {
        type: 'text',
        text: groupMessage,
      });

      userSessions.delete(userId);

      return replyText(
        event.replyToken,
        [
          '您的任務資料已收到，',
          '系統正在為您安排派單。',
          '',
          '如需補充資訊，將由專人與您聯繫。',
        ].join('\n')
      );
    }

    // 有可能是表單資料
    const parsedForm = parseTaskForm(rawText);

    if (parsedForm.isValid) {
      const session = userSessions.get(userId);

      // 沒有先選模式，也幫他自動估價
      const mode = session?.mode || 'estimate';

      const validationError = validateFormData(parsedForm.data);
      if (validationError) {
        return replyText(event.replyToken, validationError);
      }

      if (!GOOGLE_MAPS_API_KEY) {
        console.error('❌ Missing GOOGLE_MAPS_API_KEY');
        return replyText(
          event.replyToken,
          '目前無法自動估價，系統尚未設定 Google Maps API Key。'
        );
      }

      const route = await getDistanceAndDuration(
        parsedForm.data.pickupAddress,
        parsedForm.data.deliveryAddress
      );

      if (!route.ok) {
        return replyText(event.replyToken, route.message);
      }

      const pricing = calculatePricing({
        distanceKm: route.distanceKm,
        durationMin: route.durationMin,
        pickupAddress: parsedForm.data.pickupAddress,
        deliveryAddress: parsedForm.data.deliveryAddress,
        urgent: parsedForm.data.urgent,
      });

      const taskData = {
        ...parsedForm.data,
        distanceKm: route.distanceKm,
        durationMin: route.durationMin,
        pricing,
      };

      if (mode === 'create') {
        userSessions.set(userId, {
          mode: 'await_confirm_create',
          taskData,
        });

        return replyText(
          event.replyToken,
          [
            '以下為本次任務報價：',
            '',
            buildCustomerQuoteMessage(taskData.pricing),
            '',
            '若您確認建立任務，請直接回覆：',
            '【確認建立】',
            '',
            '若要取消，請回覆：',
            '【取消】',
          ].join('\n')
        );
      }

      return replyText(
        event.replyToken,
        [
          '以下為本次預估費用：',
          '',
          buildCustomerQuoteMessage(taskData.pricing),
          '',
          '如需正式建立任務，請輸入：',
          '【建立任務】',
        ].join('\n')
      );
    }

    // 說明指令
    if (['help', '幫助', '說明'].includes(text.toLowerCase())) {
      return replyText(
        event.replyToken,
        [
          'UBee 可使用以下功能：',
          '',
          '1. 立即估價',
          '2. 建立任務',
          '3. 取消',
        ].join('\n')
      );
    }

    // 預設回覆
    return replyText(
      event.replyToken,
      [
        '您好，請輸入以下功能：',
        '',
        '【立即估價】',
        '【建立任務】',
      ].join('\n')
    );
  } catch (err) {
    console.error('❌ handleEvent Error:', err);
    return replyText(event.replyToken, '系統忙碌中，請稍後再試。');
  }
}

// =========================
// 回覆訊息
// =========================
function replyText(replyToken, text) {
  return client.replyMessage(replyToken, {
    type: 'text',
    text,
  });
}

// =========================
// 文字正規化
// =========================
function normalizeText(text) {
  return String(text || '')
    .replace(/\u3000/g, ' ')
    .replace(/\r/g, '')
    .trim();
}

// =========================
// 解析表單
// =========================
function parseTaskForm(text) {
  const cleanText = normalizeText(text);

  const lines = cleanText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const data = {
    pickupAddress: '',
    pickupPhone: '',
    deliveryAddress: '',
    deliveryPhone: '',
    item: '',
    urgent: '一般',
    advancePayment: '無',
    note: '',
  };

  for (const line of lines) {
    const normalized = line.replace(/：/g, ':');

    if (normalized.startsWith('取件地點:')) {
      data.pickupAddress = normalized.replace('取件地點:', '').trim();
    } else if (normalized.startsWith('取件地址:')) {
      data.pickupAddress = normalized.replace('取件地址:', '').trim();
    } else if (normalized.startsWith('取件電話:')) {
      data.pickupPhone = normalized.replace('取件電話:', '').trim();
    } else if (normalized.startsWith('送達地點:')) {
      data.deliveryAddress = normalized.replace('送達地點:', '').trim();
    } else if (normalized.startsWith('送達地址:')) {
      data.deliveryAddress = normalized.replace('送達地址:', '').trim();
    } else if (normalized.startsWith('送達電話:')) {
      data.deliveryPhone = normalized.replace('送達電話:', '').trim();
    } else if (normalized.startsWith('收件電話:')) {
      data.deliveryPhone = normalized.replace('收件電話:', '').trim();
    } else if (normalized.startsWith('物品內容:')) {
      data.item = normalized.replace('物品內容:', '').trim();
    } else if (normalized.startsWith('是否急件')) {
      data.urgent = normalized.split(':')[1]?.trim() || '一般';
    } else if (normalized.startsWith('急件:')) {
      data.urgent = normalized.replace('急件:', '').trim() || '一般';
    } else if (normalized.startsWith('是否代墊')) {
      data.advancePayment = normalized.split(':')[1]?.trim() || '無';
    } else if (normalized.startsWith('代墊:')) {
      data.advancePayment = normalized.replace('代墊:', '').trim() || '無';
    } else if (normalized.startsWith('備註:')) {
      data.note = normalized.replace('備註:', '').trim();
    }
  }

  const isValid =
    !!data.pickupAddress &&
    !!data.pickupPhone &&
    !!data.deliveryAddress &&
    !!data.deliveryPhone &&
    !!data.item;

  return { isValid, data };
}

// =========================
// 欄位驗證
// =========================
function validateFormData(data) {
  if (!data.pickupAddress) return '請填寫完整的取件地點。';
  if (!data.pickupPhone) return '請填寫取件電話。';
  if (!data.deliveryAddress) return '請填寫完整的送達地點。';
  if (!data.deliveryPhone) return '請填寫送達電話。';
  if (!data.item) return '請填寫物品內容。';

  const phoneRegex = /^[0-9+\-\s()]{8,20}$/;

  if (!phoneRegex.test(data.pickupPhone)) {
    return '取件電話格式不正確，請重新確認。';
  }

  if (!phoneRegex.test(data.deliveryPhone)) {
    return '送達電話格式不正確，請重新確認。';
  }

  const urgentValue = normalizeUrgent(data.urgent);
  if (!['一般', '急件'].includes(urgentValue)) {
    return '是否急件請填寫「一般」或「急件」。';
  }
  data.urgent = urgentValue;

  const advanceValue = normalizeAdvancePayment(data.advancePayment);
  if (!['無', '有'].includes(advanceValue)) {
    return '是否代墊請填寫「無」或「有」。';
  }
  data.advancePayment = advanceValue;

  if (!data.note) {
    data.note = '無';
  }

  return null;
}

function normalizeUrgent(value) {
  const text = String(value || '').trim();
  if (text.includes('急')) return '急件';
  return '一般';
}

function normalizeAdvancePayment(value) {
  const text = String(value || '').trim();
  if (text.includes('有')) return '有';
  return '無';
}

// =========================
// Google Maps 距離時間
// =========================
async function getDistanceAndDuration(origin, destination) {
  try {
    const url =
      `https://maps.googleapis.com/maps/api/distancematrix/json` +
      `?origins=${encodeURIComponent(origin)}` +
      `&destinations=${encodeURIComponent(destination)}` +
      `&language=zh-TW` +
      `&region=tw` +
      `&mode=driving` +
      `&key=${GOOGLE_MAPS_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK') {
      console.error('❌ Google Maps API status:', data.status, data.error_message || '');
      return {
        ok: false,
        message: '目前無法自動估價，請稍後再試或確認地址是否完整。',
      };
    }

    const row = data.rows?.[0];
    const element = row?.elements?.[0];

    if (!element || element.status !== 'OK') {
      console.error('❌ Distance Matrix element error:', element?.status);
      return {
        ok: false,
        message: '目前無法自動估價，請確認取件地點與送達地點是否填寫完整。',
      };
    }

    const distanceMeters = element.distance?.value || 0;
    const durationSeconds = element.duration?.value || 0;

    if (distanceMeters <= 0 || durationSeconds <= 0) {
      return {
        ok: false,
        message: '目前無法自動估價，請確認地址或由人工協助。',
      };
    }

    const distanceKm = roundToOne(distanceMeters / 1000);
    const durationMin = Math.max(1, Math.ceil(durationSeconds / 60));

    return {
      ok: true,
      distanceKm,
      durationMin,
    };
  } catch (err) {
    console.error('❌ getDistanceAndDuration Error:', err);
    return {
      ok: false,
      message: '目前無法自動估價，請稍後再試或由人工協助。',
    };
  }
}

// =========================
// 計價邏輯
// 任務費 = 基本費 + 距離費 + 時間費 + 跨區費 + 急件費
// 服務費 = 固定 50
// 小計 = 任務費 + 服務費
// 稅金 = 固定 15
// 總計 = 小計 + 稅金
// 騎手費 = 任務費 * 0.6
// =========================
function calculatePricing({ distanceKm, durationMin, pickupAddress, deliveryAddress, urgent }) {
  const distanceFee = Math.round(distanceKm * PER_KM_FEE);
  const timeFee = Math.round(durationMin * PER_MIN_FEE);
  const crossDistrictFee = isCrossDistrict(pickupAddress, deliveryAddress) ? CROSS_DISTRICT_FEE : 0;
  const urgentFee = normalizeUrgent(urgent) === '急件' ? URGENT_FEE : 0;

  let taskFee = BASE_FEE + distanceFee + timeFee + crossDistrictFee + urgentFee;

  if (taskFee < MIN_TASK_FEE) {
    taskFee = MIN_TASK_FEE;
  }

  const serviceFee = SERVICE_FEE;
  const subtotal = taskFee + serviceFee;
  const tax = FIXED_TAX;
  const total = subtotal + tax;
  const riderFee = Math.round(taskFee * RIDER_SHARE_RATE);

  return {
    baseFee: BASE_FEE,
    distanceFee,
    timeFee,
    crossDistrictFee,
    urgentFee,
    taskFee,
    serviceFee,
    subtotal,
    tax,
    total,
    riderFee,
  };
}

// =========================
// 客人報價訊息
// =========================
function buildCustomerQuoteMessage(pricing) {
  return [
    `任務費：$${pricing.taskFee}`,
    `服務費：$${pricing.serviceFee}`,
    '',
    `小計：$${pricing.subtotal}`,
    `稅金：$${pricing.tax}`,
    '',
    `總計：$${pricing.total}`,
  ].join('\n');
}

// =========================
// 騎手派單訊息
// =========================
function buildRiderDispatchMessage(taskData) {
  return [
    '【UBee 新任務】',
    '',
    `費用：$${taskData.pricing.riderFee}`,
    `距離：${taskData.distanceKm} km`,
    '',
    `取件：${taskData.pickupAddress}`,
    `送達：${taskData.deliveryAddress}`,
    `物品：${taskData.item}`,
    `急件：${taskData.urgent}`,
    `是否代墊：${taskData.advancePayment}`,
    `備註：${taskData.note || '無'}`,
  ].join('\n');
}

// =========================
// 判斷是否跨區
// =========================
function isCrossDistrict(addressA, addressB) {
  const districtA = extractDistrict(addressA);
  const districtB = extractDistrict(addressB);

  if (!districtA || !districtB) {
    return false;
  }

  return districtA !== districtB;
}

function extractDistrict(address) {
  const text = String(address || '');

  // 優先抓台灣常見行政區格式
  const match = text.match(/([^\s\d]{1,6}(區|市|鎮|鄉))/);
  return match ? match[1] : '';
}

// =========================
// 小工具
// =========================
function roundToOne(num) {
  return Math.round(num * 10) / 10;
}

// =========================
// 啟動伺服器
// =========================
app.listen(PORT, () => {
  console.log(`✅ UBee server is running on port ${PORT}`);
});
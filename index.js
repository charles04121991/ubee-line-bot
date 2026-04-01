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

// ====== 費率設定 ======
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const URGENT_FEE = 100;
const SERVICE_FEE = 50;
const FIXED_TAX = 15;

// 騎手分潤：配送費 * 0.6
const RIDER_SHARE_RATE = 0.6;

// ====== 記憶體資料 ======
// 使用者引導流程
const userSessions = {}; // { [userId]: { mode, step, data, quote } }

// 已建立並派到群組的任務
const activeJobs = {}; // { [groupId]: { customerUserId, customerName, status, ... } }

// 群組等待騎手輸入 ETA 的暫存
const pendingRiderAccept = {}; // { [groupId]: { riderUserId, riderName } }

// 避免重複歡迎詞
const greetedUsers = new Set();

// ====== 工具函式 ======
function safeText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeUrgent(text) {
  const t = safeText(text);
  if (t.includes('急')) return '急件';
  return '一般';
}

function normalizeNote(text) {
  const t = safeText(text);
  return t || '無';
}

function isValidPhone(phone) {
  const cleaned = safeText(phone).replace(/[^\d]/g, '');
  return cleaned.length >= 8 && cleaned.length <= 12;
}

function parseDistanceKm(distanceMeters) {
  return Number((distanceMeters / 1000).toFixed(1));
}

function parseDurationMin(durationSeconds) {
  return Math.max(1, Math.round(durationSeconds / 60));
}

function roundCurrency(n) {
  return Math.round(Number(n) || 0);
}

function getDistrict(address) {
  const districts = [
    '豐原區', '潭子區', '神岡區', '大雅區', '北屯區',
    '西屯區', '南屯區', '西區', '南區', '東區', '北區',
    '太平區', '大里區', '烏日區', '霧峰區', '后里區',
    '石岡區', '東勢區', '新社區', '沙鹿區', '清水區',
    '梧棲區', '龍井區', '大肚區', '外埔區', '大安區',
    '和平區'
  ];

  for (const d of districts) {
    if (address.includes(d)) return d;
  }
  return '';
}

function calcPricing({ distanceKm, durationMin, urgent, pickupAddress, dropoffAddress }) {
  const deliveryFee =
    BASE_FEE +
    roundCurrency(distanceKm * PER_KM_FEE) +
    roundCurrency(durationMin * PER_MIN_FEE);

  const pickupDistrict = getDistrict(pickupAddress);
  const dropoffDistrict = getDistrict(dropoffAddress);

  const crossDistrictFee =
    pickupDistrict && dropoffDistrict && pickupDistrict !== dropoffDistrict
      ? CROSS_DISTRICT_FEE
      : 0;

  const urgentFee = urgent === '急件' ? URGENT_FEE : 0;

  const subtotal = deliveryFee + crossDistrictFee + urgentFee + SERVICE_FEE;
  const total = subtotal + FIXED_TAX;

  const riderFee = roundCurrency((deliveryFee + crossDistrictFee) * RIDER_SHARE_RATE);

  return {
    deliveryFee,
    crossDistrictFee,
    urgentFee,
    serviceFee: SERVICE_FEE,
    tax: FIXED_TAX,
    total,
    riderFee,
    pickupDistrict,
    dropoffDistrict,
  };
}

async function getDistanceAndDuration(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('Missing GOOGLE_MAPS_API_KEY');
  }

  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(destination)}` +
    `&mode=driving&language=zh-TW&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (
    !data ||
    data.status !== 'OK' ||
    !data.rows ||
    !data.rows[0] ||
    !data.rows[0].elements ||
    !data.rows[0].elements[0] ||
    data.rows[0].elements[0].status !== 'OK'
  ) {
    throw new Error('Google Maps distance lookup failed');
  }

  const element = data.rows[0].elements[0];

  return {
    distanceMeters: element.distance.value,
    durationSeconds: element.duration.value,
    distanceText: element.distance.text,
    durationText: element.duration.text,
  };
}

function getQuickReplyItems(items) {
  return {
    items: items.map((label) => ({
      type: 'action',
      action: {
        type: 'message',
        label,
        text: label,
      },
    })),
  };
}

function formatQuoteForCustomer(quote) {
  return (
    `✅ 已為您完成估價\n\n` +
    `配送費：$${quote.deliveryFee + quote.crossDistrictFee}\n` +
    `急件費：$${quote.urgentFee}\n` +
    `服務費：$${quote.serviceFee}\n` +
    `稅金：$${quote.tax}\n` +
    `總計：$${quote.total}`
  );
}

function formatTaskCreatedForCustomer(quote) {
  return (
    `✅ 您的任務已建立成功\n\n` +
    `配送費：$${quote.deliveryFee + quote.crossDistrictFee}\n` +
    `急件費：$${quote.urgentFee}\n` +
    `服務費：$${quote.serviceFee}\n` +
    `稅金：$${quote.tax}\n` +
    `總計：$${quote.total}\n\n` +
    `🚀 我們正在為您派單，請稍候通知`
  );
}

function formatConfirmMessage(data, quote, mode, distanceKm, durationMin) {
  return (
    `📋 請確認以下資訊：\n\n` +
    `取件地點：${data.pickupAddress}\n` +
    `取件電話：${data.pickupPhone}\n\n` +
    `送達地點：${data.dropoffAddress}\n` +
    `送達電話：${data.dropoffPhone}\n\n` +
    `物品內容：${data.item}\n` +
    `是否急件：${data.urgent}\n` +
    `備註：${data.note}\n\n` +
    `距離：約 ${distanceKm} 公里\n` +
    `時間：約 ${durationMin} 分鐘\n\n` +
    `配送費：$${quote.deliveryFee + quote.crossDistrictFee}\n` +
    `急件費：$${quote.urgentFee}\n` +
    `服務費：$${quote.serviceFee}\n` +
    `稅金：$${quote.tax}\n` +
    `總計：$${quote.total}\n\n` +
    (mode === 'create'
      ? `請回覆「確認」建立任務\n或回覆「修改」重新填寫`
      : `請回覆「確認」完成估價\n或回覆「修改」重新填寫`)
  );
}

function formatGroupJobMessage(job) {
  return (
    `📦 UBee 新任務通知\n\n` +
    `費用：$${job.riderFee}\n` +
    `距離：${job.distanceKm} 公里\n\n` +
    `取件：${job.pickupAddress}\n` +
    `取件電話：${job.pickupPhone}\n\n` +
    `送達：${job.dropoffAddress}\n` +
    `送達電話：${job.dropoffPhone}\n\n` +
    `物品：${job.item}\n` +
    `急件：${job.urgent}\n` +
    `備註：${job.note}`
  );
}

async function pushToGroup(text) {
  if (!LINE_GROUP_ID) {
    console.error('❌ Missing LINE_GROUP_ID');
    return;
  }

  try {
    await client.pushMessage(LINE_GROUP_ID, { type: 'text', text });
  } catch (err) {
    console.error('❌ pushToGroup failed:', err.message);
  }
}

async function replyText(replyToken, text, quickReply = null) {
  const message = { type: 'text', text };
  if (quickReply) message.quickReply = quickReply;
  return client.replyMessage(replyToken, message);
}

async function getDisplayName(userId, source) {
  try {
    if (source.type === 'user') {
      const profile = await client.getProfile(userId);
      return profile.displayName || '客戶';
    }
    if (source.type === 'group') {
      const profile = await client.getGroupMemberProfile(source.groupId, userId);
      return profile.displayName || '騎手';
    }
    if (source.type === 'room') {
      const profile = await client.getRoomMemberProfile(source.roomId, userId);
      return profile.displayName || '騎手';
    }
  } catch (err) {
    console.error('⚠️ getDisplayName failed:', err.message);
  }
  return source.type === 'user' ? '客戶' : '騎手';
}

function createEmptySession(mode) {
  return {
    mode, // create / quote
    step: 'pickupAddress',
    data: {
      pickupAddress: '',
      pickupPhone: '',
      dropoffAddress: '',
      dropoffPhone: '',
      item: '',
      urgent: '',
      note: '',
    },
    quote: null,
    distanceKm: 0,
    durationMin: 0,
  };
}

function clearUserSession(userId) {
  delete userSessions[userId];
}

async function startFlow(event, mode) {
  const userId = event.source.userId;
  userSessions[userId] = createEmptySession(mode);

  const title = mode === 'create' ? '建立任務' : '立即估價';
  return replyText(event.replyToken, `已進入「${title}」流程\n\n請輸入【取件地點】`);
}

async function handleUserFlow(event, text) {
  const userId = event.source.userId;
  const session = userSessions[userId];

  if (!session) return false;

  const t = safeText(text);

  if (t === '取消') {
    clearUserSession(userId);
    await replyText(event.replyToken, '已取消本次流程。');
    return true;
  }

  if (t === '建立任務') {
    await startFlow(event, 'create');
    return true;
  }

  if (t === '立即估價') {
    await startFlow(event, 'quote');
    return true;
  }

  if (session.step === 'pickupAddress') {
    session.data.pickupAddress = t;
    session.step = 'pickupPhone';
    await replyText(event.replyToken, '請輸入【取件電話】');
    return true;
  }

  if (session.step === 'pickupPhone') {
    if (!isValidPhone(t)) {
      await replyText(event.replyToken, '取件電話格式看起來不正確，請重新輸入【取件電話】');
      return true;
    }
    session.data.pickupPhone = t;
    session.step = 'dropoffAddress';
    await replyText(event.replyToken, '請輸入【送達地點】');
    return true;
  }

  if (session.step === 'dropoffAddress') {
    session.data.dropoffAddress = t;
    session.step = 'dropoffPhone';
    await replyText(event.replyToken, '請輸入【送達電話】');
    return true;
  }

  if (session.step === 'dropoffPhone') {
    if (!isValidPhone(t)) {
      await replyText(event.replyToken, '送達電話格式看起來不正確，請重新輸入【送達電話】');
      return true;
    }
    session.data.dropoffPhone = t;
    session.step = 'item';
    await replyText(event.replyToken, '請輸入【物品內容】');
    return true;
  }

  if (session.step === 'item') {
    session.data.item = t || '無';
    session.step = 'urgent';
    await replyText(
      event.replyToken,
      '是否為急件？請輸入【一般】或【急件】',
      getQuickReplyItems(['一般', '急件'])
    );
    return true;
  }

  if (session.step === 'urgent') {
    session.data.urgent = normalizeUrgent(t);
    session.step = 'note';
    await replyText(event.replyToken, '請輸入【備註】（若無可直接輸入：無）');
    return true;
  }

  if (session.step === 'note') {
    session.data.note = normalizeNote(t);

    try {
      const route = await getDistanceAndDuration(
        session.data.pickupAddress,
        session.data.dropoffAddress
      );

      const distanceKm = parseDistanceKm(route.distanceMeters);
      const durationMin = parseDurationMin(route.durationSeconds);

      const quote = calcPricing({
        distanceKm,
        durationMin,
        urgent: session.data.urgent,
        pickupAddress: session.data.pickupAddress,
        dropoffAddress: session.data.dropoffAddress,
      });

      session.quote = quote;
      session.distanceKm = distanceKm;
      session.durationMin = durationMin;
      session.step = 'confirm';

      await replyText(
        event.replyToken,
        formatConfirmMessage(session.data, quote, session.mode, distanceKm, durationMin),
        getQuickReplyItems(['確認', '修改', '取消'])
      );
      return true;
    } catch (err) {
      console.error('❌ route error:', err.message);
      clearUserSession(userId);
      await replyText(
        event.replyToken,
        '目前無法取得地址距離資訊，請確認地址是否完整，稍後再試一次。'
      );
      return true;
    }
  }

  if (session.step === 'confirm') {
    if (t === '修改') {
      userSessions[userId] = createEmptySession(session.mode);
      await replyText(event.replyToken, '好的，重新開始。\n\n請輸入【取件地點】');
      return true;
    }

    if (t !== '確認') {
      await replyText(
        event.replyToken,
        '請回覆【確認】、【修改】或【取消】',
        getQuickReplyItems(['確認', '修改', '取消'])
      );
      return true;
    }

    // ===== 立即估價 =====
    if (session.mode === 'quote') {
      const quoteText = formatQuoteForCustomer(session.quote);
      clearUserSession(userId);
      await replyText(event.replyToken, `${quoteText}\n\n👉 若需安排任務，請輸入「建立任務」`);
      return true;
    }

    // ===== 建立任務 =====
    const customerName = await getDisplayName(userId, event.source);

    const job = {
      customerUserId: userId,
      customerName,
      pickupAddress: session.data.pickupAddress,
      pickupPhone: session.data.pickupPhone,
      dropoffAddress: session.data.dropoffAddress,
      dropoffPhone: session.data.dropoffPhone,
      item: session.data.item,
      urgent: session.data.urgent,
      note: session.data.note,
      distanceKm: session.distanceKm,
      durationMin: session.durationMin,
      deliveryFee: session.quote.deliveryFee,
      crossDistrictFee: session.quote.crossDistrictFee,
      urgentFee: session.quote.urgentFee,
      serviceFee: session.quote.serviceFee,
      tax: session.quote.tax,
      total: session.quote.total,
      riderFee: session.quote.riderFee,
      status: 'waiting_rider',
      riderUserId: '',
      riderName: '',
      etaMin: 0,
      groupId: LINE_GROUP_ID,
    };

    activeJobs[LINE_GROUP_ID] = job;

    const customerText = formatTaskCreatedForCustomer(session.quote);
    const groupText = formatGroupJobMessage(job);

    clearUserSession(userId);

    await client.replyMessage(event.replyToken, { type: 'text', text: customerText });
    await pushToGroup(groupText);

    return true;
  }

  return false;
}

// ====== 客戶一般文字處理 ======
async function handleUserMessage(event, text) {
  const userId = event.source.userId;
  const t = safeText(text);

  // 若在流程中，優先處理流程
  if (userSessions[userId]) {
    const handled = await handleUserFlow(event, t);
    if (handled) return;
  }

  if (t === '建立任務') {
    await startFlow(event, 'create');
    return;
  }

  if (t === '立即估價') {
    await startFlow(event, 'quote');
    return;
  }

  if (!greetedUsers.has(userId)) {
    greetedUsers.add(userId);
    await replyText(
      event.replyToken,
      `您好，歡迎使用 UBee 城市任務跑腿\n\n` +
      `您可以直接輸入：\n` +
      `1. 建立任務\n` +
      `2. 立即估價`
    );
    return;
  }

  await replyText(
    event.replyToken,
    `請直接輸入以下功能：\n\n1. 建立任務\n2. 立即估價`
  );
}

// ====== 群組騎手訊息處理 ======
async function handleGroupMessage(event, text) {
  const groupId = event.source.groupId || event.source.roomId || 'default';
  const userId = event.source.userId;
  const t = safeText(text);

  const riderName = await getDisplayName(userId, event.source);
  const job = activeJobs[groupId];

  if (!job) {
    return replyText(event.replyToken, '目前沒有可處理的任務。');
  }

  // ===== 騎手輸入 接 =====
  if (t === '接') {
    if (job.status !== 'waiting_rider') {
      return replyText(event.replyToken, '此任務目前不可接單。');
    }

    pendingRiderAccept[groupId] = {
      riderUserId: userId,
      riderName,
    };

    return replyText(
      event.replyToken,
      `✅ 已收到接單\n請回覆幾分鐘會到取件地點\n例如：8`
    );
  }

  // ===== 接單後輸入 ETA 數字 =====
  if (/^\d{1,3}$/.test(t) && pendingRiderAccept[groupId]) {
    const pending = pendingRiderAccept[groupId];

    if (pending.riderUserId !== userId) {
      return replyText(event.replyToken, '目前等待上一位接單騎手輸入 ETA。');
    }

    if (job.status !== 'waiting_rider') {
      delete pendingRiderAccept[groupId];
      return replyText(event.replyToken, '此任務已不可接單。');
    }

    const etaMin = parseInt(t, 10);

    job.status = 'accepted';
    job.riderUserId = userId;
    job.riderName = pending.riderName;
    job.etaMin = etaMin;

    delete pendingRiderAccept[groupId];

    // 群組回覆
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 此任務已由 ${job.riderName} 接單\n⏱ 預計 ${etaMin} 分鐘抵達取件地點`,
    });

    // 客戶通知
    try {
      await client.pushMessage(job.customerUserId, {
        type: 'text',
        text: `✅ 已有人接單\n⏱ 預計 ${etaMin} 分鐘抵達取件地點`,
      });
    } catch (err) {
      console.error('❌ push customer ETA failed:', err.message);
    }

    return;
  }

  // ===== 已抵達 =====
  if (t === '已抵達') {
    if (job.riderUserId !== userId) {
      return replyText(event.replyToken, '只有已接單騎手可以回報此狀態。');
    }

    job.status = 'arrived_pickup';

    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: '✅ 已回報：已抵達取件地點',
    });

    try {
      await client.pushMessage(job.customerUserId, {
        type: 'text',
        text: '✅ 騎手已抵達取件地點',
      });
    } catch (err) {
      console.error('❌ push arrived failed:', err.message);
    }
    return;
  }

  // ===== 已取件 =====
  if (t === '已取件') {
    if (job.riderUserId !== userId) {
      return replyText(event.replyToken, '只有已接單騎手可以回報此狀態。');
    }

    job.status = 'picked_up';

    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: '✅ 已回報：已取件',
    });

    try {
      await client.pushMessage(job.customerUserId, {
        type: 'text',
        text: '✅ 您的物品已取件，正在配送中',
      });
    } catch (err) {
      console.error('❌ push picked up failed:', err.message);
    }
    return;
  }

  // ===== 已送達 =====
  if (t === '已送達') {
    if (job.riderUserId !== userId) {
      return replyText(event.replyToken, '只有已接單騎手可以回報此狀態。');
    }

    job.status = 'delivered';

    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: '✅ 已回報：已送達',
    });

    try {
      await client.pushMessage(job.customerUserId, {
        type: 'text',
        text: '✅ 您的任務已送達',
      });
    } catch (err) {
      console.error('❌ push delivered failed:', err.message);
    }
    return;
  }

  // ===== 已完成 =====
  if (t === '已完成') {
    if (job.riderUserId !== userId) {
      return replyText(event.replyToken, '只有已接單騎手可以回報此狀態。');
    }

    job.status = 'completed';

    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: '✅ 已回報：任務完成',
    });

    try {
      await client.pushMessage(job.customerUserId, {
        type: 'text',
        text:
          `✅ 已抵達目的地，任務已完成。\n\n` +
          `感謝您使用 UBee 城市任務跑腿服務。\n` +
          `期待再次為您服務。`,
      });
    } catch (err) {
      console.error('❌ push completed failed:', err.message);
    }

    delete activeJobs[groupId];
    delete pendingRiderAccept[groupId];
    return;
  }

  return replyText(
    event.replyToken,
    `可使用指令：\n接\n已抵達\n已取件\n已送達\n已完成`
  );
}

// ====== 主事件處理 ======
async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') {
      return null;
    }

    const text = safeText(event.message.text);

    if (event.source.type === 'user') {
      return handleUserMessage(event, text);
    }

    if (event.source.type === 'group' || event.source.type === 'room') {
      return handleGroupMessage(event, text);
    }

    return null;
  } catch (err) {
    console.error('❌ handleEvent error:', err);
    if (event.replyToken) {
      try {
        await replyText(event.replyToken, '系統忙碌中，請稍後再試。');
      } catch (replyErr) {
        console.error('❌ reply fallback error:', replyErr.message);
      }
    }
    return null;
  }
}

// ====== Express ======
app.get('/', (req, res) => {
  res.status(200).send('UBee bot v3.1 running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('❌ webhook error:', err);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log(`✅ UBee bot v3.1 running on port ${PORT}`);
});

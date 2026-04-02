require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');

const app = express();

// =========================
// LINE 基本設定
// =========================
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

if (!LINE_GROUP_ID) {
  console.warn('⚠️ LINE_GROUP_ID 未設定，確認派單將無法推送到群組');
}

if (!GOOGLE_MAPS_API_KEY) {
  console.warn('⚠️ GOOGLE_MAPS_API_KEY 未設定，距離與時間將無法精準估算');
}

// =========================
// 費率設定（可自行修改）
// =========================
const BASE_FEE = 99;          // 基本費
const PER_KM_FEE = 6;         // 每公里
const PER_MIN_FEE = 3;        // 每分鐘
const CROSS_DISTRICT_FEE = 25; // 跨區加價
const SERVICE_FEE = 50;       // 固定服務費
const URGENT_FEE = 100;       // 急件費
const FIXED_TAX = 15;         // 固定稅金

// =========================
// 記憶體暫存（目前版本）
// 若 Render 重啟，資料會清空，先適合測試與初期營運
// =========================
const userSessions = {};      // 客戶引導填表狀態：userId -> session
const riderEtaSessions = {};  // 騎手 ETA 回覆狀態：groupId:userId -> orderId
const orders = {};            // orderId -> order
let orderSeq = 1;

// =========================
// Express
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee OMS V3.6 Running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('❌ Webhook Error:', err);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log(`✅ UBee V3.6 running on port ${PORT}`);
});

// =========================
// 主事件處理
// =========================
async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') {
      return null;
    }

    const text = (event.message.text || '').trim();
    const sourceType = event.source.type;

    if (sourceType === 'user') {
      return await handleUserMessage(event, text);
    }

    if (sourceType === 'group' || sourceType === 'room') {
      return await handleGroupMessage(event, text);
    }

    return null;
  } catch (err) {
    console.error('❌ handleEvent error:', err);
    return safeReply(event.replyToken, [
      { type: 'text', text: '⚠️ 系統暫時忙碌中，請稍後再試一次。' }
    ]);
  }
}

// =========================
// 客戶私訊處理
// =========================
async function handleUserMessage(event, text) {
  const userId = event.source.userId;
  const session = userSessions[userId];

  // 開始建立任務
  if (text === '建立任務') {
    userSessions[userId] = createNewTaskSession();
    return replyText(event.replyToken,
      '📦 UBee 建立任務\n\n請先輸入【取件地點】\n例如：台中市豐原區中正路100號'
    );
  }

  // 取消
  if (text === '取消') {
    delete userSessions[userId];
    return replyText(event.replyToken, '已取消本次任務建立。');
  }

  // 若正在引導式建立任務
  if (session && session.mode === 'create_task') {
    return await handleGuidedTaskFlow(event, text, session);
  }

  // 快速指令
  if (text === '立即估價') {
    return replyText(
      event.replyToken,
      '請輸入「建立任務」，系統會一步一步引導您填寫並自動精準報價。'
    );
  }

  // 客人完成任務後若說謝謝
  if (['謝謝', 'thanks', 'thank you'].includes(text.toLowerCase())) {
    return replyText(
      event.replyToken,
      '不客氣 🙌\n感謝您使用 UBee 城市任務服務，期待再次為您服務。'
    );
  }

  // 預設提示
  return replyText(
    event.replyToken,
    '您好，歡迎使用 UBee。\n\n可直接輸入：\n1. 建立任務\n2. 立即估價'
  );
}

// =========================
// 引導式建立任務流程
// =========================
async function handleGuidedTaskFlow(event, text, session) {
  const userId = event.source.userId;

  // 最後確認階段
  if (session.step === 'final_confirm') {
    if (text === '確認') {
      if (!session.quote) {
        return replyText(event.replyToken, '⚠️ 報價資料異常，請輸入「修改」重新填寫。');
      }

      const orderId = generateOrderId();
      const order = {
        id: orderId,
        userId,
        customerSourceType: event.source.type,
        customerData: { ...session.form },
        quote: { ...session.quote },
        status: 'waiting_rider',
        createdAt: new Date().toISOString(),
        riderId: null,
        riderName: null,
        etaMinutes: null,
        hiddenSeq: orderSeq,
      };

      orders[orderId] = order;

      // 派單到群組
      const pushOk = await pushTaskToGroup(order);

      delete userSessions[userId];

      if (!pushOk) {
        return replyText(
          event.replyToken,
          '⚠️ 任務已建立，但派單到群組失敗。\n請稍後再試，或檢查 LINE_GROUP_ID / 群組設定。'
        );
      }

      return replyText(
        event.replyToken,
        [
          '✅ 您的任務已建立成功',
          '',
          formatCustomerSummary(order.customerData),
          '',
          formatQuoteBlock(order.quote),
          '',
          '我們會立即為您安排人員處理。'
        ].join('\n')
      );
    }

    if (text === '修改') {
      userSessions[userId] = createNewTaskSession();
      return replyText(
        event.replyToken,
        '好的，重新建立任務。\n\n請先輸入【取件地點】'
      );
    }

    if (text === '取消') {
      delete userSessions[userId];
      return replyText(event.replyToken, '已取消本次任務建立。');
    }

    return replyText(
      event.replyToken,
      '請回覆以下其中一個指令：\n\n確認\n修改\n取消'
    );
  }

  // 正常填寫流程
  switch (session.step) {
    case 'pickup_address':
      session.form.pickupAddress = text;
      session.step = 'pickup_phone';
      return replyText(event.replyToken, '請輸入【取件電話】');

    case 'pickup_phone':
      session.form.pickupPhone = text;
      session.step = 'delivery_address';
      return replyText(event.replyToken, '請輸入【送達地點】');

    case 'delivery_address':
      session.form.deliveryAddress = text;
      session.step = 'delivery_phone';
      return replyText(event.replyToken, '請輸入【送達電話】');

    case 'delivery_phone':
      session.form.deliveryPhone = text;
      session.step = 'item';
      return replyText(event.replyToken, '請輸入【物品內容】\n例如：文件、樣品、合約');

    case 'item':
      session.form.item = text;
      session.step = 'urgent';
      return replyText(event.replyToken, '請輸入【是否急件】\n請回覆：一般 或 急件');

    case 'urgent':
      if (!['一般', '急件'].includes(text)) {
        return replyText(event.replyToken, '請回覆【一般】或【急件】');
      }
      session.form.urgent = text;
      session.step = 'note';
      return replyText(event.replyToken, '請輸入【備註】\n若無可輸入：無');

    case 'note':
      session.form.note = text;

      // 計算報價
      const quote = await buildQuote(session.form);
      if (!quote.ok) {
        return replyText(
          event.replyToken,
          '⚠️ 地址計算失敗，請輸入「修改」重新建立任務，並盡量填寫完整地址。\n例如：台中市豐原區中正路100號'
        );
      }

      session.quote = quote.data;
      session.step = 'final_confirm';

      return replyText(
        event.replyToken,
        [
          '請確認以下任務資訊：',
          '',
          formatCustomerSummary(session.form),
          '',
          formatQuoteBlock(session.quote),
          '',
          '請回覆：',
          '確認',
          '修改',
          '取消'
        ].join('\n')
      );

    default:
      delete userSessions[userId];
      return replyText(event.replyToken, '⚠️ 流程已重置，請重新輸入「建立任務」。');
  }
}

// =========================
// 群組訊息處理（騎手接單 / 回報）
// =========================
async function handleGroupMessage(event, text) {
  const groupId = event.source.groupId || event.source.roomId || LINE_GROUP_ID;
  const riderUserId = event.source.userId;
  const etaKey = `${groupId}:${riderUserId}`;

  // 騎手如果剛被詢問 ETA
  if (riderEtaSessions[etaKey]) {
    const orderId = riderEtaSessions[etaKey];
    const order = orders[orderId];

    if (!order || order.status !== 'waiting_rider') {
      delete riderEtaSessions[etaKey];
      return replyText(event.replyToken, '⚠️ 此任務目前無法接單。');
    }

    const etaMinutes = parseEtaMinutes(text);
    if (!etaMinutes) {
      return replyText(
        event.replyToken,
        '請直接回覆數字或分鐘數。\n例如：8\n或：8分鐘'
      );
    }

    const riderName = await getRiderDisplayName(groupId, riderUserId);
    order.status = 'accepted';
    order.riderId = riderUserId;
    order.riderName = riderName;
    order.etaMinutes = etaMinutes;
    order.acceptedAt = new Date().toISOString();

    delete riderEtaSessions[etaKey];

    // 通知群組
    await safeReply(event.replyToken, [
      {
        type: 'text',
        text: `✅ 此任務已由 ${riderName} 接單\n⏱ 預計 ${etaMinutes} 分鐘抵達取件地點`
      }
    ]);

    // 通知客戶
    await pushToUser(order.userId, [
      {
        type: 'text',
        text:
          `✅ 已有人接單\n` +
          `接單人員：${riderName}\n` +
          `⏱ 預計 ${etaMinutes} 分鐘抵達取件地點`
      }
    ]);

    return null;
  }

  // 騎手開始接單
  if (['接', '接單', '+1'].includes(text)) {
    const order = findLatestWaitingOrder();

    if (!order) {
      return replyText(event.replyToken, '目前沒有待接任務。');
    }

    riderEtaSessions[etaKey] = order.id;
    return replyText(
      event.replyToken,
      '請回覆多久可抵達取件地點？\n\n例如：8\n或：8分鐘'
    );
  }

  // 已抵達
  if (text === '已抵達') {
    const order = findRiderActiveOrder(riderUserId);
    if (!order) {
      return replyText(event.replyToken, '⚠️ 目前沒有可更新的任務。');
    }

    order.status = 'arrived_pickup';

    await pushToUser(order.userId, [
      { type: 'text', text: '📍 服務人員已抵達取件地點。' }
    ]);

    return replyText(event.replyToken, '✅ 已通知客戶：服務人員已抵達取件地點。');
  }

  // 已取件
  if (text === '已取件') {
    const order = findRiderActiveOrder(riderUserId);
    if (!order) {
      return replyText(event.replyToken, '⚠️ 目前沒有可更新的任務。');
    }

    order.status = 'picked_up';

    await pushToUser(order.userId, [
      { type: 'text', text: '📦 物品已完成取件，正送往目的地。' }
    ]);

    return replyText(event.replyToken, '✅ 已通知客戶：物品已完成取件。');
  }

  // 已送達
  if (text === '已送達') {
    const order = findRiderActiveOrder(riderUserId);
    if (!order) {
      return replyText(event.replyToken, '⚠️ 目前沒有可更新的任務。');
    }

    order.status = 'delivered';

    await pushToUser(order.userId, [
      { type: 'text', text: '📬 物品已送達指定地點。' }
    ]);

    return replyText(event.replyToken, '✅ 已通知客戶：物品已送達。');
  }

  // 已完成
  if (text === '已完成') {
    const order = findRiderActiveOrder(riderUserId);
    if (!order) {
      return replyText(event.replyToken, '⚠️ 目前沒有可完成的任務。');
    }

    order.status = 'completed';
    order.completedAt = new Date().toISOString();

    await pushToUser(order.userId, [
      {
        type: 'text',
        text:
          '✅ 任務已完成。\n\n' +
          '感謝您使用 UBee 城市任務服務。\n' +
          '期待再次為您服務。'
      }
    ]);

    return replyText(event.replyToken, '✅ 任務已完成，已通知客戶。');
  }

  return null;
}

// =========================
// Session / Order 工具
// =========================
function createNewTaskSession() {
  return {
    mode: 'create_task',
    step: 'pickup_address',
    form: {
      pickupAddress: '',
      pickupPhone: '',
      deliveryAddress: '',
      deliveryPhone: '',
      item: '',
      urgent: '一般',
      note: '無',
    },
    quote: null,
  };
}

function generateOrderId() {
  const id = `ORDER_${Date.now()}_${orderSeq}`;
  orderSeq += 1;
  return id;
}

function findLatestWaitingOrder() {
  const waitingOrders = Object.values(orders)
    .filter(order => order.status === 'waiting_rider')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return waitingOrders[0] || null;
}

function findRiderActiveOrder(riderUserId) {
  const activeStatuses = ['accepted', 'arrived_pickup', 'picked_up', 'delivered'];
  const riderOrders = Object.values(orders)
    .filter(order => order.riderId === riderUserId && activeStatuses.includes(order.status))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return riderOrders[0] || null;
}

function parseEtaMinutes(text) {
  const cleaned = String(text).trim();
  const match = cleaned.match(/(\d{1,3})/);
  if (!match) return null;

  const val = parseInt(match[1], 10);
  if (Number.isNaN(val) || val <= 0 || val > 180) return null;
  return val;
}

// =========================
// 推播 / 回覆
// =========================
async function replyText(replyToken, text) {
  return safeReply(replyToken, [{ type: 'text', text }]);
}

async function safeReply(replyToken, messages) {
  try {
    return await client.replyMessage(replyToken, messages);
  } catch (err) {
    console.error('❌ replyMessage error:', err?.originalError?.response?.data || err.message || err);
    return null;
  }
}

async function pushToUser(userId, messages) {
  try {
    return await client.pushMessage(userId, messages);
  } catch (err) {
    console.error('❌ pushToUser error:', err?.originalError?.response?.data || err.message || err);
    return null;
  }
}

async function pushTaskToGroup(order) {
  if (!LINE_GROUP_ID) return false;

  const taskText =
    `📦 UBee 新任務通知\n\n` +
    `費用：$${order.quote.total}\n` +
    `距離：${order.quote.distanceKm.toFixed(1)} 公里\n\n` +
    `取件：${order.customerData.pickupAddress}\n` +
    `送達：${order.customerData.deliveryAddress}\n` +
    `物品：${order.customerData.item}\n` +
    `急件：${order.customerData.urgent}`;

  try {
    await client.pushMessage(LINE_GROUP_ID, [
      { type: 'text', text: taskText }
    ]);
    return true;
  } catch (err) {
    console.error('❌ pushTaskToGroup error:', err?.originalError?.response?.data || err.message || err);
    return false;
  }
}

// =========================
// 格式化
// =========================
function formatCustomerSummary(form) {
  return [
    `取件地點：${form.pickupAddress}`,
    `取件電話：${form.pickupPhone}`,
    ``,
    `送達地點：${form.deliveryAddress}`,
    `送達電話：${form.deliveryPhone}`,
    ``,
    `物品內容：${form.item}`,
    `是否急件：${form.urgent}`,
    `備註：${form.note || '無'}`
  ].join('\n');
}

function formatQuoteBlock(quote) {
  return [
    `配送費：$${quote.deliveryFee}`,
    `服務費：$${quote.serviceFee}`,
    `急件費：$${quote.urgentFee}`,
    `稅金：$${quote.tax}`,
    `總計：$${quote.total}`
  ].join('\n');
}

// =========================
// 騎手名稱
// =========================
async function getRiderDisplayName(groupId, userId) {
  try {
    if (!groupId || !userId) return '接單人員';

    const profile = await client.getGroupMemberProfile(groupId, userId);
    if (profile && profile.displayName) {
      return profile.displayName;
    }
    return '接單人員';
  } catch (err) {
    console.error('⚠️ getGroupMemberProfile error:', err.message || err);
    return '接單人員';
  }
}

// =========================
// 報價核心
// =========================
async function buildQuote(form) {
  try {
    const route = await getRouteInfo(form.pickupAddress, form.deliveryAddress);
    if (!route.ok) {
      return { ok: false };
    }

    const pickupDistrict = await getDistrictFromAddress(form.pickupAddress);
    const deliveryDistrict = await getDistrictFromAddress(form.deliveryAddress);

    const distanceKm = route.distanceMeters / 1000;
    const durationMin = route.durationSeconds / 60;

    const baseFee = BASE_FEE;
    const kmFee = Math.ceil(distanceKm) * PER_KM_FEE;
    const minFee = Math.ceil(durationMin) * PER_MIN_FEE;

    let crossDistrictFee = 0;
    if (
      pickupDistrict &&
      deliveryDistrict &&
      pickupDistrict !== deliveryDistrict
    ) {
      crossDistrictFee = CROSS_DISTRICT_FEE;
    }

    const urgentFee = form.urgent === '急件' ? URGENT_FEE : 0;
    const serviceFee = SERVICE_FEE;
    const tax = FIXED_TAX;

    const deliveryFee = baseFee + kmFee + minFee + crossDistrictFee;
    const total = deliveryFee + serviceFee + urgentFee + tax;

    return {
      ok: true,
      data: {
        baseFee,
        kmFee,
        minFee,
        crossDistrictFee,
        deliveryFee,
        serviceFee,
        urgentFee,
        tax,
        total,
        distanceKm,
        durationMin,
        pickupDistrict,
        deliveryDistrict,
      }
    };
  } catch (err) {
    console.error('❌ buildQuote error:', err.message || err);
    return { ok: false };
  }
}

// =========================
// Google Maps API
// 優先使用 Distance Matrix
// =========================
async function getRouteInfo(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    return { ok: false };
  }

  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(destination)}` +
    `&mode=driving` +
    `&language=zh-TW` +
    `&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (
    data.status !== 'OK' ||
    !data.rows ||
    !data.rows[0] ||
    !data.rows[0].elements ||
    !data.rows[0].elements[0] ||
    data.rows[0].elements[0].status !== 'OK'
  ) {
    console.error('❌ Distance Matrix error:', JSON.stringify(data));
    return { ok: false };
  }

  const el = data.rows[0].elements[0];

  return {
    ok: true,
    distanceMeters: el.distance.value,
    durationSeconds: el.duration.value,
  };
}

async function getDistrictFromAddress(address) {
  if (!GOOGLE_MAPS_API_KEY) return null;

  try {
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json` +
      `?address=${encodeURIComponent(address)}` +
      `&language=zh-TW` +
      `&key=${GOOGLE_MAPS_API_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== 'OK' || !data.results || !data.results[0]) {
      return extractDistrictByRegex(address);
    }

    const components = data.results[0].address_components || [];

    // 先找行政區
    for (const c of components) {
      if (
        c.types.includes('administrative_area_level_3') ||
        c.types.includes('administrative_area_level_2') ||
        c.types.includes('sublocality_level_1')
      ) {
        const name = c.long_name || c.short_name;
        const district = normalizeDistrictName(name);
        if (district) return district;
      }
    }

    return extractDistrictByRegex(data.results[0].formatted_address || address);
  } catch (err) {
    console.error('⚠️ getDistrictFromAddress error:', err.message || err);
    return extractDistrictByRegex(address);
  }
}

function normalizeDistrictName(name) {
  if (!name) return null;
  const match = String(name).match(/(.+[區鄉鎮市])/);
  return match ? match[1] : null;
}

function extractDistrictByRegex(address) {
  if (!address) return null;
  const match = String(address).match(/([^\s,，]+[區鄉鎮市])/);
  return match ? match[1] : null;
}
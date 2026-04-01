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
// 費率設定
// =========================
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const URGENT_FEE = 100;
const SERVICE_FEE = 50;
const FIXED_TAX = 15;

// 騎手分潤：配送費 * 0.6
const RIDER_RATE = 0.6;

// =========================
// 記憶體資料（V3 穩定版）
// =========================
const userSessions = new Map();      // userId -> session
const jobs = new Map();              // jobId -> job
const riderPendingEta = new Map();   // riderUserId -> jobId

// =========================
// 工具函式
// =========================
function safeText(val = '') {
  return String(val).trim();
}

function makeJobId() {
  return `J${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function createEmptyTask() {
  return {
    pickupAddress: '',
    pickupPhone: '',
    deliveryAddress: '',
    deliveryPhone: '',
    item: '',
    urgency: '', // 一般 / 急件
    note: '',
    pricing: null,
  };
}

function getSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      mode: null,        // create / quote
      step: null,
      task: createEmptyTask(),
      lastInteraction: Date.now(),
    });
  }
  return userSessions.get(userId);
}

function resetSession(userId) {
  userSessions.set(userId, {
    mode: null,
    step: null,
    task: createEmptyTask(),
    lastInteraction: Date.now(),
  });
}

function getDistrict(address = '') {
  const text = safeText(address);
  const match =
    text.match(/台中市(.+?[區鄉鎮市])/)
    || text.match(/(.+?[區鄉鎮市])/);
  return match ? match[1] : '';
}

function isCrossDistrict(pickup, delivery) {
  const a = getDistrict(pickup);
  const b = getDistrict(delivery);
  if (!a || !b) return false;
  return a !== b;
}

function round(n) {
  return Math.round(Number(n || 0));
}

async function getDistanceAndDuration(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('Missing GOOGLE_MAPS_API_KEY');
  }

  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  url.searchParams.set('origins', origin);
  url.searchParams.set('destinations', destination);
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('language', 'zh-TW');
  url.searchParams.set('key', GOOGLE_MAPS_API_KEY);

  const response = await fetch(url.toString());
  const data = await response.json();

  if (
    !data.rows ||
    !data.rows[0] ||
    !data.rows[0].elements ||
    !data.rows[0].elements[0]
  ) {
    throw new Error('Google Maps API 回傳格式異常');
  }

  const element = data.rows[0].elements[0];

  if (element.status !== 'OK') {
    throw new Error(`地址距離查詢失敗：${element.status}`);
  }

  const meters = element.distance.value || 0;
  const seconds = element.duration.value || 0;

  const km = meters / 1000;
  const mins = seconds / 60;

  return {
    distanceKm: Number(km.toFixed(1)),
    durationMin: Math.max(1, round(mins)),
  };
}

async function calculatePrice(task) {
  const route = await getDistanceAndDuration(task.pickupAddress, task.deliveryAddress);

  const crossDistrictFee = isCrossDistrict(task.pickupAddress, task.deliveryAddress)
    ? CROSS_DISTRICT_FEE
    : 0;

  const urgentFee = task.urgency === '急件' ? URGENT_FEE : 0;

  const deliveryFee =
    BASE_FEE +
    round(route.distanceKm * PER_KM_FEE) +
    round(route.durationMin * PER_MIN_FEE) +
    crossDistrictFee;

  const subtotal = deliveryFee + urgentFee + SERVICE_FEE;
  const total = subtotal + FIXED_TAX;
  const riderFee = round(deliveryFee * RIDER_RATE);

  return {
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
    deliveryFee,
    urgentFee,
    serviceFee: SERVICE_FEE,
    tax: FIXED_TAX,
    subtotal,
    total,
    riderFee,
    crossDistrictFee,
  };
}

function formatCustomerPrice(pricing) {
  return [
    `配送費：$${pricing.deliveryFee}`,
    `急件費：$${pricing.urgentFee}`,
    `服務費：$${pricing.serviceFee}`,
    `稅金：$${pricing.tax}`,
    `總計：$${pricing.total}`,
  ].join('\n');
}

function formatTaskSummary(task) {
  return [
    `取件地點：${task.pickupAddress}`,
    `取件電話：${task.pickupPhone}`,
    '',
    `送達地點：${task.deliveryAddress}`,
    `送達電話：${task.deliveryPhone}`,
    '',
    `物品內容：${task.item}`,
    `是否急件：${task.urgency}`,
    `備註：${task.note || '無'}`,
    '',
    task.pricing ? formatCustomerPrice(task.pricing) : '',
  ].filter(Boolean).join('\n');
}

function createButtonsTemplate(task) {
  return {
    type: 'template',
    altText: '請確認您的任務資料',
    template: {
      type: 'buttons',
      title: '請確認任務資料',
      text: '確認無誤後送出，或選擇修改 / 取消',
      actions: [
        {
          type: 'postback',
          label: '確認送出',
          data: 'action=confirm_create',
          displayText: '確認送出',
        },
        {
          type: 'postback',
          label: '修改資料',
          data: 'action=edit_create',
          displayText: '修改資料',
        },
        {
          type: 'postback',
          label: '取消任務',
          data: 'action=cancel_create',
          displayText: '取消任務',
        },
      ],
    },
  };
}

function createQuickMenuText() {
  return {
    type: 'text',
    text:
      '您好，歡迎使用 UBee。\n' +
      '請輸入以下指令：\n' +
      '・建立任務\n' +
      '・立即估價\n' +
      '・幫助',
  };
}

function getNextOpenJob() {
  const openJobs = Array.from(jobs.values())
    .filter((job) => job.status === 'open')
    .sort((a, b) => a.createdAt - b.createdAt);

  return openJobs[0] || null;
}

function getRiderActiveJob(riderUserId) {
  const riderJobs = Array.from(jobs.values())
    .filter((job) => job.riderUserId === riderUserId && ['accepted', 'arrived', 'picked'].includes(job.status))
    .sort((a, b) => b.createdAt - a.createdAt);

  return riderJobs[0] || null;
}

async function pushToUser(userId, text) {
  return client.pushMessage(userId, {
    type: 'text',
    text,
  });
}

async function pushTaskToGroup(job) {
  if (!LINE_GROUP_ID) {
    console.warn('⚠️ LINE_GROUP_ID 未設定，無法派單到群組');
    return;
  }

  const text =
    '📦 UBee 新任務通知\n\n' +
    `費用：$${job.pricing.riderFee}\n` +
    `距離：${job.pricing.distanceKm} 公里\n\n` +
    `取件：${job.pickupAddress}\n` +
    `送達：${job.deliveryAddress}\n` +
    `物品：${job.item}\n` +
    `急件：${job.urgency}`;

  await client.pushMessage(LINE_GROUP_ID, {
    type: 'text',
    text,
  });
}

async function replyText(replyToken, texts) {
  const messages = (Array.isArray(texts) ? texts : [texts]).map((text) => ({
    type: 'text',
    text,
  }));
  return client.replyMessage(replyToken, messages);
}

async function askNextStep(replyToken, session) {
  const prompts = {
    pickupAddress: '請輸入取件地點',
    pickupPhone: '請輸入取件電話',
    deliveryAddress: '請輸入送達地點',
    deliveryPhone: '請輸入送達電話',
    item: '請輸入物品內容',
    urgency: '請輸入是否急件（一般 / 急件）',
    note: '請輸入備註（若無可輸入：無）',
  };

  return replyText(replyToken, prompts[session.step] || '請繼續輸入資料');
}

function normalizeUrgency(text) {
  const t = safeText(text);
  if (t === '急件') return '急件';
  if (t === '一般') return '一般';
  return null;
}

async function startCreateFlow(replyToken, userId) {
  const session = getSession(userId);
  session.mode = 'create';
  session.step = 'pickupAddress';
  session.task = createEmptyTask();
  session.lastInteraction = Date.now();

  return replyText(replyToken, '好的，開始建立任務。\n請輸入取件地點');
}

async function startQuoteFlow(replyToken, userId) {
  const session = getSession(userId);
  session.mode = 'quote';
  session.step = 'pickupAddress';
  session.task = createEmptyTask();
  session.lastInteraction = Date.now();

  return replyText(replyToken, '好的，開始立即估價。\n請輸入取件地點');
}

async function finalizeQuote(replyToken, userId) {
  const session = getSession(userId);

  try {
    const pricing = await calculatePrice(session.task);
    session.task.pricing = pricing;

    const summary =
      '✅ 立即估價完成\n\n' +
      formatCustomerPrice(pricing);

    resetSession(userId);
    return replyText(replyToken, summary);
  } catch (err) {
    console.error('❌ quote error:', err.message);
    resetSession(userId);
    return replyText(replyToken, '抱歉，地址估價失敗，請確認地址是否完整後再試一次。');
  }
}

async function finalizeCreatePreview(replyToken, userId) {
  const session = getSession(userId);

  try {
    const pricing = await calculatePrice(session.task);
    session.task.pricing = pricing;

    const summary =
      '請確認以下任務資料：\n\n' +
      formatTaskSummary(session.task);

    return client.replyMessage(replyToken, [
      { type: 'text', text: summary },
      createButtonsTemplate(session.task),
    ]);
  } catch (err) {
    console.error('❌ create preview error:', err.message);
    resetSession(userId);
    return replyText(replyToken, '抱歉，任務建立前估價失敗，請確認地址是否完整後再試一次。');
  }
}

async function submitConfirmedJob(replyToken, userId) {
  const session = getSession(userId);

  if (!session.task || !session.task.pricing) {
    resetSession(userId);
    return replyText(replyToken, '找不到待確認任務，請重新輸入「建立任務」。');
  }

  const jobId = makeJobId();
  const job = {
    id: jobId,
    userId,
    status: 'open',
    createdAt: Date.now(),
    riderUserId: null,
    riderName: null,
    etaMin: null,
    ...session.task,
  };

  jobs.set(jobId, job);
  resetSession(userId);

  try {
    await pushTaskToGroup(job);

    return replyText(
      replyToken,
      '✅ 您的任務已建立成功，我們會立即為您派單。\n\n' +
      formatCustomerPrice(job.pricing)
    );
  } catch (err) {
    console.error('❌ push group error:', err.message);
    return replyText(
      replyToken,
      '✅ 您的任務已建立成功。\n但目前群組派單暫時失敗，請稍後檢查 LINE_GROUP_ID 設定。'
    );
  }
}

async function handleTaskInput(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const text = safeText(event.message.text);
  const session = getSession(userId);
  session.lastInteraction = Date.now();

  if (!session.mode || !session.step) {
    if (text === '建立任務') return startCreateFlow(replyToken, userId);
    if (text === '立即估價') return startQuoteFlow(replyToken, userId);
    if (text === '幫助' || text === 'help') return replyText(replyToken, createQuickMenuText().text);

    return replyText(replyToken, createQuickMenuText().text);
  }

  if (text === '取消' || text === '取消任務') {
    resetSession(userId);
    return replyText(replyToken, '已取消本次流程。');
  }

  // 修改資料：重新開始
  if (text === '修改資料' || text === '修改任務') {
    session.mode = 'create';
    session.step = 'pickupAddress';
    session.task = createEmptyTask();
    return replyText(replyToken, '好的，重新開始建立任務。\n請輸入取件地點');
  }

  switch (session.step) {
    case 'pickupAddress':
      session.task.pickupAddress = text;
      session.step = 'pickupPhone';
      return askNextStep(replyToken, session);

    case 'pickupPhone':
      session.task.pickupPhone = text;
      session.step = 'deliveryAddress';
      return askNextStep(replyToken, session);

    case 'deliveryAddress':
      session.task.deliveryAddress = text;
      session.step = 'deliveryPhone';
      return askNextStep(replyToken, session);

    case 'deliveryPhone':
      session.task.deliveryPhone = text;
      session.step = 'item';
      return askNextStep(replyToken, session);

    case 'item':
      session.task.item = text;
      session.step = 'urgency';
      return askNextStep(replyToken, session);

    case 'urgency': {
      const urgency = normalizeUrgency(text);
      if (!urgency) {
        return replyText(replyToken, '請輸入「一般」或「急件」');
      }
      session.task.urgency = urgency;
      session.step = 'note';
      return askNextStep(replyToken, session);
    }

    case 'note':
      session.task.note = text === '無' ? '' : text;
      session.step = 'confirm';

      if (session.mode === 'quote') {
        return finalizeQuote(replyToken, userId);
      }

      if (session.mode === 'create') {
        return finalizeCreatePreview(replyToken, userId);
      }

      resetSession(userId);
      return replyText(replyToken, '流程異常，請重新輸入。');

    default:
      resetSession(userId);
      return replyText(replyToken, '流程異常，請重新輸入「建立任務」或「立即估價」。');
  }
}

async function handlePostback(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const data = safeText(event.postback.data);
  const session = getSession(userId);

  if (data === 'action=confirm_create') {
    return submitConfirmedJob(replyToken, userId);
  }

  if (data === 'action=edit_create') {
    session.mode = 'create';
    session.step = 'pickupAddress';
    session.task = createEmptyTask();
    return replyText(replyToken, '好的，請重新填寫任務資料。\n請輸入取件地點');
  }

  if (data === 'action=cancel_create') {
    resetSession(userId);
    return replyText(replyToken, '已取消本次任務。');
  }

  return replyText(replyToken, '未知操作。');
}

async function handleGroupText(event) {
  const text = safeText(event.message.text);
  const replyToken = event.replyToken;
  const riderUserId = event.source.userId;

  let riderName = '騎手';
  try {
    if (event.source.groupId && riderUserId) {
      const profile = await client.getGroupMemberProfile(event.source.groupId, riderUserId);
      riderName = profile.displayName || '騎手';
    }
  } catch (err) {
    console.warn('⚠️ 無法取得群組成員名稱:', err.message);
  }

  // 接單 8 / 接 8
  const instantAccept = text.match(/^(接單|接)\s*(\d{1,3})$/);
  if (instantAccept) {
    const eta = Number(instantAccept[2]);
    const job = getNextOpenJob();

    if (!job) {
      return replyText(replyToken, '目前沒有可接任務。');
    }

    job.status = 'accepted';
    job.riderUserId = riderUserId;
    job.riderName = riderName;
    job.etaMin = eta;

    await pushToUser(
      job.userId,
      `✅ 已有人接單\n預計 ${eta} 分鐘抵達取件地點`
    );

    return replyText(replyToken, `✅ 已收到接單\n⏱ 預計 ${eta} 分鐘抵達取件地點`);
  }

  // 接 / 接單
  if (text === '接' || text === '接單') {
    const job = getNextOpenJob();

    if (!job) {
      return replyText(replyToken, '目前沒有可接任務。');
    }

    riderPendingEta.set(riderUserId, job.id);
    return replyText(replyToken, '✅ 已收到接單\n請回覆幾分鐘會到取件地點\n例如：8');
  }

  // 接單後只回數字
  if (/^\d{1,3}$/.test(text) && riderPendingEta.has(riderUserId)) {
    const eta = Number(text);
    const jobId = riderPendingEta.get(riderUserId);
    riderPendingEta.delete(riderUserId);

    const job = jobs.get(jobId);
    if (!job || job.status !== 'open') {
      return replyText(replyToken, '此任務目前已不可接。');
    }

    job.status = 'accepted';
    job.riderUserId = riderUserId;
    job.riderName = riderName;
    job.etaMin = eta;

    await pushToUser(
      job.userId,
      `✅ 已有人接單\n預計 ${eta} 分鐘抵達取件地點`
    );

    return replyText(replyToken, `✅ 接單成功\n⏱ 預計 ${eta} 分鐘抵達取件地點`);
  }

  // 已抵達 / 已取件 / 已送達 / 已完成
  const activeJob = getRiderActiveJob(riderUserId);

  if (text === '已抵達') {
    if (!activeJob) return replyText(replyToken, '您目前沒有進行中的任務。');
    activeJob.status = 'arrived';
    await pushToUser(activeJob.userId, '✅ 騎手已抵達取件地點。');
    return replyText(replyToken, '已通知客人：騎手已抵達取件地點。');
  }

  if (text === '已取件') {
    if (!activeJob) return replyText(replyToken, '您目前沒有進行中的任務。');
    activeJob.status = 'picked';
    await pushToUser(activeJob.userId, '✅ 騎手已取件，正在前往送達地點。');
    return replyText(replyToken, '已通知客人：騎手已取件。');
  }

  if (text === '已送達' || text === '已完成') {
    if (!activeJob) return replyText(replyToken, '您目前沒有進行中的任務。');
    activeJob.status = 'completed';
    await pushToUser(
      activeJob.userId,
      '✅ 已抵達目的地，任務已完成。\n\n感謝您使用 UBee 城市任務跑腿服務。'
    );
    return replyText(replyToken, '✅ 任務已完成，已通知客人。');
  }

  return replyText(replyToken, '群組可用指令：接、接單 8、已抵達、已取件、已送達、已完成');
}

// =========================
// Webhook
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee bot v3 stable');
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

async function handleEvent(event) {
  try {
    if (event.type === 'postback') {
      return handlePostback(event);
    }

    if (event.type !== 'message' || event.message.type !== 'text') {
      return Promise.resolve(null);
    }

    if (event.source.type === 'group') {
      return handleGroupText(event);
    }

    if (event.source.type === 'user') {
      return handleTaskInput(event);
    }

    return Promise.resolve(null);
  } catch (err) {
    console.error('❌ handleEvent error:', err);
    if (event.replyToken) {
      try {
        return replyText(event.replyToken, '系統忙碌中，請稍後再試。');
      } catch (replyErr) {
        console.error('❌ reply fallback error:', replyErr);
      }
    }
    return Promise.resolve(null);
  }
}

app.listen(PORT, () => {
  console.log(`✅ UBee bot running on port ${PORT}`);
});

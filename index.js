require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');
const crypto = require('crypto');

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

// =========================
// 環境變數
// =========================
const LINE_GROUP_ID = (process.env.LINE_GROUP_ID || '').trim();
const GOOGLE_MAPS_API_KEY = (process.env.GOOGLE_MAPS_API_KEY || '').trim();

// 可選：限定哪些人可以按群組按鈕（建議你正式上線一定要設）
// 格式：Uxxxxxxxx,Uyyyyyyyy
const RIDER_USER_IDS = (process.env.RIDER_USER_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// 可選：admin 可強制操作
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// =========================
// 固定費率設定
// =========================
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const SERVICE_FEE = 50;
const URGENT_FEE = 100;
const FIXED_TAX = 15;

// 騎手抽成：配送費 * 0.6
const RIDER_SHARE_RATE = 0.6;

// 任務按鈕簽章密鑰
const ACTION_SECRET = process.env.ACTION_SECRET || 'ubee-v362-secret';

// 任務有效時間（避免舊按鈕被亂按）
const ORDER_EXPIRE_MS = 12 * 60 * 60 * 1000; // 12小時

// =========================
// 記憶體資料（Render 重啟會清空）
// =========================
const userSessions = new Map(); // 使用者填單暫存
const orders = new Map();       // 訂單資料

// =========================
// Webhook
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee OMS V3.6.2 Group Button Protected Running');
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
  console.log(`✅ UBee OMS V3.6.2 running on port ${PORT}`);
});

// =========================
// 主事件入口
// =========================
async function handleEvent(event) {
  try {
    if (event.type === 'message' && event.message.type === 'text') {
      return await handleTextMessage(event);
    }

    if (event.type === 'postback') {
      return await handlePostback(event);
    }

    return null;
  } catch (err) {
    console.error('❌ handleEvent Error:', err);
    return safeReply(event.replyToken, [{
      type: 'text',
      text: '系統發生錯誤，請稍後再試一次。'
    }]);
  }
}

// =========================
// 文字訊息處理
// =========================
async function handleTextMessage(event) {
  const text = (event.message.text || '').trim();
  const userId = event.source.userId;

  if (!userId) {
    return safeReply(event.replyToken, [{
      type: 'text',
      text: '目前無法辨識使用者，請改由 LINE 一對一聊天室操作。'
    }]);
  }

  // 群組內文字指令：只提示用按鈕，不接受文字亂操作
  if (event.source.type === 'group') {
    if (['接單', '已抵達', '已取件', '已送達', '已完成'].includes(text)) {
      return safeReply(event.replyToken, [{
        type: 'text',
        text: '請直接點擊任務卡片下方按鈕操作，不需要手動打字。'
      }]);
    }
    return null;
  }

  // 一對一聊天室
  if (text === '建立任務') {
    userSessions.set(userId, {
      mode: 'create',
      step: 'pickupAddress',
      form: {}
    });

    return safeReply(event.replyToken, [{
      type: 'text',
      text:
`好的，請輸入【取件地點】`
    }]);
  }

  if (text === '立即估價') {
    userSessions.set(userId, {
      mode: 'quote',
      step: 'pickupAddress',
      form: {}
    });

    return safeReply(event.replyToken, [{
      type: 'text',
      text:
`好的，請輸入【取件地點】`
    }]);
  }

  if (text === '取消' || text === '結束') {
    userSessions.delete(userId);
    return safeReply(event.replyToken, [{
      type: 'text',
      text: '已取消本次操作。'
    }]);
  }

  const session = userSessions.get(userId);
  if (!session) {
    return safeReply(event.replyToken, [{
      type: 'text',
      text:
`您好，請輸入以下指令開始使用：

建立任務
立即估價`
    }]);
  }

  return await handleSessionInput(event, session, text);
}

// =========================
// 引導填單流程
// =========================
async function handleSessionInput(event, session, text) {
  const userId = event.source.userId;
  const form = session.form;

  switch (session.step) {
    case 'pickupAddress':
      form.pickupAddress = text;
      session.step = 'pickupPhone';
      userSessions.set(userId, session);
      return safeReply(event.replyToken, [{
        type: 'text',
        text: '請輸入【取件電話】'
      }]);

    case 'pickupPhone':
      form.pickupPhone = text;
      session.step = 'dropoffAddress';
      userSessions.set(userId, session);
      return safeReply(event.replyToken, [{
        type: 'text',
        text: '請輸入【送達地點】'
      }]);

    case 'dropoffAddress':
      form.dropoffAddress = text;
      session.step = 'dropoffPhone';
      userSessions.set(userId, session);
      return safeReply(event.replyToken, [{
        type: 'text',
        text: '請輸入【送達電話】'
      }]);

    case 'dropoffPhone':
      form.dropoffPhone = text;
      session.step = 'item';
      userSessions.set(userId, session);
      return safeReply(event.replyToken, [{
        type: 'text',
        text: '請輸入【物品內容】'
      }]);

    case 'item':
      form.item = text;
      session.step = 'urgent';
      userSessions.set(userId, session);
      return safeReply(event.replyToken, [
        {
          type: 'template',
          altText: '請選擇是否急件',
          template: {
            type: 'buttons',
            text: '請選擇【是否急件】',
            actions: [
              {
                type: 'postback',
                label: '一般',
                data: `FORM|URGENT|general`,
                displayText: '一般'
              },
              {
                type: 'postback',
                label: '急件',
                data: `FORM|URGENT|urgent`,
                displayText: '急件'
              }
            ]
          }
        }
      ]);

    case 'note':
      form.note = text || '無';
      return await finalizeForm(event, session);

    default:
      userSessions.delete(userId);
      return safeReply(event.replyToken, [{
        type: 'text',
        text: '流程已重置，請重新輸入「建立任務」或「立即估價」。'
      }]);
  }
}

// =========================
// Postback 處理
// =========================
async function handlePostback(event) {
  const data = event.postback.data || '';
  const userId = event.source.userId;

  // 表單急件選擇
  if (data.startsWith('FORM|URGENT|')) {
    const session = userSessions.get(userId);
    if (!session) {
      return safeReply(event.replyToken, [{
        type: 'text',
        text: '本次填單流程已失效，請重新輸入「建立任務」或「立即估價」。'
      }]);
    }

    const urgentValue = data.split('|')[2];
    session.form.urgent = urgentValue === 'urgent' ? '急件' : '一般';
    session.step = 'note';
    userSessions.set(userId, session);

    return safeReply(event.replyToken, [{
      type: 'text',
      text: '請輸入【備註】\n若無備註請直接輸入：無'
    }]);
  }

  // 客戶確認建立任務
  if (data.startsWith('CUSTOMER|CREATE|')) {
    const payload = decodePayload(data.replace('CUSTOMER|CREATE|', ''));
    if (!payload) {
      return safeReply(event.replyToken, [{
        type: 'text',
        text: '資料已失效，請重新建立任務。'
      }]);
    }

    return await createOrderFromPayload(event, payload);
  }

  // 客戶重新填寫
  if (data === 'CUSTOMER|RESET') {
    userSessions.set(userId, {
      mode: 'create',
      step: 'pickupAddress',
      form: {}
    });

    return safeReply(event.replyToken, [{
      type: 'text',
      text: '好的，請重新輸入【取件地點】'
    }]);
  }

  // 客戶取消
  if (data === 'CUSTOMER|CANCEL') {
    userSessions.delete(userId);
    return safeReply(event.replyToken, [{
      type: 'text',
      text: '已取消本次任務。'
    }]);
  }

  // 群組任務按鈕
  if (data.startsWith('ORDER|')) {
    return await handleOrderAction(event, data);
  }

  return null;
}

// =========================
// 完成表單後估價/建單前確認
// =========================
async function finalizeForm(event, session) {
  const userId = event.source.userId;
  const form = session.form;

  try {
    const route = await getRouteInfo(form.pickupAddress, form.dropoffAddress);
    if (!route.ok) {
      userSessions.delete(userId);
      return safeReply(event.replyToken, [{
        type: 'text',
        text: `地址查詢失敗：${route.message}`
      }]);
    }

    const pricing = calculatePricing({
      distanceKm: route.distanceKm,
      durationMin: route.durationMin,
      pickupAddress: form.pickupAddress,
      dropoffAddress: form.dropoffAddress,
      urgent: form.urgent
    });

    const payload = {
      customerUserId: userId,
      sourceType: event.source.type,
      pickupAddress: form.pickupAddress,
      pickupPhone: form.pickupPhone,
      dropoffAddress: form.dropoffAddress,
      dropoffPhone: form.dropoffPhone,
      item: form.item,
      urgent: form.urgent,
      note: form.note || '無',
      route,
      pricing
    };

    if (session.mode === 'quote') {
      userSessions.delete(userId);
      return safeReply(event.replyToken, [{
        type: 'text',
        text:
`估價結果如下：

配送費：$${pricing.deliveryFee}
服務費：$${pricing.serviceFee}
急件費：$${pricing.urgentFee}
稅金：$${pricing.tax}
總計：$${pricing.total}

距離：約 ${route.distanceKm.toFixed(1)} 公里
時間：約 ${route.durationMin} 分鐘`
      }]);
    }

    // 建立任務模式：先顯示確認
    userSessions.delete(userId);

    return safeReply(event.replyToken, [
      {
        type: 'text',
        text:
`請確認以下任務資訊：

取件地點：${form.pickupAddress}
取件電話：${form.pickupPhone}

送達地點：${form.dropoffAddress}
送達電話：${form.dropoffPhone}

物品內容：${form.item}
是否急件：${form.urgent}
備註：${form.note || '無'}

配送費：$${pricing.deliveryFee}
服務費：$${pricing.serviceFee}
急件費：$${pricing.urgentFee}
稅金：$${pricing.tax}
總計：$${pricing.total}`
      },
      {
        type: 'template',
        altText: '請確認任務資訊',
        template: {
          type: 'buttons',
          text: '請選擇下一步',
          actions: [
            {
              type: 'postback',
              label: '確認建立任務',
              data: `CUSTOMER|CREATE|${encodePayload(payload)}`,
              displayText: '確認建立任務'
            },
            {
              type: 'postback',
              label: '重新填寫',
              data: 'CUSTOMER|RESET',
              displayText: '重新填寫'
            },
            {
              type: 'postback',
              label: '取消',
              data: 'CUSTOMER|CANCEL',
              displayText: '取消'
            }
          ]
        }
      }
    ]);
  } catch (err) {
    console.error('❌ finalizeForm Error:', err);
    userSessions.delete(userId);
    return safeReply(event.replyToken, [{
      type: 'text',
      text: '系統發生錯誤，請稍後再試。'
    }]);
  }
}

// =========================
// 正式建立訂單
// =========================
async function createOrderFromPayload(event, payload) {
  if (!LINE_GROUP_ID) {
    return safeReply(event.replyToken, [{
      type: 'text',
      text: '系統尚未設定派單群組，請先補上 LINE_GROUP_ID。'
    }]);
  }

  const orderId = generateOrderId();
  const now = Date.now();

  const order = {
    id: orderId,
    createdAt: now,
    expiresAt: now + ORDER_EXPIRE_MS,

    customerUserId: payload.customerUserId,
    pickupAddress: payload.pickupAddress,
    pickupPhone: payload.pickupPhone,
    dropoffAddress: payload.dropoffAddress,
    dropoffPhone: payload.dropoffPhone,
    item: payload.item,
    urgent: payload.urgent,
    note: payload.note || '無',

    route: payload.route,
    pricing: payload.pricing,

    status: 'open',
    assignedRiderId: null,
    assignedRiderName: null,

    actionHistory: [],
  };

  orders.set(orderId, order);

  // 先回客人
  await safeReply(event.replyToken, [{
    type: 'text',
    text:
`您的任務已建立成功，我們會立即為您派單。

總計：$${order.pricing.total}`
  }]);

  // 派單到群組
  await safePush(LINE_GROUP_ID, [
    buildGroupOrderFlex(order)
  ]);

  return null;
}

// =========================
// 群組按鈕行為處理
// =========================
async function handleOrderAction(event, rawData) {
  const source = event.source;
  const userId = source.userId;

  if (source.type !== 'group') {
    return safeReply(event.replyToken, [{
      type: 'text',
      text: '此操作只能在派單群組內使用。'
    }]);
  }

  if (!source.groupId || source.groupId !== LINE_GROUP_ID) {
    return safeReply(event.replyToken, [{
      type: 'text',
      text: '這不是指定派單群組，操作無效。'
    }]);
  }

  const parsed = parseOrderActionData(rawData);
  if (!parsed.ok) {
    return safeReply(event.replyToken, [{
      type: 'text',
      text: '按鈕資料驗證失敗，操作無效。'
    }]);
  }

  const { orderId, action } = parsed;
  const order = orders.get(orderId);

  if (!order) {
    return safeReply(event.replyToken, [{
      type: 'text',
      text: '此任務不存在，或已失效。'
    }]);
  }

  if (Date.now() > order.expiresAt) {
    return safeReply(event.replyToken, [{
      type: 'text',
      text: '此任務按鈕已過期，請重新派單。'
    }]);
  }

  const riderName = await getSafeGroupMemberName(source.groupId, userId);

  // 只有白名單騎手可操作
  if (RIDER_USER_IDS.length > 0 && !RIDER_USER_IDS.includes(userId) && !ADMIN_USER_IDS.includes(userId)) {
    return safeReply(event.replyToken, [{
      type: 'text',
      text: `⛔ ${riderName} 無操作權限。`
    }]);
  }

  // 已完成 / 已取消 的單不可再操作
  if (['completed', 'cancelled'].includes(order.status)) {
    return safeReply(event.replyToken, [{
      type: 'text',
      text: '此任務已結束，不能再操作。'
    }]);
  }

  // 狀態機 + 防亂按
  if (action === 'accept') {
    return await handleAcceptOrder(event, order, userId, riderName);
  }

  if (action === 'arrived') {
    return await handleOrderStatusChange(event, order, userId, riderName, {
      from: 'accepted',
      to: 'arrived',
      notifyText: `📍 騎手已抵達取件地點`,
      groupText: `📍 任務 ${order.id} 已由 ${riderName} 回報：已抵達`
    });
  }

  if (action === 'picked') {
    return await handleOrderStatusChange(event, order, userId, riderName, {
      from: 'arrived',
      to: 'picked_up',
      notifyText: `📦 騎手已取件，正在前往送達地點`,
      groupText: `📦 任務 ${order.id} 已由 ${riderName} 回報：已取件`
    });
  }

  if (action === 'delivered') {
    return await handleOrderStatusChange(event, order, userId, riderName, {
      from: 'picked_up',
      to: 'delivered',
      notifyText: `✅ 物品已送達`,
      groupText: `✅ 任務 ${order.id} 已由 ${riderName} 回報：已送達`
    });
  }

  if (action === 'completed') {
    return await handleOrderStatusChange(event, order, userId, riderName, {
      from: 'delivered',
      to: 'completed',
      notifyText:
`✅ 已完成。

感謝您使用 UBee 城市任務服務。
期待再次為您服務。`,
      groupText: `🏁 任務 ${order.id} 已由 ${riderName} 回報：已完成`,
      isFinal: true
    });
  }

  return safeReply(event.replyToken, [{
    type: 'text',
    text: '未知操作，已忽略。'
  }]);
}

// =========================
// 接單
// =========================
async function handleAcceptOrder(event, order, userId, riderName) {
  if (order.status !== 'open') {
    if (order.assignedRiderId && order.assignedRiderId !== userId) {
      return safeReply(event.replyToken, [{
        type: 'text',
        text: `此任務已由 ${order.assignedRiderName || '其他騎手'} 接單，不能重複操作。`
      }]);
    }

    return safeReply(event.replyToken, [{
      type: 'text',
      text: '此任務已不是待接單狀態。'
    }]);
  }

  order.status = 'accepted';
  order.assignedRiderId = userId;
  order.assignedRiderName = riderName;
  order.actionHistory.push({
    action: 'accept',
    by: userId,
    byName: riderName,
    at: Date.now()
  });

  // 回按鈕的人
  await safeReply(event.replyToken, [{
    type: 'text',
    text: `✅ 你已成功接下任務 ${order.id}`
  }]);

  // 通知客人
  await safePush(order.customerUserId, [{
    type: 'text',
    text:
`✅ 您的任務已有人接單

騎手：${riderName}`
  }]);

  // 群組更新卡片
  await safePush(LINE_GROUP_ID, [
    {
      type: 'text',
      text: `✅ 任務 ${order.id} 已由 ${riderName} 接單`
    },
    buildGroupOrderFlex(order)
  ]);

  return null;
}

// =========================
// 狀態變更共用
// =========================
async function handleOrderStatusChange(event, order, userId, riderName, configChange) {
  const isAdmin = ADMIN_USER_IDS.includes(userId);

  // 只能是接單騎手本人 或 admin
  if (!isAdmin && order.assignedRiderId !== userId) {
    return safeReply(event.replyToken, [{
      type: 'text',
      text: `⛔ 此任務目前由 ${order.assignedRiderName || '其他騎手'} 負責，您不能操作。`
    }]);
  }

  if (order.status !== configChange.from) {
    return safeReply(event.replyToken, [{
      type: 'text',
      text: `⛔ 狀態順序錯誤，目前任務狀態為：${formatStatus(order.status)}`
    }]);
  }

  order.status = configChange.to;
  order.actionHistory.push({
    action: configChange.to,
    by: userId,
    byName: riderName,
    at: Date.now()
  });

  await safeReply(event.replyToken, [{
    type: 'text',
    text: `✅ 已更新為：${formatStatus(order.status)}`
  }]);

  await safePush(order.customerUserId, [{
    type: 'text',
    text: configChange.notifyText
  }]);

  if (configChange.isFinal) {
    await safePush(LINE_GROUP_ID, [{
      type: 'text',
      text: configChange.groupText
    }]);
    return null;
  }

  await safePush(LINE_GROUP_ID, [
    {
      type: 'text',
      text: configChange.groupText
    },
    buildGroupOrderFlex(order)
  ]);

  return null;
}

// =========================
// 群組任務 Flex 卡片
// =========================
function buildGroupOrderFlex(order) {
  const sigAccept = signAction(order.id, 'accept');
  const sigArrived = signAction(order.id, 'arrived');
  const sigPicked = signAction(order.id, 'picked');
  const sigDelivered = signAction(order.id, 'delivered');
  const sigCompleted = signAction(order.id, 'completed');

  const statusText = formatStatus(order.status);

  return {
    type: 'flex',
    altText: `UBee 新任務 ${order.id}`,
    contents: {
      type: 'bubble',
      size: 'giga',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '📦 UBee 新任務通知',
            weight: 'bold',
            size: 'lg'
          },
          {
            type: 'text',
            text: `任務編號：${order.id}`,
            size: 'sm',
            color: '#666666'
          },
          {
            type: 'separator',
            margin: 'md'
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            margin: 'md',
            contents: [
              infoRow('任務狀態', statusText),
              infoRow('騎手費用', `$${order.pricing.riderPayout}`),
              infoRow('距離', `${order.route.distanceKm.toFixed(1)} 公里`),
              infoRow('時間', `${order.route.durationMin} 分鐘`),
              infoRow('取件', order.pickupAddress),
              infoRow('送達', order.dropoffAddress),
              infoRow('物品', order.item),
              infoRow('急件', order.urgent),
              infoRow('備註', order.note || '無'),
              infoRow('目前接單者', order.assignedRiderName || '尚未接單')
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          actionButton('接單', `ORDER|${order.id}|accept|${sigAccept}`),
          actionButton('已抵達', `ORDER|${order.id}|arrived|${sigArrived}`),
          actionButton('已取件', `ORDER|${order.id}|picked|${sigPicked}`),
          actionButton('已送達', `ORDER|${order.id}|delivered|${sigDelivered}`),
          actionButton('已完成', `ORDER|${order.id}|completed|${sigCompleted}`)
        ]
      }
    }
  };
}

function infoRow(label, value) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      {
        type: 'text',
        text: label,
        color: '#555555',
        size: 'sm',
        flex: 3,
        wrap: true
      },
      {
        type: 'text',
        text: value,
        color: '#111111',
        size: 'sm',
        flex: 7,
        wrap: true
      }
    ]
  };
}

function actionButton(label, data) {
  return {
    type: 'button',
    style: 'primary',
    height: 'sm',
    action: {
      type: 'postback',
      label,
      data,
      displayText: label
    }
  };
}

// =========================
// Google Maps：距離 / 時間
// =========================
async function getRouteInfo(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    return {
      ok: false,
      message: '尚未設定 GOOGLE_MAPS_API_KEY'
    };
  }

  try {
    const url =
      `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&mode=driving&language=zh-TW&key=${GOOGLE_MAPS_API_KEY}`;

    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== 'OK' || !data.routes || !data.routes.length) {
      return {
        ok: false,
        message: data.error_message || data.status || '查無路線'
      };
    }

    const leg = data.routes[0].legs[0];
    const distanceMeters = leg.distance.value;
    const durationSeconds = leg.duration.value;

    return {
      ok: true,
      distanceKm: round1(distanceMeters / 1000),
      durationMin: Math.max(1, Math.round(durationSeconds / 60)),
      rawDistanceText: leg.distance.text,
      rawDurationText: leg.duration.text,
      startAddress: leg.start_address,
      endAddress: leg.end_address
    };
  } catch (err) {
    console.error('❌ getRouteInfo Error:', err);
    return {
      ok: false,
      message: 'Google Maps 查詢失敗'
    };
  }
}

// =========================
// 計價
// =========================
function calculatePricing({ distanceKm, durationMin, pickupAddress, dropoffAddress, urgent }) {
  const distanceFee = Math.round(distanceKm * PER_KM_FEE);
  const timeFee = Math.round(durationMin * PER_MIN_FEE);
  const crossDistrictFee = isCrossDistrict(pickupAddress, dropoffAddress) ? CROSS_DISTRICT_FEE : 0;
  const urgentFee = urgent === '急件' ? URGENT_FEE : 0;

  const deliveryFee = BASE_FEE + distanceFee + timeFee + crossDistrictFee;
  const serviceFee = SERVICE_FEE;
  const tax = FIXED_TAX;
  const total = deliveryFee + serviceFee + urgentFee + tax;

  const riderPayout = Math.round(deliveryFee * RIDER_SHARE_RATE);

  return {
    baseFee: BASE_FEE,
    distanceFee,
    timeFee,
    crossDistrictFee,
    deliveryFee,
    serviceFee,
    urgentFee,
    tax,
    total,
    riderPayout
  };
}

// =========================
// 簡易跨區判斷
// =========================
function isCrossDistrict(pickupAddress, dropoffAddress) {
  const districtA = extractDistrict(pickupAddress);
  const districtB = extractDistrict(dropoffAddress);
  if (!districtA || !districtB) return false;
  return districtA !== districtB;
}

function extractDistrict(address = '') {
  const match = address.match(/(豐原區|潭子區|神岡區|大雅區|北屯區|西屯區|西區|南屯區|南區|北區|東區|中區|太平區|大里區|霧峰區|烏日區|清水區|沙鹿區|梧棲區|龍井區|大肚區|后里區|石岡區|新社區|東勢區|和平區|大甲區|外埔區|大安區)/);
  return match ? match[1] : null;
}

// =========================
// 安全驗證：按鈕簽章
// =========================
function signAction(orderId, action) {
  return crypto
    .createHmac('sha256', ACTION_SECRET)
    .update(`${orderId}|${action}`)
    .digest('hex')
    .slice(0, 16);
}

function parseOrderActionData(data) {
  try {
    const parts = data.split('|');
    if (parts.length !== 4) {
      return { ok: false };
    }

    const [, orderId, action, sig] = parts;
    const expected = signAction(orderId, action);
    if (sig !== expected) {
      return { ok: false };
    }

    return {
      ok: true,
      orderId,
      action
    };
  } catch (err) {
    return { ok: false };
  }
}

// =========================
// 客戶建立任務 payload 編解碼
// =========================
function encodePayload(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function decodePayload(base64) {
  try {
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch (err) {
    return null;
  }
}

// =========================
// 狀態文字
// =========================
function formatStatus(status) {
  switch (status) {
    case 'open':
      return '待接單';
    case 'accepted':
      return '已接單';
    case 'arrived':
      return '已抵達';
    case 'picked_up':
      return '已取件';
    case 'delivered':
      return '已送達';
    case 'completed':
      return '已完成';
    case 'cancelled':
      return '已取消';
    default:
      return status;
  }
}

// =========================
// 產生訂單編號
// =========================
function generateOrderId() {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `UB${y}${m}${d}-${rand}`;
}

// =========================
// 取得群組成員名稱
// =========================
async function getSafeGroupMemberName(groupId, userId) {
  try {
    const profile = await client.getGroupMemberProfile(groupId, userId);
    return profile.displayName || '騎手';
  } catch (err) {
    return '騎手';
  }
}

// =========================
// LINE 安全回覆
// =========================
async function safeReply(replyToken, messages) {
  try {
    if (!replyToken || !messages || !messages.length) return null;
    return await client.replyMessage(replyToken, messages);
  } catch (err) {
    console.error('❌ Reply Error:', err && err.originalError ? err.originalError.response?.data : err);
    return null;
  }
}

async function safePush(to, messages) {
  try {
    if (!to || !messages || !messages.length) return null;
    return await client.pushMessage(to, messages);
  } catch (err) {
    const detail = err && err.originalError ? err.originalError.response?.data : err;
    console.error('❌ Push Error:', detail);

    // 常見 429 提示
    if (detail && detail.message && String(detail.message).includes('429')) {
      console.error('⚠️ LINE 暫時限制發送（429）');
    }
    return null;
  }
}

// =========================
// 小工具
// =========================
function round1(n) {
  return Math.round(n * 10) / 10;
}

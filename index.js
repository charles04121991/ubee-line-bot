require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('❌ 缺少 CHANNEL_ACCESS_TOKEN 或 CHANNEL_SECRET');
  process.exit(1);
}

const client = new line.Client(config);
app.use(line.middleware(config));

const LINE_GROUP_ID = process.env.LINE_GROUP_ID;

if (!LINE_GROUP_ID) {
  console.error('❌ 缺少 LINE_GROUP_ID');
  process.exit(1);
}

// ===== 表單 =====
const BUSINESS_FORM =
  'https://docs.google.com/forms/d/e/1FAIpQLScn9AGnp4FbTGg6fZt5fpiMdNEi-yL9x595bTyVFHAoJmpYlA/viewform';
const PARTNER_FORM =
  'https://docs.google.com/forms/d/e/1FAIpQLSc2qdklWuSSPw39vjfrXEakBHTI3TM_NgqMxWLAZg0ej6zvMA/viewform';

// ===== 訂單 / 會話 =====
const orders = {};
const sessions = {};

// ===== 工具 =====
const createOrderId = () => 'OD' + Date.now();

function safeReply(replyToken, message) {
  return client.replyMessage(replyToken, message).catch(err => {
    console.error('replyMessage error:', err?.originalError || err);
  });
}

function safePush(to, message) {
  return client.pushMessage(to, message).catch(err => {
    console.error('pushMessage error:', err?.originalError || err);
  });
}

function getOrder(orderId) {
  return orders[orderId] || null;
}

function getSession(userId) {
  return sessions[userId] || null;
}

function clearSession(userId) {
  delete sessions[userId];
}

function isDriverAuthorized(order, userId) {
  return !!(order && order.driverId && order.driverId === userId);
}

function textMessage(text) {
  return { type: 'text', text };
}

function createQuickReplyText(text, items) {
  return {
    type: 'text',
    text,
    quickReply: {
      items: items.map(item => ({
        type: 'action',
        action: item
      }))
    }
  };
}

function normalizePhone(input) {
  return (input || '').trim();
}

function isValidTaiwanPhone(phone) {
  return /^0\d{8,9}$/.test(phone);
}

function getStatusText(status) {
  switch (status) {
    case 'pending':
      return '待接單';
    case 'accepted':
      return '已接單';
    case 'arrived_pickup':
      return '已抵達取件地點';
    case 'picked_up':
      return '已取件';
    case 'arrived_dropoff':
      return '已抵達送達地點';
    case 'completed':
      return '已完成';
    case 'cancelled':
      return '已取消';
    default:
      return '未知狀態';
  }
}

function requireOrder(replyToken, orderId) {
  const order = getOrder(orderId);
  if (!order) {
    safeReply(replyToken, textMessage('❌ 訂單不存在或已失效'));
    return null;
  }
  return order;
}

function requireDriver(replyToken, order, userId) {
  if (!isDriverAuthorized(order, userId)) {
    safeReply(replyToken, textMessage('⚠️ 只有接單騎手可以操作此按鈕'));
    return false;
  }
  return true;
}

function requireStatus(replyToken, order, allowedStatuses, actionName) {
  if (!allowedStatuses.includes(order.status)) {
    safeReply(
      replyToken,
      textMessage(`⚠️ 目前訂單狀態為「${getStatusText(order.status)}」，不能執行${actionName}`)
    );
    return false;
  }
  return true;
}

function buildGoogleMapSearchUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

// ===== 計價 =====
function calculateFees(session) {
  const deliveryFee = 150;
  const serviceFee = 50;
  const urgentFee = session.isUrgent === '急件' ? 100 : 0;
  const totalFee = deliveryFee + serviceFee + urgentFee;

  // 騎手可見 / 可賺費用
  const driverFee = Math.round(totalFee * 0.6);

  return {
    deliveryFee,
    serviceFee,
    urgentFee,
    totalFee,
    driverFee
  };
}

function buildOrderSummary(session) {
  return (
    '請確認以下任務資訊：\n\n' +
    `取件地點：${session.pickup}\n` +
    `取件電話：${session.pickupPhone}\n` +
    `送達地點：${session.dropoff}\n` +
    `送達電話：${session.dropoffPhone}\n` +
    `物品內容：${session.item}\n` +
    `是否急件：${session.isUrgent}\n` +
    `備註：${session.note}\n\n` +
    `配送費：$${session.deliveryFee}\n` +
    `服務費：$${session.serviceFee}\n` +
    `急件費：$${session.urgentFee}\n\n` +
    `總計：$${session.totalFee}`
  );
}

function createConfirmCard(mode = 'create') {
  const confirmData = mode === 'quote' ? 'action=confirmQuoteCreate' : 'action=confirmCreate';
  const restartData = mode === 'quote' ? 'action=restartQuote' : 'action=restartCreate';
  const cancelData = mode === 'quote' ? 'action=cancelQuote' : 'action=cancelCreate';

  return {
    type: 'template',
    altText: '確認任務資料',
    template: {
      type: 'buttons',
      text: '請確認資料是否正確',
      actions: [
        {
          type: 'postback',
          label: mode === 'quote' ? '確認並建立任務' : '確認送出',
          data: confirmData
        },
        {
          type: 'postback',
          label: '重新填寫',
          data: restartData
        },
        {
          type: 'postback',
          label: '取消',
          data: cancelData
        }
      ]
    }
  };
}

function createEmptySession(userId, type) {
  return {
    type,
    step: 'pickup',
    userId,
    pickup: '',
    pickupPhone: '',
    dropoff: '',
    dropoffPhone: '',
    item: '',
    isUrgent: '',
    note: '',
    deliveryFee: 0,
    serviceFee: 0,
    urgentFee: 0,
    totalFee: 0,
    driverFee: 0
  };
}

// ===== 建立正式訂單 =====
async function createOrderFromSession(event, session) {
  const orderId = createOrderId();

  orders[orderId] = {
    orderId,
    userId: session.userId,
    pickup: session.pickup,
    pickupPhone: session.pickupPhone,
    dropoff: session.dropoff,
    dropoffPhone: session.dropoffPhone,
    item: session.item,
    isUrgent: session.isUrgent,
    note: session.note,
    deliveryFee: session.deliveryFee,
    serviceFee: session.serviceFee,
    urgentFee: session.urgentFee,
    totalFee: session.totalFee,
    driverFee: session.driverFee,
    status: 'pending',
    driverId: null,
    etaMinutes: null,
    createdAt: new Date().toISOString(),
    acceptedAt: null,
    arrivedPickupAt: null,
    pickedUpAt: null,
    arrivedDropoffAt: null,
    completedAt: null,
    abandonedBy: []
  };

  clearSession(session.userId);

  await safePush(LINE_GROUP_ID, createGroupText(orderId));
  await safePush(LINE_GROUP_ID, createGroupCard(orderId));

  return safeReply(event.replyToken, textMessage('✅ 任務已建立成功，系統正在尋找騎手'));
}

// ===== Webhook =====
app.post('/webhook', async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error('webhook error:', err);
    res.sendStatus(500);
  }
});

// ===== 主邏輯 =====
async function handleEvent(event) {
  try {
    if (event.type === 'postback') {
      return handlePostback(event);
    }

    if (event.type !== 'message' || event.message.type !== 'text') {
      return;
    }

    const text = (event.message.text || '').trim();
    const userId = event.source.userId;

    if (text === '主選單') return replyMain(event.replyToken);
    if (text === '下單') return replyOrder(event.replyToken);
    if (text === '企業') return replyEnterprise(event.replyToken);
    if (text === '我的') return replyMe(event.replyToken);

    if (text === '企業服務說明') {
      return safeReply(
        event.replyToken,
        textMessage(
          'UBee 企業服務說明\n\n' +
            '適用對象：公司、工廠、中小企業、事務所與門市單位。\n' +
            '服務內容：文件急送、商務跑腿、樣品收送、臨時行政支援。\n' +
            '服務方式：建立任務後，由系統派送至群組，媒合合適騎手執行。'
        )
      );
    }

    if (text === '服務說明') {
      return safeReply(
        event.replyToken,
        textMessage(
          'UBee 服務說明\n\n' +
            'UBee 提供城市任務服務，包含文件急送、商務跑腿與即時在地支援。\n' +
            '建立任務後，系統會媒合騎手執行，並在任務過程中同步通知進度。'
        )
      );
    }

    const session = getSession(userId);
    if (session && (session.type === 'create_order' || session.type === 'quote_order')) {
      return handleOrderInput(event, session, text);
    }
  } catch (err) {
    console.error('handleEvent error:', err);
  }
}

// ===== 建立任務 / 立即估價 共用引導 =====
async function handleOrderInput(event, session, text) {
  const userId = event.source.userId;

  if (session.step === 'pickup') {
    session.pickup = text;
    session.step = 'pickupPhone';
    return safeReply(event.replyToken, textMessage('請輸入取件電話：'));
  }

  if (session.step === 'pickupPhone') {
    const phone = normalizePhone(text);
    if (!isValidTaiwanPhone(phone)) {
      return safeReply(event.replyToken, textMessage('⚠️ 取件電話格式不正確，請重新輸入正確電話：'));
    }

    session.pickupPhone = phone;
    session.step = 'dropoff';
    return safeReply(event.replyToken, textMessage('請輸入送達地點：'));
  }

  if (session.step === 'dropoff') {
    session.dropoff = text;
    session.step = 'dropoffPhone';
    return safeReply(event.replyToken, textMessage('請輸入送達電話：'));
  }

  if (session.step === 'dropoffPhone') {
    const phone = normalizePhone(text);
    if (!isValidTaiwanPhone(phone)) {
      return safeReply(event.replyToken, textMessage('⚠️ 送達電話格式不正確，請重新輸入正確電話：'));
    }

    session.dropoffPhone = phone;
    session.step = 'item';
    return safeReply(event.replyToken, textMessage('請輸入物品內容：'));
  }

  if (session.step === 'item') {
    session.item = text;
    session.step = 'urgent';
    return safeReply(
      event.replyToken,
      createQuickReplyText('是否為急件？', [
        { type: 'message', label: '一般', text: '一般' },
        { type: 'message', label: '急件', text: '急件' }
      ])
    );
  }

  if (session.step === 'urgent') {
    if (text !== '一般' && text !== '急件') {
      return safeReply(
        event.replyToken,
        createQuickReplyText('請選擇是否為急件：', [
          { type: 'message', label: '一般', text: '一般' },
          { type: 'message', label: '急件', text: '急件' }
        ])
      );
    }

    session.isUrgent = text;
    session.step = 'note';
    return safeReply(event.replyToken, textMessage('請輸入備註，若無請輸入「無」：'));
  }

  if (session.step === 'note') {
    session.note = text || '無';

    const fees = calculateFees(session);
    session.deliveryFee = fees.deliveryFee;
    session.serviceFee = fees.serviceFee;
    session.urgentFee = fees.urgentFee;
    session.totalFee = fees.totalFee;
    session.driverFee = fees.driverFee;
    session.step = 'confirm';

    const isQuote = session.type === 'quote_order';

    return safeReply(event.replyToken, [
      textMessage(buildOrderSummary(session)),
      createConfirmCard(isQuote ? 'quote' : 'create')
    ]);
  }

  if (session.step === 'confirm') {
    return safeReply(event.replyToken, textMessage('請直接使用下方按鈕進行確認、重新填寫或取消。'));
  }

  clearSession(userId);
  return safeReply(event.replyToken, textMessage('⚠️ 流程已重置，請重新開始。'));
}

// ===== 主選單 =====
function replyMain(token) {
  return safeReply(token, {
    type: 'template',
    altText: '主選單',
    template: {
      type: 'buttons',
      text: 'UBee 主選單',
      actions: [
        { type: 'message', label: '下單', text: '下單' },
        { type: 'message', label: '企業', text: '企業' },
        { type: 'message', label: '我的', text: '我的' }
      ]
    }
  });
}

// ===== 下單 =====
function replyOrder(token) {
  return safeReply(token, {
    type: 'template',
    altText: '下單',
    template: {
      type: 'buttons',
      text: '請選擇',
      actions: [
        {
          type: 'postback',
          label: '建立任務',
          data: 'action=create'
        },
        {
          type: 'postback',
          label: '立即估價',
          data: 'action=quote'
        }
      ]
    }
  });
}

// ===== 企業 =====
function replyEnterprise(token) {
  return safeReply(token, [
    {
      type: 'text',
      text:
        'UBee 企業合作服務\n\n' +
        '我們提供企業專屬城市任務支援：\n' +
        '・文件急送\n' +
        '・商務跑腿\n' +
        '・樣品收送\n' +
        '・臨時行政支援\n\n' +
        '如需合作，請填寫下方申請表，我們將與您聯繫。'
    },
    {
      type: 'template',
      altText: '企業合作',
      template: {
        type: 'buttons',
        text: '企業合作申請',
        actions: [
          {
            type: 'uri',
            label: '填寫企業合作申請',
            uri: BUSINESS_FORM
          },
          {
            type: 'message',
            label: '服務說明',
            text: '企業服務說明'
          }
        ]
      }
    }
  ]);
}

// ===== 我的 =====
function replyMe(token) {
  return safeReply(token, [
    {
      type: 'text',
      text:
        '歡迎使用 UBee。\n\n' +
        '您可以查看服務說明，或申請加入夥伴，一起參與城市任務服務。'
    },
    {
      type: 'template',
      altText: '我的選單',
      template: {
        type: 'buttons',
        text: '我的選單',
        actions: [
          {
            type: 'message',
            label: '服務說明',
            text: '服務說明'
          },
          {
            type: 'uri',
            label: '加入夥伴',
            uri: PARTNER_FORM
          }
        ]
      }
    }
  ]);
}

// ===== Postback =====
async function handlePostback(event) {
  const data = event.postback.data || '';
  const userId = event.source.userId;

  // 建立任務
  if (data === 'action=create') {
    sessions[userId] = createEmptySession(userId, 'create_order');
    return safeReply(event.replyToken, textMessage('請輸入取件地點：'));
  }

  // 立即估價
  if (data === 'action=quote') {
    sessions[userId] = createEmptySession(userId, 'quote_order');
    return safeReply(event.replyToken, textMessage('請輸入取件地點：'));
  }

  // 建立任務確認
  if (data === 'action=confirmCreate') {
    const session = getSession(userId);
    if (!session || session.type !== 'create_order' || session.step !== 'confirm') {
      return safeReply(event.replyToken, textMessage('⚠️ 目前沒有可送出的任務資料，請重新建立任務。'));
    }
    return createOrderFromSession(event, session);
  }

  // 立即估價確認並建立任務
  if (data === 'action=confirmQuoteCreate') {
    const session = getSession(userId);
    if (!session || session.type !== 'quote_order' || session.step !== 'confirm') {
      return safeReply(event.replyToken, textMessage('⚠️ 目前沒有可送出的估價資料，請重新操作。'));
    }
    return createOrderFromSession(event, session);
  }

  // 重新填寫
  if (data === 'action=restartCreate') {
    sessions[userId] = createEmptySession(userId, 'create_order');
    return safeReply(event.replyToken, textMessage('請重新輸入取件地點：'));
  }

  if (data === 'action=restartQuote') {
    sessions[userId] = createEmptySession(userId, 'quote_order');
    return safeReply(event.replyToken, textMessage('請重新輸入取件地點：'));
  }

  // 取消
  if (data === 'action=cancelCreate') {
    clearSession(userId);
    return safeReply(event.replyToken, textMessage('✅ 已取消本次建立任務'));
  }

  if (data === 'action=cancelQuote') {
    clearSession(userId);
    return safeReply(event.replyToken, textMessage('✅ 已取消本次立即估價'));
  }

  // 接單
  if (data.startsWith('accept=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;

    if (!requireStatus(event.replyToken, order, ['pending'], '接單')) return;

    if (order.abandonedBy.includes(userId)) {
      return safeReply(event.replyToken, textMessage('⚠️ 您已放棄此任務，無法再次接單'));
    }

    if (order.driverId) {
      return safeReply(event.replyToken, textMessage('⚠️ 此任務已被其他騎手接單'));
    }

    order.driverId = userId;
    order.status = 'accepted';
    order.acceptedAt = new Date().toISOString();

    return safeReply(event.replyToken, createETA(orderId));
  }

  // 放棄任務
  if (data.startsWith('reject=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;

    if (!requireStatus(event.replyToken, order, ['pending'], '放棄任務')) return;

    if (!order.abandonedBy.includes(userId)) {
      order.abandonedBy.push(userId);
    }

    return safeReply(event.replyToken, textMessage('✅ 您已放棄此任務'));
  }

  // ETA 頁面
  if (data.startsWith('etaPage2=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '查看 ETA')) return;

    return safeReply(event.replyToken, createETA2(orderId));
  }

  if (data.startsWith('etaPage3=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '查看 ETA')) return;

    return safeReply(event.replyToken, createETA3(orderId));
  }

  if (data.startsWith('etaPage4=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '查看 ETA')) return;

    return safeReply(event.replyToken, createETA4(orderId));
  }

  // ETA 選擇
  if (data.startsWith('eta=')) {
    const [, orderId, min] = data.split('=');
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '設定 ETA')) return;

    order.etaMinutes = min;

    await safePush(order.userId, textMessage(`✅ 已有騎手接單，預計 ${min} 分鐘抵達取件地點`));
    await safePush(LINE_GROUP_ID, textMessage(`✅ 任務已接單，預計 ${min} 分鐘抵達取件地點`));
    await safePush(LINE_GROUP_ID, createPickupActionCard(orderId));

    return safeReply(event.replyToken, textMessage(`✅ 已設定 ETA，預計 ${min} 分鐘抵達取件地點`));
  }

  // 已抵達取件地點
  if (data.startsWith('arrivePickup=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '已抵達')) return;

    order.status = 'arrived_pickup';
    order.arrivedPickupAt = new Date().toISOString();

    await safePush(order.userId, textMessage('📍 騎手已抵達取件地點'));

    return safeReply(event.replyToken, createPickedActionCard(orderId));
  }

  // 已取件
  if (data.startsWith('picked=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['arrived_pickup'], '已取件')) return;

    order.status = 'picked_up';
    order.pickedUpAt = new Date().toISOString();

    await safePush(order.userId, textMessage('✅ 騎手已完成取件，正在前往送達地點'));

    return safeReply(event.replyToken, createDropoffActionCard(orderId));
  }

  // 已抵達送達地點
  if (data.startsWith('arriveDropoff=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['picked_up'], '抵達送達地點')) return;

    order.status = 'arrived_dropoff';
    order.arrivedDropoffAt = new Date().toISOString();

    return safeReply(event.replyToken, createDropoffArrivedCard(orderId));
  }

  // 撥打收件人
  if (data.startsWith('call=')) {
    const [, orderId, phone] = data.split('=');
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['arrived_dropoff'], '撥打電話')) return;

    return safeReply(event.replyToken, {
      type: 'template',
      altText: '撥打電話',
      template: {
        type: 'buttons',
        text: '請聯絡收件人',
        actions: [
          {
            type: 'uri',
            label: '📞 撥打',
            uri: `tel:${phone}`
          }
        ]
      }
    });
  }

  // 已完成
  if (data.startsWith('complete=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['arrived_dropoff'], '完成任務')) return;

    order.status = 'completed';
    order.completedAt = new Date().toISOString();

    await safePush(order.userId, textMessage('✅ 任務已完成，感謝您使用 UBee'));

    return safeReply(event.replyToken, textMessage('✅ 任務已完成'));
  }
}

// ===== 群組通知 =====
function createGroupText(orderId) {
  const order = orders[orderId];

  return {
    type: 'text',
    text:
      `📦 UBee 新任務通知\n\n` +
      `費用：$${order.driverFee}\n` +
      `取件地點：${order.pickup}\n` +
      `送達地點：${order.dropoff}\n` +
      `物品：${order.item}\n` +
      `急件：${order.isUrgent}\n` +
      `備註：${order.note}`
  };
}

function createGroupCard(orderId) {
  return {
    type: 'template',
    altText: '任務操作',
    template: {
      type: 'buttons',
      text: '請選擇操作',
      actions: [
        {
          type: 'postback',
          label: '接單',
          data: `accept=${orderId}`
        },
        {
          type: 'postback',
          label: '放棄任務',
          data: `reject=${orderId}`
        }
      ]
    }
  };
}

// ===== ETA =====
function createETA(orderId) {
  return {
    type: 'template',
    altText: 'ETA',
    template: {
      type: 'buttons',
      text: '選擇 ETA（1/4）',
      actions: [
        { type: 'postback', label: '5 分鐘', data: `eta=${orderId}=5` },
        { type: 'postback', label: '7 分鐘', data: `eta=${orderId}=7` },
        { type: 'postback', label: '8 分鐘', data: `eta=${orderId}=8` },
        { type: 'postback', label: '➡️ 下一頁', data: `etaPage2=${orderId}` }
      ]
    }
  };
}

function createETA2(orderId) {
  return {
    type: 'template',
    altText: 'ETA',
    template: {
      type: 'buttons',
      text: '選擇 ETA（2/4）',
      actions: [
        { type: 'postback', label: '10 分鐘', data: `eta=${orderId}=10` },
        { type: 'postback', label: '12 分鐘', data: `eta=${orderId}=12` },
        { type: 'postback', label: '15 分鐘', data: `eta=${orderId}=15` },
        { type: 'postback', label: '➡️ 下一頁', data: `etaPage3=${orderId}` }
      ]
    }
  };
}

function createETA3(orderId) {
  return {
    type: 'template',
    altText: 'ETA',
    template: {
      type: 'buttons',
      text: '選擇 ETA（3/4）',
      actions: [
        { type: 'postback', label: '17 分鐘', data: `eta=${orderId}=17` },
        { type: 'postback', label: '18 分鐘', data: `eta=${orderId}=18` },
        { type: 'postback', label: '20 分鐘', data: `eta=${orderId}=20` },
        { type: 'postback', label: '➡️ 下一頁', data: `etaPage4=${orderId}` }
      ]
    }
  };
}

function createETA4(orderId) {
  return {
    type: 'template',
    altText: 'ETA',
    template: {
      type: 'buttons',
      text: '選擇 ETA（4/4）',
      actions: [
        { type: 'postback', label: '22 分鐘', data: `eta=${orderId}=22` },
        { type: 'postback', label: '25 分鐘', data: `eta=${orderId}=25` },
        { type: 'postback', label: '⬅️ 上一頁', data: `etaPage3=${orderId}` }
      ]
    }
  };
}

// ===== 後續操作 =====
function createPickupActionCard(orderId) {
  const order = orders[orderId];

  return {
    type: 'template',
    altText: '取件操作',
    template: {
      type: 'buttons',
      text: '請前往取件地點',
      actions: [
        {
          type: 'uri',
          label: '導航取件地點',
          uri: buildGoogleMapSearchUrl(order.pickup)
        },
        {
          type: 'postback',
          label: '已抵達取件地點',
          data: `arrivePickup=${orderId}`
        }
      ]
    }
  };
}

function createPickedActionCard(orderId) {
  return {
    type: 'template',
    altText: '已取件操作',
    template: {
      type: 'buttons',
      text: '請選擇下一步',
      actions: [
        {
          type: 'postback',
          label: '已取件',
          data: `picked=${orderId}`
        }
      ]
    }
  };
}

function createDropoffActionCard(orderId) {
  const order = orders[orderId];

  return {
    type: 'template',
    altText: '送達操作',
    template: {
      type: 'buttons',
      text: '請前往送達地點',
      actions: [
        {
          type: 'uri',
          label: '導航送達地點',
          uri: buildGoogleMapSearchUrl(order.dropoff)
        },
        {
          type: 'postback',
          label: '已抵達送達地點',
          data: `arriveDropoff=${orderId}`
        }
      ]
    }
  };
}

function createDropoffArrivedCard(orderId) {
  const order = orders[orderId];

  return {
    type: 'template',
    altText: '送達地點操作',
    template: {
      type: 'buttons',
      text: '請先聯絡收件人，再完成任務',
      actions: [
        {
          type: 'postback',
          label: '撥打收件人',
          data: `call=${orderId}=${order.dropoffPhone}`
        },
        {
          type: 'postback',
          label: '已完成',
          data: `complete=${orderId}`
        }
      ]
    }
  };
}

// ===== 啟動 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('UBee OMS V3.7.5 Running');
});
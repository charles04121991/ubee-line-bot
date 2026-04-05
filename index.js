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

function parseDistrict(address) {
  if (!address) return '';
  const match = address.match(/([\u4e00-\u9fa5]{1,6}[區鄉鎮市])/);
  return match ? match[1] : '';
}

// ===== 計價 =====
function calculateFees(session) {
  const pickupDistrict = parseDistrict(session.pickup);
  const dropoffDistrict = parseDistrict(session.dropoff);

  const isCrossDistrict =
    pickupDistrict && dropoffDistrict && pickupDistrict !== dropoffDistrict;

  const baseDeliveryFee = 150;
  const crossDistrictFee = isCrossDistrict ? 80 : 0;
  const deliveryFee = baseDeliveryFee + crossDistrictFee;

  const serviceFee = 50;
  const urgentFee = session.isUrgent === '急件' ? 100 : 0;
  const totalFee = deliveryFee + serviceFee + urgentFee;
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

// ===== Flex 共用樣式 =====
function createActionButton(label, data, style = 'primary', color) {
  const btn = {
    type: 'button',
    style,
    action: {
      type: 'postback',
      label,
      data
    }
  };
  if (color) btn.color = color;
  return btn;
}

function createUriButton(label, uri, style = 'primary', color) {
  const btn = {
    type: 'button',
    style,
    action: {
      type: 'uri',
      label,
      uri
    }
  };
  if (color) btn.color = color;
  return btn;
}

function createMessageButton(label, text, style = 'secondary', color) {
  const btn = {
    type: 'button',
    style,
    action: {
      type: 'message',
      label,
      text
    }
  };
  if (color) btn.color = color;
  return btn;
}

function createInfoRow(label, value) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'md',
    contents: [
      {
        type: 'text',
        text: `${label}：`,
        size: 'sm',
        color: '#666666',
        flex: 3
      },
      {
        type: 'text',
        text: value || '無',
        size: 'sm',
        wrap: true,
        flex: 7
      }
    ]
  };
}

function createPriceRow(label, value) {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      {
        type: 'text',
        text: label,
        size: 'sm',
        color: '#666666',
        flex: 5
      },
      {
        type: 'text',
        text: value,
        size: 'sm',
        align: 'end',
        flex: 5
      }
    ]
  };
}

function createSimpleFlex(title, subtitle, buttons = [], accentColor = '#111111') {
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: accentColor,
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: title,
            color: '#FFFFFF',
            weight: 'bold',
            size: 'lg'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: subtitle,
            wrap: true,
            size: 'sm',
            color: '#333333'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: buttons
      }
    }
  };
}

// ===== Flex 畫面 =====
function createMainMenuFlex() {
  return {
    type: 'flex',
    altText: 'UBee 主選單',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: 'UBee 主選單',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl'
          },
          {
            type: 'text',
            text: '城市任務服務入口',
            color: '#D8D8D8',
            size: 'sm',
            margin: 'sm'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '請選擇您要使用的功能',
            wrap: true,
            size: 'sm',
            color: '#333333'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createMessageButton('下單', '下單', 'primary', '#111111'),
          createMessageButton('企業', '企業', 'secondary'),
          createMessageButton('我的', '我的', 'secondary')
        ]
      }
    }
  };
}

function createOrderMenuFlex() {
  return createSimpleFlex(
    '下單',
    '請選擇您要進行的操作',
    [
      createActionButton('建立任務', 'action=create', 'primary', '#111111'),
      createActionButton('立即估價', 'action=quote', 'secondary')
    ],
    '#111111'
  );
}

function createEnterpriseFlex() {
  return {
    type: 'flex',
    altText: '企業合作',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: 'UBee 企業合作',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text:
              '我們提供企業專屬城市任務支援：\n' +
              '・文件急送\n' +
              '・商務跑腿\n' +
              '・樣品收送\n' +
              '・臨時行政支援\n\n' +
              '如需合作，請填寫下方申請表。',
            wrap: true,
            size: 'sm',
            color: '#333333'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createUriButton('填寫企業合作申請', BUSINESS_FORM, 'primary', '#111111'),
          createMessageButton('服務說明', '企業服務說明', 'secondary')
        ]
      }
    }
  };
}

function createMeFlex() {
  return {
    type: 'flex',
    altText: '我的選單',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: '我的選單',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: '您可以查看服務說明，或申請加入夥伴，一起參與城市任務服務。',
            wrap: true,
            size: 'sm',
            color: '#333333'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createMessageButton('服務說明', '服務說明', 'secondary'),
          createUriButton('加入夥伴', PARTNER_FORM, 'primary', '#111111')
        ]
      }
    }
  };
}

function createConfirmCardFlex(session, mode = 'create') {
  const confirmData = mode === 'quote' ? 'action=confirmQuoteCreate' : 'action=confirmCreate';
  const restartData = mode === 'quote' ? 'action=restartQuote' : 'action=restartCreate';
  const cancelData = mode === 'quote' ? 'action=cancelQuote' : 'action=cancelCreate';

  return {
    type: 'flex',
    altText: '請確認任務資訊',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: '請確認以下任務資訊',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'lg'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              createInfoRow('取件地點', session.pickup),
              createInfoRow('取件電話', session.pickupPhone),
              createInfoRow('送達地點', session.dropoff),
              createInfoRow('送達電話', session.dropoffPhone),
              createInfoRow('物品內容', session.item),
              createInfoRow('是否急件', session.isUrgent),
              createInfoRow('備註', session.note)
            ]
          },
          {
            type: 'separator',
            margin: 'lg'
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            margin: 'lg',
            contents: [
              createPriceRow('配送費', `$${session.deliveryFee}`),
              createPriceRow('服務費', `$${session.serviceFee}`),
              createPriceRow('急件費', `$${session.urgentFee}`)
            ]
          },
          {
            type: 'separator',
            margin: 'lg'
          },
          {
            type: 'box',
            layout: 'horizontal',
            margin: 'lg',
            contents: [
              {
                type: 'text',
                text: '總計',
                weight: 'bold',
                size: 'lg'
              },
              {
                type: 'text',
                text: `$${session.totalFee}`,
                weight: 'bold',
                size: 'xl',
                align: 'end'
              }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createActionButton(
            mode === 'quote' ? '確認並建立任務' : '確認送出',
            confirmData,
            'primary',
            '#111111'
          ),
          createActionButton('重新填寫', restartData, 'secondary'),
          createActionButton('取消', cancelData, 'secondary')
        ]
      }
    }
  };
}

function createGroupTaskFlex(orderId) {
  const order = orders[orderId];

  return {
    type: 'flex',
    altText: 'UBee 新任務通知',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: '📦 UBee 新任務通知',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'lg'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createInfoRow('費用', `$${order.driverFee}`),
          createInfoRow('取件地點', order.pickup),
          createInfoRow('送達地點', order.dropoff),
          createInfoRow('物品', order.item),
          createInfoRow('急件', order.isUrgent),
          createInfoRow('備註', order.note)
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createActionButton('接單', `accept=${orderId}`, 'primary', '#111111'),
          createActionButton('放棄任務', `reject=${orderId}`, 'secondary')
        ]
      }
    }
  };
}

function createETAFlex(orderId, page) {
  const pageMap = {
    1: [
      createActionButton('5 分鐘', `eta=${orderId}=5`, 'secondary'),
      createActionButton('7 分鐘', `eta=${orderId}=7`, 'secondary'),
      createActionButton('8 分鐘', `eta=${orderId}=8`, 'secondary'),
      createActionButton('下一頁', `etaPage2=${orderId}`, 'primary', '#111111')
    ],
    2: [
      createActionButton('10 分鐘', `eta=${orderId}=10`, 'secondary'),
      createActionButton('12 分鐘', `eta=${orderId}=12`, 'secondary'),
      createActionButton('15 分鐘', `eta=${orderId}=15`, 'secondary'),
      createActionButton('下一頁', `etaPage3=${orderId}`, 'primary', '#111111')
    ],
    3: [
      createActionButton('17 分鐘', `eta=${orderId}=17`, 'secondary'),
      createActionButton('18 分鐘', `eta=${orderId}=18`, 'secondary'),
      createActionButton('20 分鐘', `eta=${orderId}=20`, 'secondary'),
      createActionButton('下一頁', `etaPage4=${orderId}`, 'primary', '#111111')
    ],
    4: [
      createActionButton('22 分鐘', `eta=${orderId}=22`, 'secondary'),
      createActionButton('25 分鐘', `eta=${orderId}=25`, 'secondary'),
      createActionButton('上一頁', `etaPage3=${orderId}`, 'primary', '#111111')
    ]
  };

  return createSimpleFlex(
    `選擇 ETA（${page}/4）`,
    '請選擇預計抵達取件地點時間',
    pageMap[page],
    '#111111'
  );
}

function createUrgentChoiceFlex() {
  return {
    type: 'flex',
    altText: '是否為急件',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111111',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: '是否為急件？',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '請選擇本次任務是否為急件',
            wrap: true,
            size: 'sm',
            color: '#333333'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          createMessageButton('一般', '一般', 'secondary'),
          createMessageButton('急件', '急件', 'primary', '#111111')
        ]
      }
    }
  };
}

function createPickupActionFlex(orderId) {
  const order = orders[orderId];
  return createSimpleFlex(
    '取件操作',
    `請前往取件地點\n\n取件：${order.pickup}`,
    [
      createUriButton('導航取件地點', buildGoogleMapSearchUrl(order.pickup), 'primary', '#111111'),
      createActionButton('已抵達取件地點', `arrivePickup=${orderId}`, 'secondary')
    ],
    '#111111'
  );
}

function createPickedActionFlex(orderId) {
  return createSimpleFlex(
    '已取件操作',
    '請確認完成取件後，再進入下一步',
    [
      createActionButton('已取件', `picked=${orderId}`, 'primary', '#111111')
    ],
    '#111111'
  );
}

function createDropoffActionFlex(orderId) {
  const order = orders[orderId];
  return createSimpleFlex(
    '送達操作',
    `請前往送達地點\n\n送達：${order.dropoff}`,
    [
      createUriButton('導航送達地點', buildGoogleMapSearchUrl(order.dropoff), 'primary', '#111111'),
      createActionButton('已抵達送達地點', `arriveDropoff=${orderId}`, 'secondary')
    ],
    '#111111'
  );
}

function createDropoffArrivedFlex(orderId) {
  const order = orders[orderId];
  return createSimpleFlex(
    '送達地點操作',
    `請先聯絡收件人，再完成任務\n\n送達電話：${order.dropoffPhone}`,
    [
      createActionButton('撥打收件人', `call=${orderId}=${order.dropoffPhone}`, 'secondary'),
      createActionButton('已完成', `complete=${orderId}`, 'primary', '#111111')
    ],
    '#111111'
  );
}

function createCallFlex(phone) {
  return createSimpleFlex(
    '聯絡收件人',
    `請點擊下方按鈕撥打電話\n\n電話：${phone}`,
    [
      createUriButton('📞 撥打', `tel:${phone}`, 'primary', '#111111')
    ],
    '#111111'
  );
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

  await safePush(LINE_GROUP_ID, createGroupTaskFlex(orderId));

  return safeReply(event.replyToken, textMessage('✅ 任務已建立成功，系統正在尋找騎手'));
}

// ===== 路由 =====
app.get('/', (req, res) => {
  res.status(200).send('UBee OMS V3.7.5 Flex Running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
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

    if (text === '主選單') return safeReply(event.replyToken, createMainMenuFlex());
    if (text === '下單') return safeReply(event.replyToken, createOrderMenuFlex());
    if (text === '企業') return safeReply(event.replyToken, createEnterpriseFlex());
    if (text === '我的') return safeReply(event.replyToken, createMeFlex());

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
    return safeReply(event.replyToken, createUrgentChoiceFlex());
  }

  if (session.step === 'urgent') {
    if (text !== '一般' && text !== '急件') {
      return safeReply(event.replyToken, createUrgentChoiceFlex());
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

    return safeReply(
      event.replyToken,
      createConfirmCardFlex(session, isQuote ? 'quote' : 'create')
    );
  }

  if (session.step === 'confirm') {
    return safeReply(event.replyToken, textMessage('請直接使用下方按鈕進行確認、重新填寫或取消。'));
  }

  clearSession(userId);
  return safeReply(event.replyToken, textMessage('⚠️ 流程已重置，請重新開始。'));
}

// ===== Postback =====
async function handlePostback(event) {
  const data = event.postback.data || '';
  const userId = event.source.userId;

  if (data === 'action=create') {
    sessions[userId] = createEmptySession(userId, 'create_order');
    return safeReply(event.replyToken, textMessage('請輸入取件地點：'));
  }

  if (data === 'action=quote') {
    sessions[userId] = createEmptySession(userId, 'quote_order');
    return safeReply(event.replyToken, textMessage('請輸入取件地點：'));
  }

  if (data === 'action=confirmCreate') {
    const session = getSession(userId);
    if (!session || session.type !== 'create_order' || session.step !== 'confirm') {
      return safeReply(event.replyToken, textMessage('⚠️ 目前沒有可送出的任務資料，請重新建立任務。'));
    }
    return createOrderFromSession(event, session);
  }

  if (data === 'action=confirmQuoteCreate') {
    const session = getSession(userId);
    if (!session || session.type !== 'quote_order' || session.step !== 'confirm') {
      return safeReply(event.replyToken, textMessage('⚠️ 目前沒有可送出的估價資料，請重新操作。'));
    }
    return createOrderFromSession(event, session);
  }

  if (data === 'action=restartCreate') {
    sessions[userId] = createEmptySession(userId, 'create_order');
    return safeReply(event.replyToken, textMessage('請重新輸入取件地點：'));
  }

  if (data === 'action=restartQuote') {
    sessions[userId] = createEmptySession(userId, 'quote_order');
    return safeReply(event.replyToken, textMessage('請重新輸入取件地點：'));
  }

  if (data === 'action=cancelCreate') {
    clearSession(userId);
    return safeReply(event.replyToken, textMessage('✅ 已取消本次建立任務'));
  }

  if (data === 'action=cancelQuote') {
    clearSession(userId);
    return safeReply(event.replyToken, textMessage('✅ 已取消本次立即估價'));
  }

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

    return safeReply(event.replyToken, createETAFlex(orderId, 1));
  }

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

  if (data.startsWith('etaPage2=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '查看 ETA')) return;

    return safeReply(event.replyToken, createETAFlex(orderId, 2));
  }

  if (data.startsWith('etaPage3=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '查看 ETA')) return;

    return safeReply(event.replyToken, createETAFlex(orderId, 3));
  }

  if (data.startsWith('etaPage4=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '查看 ETA')) return;

    return safeReply(event.replyToken, createETAFlex(orderId, 4));
  }

  if (data.startsWith('eta=')) {
    const [, orderId, min] = data.split('=');
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '設定 ETA')) return;

    order.etaMinutes = min;

    await safePush(order.userId, textMessage(`✅ 已有騎手接單，預計 ${min} 分鐘抵達取件地點`));
    await safePush(LINE_GROUP_ID, textMessage(`✅ 任務已接單，預計 ${min} 分鐘抵達取件地點`));
    await safePush(LINE_GROUP_ID, createPickupActionFlex(orderId));

    return safeReply(event.replyToken, textMessage(`✅ 已設定 ETA，預計 ${min} 分鐘抵達取件地點`));
  }

  if (data.startsWith('arrivePickup=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['accepted'], '已抵達')) return;

    order.status = 'arrived_pickup';
    order.arrivedPickupAt = new Date().toISOString();

    await safePush(order.userId, textMessage('📍 騎手已抵達取件地點'));

    return safeReply(event.replyToken, createPickedActionFlex(orderId));
  }

  if (data.startsWith('picked=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['arrived_pickup'], '已取件')) return;

    order.status = 'picked_up';
    order.pickedUpAt = new Date().toISOString();

    await safePush(order.userId, textMessage('✅ 騎手已完成取件，正在前往送達地點'));

    return safeReply(event.replyToken, createDropoffActionFlex(orderId));
  }

  if (data.startsWith('arriveDropoff=')) {
    const orderId = data.split('=')[1];
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['picked_up'], '抵達送達地點')) return;

    order.status = 'arrived_dropoff';
    order.arrivedDropoffAt = new Date().toISOString();

    return safeReply(event.replyToken, createDropoffArrivedFlex(orderId));
  }

  if (data.startsWith('call=')) {
    const [, orderId, phone] = data.split('=');
    const order = requireOrder(event.replyToken, orderId);
    if (!order) return;
    if (!requireDriver(event.replyToken, order, userId)) return;
    if (!requireStatus(event.replyToken, order, ['arrived_dropoff'], '撥打電話')) return;

    return safeReply(event.replyToken, createCallFlex(phone));
  }

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

// ===== 啟動 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('UBee OMS V3.7.5 Flex Running');
});
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

// =========================
// 費率設定
// =========================
const BASE_FEE = 99;
const PER_KM_FEE = 6;
const PER_MIN_FEE = 3;
const CROSS_DISTRICT_FEE = 25;
const SERVICE_FEE = 50;
const URGENT_FEE = 100;
const FIXED_TAX = 15;

// 騎手實拿比例（配送費 * 0.6）
const RIDER_RATE = 0.6;

// =========================
// 記憶體資料（目前為簡易版）
// 若 Render 重啟，資料會清空
// =========================
const userSessions = {};   // 客人流程
const riderSessions = {};  // 騎手流程
const tasks = {};          // 任務資料
let taskCounter = 1;

// =========================
// 工具
// =========================
function getUserId(event) {
  return event.source.userId;
}

function getGroupId(event) {
  return event.source.groupId || '';
}

function getReplyToken(event) {
  return event.replyToken;
}

function safeTrim(text) {
  return (text || '').trim();
}

function formatCurrency(num) {
  return `$${Math.round(num)}`;
}

function createTaskId() {
  const id = `T${String(taskCounter).padStart(5, '0')}`;
  taskCounter += 1;
  return id;
}

function parseDistrict(address = '') {
  const cleaned = address.replace(/\s/g, '');
  const match = cleaned.match(/台中市?([^區鄉鎮市]{1,6}[區鄉鎮市])/);
  if (match && match[1]) return match[1];

  const districts = [
    '中區', '東區', '南區', '西區', '北區',
    '北屯區', '西屯區', '南屯區',
    '太平區', '大里區', '霧峰區', '烏日區',
    '豐原區', '后里區', '石岡區', '東勢區',
    '和平區', '新社區', '潭子區', '大雅區',
    '神岡區', '大肚區', '沙鹿區', '龍井區',
    '梧棲區', '清水區', '大甲區', '外埔區',
    '大安區'
  ];

  for (const d of districts) {
    if (address.includes(d)) return d;
  }
  return '';
}

function isCrossDistrict(pickupAddress, dropoffAddress) {
  const d1 = parseDistrict(pickupAddress);
  const d2 = parseDistrict(dropoffAddress);
  if (!d1 || !d2) return false;
  return d1 !== d2;
}

async function geocodeAddress(address) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('未設定 GOOGLE_MAPS_API_KEY');
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}&language=zh-TW`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK' || !data.results || !data.results.length) {
    throw new Error(`地址查詢失敗：${data.error_message || data.status}`);
  }

  const result = data.results[0];
  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    formattedAddress: result.formatted_address || address,
  };
}

async function getDistanceAndDuration(pickupAddress, dropoffAddress) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('未設定 GOOGLE_MAPS_API_KEY');
  }

  // 先 geocode，增加地址穩定性
  const pickupGeo = await geocodeAddress(pickupAddress);
  const dropoffGeo = await geocodeAddress(dropoffAddress);

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${pickupGeo.lat},${pickupGeo.lng}&destinations=${dropoffGeo.lat},${dropoffGeo.lng}&mode=driving&language=zh-TW&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK') {
    throw new Error(`距離查詢失敗：${data.error_message || data.status}`);
  }

  const element = data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK') {
    throw new Error(`距離查詢失敗：${element?.status || 'UNKNOWN'}`);
  }

  const distanceMeters = element.distance.value;
  const durationSeconds = element.duration.value;

  return {
    distanceKm: distanceMeters / 1000,
    durationMin: Math.ceil(durationSeconds / 60),
    pickupFormatted: pickupGeo.formattedAddress,
    dropoffFormatted: dropoffGeo.formattedAddress,
  };
}

async function calculatePrice(pickupAddress, dropoffAddress, urgent) {
  const route = await getDistanceAndDuration(pickupAddress, dropoffAddress);

  const distanceFee = Math.round(route.distanceKm * PER_KM_FEE);
  const timeFee = Math.round(route.durationMin * PER_MIN_FEE);
  const crossFee = isCrossDistrict(pickupAddress, dropoffAddress) ? CROSS_DISTRICT_FEE : 0;
  const urgentFee = urgent === '急件' ? URGENT_FEE : 0;

  const deliveryFee = BASE_FEE + distanceFee + timeFee + crossFee;
  const subtotal = deliveryFee + SERVICE_FEE + urgentFee;
  const total = subtotal + FIXED_TAX;

  const riderFee = Math.round(deliveryFee * RIDER_RATE);

  return {
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
    deliveryFee,
    serviceFee: SERVICE_FEE,
    urgentFee,
    tax: FIXED_TAX,
    subtotal,
    total,
    riderFee,
    pickupFormatted: route.pickupFormatted,
    dropoffFormatted: route.dropoffFormatted,
    crossFee,
  };
}

function resetUserSession(userId) {
  delete userSessions[userId];
}

function startCreateTaskFlow(userId) {
  userSessions[userId] = {
    mode: 'create_task',
    step: 'pickupAddress',
    data: {},
  };
}

function startQuoteFlow(userId) {
  userSessions[userId] = {
    mode: 'quote_only',
    step: 'pickupAddress',
    data: {},
  };
}

function buildTaskSummary(task) {
  return [
    '請確認以下任務資訊：',
    '',
    `取件地點：${task.pickupAddress}`,
    `取件電話：${task.pickupPhone}`,
    '',
    `送達地點：${task.dropoffAddress}`,
    `送達電話：${task.dropoffPhone}`,
    '',
    `物品內容：${task.item}`,
    `是否急件：${task.urgent}`,
    `備註：${task.note || '無'}`,
    '',
    `配送費：${formatCurrency(task.pricing.deliveryFee)}`,
    `服務費：${formatCurrency(task.pricing.serviceFee)}`,
    `急件費：${formatCurrency(task.pricing.urgentFee)}`,
    `稅金：${formatCurrency(task.pricing.tax)}`,
    `總計：${formatCurrency(task.pricing.total)}`,
  ].join('\n');
}

function buildQuoteSummary(data, pricing) {
  return [
    '以下是本次立即估價結果：',
    '',
    `取件地點：${data.pickupAddress}`,
    `送達地點：${data.dropoffAddress}`,
    `物品內容：${data.item}`,
    `是否急件：${data.urgent}`,
    `備註：${data.note || '無'}`,
    '',
    `配送費：${formatCurrency(pricing.deliveryFee)}`,
    `服務費：${formatCurrency(pricing.serviceFee)}`,
    `急件費：${formatCurrency(pricing.urgentFee)}`,
    `稅金：${formatCurrency(pricing.tax)}`,
    `總計：${formatCurrency(pricing.total)}`,
  ].join('\n');
}

function createConfirmButtonsText(summaryText) {
  return {
    type: 'template',
    altText: '請確認任務資訊',
    template: {
      type: 'buttons',
      text: summaryText.length > 160 ? summaryText.slice(0, 157) + '...' : summaryText,
      actions: [
        { type: 'message', label: '確認', text: '確認' },
        { type: 'message', label: '修改', text: '修改' },
        { type: 'message', label: '取消', text: '取消' },
      ],
    },
  };
}

function createQuoteDecisionTemplate() {
  return {
    type: 'template',
    altText: '是否確定建立任務',
    template: {
      type: 'buttons',
      text: '是否確定建立任務？',
      actions: [
        { type: 'message', label: '是', text: '是' },
        { type: 'message', label: '否', text: '否' },
      ],
    },
  };
}

function createMainMenuMessage() {
  return {
    type: 'text',
    text:
      '您好，歡迎使用 UBee OMS。\n\n您可以直接輸入：\n・建立任務\n・立即估價',
  };
}

function createGroupTaskTemplate(task) {
  const text =
    `📦 UBee 新任務通知\n\n` +
    `費用：${formatCurrency(task.riderFee)}\n` +
    `距離：${task.pricing.distanceKm.toFixed(1)} 公里\n\n` +
    `取件：${task.pickupAddress}\n` +
    `送達：${task.dropoffAddress}\n` +
    `物品：${task.item}\n` +
    `急件：${task.urgent}`;

  return {
    type: 'template',
    altText: 'UBee 新任務通知',
    template: {
      type: 'buttons',
      text: text.length > 160 ? text.slice(0, 157) + '...' : text,
      actions: [
        {
          type: 'postback',
          label: '接單',
          data: `action=acceptTask&taskId=${task.id}`,
          displayText: `我要接單 ${task.id}`,
        },
      ],
    },
  };
}

function createAssignedTaskStatusTemplate(taskId) {
  return {
    type: 'template',
    altText: '任務狀態操作',
    template: {
      type: 'buttons',
      text: '請選擇任務狀態',
      actions: [
        {
          type: 'postback',
          label: '已抵達',
          data: `action=taskStatus&taskId=${taskId}&status=arrived`,
          displayText: `已抵達 ${taskId}`,
        },
        {
          type: 'postback',
          label: '已取件',
          data: `action=taskStatus&taskId=${taskId}&status=picked`,
          displayText: `已取件 ${taskId}`,
        },
        {
          type: 'postback',
          label: '已送達',
          data: `action=taskStatus&taskId=${taskId}&status=delivered`,
          displayText: `已送達 ${taskId}`,
        },
        {
          type: 'postback',
          label: '已完成',
          data: `action=taskStatus&taskId=${taskId}&status=completed`,
          displayText: `已完成 ${taskId}`,
        },
      ],
    },
  };
}

function createEtaQuickReply(taskId) {
  return {
    type: 'text',
    text: '請回覆多久抵達取件地點，或直接點選下方按鈕。',
    quickReply: {
      items: [5, 10, 15, 20, 30].map((min) => ({
        type: 'action',
        action: {
          type: 'postback',
          label: `${min} 分鐘`,
          data: `action=eta&taskId=${taskId}&minutes=${min}`,
          displayText: `${min}`,
        },
      })),
    },
  };
}

function parsePostbackData(data = '') {
  const result = {};
  data.split('&').forEach((pair) => {
    const [k, v] = pair.split('=');
    if (k) result[k] = v;
  });
  return result;
}

async function pushMessageSafe(to, message) {
  if (!to) return;
  try {
    await client.pushMessage(to, message);
  } catch (err) {
    console.error('❌ pushMessage error:', err?.response?.data || err.message || err);
  }
}

async function replyMessageSafe(replyToken, messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  try {
    await client.replyMessage(replyToken, arr);
  } catch (err) {
    console.error('❌ replyMessage error:', err?.response?.data || err.message || err);
  }
}

async function getUserDisplayName(userId, source) {
  try {
    if (source.groupId) {
      const profile = await client.getGroupMemberProfile(source.groupId, userId);
      return profile.displayName || '騎手';
    }
    const profile = await client.getProfile(userId);
    return profile.displayName || '使用者';
  } catch (e) {
    return '使用者';
  }
}

// =========================
// 狀態訊息
// =========================
function getStatusText(status) {
  switch (status) {
    case 'arrived':
      return '已抵達取件地點';
    case 'picked':
      return '已取件';
    case 'delivered':
      return '已送達';
    case 'completed':
      return '已完成';
    default:
      return '狀態更新';
  }
}

// =========================
// 任務建立
// =========================
async function finalizeTaskAndDispatch(userId, sessionData) {
  const pricing = await calculatePrice(sessionData.pickupAddress, sessionData.dropoffAddress, sessionData.urgent);

  const taskId = createTaskId();
  const task = {
    id: taskId,
    customerUserId: userId,
    pickupAddress: sessionData.pickupAddress,
    pickupPhone: sessionData.pickupPhone,
    dropoffAddress: sessionData.dropoffAddress,
    dropoffPhone: sessionData.dropoffPhone,
    item: sessionData.item,
    urgent: sessionData.urgent,
    note: sessionData.note || '無',
    pricing,
    riderFee: pricing.riderFee,
    status: 'pending',
    assignedRiderId: '',
    assignedRiderName: '',
    createdAt: new Date().toISOString(),
  };

  tasks[taskId] = task;
  return task;
}

// =========================
// 建立任務流程訊息
// =========================
async function handleCreateOrQuoteInput(event, userId, text) {
  const session = userSessions[userId];
  if (!session) return false;

  const data = session.data;
  const mode = session.mode;

  // 共用流程：先處理等待確認
  if (session.step === 'quoteConfirmCreate') {
    if (text === '是') {
      session.mode = 'create_task';
      session.step = 'pickupPhone';
      return replyMessageSafe(getReplyToken(event), {
        type: 'text',
        text:
          `好的，以下將接續您剛剛的估價內容建立任務。\n\n` +
          `取件地點：${data.pickupAddress}\n` +
          `送達地點：${data.dropoffAddress}\n` +
          `物品內容：${data.item}\n` +
          `是否急件：${data.urgent}\n\n` +
          `請輸入取件電話：`,
      });
    }

    if (text === '否') {
      resetUserSession(userId);
      return replyMessageSafe(getReplyToken(event), {
        type: 'text',
        text: '好的，本次未建立任務。若您需要，可再次輸入「建立任務」或「立即估價」。',
      });
    }

    return replyMessageSafe(getReplyToken(event), {
      type: 'text',
      text: '請直接回覆「是」或「否」。',
    });
  }

  if (session.step === 'confirmTask') {
    if (text === '確認') {
      try {
        const task = await finalizeTaskAndDispatch(userId, data);

        await replyMessageSafe(getReplyToken(event), {
          type: 'text',
          text:
            `✅ 您的任務已建立成功。\n\n` +
            `配送費：${formatCurrency(task.pricing.deliveryFee)}\n` +
            `服務費：${formatCurrency(task.pricing.serviceFee)}\n` +
            `急件費：${formatCurrency(task.pricing.urgentFee)}\n` +
            `稅金：${formatCurrency(task.pricing.tax)}\n` +
            `總計：${formatCurrency(task.pricing.total)}\n\n` +
            `我們會立即為您派單。`,
        });

        if (LINE_GROUP_ID) {
          await pushMessageSafe(LINE_GROUP_ID, createGroupTaskTemplate(task));
        } else {
          console.warn('⚠️ LINE_GROUP_ID 未設定，無法派單到群組');
        }

        resetUserSession(userId);
      } catch (err) {
        console.error('❌ finalizeTaskAndDispatch error:', err.message);
        resetUserSession(userId);
        return replyMessageSafe(getReplyToken(event), {
          type: 'text',
          text: `建立任務失敗：${err.message}`,
        });
      }
      return true;
    }

    if (text === '修改') {
      session.step = 'pickupAddress';
      return replyMessageSafe(getReplyToken(event), {
        type: 'text',
        text: '好的，請重新輸入取件地點：',
      });
    }

    if (text === '取消') {
      resetUserSession(userId);
      return replyMessageSafe(getReplyToken(event), {
        type: 'text',
        text: '好的，已取消本次任務。',
      });
    }

    return replyMessageSafe(getReplyToken(event), {
      type: 'text',
      text: '請直接回覆「確認」、「修改」或「取消」。',
    });
  }

  // 立即估價流程
  if (mode === 'quote_only') {
    switch (session.step) {
      case 'pickupAddress':
        data.pickupAddress = text;
        session.step = 'dropoffAddress';
        return replyMessageSafe(getReplyToken(event), {
          type: 'text',
          text: '請輸入送達地點：',
        });

      case 'dropoffAddress':
        data.dropoffAddress = text;
        session.step = 'item';
        return replyMessageSafe(getReplyToken(event), {
          type: 'text',
          text: '請輸入物品內容：',
        });

      case 'item':
        data.item = text;
        session.step = 'urgent';
        return replyMessageSafe(getReplyToken(event), {
          type: 'text',
          text: '請輸入是否急件（一般 / 急件）：',
        });

      case 'urgent':
        if (!['一般', '急件'].includes(text)) {
          return replyMessageSafe(getReplyToken(event), {
            type: 'text',
            text: '請輸入「一般」或「急件」。',
          });
        }
        data.urgent = text;
        session.step = 'note';
        return replyMessageSafe(getReplyToken(event), {
          type: 'text',
          text: '請輸入備註（若無請輸入：無）：',
        });

      case 'note':
        data.note = text || '無';

        try {
          const pricing = await calculatePrice(data.pickupAddress, data.dropoffAddress, data.urgent);
          data.pricing = pricing;

          await replyMessageSafe(getReplyToken(event), [
            {
              type: 'text',
              text: buildQuoteSummary(data, pricing),
            },
            createQuoteDecisionTemplate(),
          ]);

          session.step = 'quoteConfirmCreate';
        } catch (err) {
          console.error('❌ quote calculate error:', err.message);
          resetUserSession(userId);
          return replyMessageSafe(getReplyToken(event), {
            type: 'text',
            text: `立即估價失敗：${err.message}`,
          });
        }
        return true;
    }
  }

  // 建立任務流程
  if (mode === 'create_task') {
    switch (session.step) {
      case 'pickupAddress':
        data.pickupAddress = text;
        session.step = 'pickupPhone';
        return replyMessageSafe(getReplyToken(event), {
          type: 'text',
          text: '請輸入取件電話：',
        });

      case 'pickupPhone':
        data.pickupPhone = text;
        session.step = 'dropoffAddress';
        return replyMessageSafe(getReplyToken(event), {
          type: 'text',
          text: '請輸入送達地點：',
        });

      case 'dropoffAddress':
        data.dropoffAddress = text;
        session.step = 'dropoffPhone';
        return replyMessageSafe(getReplyToken(event), {
          type: 'text',
          text: '請輸入送達電話：',
        });

      case 'dropoffPhone':
        data.dropoffPhone = text;
        session.step = 'item';
        return replyMessageSafe(getReplyToken(event), {
          type: 'text',
          text: '請輸入物品內容：',
        });

      case 'item':
        data.item = text;
        session.step = 'urgent';
        return replyMessageSafe(getReplyToken(event), {
          type: 'text',
          text: '請輸入是否急件（一般 / 急件）：',
        });

      case 'urgent':
        if (!['一般', '急件'].includes(text)) {
          return replyMessageSafe(getReplyToken(event), {
            type: 'text',
            text: '請輸入「一般」或「急件」。',
          });
        }
        data.urgent = text;
        session.step = 'note';
        return replyMessageSafe(getReplyToken(event), {
          type: 'text',
          text: '請輸入備註（若無請輸入：無）：',
        });

      case 'note':
        data.note = text || '無';

        try {
          const pricing = await calculatePrice(data.pickupAddress, data.dropoffAddress, data.urgent);
          data.pricing = pricing;

          const summary = buildTaskSummary({
            ...data,
            pricing,
          });

          await replyMessageSafe(getReplyToken(event), [
            { type: 'text', text: summary },
            createConfirmButtonsText(summary),
          ]);

          session.step = 'confirmTask';
        } catch (err) {
          console.error('❌ create calculate error:', err.message);
          resetUserSession(userId);
          return replyMessageSafe(getReplyToken(event), {
            type: 'text',
            text: `建立任務失敗：${err.message}`,
          });
        }
        return true;
    }
  }

  return false;
}

// =========================
// 騎手文字指令
// =========================
async function handleGroupTextCommands(event, userId, text) {
  const groupId = getGroupId(event);
  if (!groupId || groupId !== LINE_GROUP_ID) return false;

  const lower = text.replace(/\s+/g, ' ').trim();

  // 若騎手正在等待 ETA 輸入
  const riderSession = riderSessions[userId];
  if (riderSession && riderSession.step === 'waitingEta') {
    const mins = parseInt(lower, 10);
    if (!Number.isNaN(mins) && mins > 0) {
      const task = tasks[riderSession.taskId];
      if (!task) {
        delete riderSessions[userId];
        return replyMessageSafe(getReplyToken(event), {
          type: 'text',
          text: '找不到該任務。',
        });
      }

      task.etaMinutes = mins;
      delete riderSessions[userId];

      await replyMessageSafe(getReplyToken(event), {
        type: 'text',
        text: `✅ 已接單，預計 ${mins} 分鐘抵達取件地點。`,
      });

      await pushMessageSafe(task.customerUserId, {
        type: 'text',
        text:
          `✅ 已有騎手接單。\n` +
          `⏱ 預計 ${mins} 分鐘抵達取件地點。`,
      });

      await pushMessageSafe(LINE_GROUP_ID, createAssignedTaskStatusTemplate(task.id));
      return true;
    }
  }

  // 接單 8 / 接 / 接單 / +1
  const acceptWithEta = lower.match(/^(接單|接|\+1)\s*(\d+)?$/);
  if (acceptWithEta) {
    const mins = acceptWithEta[2] ? parseInt(acceptWithEta[2], 10) : null;

    const pendingTask = Object.values(tasks)
      .filter((t) => t.status === 'pending')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

    if (!pendingTask) {
      return replyMessageSafe(getReplyToken(event), {
        type: 'text',
        text: '目前沒有待接任務。',
      });
    }

    if (pendingTask.assignedRiderId) {
      return replyMessageSafe(getReplyToken(event), {
        type: 'text',
        text: '此任務已被其他騎手接走。',
      });
    }

    const riderName = await getUserDisplayName(userId, event.source);
    pendingTask.assignedRiderId = userId;
    pendingTask.assignedRiderName = riderName;
    pendingTask.status = 'accepted';

    if (mins && mins > 0) {
      pendingTask.etaMinutes = mins;

      await replyMessageSafe(getReplyToken(event), {
        type: 'text',
        text: `✅ ${riderName} 已接單，預計 ${mins} 分鐘抵達取件地點。`,
      });

      await pushMessageSafe(pendingTask.customerUserId, {
        type: 'text',
        text:
          `✅ 已有騎手接單。\n` +
          `⏱ 預計 ${mins} 分鐘抵達取件地點。`,
      });

      await pushMessageSafe(LINE_GROUP_ID, createAssignedTaskStatusTemplate(pendingTask.id));
      return true;
    }

    riderSessions[userId] = {
      step: 'waitingEta',
      taskId: pendingTask.id,
    };

    return replyMessageSafe(getReplyToken(event), createEtaQuickReply(pendingTask.id));
  }

  // 文字狀態更新（備援）
  const statusMap = {
    '已抵達': 'arrived',
    '已取件': 'picked',
    '已送達': 'delivered',
    '已完成': 'completed',
  };

  if (statusMap[lower]) {
    const activeTask = Object.values(tasks)
      .filter((t) => t.assignedRiderId === userId && t.status !== 'completed')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

    if (!activeTask) {
      return replyMessageSafe(getReplyToken(event), {
        type: 'text',
        text: '您目前沒有可更新的任務。',
      });
    }

    const status = statusMap[lower];
    activeTask.status = status;

    await replyMessageSafe(getReplyToken(event), {
      type: 'text',
      text: `✅ 任務狀態已更新為：${getStatusText(status)}`,
    });

    await pushMessageSafe(activeTask.customerUserId, {
      type: 'text',
      text: `📦 您的任務目前狀態：${getStatusText(status)}`,
    });

    if (status === 'completed') {
      await pushMessageSafe(activeTask.customerUserId, {
        type: 'text',
        text:
          '✅ 已抵達目的地，任務已完成。\n\n' +
          '感謝您使用 UBee 城市任務服務。\n' +
          '期待再次為您服務。',
      });
    }

    return true;
  }

  return false;
}

// =========================
// Postback 處理
// =========================
async function handlePostback(event) {
  const replyToken = getReplyToken(event);
  const userId = getUserId(event);
  const source = event.source;
  const postback = parsePostbackData(event.postback.data || '');
  const action = postback.action;

  if (action === 'acceptTask') {
    const taskId = postback.taskId;
    const task = tasks[taskId];

    if (!task) {
      return replyMessageSafe(replyToken, {
        type: 'text',
        text: '找不到該任務。',
      });
    }

    if (source.groupId !== LINE_GROUP_ID) {
      return replyMessageSafe(replyToken, {
        type: 'text',
        text: '此操作只能在指定群組使用。',
      });
    }

    if (task.assignedRiderId) {
      return replyMessageSafe(replyToken, {
        type: 'text',
        text: '此任務已被其他騎手接走。',
      });
    }

    const riderName = await getUserDisplayName(userId, source);

    task.assignedRiderId = userId;
    task.assignedRiderName = riderName;
    task.status = 'accepted';

    riderSessions[userId] = {
      step: 'waitingEta',
      taskId,
    };

    return replyMessageSafe(replyToken, [
      {
        type: 'text',
        text: `✅ ${riderName} 已接單。`,
      },
      createEtaQuickReply(taskId),
    ]);
  }

  if (action === 'eta') {
    const taskId = postback.taskId;
    const minutes = parseInt(postback.minutes, 10);
    const task = tasks[taskId];

    if (!task) {
      return replyMessageSafe(replyToken, {
        type: 'text',
        text: '找不到該任務。',
      });
    }

    if (task.assignedRiderId !== userId) {
      return replyMessageSafe(replyToken, {
        type: 'text',
        text: '只有已接單騎手本人可以操作。',
      });
    }

    if (Number.isNaN(minutes) || minutes <= 0) {
      return replyMessageSafe(replyToken, {
        type: 'text',
        text: 'ETA 格式錯誤。',
      });
    }

    task.etaMinutes = minutes;
    delete riderSessions[userId];

    await replyMessageSafe(replyToken, {
      type: 'text',
      text: `✅ 已設定 ETA，預計 ${minutes} 分鐘抵達取件地點。`,
    });

    await pushMessageSafe(task.customerUserId, {
      type: 'text',
      text:
        `✅ 已有騎手接單。\n` +
        `⏱ 預計 ${minutes} 分鐘抵達取件地點。`,
    });

    await pushMessageSafe(LINE_GROUP_ID, createAssignedTaskStatusTemplate(taskId));
    return true;
  }

  if (action === 'taskStatus') {
    const taskId = postback.taskId;
    const status = postback.status;
    const task = tasks[taskId];

    if (!task) {
      return replyMessageSafe(replyToken, {
        type: 'text',
        text: '找不到該任務。',
      });
    }

    if (task.assignedRiderId !== userId) {
      return replyMessageSafe(replyToken, {
        type: 'text',
        text: '只有已接單騎手本人可以更新任務狀態。',
      });
    }

    task.status = status;

    await replyMessageSafe(replyToken, {
      type: 'text',
      text: `✅ 任務狀態已更新為：${getStatusText(status)}`,
    });

    await pushMessageSafe(task.customerUserId, {
      type: 'text',
      text: `📦 您的任務目前狀態：${getStatusText(status)}`,
    });

    if (status === 'completed') {
      await pushMessageSafe(task.customerUserId, {
        type: 'text',
        text:
          '✅ 已抵達目的地，任務已完成。\n\n' +
          '感謝您使用 UBee 城市任務服務。\n' +
          '期待再次為您服務。',
      });
    }

    return true;
  }

  return replyMessageSafe(replyToken, {
    type: 'text',
    text: '無法辨識此操作。',
  });
}

// =========================
// 文字訊息主流程
// =========================
async function handleTextMessage(event) {
  const userId = getUserId(event);
  const replyToken = getReplyToken(event);
  const text = safeTrim(event.message.text);

  // 先處理群組內騎手指令
  const handledGroup = await handleGroupTextCommands(event, userId, text);
  if (handledGroup) return;

  // 客人主流程指令
  if (text === '建立任務') {
    startCreateTaskFlow(userId);
    return replyMessageSafe(replyToken, {
      type: 'text',
      text: '請輸入取件地點：',
    });
  }

  if (text === '立即估價') {
    startQuoteFlow(userId);
    return replyMessageSafe(replyToken, {
      type: 'text',
      text: '請輸入取件地點：',
    });
  }

  // 進行中流程
  const handledFlow = await handleCreateOrQuoteInput(event, userId, text);
  if (handledFlow) return;

  // 完成任務後客戶回謝謝
  if (['謝謝', '感謝', 'thanks', 'thank you'].includes(text.toLowerCase())) {
    return replyMessageSafe(replyToken, {
      type: 'text',
      text: '不客氣，謝謝您使用 UBee，期待再次為您服務。',
    });
  }

  // 預設回覆
  return replyMessageSafe(replyToken, createMainMenuMessage());
}

// =========================
// LINE Webhook
// =========================
app.get('/', (req, res) => {
  res.status(200).send('UBee OMS V3.6.3 Running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(async (event) => {
      try {
        if (event.type === 'message' && event.message.type === 'text') {
          return handleTextMessage(event);
        }

        if (event.type === 'postback') {
          return handlePostback(event);
        }

        return null;
      } catch (err) {
        console.error('❌ Event handle error:', err);
        return null;
      }
    }));

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.status(500).send('Webhook Error');
  }
});

app.listen(PORT, () => {
  console.log(`✅ UBee OMS V3.6.3 running on port ${PORT}`);
});

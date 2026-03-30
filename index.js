const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// 保留 raw body 給 LINE 驗證簽章
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ===== 記憶體資料 =====
const userSessions = new Map();
const tasks = new Map();

// ===== 固定欄位 =====
const FLOW_FIELDS = [
  { key: "pickupAddress", label: "取件地點" },
  { key: "dropoffAddress", label: "送達地點" },
  { key: "item", label: "物品內容" },
  { key: "urgent", label: "是否急件" },
  { key: "phone", label: "聯絡電話" },
];

const PRICE_CONFIG = {
  baseFee: 99,
  perKm: 6,
  perMinute: 3,
  crossDistrictFee: 25,
  urgentFee: 100,
  memberDiscount: 0,
  tax: 15,
};

const HELP_TEXT =
  "請輸入以下功能：\n" +
  "1. 建立任務\n" +
  "2. 立即估價\n\n" +
  "若要取消目前流程，請輸入：取消";

// ===== 工具函式 =====
function validateEnv() {
  const missing = [];

  if (!CHANNEL_ACCESS_TOKEN) missing.push("CHANNEL_ACCESS_TOKEN");
  if (!CHANNEL_SECRET) missing.push("CHANNEL_SECRET");
  if (!GOOGLE_MAPS_API_KEY) missing.push("GOOGLE_MAPS_API_KEY");

  if (missing.length > 0) {
    console.error("缺少環境變數：", missing.join(", "));
  }
}

function isLineSignatureValid(channelSecret, rawBody, signature) {
  if (!channelSecret || !rawBody || !signature) return false;

  const hash = crypto
    .createHmac("SHA256", channelSecret)
    .update(rawBody)
    .digest("base64");

  return hash === signature;
}

function normalizeTaichungAddress(address) {
  let text = (address || "").trim();
  if (!text) return text;

  if (!/^(台中市|臺中市)/.test(text)) {
    text = `台中市${text}`;
  }
  return text;
}

function normalizeUrgentInput(text) {
  const value = (text || "").trim().toLowerCase();

  if (["是", "要", "需要", "急件", "yes", "y", "1"].includes(value)) return "是";
  if (["否", "不要", "不需要", "不是", "no", "n", "0"].includes(value)) return "否";

  return (text || "").trim();
}

function isValidUrgentValue(value) {
  return value === "是" || value === "否";
}

function generateTaskId() {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `U${y}${m}${d}${rand}`;
}

function getDistrict(address) {
  const text = address || "";
  const match = text.match(/([^\s]+?[區鄉鎮市])/);
  return match ? match[1] : "";
}

function formatMoney(num) {
  return `$${Math.round(Number(num) || 0)}`;
}

function buildMainMenuText() {
  return "您好，這裡是 UBee 城市任務。\n\n" + HELP_TEXT;
}

function buildAskText(mode, stepIndex) {
  const field = FLOW_FIELDS[stepIndex];
  const title = mode === "create" ? "建立任務" : "立即估價";
  return `您目前正在使用【${title}】\n\n請輸入：${field.label}`;
}

function buildTaskSummary(data) {
  return (
    `取件地點：${data.pickupAddress}\n` +
    `送達地點：${data.dropoffAddress}\n` +
    `物品內容：${data.item}\n` +
    `是否急件：${data.urgent}\n` +
    `聯絡電話：${data.phone}`
  );
}

function startFlow(userId, mode) {
  userSessions.set(userId, {
    mode,
    stepIndex: 0,
    data: {},
  });
}

function clearFlow(userId) {
  userSessions.delete(userId);
}

async function callLineReplyApi(replyToken, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LINE reply API 錯誤：${res.status} ${text}`);
  }
}

async function callLinePushApi(to, messages) {
  if (!to) return;

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LINE push API 錯誤：${res.status} ${text}`);
  }
}

async function replyText(replyToken, text) {
  await callLineReplyApi(replyToken, [{ type: "text", text }]);
}

async function replyTexts(replyToken, texts) {
  const messages = texts.map((text) => ({ type: "text", text }));
  await callLineReplyApi(replyToken, messages);
}

async function pushText(to, text) {
  await callLinePushApi(to, [{ type: "text", text }]);
}

async function getDistanceAndDuration(origin, destination) {
  const url =
    "https://maps.googleapis.com/maps/api/distancematrix/json" +
    `?origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(destination)}` +
    `&mode=driving&language=zh-TW&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Maps API HTTP 錯誤：${res.status} ${text}`);
  }

  const data = await res.json();

  if (data.status !== "OK") {
    throw new Error(`Google Maps API 錯誤：${data.status}`);
  }

  const element =
    data.rows &&
    data.rows[0] &&
    data.rows[0].elements &&
    data.rows[0].elements[0];

  if (!element) {
    throw new Error("Google Maps API 沒有回傳距離資料");
  }

  if (element.status !== "OK") {
    throw new Error(`Google Maps 路線資料錯誤：${element.status}`);
  }

  return {
    distanceMeters: element.distance.value,
    durationSeconds: element.duration.value,
    distanceText: element.distance.text,
    durationText: element.duration.text,
  };
}

function calculatePrice({
  distanceMeters,
  durationSeconds,
  pickupAddress,
  dropoffAddress,
  urgent,
}) {
  const km = distanceMeters / 1000;
  const minutes = durationSeconds / 60;

  const pickupDistrict = getDistrict(pickupAddress);
  const dropoffDistrict = getDistrict(dropoffAddress);
  const isCrossDistrict =
    pickupDistrict && dropoffDistrict && pickupDistrict !== dropoffDistrict;

  const baseFee = PRICE_CONFIG.baseFee;
  const kmFee = Math.ceil(km) * PRICE_CONFIG.perKm;
  const minuteFee = Math.ceil(minutes) * PRICE_CONFIG.perMinute;
  const crossDistrictFee = isCrossDistrict ? PRICE_CONFIG.crossDistrictFee : 0;
  const urgentFee = urgent === "是" ? PRICE_CONFIG.urgentFee : 0;

  const deliveryFee =
    baseFee + kmFee + minuteFee + crossDistrictFee + urgentFee;

  const memberDiscount = PRICE_CONFIG.memberDiscount;
  const subtotal = Math.max(0, deliveryFee - memberDiscount);
  const tax = PRICE_CONFIG.tax;
  const total = subtotal + tax;

  return {
    deliveryFee,
    memberDiscount,
    subtotal,
    tax,
    total,
  };
}

function buildQuoteText(input, route, price) {
  return (
    "以下為本次預估費用：\n\n" +
    `取件地點：${input.pickupAddress}\n` +
    `送達地點：${input.dropoffAddress}\n` +
    `物品內容：${input.item}\n` +
    `是否急件：${input.urgent}\n` +
    `聯絡電話：${input.phone}\n\n` +
    `路線距離：約 ${route.distanceText}\n` +
    `行車時間：約 ${route.durationText}\n\n` +
    `配送費：${formatMoney(price.deliveryFee)}\n` +
    `會員折扣：-${formatMoney(price.memberDiscount)}\n` +
    `小計：${formatMoney(price.subtotal)}\n` +
    `稅金：${formatMoney(price.tax)}\n` +
    `總計：${formatMoney(price.total)}\n\n` +
    "📌 此為預估金額，實際報價仍以最終任務內容為準。"
  );
}

function buildTaskCreatedText(task) {
  return (
    "任務已建立成功 ✅\n\n" +
    `任務編號：${task.taskId}\n` +
    `${buildTaskSummary(task)}\n\n` +
    `預估總計：${formatMoney(task.price.total)}\n\n` +
    "好的！我們會持續為您安排騎手，一有騎手接單會第一時間通知您，感謝您的耐心等候"
  );
}

function buildGroupTaskText(task) {
  return (
    "【UBee 新任務通知】\n\n" +
    `任務編號：${task.taskId}\n` +
    `取件地點：${task.pickupAddress}\n` +
    `送達地點：${task.dropoffAddress}\n` +
    `物品內容：${task.item}\n` +
    `是否急件：${task.urgent}\n` +
    `聯絡電話：${task.phone}\n` +
    `距離：約 ${task.route.distanceText}\n` +
    `時間：約 ${task.route.durationText}\n` +
    `預估總計：${formatMoney(task.price.total)}\n\n` +
    `接單請輸入：接單 ${task.taskId}\n` +
    `完成送達請輸入：抵達 ${task.taskId}`
  );
}

async function finalizeQuote(replyToken, userId, session) {
  const input = { ...session.data };

  input.pickupAddress = normalizeTaichungAddress(input.pickupAddress);
  input.dropoffAddress = normalizeTaichungAddress(input.dropoffAddress);
  input.urgent = normalizeUrgentInput(input.urgent);

  const route = await getDistanceAndDuration(
    input.pickupAddress,
    input.dropoffAddress
  );

  const price = calculatePrice({
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    pickupAddress: input.pickupAddress,
    dropoffAddress: input.dropoffAddress,
    urgent: input.urgent,
  });

  clearFlow(userId);
  await replyText(replyToken, buildQuoteText(input, route, price));
}

async function finalizeCreate(replyToken, userId, session) {
  const input = { ...session.data };

  input.pickupAddress = normalizeTaichungAddress(input.pickupAddress);
  input.dropoffAddress = normalizeTaichungAddress(input.dropoffAddress);
  input.urgent = normalizeUrgentInput(input.urgent);

  const route = await getDistanceAndDuration(
    input.pickupAddress,
    input.dropoffAddress
  );

  const price = calculatePrice({
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    pickupAddress: input.pickupAddress,
    dropoffAddress: input.dropoffAddress,
    urgent: input.urgent,
  });

  const taskId = generateTaskId();

  const task = {
    taskId,
    userId,
    pickupAddress: input.pickupAddress,
    dropoffAddress: input.dropoffAddress,
    item: input.item,
    urgent: input.urgent,
    phone: input.phone,
    route,
    price,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  tasks.set(taskId, task);
  clearFlow(userId);

  await replyText(replyToken, buildTaskCreatedText(task));

  if (TARGET_GROUP_ID) {
    try {
      await pushText(TARGET_GROUP_ID, buildGroupTaskText(task));
    } catch (err) {
      console.error("推送群組失敗：", err.message);
    }
  }
}

async function handleGroupCommand(event, userText) {
  if (!event.source || event.source.type !== "group") return false;

  const replyToken = event.replyToken;
  const text = (userText || "").trim();

  const acceptMatch = text.match(/^接單\s+([A-Za-z0-9\-]+)$/);
  if (acceptMatch) {
    const taskId = acceptMatch[1];
    const task = tasks.get(taskId);

    if (!task) {
      await replyText(replyToken, "找不到此任務編號。");
      return true;
    }

    if (task.status !== "pending") {
      await replyText(replyToken, `此任務目前狀態為：${task.status}`);
      return true;
    }

    task.status = "accepted";
    task.acceptedAt = new Date().toISOString();

    await replyText(replyToken, `已成功接單 ✅\n任務編號：${taskId}`);

    try {
      await pushText(
        task.userId,
        `您好，您的任務 ${taskId} 已有騎手接單，我們會盡快為您處理。`
      );
    } catch (err) {
      console.error("通知客戶接單失敗：", err.message);
    }

    return true;
  }

  const arriveMatch = text.match(/^抵達\s+([A-Za-z0-9\-]+)$/);
  if (arriveMatch) {
    const taskId = arriveMatch[1];
    const task = tasks.get(taskId);

    if (!task) {
      await replyText(replyToken, "找不到此任務編號。");
      return true;
    }

    task.status = "completed";
    task.completedAt = new Date().toISOString();

    await replyText(replyToken, `已標記完成 ✅\n任務編號：${taskId}`);

    try {
      await pushText(task.userId, "騎手已抵達您的送達地點，本次任務已完成");
    } catch (err) {
      console.error("通知客戶完成失敗：", err.message);
    }

    return true;
  }

  return false;
}

async function handleUserText(event) {
  if (event.type !== "message") return;
  if (!event.message || event.message.type !== "text") return;

  const userText = (event.message.text || "").trim();
  const replyToken = event.replyToken;
  const userId = event.source && event.source.userId ? event.source.userId : "";
  const sourceType = event.source && event.source.type ? event.source.type : "";

  const groupHandled = await handleGroupCommand(event, userText);
  if (groupHandled) return;

  if (sourceType !== "user") return;

  if (userText === "取消") {
    clearFlow(userId);
    await replyTexts(replyToken, ["好的，已取消目前流程。", HELP_TEXT]);
    return;
  }

  if (userText === "1" || userText === "建立任務") {
    startFlow(userId, "create");
    await replyText(replyToken, buildAskText("create", 0));
    return;
  }

  if (userText === "2" || userText === "立即估價" || userText === "立即下單") {
    startFlow(userId, "quote");
    await replyText(replyToken, buildAskText("quote", 0));
    return;
  }

  const lower = userText.toLowerCase();
  if (["你好", "您好", "哈囉", "嗨", "hi", "hello"].includes(lower)) {
    clearFlow(userId);
    await replyText(replyToken, buildMainMenuText());
    return;
  }

  const session = userSessions.get(userId);

  if (!session) {
    await replyText(replyToken, buildMainMenuText());
    return;
  }

  const currentField = FLOW_FIELDS[session.stepIndex];
  let value = userText;

  if (currentField.key === "pickupAddress" || currentField.key === "dropoffAddress") {
    value = normalizeTaichungAddress(value);
  }

  if (currentField.key === "urgent") {
    value = normalizeUrgentInput(value);
    if (!isValidUrgentValue(value)) {
      await replyText(replyToken, "請輸入「是」或「否」。");
      return;
    }
  }

  session.data[currentField.key] = value;
  session.stepIndex += 1;
  userSessions.set(userId, session);

  if (session.stepIndex < FLOW_FIELDS.length) {
    await replyText(replyToken, buildAskText(session.mode, session.stepIndex));
    return;
  }

  try {
    if (session.mode === "quote") {
      await finalizeQuote(replyToken, userId, session);
      return;
    }

    if (session.mode === "create") {
      await finalizeCreate(replyToken, userId, session);
      return;
    }

    clearFlow(userId);
    await replyText(replyToken, buildMainMenuText());
  } catch (err) {
    console.error("流程完成錯誤：", err);

    clearFlow(userId);

    let msg = "系統忙碌中，請稍後再試一次。";

    if (
      err.message &&
      (err.message.includes("REQUEST_DENIED") ||
        err.message.includes("Google Maps API"))
    ) {
      msg =
        "目前無法取得 Google 地圖距離資料。\n請先確認 GOOGLE_MAPS_API_KEY 是否正確，並確認 Distance Matrix API 已啟用。";
    }

    await replyText(replyToken, msg);
  }
}

// ===== 路由 =====
app.get("/", (req, res) => {
  res.status(200).send("UBee bot running");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    time: new Date().toISOString(),
  });
});

app.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-line-signature"];

    const valid = isLineSignatureValid(
      CHANNEL_SECRET,
      req.rawBody,
      signature
    );

    if (!valid) {
      return res.status(401).send("Invalid signature");
    }

    const events = req.body.events || [];

    res.status(200).send("OK");

    for (const event of events) {
      try {
        await handleUserText(event);
      } catch (err) {
        console.error("單一事件處理失敗：", err);
      }
    }
  } catch (err) {
    console.error("Webhook 錯誤：", err);
    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  }
});

validateEnv();

app.listen(PORT, () => {
  console.log(`UBee bot running on port ${PORT}`);
});
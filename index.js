const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const PORT = Number(process.env.PORT) || 10000;

if (!CHANNEL_ACCESS_TOKEN || !TARGET_GROUP_ID || !GOOGLE_MAPS_API_KEY) {
  console.error("❌ 缺少必要環境變數");
  process.exit(1);
}

/* =========================
   暫存資料（初版）
========================= */
const userSessions = {};
const tasks = {};
let taskCounter = 1;

/**
 * 會員名單（先用 userId 暫存）
 * 之後可接 DB / Google Sheet
 */
const memberUsers = new Set();

/* =========================
   Session
========================= */
function getSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = {
      mode: null, // task / estimate
      waitingInput: false,
      cancelTaskId: null,
    };
  }
  return userSessions[userId];
}

function resetSession(userId) {
  delete userSessions[userId];
}

/* =========================
   工具
========================= */
function normalizeText(value = "") {
  return value.replace(/\s+/g, " ").trim();
}

function extractField(line, label) {
  const raw = line.trim();
  if (!raw.includes(label)) return null;

  if (raw.includes("：")) {
    const parts = raw.split("：");
    parts.shift();
    return parts.join("：").trim();
  }

  return raw.replace(label, "").trim();
}

function isMember(userId) {
  return memberUsers.has(userId);
}

function createTaskId() {
  const id = `UB${String(taskCounter).padStart(3, "0")}`;
  taskCounter += 1;
  return id;
}

function findAvailableTask() {
  return Object.values(tasks).find((task) => task.status === "待派單");
}

function findRiderTask(userId) {
  return Object.values(tasks).find(
    (task) =>
      (task.status === "已接單" || task.status === "已到取件地點") &&
      task.acceptedBy === userId
  );
}

function findLatestPendingTaskByCustomer(userId) {
  const customerTasks = Object.values(tasks)
    .filter(
      (task) =>
        task.customerUserId === userId &&
        task.status === "待派單"
    )
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return customerTasks[0] || null;
}

/* =========================
   Google Maps
========================= */
async function getDistanceAndDuration(origin, destination) {
  const url = "https://maps.googleapis.com/maps/api/distancematrix/json";

  const response = await axios.get(url, {
    params: {
      origins: origin,
      destinations: destination,
      key: GOOGLE_MAPS_API_KEY,
      language: "zh-TW",
      region: "tw",
      units: "metric",
      mode: "driving",
    },
    timeout: 15000,
  });

  const data = response.data;
  console.log("Google Maps response:", JSON.stringify(data, null, 2));

  if (!data || data.status !== "OK") {
    throw new Error(`Google Maps API 錯誤：${data?.status || "UNKNOWN"}`);
  }

  const element = data?.rows?.[0]?.elements?.[0];
  if (!element) {
    throw new Error("Google Maps 無法取得距離資料");
  }

  if (element.status !== "OK") {
    throw new Error(`Google Maps 距離計算失敗：${element.status}`);
  }

  return {
    distanceKm: Math.ceil(element.distance.value / 1000),
    durationMinutes: Math.ceil(element.duration.value / 60),
    distanceText: element.distance.text,
    durationText: element.duration.text,
  };
}

/* =========================
   計價
========================= */
function calculatePrice(km, minutes, urgent, isMemberUser) {
  const baseFee = 99;
  const distanceFee = km * 6;
  const timeFee = minutes * 3;
  const urgentFee = urgent ? 100 : 0;

  const rawDeliveryFee = baseFee + distanceFee + timeFee + urgentFee;
  const memberDiscount = isMemberUser ? 99 : 0;
  const deliveryFee = Math.max(rawDeliveryFee - memberDiscount, 0);
  const tax = 15;
  const total = deliveryFee + tax;

  // 騎手費用：基本費 + 公里費 + 時間費 + 急件60%
  const riderUrgentFee = urgent ? Math.round(100 * 0.6) : 0;
  const riderFee = baseFee + distanceFee + timeFee + riderUrgentFee;

  return {
    deliveryFee,
    memberDiscount,
    tax,
    total,
    riderFee,
  };
}

/* =========================
   解析：建立任務
========================= */
function parseTaskTemplate(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const data = {
    pickupAddress: "",
    pickupContact: "",
    deliveryAddress: "",
    deliveryContact: "",
    itemContent: "",
    isUrgentRaw: "",
    note: "",
  };

  for (const line of lines) {
    if (line.includes("取件地點")) {
      data.pickupAddress =
        extractField(line, "取件地點") ||
        extractField(line, "取件地點：") ||
        data.pickupAddress;
    } else if (line.includes("取件電話")) {
      data.pickupContact =
        extractField(line, "取件電話") ||
        extractField(line, "取件電話：") ||
        data.pickupContact;
    } else if (line.includes("送達地點")) {
      data.deliveryAddress =
        extractField(line, "送達地點") ||
        extractField(line, "送達地點：") ||
        data.deliveryAddress;
    } else if (line.includes("送達電話")) {
      data.deliveryContact =
        extractField(line, "送達電話") ||
        extractField(line, "送達電話：") ||
        data.deliveryContact;
    } else if (line.includes("物品內容")) {
      data.itemContent =
        extractField(line, "物品內容") ||
        extractField(line, "物品內容：") ||
        data.itemContent;
    } else if (line.includes("是否急件")) {
      data.isUrgentRaw =
        extractField(line, "是否急件") ||
        extractField(line, "是否急件：") ||
        data.isUrgentRaw;
    } else if (line.includes("備註")) {
      data.note =
        extractField(line, "備註") ||
        extractField(line, "備註：") ||
        data.note;
    }
  }

  const urgentSource = `${data.isUrgentRaw} ${data.note}`;
  const isUrgent =
    urgentSource.includes("是") ||
    urgentSource.includes("急件") ||
    (urgentSource.includes("急") && !urgentSource.includes("不急"));

  return {
    pickupAddress: normalizeText(data.pickupAddress),
    pickupContact: normalizeText(data.pickupContact),
    deliveryAddress: normalizeText(data.deliveryAddress),
    deliveryContact: normalizeText(data.deliveryContact),
    itemContent: normalizeText(data.itemContent),
    isUrgent,
    note: normalizeText(data.note),
  };
}

/* =========================
   解析：立即估價
========================= */
function parseEstimateTemplate(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const data = {
    pickupAddress: "",
    deliveryAddress: "",
    itemContent: "",
    isUrgentRaw: "",
  };

  for (const line of lines) {
    if (line.includes("取件地點")) {
      data.pickupAddress =
        extractField(line, "取件地點") ||
        extractField(line, "取件地點：") ||
        data.pickupAddress;
    } else if (line.includes("送達地點")) {
      data.deliveryAddress =
        extractField(line, "送達地點") ||
        extractField(line, "送達地點：") ||
        data.deliveryAddress;
    } else if (line.includes("物品內容")) {
      data.itemContent =
        extractField(line, "物品內容") ||
        extractField(line, "物品內容：") ||
        data.itemContent;
    } else if (line.includes("是否急件")) {
      data.isUrgentRaw =
        extractField(line, "是否急件") ||
        extractField(line, "是否急件：") ||
        data.isUrgentRaw;
    }
  }

  const isUrgent =
    data.isUrgentRaw.includes("是") ||
    data.isUrgentRaw.includes("急件") ||
    (data.isUrgentRaw.includes("急") && !data.isUrgentRaw.includes("不急"));

  return {
    pickupAddress: normalizeText(data.pickupAddress),
    deliveryAddress: normalizeText(data.deliveryAddress),
    itemContent: normalizeText(data.itemContent),
    isUrgent,
  };
}

/* =========================
   驗證
========================= */
function validateTaskData(data) {
  if (!data.pickupAddress) return "請填寫取件地點";
  if (!data.pickupContact) return "請填寫取件電話";
  if (!data.deliveryAddress) return "請填寫送達地點";
  if (!data.deliveryContact) return "請填寫送達電話";
  if (!data.itemContent) return "請填寫物品內容";
  return null;
}

function validateEstimateData(data) {
  if (!data.pickupAddress) return "請填寫取件地點";
  if (!data.deliveryAddress) return "請填寫送達地點";
  if (!data.itemContent) return "請填寫物品內容";
  return null;
}

/* =========================
   訊息模板
========================= */
function getTaskTemplateText() {
  return [
    "請依格式填寫：",
    "",
    "取件地點：",
    "取件電話：",
    "",
    "送達地點：",
    "送達電話：",
    "",
    "物品內容：",
    "",
    "是否急件：",
    "",
    "備註：",
  ].join("\n");
}

function getEstimateTemplateText() {
  return [
    "您可以先快速取得任務費用估算。",
    "",
    "請提供：",
    "",
    "取件地點：",
    "送達地點：",
    "物品內容：",
    "是否急件：",
    "",
    "—————————",
    "",
    "📌 我們將為您即時計算預估費用（非最終報價）",
  ].join("\n");
}

function getTaskTemplateErrorText() {
  return [
    "您好，您尚未填寫完整資料。",
    "",
    "請依格式填寫：",
    "",
    "取件地點：",
    "取件電話：",
    "",
    "送達地點：",
    "送達電話：",
    "",
    "物品內容：",
    "",
    "是否急件：",
    "",
    "備註：",
  ].join("\n");
}

function getEstimateTemplateErrorText() {
  return [
    "您好，您尚未填寫完整估價資料。",
    "",
    "請提供：",
    "",
    "取件地點：",
    "送達地點：",
    "物品內容：",
    "是否急件：",
    "",
    "—————————",
    "",
    "📌 我們將為您即時計算預估費用（非最終報價）",
  ].join("\n");
}

function buildTaskCustomerReplyText(task) {
  return [
    `配送費：$${task.price.deliveryFee}`,
    `稅金：$${task.price.tax}`,
    `總計：$${task.price.total}`,
    "",
    "任務已建立，我們將盡快為您安排。",
  ].join("\n");
}

function buildEstimateOnlyText(price) {
  return [
    `配送費：$${price.deliveryFee}`,
    `稅金：$${price.tax}`,
    `總計：$${price.total}`,
    "",
    "此為預估費用，非最終報價",
  ].join("\n");
}

function buildGroupTaskText(task) {
  return [
    `費用：$${task.price.riderFee}`,
    `距離：${task.distanceText}`,
    "",
    `取件地點：${task.pickupAddress}`,
    `送達地點：${task.deliveryAddress}`,
    `物品內容：${task.itemContent}`,
    `是否急件：${task.isUrgent ? "是" : "否"}`,
  ].join("\n");
}

function getCancelPromptText() {
  return [
    "系統提醒：",
    "",
    "目前尚未派單，可協助您取消或調整需求",
    "",
    "請問您要：",
    "1️⃣ 繼續等待 UBee 騎手",
    "2️⃣ 取消本次任務（不收費）",
  ].join("\n");
}

/* =========================
   LINE API
========================= */
async function replyMessage(replyToken, text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
      timeout: 15000,
    }
  );
}

async function pushToGroup(text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: TARGET_GROUP_ID,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
      timeout: 15000,
    }
  );
}

async function pushToUser(userId, text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: userId,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
      timeout: 15000,
    }
  );
}

/* =========================
   Health Check
========================= */
app.get("/", (req, res) => {
  res.status(200).send("UBee bot running");
});

/* =========================
   Webhook
========================= */
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      try {
        if (event.type !== "message") continue;
        if (event.message?.type !== "text") continue;

        const userText = (event.message.text || "").trim();
        const replyToken = event.replyToken;
        const userId = event.source?.userId;

        if (!replyToken || !userId) continue;

        const session = getSession(userId);

        console.log("收到訊息：", userText);
        console.log("目前session：", session);

        /* ===== 主選單 ===== */
        if (["你好", "嗨", "哈囉", "開始", "選單"].includes(userText)) {
          await replyMessage(
            replyToken,
            [
              "您好，這裡是 UBee 城市任務。",
              "",
              "請輸入以下功能：",
              "1. 建立任務",
              "2. 立即估價",
              "",
              "會員開通請輸入：加入會員",
              "若要取消目前流程，請輸入：取消",
            ].join("\n")
          );
          continue;
        }

        /* ===== 加入會員 ===== */
        if (userText === "加入會員") {
          memberUsers.add(userId);
          await replyMessage(
            replyToken,
            "已為您開通會員 ✅\n之後建立任務或立即估價，將自動折抵 $99。"
          );
          continue;
        }

        /* ===== 客人取消流程 ===== */
        if (userText === "取消") {
          // 1) 先取消正在填寫中的流程
          if (session.waitingInput) {
            resetSession(userId);
            await replyMessage(replyToken, "已取消目前流程。");
            continue;
          }

          // 2) 找最後一筆待派單任務
          const pendingTask = findLatestPendingTaskByCustomer(userId);
          if (pendingTask) {
            session.cancelTaskId = pendingTask.taskId;
            await replyMessage(replyToken, getCancelPromptText());
            continue;
          }

          await replyMessage(replyToken, "目前沒有可取消的任務。");
          continue;
        }

        /* ===== 客人取消選項：1 ===== */
        if (userText === "1" && session.cancelTaskId) {
          const task = tasks[session.cancelTaskId];
          session.cancelTaskId = null;

          if (task && task.status === "待派單") {
            await replyMessage(
              replyToken,
              "好的！我們會持續為您安排騎手，一有騎手接單會第一時間通知您，感謝您的耐心等候"
            );
            continue;
          }

          await replyMessage(replyToken, "目前此任務狀態已變更，無法繼續等待。");
          continue;
        }

        /* ===== 客人取消選項：2 ===== */
        if (userText === "2" && session.cancelTaskId) {
          const task = tasks[session.cancelTaskId];
          session.cancelTaskId = null;

          if (task && task.status === "待派單") {
            task.status = "已取消";
            await replyMessage(
              replyToken,
              "好的，已為您取消本次任務，因目前尚未派單，本次退款費用給您，若之後還有需要，歡迎再找 UBee城市任務跑腿"
            );
            continue;
          }

          await replyMessage(replyToken, "目前此任務狀態已變更，無法取消。");
          continue;
        }

        /* ===== 建立任務 ===== */
        if (userText === "建立任務") {
          session.mode = "task";
          session.waitingInput = true;
          session.cancelTaskId = null;
          await replyMessage(replyToken, getTaskTemplateText());
          continue;
        }

        /* ===== 立即估價 ===== */
        if (userText === "立即估價") {
          session.mode = "estimate";
          session.waitingInput = true;
          session.cancelTaskId = null;
          await replyMessage(replyToken, getEstimateTemplateText());
          continue;
        }

        /* ===== 群組：接 / 接單 ===== */
        if (userText === "接" || userText === "接單") {
          const task = findAvailableTask();

          if (!task) {
            await replyMessage(replyToken, "目前沒有可接任務");
            continue;
          }

          task.status = "已接單";
          task.acceptedBy = userId;

          await replyMessage(replyToken, "已接單");

          await pushToUser(
            task.customerUserId,
            "已有騎手接單，司機正為您處理中。"
          );
          continue;
        }

        /* ===== 群組：到 ===== */
        if (userText === "到") {
          const task = findRiderTask(userId);

          if (!task) {
            await replyMessage(replyToken, "目前沒有進行中的任務");
            continue;
          }

          task.status = "已到取件地點";

          await replyMessage(replyToken, "已到取件地點");

          await pushToUser(
            task.customerUserId,
            "已經抵達您的取件地點"
          );
          continue;
        }

        /* ===== 群組：抵達 ===== */
        if (userText === "抵達") {
          const task = findRiderTask(userId);

          if (!task) {
            await replyMessage(replyToken, "目前沒有進行中的任務");
            continue;
          }

          task.status = "已完成";

          await replyMessage(replyToken, "任務已完成");

          await pushToUser(
            task.customerUserId,
            "騎手已抵達您的送達地點，本次任務已完成"
          );
          continue;
        }

        /* ===== 建立任務：客人貼表單後直接派單 ===== */
        if (session.waitingInput && session.mode === "task") {
          const taskData = parseTaskTemplate(userText);
          console.log("建立任務解析結果：", taskData);

          const validationError = validateTaskData(taskData);
          if (validationError) {
            await replyMessage(replyToken, getTaskTemplateErrorText());
            continue;
          }

          const mapResult = await getDistanceAndDuration(
            taskData.pickupAddress,
            taskData.deliveryAddress
          );

          const price = calculatePrice(
            mapResult.distanceKm,
            mapResult.durationMinutes,
            taskData.isUrgent,
            isMember(userId)
          );

          const taskId = createTaskId();

          const task = {
            taskId,
            customerUserId: userId,
            pickupAddress: taskData.pickupAddress,
            pickupContact: taskData.pickupContact,
            deliveryAddress: taskData.deliveryAddress,
            deliveryContact: taskData.deliveryContact,
            itemContent: taskData.itemContent,
            isUrgent: taskData.isUrgent,
            note: taskData.note,
            distanceText: mapResult.distanceText,
            durationText: mapResult.durationText,
            price,
            status: "待派單",
            acceptedBy: null,
            createdAt: new Date().toISOString(),
          };

          tasks[taskId] = task;

          await pushToGroup(buildGroupTaskText(task));
          await replyMessage(replyToken, buildTaskCustomerReplyText(task));

          resetSession(userId);
          continue;
        }

        /* ===== 立即估價：只回估價，不派單 ===== */
        if (session.waitingInput && session.mode === "estimate") {
          const estimateData = parseEstimateTemplate(userText);
          console.log("立即估價解析結果：", estimateData);

          const validationError = validateEstimateData(estimateData);
          if (validationError) {
            await replyMessage(replyToken, getEstimateTemplateErrorText());
            continue;
          }

          let mapResult;
          try {
            mapResult = await getDistanceAndDuration(
              estimateData.pickupAddress,
              estimateData.deliveryAddress
            );
          } catch (error) {
            await replyMessage(
              replyToken,
              `立即估價失敗：${error.message}\n\n請確認地址是否完整，例如「台中市＋行政區＋路名門牌」。`
            );
            resetSession(userId);
            continue;
          }

          const price = calculatePrice(
            mapResult.distanceKm,
            mapResult.durationMinutes,
            estimateData.isUrgent,
            isMember(userId)
          );

          await replyMessage(replyToken, buildEstimateOnlyText(price));

          resetSession(userId);
          continue;
        }

        await replyMessage(
          replyToken,
          [
            "請輸入以下功能：",
            "1. 建立任務",
            "2. 立即估價",
            "",
            "會員開通請輸入：加入會員",
          ].join("\n")
        );
      } catch (eventError) {
        console.error("單筆事件處理失敗：", eventError);
        try {
          if (event.replyToken) {
            await replyMessage(
              event.replyToken,
              "系統錯誤：" + (eventError.message || "未知錯誤")
            );
          }
        } catch (replyError) {
          console.error("錯誤回覆失敗：", replyError?.response?.data || replyError.message);
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook 錯誤：", error?.response?.data || error.message);
    res.sendStatus(500);
  }
});

/* =========================
   啟動
========================= */
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`UBee bot running on port ${PORT}`);
});

server.on("error", (err) => {
  console.error("Server 啟動錯誤：", err);
});

process.on("unhandledRejection", (err) => {
  console.error("未處理 Promise 錯誤：", err);
});

process.on("uncaughtException", (err) => {
  console.error("未捕捉例外：", err);
});
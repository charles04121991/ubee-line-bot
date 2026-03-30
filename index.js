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
  console.error(
    "缺少必要環境變數：CHANNEL_ACCESS_TOKEN / TARGET_GROUP_ID / GOOGLE_MAPS_API_KEY"
  );
  process.exit(1);
}

/* =========================
   暫存 session
========================= */
const userSessions = {};

/* =========================
   費率設定
========================= */
const CUSTOMER_PRICING = {
  baseFee: 99,
  perKm: 6,
  perMinute: 3,
  urgentFee: 100,
  tax: 15,
};

const RIDER_PRICING = {
  urgentShareRate: 0.6,
};

/* =========================
   Session 工具
========================= */
function getSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = {
      mode: null, // task / estimate
      waitingInput: false,
    };
  }
  return userSessions[userId];
}

function resetSession(userId) {
  delete userSessions[userId];
}

/* =========================
   文字工具
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
function calculateCustomerPrice({ km, minutes, urgent }) {
  const deliveryFee =
    CUSTOMER_PRICING.baseFee +
    km * CUSTOMER_PRICING.perKm +
    minutes * CUSTOMER_PRICING.perMinute +
    (urgent ? CUSTOMER_PRICING.urgentFee : 0);

  const subtotal = deliveryFee;
  const total = subtotal + CUSTOMER_PRICING.tax;

  return {
    deliveryFee,
    tax: CUSTOMER_PRICING.tax,
    total,
  };
}

function calculateRiderPrice({ km, minutes, urgent }) {
  const urgentShare = urgent
    ? Math.round(CUSTOMER_PRICING.urgentFee * RIDER_PRICING.urgentShareRate)
    : 0;

  const riderTotal =
    CUSTOMER_PRICING.baseFee +
    km * CUSTOMER_PRICING.perKm +
    minutes * CUSTOMER_PRICING.perMinute +
    urgentShare;

  return {
    riderTotal,
  };
}

/* =========================
   建立任務解析
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
    } else if (line.includes("取件人")) {
      data.pickupContact =
        extractField(line, "取件人 / 電話") ||
        extractField(line, "取件人/電話") ||
        extractField(line, "取件人") ||
        data.pickupContact;
    } else if (line.includes("送達地點")) {
      data.deliveryAddress =
        extractField(line, "送達地點") ||
        extractField(line, "送達地點：") ||
        data.deliveryAddress;
    } else if (line.includes("收件人")) {
      data.deliveryContact =
        extractField(line, "收件人 / 電話") ||
        extractField(line, "收件人/電話") ||
        extractField(line, "收件人") ||
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
   立即估價解析
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
  if (!data.pickupContact) return "請填寫取件人 / 電話";
  if (!data.deliveryAddress) return "請填寫送達地點";
  if (!data.deliveryContact) return "請填寫收件人 / 電話";
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
    "請依下列格式填寫並整段回傳：",
    "",
    "取件地點：",
    "取件人 / 電話：",
    "",
    "送達地點：",
    "收件人 / 電話：",
    "",
    "物品內容：",
    "",
    "是否急件：",
    "",
    "備註：",
    "",
    "※ 不配送食品、違禁品或危險物品，若為急件請於備註註明「急件」",
  ].join("\n");
}

function getEstimateTemplateText() {
  return [
    "您可以先快速取得任務費用估算，請提供：",
    "",
    "取件地點：",
    "送達地點：",
    "物品內容：",
    "是否急件：",
    "",
    "———",
    "",
    "📌 我們將為您即時計算預估費用（非最終報價）",
  ].join("\n");
}

function getTaskTemplateErrorText() {
  return [
    "您好，您尚未填寫完整資料。",
    "",
    "請依下列格式填寫並整段回傳：",
    "",
    "取件地點：",
    "取件人 / 電話：",
    "",
    "送達地點：",
    "收件人 / 電話：",
    "",
    "物品內容：",
    "",
    "是否急件：",
    "",
    "備註：",
    "",
    "※ 不配送食品、違禁品或危險物品，若為急件請於備註註明「急件」",
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
    "———",
    "",
    "📌 我們將為您即時計算預估費用（非最終報價）",
  ].join("\n");
}

function buildTaskCustomerReplyText(quote) {
  return [
    "【UBee 任務報價】",
    `取件地點：${quote.pickupAddress}`,
    `送達地點：${quote.deliveryAddress}`,
    `物品內容：${quote.itemContent}`,
    `是否急件：${quote.isUrgent ? "急件" : "一般"}`,
    "",
    `配送費：$${quote.customerPrice.deliveryFee}`,
    `稅金：$${quote.customerPrice.tax}`,
    `總計：$${quote.customerPrice.total}`,
    "",
    "任務已建立，我們將盡快為您安排。",
  ].join("\n");
}

function buildEstimateOnlyText(quote) {
  return [
    "【UBee 即時估價】",
    `取件地點：${quote.pickupAddress}`,
    `送達地點：${quote.deliveryAddress}`,
    `物品內容：${quote.itemContent}`,
    `是否急件：${quote.isUrgent ? "急件" : "一般"}`,
    "",
    `預估配送費：$${quote.customerPrice.deliveryFee}`,
    `稅金：$${quote.customerPrice.tax}`,
    `預估總計：$${quote.customerPrice.total}`,
    "",
    "📌 此為預估費用，非最終報價",
  ].join("\n");
}

function buildGroupTaskText(quote, userId) {
  return [
    "【UBee 新任務通知】",
    "",
    `費用：$${quote.riderPrice.riderTotal}`,
    "",
    `距離：${quote.distanceText}（${quote.durationText}）`,
    "",
    `客戶ID：${userId}`,
    "",
    `取件：${quote.pickupAddress}`,
    `取件人 / 電話：${quote.pickupContact || "未提供"}`,
    "",
    `送達：${quote.deliveryAddress}`,
    `收件人 / 電話：${quote.deliveryContact || "未提供"}`,
    "",
    `物品：${quote.itemContent}`,
    `急件：${quote.isUrgent ? "是" : "否"}`,
    `備註：${quote.note || "無"}`,
    "",
    "———",
  ].join("\n");
}

/* =========================
   LINE API
========================= */
async function replyMessage(replyToken, text) {
  try {
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
  } catch (error) {
    console.error("❌ LINE回覆錯誤：", error.response?.data || error.message);
    throw error;
  }
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
              "若要取消目前流程，請輸入：取消",
            ].join("\n")
          );
          continue;
        }

        if (userText === "取消" || userText === "重新開始") {
          resetSession(userId);
          await replyMessage(
            replyToken,
            [
              "已取消目前流程。",
              "",
              "請重新輸入：",
              "1. 建立任務",
              "2. 立即估價",
            ].join("\n")
          );
          continue;
        }

        if (userText === "建立任務") {
          const current = getSession(userId);
          current.mode = "task";
          current.waitingInput = true;

          await replyMessage(replyToken, getTaskTemplateText());
          continue;
        }

        if (userText === "立即估價") {
          const current = getSession(userId);
          current.mode = "estimate";
          current.waitingInput = true;

          await replyMessage(replyToken, getEstimateTemplateText());
          continue;
        }

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

          const customerPrice = calculateCustomerPrice({
            km: mapResult.distanceKm,
            minutes: mapResult.durationMinutes,
            urgent: taskData.isUrgent,
          });

          const riderPrice = calculateRiderPrice({
            km: mapResult.distanceKm,
            minutes: mapResult.durationMinutes,
            urgent: taskData.isUrgent,
          });

          const quote = {
            ...taskData,
            customerPrice,
            riderPrice,
            distanceText: mapResult.distanceText,
            durationText: mapResult.durationText,
          };

          const groupText = buildGroupTaskText(quote, userId);
          await pushToGroup(groupText);

          await replyMessage(replyToken, buildTaskCustomerReplyText(quote));

          resetSession(userId);
          continue;
        }

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
            console.error("立即估價 Google Maps 錯誤：", error.message);
            await replyMessage(
              replyToken,
              `立即估價失敗：${error.message}\n\n請確認地址是否完整，例如「台中市＋行政區＋路名門牌」。`
            );
            resetSession(userId);
            continue;
          }

          const customerPrice = calculateCustomerPrice({
            km: mapResult.distanceKm,
            minutes: mapResult.durationMinutes,
            urgent: estimateData.isUrgent,
          });

          const riderPrice = calculateRiderPrice({
            km: mapResult.distanceKm,
            minutes: mapResult.durationMinutes,
            urgent: estimateData.isUrgent,
          });

          const quote = {
            ...estimateData,
            note: "",
            pickupContact: "",
            deliveryContact: "",
            customerPrice,
            riderPrice,
            distanceText: mapResult.distanceText,
            durationText: mapResult.durationText,
          };

          await replyMessage(replyToken, buildEstimateOnlyText(quote));

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
            "若要取消目前流程，請輸入：取消",
          ].join("\n")
        );
      } catch (eventError) {
        console.error("🔥單筆事件處理失敗：", eventError);

        try {
          if (event.replyToken) {
            await replyMessage(
              event.replyToken,
              "系統錯誤：" + (eventError.message || JSON.stringify(eventError))
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
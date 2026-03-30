const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const PORT = process.env.PORT || 3000;

if (!CHANNEL_ACCESS_TOKEN || !TARGET_GROUP_ID || !GOOGLE_MAPS_API_KEY) {
  console.error("缺少必要環境變數：CHANNEL_ACCESS_TOKEN / TARGET_GROUP_ID / GOOGLE_MAPS_API_KEY");
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
   工具
========================= */
function getSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = {
      mode: null, // task / estimate
      waitingInput: false,
      quote: null,
      readyToConfirm: false,
    };
  }
  return userSessions[userId];
}

function resetSession(userId) {
  delete userSessions[userId];
}

function normalizeText(value = "") {
  return value.replace(/\s+/g, " ").trim();
}

function normalizePhone(value = "") {
  return value.replace(/\s+/g, "").trim();
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
    memberDiscount: 0,
    subtotal,
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
    urgentSource.includes("急");

  return {
    pickupAddress: normalizeText(data.pickupAddress),
    pickupContact: normalizePhone(data.pickupContact),
    deliveryAddress: normalizeText(data.deliveryAddress),
    deliveryContact: normalizePhone(data.deliveryContact),
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
    data.isUrgentRaw.includes("是") || data.isUrgentRaw.includes("急");

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
    "📌 我們將為您即時計算預估費用（非最終報價）",
  ].join("\n");
}

function buildCustomerQuoteText(quote) {
  return [
    "【UBee 預估報價】",
    `取件地點：${quote.pickupAddress}`,
    `送達地點：${quote.deliveryAddress}`,
    `物品內容：${quote.itemContent}`,
    `是否急件：${quote.isUrgent ? "是" : "否"}`,
    "",
    `配送費：$${quote.customerPrice.deliveryFee}`,
    `會員折扣：-$${quote.customerPrice.memberDiscount}`,
    `小計：$${quote.customerPrice.subtotal}`,
    `稅金：$${quote.customerPrice.tax}`,
    `客人總計：$${quote.customerPrice.total}`,
    "",
    "如確認送出，請回覆：確認送出",
    "如需取消，請回覆：取消",
  ].join("\n");
}

function buildEstimateOnlyText(quote) {
  return [
    "【UBee 即時估價】",
    `取件地點：${quote.pickupAddress}`,
    `送達地點：${quote.deliveryAddress}`,
    `物品內容：${quote.itemContent}`,
    `是否急件：${quote.isUrgent ? "是" : "否"}`,
    "",
    `配送費：$${quote.customerPrice.deliveryFee}`,
    `會員折扣：-$${quote.customerPrice.memberDiscount}`,
    `小計：$${quote.customerPrice.subtotal}`,
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

/* =========================
   路由
========================= */
app.get("/", (req, res) => {
  res.status(200).send("UBee bot running");
});

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

        console.log("收到訊息：", userText);

        const session = getSession(userId);

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
          current.quote = null;
          current.readyToConfirm = false;

          await replyMessage(replyToken, getTaskTemplateText());
          continue;
        }

        if (userText === "立即估價") {
          const current = getSession(userId);
          current.mode = "estimate";
          current.waitingInput = true;
          current.quote = null;
          current.readyToConfirm = false;

          await replyMessage(replyToken, getEstimateTemplateText());
          continue;
        }

        if (userText === "確認送出") {
          if (!session.readyToConfirm || !session.quote || session.mode !== "task") {
            await replyMessage(replyToken, "目前沒有可送出的任務，請先輸入：建立任務");
            continue;
          }

          const groupText = buildGroupTaskText(session.quote, userId);
          await pushToGroup(groupText);

          await replyMessage(
            replyToken,
            [
              "您的任務已成功送出 ✅",
              `本次總計：$${session.quote.customerPrice.total}`,
              "",
              "我們會盡快為您安排。",
            ].join("\n")
          );

          resetSession(userId);
          continue;
        }

        if (session.waitingInput && session.mode === "task") {
          const taskData = parseTaskTemplate(userText);
          console.log("建立任務解析結果：", taskData);

          const validationError = validateTaskData(taskData);
          if (validationError) {
            await replyMessage(
              replyToken,
              `${validationError}\n\n請重新依格式填寫：\n\n${getTaskTemplateText()}`
            );
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

          session.quote = {
            ...taskData,
            customerPrice,
            riderPrice,
            distanceText: mapResult.distanceText,
            durationText: mapResult.durationText,
          };

          session.waitingInput = false;
          session.readyToConfirm = true;

          await replyMessage(replyToken, buildCustomerQuoteText(session.quote));
          continue;
        }

        if (session.waitingInput && session.mode === "estimate") {
          const estimateData = parseEstimateTemplate(userText);
          console.log("立即估價解析結果：", estimateData);

          const validationError = validateEstimateData(estimateData);
          if (validationError) {
            await replyMessage(
              replyToken,
              `${validationError}\n\n請重新依格式填寫：\n\n${getEstimateTemplateText()}`
            );
            continue;
          }

          const mapResult = await getDistanceAndDuration(
            estimateData.pickupAddress,
            estimateData.deliveryAddress
          );

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

          resetSession(userId);
          await replyMessage(replyToken, buildEstimateOnlyText(quote));
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
        console.error("單筆事件處理失敗：", eventError?.response?.data || eventError.message);

        try {
          if (event.replyToken) {
            await replyMessage(
              event.replyToken,
              `系統處理失敗：${eventError.message || "未知錯誤"}`
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

app.listen(PORT, () => {
  console.log(`UBee bot running on port ${PORT}`);
});
"use strict";

const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

const PORT = process.env.PORT || 3000;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ====== 可調整費率 ======
const BASE_FEE = Number(process.env.BASE_FEE || 99);        // 基本費
const PER_KM_FEE = Number(process.env.PER_KM_FEE || 6);     // 每公里
const PER_MIN_FEE = Number(process.env.PER_MIN_FEE || 3);   // 每分鐘
const URGENT_FEE = Number(process.env.URGENT_FEE || 100);   // 急件加價
const TAX_RATE = Number(process.env.TAX_RATE || 0.05);      // 稅率 5%

// ====== 表單文字 ======
const createTaskFormText = `請直接依下列表單填寫並送出：

取件地點：
取件電話：

送達地點：
送達電話：

物品內容：
是否急件：
備註：`;

const instantQuoteFormText = `請直接依下列格式填寫並送出：

取件地點：
送達地點：
物品內容：
是否急件：`;

// ====== 工具函式 ======
function getValue(text, label) {
  const regex = new RegExp(`${label}：\\s*(.*)`);
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

function normalizeUrgentText(value) {
  const raw = (value || "").trim();

  if (["是", "急件", "需要", "yes", "Yes", "YES"].includes(raw)) {
    return "急件";
  }

  if (["否", "一般", "不需要", "no", "No", "NO"].includes(raw)) {
    return "一般";
  }

  return raw || "一般";
}

function isCreateTaskForm(text) {
  return (
    text.includes("取件地點：") &&
    text.includes("取件電話：") &&
    text.includes("送達地點：") &&
    text.includes("送達電話：") &&
    text.includes("物品內容：") &&
    text.includes("是否急件：")
  );
}

function isInstantQuoteForm(text) {
  return (
    text.includes("取件地點：") &&
    !text.includes("取件電話：") &&
    text.includes("送達地點：") &&
    text.includes("物品內容：") &&
    text.includes("是否急件：")
  );
}

function parseCreateTaskForm(text) {
  return {
    pickupAddress: getValue(text, "取件地點"),
    pickupPhone: getValue(text, "取件電話"),
    deliveryAddress: getValue(text, "送達地點"),
    deliveryPhone: getValue(text, "送達電話"),
    item: getValue(text, "物品內容"),
    urgent: normalizeUrgentText(getValue(text, "是否急件")),
    note: getValue(text, "備註"),
  };
}

function parseInstantQuoteForm(text) {
  return {
    pickupAddress: getValue(text, "取件地點"),
    deliveryAddress: getValue(text, "送達地點"),
    item: getValue(text, "物品內容"),
    urgent: normalizeUrgentText(getValue(text, "是否急件")),
  };
}

function validateCreateTaskForm(form) {
  if (!form.pickupAddress) return "請填寫取件地點";
  if (!form.pickupPhone) return "請填寫取件電話";
  if (!form.deliveryAddress) return "請填寫送達地點";
  if (!form.deliveryPhone) return "請填寫送達電話";
  if (!form.item) return "請填寫物品內容";
  if (!form.urgent) return "請填寫是否急件";
  return null;
}

function validateInstantQuoteForm(form) {
  if (!form.pickupAddress) return "請填寫取件地點";
  if (!form.deliveryAddress) return "請填寫送達地點";
  if (!form.item) return "請填寫物品內容";
  if (!form.urgent) return "請填寫是否急件";
  return null;
}

async function replyText(replyToken, text) {
  await client.replyMessage(replyToken, {
    type: "text",
    text,
  });
}

async function getDistanceAndTime(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error("未設定 GOOGLE_MAPS_API_KEY");
  }

  const url = "https://maps.googleapis.com/maps/api/distancematrix/json";

  const response = await axios.get(url, {
    params: {
      origins: origin,
      destinations: destination,
      key: GOOGLE_MAPS_API_KEY,
      language: "zh-TW",
      region: "tw",
      mode: "driving",
    },
  });

  const data = response.data;

  if (!data || data.status !== "OK") {
    throw new Error(`Google Maps API 錯誤：${data?.status || "未知錯誤"}`);
  }

  const row = data.rows && data.rows[0];
  const element = row && row.elements && row.elements[0];

  if (!element || element.status !== "OK") {
    throw new Error(`無法取得距離資料：${element?.status || "未知錯誤"}`);
  }

  const distanceKm = element.distance.value / 1000;
  const durationMin = element.duration.value / 60;

  return {
    distanceKm,
    durationMin,
    distanceText: element.distance.text,
    durationText: element.duration.text,
  };
}

function calculateFee({ distanceKm, durationMin, urgent }) {
  let fee = BASE_FEE + distanceKm * PER_KM_FEE + durationMin * PER_MIN_FEE;

  if (urgent === "急件") {
    fee += URGENT_FEE;
  }

  fee = Math.round(fee);

  const tax = Math.round(fee * TAX_RATE);
  const total = fee + tax;

  return {
    fee,
    tax,
    total,
  };
}

function formatDispatchMessage(task) {
  return `【UBee 新任務派單】

費用：$${task.fee}
距離：${task.distanceText}
取件地點：${task.pickupAddress}
取件電話：${task.pickupPhone}
送達地點：${task.deliveryAddress}
送達電話：${task.deliveryPhone}
物品內容：${task.item}
是否急件：${task.urgent}`;
}

function formatQuoteMessage(quote) {
  return `取件地點：${quote.pickupAddress}
送達地點：${quote.deliveryAddress}
物品內容：${quote.item}
是否急件：${quote.urgent}

費用：$${quote.fee}
稅金：$${quote.tax}
總計：$${quote.total}`;
}

// ====== 建立任務 ======
async function handleCreateTask(event, userText) {
  const form = parseCreateTaskForm(userText);
  const error = validateCreateTaskForm(form);

  if (error) {
    await replyText(
      event.replyToken,
      `${error}\n\n請重新依格式填寫：\n\n${createTaskFormText}`
    );
    return;
  }

  try {
    const mapData = await getDistanceAndTime(
      form.pickupAddress,
      form.deliveryAddress
    );

    const pricing = calculateFee({
      distanceKm: mapData.distanceKm,
      durationMin: mapData.durationMin,
      urgent: form.urgent,
    });

    const task = {
      ...form,
      fee: pricing.fee,
      tax: pricing.tax,
      total: pricing.total,
      distanceText: mapData.distanceText,
      durationText: mapData.durationText,
    };

    await replyText(
      event.replyToken,
      "您的任務已建立成功，我們會立即為您派單。"
    );

    if (!LINE_GROUP_ID) {
      console.error("LINE_GROUP_ID 未設定，無法推送群組訊息");
      return;
    }

    console.log("準備推送到群組，LINE_GROUP_ID =", LINE_GROUP_ID);

    await client.pushMessage(LINE_GROUP_ID, {
      type: "text",
      text: formatDispatchMessage(task),
    });

    console.log("pushMessage 成功");
  } catch (err) {
    console.error("handleCreateTask 失敗：", err?.response?.data || err.message || err);

    await replyText(
      event.replyToken,
      "任務建立失敗，請稍後再試，或確認地址是否填寫完整。"
    );
  }
}

// ====== 立即估價 ======
async function handleInstantQuote(event, userText) {
  const form = parseInstantQuoteForm(userText);
  const error = validateInstantQuoteForm(form);

  if (error) {
    await replyText(
      event.replyToken,
      `${error}\n\n請重新依格式填寫：\n\n${instantQuoteFormText}`
    );
    return;
  }

  try {
    const mapData = await getDistanceAndTime(
      form.pickupAddress,
      form.deliveryAddress
    );

    const pricing = calculateFee({
      distanceKm: mapData.distanceKm,
      durationMin: mapData.durationMin,
      urgent: form.urgent,
    });

    const quote = {
      ...form,
      fee: pricing.fee,
      tax: pricing.tax,
      total: pricing.total,
      distanceText: mapData.distanceText,
      durationText: mapData.durationText,
    };

    await replyText(event.replyToken, formatQuoteMessage(quote));
  } catch (err) {
    console.error("handleInstantQuote 失敗：", err?.response?.data || err.message || err);

    await replyText(
      event.replyToken,
      "目前無法完成估價，請確認地址是否正確，或稍後再試。"
    );
  }
}

// ====== 主事件處理 ======
async function handleEvent(event) {
  console.log("收到 webhook event:", JSON.stringify(event, null, 2));

  if (event.source && event.source.type === "group") {
    console.log("目前 groupId =", event.source.groupId);
  }

  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const userText = (event.message.text || "").trim();

  if (userText === "建立任務") {
    await replyText(event.replyToken, createTaskFormText);
    return;
  }

  if (userText === "立即估價") {
    await replyText(event.replyToken, instantQuoteFormText);
    return;
  }

  if (isCreateTaskForm(userText)) {
    await handleCreateTask(event, userText);
    return;
  }

  if (isInstantQuoteForm(userText)) {
    await handleInstantQuote(event, userText);
    return;
  }
}

// ====== 健康檢查 ======
app.get("/", (req, res) => {
  res.status(200).send("UBee LINE Bot is running.");
});

// ====== Webhook ======
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook Error:", error);
    res.status(500).send("Internal Server Error");
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

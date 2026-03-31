"use strict";

const express = require("express");
const line = require("@line/bot-sdk");

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

const PORT = process.env.PORT || 3000;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;

// 可自行調整的固定費用設定
const DEFAULT_CREATE_TASK_FEE = Number(process.env.DEFAULT_CREATE_TASK_FEE || 300);
const DEFAULT_QUOTE_FEE = Number(process.env.DEFAULT_QUOTE_FEE || 230);
const DEFAULT_TAX = Number(process.env.DEFAULT_TAX || 15);

// =========================
// 表單文字
// =========================
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

// =========================
// 工具函式
// =========================
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

function calculateCreateTaskFee(form) {
  let fee = DEFAULT_CREATE_TASK_FEE;

  if (form.urgent === "急件") {
    fee += 100;
  }

  return fee;
}

function calculateQuoteFee(form) {
  let fee = DEFAULT_QUOTE_FEE;

  if (form.urgent === "急件") {
    fee += 100;
  }

  const tax = DEFAULT_TAX;
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

async function replyText(replyToken, text) {
  await client.replyMessage(replyToken, {
    type: "text",
    text,
  });
}

async function handleCreateTask(event, userText) {
  const form = parseCreateTaskForm(userText);
  const error = validateCreateTaskForm(form);

  if (error) {
    await replyText(event.replyToken, `${error}\n\n請重新依格式填寫：\n\n${createTaskFormText}`);
    return;
  }

  const fee = calculateCreateTaskFee(form);

  const task = {
    ...form,
    fee,
    distanceText: "待確認",
  };

  await replyText(event.replyToken, "您的任務已建立成功，我們會立即為您派單。");

  if (!LINE_GROUP_ID) {
    console.error("未設定 LINE_GROUP_ID，無法推送群組派單訊息。");
    return;
  }

  await client.pushMessage(LINE_GROUP_ID, {
    type: "text",
    text: formatDispatchMessage(task),
  });
}

async function handleInstantQuote(event, userText) {
  const form = parseInstantQuoteForm(userText);
  const error = validateInstantQuoteForm(form);

  if (error) {
    await replyText(event.replyToken, `${error}\n\n請重新依格式填寫：\n\n${instantQuoteFormText}`);
    return;
  }

  const result = calculateQuoteFee(form);

  const quote = {
    ...form,
    fee: result.fee,
    tax: result.tax,
    total: result.total,
  };

  await replyText(event.replyToken, formatQuoteMessage(quote));
}

async function handleEvent(event) {
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

// 健康檢查
app.get("/", (req, res) => {
  res.status(200).send("UBee LINE Bot is running.");
});

// LINE Webhook
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

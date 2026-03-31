const express = require("express");
const line = require("@line/bot-sdk");

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

const GROUP_ID = process.env.GROUP_ID;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const orders = new Map();

// ================= 工具 =================

function formatCurrency(num) {
  return `$${Math.round(num)}`;
}

function getField(text, label) {
  const regex = new RegExp(`${label}[:：]\\s*(.+)`);
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

function parseForm(text) {
  return {
    pickup: getField(text, "取件地點"),
    dropoff: getField(text, "送達地點"),
    item: getField(text, "物品內容"),
    urgent: getField(text, "是否急件").includes("急件"),
  };
}

// ================= 距離 =================

async function getDistance(origin, destination) {
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  const element = data.rows[0].elements[0];

  return {
    km: element.distance.value / 1000,
    text: element.distance.text,
    minutes: element.duration.value / 60,
  };
}

// ================= 計價 =================

async function calculatePrice(pickup, dropoff, urgent) {
  const base = 99;
  const kmRate = 6;
  const minRate = 3;
  const urgentFee = urgent ? 100 : 0;
  const serviceFee = 50;
  const tax = 15;

  const route = await getDistance(pickup, dropoff);

  const deliveryFee = Math.round(
    base +
    route.km * kmRate +
    route.minutes * minRate +
    urgentFee +
    serviceFee
  );

  const total = deliveryFee + tax;

  const riderFee = Math.round(deliveryFee * 0.6);
  const platformIncome = deliveryFee - riderFee;

  return {
    deliveryFee,
    total,
    riderFee,
    platformIncome,
    distanceText: route.text,
  };
}

// ================= LINE =================

app.post("/webhook", line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

// ================= 主邏輯 =================

async function handleEvent(event) {
  if (event.type !== "message") return;

  const text = event.message.text;

  // ================= 群組（騎手） =================
  if (event.source.type === "group") {
    const order = Array.from(orders.values()).find(o => o.status !== "done");

    if (!order) return;

    if (text === "接" && order.status === "pending") {
      order.status = "accepted";
      await push(order.userId, "已經有騎手接單");
    }

    if (text === "到" && order.status === "accepted") {
      order.status = "arrived";
      await push(order.userId, "騎手已抵達取件地點");
    }

    if (text === "出發" && order.status === "arrived") {
      order.status = "picked";
      await push(order.userId, "騎手已取件完成");
    }

    if (text === "抵達" && order.status === "picked") {
      order.status = "done";
      await push(order.userId, "騎手已抵達送達地點");
    }

    return;
  }

  // ================= 客人 =================

  if (text === "建立任務" || text === "立即估價") {
    return reply(event.replyToken, {
      type: "text",
      text: `請填寫：

取件地點：
送達地點：
物品內容：
是否急件（一般 / 急件）`,
    });
  }

  // 表單判斷
  if (text.includes("取件地點") && text.includes("送達地點")) {
    const form = parseForm(text);

    const price = await calculatePrice(
      form.pickup,
      form.dropoff,
      form.urgent
    );

    // ===== 客人只看總計 =====
    await reply(event.replyToken, {
      type: "text",
      text: `總計：${formatCurrency(price.total)}`,
    });

    // ===== 存訂單 =====
    orders.set(Date.now(), {
      ...form,
      ...price,
      userId: event.source.userId,
      status: "pending",
    });

    // ===== 派單給騎手 =====
    await push(GROUP_ID, {
      type: "text",
      text: `【UBee 派單】

費用：${formatCurrency(price.riderFee)}
距離：${price.distanceText}

取件：${form.pickup}
送達：${form.dropoff}
物品：${form.item}
急件：${form.urgent ? "急件" : "一般"}`,
    });

    return;
  }
}

// ================= 發送 =================

function reply(token, msg) {
  return client.replyMessage(token, msg);
}

function push(to, text) {
  return client.pushMessage(to, { type: "text", text });
}

module.exports = app;

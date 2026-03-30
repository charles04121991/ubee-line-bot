const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const PORT = process.env.PORT || 3000;

/* ====== 基本設定 ====== */

const CUSTOMER_PRICING = {
  baseFee: 99,
  perKm: 6,
  perMinute: 3,
  crossAreaFee: 25,
  urgentFee: 100,
  tax: 15,
};

const RIDER_PRICING = {
  urgentShareRate: 0.6,
};

/* ====== 工具 ====== */

function normalizePhone(phone = "") {
  return phone.replace(/\s+/g, "").trim();
}

/* ====== Google Maps ====== */

async function getDistance(origin, destination) {
  const url = "https://maps.googleapis.com/maps/api/distancematrix/json";

  const res = await axios.get(url, {
    params: {
      origins: origin,
      destinations: destination,
      key: GOOGLE_MAPS_API_KEY,
      language: "zh-TW",
      region: "tw",
    },
  });

  const el = res.data.rows[0].elements[0];

  if (el.status !== "OK") {
    throw new Error("距離計算失敗");
  }

  return {
    km: Math.ceil(el.distance.value / 1000),
    min: Math.ceil(el.duration.value / 60),
    textDistance: el.distance.text,
    textTime: el.duration.text,
  };
}

/* ====== 計價 ====== */

function calculatePrice({ km, min, urgent }) {
  const base = CUSTOMER_PRICING.baseFee;
  const distance = km * CUSTOMER_PRICING.perKm;
  const time = min * CUSTOMER_PRICING.perMinute;
  const urgentFee = urgent ? CUSTOMER_PRICING.urgentFee : 0;

  const delivery = base + distance + time + urgentFee;
  const total = delivery + CUSTOMER_PRICING.tax;

  const rider =
    base + distance + time +
    (urgent ? Math.round(urgentFee * RIDER_PRICING.urgentShareRate) : 0);

  return { delivery, total, rider };
}

/* ====== 容錯解析 ====== */

function parseText(text) {
  const lines = text.split("\n");

  let pickup = "";
  let delivery = "";
  let item = "";
  let urgent = false;

  for (let l of lines) {
    if (l.includes("取件地點")) pickup = l.split("：")[1] || l.replace("取件地點", "");
    if (l.includes("送達地點")) delivery = l.split("：")[1] || l.replace("送達地點", "");
    if (l.includes("物品內容")) item = l.split("：")[1] || l.replace("物品內容", "");
    if (l.includes("是否急件")) urgent = l.includes("是");
  }

  return {
    pickup: pickup.trim(),
    delivery: delivery.trim(),
    item: item.trim(),
    urgent,
  };
}

/* ====== LINE 回覆 ====== */

async function reply(token, text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken: token,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );
}

async function pushGroup(text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: TARGET_GROUP_ID,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );
}

/* ====== Webhook ====== */

app.post("/webhook", async (req, res) => {
  const events = req.body.events;

  for (const e of events) {
    if (e.type !== "message") continue;
    if (e.message.type !== "text") continue;

    const text = e.message.text.trim();
    const token = e.replyToken;
    const userId = e.source.userId;

    try {
      /* ===== 主選單 ===== */
      if (["你好", "嗨", "開始"].includes(text)) {
        await reply(
          token,
          "請選擇功能：\n1. 建立任務\n2. 立即估價"
        );
        continue;
      }

      /* ===== 建立任務 ===== */
      if (text === "建立任務") {
        await reply(
          token,
          "請填寫：\n取件地點：\n送達地點：\n物品內容：\n是否急件："
        );
        continue;
      }

      /* ===== 立即估價 ===== */
      if (text === "立即估價") {
        await reply(
          token,
          "請輸入估價資料：\n取件地點：\n送達地點：\n物品內容：\n是否急件："
        );
        continue;
      }

      /* ===== 自動解析 ===== */
      if (text.includes("取件地點")) {
        const data = parseText(text);

        if (!data.pickup || !data.delivery) {
          await reply(token, "❌ 資料不足，請重新輸入");
          continue;
        }

        const map = await getDistance(data.pickup, data.delivery);
        const price = calculatePrice({
          km: map.km,
          min: map.min,
          urgent: data.urgent,
        });

        /* ===== 客人顯示 ===== */
        await reply(
          token,
          `【UBee 預估報價】
取件地點：${data.pickup}
送達地點：${data.delivery}
物品內容：${data.item}
是否急件：${data.urgent ? "是" : "否"}

配送費：$${price.delivery}
稅金：$15
總計：$${price.total}

回覆「確認」送出`
        );

        /* ===== 存暫存 ===== */
        global.temp = { data, map, price, userId };

        continue;
      }

      /* ===== 確認送出 ===== */
      if (text === "確認" && global.temp) {
        const t = global.temp;

        await pushGroup(
          `【UBee 新任務通知】

費用：$${t.price.rider}

距離：${t.map.textDistance}（${t.map.textTime}）

客戶ID：${t.userId}

取件：${t.data.pickup}
送達：${t.data.delivery}
物品：${t.data.item}
急件：${t.data.urgent ? "是" : "否"}

———`
        );

        await reply(token, "✅ 任務已送出");

        global.temp = null;
        continue;
      }

    } catch (err) {
      console.log(err.message);
      await reply(token, "❌ 系統錯誤，請稍後再試");
    }
  }

  res.sendStatus(200);
});

/* ====== 啟動 ====== */

app.listen(PORT, () => {
  console.log("UBee running");
});
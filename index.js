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
  console.error("❌ 缺少環境變數");
  process.exit(1);
}

/* =========================
   Session
========================= */
const userSessions = {};

function getSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = {
      mode: null,
      waitingInput: false,
    };
  }
  return userSessions[userId];
}

function resetSession(userId) {
  delete userSessions[userId];
}

/* =========================
   Google Maps
========================= */
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

  const element = res.data.rows[0].elements[0];

  if (element.status !== "OK") {
    throw new Error("Google Maps 無法計算距離");
  }

  return {
    km: Math.ceil(element.distance.value / 1000),
    minutes: Math.ceil(element.duration.value / 60),
    distanceText: element.distance.text,
    durationText: element.duration.text,
  };
}

/* =========================
   計價
========================= */
function calculatePrice(km, minutes, urgent) {
  let price = 99 + km * 6 + minutes * 3;
  if (urgent) price += 100;

  return {
    delivery: price,
    tax: 15,
    total: price + 15,
  };
}

/* =========================
   LINE 回覆
========================= */
async function reply(replyToken, text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );
}

/* =========================
   群組派單
========================= */
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

/* =========================
   解析輸入
========================= */
function getValue(text, key) {
  const line = text.split("\n").find((l) => l.includes(key));
  if (!line) return "";
  return line.split("：")[1]?.trim() || "";
}

/* =========================
   Webhook
========================= */
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== "message") continue;
    if (event.message.type !== "text") continue;

    const text = event.message.text.trim();
    const replyToken = event.replyToken;
    const userId = event.source.userId;

    const session = getSession(userId);

    console.log("收到：", text);
    console.log("session：", session);

    /* =========================
       主選單
    ========================= */
    if (["你好", "開始", "選單"].includes(text)) {
      await reply(
        replyToken,
        "請輸入：\n1. 建立任務\n2. 立即估價"
      );
      continue;
    }

    /* =========================
       建立任務
    ========================= */
    if (text === "建立任務") {
      session.mode = "task";
      session.waitingInput = true;

      await reply(
        replyToken,
        "請依格式填寫：\n\n取件地點：\n取件人 / 電話：\n\n送達地點：\n收件人 / 電話：\n\n物品內容：\n\n是否急件：\n\n備註："
      );
      continue;
    }

    /* =========================
       立即估價
    ========================= */
    if (text === "立即估價") {
      session.mode = "estimate";
      session.waitingInput = true;

      await reply(
        replyToken,
        "請提供：\n\n取件地點：\n送達地點：\n物品內容：\n是否急件："
      );
      continue;
    }

    /* =========================
       處理輸入
    ========================= */
    if (session.waitingInput) {
      const pickup = getValue(text, "取件地點");
      const delivery = getValue(text, "送達地點");
      const item = getValue(text, "物品內容");
      const urgentRaw = getValue(text, "是否急件");

      if (!pickup || !delivery || !item) {
        await reply(replyToken, "❌ 資料不完整，請重新填寫");
        continue;
      }

      const urgent = urgentRaw.includes("是") || urgentRaw.includes("急");

      try {
        const map = await getDistance(pickup, delivery);
        const price = calculatePrice(map.km, map.minutes, urgent);

        /* ===== 立即估價 ===== */
        if (session.mode === "estimate") {
          await reply(
            replyToken,
            `【即時估價】
配送費：$${price.delivery}
稅金：$${price.tax}
總計：$${price.total}`
          );
        }

        /* ===== 建立任務 ===== */
        if (session.mode === "task") {
          await pushGroup(
            `【新任務】
費用：$${price.delivery}
距離：${map.distanceText}

取件：${pickup}
送達：${delivery}
物品：${item}
急件：${urgent ? "是" : "否"}`
          );

          await reply(
            replyToken,
            `任務已建立 ✅
費用：$${price.total}`
          );
        }

        resetSession(userId);
      } catch (err) {
        console.error(err);
        await reply(replyToken, "❌ 計算失敗（請確認地址）");
      }
    }
  }

  res.sendStatus(200);
});

/* =========================
   Render Port 修正（關鍵）
========================= */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`UBee bot running on port ${PORT}`);
});
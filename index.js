const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

const app = express();

const PORT = process.env.PORT || 3000;

const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;

// 啟動前先檢查必要環境變數
if (!CHANNEL_SECRET) {
  throw new Error("Missing CHANNEL_SECRET");
}
if (!CHANNEL_ACCESS_TOKEN) {
  throw new Error("Missing CHANNEL_ACCESS_TOKEN");
}

const config = {
  channelSecret: CHANNEL_SECRET,
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
};

const client = new line.Client(config);

// 健康檢查
app.get("/", (req, res) => {
  res.send("UBee LINE Bot is running.");
});

// LINE webhook
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (error) {
    console.error("Webhook Error:", error);
    res.status(500).end();
  }
});

// 主事件處理
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const userText = event.message.text.trim();

  // 1) 立即估價
  if (userText === "立即估價") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "請直接依下方格式填寫，我會立即幫您估價：\n\n" +
        "取件地點：\n" +
        "取件電話：\n\n" +
        "送達地點：\n" +
        "送達電話：\n\n" +
        "物品內容：\n" +
        "是否急件（一般 / 急件）：\n" +
        "備註："
    });
  }

  // 2) 建立任務 / 自動估價
  if (looksLikeOrderForm(userText)) {
    const parsed = parseOrderForm(userText);

    if (!parsed.pickupAddress || !parsed.deliveryAddress) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "資料讀取不完整，請確認有填寫「取件地點」與「送達地點」。"
      });
    }

    try {
      const quote = await calculateQuote(parsed);

      const replyText =
        `配送費：$${quote.deliveryFee}\n` +
        `稅金：$${quote.tax}\n` +
        `總計：$${quote.total}`;

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: replyText
      });

      // 派單到群組
      if (LINE_GROUP_ID) {
        const dispatchText =
          `【UBee 新任務派單】\n\n` +
          `取件地點：${parsed.pickupAddress}\n` +
          `取件電話：${parsed.pickupPhone || "未提供"}\n\n` +
          `送達地點：${parsed.deliveryAddress}\n` +
          `送達電話：${parsed.deliveryPhone || "未提供"}\n\n` +
          `物品內容：${parsed.item || "未提供"}\n` +
          `是否急件：${parsed.urgent || "一般"}\n` +
          `備註：${parsed.note || "無"}\n\n` +
          `配送費：$${quote.deliveryFee}\n` +
          `稅金：$${quote.tax}\n` +
          `總計：$${quote.total}`;

        try {
          await client.pushMessage(LINE_GROUP_ID, {
            type: "text",
            text: dispatchText
          });
          console.log("派單成功，已推送至群組");
        } catch (pushError) {
          console.error("派單到群組失敗：", pushError.response?.data || pushError.message);
        }
      } else {
        console.warn("未設定 LINE_GROUP_ID，略過群組派單");
      }

      return null;
    } catch (error) {
      console.error("報價失敗：", error.response?.data || error.message);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "目前無法完成估價，請稍後再試，或直接聯繫客服。"
      });
    }
  }

  return null;
}

// 判斷像不像表單
function looksLikeOrderForm(text) {
  return (
    text.includes("取件地點") &&
    text.includes("送達地點") &&
    text.includes("物品內容")
  );
}

// 解析客戶表單
function parseOrderForm(text) {
  return {
    pickupAddress: getField(text, "取件地點"),
    pickupPhone: getField(text, "取件電話"),
    deliveryAddress: getField(text, "送達地點"),
    deliveryPhone: getField(text, "送達電話"),
    item: getField(text, "物品內容"),
    urgent: getField(text, "是否急件") || "一般",
    note: getField(text, "備註") || "無",
  };
}

// 通用欄位抓取
function getField(text, label) {
  const regex = new RegExp(`${label}[：:]\\s*(.+)`);
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

// Google Maps 距離與時間
async function getDistanceAndDuration(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error("Missing GOOGLE_MAPS_API_KEY");
  }

  const url = "https://maps.googleapis.com/maps/api/distancematrix/json";

  const response = await axios.get(url, {
    params: {
      origins: origin,
      destinations: destination,
      language: "zh-TW",
      key: GOOGLE_MAPS_API_KEY,
    },
  });

  const data = response.data;

  if (
    data.status !== "OK" ||
    !data.rows ||
    !data.rows[0] ||
    !data.rows[0].elements ||
    !data.rows[0].elements[0] ||
    data.rows[0].elements[0].status !== "OK"
  ) {
    throw new Error("Google Maps distance lookup failed");
  }

  const element = data.rows[0].elements[0];

  return {
    distanceMeters: element.distance.value,
    durationSeconds: element.duration.value,
  };
}

// 報價計算
async function calculateQuote(order) {
  const { distanceMeters, durationSeconds } = await getDistanceAndDuration(
    order.pickupAddress,
    order.deliveryAddress
  );

  const distanceKm = distanceMeters / 1000;
  const durationMin = durationSeconds / 60;

  // 你的報價邏輯
  const baseFee = 99;
  const perKmFee = 6;
  const perMinFee = 3;
  const serviceFee = 50;

  let urgentFee = 0;
  if (order.urgent.includes("急件")) {
    urgentFee = 100;
  }

  let subtotal =
    baseFee +
    Math.ceil(distanceKm) * perKmFee +
    Math.ceil(durationMin) * perMinFee +
    serviceFee +
    urgentFee;

  const tax = Math.round(subtotal * 0.05);
  const total = subtotal + tax;

  return {
    deliveryFee: subtotal,
    tax,
    total,
    distanceKm: Math.ceil(distanceKm),
    durationMin: Math.ceil(durationMin),
  };
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

app.get("/", (req, res) => {
  res.status(200).send("UBee bot v1 running");
});

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const userText = event.message.text.trim();

  try {
    // =========================
    // 1. 建立任務 表單顯示
    // =========================
    if (userText === "建立任務") {
      const replyText = `請填寫以下任務資訊：

取件地點：
取件電話：

送達地點：
送達電話：

物品內容：
是否急件（一般 / 急件）：
備註：`;

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: replyText,
      });
    }

    // =========================
    // 2. 立即估價 表單顯示
    // =========================
    if (userText === "立即估價") {
      const replyText = `請填寫以下估價資訊：

取件地點：
送達地點：
物品內容：
是否急件（一般 / 急件）：`;

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: replyText,
      });
    }

    // =========================
    // 3. 判斷是否為估價格式
    // =========================
    const isEstimateForm =
      userText.includes("取件地點：") &&
      userText.includes("送達地點：") &&
      userText.includes("物品內容：") &&
      userText.includes("是否急件");

    if (isEstimateForm) {
      const pickupAddress = extractField(userText, "取件地點");
      const deliveryAddress = extractField(userText, "送達地點");
      const itemContent = extractField(userText, "物品內容");
      const urgentText = extractField(userText, "是否急件");

      if (!pickupAddress || !deliveryAddress) {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "資料不完整，請確認已填寫取件地點與送達地點。",
        });
      }

      const { distanceKm, durationMin } = await getDistanceAndTime(
        pickupAddress,
        deliveryAddress
      );

      const isUrgent =
        urgentText.includes("急件") || urgentText.includes("是");

      const priceResult = calculatePrice({
        distanceKm,
        durationMin,
        pickupAddress,
        deliveryAddress,
        isUrgent,
      });

      const replyText = `配送費：$${priceResult.deliveryFee}
急件費：$${priceResult.urgentFee}
稅金：$${priceResult.tax}
總計：$${priceResult.total}`;

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: replyText,
      });
    }

    // =========================
    // 4. 建立任務格式
    // =========================
    const isTaskForm =
      userText.includes("取件地點：") &&
      userText.includes("取件電話：") &&
      userText.includes("送達地點：") &&
      userText.includes("送達電話：") &&
      userText.includes("物品內容：") &&
      userText.includes("是否急件");

    if (isTaskForm) {
      const pickupAddress = extractField(userText, "取件地點");
      const pickupPhone = extractField(userText, "取件電話");
      const deliveryAddress = extractField(userText, "送達地點");
      const deliveryPhone = extractField(userText, "送達電話");
      const itemContent = extractField(userText, "物品內容");
      const urgentText = extractField(userText, "是否急件");
      const note = extractField(userText, "備註");

      if (!pickupAddress || !deliveryAddress) {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "資料不完整，請確認取件地點與送達地點都有填寫。",
        });
      }

      const { distanceKm, durationMin } = await getDistanceAndTime(
        pickupAddress,
        deliveryAddress
      );

      const isUrgent =
        urgentText.includes("急件") || urgentText.includes("是");

      const priceResult = calculatePrice({
        distanceKm,
        durationMin,
        pickupAddress,
        deliveryAddress,
        isUrgent,
      });

      // 回覆客人
      const customerReply = `您的任務已建立成功，我們會立即為您派單。

配送費：$${priceResult.deliveryFee}
急件費：$${priceResult.urgentFee}
稅金：$${priceResult.tax}
總計：$${priceResult.total}`;

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: customerReply,
      });

      // 如果你之後有群組 ID，可以在這裡派送到群組
      if (process.env.GROUP_ID) {
        const dispatchText = `【UBee 新任務通知】

取件地點：${pickupAddress}
取件電話：${pickupPhone || "未填"}

送達地點：${deliveryAddress}
送達電話：${deliveryPhone || "未填"}

物品內容：${itemContent || "未填"}
是否急件：${isUrgent ? "急件" : "一般"}
備註：${note || "無"}

配送費：$${priceResult.deliveryFee}
急件費：$${priceResult.urgentFee}
稅金：$${priceResult.tax}
總計：$${priceResult.total}

距離：約 ${distanceKm.toFixed(1)} 公里
時間：約 ${Math.round(durationMin)} 分鐘`;

        await client.pushMessage(process.env.GROUP_ID, {
          type: "text",
          text: dispatchText,
        });
      }

      return null;
    }

    // =========================
    // 5. 其他訊息不回覆
    // =========================
    return null;
  } catch (error) {
    console.error("handleEvent error:", error);

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "系統忙碌中，請稍後再試一次。",
    });
  }
}

// =========================
// 取欄位內容
// =========================
function extractField(text, fieldName) {
  const regex = new RegExp(`${fieldName}[：:]\\s*(.*)`);
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

// =========================
// Google Maps 距離 / 時間
// =========================
async function getDistanceAndTime(origin, destination) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GOOGLE_MAPS_API_KEY");
  }

  const originFull = formatTaiwanAddress(origin);
  const destinationFull = formatTaiwanAddress(destination);

  const url = "https://maps.googleapis.com/maps/api/distancematrix/json";

  const response = await axios.get(url, {
    params: {
      origins: originFull,
      destinations: destinationFull,
      key: apiKey,
      language: "zh-TW",
      region: "tw",
    },
  });

  const data = response.data;

  if (
    !data.rows ||
    !data.rows[0] ||
    !data.rows[0].elements ||
    !data.rows[0].elements[0]
  ) {
    throw new Error("Google Maps response invalid");
  }

  const element = data.rows[0].elements[0];

  if (element.status !== "OK") {
    throw new Error(`Google Maps error: ${element.status}`);
  }

  const distanceKm = element.distance.value / 1000;
  const durationMin = element.duration.value / 60;

  return {
    distanceKm,
    durationMin,
  };
}

// =========================
// 自動補台灣地址
// =========================
function formatTaiwanAddress(address) {
  if (!address) return "";
  if (address.includes("台中市") || address.includes("臺中市")) {
    return address;
  }
  return `台中市${address}`;
}

// =========================
// 判斷是否跨區
// =========================
function isCrossArea(pickupAddress, deliveryAddress) {
  const areas = ["豐原", "潭子", "神岡", "大雅", "北屯"];

  const pickupArea = areas.find((area) => pickupAddress.includes(area)) || "";
  const deliveryArea =
    areas.find((area) => deliveryAddress.includes(area)) || "";

  if (!pickupArea || !deliveryArea) {
    return false;
  }

  return pickupArea !== deliveryArea;
}

// =========================
// 計價邏輯
// =========================
function calculatePrice({
  distanceKm,
  durationMin,
  pickupAddress,
  deliveryAddress,
  isUrgent,
}) {
  const baseFee = 99;
  const distanceFee = distanceKm * 6;
  const timeFee = durationMin * 3;
  const crossAreaFee = isCrossArea(pickupAddress, deliveryAddress) ? 25 : 0;
  const urgentFee = isUrgent ? 100 : 0;
  const tax = 15;

  const deliveryFee = Math.round(
    baseFee + distanceFee + timeFee + crossAreaFee
  );

  const total = deliveryFee + urgentFee + tax;

  return {
    deliveryFee,
    urgentFee,
    tax,
    total,
  };
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`UBee bot running on port ${port}`);
});

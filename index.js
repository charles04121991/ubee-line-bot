const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

/**
 * =========================
 * 環境變數
 * =========================
 */
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID;
const PORT = process.env.PORT || 3000;

/**
 * =========================
 * 費率設定
 * =========================
 */
const PRICING = {
  baseFee: 99,
  perKm: 6,
  perMin: 3,
  crossDistrictFee: 25,
  urgentFee: 100
};

/**
 * =========================
 * 單一流程記憶
 * =========================
 */
const userSessions = new Map();

/**
 * session 格式：
 * {
 *   mode: "create_task" | "quote"
 * }
 */

app.get("/", (req, res) => {
  res.send("UBee bot running");
});

app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      try {
        if (event.type !== "message") continue;
        if (event.message.type !== "text") continue;

        const userId = event.source?.userId;
        const replyToken = event.replyToken;
        const userText = (event.message.text || "").trim();

        if (!userId || !replyToken) continue;

        console.log("============");
        console.log("收到訊息:", userText);
        console.log("userId:", userId);
        console.log("目前 session:", userSessions.get(userId));

        /**
         * 建立任務
         */
        if (isCreateTaskCommand(userText)) {
          userSessions.set(userId, { mode: "create_task" });

          await replyMessage(
            replyToken,
            `請依格式填寫：

取件地點：
取件電話：

送達地點：
送達電話：

物品內容：

是否急件：

備註：不配送食品、違禁品或危險物品`
          );
          continue;
        }

        /**
         * 立即估價
         */
        if (isQuoteCommand(userText)) {
          userSessions.set(userId, { mode: "quote" });

          await replyMessage(
            replyToken,
            `您可以先快速取得任務費用估算，請提供：

取件地點：
送達地點：
物品內容：
是否急件：`
          );
          continue;
        }

        /**
         * 取消
         */
        if (userText === "取消") {
          userSessions.delete(userId);

          await replyMessage(replyToken, "好的，已取消目前流程。");
          continue;
        }

        const session = userSessions.get(userId);

        /**
         * 沒有流程狀態時，不主動塞一大段主選單
         */
        if (!session) {
          continue;
        }

        /**
         * 建立任務流程
         */
        if (session.mode === "create_task") {
          const form = parseCreateTaskForm(userText);
          console.log("建立任務解析結果:", form);

          if (!form.ok) {
            await replyMessage(
              replyToken,
              `格式不正確，請依以下格式填寫：

取件地點：
取件電話：

送達地點：
送達電話：

物品內容：

是否急件：

備註：不配送食品、違禁品或危險物品`
            );
            continue;
          }

          const pickupAddress = normalizeAddress(form.data.pickupAddress);
          const dropoffAddress = normalizeAddress(form.data.dropoffAddress);
          const pickupPhone = form.data.pickupPhone;
          const dropoffPhone = form.data.dropoffPhone;
          const itemContent = form.data.itemContent;
          const isUrgent = parseUrgent(form.data.isUrgent);

          const routeInfo = await getRouteInfo(pickupAddress, dropoffAddress);
          const fee = calculateFee(routeInfo.distanceKm, routeInfo.durationMin, isUrgent);

          await replyMessage(
            replyToken,
            "任務已建立成功，我們會儘快為您安排。"
          );

          const groupMessage = `【UBee 新任務通知】

費用：$${fee.total}
${routeInfo.distanceKm.toFixed(1)} 公里（${routeInfo.durationMin} 分鐘）

取件地點：${pickupAddress}
取件電話：${pickupPhone}

送達地點：${dropoffAddress}
送達電話：${dropoffPhone}

物品內容：${itemContent}

—————————`;

          await pushMessage(TARGET_GROUP_ID, groupMessage);

          userSessions.delete(userId);
          console.log("建立任務完成，session 已清除");
          continue;
        }

        /**
         * 立即估價流程
         */
        if (session.mode === "quote") {
          const form = parseQuoteForm(userText);
          console.log("立即估價解析結果:", form);

          if (!form.ok) {
            await replyMessage(
              replyToken,
              `格式不正確，請依以下格式填寫：

取件地點：
送達地點：
物品內容：
是否急件：`
            );
            continue;
          }

          const pickupAddress = normalizeAddress(form.data.pickupAddress);
          const dropoffAddress = normalizeAddress(form.data.dropoffAddress);
          const itemContent = form.data.itemContent;
          const isUrgent = parseUrgent(form.data.isUrgent);

          const routeInfo = await getRouteInfo(pickupAddress, dropoffAddress);
          const fee = calculateFee(routeInfo.distanceKm, routeInfo.durationMin, isUrgent);

          const quoteMessage = `以下為本次任務預估費用：

配送費：$${fee.deliveryFee}
小計：$${fee.subtotal}
稅金：$${fee.tax}
總計：$${fee.total}

路線資訊：
${routeInfo.distanceKm.toFixed(1)} 公里（約 ${routeInfo.durationMin} 分鐘）

物品內容：${itemContent}

※ 此為預估費用，非最終報價`;

          await replyMessage(replyToken, quoteMessage);

          userSessions.delete(userId);
          console.log("立即估價完成，session 已清除");
          continue;
        }
      } catch (err) {
        console.error("單一事件錯誤:", err);
        console.error("錯誤訊息:", err.message);
        console.error("錯誤回傳:", err.response?.data || "無 response data");

        try {
          await replyMessage(
            event.replyToken,
            "系統忙碌中，請稍後再試一次。"
          );
        } catch (replyErr) {
          console.error("錯誤回覆失敗:", replyErr.message);
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook 錯誤:", error);
    res.sendStatus(500);
  }
});

/**
 * =========================
 * 指令判斷
 * =========================
 */
function isCreateTaskCommand(text) {
  const t = normalizeCommand(text);
  return t === "建立任務" || t === "1" || t === "1建立任務";
}

function isQuoteCommand(text) {
  const t = normalizeCommand(text);
  return t === "立即估價" || t === "2" || t === "2立即估價";
}

function normalizeCommand(text) {
  return (text || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[．。.、]/g, "");
}

/**
 * =========================
 * 建立任務表單解析
 * =========================
 */
function parseCreateTaskForm(text) {
  let normalized = (text || "").replace(/\r/g, "").trim();
  normalized = normalized.replace(/^請依格式填寫[:：]?\s*/m, "").trim();

  const pickupAddress = extractField(normalized, "取件地點");
  const pickupPhone = extractField(normalized, "取件電話");
  const dropoffAddress = extractField(normalized, "送達地點");
  const dropoffPhone = extractField(normalized, "送達電話");
  const itemContent = extractField(normalized, "物品內容");
  const isUrgent = extractField(normalized, "是否急件");
  const note = extractField(normalized, "備註");

  if (
    !pickupAddress ||
    !pickupPhone ||
    !dropoffAddress ||
    !dropoffPhone ||
    !itemContent ||
    !isUrgent
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    data: {
      pickupAddress,
      pickupPhone,
      dropoffAddress,
      dropoffPhone,
      itemContent,
      isUrgent,
      note
    }
  };
}

/**
 * =========================
 * 立即估價表單解析
 * =========================
 */
function parseQuoteForm(text) {
  let normalized = (text || "").replace(/\r/g, "").trim();
  normalized = normalized.replace(/^您可以先快速取得任務費用估算，請提供[:：]?\s*/m, "").trim();

  const pickupAddress = extractField(normalized, "取件地點");
  const dropoffAddress = extractField(normalized, "送達地點");
  const itemContent = extractField(normalized, "物品內容");
  const isUrgent = extractField(normalized, "是否急件");

  if (!pickupAddress || !dropoffAddress || !itemContent || !isUrgent) {
    return { ok: false };
  }

  return {
    ok: true,
    data: {
      pickupAddress,
      dropoffAddress,
      itemContent,
      isUrgent
    }
  };
}

/**
 * =========================
 * 欄位抽取
 * =========================
 */
function extractField(text, label) {
  const lines = text.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith(label + "：")) {
      return trimmed.slice((label + "：").length).trim();
    }

    if (trimmed.startsWith(label + ":")) {
      return trimmed.slice((label + ":").length).trim();
    }
  }

  return "";
}

/**
 * =========================
 * 地址標準化
 * =========================
 */
function normalizeAddress(address) {
  const trimmed = (address || "").trim();

  if (!trimmed) return trimmed;
  if (trimmed.startsWith("台中市") || trimmed.startsWith("臺中市")) {
    return trimmed;
  }

  return `台中市${trimmed}`;
}

/**
 * =========================
 * 急件判斷
 * =========================
 */
function parseUrgent(value) {
  const text = (value || "").trim().toLowerCase();
  return ["是", "急件", "要", "yes", "y", "true", "1"].includes(text);
}

/**
 * =========================
 * Google Maps：地址轉座標
 * =========================
 */
async function geocodeAddress(address) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error("缺少 GOOGLE_MAPS_API_KEY");
  }

  const res = await axios.get(
    "https://maps.googleapis.com/maps/api/geocode/json",
    {
      params: {
        address,
        language: "zh-TW",
        region: "tw",
        key: GOOGLE_MAPS_API_KEY
      }
    }
  );

  if (res.data.status !== "OK") {
    throw new Error(`Google Geocoding API 錯誤：${res.data.status}`);
  }

  const result = res.data.results?.[0];
  if (!result) {
    throw new Error(`地址解析失敗：${address}`);
  }

  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng
  };
}

/**
 * =========================
 * Google Maps：取得距離與時間
 * =========================
 */
async function getRouteInfo(originAddress, destinationAddress) {
  const originGeo = await geocodeAddress(originAddress);
  const destinationGeo = await geocodeAddress(destinationAddress);

  const res = await axios.get(
    "https://maps.googleapis.com/maps/api/directions/json",
    {
      params: {
        origin: `${originGeo.lat},${originGeo.lng}`,
        destination: `${destinationGeo.lat},${destinationGeo.lng}`,
        mode: "driving",
        language: "zh-TW",
        key: GOOGLE_MAPS_API_KEY
      }
    }
  );

  if (res.data.status !== "OK") {
    throw new Error(`Google Directions API 錯誤：${res.data.status}`);
  }

  const leg = res.data.routes?.[0]?.legs?.[0];
  if (!leg) {
    throw new Error("找不到路線資料");
  }

  return {
    distanceKm: (leg.distance?.value || 0) / 1000,
    durationMin: Math.ceil((leg.duration?.value || 0) / 60)
  };
}

/**
 * =========================
 * 計費
 * =========================
 */
function calculateFee(distanceKm, durationMin, isUrgent) {
  const baseFee = PRICING.baseFee;
  const kmFee = Math.ceil(distanceKm) * PRICING.perKm;
  const timeFee = Math.ceil(durationMin) * PRICING.perMin;
  const crossDistrictFee = distanceKm > 5 ? PRICING.crossDistrictFee : 0;
  const urgentFee = isUrgent ? PRICING.urgentFee : 0;

  const deliveryFee = baseFee + kmFee + timeFee + crossDistrictFee + urgentFee;
  const subtotal = deliveryFee;
  const tax = Math.round(subtotal * 0.05);
  const total = subtotal + tax;

  return {
    deliveryFee,
    subtotal,
    tax,
    total
  };
}

/**
 * =========================
 * LINE Reply
 * =========================
 */
async function replyMessage(replyToken, text) {
  if (!CHANNEL_ACCESS_TOKEN) {
    throw new Error("缺少 CHANNEL_ACCESS_TOKEN");
  }

  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [
        {
          type: "text",
          text
        }
      ]
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`
      }
    }
  );
}

/**
 * =========================
 * LINE Push
 * =========================
 */
async function pushMessage(to, text) {
  if (!CHANNEL_ACCESS_TOKEN) {
    throw new Error("缺少 CHANNEL_ACCESS_TOKEN");
  }

  if (!to) {
    throw new Error("缺少 TARGET_GROUP_ID");
  }

  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to,
      messages: [
        {
          type: "text",
          text
        }
      ]
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`
      }
    }
  );
}

app.listen(PORT, () => {
  console.log(`UBee bot running on port ${PORT}`);
});
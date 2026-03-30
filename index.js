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

if (!CHANNEL_ACCESS_TOKEN) {
  console.error("缺少 CHANNEL_ACCESS_TOKEN");
}
if (!GOOGLE_MAPS_API_KEY) {
  console.error("缺少 GOOGLE_MAPS_API_KEY");
}
if (!TARGET_GROUP_ID) {
  console.error("缺少 TARGET_GROUP_ID");
}

/**
 * =========================
 * 基本設定
 * =========================
 * 你目前的費用公式：
 * 基本費 $99
 * 公里費 $6 / km
 * 時間費 $3 / 分鐘
 * 跨區費 $25
 * 急件費 $100
 *
 * 立即估價：只顯示給客人，不推送群組
 * 建立任務：回覆客人 + 推送群組
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
 * 記憶流程（單一任務版）
 * 不做多任務版本
 * =========================
 */
const userSessions = new Map();

/**
 * session 格式：
 * {
 *   mode: "create_task" | "quote"
 * }
 */

/**
 * =========================
 * 首頁
 * =========================
 */
app.get("/", (req, res) => {
  res.send("UBee bot running");
});

/**
 * =========================
 * LINE Webhook
 * =========================
 */
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

        console.log("收到使用者訊息：", userText);

        /**
         * 1. 點選「建立任務」
         */
        if (userText === "建立任務") {
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
         * 2. 點選「立即估價」
         */
        if (userText === "立即估價") {
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
         * 3. 取消
         */
        if (userText === "取消") {
          userSessions.delete(userId);

          await replyMessage(
            replyToken,
            `好的，已取消目前流程。

請輸入以下功能：
1. 建立任務
2. 立即估價`
          );
          continue;
        }

        /**
         * 4. 判斷目前使用者正在什麼流程
         */
        const session = userSessions.get(userId);

        if (!session) {
          await replyMessage(
            replyToken,
            `您好，這裡是 UBee 城市任務。

請輸入以下功能：
1. 建立任務
2. 立即估價

若要取消目前流程，請輸入：取消`
          );
          continue;
        }

        /**
         * 5. 建立任務流程
         */
        if (session.mode === "create_task") {
          const form = parseCreateTaskForm(userText);

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

          // 回覆客人
          await replyMessage(
            replyToken,
            `任務已建立成功，我們會儘快為您安排。`
          );

          // 推送到群組
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

          // 清除流程
          userSessions.delete(userId);
          continue;
        }

        /**
         * 6. 立即估價流程
         */
        if (session.mode === "quote") {
          const form = parseQuoteForm(userText);

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

          const quoteText = `以下為本次任務預估費用：

配送費：$${fee.deliveryFee}
小計：$${fee.subtotal}
稅金：$${fee.tax}
總計：$${fee.total}

路線資訊：
${routeInfo.distanceKm.toFixed(1)} 公里（約 ${routeInfo.durationMin} 分鐘）

物品內容：${itemContent}

※ 此為預估費用，非最終報價`;

          await replyMessage(replyToken, quoteText);

          // 只估價，不推送群組
          userSessions.delete(userId);
          continue;
        }

        /**
         * 7. 其他狀況
         */
        await replyMessage(
          replyToken,
          `您好，這裡是 UBee 城市任務。

請輸入以下功能：
1. 建立任務
2. 立即估價

若要取消目前流程，請輸入：取消`
        );
      } catch (eventError) {
        console.error("單一事件處理失敗：", eventError);

        if (event.replyToken) {
          try {
            await replyMessage(
              event.replyToken,
              "系統忙碌中，請稍後再試一次。"
            );
          } catch (replyError) {
            console.error("回覆失敗：", replyError.message);
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook 處理失敗：", error);
    res.sendStatus(500);
  }
});

/**
 * =========================
 * 表單解析 - 建立任務
 * 格式：
 *
 * 取件地點：
 * 取件電話：
 *
 * 送達地點：
 * 送達電話：
 *
 * 物品內容：
 *
 * 是否急件：
 * =========================
 */
function parseCreateTaskForm(text) {
  const normalized = text.replace(/\r/g, "").trim();

  const pickupAddress = extractField(normalized, "取件地點");
  const pickupPhone = extractField(normalized, "取件電話");
  const dropoffAddress = extractField(normalized, "送達地點");
  const dropoffPhone = extractField(normalized, "送達電話");
  const itemContent = extractField(normalized, "物品內容");
  const isUrgent = extractField(normalized, "是否急件");

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
      isUrgent
    }
  };
}

/**
 * =========================
 * 表單解析 - 立即估價
 * 格式：
 *
 * 取件地點：
 * 送達地點：
 * 物品內容：
 * 是否急件：
 * =========================
 */
function parseQuoteForm(text) {
  const normalized = text.replace(/\r/g, "").trim();

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
 * 抽取欄位
 * 支援：
 * 欄位：
 * 欄位:
 * =========================
 */
function extractField(text, label) {
  const escaped = escapeRegExp(label);
  const regex = new RegExp(`${escaped}\\s*[：:]\\s*([\\s\\S]*?)(?=\\n\\S+\\s*[：:]|$)`, "m");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * =========================
 * 地址標準化
 * 若客人沒打「台中市」，自動補上
 * 例如：
 * 豐原區中正路218號 -> 台中市豐原區中正路218號
 * =========================
 */
function normalizeAddress(address) {
  const trimmed = (address || "").trim();

  if (!trimmed) return trimmed;

  if (trimmed.startsWith("台中市")) return trimmed;
  if (trimmed.startsWith("臺中市")) return trimmed;

  return `台中市${trimmed}`;
}

/**
 * =========================
 * 是否急件解析
 * =========================
 */
function parseUrgent(value) {
  const text = (value || "").trim();
  const yesValues = ["是", "急件", "要", "yes", "y", "true", "1"];
  return yesValues.includes(text.toLowerCase());
}

/**
 * =========================
 * 取得路線資訊
 * 使用 Google Maps Geocoding + Directions
 * =========================
 */
async function getRouteInfo(originAddress, destinationAddress) {
  // 先 geocode，讓地址更穩定
  const originGeo = await geocodeAddress(originAddress);
  const destinationGeo = await geocodeAddress(destinationAddress);

  // 再 directions 取距離與時間
  const directionsUrl = "https://maps.googleapis.com/maps/api/directions/json";
  const directionsRes = await axios.get(directionsUrl, {
    params: {
      origin: `${originGeo.lat},${originGeo.lng}`,
      destination: `${destinationGeo.lat},${destinationGeo.lng}`,
      mode: "driving",
      language: "zh-TW",
      key: GOOGLE_MAPS_API_KEY
    }
  });

  if (directionsRes.data.status !== "OK") {
    throw new Error(`Google Directions API 錯誤：${directionsRes.data.status}`);
  }

  const leg = directionsRes.data.routes?.[0]?.legs?.[0];
  if (!leg) {
    throw new Error("找不到路線資料");
  }

  const distanceMeters = leg.distance?.value || 0;
  const durationSeconds = leg.duration?.value || 0;

  const distanceKm = distanceMeters / 1000;
  const durationMin = Math.ceil(durationSeconds / 60);

  return {
    distanceKm,
    durationMin,
    originFormatted: originGeo.formattedAddress,
    destinationFormatted: destinationGeo.formattedAddress
  };
}

/**
 * =========================
 * Geocoding
 * =========================
 */
async function geocodeAddress(address) {
  const geocodeUrl = "https://maps.googleapis.com/maps/api/geocode/json";

  const res = await axios.get(geocodeUrl, {
    params: {
      address,
      language: "zh-TW",
      region: "tw",
      key: GOOGLE_MAPS_API_KEY
    }
  });

  if (res.data.status !== "OK") {
    throw new Error(`Google Geocoding API 錯誤：${res.data.status}`);
  }

  const result = res.data.results?.[0];
  if (!result) {
    throw new Error(`地址解析失敗：${address}`);
  }

  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    formattedAddress: result.formatted_address
  };
}

/**
 * =========================
 * 計費邏輯
 * =========================
 */
function calculateFee(distanceKm, durationMin, isUrgent) {
  const baseFee = PRICING.baseFee;
  const kmFee = Math.ceil(distanceKm) * PRICING.perKm;
  const timeFee = Math.ceil(durationMin) * PRICING.perMin;

  const crossDistrictFee = isCrossDistrictFeeNeeded(distanceKm)
    ? PRICING.crossDistrictFee
    : 0;

  const urgentFee = isUrgent ? PRICING.urgentFee : 0;

  const deliveryFee = baseFee + kmFee + timeFee + crossDistrictFee + urgentFee;
  const subtotal = deliveryFee;
  const tax = Math.round(subtotal * 0.05);
  const total = subtotal + tax;

  return {
    baseFee,
    kmFee,
    timeFee,
    crossDistrictFee,
    urgentFee,
    deliveryFee,
    subtotal,
    tax,
    total
  };
}

/**
 * =========================
 * 跨區費
 * 這裡先用簡單版：
 * 只要距離 > 5km 就加跨區費
 *
 * 你之後若要改成真正「不同行政區才加」
 * 我可以再幫你改成比對區名版本
 * =========================
 */
function isCrossDistrictFeeNeeded(distanceKm) {
  return distanceKm > 5;
}

/**
 * =========================
 * LINE 回覆訊息
 * =========================
 */
async function replyMessage(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";

  await axios.post(
    url,
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
 * LINE 推送訊息到群組
 * =========================
 */
async function pushMessage(to, text) {
  const url = "https://api.line.me/v2/bot/message/push";

  await axios.post(
    url,
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

/**
 * =========================
 * 啟動伺服器
 * =========================
 */
app.listen(PORT, () => {
  console.log(`UBee bot running on port ${PORT}`);
});
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
 * 啟動前檢查
 * =========================
 */
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
 * 注意：伺服器重啟後會清空
 * =========================
 */
const userSessions = new Map();

/**
 * session 格式
 * {
 *   mode: "create_task" | "quote"
 * }
 */

app.get("/", (req, res) => {
  res.status(200).send("UBee bot running");
});

/**
 * =========================
 * Webhook
 * =========================
 */
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];

  for (const event of events) {
    try {
      if (event.type !== "message") continue;
      if (event.message?.type !== "text") continue;

      const userId = event.source?.userId;
      const replyToken = event.replyToken;
      const userText = (event.message.text || "").trim();

      if (!userId || !replyToken) continue;

      console.log("============");
      console.log("收到訊息:", userText);
      console.log("userId:", userId);
      console.log("目前 session:", userSessions.get(userId));

      /**
       * 建立任務指令
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
       * 立即估價指令
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
       * 沒有流程狀態時，避免完全沒反應
       */
      if (!session) {
        await replyMessage(replyToken, "請重新點選下方功能開始。");
        continue;
      }

      /**
       * =========================
       * 建立任務流程
       * =========================
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

        try {
          const pickupAddress = normalizeAddress(form.data.pickupAddress);
          const dropoffAddress = normalizeAddress(form.data.dropoffAddress);
          const pickupPhone = form.data.pickupPhone;
          const dropoffPhone = form.data.dropoffPhone;
          const itemContent = form.data.itemContent;
          const isUrgent = parseUrgent(form.data.isUrgent);

          validatePhone(pickupPhone, "取件電話");
          validatePhone(dropoffPhone, "送達電話");
          validateItemContent(itemContent);

          const routeInfo = await getRouteInfo(pickupAddress, dropoffAddress);
          const fee = calculateFee(
            routeInfo.distanceKm,
            routeInfo.durationMin,
            isUrgent
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

          // 先推群組，成功後再回客人
          await pushMessage(TARGET_GROUP_ID, groupMessage);

          await replyMessage(
            replyToken,
            "任務已建立成功，我們會儘快為您安排。"
          );

          userSessions.delete(userId);
          console.log("建立任務完成，session 已清除");
        } catch (err) {
          console.error("建立任務失敗:", err.message);
          console.error("建立任務錯誤回傳:", err.response?.data || "無 response data");

          await replyMessage(
            replyToken,
            mapCreateTaskErrorMessage(err)
          );
        }

        continue;
      }

      /**
       * =========================
       * 立即估價流程
       * =========================
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

        try {
          const pickupAddress = normalizeAddress(form.data.pickupAddress);
          const dropoffAddress = normalizeAddress(form.data.dropoffAddress);
          const itemContent = form.data.itemContent;
          const isUrgent = parseUrgent(form.data.isUrgent);

          validateItemContent(itemContent);

          const routeInfo = await getRouteInfo(pickupAddress, dropoffAddress);
          const fee = calculateFee(
            routeInfo.distanceKm,
            routeInfo.durationMin,
            isUrgent
          );

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
        } catch (err) {
          console.error("立即估價失敗:", err.message);
          console.error("立即估價錯誤回傳:", err.response?.data || "無 response data");

          await replyMessage(
            replyToken,
            mapQuoteErrorMessage(err)
          );
        }

        continue;
      }

      /**
       * 其他未知流程
       */
      await replyMessage(replyToken, "請重新點選下方功能開始。");
    } catch (err) {
      /**
       * 最外層只記錄，不再重複 reply
       * 避免 replyToken 被重複使用
       */
      console.error("Webhook 單一事件未預期錯誤:", err.message);
      console.error("Webhook 單一事件錯誤回傳:", err.response?.data || "無 response data");
    }
  }

  res.sendStatus(200);
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
    .replace(/[．。.、]/g, "")
    .replace(/：/g, ":");
}

/**
 * =========================
 * 建立任務表單解析
 * =========================
 */
function parseCreateTaskForm(text) {
  let normalized = (text || "").replace(/\r/g, "").trim();

  normalized = normalized
    .replace(/^請依格式填寫[:：]?\s*/m, "")
    .trim();

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

  normalized = normalized
    .replace(/^您可以先快速取得任務費用估算，請提供[:：]?\s*/m, "")
    .trim();

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
 * 簡單驗證
 * =========================
 */
function validatePhone(phone, label) {
  const cleaned = String(phone).replace(/\D/g, "");
  if (cleaned.length < 8 || cleaned.length > 12) {
    throw new Error(`${label}格式不正確`);
  }
}

function validateItemContent(itemContent) {
  const text = String(itemContent || "").trim();

  if (!text) {
    throw new Error("物品內容不得空白");
  }

  // 你若不想阻擋食品，可刪掉這段
  if (text.includes("食品")) {
    throw new Error("目前不配送食品");
  }
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
      },
      timeout: 15000
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
      },
      timeout: 15000
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
 * 錯誤訊息轉換
 * =========================
 */
function mapCreateTaskErrorMessage(err) {
  const msg = err.message || "";

  if (msg.includes("取件電話格式不正確")) return "取件電話格式不正確，請重新確認。";
  if (msg.includes("送達電話格式不正確")) return "送達電話格式不正確，請重新確認。";
  if (msg.includes("目前不配送食品")) return "目前不配送食品，請重新確認物品內容。";
  if (msg.includes("地址解析失敗")) return "地址無法辨識，請輸入更完整的地址。";
  if (msg.includes("REQUEST_DENIED")) return "地圖服務尚未設定完成，請稍後再試。";
  if (msg.includes("GOOGLE_MAPS_API_KEY")) return "地圖服務尚未設定完成，請稍後再試。";
  if (msg.includes("TARGET_GROUP_ID")) return "派單群組尚未設定完成，請稍後再試。";

  return "任務建立失敗，請稍後再試一次。";
}

function mapQuoteErrorMessage(err) {
  const msg = err.message || "";

  if (msg.includes("目前不配送食品")) return "目前不配送食品，請重新確認物品內容。";
  if (msg.includes("地址解析失敗")) return "地址無法辨識，請輸入更完整的地址。";
  if (msg.includes("REQUEST_DENIED")) return "地圖服務尚未設定完成，暫時無法估價。";
  if (msg.includes("GOOGLE_MAPS_API_KEY")) return "地圖服務尚未設定完成，暫時無法估價。";

  return "目前無法取得預估費用，請稍後再試一次。";
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
      },
      timeout: 15000
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
      },
      timeout: 15000
    }
  );
}

app.listen(PORT, () => {
  console.log(`UBee bot running on port ${PORT}`);
});
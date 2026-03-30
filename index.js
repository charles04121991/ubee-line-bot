const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID;
const PORT = process.env.PORT || 3000;

// ===== 記憶資料（MVP版本，Render重啟後會清空）=====
const userSessions = new Map();
const tasks = new Map();
let taskCounter = 1;

// ===== 基本設定 =====
const PRICING = {
  baseFee: 99,
  perKm: 6,
  perMinute: 3,
  crossAreaBase: 25,
  urgentFee: 100,
  tax: 15
};

// ===== 工具函式 =====
function createTaskId() {
  const id = String(taskCounter).padStart(4, "0");
  taskCounter++;
  return `UB${id}`;
}

function getUserSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {});
  }
  return userSessions.get(userId);
}

function resetUserSession(userId) {
  userSessions.set(userId, {});
}

async function replyMessage(replyToken, text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [{ type: "text", text }]
    },
    {
      headers: {
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

async function pushMessage(to, text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to,
      messages: [{ type: "text", text }]
    },
    {
      headers: {
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

async function getDistanceAndDuration(origin, destination) {
  const url = "https://maps.googleapis.com/maps/api/distancematrix/json";

  const response = await axios.get(url, {
    params: {
      origins: origin,
      destinations: destination,
      language: "zh-TW",
      key: GOOGLE_MAPS_API_KEY
    }
  });

  const row = response.data.rows?.[0];
  const element = row?.elements?.[0];

  if (!element || element.status !== "OK") {
    throw new Error("Google Maps 無法取得距離與時間");
  }

  const distanceMeters = element.distance.value;
  const durationSeconds = element.duration.value;

  return {
    distanceKm: distanceMeters / 1000,
    durationMin: Math.ceil(durationSeconds / 60),
    distanceText: element.distance.text,
    durationText: element.duration.text
  };
}

async function geocodeAddress(address) {
  const url = "https://maps.googleapis.com/maps/api/geocode/json";

  const response = await axios.get(url, {
    params: {
      address,
      language: "zh-TW",
      key: GOOGLE_MAPS_API_KEY
    }
  });

  const result = response.data.results?.[0];
  if (!result) {
    throw new Error("Google Maps 無法解析地址");
  }

  const components = result.address_components || [];

  const districtComponent =
    components.find(c => c.types.includes("administrative_area_level_3")) ||
    components.find(c => c.types.includes("administrative_area_level_2")) ||
    components.find(c => c.types.includes("locality")) ||
    null;

  return {
    formattedAddress: result.formatted_address,
    district: districtComponent ? districtComponent.long_name : ""
  };
}

function calculateCrossAreaFee(pickupDistrict, deliveryDistrict, distanceKm) {
  if (!pickupDistrict || !deliveryDistrict) return 0;
  if (pickupDistrict === deliveryDistrict) return 0;

  const multiplier = Math.max(1, Math.ceil(distanceKm / 5));
  return PRICING.crossAreaBase * multiplier;
}

function calculatePrice({ distanceKm, durationMin, urgent, memberDiscount = 0, crossAreaFee = 0 }) {
  const baseFee = PRICING.baseFee;
  const kmFee = Math.ceil(distanceKm) * PRICING.perKm;
  const timeFee = Math.ceil(durationMin) * PRICING.perMinute;
  const urgentFee = urgent ? PRICING.urgentFee : 0;

  const deliveryFee = baseFee + kmFee + timeFee + crossAreaFee + urgentFee;
  const subtotal = Math.max(0, deliveryFee - memberDiscount);
  const tax = PRICING.tax;
  const total = subtotal + tax;

  return {
    baseFee,
    kmFee,
    timeFee,
    crossAreaFee,
    urgentFee,
    deliveryFee,
    memberDiscount,
    subtotal,
    tax,
    total
  };
}

function formatPriceBreakdown(price, isEstimate = false) {
  let text = "";

  if (isEstimate) {
    text += "【UBee 預估費用】\n";
  } else {
    text += "【UBee 費用資訊】\n";
  }

  text += `配送費：$${price.deliveryFee}\n`;
  text += `會員折扣：-$${price.memberDiscount}\n`;
  text += `小計：$${price.subtotal}\n`;
  text += `稅金：$${price.tax}\n`;
  text += `總計：$${price.total}`;

  if (isEstimate) {
    text += `\n\n提醒：此為預估費用，非最終報價`;
  }

  return text;
}

function formatTaskForGroup(task) {
  return `【UBee 新任務通知】
任務編號：${task.taskId}
類型：正式下單
客戶ID：${task.userId}

取件地點：${task.pickup}
送達地點：${task.delivery}
物品內容：${task.item}
是否急件：${task.urgent ? "是" : "否"}
聯絡電話：${task.phone}

距離：約 ${task.distanceText}
時間：約 ${task.durationText}
取件區域：${task.pickupDistrict || "未辨識"}
送達區域：${task.deliveryDistrict || "未辨識"}

配送費：$${task.price.deliveryFee}
會員折扣：-$${task.price.memberDiscount}
小計：$${task.price.subtotal}
稅金：$${task.price.tax}
總計：$${task.price.total}

騎手可輸入：
接單 ${task.taskId}
抵達 ${task.taskId}`;
}

function formatTaskCreatedMessage(task) {
  return `好的，您的任務已建立 ✅

任務編號：${task.taskId}
取件地點：${task.pickup}
送達地點：${task.delivery}
物品內容：${task.item}
是否急件：${task.urgent ? "是" : "否"}
聯絡電話：${task.phone}

${formatPriceBreakdown(task.price, false)}

如需取消任務，請直接輸入：
取消`;
}

async function buildTaskData(session, userId, mode) {
  const pickupGeo = await geocodeAddress(session.pickup);
  const deliveryGeo = await geocodeAddress(session.delivery);
  const route = await getDistanceAndDuration(session.pickup, session.delivery);

  const crossAreaFee = calculateCrossAreaFee(
    pickupGeo.district,
    deliveryGeo.district,
    route.distanceKm
  );

  const memberDiscount = 0;

  const price = calculatePrice({
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
    urgent: session.urgent,
    memberDiscount,
    crossAreaFee
  });

  return {
    taskId: createTaskId(),
    mode,
    userId,
    pickup: session.pickup,
    delivery: session.delivery,
    item: session.item,
    urgent: session.urgent,
    phone: session.phone,
    pickupDistrict: pickupGeo.district,
    deliveryDistrict: deliveryGeo.district,
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
    distanceText: route.distanceText,
    durationText: route.durationText,
    price,
    status: mode === "order" ? "pending" : "quoted",
    createdAt: new Date().toISOString()
  };
}

// ===== 使用者流程引導 =====
function getWelcomeText() {
  return `您好，這裡是 UBee 城市任務 👋

請直接輸入以下功能：
1. 建立任務
2. 立即下單
3. 立即估價

如您要取消已建立的任務，也可直接輸入：
取消`;
}

function startFlow(userId, mode) {
  userSessions.set(userId, {
    mode,
    step: "pickup"
  });
}

function getStepQuestion(step, mode) {
  const modeText =
    mode === "quote" ? "立即估價" : "建立任務";

  switch (step) {
    case "pickup":
      return `【${modeText}】\n請輸入取件地點`;
    case "delivery":
      return `請輸入送達地點`;
    case "item":
      return `請輸入物品內容`;
    case "urgent":
      return `是否急件？請輸入：是 / 否`;
    case "phone":
      return `請輸入聯絡電話`;
    default:
      return getWelcomeText();
  }
}

// ===== 群組指令處理 =====
async function handleGroupMessage(event, userText) {
  const groupId = event.source.groupId;
  const replyToken = event.replyToken;

  if (TARGET_GROUP_ID && groupId !== TARGET_GROUP_ID) {
    await replyMessage(replyToken, "此群組非 UBee 指定派單群組");
    return;
  }

  if (userText.startsWith("接單 ")) {
    const taskId = userText.replace("接單 ", "").trim();
    const task = tasks.get(taskId);

    if (!task) {
      await replyMessage(replyToken, "找不到此任務編號");
      return;
    }

    if (task.status !== "pending") {
      await replyMessage(replyToken, `任務 ${taskId} 目前狀態為 ${task.status}，不可接單`);
      return;
    }

    task.status = "accepted";
    task.acceptedAt = new Date().toISOString();

    await replyMessage(replyToken, `已成功接下任務 ${taskId} ✅`);

    await pushMessage(
      task.userId,
      `您好，您的任務 ${taskId} 已有騎手接單，我們會盡快為您配送，感謝您的耐心等候。`
    );
    return;
  }

  if (userText.startsWith("抵達 ")) {
    const taskId = userText.replace("抵達 ", "").trim();
    const task = tasks.get(taskId);

    if (!task) {
      await replyMessage(replyToken, "找不到此任務編號");
      return;
    }

    task.status = "completed";
    task.completedAt = new Date().toISOString();

    await replyMessage(replyToken, `任務 ${taskId} 已標記完成 ✅`);

    await pushMessage(
      task.userId,
      "騎手已抵達您的送達地點，本次任務已完成"
    );
    return;
  }

  await replyMessage(
    replyToken,
    `可使用指令：
接單 任務編號
抵達 任務編號`
  );
}

// ===== 使用者訊息處理 =====
async function handleUserMessage(event, userText) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const session = getUserSession(userId);

  // 主入口
  if (["你好", "哈囉", "嗨", "您好", "menu", "開始"].includes(userText)) {
    resetUserSession(userId);
    await replyMessage(replyToken, getWelcomeText());
    return;
  }

  // 建立任務 / 立即下單 都走正式下單流程
  if (userText === "建立任務" || userText === "立即下單") {
    startFlow(userId, "order");
    await replyMessage(replyToken, getStepQuestion("pickup", "order"));
    return;
  }

  if (userText === "立即估價") {
    startFlow(userId, "quote");
    await replyMessage(replyToken, getStepQuestion("pickup", "quote"));
    return;
  }

  // 取消任務流程
  if (userText === "取消") {
    session.step = "cancel_choice";
    await replyMessage(
      replyToken,
      `請輸入以下選項：
1. 持續安排騎手
2. 取消本次任務`
    );
    return;
  }

  if (session.step === "cancel_choice") {
    if (userText === "1") {
      resetUserSession(userId);
      await replyMessage(
        replyToken,
        "好的！我們會持續為您安排騎手，一有騎手接單會第一時間通知您，感謝您的耐心等候"
      );
      return;
    }

    if (userText === "2") {
      resetUserSession(userId);
      await replyMessage(
        replyToken,
        "好的，已為您取消本次任務，因目前尚未派單，本次退款費用給您，若之後還有需要，歡迎再找 UBee城市任務跑腿"
      );
      return;
    }

    await replyMessage(replyToken, "請輸入 1 或 2");
    return;
  }

  if (!session.step) {
    await replyMessage(replyToken, getWelcomeText());
    return;
  }

  // 取件地點
  if (session.step === "pickup") {
    session.pickup = userText;
    session.step = "delivery";
    await replyMessage(replyToken, getStepQuestion("delivery", session.mode));
    return;
  }

  // 送達地點
  if (session.step === "delivery") {
    session.delivery = userText;
    session.step = "item";
    await replyMessage(replyToken, getStepQuestion("item", session.mode));
    return;
  }

  // 物品內容
  if (session.step === "item") {
    session.item = userText;
    session.step = "urgent";
    await replyMessage(replyToken, getStepQuestion("urgent", session.mode));
    return;
  }

  // 是否急件
  if (session.step === "urgent") {
    if (!["是", "否"].includes(userText)) {
      await replyMessage(replyToken, "請輸入：是 / 否");
      return;
    }

    session.urgent = userText === "是";
    session.step = "phone";
    await replyMessage(replyToken, getStepQuestion("phone", session.mode));
    return;
  }

  // 聯絡電話
  if (session.step === "phone") {
    session.phone = userText;

    // 立即估價
    if (session.mode === "quote") {
      try {
        const taskData = await buildTaskData(session, userId, "quote");
        tasks.set(taskData.taskId, taskData);

        resetUserSession(userId);

        await replyMessage(
          replyToken,
          `${formatPriceBreakdown(taskData.price, true)}`
        );
        return;
      } catch (error) {
        console.error("立即估價錯誤：", error.message);
        resetUserSession(userId);
        await replyMessage(
          replyToken,
          "抱歉，目前無法完成估價，請確認地址是否正確，稍後再試一次。"
        );
        return;
      }
    }

    // 建立任務 / 立即下單：輸入電話後直接建立
    if (session.mode === "order") {
      try {
        const finalTask = await buildTaskData(session, userId, "order");
        tasks.set(finalTask.taskId, finalTask);

        await replyMessage(replyToken, formatTaskCreatedMessage(finalTask));

        if (TARGET_GROUP_ID) {
          await pushMessage(TARGET_GROUP_ID, formatTaskForGroup(finalTask));
        }

        resetUserSession(userId);
        return;
      } catch (error) {
        console.error("正式建立任務錯誤：", error.message);
        resetUserSession(userId);
        await replyMessage(
          replyToken,
          "抱歉，目前無法建立任務，請確認地址是否正確，稍後再試一次。"
        );
        return;
      }
    }
  }

  await replyMessage(replyToken, getWelcomeText());
}

// ===== Webhook =====
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

        const userText = (event.message.text || "").trim();

        if (event.source.type === "group") {
          await handleGroupMessage(event, userText);
          continue;
        }

        if (event.source.type === "user") {
          await handleUserMessage(event, userText);
          continue;
        }
      } catch (innerError) {
        console.error("單一事件處理失敗：", innerError.message);
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook錯誤：", error.message);
    res.status(500).send("Error");
  }
});

app.listen(PORT, () => {
  console.log(`UBee bot running on port ${PORT}`);
});
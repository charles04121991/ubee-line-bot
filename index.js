const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const PORT = process.env.PORT || 3000;

if (!CHANNEL_ACCESS_TOKEN || !TARGET_GROUP_ID || !GOOGLE_MAPS_API_KEY) {
  console.error(
    "缺少必要環境變數，請檢查：CHANNEL_ACCESS_TOKEN / TARGET_GROUP_ID / GOOGLE_MAPS_API_KEY"
  );
  process.exit(1);
}

/**
 * 使用者暫存流程
 */
const userSessions = {};

/**
 * 服務區域
 */
const SERVICE_AREAS = ["豐原", "潭子", "神岡", "大雅", "北屯"];

/**
 * 客人端費率
 */
const CUSTOMER_PRICING = {
  baseFee: 99,
  perKm: 6,
  perMinute: 3,
  crossAreaFee: 25,
  urgentFee: 100,
  memberDiscount: 99,
  tax: 15,
};

/**
 * 騎手端費率
 */
const RIDER_PRICING = {
  baseFee: 99,
  perKm: 6,
  perMinute: 3,
  crossAreaFee: 25,
  urgentShareRate: 0.6,
};

function isMember(userId) {
  return false;
}

function normalizePhone(phone = "") {
  return phone.replace(/\s+/g, "").trim();
}

function detectArea(address = "") {
  for (const area of SERVICE_AREAS) {
    if (address.includes(area)) return area;
  }
  return null;
}

function calculateCrossAreaFee(pickupAddress, deliveryAddress, fee = 25) {
  const pickupArea = detectArea(pickupAddress);
  const deliveryArea = detectArea(deliveryAddress);

  if (!pickupArea || !deliveryArea) return fee;
  if (pickupArea === deliveryArea) return 0;
  return fee;
}

/**
 * Google Maps 距離與時間
 */
async function getDistanceAndDuration(origin, destination) {
  const url = "https://maps.googleapis.com/maps/api/distancematrix/json";

  const response = await axios.get(url, {
    params: {
      origins: origin,
      destinations: destination,
      key: GOOGLE_MAPS_API_KEY,
      language: "zh-TW",
      region: "tw",
      units: "metric",
      mode: "driving",
    },
    timeout: 15000,
  });

  const data = response.data;

  if (
    !data ||
    !data.rows ||
    !data.rows[0] ||
    !data.rows[0].elements ||
    !data.rows[0].elements[0]
  ) {
    throw new Error("Google Maps 無法取得距離資料");
  }

  const element = data.rows[0].elements[0];

  if (element.status !== "OK") {
    throw new Error(`Google Maps 距離計算失敗：${element.status}`);
  }

  const distanceMeters = element.distance.value;
  const durationSeconds = element.duration.value;

  const distanceKm = Math.ceil(distanceMeters / 1000);
  const durationMinutes = Math.ceil(durationSeconds / 60);

  return {
    distanceKm,
    durationMinutes,
    distanceText: element.distance.text,
    durationText: element.duration.text,
  };
}

function calculateCustomerPrice({
  distanceKm,
  durationMinutes,
  pickupAddress,
  deliveryAddress,
  isUrgent,
  isMemberUser,
}) {
  const baseFee = CUSTOMER_PRICING.baseFee;
  const distanceFee = distanceKm * CUSTOMER_PRICING.perKm;
  const timeFee = durationMinutes * CUSTOMER_PRICING.perMinute;
  const crossAreaFee = calculateCrossAreaFee(
    pickupAddress,
    deliveryAddress,
    CUSTOMER_PRICING.crossAreaFee
  );
  const urgentFee = isUrgent ? CUSTOMER_PRICING.urgentFee : 0;

  const deliveryFee =
    baseFee + distanceFee + timeFee + crossAreaFee + urgentFee;

  const memberDiscount = isMemberUser ? CUSTOMER_PRICING.memberDiscount : 0;
  const subtotal = Math.max(deliveryFee - memberDiscount, 0);
  const tax = CUSTOMER_PRICING.tax;
  const total = subtotal + tax;

  return {
    baseFee,
    distanceFee,
    timeFee,
    crossAreaFee,
    urgentFee,
    deliveryFee,
    memberDiscount,
    subtotal,
    tax,
    total,
  };
}

function calculateRiderPrice({
  distanceKm,
  durationMinutes,
  pickupAddress,
  deliveryAddress,
  isUrgent,
}) {
  const baseFee = RIDER_PRICING.baseFee;
  const distanceFee = distanceKm * RIDER_PRICING.perKm;
  const timeFee = durationMinutes * RIDER_PRICING.perMinute;
  const crossAreaFee = calculateCrossAreaFee(
    pickupAddress,
    deliveryAddress,
    RIDER_PRICING.crossAreaFee
  );

  const urgentShare = isUrgent
    ? Math.round(CUSTOMER_PRICING.urgentFee * RIDER_PRICING.urgentShareRate)
    : 0;

  const riderTotal =
    baseFee + distanceFee + timeFee + crossAreaFee + urgentShare;

  return {
    baseFee,
    distanceFee,
    timeFee,
    crossAreaFee,
    urgentShare,
    riderTotal,
  };
}

function buildQuote({
  pickupAddress,
  pickupContact,
  deliveryAddress,
  deliveryContact,
  itemContent,
  isUrgent,
  note,
  customerPrice,
  riderPrice,
  distanceText,
  durationText,
}) {
  return {
    pickupAddress,
    pickupContact,
    deliveryAddress,
    deliveryContact,
    itemContent,
    isUrgent,
    note,
    customerPrice,
    riderPrice,
    distanceText,
    durationText,
  };
}

/**
 * 客人端顯示：建立任務後的報價
 */
function buildCustomerQuoteText(quote) {
  const urgentText = quote.isUrgent ? "是" : "否";

  return [
    "【UBee 預估報價】",
    `取件地點：${quote.pickupAddress}`,
    `送達地點：${quote.deliveryAddress}`,
    `物品內容：${quote.itemContent}`,
    `是否急件：${urgentText}`,
    "",
    `配送費：$${quote.customerPrice.deliveryFee}`,
    `會員折扣：-$${quote.customerPrice.memberDiscount}`,
    `小計：$${quote.customerPrice.subtotal}`,
    `稅金：$${quote.customerPrice.tax}`,
    `客人總計：$${quote.customerPrice.total}`,
    "",
    "請確認是否送出任務。",
  ].join("\n");
}

/**
 * 客人端顯示：立即估價
 */
function buildEstimateOnlyText(quote) {
  const urgentText = quote.isUrgent ? "是" : "否";

  return [
    "【UBee 即時估價】",
    `取件地點：${quote.pickupAddress}`,
    `送達地點：${quote.deliveryAddress}`,
    `物品內容：${quote.itemContent}`,
    `是否急件：${urgentText}`,
    "",
    `配送費：$${quote.customerPrice.deliveryFee}`,
    `會員折扣：-$${quote.customerPrice.memberDiscount}`,
    `小計：$${quote.customerPrice.subtotal}`,
    `稅金：$${quote.customerPrice.tax}`,
    `預估總計：$${quote.customerPrice.total}`,
    "",
    "📌 此為預估費用，非最終報價",
  ].join("\n");
}

/**
 * 群組派單格式
 */
function buildGroupTaskText(quote, userId) {
  const urgentText = quote.isUrgent ? "是" : "否";

  return [
    "【UBee 新任務通知】",
    "",
    `費用：$${quote.riderPrice.riderTotal}`,
    "",
    `距離：${quote.distanceText}（${quote.durationText}）`,
    "",
    `客戶ID：${userId}`,
    "",
    `取件：${quote.pickupAddress}`,
    `取件人 / 電話：${quote.pickupContact || "未提供"}`,
    "",
    `送達：${quote.deliveryAddress}`,
    `收件人 / 電話：${quote.deliveryContact || "未提供"}`,
    "",
    `物品：${quote.itemContent}`,
    `急件：${urgentText}`,
    `備註：${quote.note || "無"}`,
    "",
    "———",
  ].join("\n");
}

/**
 * Quick Reply
 */
function createQuickReply(items = []) {
  return {
    items: items.map((item) => ({
      type: "action",
      action: {
        type: "message",
        label: item.label,
        text: item.text,
      },
    })),
  };
}

function textMessage(text, quickReplyItems = null) {
  const message = {
    type: "text",
    text,
  };

  if (quickReplyItems && quickReplyItems.length > 0) {
    message.quickReply = createQuickReply(quickReplyItems);
  }

  return message;
}

/**
 * 常用按鈕
 */
function getMainMenuQuickReply() {
  return [
    { label: "建立任務", text: "建立任務" },
    { label: "立即估價", text: "立即估價" },
    { label: "取消流程", text: "取消" },
  ];
}

function getTaskConfirmQuickReply() {
  return [
    { label: "確認送出", text: "確認送出" },
    { label: "重新填寫", text: "建立任務" },
    { label: "取消流程", text: "取消" },
  ];
}

function getEstimateQuickReply() {
  return [
    { label: "建立任務", text: "建立任務" },
    { label: "再估一次", text: "立即估價" },
    { label: "取消流程", text: "取消" },
  ];
}

function getCancelOnlyQuickReply() {
  return [{ label: "取消流程", text: "取消" }];
}

/**
 * LINE reply
 */
async function replyMessages(replyToken, messages) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages,
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
      timeout: 15000,
    }
  );
}

async function replyText(replyToken, text, quickReplyItems = null) {
  await replyMessages(replyToken, [textMessage(text, quickReplyItems)]);
}

/**
 * 推播到群組
 */
async function pushToGroup(text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: TARGET_GROUP_ID,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
      timeout: 15000,
    }
  );
}

function createSession(userId) {
  userSessions[userId] = {
    mode: null, // estimate / task
    waitingTemplateInput: false,
    quote: null,
    readyToConfirm: false,
  };
  return userSessions[userId];
}

function getSession(userId) {
  if (!userSessions[userId]) return createSession(userId);
  return userSessions[userId];
}

function resetSession(userId) {
  delete userSessions[userId];
}

/**
 * 建立任務範本
 */
function getTaskTemplateText() {
  return [
    "請依下列格式填寫並整段回傳：",
    "",
    "取件地點：",
    "取件人 / 電話：",
    "",
    "送達地點：",
    "收件人 / 電話：",
    "",
    "物品內容：",
    "是否急件：",
    "",
    "備註：",
    "",
    "※ 不配送食品、違禁品或危險物品，若為急件請於備註註明「急件」",
    "——————",
  ].join("\n");
}

/**
 * 立即估價範本
 */
function getEstimateTemplateText() {
  return [
    "您可以先快速取得任務費用估算，請提供：",
    "",
    "取件地點：",
    "送達地點：",
    "物品內容：",
    "是否急件：",
    "",
    "———",
    "",
    "📌 我們將為您即時計算預估費用（非最終報價）",
  ].join("\n");
}

/**
 * 解析建立任務內容
 */
function parseTaskTemplate(text) {
  const lines = text.split("\n").map((line) => line.trim());

  const data = {
    pickupAddress: "",
    pickupContact: "",
    deliveryAddress: "",
    deliveryContact: "",
    itemContent: "",
    isUrgentRaw: "",
    note: "",
  };

  for (const line of lines) {
    if (line.startsWith("取件地點：")) {
      data.pickupAddress = line.replace("取件地點：", "").trim();
    } else if (line.startsWith("取件人 / 電話：")) {
      data.pickupContact = line.replace("取件人 / 電話：", "").trim();
    } else if (line.startsWith("送達地點：")) {
      data.deliveryAddress = line.replace("送達地點：", "").trim();
    } else if (line.startsWith("收件人 / 電話：")) {
      data.deliveryContact = line.replace("收件人 / 電話：", "").trim();
    } else if (line.startsWith("物品內容：")) {
      data.itemContent = line.replace("物品內容：", "").trim();
    } else if (line.startsWith("是否急件：")) {
      data.isUrgentRaw = line.replace("是否急件：", "").trim();
    } else if (line.startsWith("備註：")) {
      data.note = line.replace("備註：", "").trim();
    }
  }

  const isUrgent =
    data.isUrgentRaw === "是" ||
    data.isUrgentRaw === "急件" ||
    data.note.includes("急件");

  return {
    pickupAddress: data.pickupAddress,
    pickupContact: normalizePhone(data.pickupContact),
    deliveryAddress: data.deliveryAddress,
    deliveryContact: normalizePhone(data.deliveryContact),
    itemContent: data.itemContent,
    isUrgent,
    note: data.note,
  };
}

/**
 * 解析立即估價內容
 */
function parseEstimateTemplate(text) {
  const lines = text.split("\n").map((line) => line.trim());

  const data = {
    pickupAddress: "",
    deliveryAddress: "",
    itemContent: "",
    isUrgentRaw: "",
  };

  for (const line of lines) {
    if (line.startsWith("取件地點：")) {
      data.pickupAddress = line.replace("取件地點：", "").trim();
    } else if (line.startsWith("送達地點：")) {
      data.deliveryAddress = line.replace("送達地點：", "").trim();
    } else if (line.startsWith("物品內容：")) {
      data.itemContent = line.replace("物品內容：", "").trim();
    } else if (line.startsWith("是否急件：")) {
      data.isUrgentRaw = line.replace("是否急件：", "").trim();
    }
  }

  const isUrgent =
    data.isUrgentRaw === "是" || data.isUrgentRaw === "急件";

  return {
    pickupAddress: data.pickupAddress,
    deliveryAddress: data.deliveryAddress,
    itemContent: data.itemContent,
    isUrgent,
  };
}

function validateTaskData(task) {
  if (!task.pickupAddress) return "請填寫取件地點";
  if (!task.pickupContact) return "請填寫取件人 / 電話";
  if (!task.deliveryAddress) return "請填寫送達地點";
  if (!task.deliveryContact) return "請填寫收件人 / 電話";
  if (!task.itemContent) return "請填寫物品內容";
  return null;
}

function validateEstimateData(data) {
  if (!data.pickupAddress) return "請填寫取件地點";
  if (!data.deliveryAddress) return "請填寫送達地點";
  if (!data.itemContent) return "請填寫物品內容";
  return null;
}

app.get("/", (req, res) => {
  res.status(200).send("UBee bot running");
});

app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      try {
        if (event.type !== "message") continue;
        if (event.message?.type !== "text") continue;

        const userText = (event.message.text || "").trim();
        const replyToken = event.replyToken;
        const userId = event.source?.userId;

        if (!replyToken || !userId) continue;

        const session = getSession(userId);

        if (["你好", "哈囉", "嗨", "選單", "開始"].includes(userText)) {
          await replyText(
            replyToken,
            [
              "您好，這裡是 UBee 城市任務。",
              "",
              "請選擇您要的功能：",
            ].join("\n"),
            getMainMenuQuickReply()
          );
          continue;
        }

        if (userText === "取消" || userText === "重新開始") {
          resetSession(userId);
          await replyText(
            replyToken,
            [
              "已取消目前流程。",
              "",
              "請重新選擇功能：",
            ].join("\n"),
            getMainMenuQuickReply()
          );
          continue;
        }

        /**
         * 建立任務
         */
        if (userText === "建立任務") {
          const next = createSession(userId);
          next.mode = "task";
          next.waitingTemplateInput = true;

          await replyText(
            replyToken,
            getTaskTemplateText(),
            getCancelOnlyQuickReply()
          );
          continue;
        }

        /**
         * 立即估價
         */
        if (userText === "立即估價") {
          const next = createSession(userId);
          next.mode = "estimate";
          next.waitingTemplateInput = true;

          await replyText(
            replyToken,
            getEstimateTemplateText(),
            getCancelOnlyQuickReply()
          );
          continue;
        }

        /**
         * 確認送出
         */
        if (userText === "確認送出") {
          if (!session.readyToConfirm || !session.quote || session.mode !== "task") {
            await replyText(
              replyToken,
              "目前沒有可送出的任務，請先選擇「建立任務」。",
              getMainMenuQuickReply()
            );
            continue;
          }

          const groupText = buildGroupTaskText(session.quote, userId);
          await pushToGroup(groupText);

          await replyText(
            replyToken,
            [
              "您的任務已成功送出 ✅",
              `本次總計：$${session.quote.customerPrice.total}`,
              "",
              "我們會盡快為您安排。",
            ].join("\n"),
            getMainMenuQuickReply()
          );

          resetSession(userId);
          continue;
        }

        /**
         * 等待使用者貼上建立任務內容
         */
        if (session.waitingTemplateInput && session.mode === "task") {
          const taskData = parseTaskTemplate(userText);
          const error = validateTaskData(taskData);

          if (error) {
            await replyText(
              replyToken,
              `${error}\n\n請依下列格式重新填寫：\n\n${getTaskTemplateText()}`,
              getCancelOnlyQuickReply()
            );
            continue;
          }

          const mapResult = await getDistanceAndDuration(
            taskData.pickupAddress,
            taskData.deliveryAddress
          );

          const member = isMember(userId);

          const customerPrice = calculateCustomerPrice({
            distanceKm: mapResult.distanceKm,
            durationMinutes: mapResult.durationMinutes,
            pickupAddress: taskData.pickupAddress,
            deliveryAddress: taskData.deliveryAddress,
            isUrgent: taskData.isUrgent,
            isMemberUser: member,
          });

          const riderPrice = calculateRiderPrice({
            distanceKm: mapResult.distanceKm,
            durationMinutes: mapResult.durationMinutes,
            pickupAddress: taskData.pickupAddress,
            deliveryAddress: taskData.deliveryAddress,
            isUrgent: taskData.isUrgent,
          });

          session.quote = buildQuote({
            pickupAddress: taskData.pickupAddress,
            pickupContact: taskData.pickupContact,
            deliveryAddress: taskData.deliveryAddress,
            deliveryContact: taskData.deliveryContact,
            itemContent: taskData.itemContent,
            isUrgent: taskData.isUrgent,
            note: taskData.note,
            customerPrice,
            riderPrice,
            distanceText: mapResult.distanceText,
            durationText: mapResult.durationText,
          });

          session.waitingTemplateInput = false;
          session.readyToConfirm = true;

          await replyText(
            replyToken,
            buildCustomerQuoteText(session.quote),
            getTaskConfirmQuickReply()
          );
          continue;
        }

        /**
         * 等待使用者貼上立即估價內容
         */
        if (session.waitingTemplateInput && session.mode === "estimate") {
          const estimateData = parseEstimateTemplate(userText);
          const error = validateEstimateData(estimateData);

          if (error) {
            await replyText(
              replyToken,
              `${error}\n\n請依下列格式重新填寫：\n\n${getEstimateTemplateText()}`,
              getCancelOnlyQuickReply()
            );
            continue;
          }

          const mapResult = await getDistanceAndDuration(
            estimateData.pickupAddress,
            estimateData.deliveryAddress
          );

          const member = isMember(userId);

          const customerPrice = calculateCustomerPrice({
            distanceKm: mapResult.distanceKm,
            durationMinutes: mapResult.durationMinutes,
            pickupAddress: estimateData.pickupAddress,
            deliveryAddress: estimateData.deliveryAddress,
            isUrgent: estimateData.isUrgent,
            isMemberUser: member,
          });

          const riderPrice = calculateRiderPrice({
            distanceKm: mapResult.distanceKm,
            durationMinutes: mapResult.durationMinutes,
            pickupAddress: estimateData.pickupAddress,
            deliveryAddress: estimateData.deliveryAddress,
            isUrgent: estimateData.isUrgent,
          });

          const quote = buildQuote({
            pickupAddress: estimateData.pickupAddress,
            pickupContact: "",
            deliveryAddress: estimateData.deliveryAddress,
            deliveryContact: "",
            itemContent: estimateData.itemContent,
            isUrgent: estimateData.isUrgent,
            note: "",
            customerPrice,
            riderPrice,
            distanceText: mapResult.distanceText,
            durationText: mapResult.durationText,
          });

          resetSession(userId);

          await replyText(
            replyToken,
            buildEstimateOnlyText(quote),
            getEstimateQuickReply()
          );
          continue;
        }

        await replyText(
          replyToken,
          [
            "請選擇您要的功能：",
          ].join("\n"),
          getMainMenuQuickReply()
        );
      } catch (eventError) {
        console.error(
          "單筆事件處理失敗：",
          eventError?.response?.data || eventError.message
        );

        if (event.replyToken) {
          try {
            await replyText(
              event.replyToken,
              "系統忙碌中，請稍後再試一次。",
              getMainMenuQuickReply()
            );
          } catch (replyError) {
            console.error(
              "回覆失敗：",
              replyError?.response?.data || replyError.message
            );
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook 錯誤：", error?.response?.data || error.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`UBee bot running on port ${PORT}`);
});
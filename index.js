require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
app.use(line.middleware(config));

const PORT = process.env.PORT || 3000;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
const LINE_FINISH_GROUP_ID = process.env.LINE_FINISH_GROUP_ID;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const orders = {};
const sessions = {};

const RIDER_RATE = 0.6;

const createOrderId = () => "OD" + Date.now();

const info = (t) => ({ type: "text", text: t, size: "sm", wrap: true });

// ===== Google =====
async function getDistance(origin, dest) {
  if (!GOOGLE_MAPS_API_KEY) return { km: 5, min: 15 };

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(dest)}&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  const el = data.rows[0].elements[0];

  return {
    km: Number((el.distance.value / 1000).toFixed(1)),
    min: Math.ceil(el.duration.value / 60)
  };
}

// ===== 計價 =====
function calcPrice(km, min, urgent) {
  const base = 99;
  const distance = Math.round(km * 6);
  const time = Math.round(min * 3);
  const service = 50;
  const urgentFee = urgent ? 100 : 0;
  const system = Math.round(base * 0.3);

  const total = base + distance + time + service + urgentFee + system;

  return { base, distance, time, service, urgentFee, system, total };
}

// ===== 派單卡（騎手）=====
function dispatchFlex(o) {
  const rider = Math.round(o.total * RIDER_RATE);

  return {
    type: "flex",
    altText: "任務通知",
    contents: {
      type: "bubble",
      size: "giga",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "📦 任務通知", weight: "bold" },

          info(`取件地址：${o.pickup}`),
          info(`取件電話：${o.pickupPhone}`),

          info(`送達地址：${o.delivery}`),
          info(`送達電話：${o.deliveryPhone}`),

          info(`距離：${o.km} km`),
          info(`時間：${o.min} 分鐘`),

          {
            type: "text",
            text: `💰 可賺：$${rider}`,
            weight: "bold",
            size: "lg",
            color: "#10B981"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "button", action: { type: "postback", label: "接受", data: `ACCEPT:${o.id}` }},
          { type: "button", action: { type: "postback", label: "放棄任務", data: `REJECT:${o.id}` }}
        ]
      }
    }
  };
}

// ===== ETA =====
function etaFlex(id) {
  const times = [5,7,8,10,12,15,17,18,20,22,25,30];

  return {
    type: "flex",
    altText: "ETA",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: times.map(t => ({
          type: "button",
          action: { type: "postback", label: `${t} 分鐘`, data: `ETA:${id}:${t}` }
        }))
      }
    }
  };
}

// ===== 財務卡 =====
function financeFlex(o) {
  const rider = Math.round(o.total * RIDER_RATE);
  const platform = o.total - rider;

  return {
    type: "flex",
    altText: "財務明細",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "💰 財務明細", weight: "bold" },

          { type: "text", text: `客戶支付：$${o.total}`, weight: "bold" },

          info(`取件地址：${o.pickup}`),
          info(`送達地址：${o.delivery}`),
          info(`物品內容：${o.item}`),
          info(`任務類型：${o.urgent ? '急件' : '一般件'}`),

          info(`距離：${o.km} 公里`),
          info(`時間：${o.min} 分鐘`),

          { type: "separator" },

          info(`騎手收入：$${rider}`),
          info(`平台收入：$${platform}`),

          { type: "separator" },

          info(`急件費：$${o.price.urgentFee}`),
          info(`服務費：$${o.price.service}`),

          {
            type: "text",
            text: `附加費總額 $${o.price.urgentFee + o.price.service}`,
            color: "#EF4444",
            weight: "bold"
          }
        ]
      }
    }
  };
}

// ===== 主流程 =====
async function handlePostback(e) {
  const d = e.postback.data;
  const uid = e.source.userId;

  if (d === "CREATE") {
    sessions[uid] = { step: "pickup" };
    return client.replyMessage(e.replyToken, [{ type: "text", text: "請輸入取件地址" }]);
  }

  if (d.startsWith("ACCEPT")) {
    const id = d.split(":")[1];
    return client.replyMessage(e.replyToken, [etaFlex(id)]);
  }

  if (d.startsWith("REJECT")) {
    const id = d.split(":")[1];
    await client.pushMessage(LINE_GROUP_ID, [dispatchFlex(orders[id])]);
    return client.replyMessage(e.replyToken, [{ type: "text", text: "重新派單" }]);
  }

  if (d.startsWith("DONE")) {
    const id = d.split(":")[1];
    await client.pushMessage(LINE_FINISH_GROUP_ID, [financeFlex(orders[id])]);
    return client.replyMessage(e.replyToken, [{ type: "text", text: "完成" }]);
  }
}

// ===== 文字 =====
async function handleText(e) {
  const uid = e.source.userId;
  const text = e.message.text;
  const s = sessions[uid];

  if (!s) return;

  if (s.step === "pickup") {
    s.pickup = text;
    s.step = "pickupPhone";
    return client.replyMessage(e.replyToken, [{ type: "text", text: "請輸入取件電話" }]);
  }

  if (s.step === "pickupPhone") {
    s.pickupPhone = text;
    s.step = "delivery";
    return client.replyMessage(e.replyToken, [{ type: "text", text: "請輸入送達地址" }]);
  }

  if (s.step === "delivery") {
    s.delivery = text;
    s.step = "deliveryPhone";
    return client.replyMessage(e.replyToken, [{ type: "text", text: "請輸入送達電話" }]);
  }

  if (s.step === "deliveryPhone") {
    s.deliveryPhone = text;
    s.step = "item";
    return client.replyMessage(e.replyToken, [{ type: "text", text: "請輸入物品內容" }]);
  }

  if (s.step === "item") {
    s.item = text;

    const dist = await getDistance(s.pickup, s.delivery);
    const price = calcPrice(dist.km, dist.min, false);

    const id = createOrderId();

    orders[id] = {
      id,
      pickup: s.pickup,
      pickupPhone: s.pickupPhone,
      delivery: s.delivery,
      deliveryPhone: s.deliveryPhone,
      item: s.item,
      km: dist.km,
      min: dist.min,
      total: price.total,
      price
    };

    delete sessions[uid];

    await client.pushMessage(LINE_GROUP_ID, [dispatchFlex(orders[id])]);

    return client.replyMessage(e.replyToken, [
      { type: "text", text: `訂單成立 $${price.total}` }
    ]);
  }
}

// ===== webhook =====
app.post("/webhook", (req, res) => {
  Promise.all(req.body.events.map(async e => {
    if (e.type === "postback") return handlePostback(e);
    if (e.type === "message") return handleText(e);
  })).then(() => res.end());
});

app.listen(PORT, () => console.log("🚀 V3.8.8 FINAL RUNNING"));

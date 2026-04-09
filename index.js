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

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
const LINE_FINISH_GROUP_ID = process.env.LINE_FINISH_GROUP_ID;

const sessions = {};
const orders = {};

const createOrderId = () => "UB" + Date.now();

// ===== Google Maps =====
async function getDistance(origin, destination) {
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  const el = data.rows[0].elements[0];

  return {
    distance: el.distance.value / 1000,
    duration: Math.ceil(el.duration.value / 60)
  };
}

function navUrl(addr) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;
}

// ===== 計價 =====
function calcPrice(d, t, urgent) {
  const base = 99;
  const dist = d * 6;
  const time = t * 3;
  const service = 50;
  const urgentFee = urgent ? 100 : 0;

  const total = Math.round(base + dist + time + service + urgentFee);
  const rider = Math.round(total * 0.6);
  const platform = total - rider;

  return { total, rider, platform, dist, time, service, urgentFee };
}

// ===== Flex =====
const btn = (label, data) => ({
  type: "button",
  action: { type: "postback", label, data }
});

// 主選單
function mainFlex() {
  return {
    type: "flex",
    altText: "UBee",
    contents: {
      type: "bubble",
      body: {
        layout: "vertical",
        contents: [
          { type: "text", text: "UBee 城市任務", weight: "bold", size: "xl" },
          btn("📦 下單", "menu_order"),
          btn("🏢 企業", "menu_business"),
          btn("👤 我的", "menu_user")
        ]
      }
    }
  };
}

// 下單
function orderMenu() {
  return {
    type: "flex",
    altText: "下單",
    contents: {
      type: "bubble",
      body: {
        layout: "vertical",
        contents: [
          btn("建立任務", "create"),
          btn("立即估價", "quote"),
          btn("計費說明", "price_info"),
          btn("取消規則", "cancel_rule")
        ]
      }
    }
  };
}

// ETA
function etaFlex(id) {
  const times = [5,7,9,10,12,15,18,20,22,25];
  return {
    type: "flex",
    altText: "ETA",
    contents: {
      type: "bubble",
      body: {
        layout: "vertical",
        contents: times.map(t =>
          btn(`${t} 分鐘`, `eta_${id}_${t}`)
        )
      }
    }
  };
}

// 任務卡（騎手）
function orderFlex(o, p) {
  return {
    type: "flex",
    altText: "新任務",
    contents: {
      type: "bubble",
      body: {
        layout: "vertical",
        contents: [
          { type: "text", text: "📦 新任務", weight: "bold" },
          { type: "text", text: `訂單：${o.id}` },
          { type: "text", text: `騎手收入：$${p.rider}` },
          { type: "text", text: `取件：${o.pickup}` },
          { type: "text", text: `送達：${o.dropoff}` }
        ]
      },
      footer: {
        layout: "vertical",
        contents: [
          btn("接受訂單", `accept_${o.id}`)
        ]
      }
    }
  };
}

// 財務卡
function financeFlex(o, p, d, t) {
  return {
    type: "flex",
    altText: "財務",
    contents: {
      type: "bubble",
      body: {
        layout: "vertical",
        contents: [
          { type: "text", text: "💰 財務明細", weight: "bold" },
          { type: "text", text: `訂單：${o.id}` },

          { type: "separator" },

          { type: "text", text: `客戶支付：$${p.total}` },
          { type: "text", text: `距離：${d.toFixed(1)} km` },
          { type: "text", text: `時間：${t} 分鐘` },

          { type: "separator" },

          { type: "text", text: `騎手：$${p.rider}` },
          { type: "text", text: `平台：$${p.platform}` },

          { type: "separator" },

          { type: "text", text: `距離費：$${Math.round(p.dist)}` },
          { type: "text", text: `時間費：$${p.time}` },
          { type: "text", text: `急件：$${p.urgentFee}` },
          { type: "text", text: `服務費：$${p.service}` }
        ]
      }
    }
  };
}

// ===== webhook =====
app.post('/webhook', async (req, res) => {

  for (const event of req.body.events) {

    // ===== Message =====
    if (event.type === 'message') {
      const text = event.message.text;
      const uid = event.source.userId;

      if (text === "menu") {
        return client.replyMessage(event.replyToken, mainFlex());
      }

      if (sessions[uid]?.step === "pickup") {
        sessions[uid].pickup = text;
        sessions[uid].step = "pickupPhone";
        return client.replyMessage(event.replyToken, { type: "text", text: "輸入取件電話" });
      }

      if (sessions[uid]?.step === "pickupPhone") {
        sessions[uid].pickupPhone = text;
        sessions[uid].step = "dropoff";
        return client.replyMessage(event.replyToken, { type: "text", text: "輸入送達地址" });
      }

      if (sessions[uid]?.step === "dropoff") {
        sessions[uid].dropoff = text;
        sessions[uid].step = "dropoffPhone";
        return client.replyMessage(event.replyToken, { type: "text", text: "輸入送達電話" });
      }

      if (sessions[uid]?.step === "dropoffPhone") {
        sessions[uid].dropoffPhone = text;
        sessions[uid].step = "urgent";
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "是否急件？（輸入：急件 / 一般件）"
        });
      }

      if (text === "急件" || text === "一般件") {
        const s = sessions[uid];

        const { distance, duration } = await getDistance(s.pickup, s.dropoff);
        const price = calcPrice(distance, duration, text === "急件");

        const order = { id: createOrderId(), ...s };
        orders[order.id] = order;

        await client.pushMessage(LINE_GROUP_ID, orderFlex(order, price));
        await client.pushMessage(LINE_FINISH_GROUP_ID, financeFlex(order, price, distance, duration));

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: `✅ 建立成功\n總金額：$${price.total}`
        });
      }
    }

    // ===== Postback =====
    if (event.type === "postback") {
      const data = event.postback.data;

      if (data === "menu_order") {
        return client.replyMessage(event.replyToken, orderMenu());
      }

      if (data === "create") {
        sessions[event.source.userId] = { step: "pickup" };
        return client.replyMessage(event.replyToken, { type: "text", text: "輸入取件地址" });
      }

      if (data.startsWith("accept_")) {
        const id = data.split("_")[1];
        return client.replyMessage(event.replyToken, etaFlex(id));
      }

      if (data.startsWith("eta_")) {
        const [_, id, t] = data.split("_");
        const o = orders[id];

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: `🚀 已接單\nETA ${t} 分鐘\n\n導航👇\n取件：${navUrl(o.pickup)}\n送達：${navUrl(o.dropoff)}`
        });
      }
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => console.log("V3.9.2 RUNNING"));

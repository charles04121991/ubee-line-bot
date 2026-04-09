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

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
const LINE_FINISH_GROUP_ID = process.env.LINE_FINISH_GROUP_ID;

const sessions = {};
const orders = {};

const createOrderId = () => "UB" + Date.now();

// ===== Google Maps 距離 =====
async function getDistance(origin, destination) {
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&key=${GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  const element = data.rows[0].elements[0];

  const distance = element.distance.value / 1000;
  const duration = Math.ceil(element.duration.value / 60);

  return { distance, duration };
}

// ===== 導航連結 =====
function navUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

// ===== 價格 =====
function calcPrice(distance, duration, urgent) {
  const base = 99;
  const distFee = distance * 6;
  const timeFee = duration * 3;
  const service = 50;
  const urgentFee = urgent ? 100 : 0;

  const total = Math.round(base + distFee + timeFee + service + urgentFee);
  const rider = Math.round(total * 0.6);
  const platform = total - rider;

  return { total, rider, platform, distFee, timeFee, service, urgentFee };
}

// ===== Flex（任務卡）=====
function orderFlex(order, price) {
  return {
    type: "flex",
    altText: "新任務",
    contents: {
      type: "bubble",
      body: {
        layout: "vertical",
        contents: [
          { type: "text", text: "📦 新任務", weight: "bold" },
          { type: "text", text: `訂單：${order.id}` },

          { type: "text", text: `騎手收入：$${price.rider}` },

          { type: "separator" },

          { type: "text", text: `取件：${order.pickup}` },
          { type: "text", text: `送達：${order.dropoff}` }
        ]
      },
      footer: {
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: {
              type: "postback",
              label: "接受訂單",
              data: `accept_${order.id}`
            }
          }
        ]
      }
    }
  };
}

// ===== 財務卡 =====
function financeFlex(order, price, distance, duration) {
  return {
    type: "flex",
    altText: "財務明細",
    contents: {
      type: "bubble",
      body: {
        layout: "vertical",
        contents: [
          { type: "text", text: "💰 財務明細", weight: "bold", size: "lg" },
          { type: "text", text: `訂單：${order.id}` },

          { type: "separator" },

          { type: "text", text: `客戶支付：$${price.total}`, weight: "bold" },

          { type: "text", text: `距離：${distance.toFixed(1)} km` },
          { type: "text", text: `時間：${duration} 分鐘` },

          { type: "separator" },

          { type: "text", text: `騎手收入：$${price.rider}` },
          { type: "text", text: `平台收入：$${price.platform}` },

          { type: "separator" },

          { type: "text", text: `距離費：$${Math.round(price.distFee)}` },
          { type: "text", text: `時間費：$${price.timeFee}` },
          { type: "text", text: `急件：$${price.urgentFee}` },
          { type: "text", text: `服務費：$${price.service}` }
        ]
      }
    }
  };
}

// ===== ETA =====
function etaFlex(order) {
  const times = [5,7,9,10,12,15,18,20,22,25];

  return {
    type: "flex",
    altText: "ETA",
    contents: {
      type: "bubble",
      body: {
        layout: "vertical",
        contents: times.map(t => ({
          type: "button",
          action: {
            type: "postback",
            label: `${t} 分鐘`,
            data: `eta_${order.id}_${t}`
          }
        }))
      }
    }
  };
}

// ===== webhook =====
app.post('/webhook', async (req, res) => {

  for (let event of req.body.events) {

    if (event.type === 'message') {
      const text = event.message.text;
      const userId = event.source.userId;

      if (text === "建立任務") {
        sessions[userId] = { step: "pickup" };
        return client.replyMessage(event.replyToken, { type: "text", text: "輸入取件地址" });
      }

      if (sessions[userId]?.step === "pickup") {
        sessions[userId].pickup = text;
        sessions[userId].step = "pickupPhone";
        return client.replyMessage(event.replyToken, { type: "text", text: "輸入取件電話" });
      }

      if (sessions[userId]?.step === "pickupPhone") {
        sessions[userId].pickupPhone = text;
        sessions[userId].step = "dropoff";
        return client.replyMessage(event.replyToken, { type: "text", text: "輸入送達地址" });
      }

      if (sessions[userId]?.step === "dropoff") {
        sessions[userId].dropoff = text;
        sessions[userId].step = "dropoffPhone";
        return client.replyMessage(event.replyToken, { type: "text", text: "輸入送達電話" });
      }

      if (sessions[userId]?.step === "dropoffPhone") {
        sessions[userId].dropoffPhone = text;
        sessions[userId].step = "urgent";
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "是否急件？（輸入：急件 / 一般件）"
        });
      }

      if (text === "急件" || text === "一般件") {

        const s = sessions[userId];

        const { distance, duration } = await getDistance(s.pickup, s.dropoff);
        const price = calcPrice(distance, duration, text === "急件");

        const order = {
          id: createOrderId(),
          ...s
        };

        orders[order.id] = order;

        await client.pushMessage(LINE_GROUP_ID, orderFlex(order, price));
        await client.pushMessage(LINE_FINISH_GROUP_ID, financeFlex(order, price, distance, duration));

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: `✅ 已建立\n總金額：$${price.total}`
        });
      }
    }

    if (event.type === "postback") {
      const data = event.postback.data;

      if (data.startsWith("accept_")) {
        const id = data.split("_")[1];
        return client.replyMessage(event.replyToken, etaFlex(orders[id]));
      }

      if (data.startsWith("eta_")) {
        const [_, id, t] = data.split("_");

        const order = orders[id];

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: `🚀 已接單\nETA：${t} 分鐘\n\n導航👇\n取件：${navUrl(order.pickup)}\n送達：${navUrl(order.dropoff)}`
        });
      }
    }
  }

  res.sendStatus(200);
});

app.listen(3000);

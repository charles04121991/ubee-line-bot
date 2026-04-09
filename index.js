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

// ===== 訂單 =====
const orders = {};

// ===== 工具 =====
const createOrderId = () => "UB" + Date.now();

// ===== 主選單 =====
function mainMenu() {
  return {
    type: "text",
    text: "請選擇功能👇",
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "📦 下單", text: "下單" }},
        { type: "action", action: { type: "message", label: "🏢 企業", text: "企業" }},
        { type: "action", action: { type: "message", label: "👤 我的", text: "我的" }},
      ]
    }
  };
}

// ===== 子選單 =====
function orderMenu() {
  return {
    type: "text",
    text: "下單功能👇",
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "建立任務", text: "建立任務" }},
        { type: "action", action: { type: "message", label: "立即估價", text: "立即估價" }},
        { type: "action", action: { type: "message", label: "計費說明", text: "計費說明" }},
        { type: "action", action: { type: "message", label: "取消規則", text: "取消規則" }},
      ]
    }
  };
}

function businessMenu() {
  return {
    type: "text",
    text: "企業服務👇",
    quickReply: {
      items: [
        { type: "action", action: { type: "uri", label: "企業合作表單", uri: "https://your-form.com" }},
        { type: "action", action: { type: "message", label: "合作說明", text: "合作說明" }},
        { type: "action", action: { type: "message", label: "服務區域", text: "服務區域" }},
        { type: "action", action: { type: "message", label: "聯絡我們", text: "聯絡我們" }},
      ]
    }
  };
}

function userMenu() {
  return {
    type: "text",
    text: "會員功能👇",
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "服務說明", text: "服務說明" }},
        { type: "action", action: { type: "message", label: "聯絡我們", text: "聯絡我們" }},
        { type: "action", action: { type: "message", label: "常見問題", text: "常見問題" }},
        { type: "action", action: { type: "uri", label: "加入我們", uri: "https://your-partner-form.com" }},
      ]
    }
  };
}

// ===== 計算 =====
function calcPrice(distance, duration, urgent) {
  const base = 99;
  const distFee = distance * 10;
  const timeFee = duration * 3;
  const service = 50;
  const urgentFee = urgent ? 100 : 0;

  const total = base + distFee + timeFee + service + urgentFee;

  const rider = Math.round(total * 0.6);
  const platform = total - rider;

  return { base, distFee, timeFee, service, urgentFee, total, rider, platform };
}

// ===== 財務卡 =====
function financeCard(order, price) {
  return {
    type: "flex",
    altText: "財務明細",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "💰 財務明細", weight: "bold", size: "lg" },
          { type: "text", text: `訂單編號：${order.id}` },

          { type: "separator" },

          { type: "text", text: `客戶支付：$${price.total}`, weight: "bold" },

          { type: "text", text: `取件地址：${order.pickup}` },
          { type: "text", text: `送達地址：${order.dropoff}` },

          { type: "text", text: `距離：${order.distance} 公里` },
          { type: "text", text: `時間：${order.duration} 分鐘` },

          { type: "separator" },

          { type: "text", text: `騎手收入：$${price.rider}` },
          { type: "text", text: `平台收入：$${price.platform}` },

          { type: "separator" },

          { type: "text", text: `急件費：$${price.urgentFee}` },
          { type: "text", text: `服務費：$${price.service}` },
        ]
      }
    }
  };
}

// ===== webhook =====
app.post('/webhook', async (req, res) => {
  const events = req.body.events;

  for (let event of events) {
    if (event.type !== 'message') continue;

    const text = event.message.text;

    // 主選單
    if (text === "menu") {
      await client.replyMessage(event.replyToken, mainMenu());
    }

    // 下單
    else if (text === "下單") {
      await client.replyMessage(event.replyToken, orderMenu());
    }

    // 企業
    else if (text === "企業") {
      await client.replyMessage(event.replyToken, businessMenu());
    }

    // 我的
    else if (text === "我的") {
      await client.replyMessage(event.replyToken, userMenu());
    }

    // 建立任務（簡化示範）
    else if (text === "建立任務") {

      const order = {
        id: createOrderId(),
        pickup: "北屯區松竹路",
        dropoff: "南屯區大墩路",
        pickupPhone: "0912xxxxxx",
        dropoffPhone: "0987xxxxxx",
        urgent: true,
        distance: 7,
        duration: 20
      };

      const price = calcPrice(order.distance, order.duration, order.urgent);
      orders[order.id] = order;

      // 派單（只顯示騎手收入）
      await client.pushMessage(LINE_GROUP_ID, {
        type: "text",
        text: `📦 新任務\n訂單：${order.id}\n騎手可得：$${price.rider}`
      });

      // 財務群（完整）
      await client.pushMessage(LINE_FINISH_GROUP_ID, financeCard(order, price));

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `✅ 任務建立成功\n總金額：$${price.total}`
      });
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log("UBee OMS V3.9 FULL running");
});

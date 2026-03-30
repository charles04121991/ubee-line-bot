const express = require("express");

const app = express();
app.use(express.json());

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

// 使用者任務流程暫存
let userSessions = {};

app.get("/", (req, res) => {
  res.send("UBee bot running");
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("收到 LINE 訊息：");
    console.log(JSON.stringify(req.body, null, 2));

    const events = req.body.events || [];

    for (const event of events) {
      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      const userText = (event.message.text || "").trim();
      const replyToken = event.replyToken;
      const userId = event.source.userId;

      if (!userSessions[userId]) {
        userSessions[userId] = { step: null, data: {} };
      }

      // 共用指令
      if (userText === "取消任務") {
        userSessions[userId] = { step: null, data: {} };
        await replyMessage(
          replyToken,
          "✅ 已取消目前任務流程。\n\n您可以重新輸入以下功能：\n1. 建立任務\n2. 立即估價\n3. 企業合作\n4. 專人協助\n5. 服務說明\n6. 會員專區"
        );
        continue;
      }

      if (userText === "重新開始") {
        userSessions[userId] = { step: "pickup", data: {} };
        await replyMessage(
          replyToken,
          "🔄 已重新開始建立任務流程。\n\n請輸入【取件地點】\n\n如需中止，請輸入：取消任務"
        );
        continue;
      }

      if (userText === "主選單" || userText === "返回主選單") {
        userSessions[userId] = { step: null, data: {} };
        await replyMessage(replyToken, getMainMenuText());
        continue;
      }

      // ===== 建立任務流程 =====
      if (userText === "建立任務") {
        userSessions[userId] = { step: "pickup", data: {} };
        await replyMessage(
          replyToken,
          "📦 UBee 任務建立流程開始\n\n請輸入【取件地點】\n\n例如：台中市豐原區中山路 100 號\n\n如需取消，請輸入：取消任務"
        );
        continue;
      }

      if (userSessions[userId].step === "pickup") {
        userSessions[userId].data.pickup = userText;
        userSessions[userId].step = "dropoff";

        await replyMessage(
          replyToken,
          "✅ 已收到取件地點\n\n請輸入【送達地點】"
        );
        continue;
      }

      if (userSessions[userId].step === "dropoff") {
        userSessions[userId].data.dropoff = userText;
        userSessions[userId].step = "item";

        await replyMessage(
          replyToken,
          "✅ 已收到送達地點\n\n請輸入【物品內容】\n\n例如：文件、樣品、合約、商務物件"
        );
        continue;
      }

      if (userSessions[userId].step === "item") {
        userSessions[userId].data.item = userText;
        userSessions[userId].step = "urgent";

        await replyMessage(
          replyToken,
          "✅ 已收到物品內容\n\n請輸入【是否急件】\n請輸入其中一種：\n1. 急件\n2. 一般"
        );
        continue;
      }

      if (userSessions[userId].step === "urgent") {
        if (userText !== "急件" && userText !== "一般") {
          await replyMessage(
            replyToken,
            "⚠️ 格式不正確。\n\n請直接輸入：\n1. 急件\n或\n2. 一般"
          );
          continue;
        }

        userSessions[userId].data.urgent = userText;
        userSessions[userId].step = "phone";

        await replyMessage(
          replyToken,
          "✅ 已收到任務類型\n\n請輸入【聯絡電話】\n\n例如：0912345678"
        );
        continue;
      }

      if (userSessions[userId].step === "phone") {
        const phone = userText.replace(/[^0-9]/g, "");

        if (phone.length < 8 || phone.length > 10) {
          await replyMessage(
            replyToken,
            "⚠️ 電話格式看起來不正確。\n\n請重新輸入【聯絡電話】\n例如：0912345678"
          );
          continue;
        }

        userSessions[userId].data.phone = userText;

        const order = userSessions[userId].data;

        const summary =
          "✅ 任務建立成功\n\n" +
          "以下為您本次提交的任務資訊：\n\n" +
          "📍取件地點：" + order.pickup + "\n" +
          "📍送達地點：" + order.dropoff + "\n" +
          "📦物品內容：" + order.item + "\n" +
          "⚡任務類型：" + order.urgent + "\n" +
          "📞聯絡電話：" + order.phone + "\n\n" +
          "UBee 已收到您的任務需求，將由專人進行後續安排與確認。\n\n" +
          "如需立即估價、企業合作或其他服務，可輸入：主選單";

        userSessions[userId] = { step: null, data: {} };

        await replyMessage(replyToken, summary);
        continue;
      }
      // ===== 建立任務流程結束 =====

      let replyText = "";

      if (userText === "你好" || userText === "哈囉" || userText === "嗨") {
        replyText =
          "您好，這裡是 UBee 城市任務服務。\n\n" +
          "我們提供商務型任務處理與城市即時支援，歡迎直接選擇以下功能：\n\n" +
          "1. 建立任務\n" +
          "2. 立即估價\n" +
          "3. 企業合作\n" +
          "4. 專人協助\n" +
          "5. 服務說明\n" +
          "6. 會員專區\n\n" +
          "請直接輸入功能名稱即可。";
      } else if (userText === "立即估價") {
        replyText =
          "📊 UBee 快速估價\n\n" +
          "請提供以下資訊，我們將為您進行預估：\n\n" +
          "1. 取件地點\n" +
          "2. 送達地點\n" +
          "3. 物品內容\n" +
          "4. 是否急件\n" +
          "5. 聯絡電話\n\n" +
          "※ 此為預估費用，實際仍依任務內容確認。";
      } else if (userText === "企業合作") {
        replyText =
          "🏢 UBee 企業合作服務\n\n" +
          "適用需求包含：\n" +
          "✔ 文件急送 / 合約遞送\n" +
          "✔ 樣品配送 / 商務物件\n" +
          "✔ 行政代辦 / 臨時任務\n" +
          "✔ 固定配合 / 月結合作\n\n" +
          "UBee 服務特色：\n" +
          "・當天快速送達\n" +
          "・非傳統宅配流程\n" +
          "・專人對接，價格透明\n" +
          "・可依企業需求調整配合方式\n\n" +
          "若需洽談合作，請留下以下資訊：\n\n" +
          "🏢 公司名稱\n" +
          "👤 聯絡人姓名\n" +
          "📞 聯絡電話\n" +
          "📦 主要需求類型";
      } else if (userText === "專人協助") {
        replyText =
          "👤 UBee 專人協助\n\n" +
          "若您有以下需求，可直接描述：\n\n" +
          "✔ 任務諮詢\n" +
          "✔ 特殊需求任務\n" +
          "✔ 高價物件 / 客製內容\n" +
          "✔ 企業合作問題\n\n" +
          "請直接輸入您的需求內容，我們將協助您處理。\n\n" +
          "※ 目前不提供餐飲、生鮮、危險物與代參服務。";
      } else if (userText === "服務說明") {
        replyText =
          "📘 UBee 服務說明\n\n" +
          "UBee 主要提供以下服務：\n\n" +
          "📦 文件急送\n" +
          "🏢 商務跑腿\n" +
          "📝 行政代辦\n" +
          "🚀 即時配送\n" +
          "🍀 城市任務\n\n" +
          "服務特色：\n" +
          "・當天快速處理\n" +
          "・商務需求導向\n" +
          "・非餐飲外送平台\n\n" +
          "如需建立任務，請輸入【建立任務】";
      } else if (userText === "會員專區") {
        replyText =
          "🎁 UBee 會員專區\n\n" +
          "目前可使用優惠如下：\n\n" +
          "🟡 回購優惠 $50（滿 $300 可使用）\n" +
          "🟡 高價任務優惠 $100（滿 $500 可使用）\n\n" +
          "📊 例如：\n" +
          "原價 $520 → 優惠後 $420\n\n" +
          "如需安排任務，可直接輸入【建立任務】\n" +
          "或回覆您要申請：【個人會員】/【公司會員】";
      } else if (
        userText.includes("報價") ||
        userText.includes("下單") ||
        userText.includes("文件")
      ) {
        replyText =
          "好的，這邊協助您進行任務評估。\n\n" +
          "請提供以下資訊：\n\n" +
          "1. 取件地點\n" +
          "2. 送達地點\n" +
          "3. 物品內容\n" +
          "4. 是否急件\n" +
          "5. 聯絡電話\n\n" +
          "收到後我們會盡快協助您報價。";
      } else {
        replyText =
          "已收到您的訊息 👋\n\n" +
          "您可以直接輸入以下功能：\n\n" +
          "1. 建立任務\n" +
          "2. 立即估價\n" +
          "3. 企業合作\n" +
          "4. 專人協助\n" +
          "5. 服務說明\n" +
          "6. 會員專區\n\n" +
          "若您正在進行任務流程，也可輸入：\n" +
          "・取消任務\n" +
          "・重新開始\n" +
          "・主選單";
      }

      await replyMessage(replyToken, replyText);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(200).send("OK");
  }
});

function getMainMenuText() {
  return (
    "📍 UBee 主選單\n\n" +
    "請直接輸入以下功能：\n\n" +
    "1. 建立任務\n" +
    "2. 立即估價\n" +
    "3. 企業合作\n" +
    "4. 專人協助\n" +
    "5. 服務說明\n" +
    "6. 會員專區"
  );
}

async function replyMessage(replyToken, text) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        {
          type: "text",
          text,
        },
      ],
    }),
  });

  const data = await response.text();
  console.log("LINE 回覆結果:", data);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

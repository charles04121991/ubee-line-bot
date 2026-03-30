const express = require("express");

const app = express();
app.use(express.json());

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

app.get("/", (req, res) => {
  res.send("UBee bot running");
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("收到LINE訊息：");
    console.log(JSON.stringify(req.body, null, 2));

    const events = req.body.events || [];

    for (const event of events) {
      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      const userText = (event.message.text || "").trim();
      const replyToken = event.replyToken;

      let replyText = "";

      if (userText === "你好" || userText === "哈囉" || userText === "嗨") {
        replyText =
          "您好，這裡是UBee城市任務。\n請問需要什麼服務？\n\n請提供：\n1. 取件地點\n2. 送達地點\n3. 物品內容\n4. 是否急件";
      } else if (
        userText.includes("報價") ||
        userText.includes("下單") ||
        userText.includes("文件")
      ) {
        replyText =
          "好的，請提供以下資訊，我幫您報價：\n\n1. 取件地點\n2. 送達地點\n3. 物品內容\n4. 是否急件\n5. 聯絡電話";
      } else {
        replyText =
          "已收到您的訊息。\n請直接提供取件與送達資訊，我們會立即協助您。";
      }

      await replyMessage(replyToken, replyText);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error(error);
    res.status(200).send("OK");
  }
});

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
  console.log("回覆結果:", data);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

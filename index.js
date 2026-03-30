const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("UBee test bot running");
});

app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.type !== "message") continue;
      if (event.message?.type !== "text") continue;

      const replyToken = event.replyToken;
      const userText = (event.message.text || "").trim();

      console.log("收到訊息:", userText);

      await axios.post(
        "https://api.line.me/v2/bot/message/reply",
        {
          replyToken,
          messages: [
            {
              type: "text",
              text: `你剛剛輸入的是：${userText}`
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

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook 錯誤:", err.message);
    console.error("錯誤回傳:", err.response?.data || "無 response data");
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`UBee test bot running on port ${PORT}`);
});
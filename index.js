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
      } else if (userText === "建立任務") {
        replyText =
          "UBee主要提供 商務跑腿服務\n服務對象為 公司、工廠與各類商務配送需求。\n\n※ 本服務不提供美食代購代買\n\n已收到您的任務需求，請提供以下資訊，\n我們立即為您安排：\n\n取件地點\n取件人 / 電話\n\n送達地點\n收件人 / 電話\n\n物品內容\n是否急件（一般 / 急件）\n\n備註：\n\n※ 不配送食品、違禁品或危險物，若為急件請於備註註明【急件】";
      } else if (userText === "立即估價") {
        replyText =
          "您可以快速這取得任務費用估算，請提供：\n\n取件地點：\n送達地點：\n物品內容：\n是否急件：\n\n────\n\n📌 我們將為您即時計算預估費用（非最終報價）";
      } else if (userText === "企業合作") {
        replyText =
          "UBee 提供企業專屬城市任務服務，適用於：\n\n✔ 文件急送 / 合約遞送\n✔ 樣品配送 / 商務物件\n✔ 行政代辦 / 臨時任務\n✔ 事務所 / 設計公司\n✔ 高單價花店 / 精品商家\n✔ 文具辦公 / 美妝或香氛小物店\n✔ 臨時行政支援\n\n────\n\n🚀 服務優勢\n・當天快速送達（非傳統宅配）\n・專人處理，流程穩定\n・價格透明，直接報價\n・可配合企業需求彈性調整\n\n📌 支援月結 / 長期配合 / 專人對接\n\n請留下以下資訊，\n我們將由專人與您聯繫：\n\n🏢 公司名稱\n👤 聯絡人\n📞 聯絡電話\n📦 主要需求類型";
      } else if (userText === "專人協助") {
        replyText =
          "您好，這裡是 UBee 專人協助服務\n\n若您有以下需求，我們可立即協助處理：\n\n✔ 任務諮詢\n✔ 特殊需求（高價物件 / 客製任務）\n✔ 企業合作問題\n\n請直接描述您的需求，我們將即時為您處理\n\n※ 不承接個人散單、代買或代參服務\n收到資訊後，會盡快回覆！";
      } else if (userText === "服務說明") {
        replyText =
          "UBee 為城市任務服務平台，主要提供：\n\n📦 文件急送\n🏢 商務跑腿\n📝 行政代辦\n🚀 即時配送\n🍀 城市任務\n\n────\n\n📌 當天快速完成\n📌 不提供餐飲 / 生鮮代購服務\n\n如需安排任務，請點選【建立任務】";
      } else if (userText === "會員專區") {
        replyText =
          "歡迎使用 UBee 會員服務 👋\n\n🎁 您目前可使用優惠：\n\n🟡 回購優惠 $50（滿 $300）\n🟡 高價任務優惠 $100（滿 $500）\n\n────\n\n📊 例如：\n原價 $520 → 使用優惠後 $420\n\n────\n\n📌 優惠將於近期到期\n\n這邊可以直接幫您安排任務！\n需要我現在幫您處理嗎？\n\n請問要加個人會員還是公司會員";
      } else if (
        userText.includes("報價") ||
        userText.includes("下單") ||
        userText.includes("文件")
      ) {
        replyText =
          "好的，請提供以下資訊，我幫您報價：\n\n1. 取件地點\n2. 送達地點\n3. 物品內容\n4. 是否急件\n5. 聯絡電話";
      } else {
        replyText =
          "已收到您的訊息。\n\n您可以直接輸入以下功能：\n1. 建立任務\n2. 立即估價\n3. 企業合作\n4. 專人協助\n5. 服務說明\n6. 會員專區";
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

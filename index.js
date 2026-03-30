const express = require("express");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("UBee bot running");
});

app.post("/webhook", (req, res) => {
  console.log("收到LINE訊息：");
  console.log(JSON.stringify(req.body, null, 2));

  res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

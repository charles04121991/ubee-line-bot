const text = (event.message.text || '').trim();
const userId = event.source.userId;

// ===== 查詢自己的 LINE userId =====
if (text === '我的ID') {
  return safeReply(
    event.replyToken,
    textMessage(`你的 userId 是：\n${event.source.userId}`)
  );
}
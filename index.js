if (text === '我的ID') {
  if (!isAdmin(userId)) {
    return safeReply(event.replyToken, textMessage('⚠️ 無權限'));
  }

  return safeReply(
    event.replyToken,
    textMessage(`你的 userId 是：\n${userId}`)
  );
}
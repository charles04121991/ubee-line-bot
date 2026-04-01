// ===== 在 handleEvent 最前面加這段 =====

async function handleEvent(event) {
  try {
    // 🔥🔥🔥 這行就是關鍵（抓 groupId）
    console.log('📩 EVENT =', JSON.stringify(event, null, 2));

    if (event.type === 'postback') {
      return handlePostback(event);
    }

    if (event.type !== 'message' || event.message.type !== 'text') {
      return Promise.resolve(null);
    }

    if (event.source.type === 'group') {
      return handleGroupText(event);
    }

    if (event.source.type === 'user') {
      return handleTaskInput(event);
    }

    return Promise.resolve(null);

  } catch (err) {
    console.error('❌ handleEvent error:', err);
    if (event.replyToken) {
      try {
        return replyText(event.replyToken, '系統忙碌中，請稍後再試。');
      } catch (replyErr) {
        console.error('❌ reply fallback error:', replyErr);
      }
    }
    return Promise.resolve(null);
  }
}

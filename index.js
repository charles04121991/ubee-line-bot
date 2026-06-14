require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');
const path = require('path');
const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      : undefined,
  }),
});

const db = admin.firestore();

const app = express();

// ===== CORS：允許 UBee 騎士前端正式站呼叫 Render 後端 =====
app.use((req, res, next) => {
  const allowedOrigins = [
  'https://ubee-rider-web.vercel.app',
  'https://ubee-line-bot-2-zezw.onrender.com',
  'https://ubee-business-web.vercel.app',
];

  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('❌ 缺少 CHANNEL_ACCESS_TOKEN 或 CHANNEL_SECRET');
  process.exit(1);
}

const client = new line.Client(config);

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');

const LINE_FINISH_GROUP_ID = process.env.LINE_FINISH_GROUP_ID || '';
const LINE_ADMIN_GROUP_ID = process.env.LINE_ADMIN_GROUP_ID || LINE_FINISH_GROUP_ID || '';
const RIDER_SOP_GROUP_LINK = process.env.RIDER_SOP_GROUP_LINK || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const LIFF_ID = process.env.LIFF_ID || '';

// ===== 騎士 App 登入設定 =====
// RIDER_LIFF_ID：如果你有另外建立騎士專用 LIFF，就在 Render 環境變數設定 RIDER_LIFF_ID。
// 如果沒有設定，就先共用原本 LIFF_ID。
const RIDER_LIFF_ID = process.env.RIDER_LIFF_ID || LIFF_ID;

// RIDER_APP_SCHEME 要跟 App 裡面的 scheme 一樣。
// 目前 App 端會接收 ubee-rider://login?lineUserId=...
const RIDER_APP_SCHEME = process.env.RIDER_APP_SCHEME || 'ubeerider';
const RIDER_APP_RETURN_URL =
  process.env.RIDER_APP_RETURN_URL || `${RIDER_APP_SCHEME}://login`;
// ===== 管理員權限名單 =====
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ===== 已審核騎手白名單 =====
const APPROVED_RIDER_IDS = [];

async function sendNewOrderPushToRiders(order) {
  try {
    const orderId = order.id || order.orderId || "";
    if (!orderId) return;

    const fee = order.driverFee || order.riderFee || "未設定";
    const pickup = order.pickupAddress || order.fromAddress || order.pickup || "附近取件地";
    const dropoff = order.dropoffAddress || order.toAddress || order.dropoff || "送達地未提供";
    try {
      await client.pushMessage("Cdc5a9583fb1364402c2a3e4e5edb4c1b", {
        type: "text",
        text:
`🔔 UBee 新任務通知

有新的跑腿任務等待接單

📍取件：${pickup}
🏁送達：${dropoff}
💰騎士收入：$${fee}`
      });

      console.log(`UBee LINE 新任務通知已送出：${orderId}`);
    } catch (lineErr) {
      console.error("UBee LINE 新任務通知失敗:", lineErr);
    }

  } catch (err) {
    console.error("UBee 新任務通知失敗:", err);
  }
}

const PAYMENT_JKO_INFO =
  (process.env.PAYMENT_JKO_INFO || '街口支付\n帳號：請填入你的街口帳號').replace(/\\n/g, '\n');

const PAYMENT_BANK_INFO =
  (process.env.PAYMENT_BANK_INFO || '銀行轉帳\n銀行：請填入銀行名稱\n帳號：請填入銀行帳號\n戶名：請填入戶名').replace(/\\n/g, '\n');

const MERCHANT_OA_LINK = process.env.MERCHANT_OA_LINK || 'https://lin.ee/uA2vLYZ';
const BUSINESS_FORM_URL =
  process.env.BUSINESS_FORM_URL ||
  'https://docs.google.com/forms/d/e/1FAIpQLScn9AGnp4FbTGg6fZt5fpiMdNEi-yL9x595bTyVFHAoJmpYlA/viewform';

const PARTNER_FORM_URL =
  process.env.PARTNER_FORM_URL ||
  `${BASE_URL}/rider.html`;

if (!LINE_ADMIN_GROUP_ID) {
  console.warn('⚠️ 未設定 LINE_ADMIN_GROUP_ID 或 LINE_FINISH_GROUP_ID，審核與管理通知可能無法推送。');
}

if (!GOOGLE_MAPS_API_KEY) {
  console.error('❌ 缺少 GOOGLE_MAPS_API_KEY');
  process.exit(1);
}

// webhook 一定要放在 express.json() 前面，避免 LINE 簽章驗證失敗
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ webhook 錯誤：', error);
    res.status(500).end();
  }
});

// ✅ 健康檢查（給 UptimeRobot 用）
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ===== 騎士 App LINE 登入入口 =====
// App 會先打開這個頁面，頁面用 LIFF 取得真正登入者的 lineUserId，
// 再導回 App：ubee-rider://login?lineUserId=Uxxxx
app.get('/rider-app-login', (req, res) => {
  if (!RIDER_LIFF_ID) {
    return res.status(500).send(`
      <!DOCTYPE html>
      <html lang="zh-Hant">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>UBee 騎士登入</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #0f172a;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", sans-serif;
          }
          .card {
            width: min(92vw, 420px);
            background: #111827;
            border-radius: 24px;
            padding: 28px;
            box-shadow: 0 20px 60px rgba(0,0,0,.35);
          }
          h1 { margin: 0 0 12px; font-size: 24px; }
          p { color: #cbd5e1; line-height: 1.6; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>UBee 騎士登入設定未完成</h1>
          <p>後端尚未設定 RIDER_LIFF_ID 或 LIFF_ID，請到 Render 環境變數確認。</p>
        </div>
      </body>
      </html>
    `);
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  res.send(`
    <!DOCTYPE html>
    <html lang="zh-Hant">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
      <title>UBee 騎士登入</title>
      <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
      <style>
        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          min-height: 100vh;
          background: linear-gradient(180deg, #0f172a 0%, #111827 100%);
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
        }

        .card {
          width: min(92vw, 430px);
          background: rgba(17, 24, 39, .96);
          border: 1px solid rgba(255,255,255,.12);
          border-radius: 28px;
          padding: 28px;
          box-shadow: 0 24px 70px rgba(0,0,0,.38);
        }

        .logo {
          width: 64px;
          height: 64px;
          border-radius: 20px;
          background: #facc15;
          color: #111827;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 34px;
          margin-bottom: 18px;
        }

        h1 {
          margin: 0;
          font-size: 26px;
          line-height: 1.25;
          font-weight: 900;
        }

        p {
          margin: 12px 0 0;
          color: #cbd5e1;
          font-size: 16px;
          line-height: 1.7;
          font-weight: 600;
        }

        .status {
          margin-top: 20px;
          padding: 14px 16px;
          border-radius: 16px;
          background: rgba(250, 204, 21, .12);
          color: #fde68a;
          font-size: 15px;
          line-height: 1.6;
          font-weight: 800;
        }

        .button {
          margin-top: 22px;
          width: 100%;
          height: 56px;
          border: 0;
          border-radius: 16px;
          background: #22c55e;
          color: #fff;
          font-size: 18px;
          font-weight: 900;
        }

        .button.secondary {
          background: #334155;
          margin-top: 12px;
        }

        .small {
          margin-top: 16px;
          color: #94a3b8;
          font-size: 13px;
          line-height: 1.6;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="logo">🐝</div>
        <h1>UBee 騎士登入</h1>
        <p>系統正在確認你的 LINE 身分，完成後會自動回到騎士 App。</p>

        <div id="status" class="status">正在啟動 LINE 登入...</div>

        <button id="openAppButton" class="button" style="display:none;">回到騎士 App</button>
        <button id="retryButton" class="button secondary" style="display:none;">重新登入</button>

        <div class="small">
          如果畫面沒有自動跳回 App，請按「回到騎士 App」。
        </div>
      </div>

      <script>
        const LIFF_ID = ${JSON.stringify(RIDER_LIFF_ID)};
        const RIDER_APP_RETURN_URL = ${JSON.stringify(RIDER_APP_RETURN_URL)};

        const statusEl = document.getElementById('status');
        const openAppButton = document.getElementById('openAppButton');
        const retryButton = document.getElementById('retryButton');

        let appUrl = '';

        function setStatus(text) {
          statusEl.textContent = text;
        }

        function openApp() {
          if (!appUrl) return;
          window.location.href = appUrl;
        }

        async function main() {
          try {
            setStatus('正在初始化 LINE 登入...');

            await liff.init({ liffId: LIFF_ID });

            if (!liff.isLoggedIn()) {
              setStatus('請先完成 LINE 登入...');
              liff.login({
                redirectUri: window.location.href
              });
              return;
            }

            setStatus('正在取得 LINE 騎士身分...');

            const profile = await liff.getProfile();
            const lineUserId = profile && profile.userId ? profile.userId : '';

            if (!lineUserId || !lineUserId.startsWith('U')) {
              throw new Error('無法取得 LINE userId');
            }

            appUrl =
              RIDER_APP_RETURN_URL +
              '?lineUserId=' +
              encodeURIComponent(lineUserId) +
              '&source=line';

            setStatus('登入成功，正在回到 UBee 騎士 App...');

            openAppButton.style.display = 'block';
            openAppButton.onclick = openApp;

            setTimeout(openApp, 600);
          } catch (error) {
            console.error(error);
            setStatus('登入失敗，請重新開啟或重新登入。');

            retryButton.style.display = 'block';
            retryButton.onclick = function () {
              window.location.reload();
            };
          }
        }

        main();
      </script>
    </body>
    </html>
  `);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==============================
// UBee 騎士系統 API
// ==============================

// 1. 取得騎士資料：正式版，以手機綁定為最高優先，避免 LINE 綁錯人
app.get('/api/rider/profile', async (req, res) => {
  try {
    const { lineUserId, phone } = req.query;

    if (!lineUserId || !String(lineUserId).startsWith('U')) {
      return res.status(400).json({
        success: false,
        message: '缺少正確的 LINE 騎士身分。',
      });
    }

    const cleanPhone = normalizePhone(phone || '');

    // 正式版規則：
    // 只要前端有帶 phone，就以 phone 文件為主，重新綁定目前 LINE userId。
    // 這可以避免以前錯誤綁定到別人的 lineUserId，導致顯示錯誤騎士資料。
    if (cleanPhone) {
      if (!/^09\d{8}$/.test(cleanPhone)) {
        return res.status(400).json({
          success: false,
          message: '手機號碼格式錯誤，請輸入 09 開頭的 10 碼手機號碼。',
        });
      }

      const phoneDocRef = db.collection('riders').doc(cleanPhone);
      const phoneDoc = await phoneDocRef.get();

      if (!phoneDoc.exists) {
        return res.status(404).json({
          success: false,
          message: '找不到此手機號碼的騎士資料。',
        });
      }

      const riderData = phoneDoc.data();

      if (riderData.approved !== true && riderData.status !== 'approved') {
        return res.status(403).json({
          success: false,
          message: '騎士尚未審核通過。',
        });
      }

      // 清掉其他誤綁到同一個 lineUserId 的騎士資料，避免同一個 LINE 對到多人
      const wrongBindSnap = await db.collection('riders')
        .where('lineUserId', '==', lineUserId)
        .get();

      const batch = db.batch();

      wrongBindSnap.docs.forEach(doc => {
        if (doc.id !== cleanPhone) {
          batch.set(doc.ref, {
            lineUserId: '',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            unboundReason: 'rebind_to_correct_phone',
          }, { merge: true });
        }
      });

      batch.set(phoneDocRef, {
        lineUserId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      await batch.commit();

      const updatedDoc = await phoneDocRef.get();

      return res.json({
        success: true,
        rider: {
          id: updatedDoc.id,
          ...updatedDoc.data(),
        },
      });
    }

    // 沒有帶手機時，才用 lineUserId 找已綁定騎士
    const snap = await db.collection('riders')
      .where('lineUserId', '==', lineUserId)
      .limit(1)
      .get();

    if (!snap.empty) {
      const doc = snap.docs[0];

      return res.json({
        success: true,
        rider: {
          id: doc.id,
          ...doc.data(),
        },
      });
    }

    return res.status(404).json({
      success: false,
      message: '找不到騎士資料，請先輸入註冊手機號碼完成綁定。',
      needPhoneBind: true,
    });

  } catch (err) {
    console.error('取得騎士資料失敗:', err);

    return res.status(500).json({
      success: false,
      message: '取得騎士資料失敗。',
      error: err.message,
    });
  }
});

// 2. 取得可接任務：正式版只允許 approved 騎士查看
app.get('/api/rider/tasks', async (req, res) => {
  try {
    const { lineUserId } = req.query;

    if (!lineUserId || !String(lineUserId).startsWith('U')) {
      return res.status(400).json({
        success: false,
        message: '缺少正確的騎士 LINE 身分。',
      });
    }

    const riderSnap = await db.collection('riders')
  .where('lineUserId', '==', lineUserId)
  .limit(1)
  .get();

const riderOk = !riderSnap.empty && (
  riderSnap.docs[0].data().approved === true ||
  riderSnap.docs[0].data().status === 'approved'
);

if (!riderOk) {
  return res.status(403).json({
    success: false,
    message: '你尚未通過 UBee 騎士審核，暫時無法查看任務。',
  });
}

    const snap = await db
      .collection('orders')
      .where('status', '==', 'pending_dispatch')
      .limit(30)
      .get();

    const orders = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    return res.json({
      success: true,
      orders,
      tasks: orders
    });

  } catch (err) {
    console.error('取得可接任務失敗:', err);
    return res.status(500).json({
      success: false,
      message: '取得可接任務失敗',
      error: err.message
    });
  }
});

// 3. 取得騎士目前進行中任務：正式版用於重新整理後恢復任務
app.get('/api/rider/current-order', async (req, res) => {
  try {
    const { lineUserId } = req.query;

    if (!lineUserId || !String(lineUserId).startsWith('U')) {
      return res.status(400).json({
        success: false,
        message: '缺少正確的騎士 LINE 身分。',
      });
    }

    const riderSnap = await db.collection('riders')
      .where('lineUserId', '==', lineUserId)
      .limit(1)
      .get();

    const riderOk = !riderSnap.empty && (
      riderSnap.docs[0].data().approved === true ||
      riderSnap.docs[0].data().status === 'approved'
    );

    if (!riderOk) {
      return res.status(403).json({
        success: false,
        message: '你尚未通過 UBee 騎士審核，暫時無法查看目前任務。',
      });
    }

    const activeStatuses = [
      'accepted',
      'arrived_pickup',
      'picked_up',
      'arrived_dropoff',
    ];

    const snap = await db.collection('orders')
      .where('riderLineUserId', '==', lineUserId)
      .where('status', 'in', activeStatuses)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.json({
        success: true,
        hasOrder: false,
        order: null,
      });
    }

    const doc = snap.docs[0];

    return res.json({
      success: true,
      hasOrder: true,
      order: {
        id: doc.id,
        ...doc.data(),
      },
    });

  } catch (err) {
    console.error('❌ 取得騎士目前任務失敗：', err);

    return res.status(500).json({
      success: false,
      message: '取得騎士目前任務失敗，請稍後再試。',
      error: err.message,
    });
  }
});

// 3. 騎士今日 / 累積統計：正式版只允許 approved 騎士查看
app.get('/api/rider/summary', async (req, res) => {
  try {
    const { lineUserId } = req.query;

    if (!lineUserId || !String(lineUserId).startsWith('U')) {
      return res.status(400).json({
        success: false,
        message: '缺少正確的騎士 LINE 身分。',
      });
    }

    const riderSnap = await db.collection('riders')
      .where('lineUserId', '==', lineUserId)
      .limit(1)
      .get();

    const riderOk = !riderSnap.empty && (
      riderSnap.docs[0].data().approved === true ||
      riderSnap.docs[0].data().status === 'approved'
    );

    if (!riderOk) {
      return res.status(403).json({
        success: false,
        message: '你尚未通過 UBee 騎士審核，暫時無法查看統計資料。',
      });
    }

    const riderDoc = riderSnap.docs[0];
    const rider = riderDoc.data();

    const now = new Date();

    const taipeiNow = new Date(
      now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' })
    );

    const todayStartTaipei = new Date(
      taipeiNow.getFullYear(),
      taipeiNow.getMonth(),
      taipeiNow.getDate(),
      0,
      0,
      0,
      0
    );

    const tomorrowStartTaipei = new Date(
      taipeiNow.getFullYear(),
      taipeiNow.getMonth(),
      taipeiNow.getDate() + 1,
      0,
      0,
      0,
      0
    );

    const todayStartMs = todayStartTaipei.getTime();
    const tomorrowStartMs = tomorrowStartTaipei.getTime();

    const riderPhone = normalizePhone(rider.phone || '');
const riderDocId = riderDoc.id;

const completedSnap = await db.collection('orders')
  .where('riderLineUserId', '==', lineUserId)
  .where('status', 'in', ['completed', 'done'])
  .limit(500)
  .get();

const completedOrders = completedSnap.docs
  .map(doc => ({
    id: doc.id,
    ...doc.data(),
  }))
  .filter(order => {
    if (!riderPhone && !riderDocId) return false;

    const orderRiderPhone = normalizePhone(order.riderPhone || '');
    const orderRiderDocId = String(order.riderDocId || order.riderPhone || '').trim();

    if (riderPhone && orderRiderPhone && orderRiderPhone === riderPhone) {
      return true;
    }

    if (riderDocId && orderRiderDocId && orderRiderDocId === riderDocId) {
      return true;
    }

    return false;
  });

    let todayCompleted = 0;
    let todayIncome = 0;
    let totalCompleted = 0;
    let totalIncome = 0;

    let weekIncome = 0;
    let monthIncome = 0;
    let pendingIncome = 0;
    let settledIncome = 0;
    let platformIncome = 0;

    let cashCollectedTotal = 0;
    let cashDueToPlatform = 0;
    let platformPayToRider = 0;
    
    completedOrders.forEach(order => {
      totalCompleted += 1;

      const income = Number(
      order.driverFee ||
      order.riderFee ||
      order.fee ||
   0
 );

const orderTotal = Number(order.total || order.price || 0);

const orderPlatformIncome = Number(
  order.platformFee ||
  order.platformIncome ||
  order.serviceFee ||
  Math.max(0, orderTotal - income) ||
  0
);
      totalIncome += income;

      platformIncome += orderPlatformIncome;

const paymentMethodText = String(
  order.paymentMethod ||
  order.payMethod ||
  order.paymentType ||
  order.payment ||
  order.payType ||
  ''
).toLowerCase();

const isCashOrder =
  paymentMethodText.includes('cash') ||
  paymentMethodText.includes('現金');

const settlementStatus = String(order.settlementStatus || 'pending').toLowerCase();

if (isCashOrder) {
  cashCollectedTotal += orderTotal;
  cashDueToPlatform += orderPlatformIncome;
} else {
  if (settlementStatus === 'settled') {
    settledIncome += income;
  } else {
    pendingIncome += income;
    platformPayToRider += income;
  }
}
      
      let completedAtMs = 0;

      if (order.completedAt && typeof order.completedAt.toDate === 'function') {
        completedAtMs = order.completedAt.toDate().getTime();
      } else if (typeof order.completedAt === 'number') {
        completedAtMs = order.completedAt;
      } else if (
        order.statusTimes &&
        order.statusTimes.completed &&
        typeof order.statusTimes.completed.toDate === 'function'
      ) {
        completedAtMs = order.statusTimes.completed.toDate().getTime();
      } else if (typeof order.updatedAt === 'number') {
        completedAtMs = order.updatedAt;
      }

      if (completedAtMs >= todayStartMs && completedAtMs < tomorrowStartMs) {
        todayCompleted += 1;
        todayIncome += income;
      }
      const weekStartTaipei = new Date(todayStartTaipei);
weekStartTaipei.setDate(todayStartTaipei.getDate() - 6);

const monthStartTaipei = new Date(
  taipeiNow.getFullYear(),
  taipeiNow.getMonth(),
  1,
  0,
  0,
  0,
  0
);

const weekStartMs = weekStartTaipei.getTime();
const monthStartMs = monthStartTaipei.getTime();

if (completedAtMs >= weekStartMs && completedAtMs < tomorrowStartMs) {
  weekIncome += income;
}

if (completedAtMs >= monthStartMs && completedAtMs < tomorrowStartMs) {
  monthIncome += income;
}
    });

    return res.json({
      success: true,
      rider: {
        id: riderDoc.id,
        name: rider.name || rider.riderName || '',
        phone: rider.phone || '',
        vehicle: rider.vehicle || '',
        plateNumber:
          rider.plateNumber ||
          rider.plateNo ||
          rider.licensePlate ||
          '',
        serviceArea: rider.serviceArea || rider.area || '',
        approved: rider.approved === true || rider.status === 'approved',
        status: rider.status || '',
        online: rider.online === true,
        busy: rider.busy === true,
        currentOrderId: rider.currentOrderId || '',
      },
      summary: {
  todayCompleted,
  todayIncome,
  totalCompleted,
  totalIncome,

  weekIncome,
  monthIncome,

  pendingIncome,
  settledIncome,

  platformIncome,

  cashCollectedTotal,
  cashDueToPlatform,
  platformPayToRider,
},
    });

  } catch (err) {
    console.error('❌ 取得騎士統計失敗：', err);

    return res.status(500).json({
      success: false,
      message: '取得騎士統計失敗，請稍後再試。',
      error: err.message,
    });
  }
});

app.get('/api/admin/pending-settlements', async (req, res) => {
  try {
    const snap = await db.collection('orders')
      .where('status', '==', 'completed')
      .where('settlementStatus', '==', 'pending')
      .limit(100)
      .get();

    const orders = [];
    let pendingTotal = 0;

    snap.forEach(doc => {
      const order = {
        id: doc.id,
        ...doc.data()
      };

      const paymentText = String(
        order.paymentMethod ||
        order.payMethod ||
        order.paymentType ||
        order.payment ||
        ''
      ).toLowerCase();

      const isCashOrder =
        paymentText.includes('cash') ||
        paymentText.includes('現金');

      if (isCashOrder) {
        return;
      }

      const riderIncome = Number(
        order.riderFee ||
        order.driverFee ||
        order.fee ||
        0
      );

      pendingTotal += riderIncome;

      orders.push({
        id: order.id,
        orderNo: order.orderNo || order.id,
        riderId: order.riderId || order.riderLineUserId || order.driverId || '',
        riderName: order.riderName || order.driverName || '',
        paymentMethod: order.paymentMethod || order.payMethod || order.paymentType || '',
        riderFee: riderIncome,
        completedAt: order.completedAt || null,
        updatedAt: order.updatedAt || null
      });
    });

    orders.sort((a, b) => {
      const getMs = value => {
        if (!value) return 0;
        if (value.toDate) return value.toDate().getTime();
        if (value.seconds) return value.seconds * 1000;
        return new Date(value).getTime() || 0;
      };

      return getMs(b.completedAt || b.updatedAt) - getMs(a.completedAt || a.updatedAt);
    });

    res.json({
      success: true,
      pendingTotal,
      count: orders.length,
      orders
    });

  } catch (err) {
    console.error('pending settlements error:', err);
    res.status(500).json({
      success: false,
      message: '讀取待結算資料失敗',
      error: err.message
    });
  }
});

app.post('/api/admin/settle-order', async (req, res) => {
  try {
    const { orderId } = req.body || {};

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: '缺少 orderId'
      });
    }

    const ref = db.collection('orders').doc(orderId);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: '找不到訂單'
      });
    }

    const order = doc.data() || {};

    if (order.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: '只有已完成訂單可以結算'
      });
    }

    const paymentText = String(
      order.paymentMethod ||
      order.payMethod ||
      order.paymentType ||
      order.payment ||
      ''
    ).toLowerCase();

    const isCashOrder =
      paymentText.includes('cash') ||
      paymentText.includes('現金');

    if (isCashOrder) {
      return res.status(400).json({
        success: false,
        message: '現金單不應標記為平台撥款結算，應走待繳平台邏輯'
      });
    }

    await ref.update({
      settlementStatus: 'settled',
      settledAt: admin.firestore.FieldValue.serverTimestamp(),
      settledBy: 'admin'
    });

    res.json({
      success: true,
      message: '已完成結算',
      orderId
    });

  } catch (err) {
    console.error('settle order error:', err);
    res.status(500).json({
      success: false,
      message: '完成結算失敗',
      error: err.message
    });
  }
});

// 4. 騎士完成訂單列表：正式版只允許 approved 騎士查看
app.get('/api/rider/completed-orders', async (req, res) => {
  try {
    const { lineUserId, limit } = req.query;

    if (!lineUserId || !String(lineUserId).startsWith('U')) {
      return res.status(400).json({
        success: false,
        message: '缺少正確的騎士 LINE 身分。',
      });
    }

    const riderSnap = await db.collection('riders')
      .where('lineUserId', '==', lineUserId)
      .limit(1)
      .get();

    const riderOk = !riderSnap.empty && (
      riderSnap.docs[0].data().approved === true ||
      riderSnap.docs[0].data().status === 'approved'
    );

    if (!riderOk) {
      return res.status(403).json({
        success: false,
        message: '你尚未通過 UBee 騎士審核，暫時無法查看完成訂單。',
      });
    }

    const safeLimit = Math.min(Math.max(Number(limit || 20), 1), 50);

    const riderData = riderSnap.docs[0].data();
    const riderPhone = normalizePhone(riderData.phone || '');
    const riderDocId = riderSnap.docs[0].id;

    const completedSnap = await db.collection('orders')
      .where('riderLineUserId', '==', lineUserId)
      .where('status', '==', 'completed')
      .limit(200)
      .get();

    const completedOrders = completedSnap.docs
      .map(doc => {
        const order = {
          id: doc.id,
          ...doc.data(),
        };

        let completedAtMs = 0;

        if (order.completedAt && typeof order.completedAt.toDate === 'function') {
          completedAtMs = order.completedAt.toDate().getTime();
        } else if (typeof order.completedAt === 'number') {
          completedAtMs = order.completedAt;
        } else if (
          order.statusTimes &&
          order.statusTimes.completed &&
          typeof order.statusTimes.completed.toDate === 'function'
        ) {
          completedAtMs = order.statusTimes.completed.toDate().getTime();
        } else if (typeof order.updatedAt === 'number') {
          completedAtMs = order.updatedAt;
        }

        return {
          id: order.id,
          orderNo: order.orderNo || order.id,
          status: order.status,
          pickupAddress: order.pickupAddress || order.fromAddress || order.pickup || '',
          dropoffAddress: order.dropoffAddress || order.toAddress || order.dropoff || '',
          item: order.item || '',
          riderPhone: order.riderPhone || '',
          riderDocId: order.riderDocId || '',
          driverFee: Number(order.driverFee || order.riderFee || order.fee || order.price || 0),
          riderFee: Number(order.riderFee || order.driverFee || order.fee || order.price || 0),
          fee: Number(order.driverFee || order.riderFee || order.fee || order.price || 0),
          price: Number(order.driverFee || order.riderFee || order.fee || order.price || 0),
          total: Number(order.total || 0),
          completedAt: completedAtMs,
          completedAtText: completedAtMs
            ? new Date(completedAtMs).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
            : '',
        };
      })
      .filter(order => {
        if (!riderPhone && !riderDocId) return false;

        const orderRiderPhone = normalizePhone(order.riderPhone || '');
        const orderRiderDocId = String(order.riderDocId || order.riderPhone || '').trim();

        if (riderPhone && orderRiderPhone && orderRiderPhone === riderPhone) {
           return true;
        }

        if (riderDocId && orderRiderDocId && orderRiderDocId === riderDocId) {
          return true;
        }
          return false;
      })

      .sort((a, b) => Number(b.completedAt || 0) - Number(a.completedAt || 0))
      .slice(0, safeLimit);

    return res.json({
      success: true,
      orders: completedOrders,
    });

  } catch (err) {
    console.error('❌ 取得騎士完成訂單失敗：', err);

    return res.status(500).json({
      success: false,
      message: '取得騎士完成訂單失敗，請稍後再試。',
      error: err.message,
    });
  }
});

app.get('/order.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

app.get("/", (req, res) => {
  res.redirect("/order.html");
});

// ===== 騎手資料（暫存記憶體）=====
const riders = {};

// ===== 騎手註冊 API =====
app.post('/api/rider/register', async (req, res) => {
  try {
    const {
      name,
      phone,
      lineId,
      userId,
      lineUserId,
      district,
      vehicle,
      plateNumber,
      area,
      serviceArea,
      availableTime,
    } = req.body;

    if (!name || !phone || !vehicle || !(area || serviceArea)) {
      return res.json({
        success: false,
        message: '資料不完整，請確認姓名、電話、配送工具與服務區域都有填寫。',
      });
    }

const cleanPhone = normalizePhone(phone);
const riderLineUserId = lineUserId || userId || '';

// ===== 防止重複申請 =====
const existingRider = await db.collection('riders')
  .where('lineUserId', '==', riderLineUserId)
  .limit(1)
  .get();

if (riderLineUserId && !existingRider.empty) {
  const riderData = existingRider.docs[0].data();

  return res.json({
  success: false,
  duplicate: true,
  alreadyExists: true,
  message:
    riderData.status === 'approved'
      ? '你已通過 UBee 騎士審核。'
      : '你的資料已送出，請等待 UBee 審核通過。',
});
}

if(!/^09\d{8}$/.test(cleanPhone)){
  return res.json({
    success: false,
    message: '請輸入正確手機號碼。',
  });
}

if(String(name).trim().length < 2 || String(name).trim().length > 20){
  return res.json({
    success: false,
    message: '姓名長度需為 2～20 字。',
  });
}

if(plateNumber && String(plateNumber).trim().length > 20){
  return res.json({
    success: false,
    message: '車牌號碼不可超過 20 字。',
  });
}

    const riderId = cleanPhone;

const rider = {
  riderId,
  id: riderId,
  name: cleanText(name, 20),
  phone: cleanPhone,
  lineId: cleanText(lineId || '', 60),
  userId: riderLineUserId,
  lineUserId: riderLineUserId,
  district: cleanText(district || '', 80),
  vehicle: cleanText(vehicle, 40),
  plateNumber: cleanText(plateNumber || '', 20),
  area: cleanText(area || serviceArea || '', 80),
  serviceArea: cleanText(serviceArea || area || '', 80),
  availableTime: cleanText(availableTime || '', 80),
  approved: false,
  status: 'pending',
  online: false,
  busy: false,
  currentOrderId: '',
  createdAt: admin.firestore.FieldValue.serverTimestamp(),
  createdAtMs: Date.now(),
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
};
    await saveRider(rider);

    console.log('🟡 新騎手註冊：', rider);

    await pushToGroup(LINE_ADMIN_GROUP_ID, createRiderReviewFlex(rider));

        res.json({
      success: true,
      riderId,
      message: '已送出申請，等待 UBee 審核。',
    });
  } catch (err) {
    console.error('❌ 騎手註冊失敗：', err);

    res.status(500).json({
      success: false,
      message: '申請送出失敗，請稍後再試。',
    });
  }
});

// ===== 騎手上線 / 下線狀態 API =====
app.post('/api/rider/status', async (req, res) => {
  try {
    const { lineUserId, online } = req.body;

    if (!lineUserId || !String(lineUserId).startsWith('U')) {
      return res.status(400).json({
        success: false,
        message: '缺少正確的 LINE 身分。',
      });
    }

    if (typeof online !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: '上線狀態格式錯誤。',
      });
    }

    const snap = await db
      .collection('riders')
      .where('lineUserId', '==', lineUserId)
      .limit(1)
      .get();

    const riderOk = !snap.empty && (
  snap.docs[0].data().approved === true ||
  snap.docs[0].data().status === 'approved'
);

if (!riderOk) {
  return res.status(403).json({
    success: false,
    message: '騎手尚未審核通過，無法上線。',
  });
}

    const riderDoc = snap.docs[0];
    const rider = riderDoc.data();

    const updateData = {
      online,
      busy: rider.busy === true ? true : false,
      currentOrderId: rider.currentOrderId || '',
      lastActive: Date.now(),
      onlineUpdatedAt: Date.now(),
    };

    if (!online && rider.busy === true && rider.currentOrderId) {
  return res.status(409).json({
    success: false,
    message: '你目前有進行中的任務，完成後才能下線。',
  });
}

if (!online) {
  updateData.busy = false;
  updateData.currentOrderId = '';
}

    await db.collection('riders').doc(riderDoc.id).set(updateData, { merge: true });

    return res.json({
      success: true,
      message: online ? '已上線。' : '已下線。',
      online,
    });

  } catch (err) {
    console.error('❌ 騎手狀態更新失敗：', err);

    return res.status(500).json({
      success: false,
      message: '狀態更新失敗，請稍後再試。',
    });
  }
});

// ===== 商務合作申請 API =====
app.post('/api/business/register', async (req, res) => {
  try {
    const companyName = cleanText(
      req.body.companyName || req.body.businessName || '',
      80
    );

    const contactName = cleanText(req.body.contactName || '', 40);
    const phone = normalizePhone(req.body.phone || '');
    const lineId = cleanText(req.body.lineId || '', 60);

    const district = cleanText(
      req.body.district || req.body.address || '',
      120
    );

    const selectedTypes = Array.isArray(req.body.selectedTypes)
      ? req.body.selectedTypes
      : Array.isArray(req.body.cooperationTypes)
        ? req.body.cooperationTypes
        : [];

    const needType = cleanText(
      req.body.needType || req.body.mainNeed || '',
      80
    );

    const frequency = cleanText(req.body.frequency || '', 40);
    const deliveryArea = cleanText(req.body.deliveryArea || '', 120);
    const note = cleanLongText(req.body.note || '', 300);

    if (!companyName || !contactName || !phone || !district || !needType || !frequency || !deliveryArea) {
      return res.status(400).json({
        success: false,
        message: '資料不完整，請確認公司名稱、聯絡人、手機、所在區域與需求資料都有填寫。',
      });
    }

    if (!/^09\d{8}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: '手機號碼格式錯誤，請輸入 09 開頭的 10 碼手機號碼。',
      });
    }

    const businessLineUserId = cleanText(req.body.lineUserId || req.body.userId || '', 80);

    const businessPayload = {
      companyName,
      contactName,
      phone,
      lineId,
      district,
      selectedTypes: selectedTypes.map(t => cleanText(t, 40)).filter(Boolean),
      needType,
      frequency,
      deliveryArea,
      note,
      lineUserId: businessLineUserId,
      source: cleanText(req.body.source || 'ubee-business-web', 80),
      pageUrl: cleanText(req.body.pageUrl || '', 200),
      status: 'pending',
      updatedAt: new Date().toLocaleString('zh-TW'),
      updatedAtMs: Date.now(),
    };

    let businessId = '';

    if (businessLineUserId) {
      const existingBusiness = await db.collection('businessApplications')
        .where('lineUserId', '==', businessLineUserId)
        .limit(1)
        .get();

      if (!existingBusiness.empty) {
        const businessDoc = existingBusiness.docs[0];
        businessId = businessDoc.id;

        const updatedBusiness = {
          ...businessDoc.data(),
          ...businessPayload,
          businessId,
          resubmittedAt: new Date().toLocaleString('zh-TW'),
          resubmittedAtMs: Date.now(),
        };

        await db.collection('businessApplications').doc(businessId).set(updatedBusiness, { merge: true });

        console.log('🏢 店家合作重新送出，已更新最新資料：', updatedBusiness);

        try {
          await pushToGroup(LINE_ADMIN_GROUP_ID, createBusinessReviewFlex(updatedBusiness));
        } catch (pushErr) {
          console.error('⚠️ 商務合作群組通知失敗：', pushErr);
        }

        return res.json({
          success: true,
          updated: true,
          businessId,
          message: '合作需求已重新送出，UBee 將會依最新資料進行審核。',
        });
      }
    }

    businessId = 'B' + Date.now();

    const business = {
      businessId,
      ...businessPayload,
      createdAt: new Date().toLocaleString('zh-TW'),
      createdAtMs: Date.now(),
    };

    await db.collection('businessApplications').doc(businessId).set(business, { merge: true });

    console.log('🏢 新商務合作申請：', business);

    try {
      await pushToGroup(LINE_ADMIN_GROUP_ID, createBusinessReviewFlex(business));
    } catch (pushErr) {
      console.error('⚠️ 商務合作群組通知失敗：', pushErr);
    }

    return res.json({
      success: true,
      businessId,
      message: '合作需求已送出，UBee 將會進行審核與評估。',
    });

  } catch (err) {
    console.error('❌ 商務合作申請失敗：', err);

    return res.status(500).json({
      success: false,
      message: '合作需求送出失敗，請稍後再試。',
      error: err.message,
    });
  }
});

app.post('/api/merchant/register', async (req, res) => {
  try {
    const {
      merchantName,
      contactPerson,
      phone,
      lineId,
      pickupAddress,
      businessType,
      settlementType,
      dispatchFrequency,
      note,
    } = req.body || {};

    const cleanPhone = String(phone || '').replace(/\s+/g, '').replace(/-/g, '');

    if (!merchantName || !contactPerson || !cleanPhone || !pickupAddress || !businessType || !settlementType) {
      return res.status(400).json({
        ok: false,
        message: '請確認必填欄位都有填寫',
      });
    }

    if (!/^09\d{8}$/.test(cleanPhone)) {
      return res.status(400).json({
        ok: false,
        message: '請輸入正確的手機格式，例如：0912345678',
      });
    }

    const existsSnap = await db
      .collection('merchants')
      .where('phone', '==', cleanPhone)
      .limit(1)
      .get();

    if (!existsSnap.empty) {
      return res.status(409).json({
        ok: false,
        message: '這支電話已送出過店家合作申請，請勿重複送出',
      });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    const merchantRef = await db.collection('merchants').add({
      merchantName: String(merchantName).trim(),
      contactPerson: String(contactPerson).trim(),
      phone: cleanPhone,
      lineId: String(lineId || '').trim(),
      pickupAddress: String(pickupAddress).trim(),
      businessType: String(businessType).trim(),
      settlementType: String(settlementType).trim(),
      dispatchFrequency: String(dispatchFrequency || '').trim(),
      note: String(note || '').trim(),

      status: 'pending_review',
      approved: false,

      lineUserId: '',
      boundAt: null,

      source: 'merchant-register',
      createdAt: now,
      updatedAt: now,
    });

    return res.json({
      ok: true,
      message: '合作申請已送出，請等待 UBee 審核',
      merchantId: merchantRef.id,
    });
  } catch (err) {
    console.error('❌ /api/merchant/register error:', err);
    return res.status(500).json({
      ok: false,
      message: '店家合作申請送出失敗，請稍後再試',
    });
  }
});

// ===== 店家資料查詢 API：已綁定店家直接進入派單中心 =====
app.get('/api/merchant/profile', async (req, res) => {
  try {
    const lineUserId = String(req.query.lineUserId || '').trim();

    if (!lineUserId) {
      return res.status(400).json({
        ok: false,
        needBind: true,
        message: '缺少 LINE 使用者資料',
      });
    }

    const snap = await db
      .collection('merchants')
      .where('lineUserId', '==', lineUserId)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.json({
        ok: false,
        needBind: true,
        message: '尚未綁定店家帳號',
      });
    }

    const doc = snap.docs[0];
    const merchant = doc.data() || {};

    if (merchant.status !== 'approved' && merchant.approved !== true) {
      return res.status(403).json({
        ok: false,
        needBind: false,
        message: '您的店家帳號尚未審核通過，暫時無法使用店家派單中心',
      });
    }

    return res.json({
      ok: true,
      needBind: false,
      merchant: {
        id: doc.id,
        merchantName: merchant.merchantName || '',
        contactPerson: merchant.contactPerson || '',
        phone: merchant.phone || '',
        pickupAddress: merchant.pickupAddress || '',
        businessType: merchant.businessType || '',
        settlementType: merchant.settlementType || '',
        status: merchant.status || '',
        approved: merchant.approved === true,
      },
    });
  } catch (err) {
    console.error('❌ /api/merchant/profile error:', err);
    return res.status(500).json({
      ok: false,
      needBind: true,
      message: '店家資料讀取失敗，請稍後再試',
    });
  }
});

// ===== 店家電話綁定 API：第一次使用店家派單中心 =====
app.post('/api/merchant/bind', async (req, res) => {
  try {
    const { phone, lineUserId } = req.body || {};

    const cleanPhone = String(phone || '').replace(/\s+/g, '').replace(/-/g, '');
    const cleanLineUserId = String(lineUserId || '').trim();

    if (!cleanLineUserId) {
      return res.status(400).json({
        ok: false,
        message: '缺少 LINE 使用者資料，請從店家合作中心官方帳號重新開啟',
      });
    }

    if (!/^09\d{8}$/.test(cleanPhone)) {
      return res.status(400).json({
        ok: false,
        message: '請輸入申請合作時填寫的手機號碼，例如：0912345678',
      });
    }

    const snap = await db
      .collection('merchants')
      .where('phone', '==', cleanPhone)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({
        ok: false,
        message: '查無店家合作資料，請先完成店家合作申請',
      });
    }

    const doc = snap.docs[0];
    const merchant = doc.data() || {};

    if (merchant.status !== 'approved' && merchant.approved !== true) {
      return res.status(403).json({
        ok: false,
        message: '您的店家合作申請尚未審核通過，暫時無法使用店家派單中心',
      });
    }

    if (merchant.lineUserId && merchant.lineUserId !== cleanLineUserId) {
      return res.status(409).json({
        ok: false,
        message: '此店家帳號已完成綁定，如需更換管理者，請聯繫 UBee 客服',
      });
    }

    await doc.ref.update({
      lineUserId: cleanLineUserId,
      boundAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      ok: true,
      message: '店家帳號綁定成功',
      merchant: {
        id: doc.id,
        merchantName: merchant.merchantName || '',
        contactPerson: merchant.contactPerson || '',
        phone: merchant.phone || '',
        pickupAddress: merchant.pickupAddress || '',
        businessType: merchant.businessType || '',
        settlementType: merchant.settlementType || '',
        status: merchant.status || '',
        approved: true,
      },
    });
  } catch (err) {
    console.error('❌ /api/merchant/bind error:', err);
    return res.status(500).json({
      ok: false,
      message: '店家帳號綁定失敗，請稍後再試',
    });
  }
});

const PRICING = {
  baseFee: 80,
  perKm: 18,
  perMinute: 3,
  serviceFee: 25,
  waitingFee: 60,
  driverRatio: 0.7,
};

const SPEED_OPTIONS = {
  standard: { label: '一般件', time: '60–90 分鐘', fee: 20, riderText: '一般任務' },
  priority: { label: '標準件', time: '45–60 分鐘', fee: 25, riderText: '標準任務' },
  express: { label: '優先件', time: '30–45 分鐘', fee: 30, riderText: '優先任務' },
};
const ETA_OPTIONS = [5, 7, 8, 10, 12, 15, 17, 20, 25];

const orders = {};
const userSessions = {};
const distanceCache = new Map();
let orderCounter = 1;

async function saveOrder(order) {
  if (!order || !order.id) return order;

  orders[order.id] = order;

  await db.collection('orders').doc(order.id).set(order, { merge: true });

  if (order.status === 'pending_dispatch' && !order.pushSentAt) {
    await sendNewOrderPushToRiders(order);

    await db.collection('orders').doc(order.id).set({
      pushSentAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    order.pushSentAt = Date.now();
  }

  return order;
}

async function getOrder(orderId) {
  const id = String(orderId || '').toUpperCase();
  if (!id) return null;

  if (orders[id]) return orders[id];

  const doc = await db.collection('orders').doc(id).get();
  if (!doc.exists) return null;

  const order = doc.data();
  orders[id] = order;
  return order;
}

async function saveRider(rider) {
  if (!rider) return rider;

  const cleanPhone = normalizePhone(rider.phone || '');

  if (!/^09\d{8}$/.test(cleanPhone)) {
    throw new Error('RIDER_PHONE_INVALID');
  }

  const riderId = cleanPhone;

  const payload = {
    ...rider,
    id: riderId,
    riderId: rider.riderId || riderId,
    phone: cleanPhone,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  riders[riderId] = payload;

  await db.collection('riders').doc(riderId).set(payload, { merge: true });

  return payload;
}

async function getRider(riderId) {
  const id = String(riderId || '').trim();
  if (!id) return null;

  if (riders[id]) return riders[id];

  const doc = await db.collection('riders').doc(id).get();
  if (!doc.exists) return null;

  const rider = {
    id: doc.id,
    ...doc.data(),
  };

  riders[id] = rider;
  return rider;
}

function generateOrderId() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const no = String(orderCounter++).padStart(3, '0');
  return `UB${yyyy}${mm}${dd}${hh}${mi}${ss}${no}`;
}

function formatCurrency(value) {
  return `NT$${Math.round(Number(value || 0))}`;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '');
}

function normalizeAddress(address) {
  return String(address || '').trim().replace(/\s+/g, '');
}

function normalizeTaskAddressForMaps(address) {
  let text = String(address || '')
    .replace(/台灣/g, '')
    .replace(/臺灣/g, '')
    .replace(/\s+/g, '')
    .trim();

  if (!text) return '';

  if (text.includes('台中市') || text.includes('臺中市')) {
    return `台灣 ${text}`;
  }

  if (text.includes('豐原區')) {
    return `台灣 台中市 ${text}`;
  }

  return `台灣 台中市 豐原區 ${text}`;
}

function getDistanceCacheKey(origin, destination) {
  return `${normalizeAddress(origin)}=>${normalizeAddress(destination)}`;
}

function getPublicUrl(fileName) {
  return BASE_URL ? `${BASE_URL}/${fileName}` : `/${fileName}`;
}

function buildGoogleMapDirectionsUrl(address) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address || '')}`;
}

function buildTelUrl(phone) {
  const clean = normalizePhone(phone);
  return clean ? `tel:${clean}` : 'tel:';
}

function getSpeedOption(speedType) {
  return SPEED_OPTIONS[speedType] || SPEED_OPTIONS.standard;
}

function getPaymentMethodLabel(method) {
  return ({
    cash: '現金付款',
    jko: '街口支付',
    bank: '銀行轉帳',
  }[method] || '未選擇');
}

function getPaymentInfo(method, total) {
  if (method === 'cash') {
    return `現金付款\n請於任務完成時，將 NT$${Math.round(Number(total || 0))} 交付給騎士。`;
  }

  if (method === 'jko') {
    return PAYMENT_JKO_INFO;
  }

  if (method === 'bank') {
    return PAYMENT_BANK_INFO;
  }

  return '';
}

function isAdminUser(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

function getStatusLabel(status) {
  return ({
    draft_confirm: '📝 待確認',
    pending_payment: '💳 待付款',
    pending_dispatch: '🟡 待派單',
    accepted: '🟢 已接單',
    arrived_pickup: '🟠 已抵達取件地點',
    picked_up: '🔵 已取件',
    arrived_dropoff: '🟣 已抵達送達地點',
    completed: '✅ 已完成',
    cancelled: '⚪ 已取消',
    quote_only: '💰 估價完成',
  }[status] || status);
}

function createTextMessage(text) {
  return { type: 'text', text };
}

function toMessageArray(messages) {
  return Array.isArray(messages) ? messages : [messages];
}

function replyText(replyToken, text) {
  return client.replyMessage(replyToken, [createTextMessage(text)]);
}

function replyMessages(replyToken, messages) {
  return client.replyMessage(replyToken, toMessageArray(messages));
}

function getPostbackValue(data, key) {
  const prefix = `${key}=`;
  if (!String(data || '').startsWith(prefix)) return '';
  return String(data).slice(prefix.length);
}

function isAdminGroup(event) {
  return (event.source.groupId || '') === LINE_ADMIN_GROUP_ID;
}

function isTerminalOrderStatus(order) {
  return ['completed', 'cancelled'].includes(order?.status);
}

function isOrderCustomer(event, order) {
  const userId = event?.source?.userId || '';
  const customerUserId = order?.userId || order?.customerId || '';
  return !!userId && !!customerUserId && customerUserId !== 'web-order' && userId === customerUserId;
}

const ORDER_INPUT_LIMITS = {
  serviceType: 30,
  serviceGroup: 30,
  item: 80,
  pickupAddress: 120,
  pickupPhone: 20,
  dropoffAddress: 120,
  dropoffPhone: 20,
  note: 300,
};

const DUPLICATE_ORDER_WINDOW_MS = 90 * 1000;

function cleanText(value, maxLength = 100) {
  return String(value || '')
    .replace(/[<>]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanLongText(value, maxLength = 200) {
  return String(value || '')
    .replace(/[<>]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .slice(0, maxLength);
}

function isValidCustomerUserId(userId) {
  return !!userId && userId !== 'web-order' && /^U[a-zA-Z0-9]{20,}$/.test(String(userId));
}

function getCustomerUserIdFromBody(body = {}) {
  return String(body.userId || body.customerId || '').trim();
}

function isSameCustomerUserId(order, requestUserId) {
  const orderUserId = String(order?.userId || order?.customerId || '').trim();
  const userId = String(requestUserId || '').trim();
  return isValidCustomerUserId(userId) && orderUserId && orderUserId !== 'web-order' && orderUserId === userId;
}

function validateOrderInput(data) {
  const errors = [];

  if (!isValidCustomerUserId(data.userId)) {
    errors.push('LINE 身分驗證失敗，請重新從官方帳號點「立即下單」。');
  }

  if (!data.pickupAddress || !data.dropoffAddress || !data.pickupPhone || !data.dropoffPhone || !data.item) {
    errors.push('請完整填寫取件地址、送達地址、電話與物品內容。');
  }

  Object.entries(ORDER_INPUT_LIMITS).forEach(([key, limit]) => {
    if (String(data[key] || '').length > limit) {
      errors.push(`${key} 欄位過長，請縮短內容。`);
    }
  });

  return errors;
}

function getDuplicateFingerprint(data) {
  return [
    String(data.userId || '').trim(),
    String(data.serviceGroup || '').trim(),
    String(data.serviceType || '').trim(),
    normalizeAddress(data.pickupAddress),
    normalizeAddress(data.dropoffAddress),
    String(data.pickupPhone || '').trim(),
    String(data.dropoffPhone || '').trim(),
    cleanText(data.item, ORDER_INPUT_LIMITS.item),
    String(data.speedType || 'standard'),
  ].join('|');
}

async function findRecentDuplicateOrder(data) {
  const now = Date.now();
  const fingerprint = getDuplicateFingerprint(data);

  for (const order of Object.values(orders)) {
    if (!order || !order.createdAt) continue;
    if (now - Number(order.createdAt) > DUPLICATE_ORDER_WINDOW_MS) continue;
    if (['cancelled', 'completed'].includes(order.status)) continue;
    if (order.duplicateFingerprint === fingerprint) return order;
  }

  try {
    const snap = await db
      .collection('orders')
      .where('userId', '==', data.userId)
      .where('duplicateFingerprint', '==', fingerprint)
      .where('createdAt', '>=', now - DUPLICATE_ORDER_WINDOW_MS)
      .limit(1)
      .get();

    if (!snap.empty) return snap.docs[0].data();
  } catch (err) {
    console.error('❌ 查詢重複訂單失敗：', err);
  }

  return null;
}

async function requireAdminPermission(event, actionText = '此操作') {
  if (!isAdminGroup(event)) {
    await replyText(event.replyToken, `${actionText}只能在 UBee 辦公室審核群組操作。`);
    return false;
  }

  if (!isAdminUser(event.source.userId)) {
    await replyText(event.replyToken, `你沒有權限執行${actionText}。`);
    return false;
  }

  return true;
}

async function isApprovedRiderUser(userId) {
  if (!userId) return false;

  if (APPROVED_RIDER_IDS.includes(userId)) return true;

  try {
    const snap = await db.collection('riders')
      .where('lineUserId', '==', userId)
      .limit(1)
      .get();

    if (snap.empty) return false;

    const rider = snap.docs[0].data();

    return rider.approved === true || rider.status === 'approved';
  } catch (err) {
    console.error('❌ 查詢騎士審核狀態失敗：', err);
    return false;
  }
}

async function requireApprovedRider(event) {
  const userId = event.source.userId;

  const approved = await isApprovedRiderUser(userId);

  if (!approved) {
    await replyText(
      event.replyToken,
      '你尚未通過 UBee 騎士審核，暫時無法接單。\n\n請先完成審核流程後，再開始接收任務。'
    );
    return false;
  }

  return true;
}

async function requireOrderStatus(event, order, allowedStatuses, message) {
  if (!order) {
    await replyText(event.replyToken, '找不到此訂單。');
    return false;
  }

  if (isTerminalOrderStatus(order)) {
    await replyText(
      event.replyToken,
      `此訂單目前狀態為「${getStatusLabel(order.status)}」，不可再操作。`
    );
    return false;
  }

  if (!allowedStatuses.includes(order.status)) {
    await replyText(event.replyToken, message);
    return false;
  }

  return true;
}

async function requireOrderCustomer(event, order) {
  if (!isOrderCustomer(event, order)) {
    await replyText(event.replyToken, '此操作只能由原本下單的客人確認。');
    return false;
  }

  return true;
}

async function getOrderOrReply(replyToken, orderId, notFoundText = '查無此訂單，請確認訂單編號是否正確。') {
  const order = await getOrder(orderId);
  if (!order) {
    await replyText(replyToken, notFoundText);
    return null;
  }
  return order;
}

async function getRiderOrReply(replyToken, riderId) {
  const rider = await getRider(riderId);
  if (!rider) {
    await replyText(replyToken, '找不到此騎士申請，可能是系統重啟後暫存資料已消失。');
    return null;
  }
  return rider;
}

async function requireOrderRider(event, order, message = '只有接單騎士可以操作此訂單。') {
  if (order.riderId !== event.source.userId) {
    await replyText(event.replyToken, message);
    return false;
  }
  return true;
}

async function updateOrderStatus(order, status, extra = {}) {
  order.status = status;
  Object.assign(order, extra);
  await saveOrder(order);
  return order;
}

async function forceCancelOrder(order, userId, reason = 'admin_force_cancel') {
  order.status = 'cancelled';
  order.cancelType = 'admin_force';
  order.cancelledBy = userId;
  order.cancelledAt = Date.now();
  order.cancelReason = reason;
  await saveOrder(order);
  return order;
}

async function notifyForceCancel(order) {
  await notifyCustomer(order, createTextMessage(
    `⚠️ UBee 訂單通知\n\n` +
    `你的訂單已由 UBee 客服取消。\n\n` +
    `訂單編號：${order.id}\n` +
    `如有付款或退款問題，請聯繫 UBee 客服。`
  ));
}

async function handleAdminForceCancel(event, orderId, reason, groupDenyText) {
  const userId = event.source.userId;

  if (!isAdminGroup(event)) {
    return replyText(event.replyToken, groupDenyText);
  }

  if (!isAdminUser(userId)) {
    return replyText(event.replyToken, '你沒有權限操作強制取消訂單。');
  }

  const order = await getOrderOrReply(event.replyToken, orderId);
  if (!order) return null;

  if (['completed', 'cancelled'].includes(order.status)) {
    return replyText(
      event.replyToken,
      `此訂單目前狀態為「${getStatusLabel(order.status)}」，不可重複取消。`
    );
  }

  await forceCancelOrder(order, userId, reason);

  await replyText(
    event.replyToken,
    `✅ 已強制取消訂單\n\n` +
    `訂單編號：${order.id}\n` +
    `目前狀態：${getStatusLabel(order.status)}`
  );

  await notifyForceCancel(order);
  return null;
}

function createFlexMessage(altText, bubble) {
  return { type: 'flex', altText, contents: bubble };
}

function createActionButton(label, data, style = 'primary') {
  return {
    type: 'button',
    style,
    height: 'sm',
    action: { type: 'postback', label, data },
  };
}

function createUriButton(label, uri, style = 'secondary') {
  return {
    type: 'button',
    style,
    height: 'sm',
    action: { type: 'uri', label, uri },
  };
}

function createInfoRow(label, value, wrap = true) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#666666', flex: 3 },
      { type: 'text', text: String(value || '-'), size: 'sm', color: '#111111', wrap, flex: 7 },
    ],
  };
}

function createTextBlock(title, text) {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'xs',
    paddingAll: '12px',
    backgroundColor: '#F7F7F7',
    cornerRadius: '12px',
    contents: [
      { type: 'text', text: title, weight: 'bold', size: 'sm', color: '#111111', wrap: true },
      { type: 'text', text, size: 'sm', color: '#555555', wrap: true, margin: 'xs' },
    ],
  };
}

function createBubble(title, bodyContents, footerContents = []) {
  const bubble = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [{ type: 'text', text: title, weight: 'bold', size: 'lg', color: '#111111' }],
      paddingAll: '16px',
      backgroundColor: '#FFF4CC',
    },
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: bodyContents },
  };

  if (footerContents.length > 0) {
    bubble.footer = { type: 'box', layout: 'vertical', spacing: 'sm', contents: footerContents };
  }

  return bubble;
}

async function pushToUser(userId, messages) {
  if (!userId || userId === 'web-order') return;
  const list = Array.isArray(messages) ? messages : [messages];
  await client.pushMessage(userId, list);
}

async function notifyCustomer(order, messages) {
  console.log(`UBee 客人 LINE 通知已暫停：${order?.id || 'UNKNOWN'}`);
  return false;
}

async function pushToGroup(groupId, messages) {
  if (!groupId) return;
  const list = Array.isArray(messages) ? messages : [messages];
  await client.pushMessage(groupId, list);
}

function safeText(value, fallback = '無') {
  const text = String(value || '').trim();
  return text || fallback;
}

async function getDistanceMatrix(origin, destination) {
  const originText = String(origin || '').trim();
  const destinationText = String(destination || '').trim();

  const isLatLngOrigin = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(originText);

  const cleanOrigin = isLatLngOrigin
  ? originText
  : normalizeTaskAddressForMaps(originText);

  const cleanDestination = normalizeTaskAddressForMaps(destinationText);
  const url =
  'https://maps.googleapis.com/maps/api/distancematrix/json' +
  `?origins=${encodeURIComponent(cleanOrigin)}` +
  `&destinations=${encodeURIComponent(cleanDestination)}` +
  `&mode=driving` +
  `&region=tw` +
  `&language=zh-TW&units=metric&key=${GOOGLE_MAPS_API_KEY}`;
  
  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK') {
    throw new Error(`Distance Matrix API 錯誤：${data.status}`);
  }

  const element = data.rows?.[0]?.elements?.[0];

  if (!element || element.status !== 'OK') {
    throw new Error(`距離計算失敗：${element?.status || 'UNKNOWN'}`);
  }

  return {
    distanceMeters: element.distance.value,
    durationSeconds: element.duration.value,
    distanceText: element.distance.text,
    durationText: element.duration.text,
  };
}

async function getDistanceMatrixCached(origin, destination) {
  const key = getDistanceCacheKey(origin, destination);
  if (distanceCache.has(key)) return distanceCache.get(key);
  const distance = await getDistanceMatrix(origin, destination);
  distanceCache.set(key, distance);
  return distance;
}

function calculatePrice({ distanceMeters, durationSeconds, speedType }) {
  const km = distanceMeters / 1000;
  const minutes = durationSeconds / 60;
  const speed = getSpeedOption(speedType);

  const deliveryFee = Math.round(
    PRICING.baseFee + km * PRICING.perKm + minutes * PRICING.perMinute
  );

  const total = deliveryFee + PRICING.serviceFee + speed.fee;
  const driverFee = Math.round(total * PRICING.driverRatio);

  return {
    deliveryFee,
    serviceFee: PRICING.serviceFee,
    speedFee: speed.fee,
    waitingFee: 0,
    total,
    driverFee,
    platformFee: total - driverFee,
  };
}

function recalculateOrderFinancials(order) {
  const total =
    Number(order.deliveryFee || 0) +
    Number(order.serviceFee || 0) +
    Number(order.speedFee || 0) +
    Number(order.waitingFee || 0);

  order.total = Math.round(total);
  order.driverFee = Math.round(order.total * PRICING.driverRatio);
  order.platformFee = order.total - order.driverFee;
  return order;
}

function createMainMenuFlex() {
  return createFlexMessage('UBee 主選單', createBubble(
    'UBee 主選單',
    [{ type: 'text', text: '請選擇你要使用的功能。', size: 'sm', color: '#666666', wrap: true }],
    [
      createUriButton('立即下單', getPublicUrl('order.html'), 'primary'),
      createUriButton('商務合作', getPublicUrl('business.html'), 'secondary'),
      createUriButton('我的資訊', getPublicUrl('info.html'), 'secondary'),
    ]
  ));
}

function createRiderReviewFlex(rider) {
  return createFlexMessage('新騎士申請審核', createBubble(
    '🟡 新騎士申請審核',
    [
      createInfoRow('申請編號', rider.riderId),
      createInfoRow('姓名', rider.name),
      createInfoRow('手機', rider.phone),
      createInfoRow('LINE ID', rider.lineId || rider.userId || '-'),
      createInfoRow('居住地區', rider.district || '-'),
      createInfoRow('配送工具', rider.vehicle),
      createInfoRow('車牌號碼', rider.plateNumber || '-'),
      createInfoRow('服務區域', rider.serviceArea || rider.area || '-'),
      createInfoRow('服務時段', rider.availableTime || '-'),
      createInfoRow('狀態', rider.status === 'pending' ? '待審核' : rider.status),
      createInfoRow('申請時間', rider.createdAt),
      {
        type: 'text',
        text: '請確認資料無誤後，再按「通過審核」。',
        size: 'sm',
        color: '#666666',
        wrap: true,
        margin: 'md',
      },
    ],
    [
      createActionButton('通過審核', `approveRider=${rider.riderId}`),
      createActionButton('拒絕申請', `rejectRider=${rider.riderId}`, 'secondary'),
    ]
  ));
}

function createBusinessReviewFlex(business) {
  const safe = (v, fallback = '未填寫') => {
    if (v === undefined || v === null || v === '') return fallback;
    return String(v);
  };

  const selectedTypesText =
    Array.isArray(business.selectedTypes) && business.selectedTypes.length
      ? business.selectedTypes.join('、')
      : safe(business.needType);

  return createFlexMessage('新商務合作申請', createBubble(
    '🏢 新商務合作申請',
    [
      createInfoRow('申請編號', safe(business.businessId)),
      createInfoRow('公司 / 店家', safe(business.companyName)),
      createInfoRow('聯絡人', safe(business.contactName)),
      createInfoRow('手機', safe(business.phone)),
      createInfoRow('LINE ID', safe(business.lineId)),
      createInfoRow('所在區域', safe(business.district)),
      createInfoRow('合作類型', selectedTypesText),
      createInfoRow('主要需求', safe(business.needType)),
      createInfoRow('需求頻率', safe(business.frequency)),
      createInfoRow('配送區域', safe(business.deliveryArea)),
      createInfoRow('備註', safe(business.note, '無')),
      createInfoRow('狀態', '待審核 / 待聯繫'),
      createInfoRow('送出時間', safe(business.createdAt || business.updatedAt || business.resubmittedAt)),
      {
        type: 'text',
        text: '此為企業 / 店家合作需求，請 UBee 辦公室評估後主動聯繫。',
        size: 'sm',
        color: '#666666',
        wrap: true,
        margin: 'md',
      },
    ],
    [
      createUriButton('撥打聯絡人', buildTelUrl(safe(business.phone, ''))),
      {
        type: 'button',
        style: 'secondary',
        action: {
          type: 'postback',
          label: '審核通過',
          data: `business_approve:${safe(business.businessId, '')}`
        }
      }
    ]
  ));
}

function createOrderStatusFlex(order) {
  return createFlexMessage('訂單查詢結果', createBubble(
    '訂單查詢結果',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('目前狀態', getStatusLabel(order.status)),
      createInfoRow('配送速度', getSpeedOption(order.speedType).label),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('抵達取件時間', order.etaMinutes ? `${order.etaMinutes} 分鐘` : '尚未設定'),
      createInfoRow('付款狀態', order.isPaid ? '已付款' : '尚未付款'),
      createInfoRow('付款方式', getPaymentMethodLabel(order.paymentMethod)),
      createInfoRow('目前總金額', formatCurrency(order.total)),
    ],
    [createActionButton('返回我的資訊', 'menu=info', 'secondary')]
  ));
}

function createOrderConfirmFlex(order) {
  const speed = getSpeedOption(order.speedType);
  return createFlexMessage('確認建立任務', createBubble(
    '確認建立任務',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('服務類型', order.serviceType),
      createInfoRow('配送速度', `${speed.label}｜${speed.time}`),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('取件電話', order.pickupPhone),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('送達電話', order.dropoffPhone),
      createInfoRow('物品內容', order.item),
      createInfoRow('備註', order.note || '無'),
      { type: 'separator', margin: 'md' },
      createInfoRow('距離', order.distanceText),
      createInfoRow('時間', order.durationText),
      createInfoRow('配送費', formatCurrency(order.deliveryFee)),
      createInfoRow('服務費', formatCurrency(order.serviceFee)),
      createInfoRow('系統費', formatCurrency(order.speedFee)),
      createInfoRow('總金額', formatCurrency(order.total)),
    ],
    [
      createActionButton('確認並前往付款', `confirmCreate=${order.id}`),
      createActionButton('取消', `cancelCreate=${order.id}`, 'secondary'),
    ]
  ));
}

// ✅ 新增：辦公室審核群組專用強制取消卡
function createAdminForceCancelFlex(order) {
  return createFlexMessage('UBee 辦公室訂單管理', createBubble(
    'UBee 辦公室訂單管理',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('目前狀態', getStatusLabel(order.status)),
      createInfoRow('服務類型', order.serviceType),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('取件電話', order.pickupPhone),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('送達電話', order.dropoffPhone),
      createInfoRow('物品內容', order.item),
      createInfoRow('備註', order.note || '無'),
      createInfoRow('客戶總金額', formatCurrency(order.total)),
      createInfoRow('付款方式', getPaymentMethodLabel(order.paymentMethod)),
      {
        type: 'text',
        text: '此卡片僅供 UBee 辦公室管理使用。必要時可強制取消此訂單。',
        size: 'sm',
        color: '#666666',
        wrap: true,
        margin: 'md',
      },
    ],
    [
      createActionButton('⚠️ 強制取消此訂單', `forceCancel=${order.id}`, 'primary'),
    ]
  ));
}

function createEtaRow(orderId, minutesList) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: minutesList.map((minutes) =>
      createActionButton(`${minutes}分鐘`, `eta=${orderId}=${minutes}`, 'primary')
    ),
  };
}

function createETAFlex(order) {
  return createFlexMessage('請選擇抵達取件地點時間', createBubble(
    '請選擇抵達取件地點時間',
    [
      { type: 'text', text: '請選擇預計抵達取件地點時間。', size: 'sm', color: '#666666', wrap: true },
      createInfoRow('訂單編號', order.id),
      createInfoRow('取件地址', order.pickupAddress),
      createEtaRow(order.id, [5, 7, 8]),
      createEtaRow(order.id, [10, 12, 15]),
      createEtaRow(order.id, [17, 20, 25]),
    ]
  ));
}

function createRiderControlFlex(order) {
  const footerButtons = [];

  if (order.status === 'accepted') {
    footerButtons.push(createUriButton('撥打取件電話', buildTelUrl(order.pickupPhone), 'secondary'));
    footerButtons.push(createActionButton('已抵達取件地點', `arrivedPickup=${order.id}`));
    footerButtons.push(createActionButton('已取件完成', `pickedUp=${order.id}`));
  }

  if (order.status === 'arrived_pickup') {
    footerButtons.push(createUriButton('撥打取件電話', buildTelUrl(order.pickupPhone), 'secondary'));
    footerButtons.push(createActionButton('申請等候費 $60', `requestWaitingFee=${order.id}`));
    footerButtons.push(createActionButton('已取件完成', `pickedUp=${order.id}`));
  }

  if (order.status === 'picked_up') {
    footerButtons.push(createUriButton('導航到送達地點', buildGoogleMapDirectionsUrl(order.dropoffAddress)));
    footerButtons.push(createUriButton('撥打送達電話', buildTelUrl(order.dropoffPhone), 'secondary'));
    footerButtons.push(createActionButton('已抵達送達地點', `arrivedDropoff=${order.id}`));
  }

  if (order.status === 'arrived_dropoff') {
    footerButtons.push(createUriButton('撥打送達電話', buildTelUrl(order.dropoffPhone), 'secondary'));
    footerButtons.push(createActionButton('已完成', `completed=${order.id}`));
  }

  return createFlexMessage('騎士任務操作', createBubble(
    '騎士任務操作',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('狀態', getStatusLabel(order.status)),
      createInfoRow('抵達取件時間', order.etaMinutes ? `${order.etaMinutes} 分鐘` : '尚未設定'),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('取件電話', order.pickupPhone),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('送達電話', order.dropoffPhone),
      createInfoRow('騎手收入', formatCurrency(order.driverFee)),
    ],
    footerButtons
  ));
}

function createPaymentInfoFlex(order) {
  const paymentInfo = order.paymentMethod === 'jko' ? PAYMENT_JKO_INFO : PAYMENT_BANK_INFO;

  return createFlexMessage('付款資訊', createBubble(
    order.paymentMethod === 'jko' ? '街口支付資訊' : '銀行轉帳資訊',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('付款方式', getPaymentMethodLabel(order.paymentMethod)),
      createInfoRow('應付金額', formatCurrency(order.total)),
      { type: 'separator', margin: 'md' },
      { type: 'text', text: paymentInfo, size: 'sm', color: '#111111', wrap: true },
      { type: 'text', text: '完成付款後，請按「我已付款」，系統才會派單。', size: 'sm', color: '#666666', wrap: true },
    ]
  ));
}

function createWaitingFeeConfirmFlex(order) {
  return createFlexMessage('等候費確認', createBubble(
    '等候費確認',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('申請金額', formatCurrency(PRICING.waitingFee)),
      { type: 'text', text: '騎士已抵達現場並等候超過 3–5 分鐘，將申請等候費 NT$60。請問是否同意加收？', size: 'sm', color: '#333333', wrap: true },
    ],
    [
      createActionButton('同意加收 $60', `waitingApprove=${order.id}`),
      createActionButton('不同意加收', `waitingReject=${order.id}`, 'secondary'),
    ]
  ));
}

function createFinanceFlex(order) {
  const total = order.total || 0;
  const driver = Math.floor(total * 0.6);
  const platform = total - driver;

  const distanceKm = Math.ceil((order.distanceMeters || 0) / 1000);
  const durationMin = Math.ceil((order.durationSeconds || 0) / 60);

  const baseIncome = order.deliveryFee || 0;
  const urgentFee = order.speedFee || 0;
  const waitingFee = order.waitingFee || 0;

  return {
    type: 'flex',
    altText: '財務明細',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            paddingAll: '16px',
            backgroundColor: '#111111',
            contents: [
              { type: 'text', text: '💰 財務明細', color: '#ffffff', weight: 'bold', size: 'lg' },
              { type: 'text', text: `訂單編號：${order.id}`, color: '#cccccc', size: 'sm', margin: 'sm' }
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F2EAD3',
            paddingAll: '16px',
            cornerRadius: '12px',
            contents: [
              { type: 'text', text: `客戶支付：$${total}`, weight: 'bold', size: 'xl' }
            ]
          },
          createInfoRow('取件地點', order.pickupAddress),
          createInfoRow('取件電話', order.pickupPhone),
          createInfoRow('送達地點', order.dropoffAddress),
          createInfoRow('送達電話', order.dropoffPhone),
          createInfoRow('物品內容', order.item),
          createInfoRow('備註', order.note || '無'),
          createInfoRow('距離', `${distanceKm} 公里`),
          createInfoRow('時間', `${durationMin} 分鐘`),
          { type: 'separator', margin: 'md' },
          createInfoRow('騎士收入', `$${driver}`),
          createInfoRow('平台收入', `$${platform}`),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '附加費明細', weight: 'bold', margin: 'md' },
          createInfoRow('急件費', `$${urgentFee}`),
          createInfoRow('等候費', `$${waitingFee}`),
          createInfoRow('附加費總額', `$${urgentFee + waitingFee}`),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '收入拆解', weight: 'bold', margin: 'md' },
          createInfoRow('基礎收入', `$${baseIncome}`),
          createInfoRow('附加收入', `$${urgentFee + waitingFee}`)
        ]
      }
    }
  };
}

function createOrderFromApi(data) {
  const userId = cleanText(data.userId || data.customerId || '', 80);

  const serviceGroupMap = {
    send: '幫我送',
    pickup: '幫我取',
    buy: '幫代買',
    queue: '幫排隊',
    life: '生活跑腿',
  };

  const rawServiceGroup = cleanText(data.serviceGroup || '', ORDER_INPUT_LIMITS.serviceGroup);
  const serviceGroupLabel = serviceGroupMap[rawServiceGroup] || rawServiceGroup || '';

  return {
    userId,
    customerId: userId,
    serviceGroup: serviceGroupLabel,
    serviceType: cleanText(data.serviceType || ''),
    serviceMode: cleanText(data.serviceMode || 'normal'),
    serviceKey: cleanText(data.serviceKey || ''),
    queueMinutes: Math.max(0, Math.round(Number(data.queueMinutes || 0))),    item: cleanText(data.item || '', ORDER_INPUT_LIMITS.item),
    pickupAddress: cleanText(data.pickup || data.pickupAddress || '', ORDER_INPUT_LIMITS.pickupAddress),
    pickupPhone: normalizePhone(cleanText(data.pickupPhone || '', ORDER_INPUT_LIMITS.pickupPhone)),
    dropoffAddress: cleanText(data.dropoff || data.dropoffAddress || '', ORDER_INPUT_LIMITS.dropoffAddress),
    dropoffPhone: normalizePhone(cleanText(data.dropoffPhone || '', ORDER_INPUT_LIMITS.dropoffPhone)),
    speedType: ['standard', 'priority', 'express', 'rush'].includes(data.speedType || data.speed)
      ? (data.speedType || data.speed)
      : 'standard',
    note: cleanLongText(data.note || '', ORDER_INPUT_LIMITS.note),
    advancePayment: Math.max(0, Math.round(Number(data.advancePayment || 0))),
  };
}
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    liffId: LIFF_ID,
    riderLiffId: RIDER_LIFF_ID,
    businessFormUrl: BUSINESS_FORM_URL,
    partnerFormUrl: PARTNER_FORM_URL,
    googleMapsApiKey: GOOGLE_MAPS_API_KEY,
  });
});

app.get('/api/nearby-places', async (req, res) => {
  try {
    const lat = req.query.lat;
    const lng = req.query.lng;
    const keyword = req.query.keyword || '餐廳';
    const radius = req.query.radius || 3000;

    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        error: '缺少定位資料'
      });
    }

    const url =
      'https://maps.googleapis.com/maps/api/place/nearbysearch/json?' +
      new URLSearchParams({
        location: `${lat},${lng}`,
        radius: String(radius),
        keyword: String(keyword),
        language: 'zh-TW',
        key: GOOGLE_MAPS_API_KEY
      }).toString();

    const response = await fetch(url);
    const data = await response.json();

    const places = await Promise.all((data.results || []).slice(0, 8).map(async place => {
  let phone = '';

  try{
    const detailUrl =
      'https://maps.googleapis.com/maps/api/place/details/json?' +
      new URLSearchParams({
        place_id: place.place_id,
        fields: 'formatted_phone_number,international_phone_number',
        language: 'zh-TW',
        key: GOOGLE_MAPS_API_KEY
      }).toString();

    const detailRes = await fetch(detailUrl);
    const detailData = await detailRes.json();

    phone =
      detailData.result?.formatted_phone_number ||
      detailData.result?.international_phone_number ||
      '';
  }catch(e){
    console.warn('place detail phone error:', e);
  }

  return {
    name: place.name || '',
    address: place.vicinity || '',
    placeId: place.place_id || '',
    lat: place.geometry?.location?.lat || '',
    lng: place.geometry?.location?.lng || '',
    rating: place.rating || '',
    userRatingsTotal: place.user_ratings_total || '',
    phone
  };
}));
    res.json({
      success: true,
      places
    });

  } catch (err) {
    console.error('nearby places error:', err);
    res.status(500).json({
      success: false,
      error: '附近地點搜尋失敗'
    });
  }
});

app.get('/api/quote', async (req, res) => {
  try {
    const from = req.query.from || req.query.pickup;
    const to = req.query.to || req.query.dropoff;
    const speedType = req.query.speed || req.query.speedType || 'standard';

    if (!from || !to) {
      return res.status(400).json({ success: false, error: '請輸入取件地址與送達地址' });
    }

    const distance = await getDistanceMatrixCached(from, to);
    const price = calculatePrice({
      distanceMeters: distance.distanceMeters,
      durationSeconds: distance.durationSeconds,
      speedType,
    });

    res.json({
      success: true,
      distanceText: distance.distanceText,
      durationText: distance.durationText,
      distanceMeters: distance.distanceMeters,
      durationSeconds: distance.durationSeconds,
      speedType,
      speedLabel: getSpeedOption(speedType).label,
      ...price,
    });
  } catch (error) {
    console.error('❌ API 估價失敗：', error);
    res.status(500).json({ success: false, error: '估價失敗，請確認地址是否正確' });
  }
});

app.post('/estimate', async (req, res) => {
  try {
    const { pickup, dropoff, speed } = req.body;

    if (!pickup || !dropoff) {
      return res.status(400).json({
        error: '請填寫取件地址與送達地址',
      });
    }

    const distance = await getDistanceMatrixCached(pickup, dropoff);

    const price = calculatePrice({
      distanceMeters: distance.distanceMeters,
      durationSeconds: distance.durationSeconds,
      speedType: speed
    });

    res.json({
      distanceText: distance.distanceText,
      durationText: distance.durationText,
      totalFee: price.total
    });

  } catch (err) {
  console.error('estimate error:', err.message || err);
  res.status(500).json({
    error: err.message || 'estimate error'
  });
}
});

// ===== Google Places 附近店家搜尋 API =====
app.post('/api/places/search', async (req, res) => {
  try {

    const {
      lat,
      lng,
      keyword
    } = req.body;

    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        error: '缺少定位資訊'
      });
    }

    const radius = Math.min(Math.max(Number(req.body.radius || 3000), 3000), 3000);

    const url =
      `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(keyword || '飲料店')}&location=${lat},${lng}&radius=${radius}&language=zh-TW&key=${GOOGLE_MAPS_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      return res.status(400).json({
        success: false,
        error: data.error_message || data.status || 'Google Places 搜尋失敗'
      });
    }

    if (!data.results || !data.results.length) {
      return res.json({
        success: true,
        places: [],
        googleStatus: data.status
      });
    }

    const places = data.results.slice(0, 20).map(place => ({
      placeId: place.place_id,
      name: place.name,
      address: place.vicinity || '',
      rating: place.rating || null
    }));

    return res.json({
      success: true,
      places
    });

  } catch (err) {
    console.error('places search error:', err);

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ===== Google Places 店家詳細資料 API =====
app.post('/api/places/detail', async (req, res) => {
  try {
    const { placeId } = req.body;

    if (!placeId) {
      return res.status(400).json({
        success: false,
        error: '缺少 placeId'
      });
    }

    const fields = [
      'place_id',
      'name',
      'formatted_address',
      'formatted_phone_number',
      'geometry'
    ].join(',');

    const url =
      `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${encodeURIComponent(fields)}&language=zh-TW&key=${GOOGLE_MAPS_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK' || !data.result) {
      return res.status(400).json({
        success: false,
        error: data.error_message || data.status || '查無店家詳細資料'
      });
    }

    const place = data.result;

    return res.json({
      success: true,
      place: {
        placeId: place.place_id,
        name: place.name || '',
        address: place.formatted_address || '',
        phone: place.formatted_phone_number || '',
        lat: place.geometry?.location?.lat || null,
        lng: place.geometry?.location?.lng || null
      }
    });

  } catch (err) {
    console.error('places detail error:', err);

    return res.status(500).json({
      success: false,
      error: err.message || 'places detail error'
    });
  }
});

// ===== 合作店家派單 API =====
app.post('/api/merchant/order', async (req, res) => {
  try {
    const {
      merchantName,
      merchantPhone,
      pickupAddress,
      customerName,
      customerPhone,
      dropoffAddress,
      itemName,
      deliveryType,
      deliveryTypeText,
      note,
    } = req.body;

    if (!merchantName || !merchantPhone || !pickupAddress || !customerName || !customerPhone || !dropoffAddress || !itemName) {
      return res.status(400).json({
        success: false,
        message: '資料不完整，請確認店家、顧客、地址與商品內容都有填寫。',
      });
    }

    const id = generateOrderId();
    
    const distance = await getDistanceMatrixCached(
    pickupAddress,
    dropoffAddress
  );

    const merchantSpeedFeeMap = {
      standard: 0,
      priority: 25,
      instant: 50,
      urgent: 75,
    };

    const km = Number(distance.distanceMeters || 0) / 1000;
    const minutes = Number(distance.durationSeconds || 0) / 60;
    const speedFee = merchantSpeedFeeMap[deliveryType] || 0;

    const deliveryFee = Math.round(
      PRICING.baseFee +
      km * PRICING.perKm +
      minutes * PRICING.perMinute
    );

    const total = deliveryFee + speedFee;
    const driverFee = Math.round(total * PRICING.driverRatio);
    const platformFee = total - driverFee;
    const order = {
      
      id,
      orderType: 'merchant_delivery',
      source: 'merchant',
      userId: 'merchant-order',
      customerId: 'merchant-order',
      riderId: '',
      status: 'pending_dispatch',

      merchantName: cleanText(merchantName, 60),
      merchantPhone: normalizePhone(merchantPhone),
      customerName: cleanText(customerName, 40),
      customerPhone: normalizePhone(customerPhone),

      serviceType: '合作店家配送',
      item: cleanLongText(itemName, 200),
      pickupAddress: cleanText(pickupAddress, 120),
      pickupPhone: normalizePhone(merchantPhone),
      dropoffAddress: cleanText(dropoffAddress, 120),
      dropoffPhone: normalizePhone(customerPhone),

      speedType: deliveryType || 'standard',
      deliveryTypeText: cleanText(deliveryTypeText || '標準件', 20),
      note: cleanLongText(note || '', 200),
      
      distanceMeters: distance.distanceMeters,
      durationSeconds: distance.durationSeconds,
      distanceText: distance.distanceText,
      durationText: distance.durationText,

      total,
      driverFee,
      riderFee: driverFee,
      platformFee,
      deliveryFee,
      serviceFee: 0,
      speedFee,
      waitingFee: 0,

      etaMinutes: null,
      paymentMethod: 'merchant',
      isPaid: true,
      paidAt: Date.now(),

      createdAt: Date.now(),
      acceptedAt: null,
      arrivedPickupAt: null,
      pickedUpAt: null,
      arrivedDropoffAt: null,
      completedAt: null,
    };

    await saveOrder(order);

    await pushToGroup(LINE_ADMIN_GROUP_ID, createAdminForceCancelFlex(order));

    return res.json({
      success: true,
      orderId: id,
      order,
      message: '店家配送單已建立，系統已放入騎士端待接任務。'
    });
    
  } catch (err) {
    console.error('❌ 店家配送單建立失敗：', err);
    return res.status(500).json({
      success: false,
      message: '店家配送單建立失敗，請稍後再試。',
    });
  }
});

app.post('/api/orders', async (req, res) => {
    try {
    if(!req.body || typeof req.body !== 'object'){
    return res.status(400).json({
    success:false,
    error:'訂單資料格式錯誤'
  });
}
    const data = createOrderFromApi(req.body);

    console.log('========== H5 建立訂單 ==========');
    console.log('req.body:', req.body);

    const inputErrors = validateOrderInput(data);
    if (inputErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: inputErrors[0],
      });
    }

    const duplicateOrder = await findRecentDuplicateOrder(data);
    if (duplicateOrder) {
      return res.status(409).json({
        success: false,
        error: `系統偵測到你剛剛已送出相同訂單，請勿重複下單。原訂單編號：${duplicateOrder.id}`,
        orderId: duplicateOrder.id,
      });
    }

    let distance = null;
    let price = null;

    if (data.serviceMode === 'queue') {
      const queueMinutes = Number(data.queueMinutes || 0);
      const waitingFee = Math.max(0, queueMinutes * 3);
      const serviceFee = 25;
      const deliveryFee = 80;

      const speedFeeMap = {
        standard: 20,
        priority: 25,
        express: 30
       };

const speedFee = speedFeeMap[data.speedType] || 0;
const total = deliveryFee + waitingFee + serviceFee + speedFee;
  price = {
    deliveryFee,
    serviceFee,
    speedFee,
    waitingFee,
    total,
    driverFee: deliveryFee + waitingFee + speedFee,
    platformFee: serviceFee
  };
} else if (data.serviceMode === 'review') {
  price = {
    deliveryFee: 0,
    serviceFee: 0,
    speedFee: 0,
    waitingFee: 0,
    total: 0,
    driverFee: 0,
    platformFee: 0
  };
} else {
  distance = await getDistanceMatrixCached(data.pickupAddress, data.dropoffAddress);

  if(!distance || !distance.distanceMeters){
    return res.status(400).json({
      success: false,
      error: '地址無法計算距離，請確認取件與送達地址是否完整'
    });
  }

  price = calculatePrice({
    distanceMeters: distance.distanceMeters,
    durationSeconds: distance.durationSeconds,
    speedType: data.speedType,
  });
}    
    const id = generateOrderId();

    const order = {
      id,
      userId: data.userId,
      customerId: data.customerId,
      riderId: '',
      status: data.hasMerchant ? 'merchant_pending' : 'pending_payment',
      serviceGroup: data.serviceGroup,
      serviceType: data.serviceType,
      serviceMode: data.serviceMode,
      serviceKey: data.serviceKey,
      queueMinutes: data.queueMinutes,
      item: data.item,
      pickupAddress: data.pickupAddress,
      pickupPhone: data.pickupPhone,
      dropoffAddress: data.dropoffAddress,
      dropoffPhone: data.dropoffPhone,
      merchantId: data.merchantId || '',
      merchantCode: data.merchantCode || data.merchantId || '',
      merchantName: data.merchantName || '',
      merchantPhone: data.merchantPhone || '',
      merchantAddress: data.merchantAddress || '',
      hasMerchant: data.hasMerchant || false,
      speedType: data.speedType,
      note: data.note,
      advancePayment: Number(data.advancePayment || 0),
      duplicateFingerprint: getDuplicateFingerprint(data),
      distanceMeters: data.serviceMode === 'queue' ? 0 : distance.distanceMeters,
      durationSeconds: data.serviceMode === 'queue' ? 0 : distance.durationSeconds,
      distanceText: data.serviceMode === 'queue' ? '排隊任務' : distance.distanceText,
      durationText: data.serviceMode === 'queue' ? `${data.queueMinutes} 分鐘內` : distance.durationText,
      ...price,
      etaMinutes: null,
      paymentMethod: '',
      isPaid: false,
      paidAt: null,
      waitingFeeRequested: false,
      waitingFeeApproved: false,
      waitingFeeRejected: false,
      waitingFeeRequestedAt: null,
      createdAt: Date.now(),
      acceptedAt: null,
      arrivedPickupAt: null,
      pickedUpAt: null,
      arrivedDropoffAt: null,
      completedAt: null,
    };

    await saveOrder(order);

    await notifyCustomer(order, createTextMessage(`✅ 訂單已建立：${order.id}\n請在網頁選擇付款方式，完成付款後按「我已付款」，系統才會派單。`));

    res.json({
      success: true,
      orderId: id,
      order,
      paymentOptions: {
  cash: '現金付款',
  jko: PAYMENT_JKO_INFO,
  bank: PAYMENT_BANK_INFO,
},
      total: order.total,
      message: '訂單已建立，請在頁面下方選擇付款方式。',
    });
  } catch (error) {
  console.error('❌ API 建立訂單失敗：', error.message || error);
  res.status(500).json({
    success: false,
    error: error.message || '建立訂單失敗，請稍後再試'
  });
}
});

app.post('/api/orders/:orderId/payment-method', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').toUpperCase();
    const { paymentMethod } = req.body;
    const requestUserId = getCustomerUserIdFromBody(req.body);
    const order = await getOrder(orderId);

    if (!order) {
      return res.status(404).json({ success: false, error: '找不到此訂單' });
    }

    if (!isSameCustomerUserId(order, requestUserId)) {
      return res.status(403).json({
        success: false,
        error: '此訂單只能由原本下單的客人設定付款方式',
      });
    }

    if (!['cash', 'jko', 'bank'].includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        error: '付款方式錯誤',
      });
    }

    if (!['pending_payment'].includes(order.status)) {
      return res.status(400).json({
        success: false,
        error: `此訂單目前狀態為「${getStatusLabel(order.status)}」，不可再變更付款方式`,
      });
    }

    order.paymentMethod = paymentMethod;
    order.paymentMethodLabel = getPaymentMethodLabel(paymentMethod);
    order.paymentStatus = paymentMethod === 'cash' ? 'cash_on_delivery' : 'waiting_confirm';
    order.cashCollectAmount = paymentMethod === 'cash' ? Number(order.total || order.totalFee || 0) : 0;
    order.cashCollected = false;
    order.status = 'pending_payment';

    await saveOrder(order);

    const customerText = paymentMethod === 'cash'
      ? `你已選擇付款方式：現金付款\n\n請於任務完成時，將 NT$${Math.round(Number(order.total || 0))} 交付給騎士。\n\n請回到網頁按「確認現金付款」，系統才會開始派單。`
      : `你已選擇付款方式：${getPaymentMethodLabel(paymentMethod)}\n完成付款後，請回到網頁按「我已付款」。`;

    await notifyCustomer(order, createTextMessage(customerText));

    return res.json({
      success: true,
      orderId,
      paymentMethod,
      paymentMethodLabel: getPaymentMethodLabel(paymentMethod),
      paymentInfo: getPaymentInfo(paymentMethod, Number(order.total || order.totalFee || 0)),
      total: order.total,
    });

  } catch (error) {
    console.error('❌ 設定付款方式失敗：', error);
    return res.status(500).json({
      success: false,
      error: '設定付款方式失敗',
    });
  }
});

app.post('/api/orders/:orderId/paid', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').toUpperCase();
    const requestUserId = getCustomerUserIdFromBody(req.body);
    const order = await getOrder(orderId);

    if (!order) {
      return res.status(404).json({ success: false, error: '找不到此訂單' });
    }

    if (!isSameCustomerUserId(order, requestUserId)) {
      return res.status(403).json({
        success: false,
        error: '此訂單只能由原本下單的客人確認付款',
      });
    }

    if (!order.paymentMethod) {
      return res.status(400).json({
        success: false,
        error: '請先選擇付款方式',
      });
    }

    if (order.status !== 'pending_payment' && !order.isPaid) {
      return res.status(400).json({
        success: false,
        error: '訂單狀態異常',
      });
    }

    const isCashPayment = order.paymentMethod === 'cash';

    order.status = order.hasMerchant ? 'merchant_pending' : 'pending_dispatch';
    order.paidAt = isCashPayment ? null : Date.now();
    order.isPaid = isCashPayment ? false : true;
    order.paymentStatus = isCashPayment ? 'cash_on_delivery' : 'paid_confirmed';
    order.cashCollectAmount = isCashPayment ? Number(order.total || 0) : 0;
    order.cashCollected = false;
    order.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await saveOrder(order);
    
    try {
      await pushToGroup(LINE_ADMIN_GROUP_ID, createAdminForceCancelFlex(order));
    } catch (adminErr) {
      console.error('⚠️ 付款確認成功，但推送辦公室群組失敗：', adminErr);
    }

    return res.json({
  success: true,
  orderId,
  paymentMethod: order.paymentMethod,
  paymentMethodLabel: getPaymentMethodLabel(order.paymentMethod),
  paymentStatus: order.paymentStatus,
  message: isCashPayment
    ? '已確認現金付款方式，系統已開始派單'
    : '已收到付款通知，系統已自動派單',
});

  } catch (error) {
    console.error('❌ H5 確認付款失敗：', error);
    return res.status(500).json({
      success: false,
      error: '確認付款失敗，請稍後再試',
    });
  }
});

app.post('/api/rider-distance-to-pickup', async (req, res) => {
  try {
    const { riderLat, riderLng, pickupAddress } = req.body;

    if (!riderLat || !riderLng || !pickupAddress) {
      return res.status(400).json({
        success: false,
        error: '缺少騎士位置或取件地址',
      });
    }

    const origin = `${riderLat},${riderLng}`;
    const distance = await getDistanceMatrix(origin, pickupAddress);

    res.json({
      success: true,
      distanceText: distance.distanceText,
      durationText: distance.durationText,
      distanceMeters: distance.distanceMeters,
      durationSeconds: distance.durationSeconds,
    });
  } catch (error) {
    console.error('❌ 騎士到取件地距離計算失敗：', error);
    res.status(500).json({
      success: false,
      error: '距離計算失敗',
    });
  }
});

// 3. 接受任務：正式版 approved 騎士才可接單，並防止多人搶同一單
app.post('/api/rider/accept-order', async (req, res) => {
  try {
    const { orderId, lineUserId } = req.body;

    if (!orderId || !lineUserId || !String(lineUserId).startsWith('U')) {
      return res.status(400).json({
        success: false,
        message: '缺少訂單編號或正確的騎士 LINE 身分。',
      });
    }

    const riderSnap = await db.collection('riders')
  .where('lineUserId', '==', lineUserId)
  .limit(1)
  .get();

const riderOk = !riderSnap.empty && (
  riderSnap.docs[0].data().approved === true ||
  riderSnap.docs[0].data().status === 'approved'
);

if (!riderOk) {
  return res.status(403).json({
    success: false,
    message: '你尚未通過 UBee 騎士審核，暫時無法接單。',
  });
}

    const riderDoc = riderSnap.docs[0];
    const rider = riderDoc.data();

    const orderRef = db.collection('orders').doc(String(orderId).toUpperCase());
    const riderRef = db.collection('riders').doc(riderDoc.id);

    let acceptedOrder = null;

    await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);

      if (!orderDoc.exists) {
        throw new Error('ORDER_NOT_FOUND');
      }

      const order = orderDoc.data();
      
      const latestRiderDoc = await transaction.get(riderRef);
      const latestRider = latestRiderDoc.exists ? latestRiderDoc.data() : {};

      if (
  latestRider.busy === true &&
  latestRider.currentOrderId &&
  latestRider.currentOrderId !== String(orderId).toUpperCase()
) {
  const oldOrderRef = db.collection('orders').doc(String(latestRider.currentOrderId).toUpperCase());
  const oldOrderDoc = await transaction.get(oldOrderRef);

  if (oldOrderDoc.exists) {
    const oldOrder = oldOrderDoc.data();

    if (!['completed', 'cancelled'].includes(oldOrder.status)) {
      throw new Error('RIDER_ALREADY_BUSY');
    }
  }
}

      if (order.status !== 'pending_dispatch') {
        throw new Error('ORDER_ALREADY_ACCEPTED');
      }

      acceptedOrder = {
  ...order,
  id: String(orderId).toUpperCase(),
  status: 'accepted',
  riderId: lineUserId,
  riderLineUserId: lineUserId,
  riderDocId: riderDoc.id,
  riderName: rider.name || '',
  riderPhone: rider.phone || '',
};

      transaction.update(orderRef, {
  status: 'accepted',
  riderId: lineUserId,
  riderLineUserId: lineUserId,
  riderDocId: riderDoc.id,
  riderName: rider.name || '',
  riderPhone: rider.phone || '',
  acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  'statusTimes.accepted': admin.firestore.FieldValue.serverTimestamp(),
});
      transaction.set(riderRef, {
        busy: true,
        currentOrderId: String(orderId).toUpperCase(),
        lastActive: Date.now(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    orders[String(orderId).toUpperCase()] = acceptedOrder;

    await notifyCustomer(
      acceptedOrder,
      createTextMessage(
        `🟢 UBee 騎士已接單\n\n訂單編號：${acceptedOrder.id}\n騎士將盡快前往取件。`
      )
    );

    return res.json({
      success: true,
      orderId: String(orderId).toUpperCase(),
      status: 'accepted',
      message: '接單成功',
    });

  } catch (error) {
    console.error('❌ 騎士網頁接單失敗：', error);

    if (error.message === 'ORDER_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        message: '找不到此訂單。',
      });
    }

    if (error.message === 'ORDER_ALREADY_ACCEPTED') {
      return res.status(409).json({
        success: false,
        message: '此訂單已被其他騎士接走。',
      });
    }
    
    if (error.message === 'RIDER_ALREADY_BUSY') {
  return res.status(409).json({
    success: false,
    message: '你目前已有進行中的任務，完成後才能接下一張。',
  });
}

    return res.status(500).json({
      success: false,
      message: '接單失敗，請稍後再試。',
    });
  }
});

// ===== 騎士轉單 API =====
// 已接單騎士可把任務退回待派遣，重新開放給其他騎士接單
app.post('/api/rider/transfer-order', async (req, res) => {
  try {
    const { orderId, lineUserId, reason } = req.body;

    if (!orderId || !lineUserId) {
      return res.status(400).json({
        success: false,
        message: '缺少訂單編號或騎士 LINE 身分。'
      });
    }

    const orderRef = db.collection('orders').doc(String(orderId).toUpperCase());

    const riderSnap = await db.collection('riders')
      .where('lineUserId', '==', lineUserId)
      .limit(1)
      .get();

    if (riderSnap.empty) {
      return res.status(403).json({
        success: false,
        message: '找不到騎士資料。'
      });
    }

    const riderDoc = riderSnap.docs[0];
    const rider = riderDoc.data();
    const riderRef = db.collection('riders').doc(riderDoc.id);

    await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);

      if (!orderDoc.exists) {
        throw new Error('ORDER_NOT_FOUND');
      }

      const order = orderDoc.data();

      if (order.riderLineUserId !== lineUserId && order.riderId !== lineUserId) {
        throw new Error('NOT_YOUR_ORDER');
      }

      if (order.status !== 'accepted') {
        throw new Error('ORDER_ALREADY_STARTED');
      }

      transaction.update(orderRef, {
        status: 'pending_dispatch',

        previousRiderLineUserId: lineUserId,
        previousRiderDocId: riderDoc.id,
        previousRiderName: rider.name || '',
        previousRiderPhone: rider.phone || '',
        transferReason: reason || '',
        transferredAt: admin.firestore.FieldValue.serverTimestamp(),

        riderId: '',
        riderLineUserId: '',
        riderDocId: '',
        riderName: '',
        riderPhone: '',

        acceptedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        'statusTimes.transferred': admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.set(riderRef, {
        busy: false,
        currentOrderId: '',
        lastActive: Date.now(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    return res.json({
      success: true,
      status: 'pending_dispatch',
      message: '轉單成功，任務已重新開放給其他騎士。'
    });

  } catch (error) {
    console.error('❌ 騎士轉單失敗：', error);

    if (error.message === 'ORDER_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        message: '找不到此訂單。'
      });
    }

    if (error.message === 'NOT_YOUR_ORDER') {
      return res.status(403).json({
        success: false,
        message: '此訂單不是你目前接的任務。'
      });
    }

    if (error.message === 'ORDER_ALREADY_STARTED') {
      return res.status(409).json({
        success: false,
        message: '任務已開始進行，不能轉單。'
      });
    }

    return res.status(500).json({
      success: false,
      message: '轉單失敗，請稍後再試。'
    });
  }
});

// ===== 騎士更新任務狀態 API =====
// 4. 更新任務狀態：正式版只允許接單本人更新
app.post('/api/rider/update-order-status', async (req, res) => {
  try {
    const { orderId, status, lineUserId } = req.body;

    if (!orderId || !status || !lineUserId || !String(lineUserId).startsWith('U')) {
      return res.status(400).json({
        success: false,
        message: '缺少訂單編號、任務狀態或騎士 LINE 身分。',
      });
    }

    const allowedFlow = {
      accepted: ['arrived_pickup'],
      going_to_pickup: ['arrived_pickup'],
      arrived_pickup: ['picked_up'],
      picked_up: ['arrived_dropoff'],
      going_to_dropoff: ['arrived_dropoff'],
      arrived_dropoff: ['completed'],
    };

    const allowedStatus = [
      'arrived_pickup',
      'picked_up',
      'arrived_dropoff',
      'completed',
    ];

    if (!allowedStatus.includes(status)) {
      return res.status(400).json({
        success: false,
        message: '不允許的任務狀態。',
      });
    }

    const riderSnap = await db.collection('riders')
  .where('lineUserId', '==', lineUserId)
  .limit(1)
  .get();

const riderOk = !riderSnap.empty && (
  riderSnap.docs[0].data().approved === true ||
  riderSnap.docs[0].data().status === 'approved'
);

if (!riderOk) {
  return res.status(403).json({
    success: false,
    message: '你尚未通過 UBee 騎士審核，暫時無法更新任務。',
  });
}

    const riderDoc = riderSnap.docs[0];
    const riderRef = db.collection('riders').doc(riderDoc.id);
    const orderRef = db.collection('orders').doc(String(orderId).toUpperCase());

    let updatedOrder = null;

    await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);

      if (!orderDoc.exists) {
        throw new Error('ORDER_NOT_FOUND');
      }

      const order = orderDoc.data();
      const currentStatus = order.status;

      if (order.riderId !== lineUserId && order.riderLineUserId !== lineUserId) {
        throw new Error('NOT_THIS_RIDER');
      }

      if (currentStatus === status) {
  updatedOrder = {
    ...order,
    id: String(orderId).toUpperCase(),
    status,
  };
  return;
}

if (currentStatus === 'completed' && status === 'completed') {
  updatedOrder = {
    ...order,
    id: String(orderId).toUpperCase(),
    status: 'completed',
  };
  return;
}

const nextStatuses = allowedFlow[currentStatus] || [];

if (!nextStatuses.includes(status)) {
  if (status === 'completed') {
    updatedOrder = {
      ...order,
      id: String(orderId).toUpperCase(),
      status: 'completed',
    };

    transaction.update(orderRef, {
      status: 'completed',
      riderStatus: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      'statusTimes.completed': admin.firestore.FieldValue.serverTimestamp(),
    });

    transaction.set(riderRef, {
      busy: false,
      currentOrderId: '',
      lastActive: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return;
  }

  throw new Error('INVALID_TRANSITION');
}
      const updateData = {
        status,
        riderStatus: status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        [`statusTimes.${status}`]: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (status === 'arrived_pickup') {
        updateData.arrivedPickupAt = admin.firestore.FieldValue.serverTimestamp();
      }

      if (status === 'picked_up') {
        updateData.pickedUpAt = admin.firestore.FieldValue.serverTimestamp();
      }

      if (status === 'arrived_dropoff') {
        updateData.arrivedDropoffAt = admin.firestore.FieldValue.serverTimestamp();
      }

      if (status === 'completed') {
        updateData.completedAt = admin.firestore.FieldValue.serverTimestamp();
        updateData.settlementStatus = 'pending';
        updateData.settledAt = null;
      }

      transaction.update(orderRef, updateData);

      if (status === 'completed') {
        transaction.set(riderRef, {
          busy: false,
          currentOrderId: '',
          lastActive: Date.now(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      updatedOrder = {
  ...order,
  ...updateData,
  id: String(orderId).toUpperCase(),
  status,
};
    });

    orders[String(orderId).toUpperCase()] = updatedOrder;

    try {
  await notifyCustomer(
    updatedOrder,
    createTextMessage(
      `UBee 任務狀態更新\n\n訂單編號：${updatedOrder.id}\n目前狀態：${getStatusLabel(status)}`
    )
  );
} catch (notifyErr) {
  console.error('⚠️ 任務狀態已更新，但通知客人失敗：', notifyErr);
}

if (status === 'completed') {
  try {
    if (LINE_FINISH_GROUP_ID) {
      await pushToGroup(LINE_FINISH_GROUP_ID, createFinanceFlex(updatedOrder));
    }
  } catch (finishErr) {
    console.error('⚠️ 任務已完成，但推送財務明細失敗：', finishErr);
  }
}

return res.json({
      success: true,
      orderId: String(orderId).toUpperCase(),
      status,
      statusLabel: getStatusLabel(status),
      message: '任務狀態已更新',
    });

  } catch (error) {
    console.error('❌ 騎士更新任務狀態失敗:', error);

    if (error.message === 'ORDER_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        message: '找不到此訂單。',
      });
    }

    if (error.message === 'NOT_THIS_RIDER') {
      return res.status(403).json({
        success: false,
        message: '這張任務不是你接的，無法操作。',
      });
    }

    if (error.message === 'INVALID_TRANSITION') {
      return res.status(400).json({
        success: false,
        message: '任務狀態流程不正確，請重新整理後再試。',
      });
    }

    return res.status(500).json({
      success: false,
      message: '任務狀態更新失敗，請稍後再試。',
    });
  }
});

app.get('/api/orders/:orderId', async (req, res) => {
  const orderId = String(req.params.orderId || '').toUpperCase();
  const requestUserId = String(req.query.userId || '').trim();
  const order = await getOrder(orderId);

  if (!order) {
    return res.status(404).json({ success: false, error: '查無此訂單' });
  }

  if (requestUserId && !isSameCustomerUserId(order, requestUserId)) {
    return res.status(403).json({ success: false, error: '此訂單只能由原本下單的客人查詢' });
  }

  res.json({
    success: true,
    order: {
      id: order.id,
      status: order.status,
      statusLabel: getStatusLabel(order.status),
      speedType: order.speedType,
      speedLabel: getSpeedOption(order.speedType).label,
      pickupAddress: order.pickupAddress,
      dropoffAddress: order.dropoffAddress,
      etaMinutes: order.etaMinutes,
      total: order.total,
      isPaid: order.isPaid,
      paymentMethod: order.paymentMethod,
      paymentMethodLabel: getPaymentMethodLabel(order.paymentMethod),
    },
  });
});

app.post('/cancel-order', async (req, res) => {
  try {
    const { orderId } = req.body;
    const requestUserId = getCustomerUserIdFromBody(req.body);
    const order = await getOrder(orderId);

    if (!order) {
      return res.json({ success: false, message: '訂單不存在' });
    }

    if (!isSameCustomerUserId(order, requestUserId)) {
      return res.status(403).json({ success: false, message: '此訂單只能由原本下單的客人取消' });
    }

    if (['picked_up', 'arrived_dropoff', 'completed', 'cancelled'].includes(order.status)) {
      return res.json({ success: false, message: '此階段不可取消' });
    }

    order.status = 'cancelled';
    order.cancelType = 'customer_cancel';
    order.cancelledBy = requestUserId;
    order.cancelledAt = Date.now();
    await saveOrder(order);

    return res.json({ success: true });
  } catch (err) {
    console.error('cancel-order error:', err);
    return res.status(500).json({ success: false, message: '取消失敗，請稍後再試' });
  }
});

async function handlePostback(event) {
  const data = event.postback.data || '';
  const userId = event.source.userId;

  console.log('========== POSTBACK 進來了 ==========');
  console.log('data:', data);
  console.log('userId:', userId);
  console.log('source:', event.source);

if (data.startsWith('business_approve:')) {
  const permitted = await requireAdminPermission(event, '商務合作審核');
  if (!permitted) return null;

  const businessId = data.split(':')[1];

  const doc = await db
    .collection('businessApplications')
    .doc(businessId)
    .get();

  if (!doc.exists) {
    return replyText(event.replyToken, '找不到商務合作申請資料');
  }

  const business = doc.data();

  if (business.status === 'approved') {
    return replyText(event.replyToken, '此商務合作申請已經審核通過，不需要重複操作。');
  }

  await db.collection('businessApplications')
    .doc(businessId)
    .update({
      status: 'approved',
      approvedAt: Date.now(),
      approvedBy: userId
    });

  if (business.lineUserId) {
    await client.pushMessage(business.lineUserId, {
      type: 'text',
      text:
`🎉 您的 UBee 商務合作申請已通過初步審核

公司 / 店家：${business.companyName}

請先加入 UBee 店家官方帳號：
${MERCHANT_OA_LINK}

加入後請傳送：
我是店家｜${business.companyName}

UBee 辦公室將會再依照您的需求，
主動與您聯繫並安排後續合作內容。

感謝您使用 UBee 城市任務平台 🐝`
    });
  } else {
    console.log(`⚠️ 商務合作申請 ${businessId} 沒有 lineUserId，無法通知客人`);
  }

  return replyText(
    event.replyToken,
    `✅ 已通過商務合作申請，系統已通知客人。\n\n申請編號：${businessId}`
  );
}

  if (data.startsWith('approveRider=')) {
    const permitted = await requireAdminPermission(event, '騎士審核');
    if (!permitted) return null;

    const riderId = getPostbackValue(data, 'approveRider');
    const rider = await getRiderOrReply(event.replyToken, riderId);
    if (!rider) return null;

    if (rider.status === 'approved') {
      return replyText(event.replyToken, '此騎士已經通過審核，不需要重複操作。');
    }

    if (rider.status === 'rejected') {
      return replyText(event.replyToken, '此騎士申請已被拒絕，不能再直接通過。');
    }

    rider.status = 'approved';
    rider.approved = true;
    rider.approvedAt = Date.now();
    rider.approvedBy = userId;
    await saveRider(rider);

    if (rider.lineUserId) {
      await client.pushMessage(rider.lineUserId, {
        type: 'text',
        text:
          `🎉 恭喜您通過 UBee 騎士審核！\n\n` +
          `歡迎加入 UBee 城市任務平台 🐝\n\n` +
          `接下來請先加入「UBee｜騎士 SOP 教學區」：\n\n` +
          `${RIDER_SOP_GROUP_LINK}\n\n` +
          `加入後請先閱讀記事本上內容：\n\n` +
          `1. 接單流程\n` +
          `2. 任務操作方式\n` +
          `3. 配送注意事項\n` +
          `4. 異常回報規範\n` +
          `5. 收入與結算說明\n\n` +
          `完成教學後，再開始接收任務。\n\n` +
          `— UBee 城市任務平台`
      });
    }
    
    return replyText(
      event.replyToken,
      `✅ 已通過騎士審核\n\n姓名：${rider.name}\n申請編號：${rider.riderId}`
    );
  }

  if (data.startsWith('rejectRider=')) {
    const permitted = await requireAdminPermission(event, '騎士審核');
    if (!permitted) return null;

    const riderId = getPostbackValue(data, 'rejectRider');
    const rider = await getRiderOrReply(event.replyToken, riderId);
    if (!rider) return null;

    if (rider.status === 'approved') {
      return replyText(event.replyToken, '此騎士已通過審核，不能直接拒絕。');
    }

    if (rider.status === 'rejected') {
      return replyText(event.replyToken, '此騎士申請已經被拒絕，不需要重複操作。');
    }

    rider.status = 'rejected';
    rider.rejectedAt = Date.now();
    rider.rejectedBy = userId;
    await saveRider(rider);

    return replyText(
      event.replyToken,
      `已拒絕騎士申請\n\n姓名：${rider.name}\n申請編號：${rider.riderId}`
    );
  }

  if (data.startsWith('forceCancel=')) {
    const orderId = getPostbackValue(data, 'forceCancel');
    return handleAdminForceCancel(
      event,
      orderId,
      'admin_force_cancel_button',
      '強制取消只能在 UBee 辦公室審核群組操作。'
    );
  }

  if (data.startsWith('cancelCreate=')) {
    const orderId = getPostbackValue(data, 'cancelCreate');
    const order = await getOrderOrReply(event.replyToken, orderId);
    if (!order) return null;

    const customerOk = await requireOrderCustomer(event, order);
    if (!customerOk) return null;

    if (order.status !== 'draft_confirm') {
      return replyText(event.replyToken, '此訂單已進入下一階段，不能取消建立。');
    }

    await updateOrderStatus(order, 'cancelled', {
      cancelType: 'customer_cancel_before_create',
      cancelledBy: userId,
      cancelledAt: Date.now(),
    });

    return replyText(event.replyToken, `已取消建立訂單：${order.id}`);
  }

  if (data.startsWith('confirmCreate=')) {
    const orderId = getPostbackValue(data, 'confirmCreate');
    const order = await getOrderOrReply(event.replyToken, orderId);
    if (!order) return null;

    const customerOk = await requireOrderCustomer(event, order);
    if (!customerOk) return null;

    const ok = await requireOrderStatus(
      event,
      order,
      ['draft_confirm'],
      '此訂單無法重複確認建立。'
    );
    if (!ok) return null;

    await updateOrderStatus(order, 'pending_payment');

    return replyMessages(event.replyToken, [
      createTextMessage(`✅ 已確認建立訂單：${order.id}\n請選擇付款方式並完成付款。`),
      createPaymentInfoFlex({ ...order, paymentMethod: order.paymentMethod || 'jko' }),
    ]);
  }

  if (data.startsWith('showEta=')) {
    const orderId = getPostbackValue(data, 'showEta');
    const order = await getOrderOrReply(event.replyToken, orderId);
    if (!order) return null;

    const riderOk = await requireOrderRider(event, order);
    if (!riderOk) return null;

    const ok = await requireOrderStatus(
      event,
      order,
      ['accepted', 'arrived_pickup', 'picked_up', 'arrived_dropoff'],
      '此訂單目前不能設定抵達取件時間。'
    );
    if (!ok) return null;

    return replyMessages(event.replyToken, [createETAFlex(order)]);
  }

  if (data.startsWith('eta=')) {
    const parts = data.split('=');
    const orderId = parts[1];
    const minutes = Number(parts[2]);

    const order = await getOrderOrReply(event.replyToken, orderId);
    if (!order) return null;

    const riderOk = await requireOrderRider(event, order);
    if (!riderOk) return null;

    if (!ETA_OPTIONS.includes(minutes)) {
      return replyText(event.replyToken, '抵達取件時間不正確。');
    }

    const ok = await requireOrderStatus(
      event,
      order,
      ['accepted', 'arrived_pickup', 'picked_up', 'arrived_dropoff'],
      '此訂單目前不能回報抵達取件時間。'
    );
    if (!ok) return null;

    order.etaMinutes = minutes;
    order.etaUpdatedAt = Date.now();
    await saveOrder(order);

    await notifyCustomer(
      order,
      createTextMessage(`⏱️ UBee 騎士已更新抵達取件時間\n\n訂單編號：${order.id}\n預計 ${minutes} 分鐘抵達。`)
    );

    return replyMessages(event.replyToken, [
      createTextMessage(`✅ 已設定抵達取件時間：${minutes} 分鐘`),
      createRiderControlFlex(order),
    ]);
  }

  if (data.startsWith('arrivedPickup=')) {
    const orderId = getPostbackValue(data, 'arrivedPickup');
    const order = await getOrderOrReply(event.replyToken, orderId);
    if (!order) return null;

    const riderOk = await requireOrderRider(event, order);
    if (!riderOk) return null;

    const ok = await requireOrderStatus(
      event,
      order,
      ['accepted'],
      '此訂單目前不能回報抵達取件地點。'
    );
    if (!ok) return null;

    await updateOrderStatus(order, 'arrived_pickup', { arrivedPickupAt: Date.now() });

    await notifyCustomer(
      order,
      createTextMessage(`🟠 UBee 騎士已抵達取件地點\n\n訂單編號：${order.id}`)
    );

    return replyMessages(event.replyToken, [
      createTextMessage(`✅ 已回報抵達取件地點：${order.id}`),
      createRiderControlFlex(order),
    ]);
  }

  if (data.startsWith('pickedUp=')) {
    const orderId = getPostbackValue(data, 'pickedUp');
    const order = await getOrderOrReply(event.replyToken, orderId);
    if (!order) return null;

    const riderOk = await requireOrderRider(event, order);
    if (!riderOk) return null;

    const ok = await requireOrderStatus(
      event,
      order,
      ['accepted', 'arrived_pickup'],
      '此訂單目前不能回報已取件。'
    );
    if (!ok) return null;

    await updateOrderStatus(order, 'picked_up', { pickedUpAt: Date.now() });

    await notifyCustomer(
      order,
      createTextMessage(`🔵 UBee 騎士已完成取件\n\n訂單編號：${order.id}\n正在前往送達地點。`)
    );

    return replyMessages(event.replyToken, [
      createTextMessage(`✅ 已回報已取件：${order.id}`),
      createRiderControlFlex(order),
    ]);
  }

  if (data.startsWith('arrivedDropoff=')) {
    const orderId = getPostbackValue(data, 'arrivedDropoff');
    const order = await getOrderOrReply(event.replyToken, orderId);
    if (!order) return null;

    const riderOk = await requireOrderRider(event, order);
    if (!riderOk) return null;

    const ok = await requireOrderStatus(
      event,
      order,
      ['picked_up'],
      '此訂單目前不能回報抵達送達地點。'
    );
    if (!ok) return null;

    await updateOrderStatus(order, 'arrived_dropoff', { arrivedDropoffAt: Date.now() });

    await notifyCustomer(
      order,
      createTextMessage(`🟣 UBee 騎士已抵達送達地點\n\n訂單編號：${order.id}`)
    );

    return replyMessages(event.replyToken, [
      createTextMessage(`✅ 已回報抵達送達地點：${order.id}`),
      createRiderControlFlex(order),
    ]);
  }

  if (data.startsWith('completed=')) {
    const orderId = getPostbackValue(data, 'completed');
    const order = await getOrderOrReply(event.replyToken, orderId);
    if (!order) return null;

    const riderOk = await requireOrderRider(event, order);
    if (!riderOk) return null;

    const ok = await requireOrderStatus(
      event,
      order,
      ['arrived_dropoff'],
      '此訂單目前不能完成。'
    );
    if (!ok) return null;

    await updateOrderStatus(order, 'completed', {
  completedAt: admin.firestore.FieldValue.serverTimestamp(),
  'statusTimes.completed': admin.firestore.FieldValue.serverTimestamp(),
});

    await notifyCustomer(
      order,
      createTextMessage(`✅ UBee 任務已完成\n\n訂單編號：${order.id}\n感謝你使用 UBee 城市任務服務。`)
    );
    
    const riderSnap = await db.collection('riders')
  .where('lineUserId', '==', userId)
  .limit(1)
  .get();

if (!riderSnap.empty) {
  await riderSnap.docs[0].ref.set({
    busy: false,
    currentOrderId: '',
    lastActive: Date.now(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

    await pushToGroup(LINE_FINISH_GROUP_ID, createFinanceFlex(order));

    return replyText(event.replyToken, `✅ 已完成訂單：${order.id}`);
  }

  if (data.startsWith('requestWaitingFee=')) {
    const orderId = getPostbackValue(data, 'requestWaitingFee');
    const order = await getOrderOrReply(event.replyToken, orderId);
    if (!order) return null;

    const riderOk = await requireOrderRider(event, order);
    if (!riderOk) return null;

    const ok = await requireOrderStatus(
      event,
      order,
      ['arrived_pickup'],
      '目前只有抵達取件地點後可以申請等候費。'
    );
    if (!ok) return null;

    if (order.waitingFeeRequested && !order.waitingFeeRejected) {
      return replyText(event.replyToken, '此訂單已申請過等候費，請等待客人回覆。');
    }

    order.waitingFeeRequested = true;
    order.waitingFeeApproved = false;
    order.waitingFeeRejected = false;
    order.waitingFeeRequestedAt = Date.now();
    await saveOrder(order);

    await notifyCustomer(order, createWaitingFeeConfirmFlex(order));

    return replyText(event.replyToken, '已向客人送出等候費確認。');
  }

  if (data.startsWith('waitingApprove=')) {
    const orderId = getPostbackValue(data, 'waitingApprove');
    const order = await getOrderOrReply(event.replyToken, orderId);
    if (!order) return null;

    const customerOk = await requireOrderCustomer(event, order);
    if (!customerOk) return null;

    if (!order.waitingFeeRequested) {
      return replyText(event.replyToken, '目前沒有待確認的等候費申請。');
    }

    if (order.waitingFeeApproved) {
      return replyText(event.replyToken, '此等候費已經同意，不需要重複操作。');
    }

    order.waitingFeeApproved = true;
    order.waitingFeeRejected = false;
    order.waitingFee = PRICING.waitingFee;
    recalculateOrderFinancials(order);
    await saveOrder(order);

    await replyText(event.replyToken, `✅ 已同意加收等候費 $60\n\n訂單編號：${order.id}`);
    return null;
  }

  if (data.startsWith('waitingReject=')) {
    const orderId = getPostbackValue(data, 'waitingReject');
    const order = await getOrderOrReply(event.replyToken, orderId);
    if (!order) return null;

    const customerOk = await requireOrderCustomer(event, order);
    if (!customerOk) return null;

    if (!order.waitingFeeRequested) {
      return replyText(event.replyToken, '目前沒有待確認的等候費申請。');
    }

    if (order.waitingFeeRejected) {
      return replyText(event.replyToken, '此等候費已經拒絕，不需要重複操作。');
    }

    order.waitingFeeApproved = false;
    order.waitingFeeRejected = true;
    order.waitingFee = 0;
    recalculateOrderFinancials(order);
    await saveOrder(order);
    
    await replyText(event.replyToken, `已拒絕加收等候費\n\n訂單編號：${order.id}`);
    return null;
  }

  return replyText(event.replyToken, '未識別的操作。');
}

async function handleTextStep(event, userId, text) {
  const normalized = text.trim();

  if (normalized === '主選單') {
    return replyMessages(event.replyToken, [createMainMenuFlex()]);
  }

  return null;
}

async function handleTextMessage(event) {
  const userId = event.source.userId;
  const text = (event.message.text || '').trim();

  console.log('========== LINE 文字訊息 ==========');
  console.log('source type:', event.source.type);
  console.log('LINE userId:', userId);
  console.log('請把這個 userId 複製到 Firebase riders 的 lineUserId 欄位:', userId);
  console.log('groupId:', event.source.groupId || '-');
  console.log('roomId:', event.source.roomId || '-');
  console.log('text:', text);

  if (/^強制取消\s+UB\d+/i.test(text)) {
    const orderId = text.replace(/^強制取消\s+/i, '').trim().toUpperCase();
    return handleAdminForceCancel(
      event,
      orderId,
      'admin_force_cancel',
      '此指令只能在 UBee 辦公室審核群組使用。'
    );
  }

  if (event.source.type === 'group') return null;

  if (/^UB\d+/i.test(text)) {
    const orderId = text.toUpperCase();
    const order = await getOrderOrReply(event.replyToken, orderId);
    if (!order) return null;

    const customerOk = await requireOrderCustomer(event, order);
    if (!customerOk) return null;

    return replyMessages(event.replyToken, [createOrderStatusFlex(order)]);
  }

  return handleTextStep(event, userId, text);
}

async function handleEvent(event) {
  try {
    if (event.type === 'follow') {
      return replyMessages(event.replyToken, [
  createTextMessage('歡迎使用 UBee｜城市任務服務 🐝'),
]);
    }

    if (event.type === 'postback') {
      return handlePostback(event);
    }

    if (event.type === 'message') {
      if (event.message.type !== 'text') {
        return null;
      }

      return handleTextMessage(event);
    }

    return null;
  } catch (err) {
    console.error('❌ handleEvent 錯誤：', err);
    if (event.replyToken) {
      return replyText(event.replyToken, '系統忙線中，請稍後再試。');
    }
    return null;
  }
}

app.listen(PORT, () => {
  console.log(`UBee OMS is running on port ${PORT}`);
});

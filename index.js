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
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
const LINE_FINISH_GROUP_ID = process.env.LINE_FINISH_GROUP_ID || '';
const LINE_ADMIN_GROUP_ID = process.env.LINE_ADMIN_GROUP_ID || LINE_FINISH_GROUP_ID || LINE_GROUP_ID;
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

if (!LINE_GROUP_ID) {
  console.error('❌ 缺少 LINE_GROUP_ID');
  process.exit(1);
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

// 1. 取得騎士資料
app.get('/api/rider/profile', async (req, res) => {
  try {
    const { lineUserId } = req.query;

    if (!lineUserId) {
      return res.status(400).json({ message: '缺少 lineUserId' });
    }

    const snap = await db.collection('riders')
      .where('lineUserId', '==', lineUserId)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ message: '找不到騎士資料' });
    }

    const doc = snap.docs[0];

    return res.json({
      rider: {
        id: doc.id,
        ...doc.data()
      }
    });

  } catch (err) {
    console.error('取得騎士資料失敗:', err);
    return res.status(500).json({ message: '取得騎士資料失敗' });
  }
});

// 2. 取得可接任務
app.get('/api/rider/tasks', async (req, res) => {
  try {
    const snap = await db.collection('orders')
      .where('status', '==', 'pending_dispatch')
      .orderBy('createdAt', 'desc')
      .limit(30)
      .get();

    const tasks = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    return res.json({ tasks });

  } catch (err) {
    console.error('取得可接任務失敗:', err);
    return res.status(500).json({ message: '取得可接任務失敗' });
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

    const riderId = 'R' + Date.now();

    const rider = {
  riderId,
  name,
  phone,
  lineId: lineId || '',
  userId: userId || lineUserId || lineId || '',
  lineUserId: lineUserId || userId || '',
  district: district || '',
  vehicle,
  plateNumber: plateNumber || '',
  area: area || serviceArea || '',
  serviceArea: serviceArea || area || '',
  availableTime: availableTime || '',
  status: 'pending',
  createdAt: new Date().toLocaleString('zh-TW')
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
      .where('status', '==', 'approved')
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(403).json({
        success: false,
        message: '你尚未通過 UBee 騎士審核，暫時無法切換接單狀態。',
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
    const {
      companyName,
      contactName,
      phone,
      lineId,
      district,
      selectedTypes,
      needType,
      frequency,
      deliveryArea,
      note,
    } = req.body;

    if (!companyName || !contactName || !phone || !district || !needType || !frequency || !deliveryArea) {
      return res.status(400).json({
        success: false,
        message: '資料不完整，請確認公司名稱、聯絡人、手機、所在區域與需求資料都有填寫。',
      });
    }

    const businessLineUserId = cleanText(req.body.lineUserId || req.body.userId || '', 80);

    const businessPayload = {
      companyName: cleanText(companyName, 80),
      contactName: cleanText(contactName, 40),
      phone: normalizePhone(phone),
      lineId: cleanText(lineId, 60),
      district: cleanText(district, 80),
      selectedTypes: Array.isArray(selectedTypes) ? selectedTypes.map(t => cleanText(t, 40)) : [],
      needType: cleanText(needType, 40),
      frequency: cleanText(frequency, 40),
      deliveryArea: cleanText(deliveryArea, 120),
      note: cleanLongText(note || '', 300),
      lineUserId: businessLineUserId,
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

        await pushToGroup(LINE_ADMIN_GROUP_ID, createBusinessReviewFlex(updatedBusiness));

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

    await pushToGroup(LINE_ADMIN_GROUP_ID, createBusinessReviewFlex(business));

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
    });
  }
});

const PRICING = {
  baseFee: 99,
  perKm: 8,
  perMinute: 2,
  serviceFee: 50,
  waitingFee: 60,
  driverRatio: 0.6,
};

const SPEED_OPTIONS = {
  standard: { label: '標準件', time: '60–90 分鐘', fee: 30, riderText: '標準任務' },
  priority: { label: '快速件', time: '45–60 分鐘', fee: 50, riderText: '快速任務' },
  express: { label: '優先件', time: '30–45 分鐘', fee: 80, riderText: '優先任務' },
  rush: { label: '急件', time: '20–30 分鐘', fee: 150, riderText: '急件任務' },
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
  if (!rider || !rider.riderId) return rider;
  riders[rider.riderId] = rider;
  await db.collection('riders').doc(rider.riderId).set(rider, { merge: true });
  return rider;
}

async function getRider(riderId) {
  const id = String(riderId || '');
  if (!id) return null;

  if (riders[id]) return riders[id];

  const doc = await db.collection('riders').doc(id).get();
  if (!doc.exists) return null;

  const rider = doc.data();
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

function normalizeMapsAddress(address) {
  const text = String(address || '')
    .replace(/[，,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return '';

  if (text.includes('台灣') || text.includes('臺灣')) {
    return text;
  }

  return `台灣 ${text}`;
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
  return ({ jko: '街口支付', bank: '銀行轉帳' }[method] || '未選擇');
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
      .where('status', '==', 'approved')
      .limit(1)
      .get();

    return !snap.empty;
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

  await pushToGroup(LINE_GROUP_ID, createTextMessage(
    `⚠️ 訂單已由 UBee 管理員強制取消\n\n` +
    `訂單編號：${order.id}\n` +
    `請勿繼續執行此任務。`
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
  try {
    const targetUserId = order?.userId || order?.customerId;

    if (!targetUserId || targetUserId === 'web-order') {
      console.log(`⚠️ 訂單 ${order?.id || 'UNKNOWN'} 沒有綁定客人 LINE userId`);
      return false;
    }

    await pushToUser(targetUserId, messages);
    return true;
  } catch (err) {
    console.error(`❌ 通知客人失敗：${order?.id || 'UNKNOWN'}`, err);
    return false;
  }
}

async function pushToGroup(groupId, messages) {
  if (!groupId) return;
  const list = Array.isArray(messages) ? messages : [messages];
  await client.pushMessage(groupId, list);
}

async function getDistanceMatrix(origin, destination) {
  const cleanOrigin = normalizeMapsAddress(origin);
  const cleanDestination = normalizeMapsAddress(destination);

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

function createInfoMenuFlex() {
  return createFlexMessage('我的資訊', createBubble(
    '📋 UBee｜我的資訊',
    [{ type: 'text', text: '請選擇你要查看的內容👇', size: 'sm', color: '#666666', wrap: true }],
    [
      createActionButton('取消規則', 'submenu=cancelRules'),
      createActionButton('常見問題', 'submenu=faq', 'secondary'),
      createActionButton('查詢訂單', 'submenu=queryOrder', 'secondary')
    ]
  ));
}

function createBusinessReviewFlex(business) {
  return createFlexMessage('新商務合作申請', createBubble(
    '🏢 新商務合作申請',
    [
      createInfoRow('申請編號', business.businessId),
      createInfoRow('公司 / 店家', business.companyName),
      createInfoRow('聯絡人', business.contactName),
      createInfoRow('手機', business.phone),
      createInfoRow('LINE ID', business.lineId),
      createInfoRow('所在區域', business.district),
      createInfoRow('合作類型', business.selectedTypes?.length ? business.selectedTypes.join('、') : business.needType),
      createInfoRow('主要需求', business.needType),
      createInfoRow('需求頻率', business.frequency),
      createInfoRow('配送區域', business.deliveryArea),
      createInfoRow('備註', business.note || '無'),
      createInfoRow('狀態', '待審核 / 待聯繫'),
      createInfoRow('送出時間', business.createdAt),
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
  createUriButton('撥打聯絡人', buildTelUrl(business.phone)),
  {
    type: 'button',
    style: 'secondary',
    action: {
      type: 'postback',
      label: '審核通過',
      data: `business_approve:${business.businessId}`
    }
  }
]
  ));
}

function createCancelRulesFlex() {
  return createFlexMessage('取消規則', createBubble(
    '取消規則',
    [
      createTextBlock('① 未接單', '可免費取消。'),
      createTextBlock('② 已接單', '酌收配送費 30%，最低 NT$60，最高 NT$200。'),
      createTextBlock('③ 騎士已抵達取件地點', '酌收配送費 50%，最低 NT$100，最高 NT$300。'),
      createTextBlock('④ 已取件後', '原則上不可取消，若有特殊狀況請聯繫 UBee。'),
    ],
    [createActionButton('返回我的資訊', 'menu=info', 'secondary')]
  ));
}

function createFaqFlex() {
  return createFlexMessage('常見問題', createBubble(
    '常見問題',
    [
      createTextBlock('Q1：UBee 可以送什麼？', '文件、合約、發票、樣品、商務物品、個人物品、安全代送與私人物件。'),
      createTextBlock('Q2：UBee 不接哪些項目？', '違法物品、危險品、易燃物、活體動物、高價未保管物、高度個資風險或需特殊證照的項目恕不承接。'),
      createTextBlock('Q3：多久可以送達？', '依距離、路況與速度選項而定。'),
      createTextBlock('Q4：費用怎麼計算？', '費用依 Google Maps 距離與時間計算，並加上服務費與系統費。'),
      createTextBlock('Q5：付款方式有哪些？', '目前支援街口支付與銀行轉帳。'),
      createTextBlock('Q6：什麼是等候費？', '騎士抵達現場後，若需要額外等候超過 3–5 分鐘，可能會申請等候費 NT$60。'),
      createTextBlock('Q7：可以查詢訂單嗎？', '可以。點選「查詢訂單」後，輸入訂單編號即可查看目前狀態。'),
      createTextBlock('Q8：有開發票或收據嗎？', '目前提供收據或交易紀錄，暫不開立統一發票。'),
    ],
    [createActionButton('返回我的資訊', 'menu=info', 'secondary')]
  ));
}

function createQueryOrderFlex() {
  return createFlexMessage('查詢訂單', createBubble(
    '查詢訂單',
    [
      { type: 'text', text: '請直接在聊天室輸入你的訂單編號，系統會回覆目前狀態。', size: 'sm', color: '#666666', wrap: true },
      createTextBlock('輸入範例', 'UB202604270001'),
    ],
    [createActionButton('返回我的資訊', 'menu=info', 'secondary')]
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

function createDispatchGroupFlex(order) {
  const speed = getSpeedOption(order.speedType);
  return createFlexMessage('UBee 新任務通知', createBubble(
    'UBee 新任務通知',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('狀態', getStatusLabel(order.status)),
      createInfoRow('配送速度', `${speed.label}｜${speed.riderText}`),
      createInfoRow('服務類型', order.serviceType),
      createInfoRow('取件地址', order.pickupAddress),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('物品內容', order.item),
      createInfoRow('備註', order.note || '無'),
      createInfoRow('騎手收入', formatCurrency(order.driverFee)),
    ],
    [
      createActionButton('接受訂單', `accept=${order.id}`, 'primary'),
      createUriButton('導航到取件地點', buildGoogleMapDirectionsUrl(order.pickupAddress), 'secondary'),
    ]
  ));
}

function createMerchantDispatchFlex(order) {
  return createFlexMessage('UBee 合作店家配送單', createBubble(
    'UBee 合作店家配送單',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('店家名稱', order.merchantName),
      createInfoRow('配送方式', order.deliveryTypeText),
      createInfoRow('取貨地址', order.pickupAddress),
      createInfoRow('店家電話', order.pickupPhone),
      createInfoRow('顧客姓名', order.customerName),
      createInfoRow('顧客電話', order.dropoffPhone),
      createInfoRow('送達地址', order.dropoffAddress),
      createInfoRow('商品內容', order.item),
      createInfoRow('備註', order.note || '無'),
    ],
    [
      createActionButton('接受配送單', `accept=${order.id}`, 'primary'),
      createUriButton('導航到店家', buildGoogleMapDirectionsUrl(order.pickupAddress), 'secondary'),
      createUriButton('導航到顧客地址', buildGoogleMapDirectionsUrl(order.dropoffAddress), 'secondary'),
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
    serviceType: cleanText(data.serviceType || data.service || '生活跑腿', ORDER_INPUT_LIMITS.serviceType),
    item: cleanText(data.item || '', ORDER_INPUT_LIMITS.item),
    pickupAddress: cleanText(data.pickup || data.pickupAddress || '', ORDER_INPUT_LIMITS.pickupAddress),
    pickupPhone: normalizePhone(cleanText(data.pickupPhone || '', ORDER_INPUT_LIMITS.pickupPhone)),
    dropoffAddress: cleanText(data.dropoff || data.dropoffAddress || '', ORDER_INPUT_LIMITS.dropoffAddress),
    dropoffPhone: normalizePhone(cleanText(data.dropoffPhone || '', ORDER_INPUT_LIMITS.dropoffPhone)),
    speedType: ['standard', 'priority', 'express', 'rush'].includes(data.speedType || data.speed)
      ? (data.speedType || data.speed)
      : 'standard',
    note: cleanLongText(data.note || '', ORDER_INPUT_LIMITS.note),
  };
}
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    liffId: LIFF_ID,
    businessFormUrl: BUSINESS_FORM_URL,
    partnerFormUrl: PARTNER_FORM_URL,
    googleMapsApiKey: GOOGLE_MAPS_API_KEY,
  });
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

      total: 0,
      driverFee: 0,
      platformFee: 0,
      deliveryFee: 0,
      serviceFee: 0,
      speedFee: 0,
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

    await pushToGroup(LINE_GROUP_ID, createMerchantDispatchFlex(order));
    await pushToGroup(LINE_ADMIN_GROUP_ID, createAdminForceCancelFlex(order));

    return res.json({
      success: true,
      orderId: id,
      message: '店家配送單已建立，系統已推送到騎士群組。',
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

    const distance = await getDistanceMatrixCached(data.pickupAddress, data.dropoffAddress);
    if(!distance || !distance.distanceMeters || !distance.durationSeconds){
    return res.status(400).json({
    success: false,
    error: '地址無法計算距離，請確認取件與送達地址是否完整。'
  });
}
    const price = calculatePrice({
      distanceMeters: distance.distanceMeters,
      durationSeconds: distance.durationSeconds,
      speedType: data.speedType,
    });

    const id = generateOrderId();

    const order = {
      id,
      userId: data.userId,
      customerId: data.customerId,
      riderId: '',
      status: 'pending_payment',
      serviceGroup: data.serviceGroup,
      serviceType: data.serviceType,
      item: data.item,
      pickupAddress: data.pickupAddress,
      pickupPhone: data.pickupPhone,
      dropoffAddress: data.dropoffAddress,
      dropoffPhone: data.dropoffPhone,
      speedType: data.speedType,
      note: data.note,
      duplicateFingerprint: getDuplicateFingerprint(data),
      distanceMeters: distance.distanceMeters,
      durationSeconds: distance.durationSeconds,
      distanceText: distance.distanceText,
      durationText: distance.durationText,
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

    if (!order) return res.status(404).json({ success: false, error: '找不到此訂單' });
    if (!isSameCustomerUserId(order, requestUserId)) {
      return res.status(403).json({ success: false, error: '此訂單只能由原本下單的客人設定付款方式' });
    }
    if (!['jko'].includes(paymentMethod)) {
      return res.status(400).json({ success: false, error: '付款方式錯誤' });
    }
    if (!['pending_payment'].includes(order.status)) {
      return res.status(400).json({ success: false, error: `此訂單目前狀態為「${getStatusLabel(order.status)}」，不可再變更付款方式` });
    }

    order.paymentMethod = paymentMethod;
    order.status = 'pending_payment';
    await saveOrder(order);

    await notifyCustomer(order, createTextMessage(`你已選擇付款方式：${getPaymentMethodLabel(paymentMethod)}\n完成付款後，請回到網頁按「我已付款」。`));

    res.json({
      success: true,
      orderId,
      paymentMethod,
      paymentMethodLabel: getPaymentMethodLabel(paymentMethod),
      paymentInfo: paymentMethod === 'jko' ? PAYMENT_JKO_INFO : PAYMENT_BANK_INFO,
      total: order.total,
    });
  } catch (error) {
    console.error('❌ 設定付款方式失敗：', error);
    res.status(500).json({ success: false, error: '設定付款方式失敗' });
  }
});

app.post('/api/orders/:orderId/paid', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').toUpperCase();
    const requestUserId = getCustomerUserIdFromBody(req.body);
    const order = await getOrder(orderId);

    if (!order) return res.status(404).json({ success: false, error: '找不到此訂單' });
    if (!isSameCustomerUserId(order, requestUserId)) {
      return res.status(403).json({ success: false, error: '此訂單只能由原本下單的客人確認付款' });
    }
    if (!order.paymentMethod) return res.status(400).json({ success: false, error: '請先選擇付款方式' });

    if (order.isPaid) {
      return res.json({ success: true, orderId, message: '此訂單已標記付款完成' });
    }

    if (order.status !== 'pending_payment') {
      return res.status(400).json({ success: false, error: `此訂單目前狀態為「${getStatusLabel(order.status)}」，不可重複確認付款` });
    }

    order.isPaid = true;
    order.paidAt = Date.now();
    order.status = 'pending_dispatch';
    await saveOrder(order);

    await notifyCustomer(
      order,
      createTextMessage(`✅ 已收到你的付款通知。\n\n訂單編號：${order.id}\n🚀 系統正在為你配對騎手，請稍候...`)
    );

    // 客人確認付款後：直接派單到騎士群；辦公室審核群只收到管理/強制取消卡，不需要管理員確認付款。
    await pushToGroup(LINE_GROUP_ID, createDispatchGroupFlex(order));
    await pushToGroup(LINE_ADMIN_GROUP_ID, createAdminForceCancelFlex(order));

    res.json({
      success: true,
      orderId,
      message: '已收到付款通知，系統已自動派單到騎手群組',
    });
  } catch (error) {
    console.error('❌ H5 確認付款失敗：', error);
    res.status(500).json({ success: false, error: '確認付款失敗，請稍後再試' });
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

app.post('/api/rider/accept-order', async (req, res) => {
  try {
    const { orderId, lineUserId } = req.body;

    if (!orderId || !lineUserId) {
      return res.status(400).json({
        success: false,
        error: '缺少訂單編號或騎士 LINE 身分',
      });
    }

    const approved = await isApprovedRiderUser(lineUserId);

    if (!approved) {
      return res.status(403).json({
        success: false,
        error: '你尚未通過 UBee 騎士審核，暫時無法接單。',
      });
    }

    const orderRef = db.collection('orders').doc(String(orderId).toUpperCase());
    let acceptedOrder = null;

    await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);

      if (!orderDoc.exists) {
        throw new Error('ORDER_NOT_FOUND');
      }

      const order = orderDoc.data();

      if (isTerminalOrderStatus(order)) {
        throw new Error('ORDER_TERMINAL');
      }

      if (order.status !== 'pending_dispatch') {
        throw new Error('ORDER_ALREADY_ACCEPTED');
      }

      order.riderId = lineUserId;
      order.status = 'accepted';
      order.acceptedAt = Date.now();

      transaction.set(orderRef, order, { merge: true });

      acceptedOrder = order;
    });

    orders[acceptedOrder.id] = acceptedOrder;

    await notifyCustomer(
      acceptedOrder,
      createTextMessage(`🟢 UBee 騎士已接單\n\n訂單編號：${acceptedOrder.id}\n騎士將盡快設定抵達取件時間。`)
    );

    return res.json({
      success: true,
      orderId: acceptedOrder.id,
      message: '接單成功',
    });

  } catch (error) {
    console.error('❌ 騎士網頁接單失敗：', error);

    if (error.message === 'ORDER_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        error: '找不到此訂單',
      });
    }

    if (error.message === 'ORDER_ALREADY_ACCEPTED') {
      return res.status(409).json({
        success: false,
        error: '此訂單已被其他騎士接走',
      });
    }

    if (error.message === 'ORDER_TERMINAL') {
      return res.status(400).json({
        success: false,
        error: '此訂單已完成或已取消，無法接單。',
      });
    }

    return res.status(500).json({
      success: false,
      error: '接單失敗，請稍後再試。',
    });
  }
});

// ===== 騎士更新任務狀態 API =====
app.post('/api/rider/update-order-status', async (req, res) => {
  try {
    const { orderId, lineUserId, status } = req.body;

    if (!orderId || !lineUserId || !status) {
      return res.status(400).json({
        success: false,
        error: '缺少訂單編號、騎士 LINE 身分或任務狀態',
      });
    }

    const order = await getOrder(orderId);

    if (!order) {
      return res.status(404).json({
        success: false,
        error: '找不到此訂單',
      });
    }

    if (order.riderId !== lineUserId) {
      return res.status(403).json({
        success: false,
        error: '只有接單騎士可以更新此任務狀態',
      });
    }

    const allowedFlow = {
      accepted: ['arrived_pickup'],
      arrived_pickup: ['picked_up'],
      picked_up: ['arrived_dropoff'],
      arrived_dropoff: ['completed'],
    };

    const nextStatuses = allowedFlow[order.status] || [];

    if (!nextStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `此訂單目前狀態為「${getStatusLabel(order.status)}」，不能更新為「${getStatusLabel(status)}」`,
      });
    }

    const timeFieldMap = {
      arrived_pickup: 'arrivedPickupAt',
      picked_up: 'pickedUpAt',
      arrived_dropoff: 'arrivedDropoffAt',
      completed: 'completedAt',
    };

    order.status = status;
    order[timeFieldMap[status]] = Date.now();

    await saveOrder(order);

    await notifyCustomer(
      order,
      createTextMessage(`UBee 任務狀態更新\n\n訂單編號：${order.id}\n目前狀態：${getStatusLabel(order.status)}`)
    );

    if (status === 'completed') {
      await pushToGroup(LINE_FINISH_GROUP_ID, createFinanceFlex(order));
    }

    return res.json({
      success: true,
      orderId: order.id,
      status: order.status,
      statusLabel: getStatusLabel(order.status),
      message: '任務狀態已更新',
    });

  } catch (error) {
    console.error('❌ 騎士更新任務狀態失敗：', error);
    return res.status(500).json({
      success: false,
      error: '任務狀態更新失敗，請稍後再試。',
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

    try {
      await pushToGroup(LINE_GROUP_ID, createTextMessage(`❌ 訂單已取消\n訂單編號：${order.id}`));
    } catch (e) {
      console.error('取消通知失敗', e);
    }

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

  if (data === 'menu=info') return replyMessages(event.replyToken, [createInfoMenuFlex()]);
  if (data === 'submenu=cancelRules') return replyMessages(event.replyToken, [createCancelRulesFlex()]);
  if (data === 'submenu=faq') return replyMessages(event.replyToken, [createFaqFlex()]);
  if (data === 'submenu=queryOrder') return replyMessages(event.replyToken, [createQueryOrderFlex()]);

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

  if (data.startsWith('accept=')) {
  const orderId = getPostbackValue(data, 'accept');
  const order = await getOrderOrReply(event.replyToken, orderId);
  if (!order) return null;

  const latestOrder = await getOrder(orderId);

  if (!latestOrder || latestOrder.status !== 'pending_dispatch') {
    return replyText(
      event.replyToken,
      '此訂單已被其他騎士接走。'
    );
  }

  const approved = await requireApprovedRider(event);
  if (!approved) return null;

  latestOrder.riderId = userId;
  latestOrder.status = 'accepted';
  latestOrder.acceptedAt = Date.now();
  await saveOrder(latestOrder);

  await notifyCustomer(
    latestOrder,
    createTextMessage(`🟢 UBee 騎士已接單\n\n訂單編號：${latestOrder.id}\n騎士將盡快設定抵達取件時間。`)
  );

  return replyMessages(event.replyToken, [
    createTextMessage(`✅ 你已接受訂單：${latestOrder.id}`),
    createETAFlex(latestOrder),
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

    await updateOrderStatus(order, 'completed', { completedAt: Date.now() });

    await notifyCustomer(
      order,
      createTextMessage(`✅ UBee 任務已完成\n\n訂單編號：${order.id}\n感謝你使用 UBee 城市任務服務。`)
    );

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

    await pushToGroup(
      LINE_GROUP_ID,
      createTextMessage(`✅ 客人已同意等候費 NT$60\n訂單編號：${order.id}`)
    );

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

    await pushToGroup(
      LINE_GROUP_ID,
      createTextMessage(`客人不同意等候費申請\n訂單編號：${order.id}`)
    );

    await replyText(event.replyToken, `已拒絕加收等候費\n\n訂單編號：${order.id}`);
    return null;
  }

  return replyText(event.replyToken, '未識別的操作。');
}

async function handleTextStep(event, userId, text) {
  const normalized = text.trim();

  if (normalized === '主選單') return replyMessages(event.replyToken, [createMainMenuFlex()]);
  if (normalized === '我的資訊' || normalized === '我的') {
  return client.replyMessage(event.replyToken, {
    type: 'template',
    altText: 'UBee 我的資訊',
    template: {
      type: 'buttons',
      title: 'UBee｜我的資訊',
      text: '查看 UBee 的取消規則與常見問題。',
      actions: [
        {
          type: 'uri',
          label: '開啟我的資訊',
          uri: getPublicUrl('info.html')
        }
      ]
    }
  });
}
  if (normalized === '取消規則') return replyMessages(event.replyToken, [createCancelRulesFlex()]);
  if (normalized === '常見問題') return replyMessages(event.replyToken, [createFaqFlex()]);
  if (normalized === '查詢訂單') return replyMessages(event.replyToken, [createQueryOrderFlex()]);

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

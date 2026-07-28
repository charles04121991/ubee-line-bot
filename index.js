require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
const webpush = require('web-push');
const multer = require('multer');

// UBee 正式清理整合版：已移除被 Google Maps 外部導航取代的舊 Navigation V2.4 後端流程。
// UBee Merchant Platform V3 + 小U資料庫 V2 證件上傳整合版｜2026-07-28

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


// =====================================================
// UBee 小U資料庫 V2：申請層／正式騎士層分離
// 第一階段採安全遷移：
// - 新申請只寫入 riderApplicationsV2
// - 審核通過後建立 ridersV2
// - 過渡期同步鏡像到舊 riders，待騎士端與調度中心改讀 V2 後再移除
// - 舊 riderApplications 不再新增資料
// =====================================================
const RIDER_V2_COLLECTIONS = Object.freeze({
  applications: 'riderApplicationsV2',
  riders: 'ridersV2',
  presence: 'riderPresenceV2',
  locations: 'riderLocationsV2',
  stats: 'riderStatsV2',
});

const RIDER_V2_APPLICATION_ROUND = '2026_RIDER_RESET';
const RIDER_V2_DATA_VERSION = 2;
const RIDER_V2_MIRROR_TO_LEGACY_RIDERS =
  String(process.env.RIDER_V2_MIRROR_TO_LEGACY_RIDERS || 'true')
    .trim()
    .toLowerCase() === 'true';

const RIDER_DOCUMENT_STORAGE_BUCKET = String(
  process.env.FIREBASE_STORAGE_BUCKET ||
  `${process.env.FIREBASE_PROJECT_ID || ''}.appspot.com`
).trim();

const RIDER_DOCUMENT_MAX_BYTES = 6 * 1024 * 1024;

const RIDER_REQUIRED_DOCUMENTS = Object.freeze({
  idFront: 'id_front',
  idBack: 'id_back',
  driverLicense: 'driver_license',
  vehicleLicense: 'vehicle_license',
  compulsoryInsurance: 'compulsory_insurance',
});

const RIDER_DOCUMENT_LABELS = Object.freeze({
  idFront: '身分證正面',
  idBack: '身分證反面',
  driverLicense: '駕照',
  vehicleLicense: '行照',
  compulsoryInsurance: '強制險證明',
});

// 證件先由 multer 存入記憶體，再立即寫入 Firebase Storage。
// 不落地到 Render 本機磁碟，避免部署或重啟後遺失。
const riderDocumentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: RIDER_DOCUMENT_MAX_BYTES,
  },
  fileFilter: (req, file, callback) => {
    const allowedMimeTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
    ]);

    if (!allowedMimeTypes.has(String(file?.mimetype || '').toLowerCase())) {
      return callback(new Error('RIDER_DOCUMENT_UNSUPPORTED_TYPE'));
    }

    return callback(null, true);
  },
});

function normalizeRiderDocumentKey(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toLowerCase();

  const aliases = {
    idfront: 'idFront',
    id_front: 'idFront',
    identity_front: 'idFront',
    idback: 'idBack',
    id_back: 'idBack',
    identity_back: 'idBack',
    driverlicense: 'driverLicense',
    driver_license: 'driverLicense',
    vehiclelicense: 'vehicleLicense',
    vehicle_license: 'vehicleLicense',
    compulsoryinsurance: 'compulsoryInsurance',
    compulsory_insurance: 'compulsoryInsurance',
    insurance: 'compulsoryInsurance',
  };

  return aliases[normalized] || '';
}

function buildRiderApplicantStorageKey(phone, lineUserId) {
  return crypto
    .createHash('sha256')
    .update(`${normalizePhone(phone)}:${String(lineUserId || '').trim()}`)
    .digest('hex')
    .slice(0, 40);
}

function riderDocumentExtension(mimeType, originalName = '') {
  const extFromName = String(originalName || '')
    .toLowerCase()
    .match(/\.([a-z0-9]{1,8})$/)?.[1];

  const allowedNameExt = new Set([
    'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'
  ]);

  if (extFromName && allowedNameExt.has(extFromName)) {
    return extFromName;
  }

  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
  };

  return map[mimeType] || 'bin';
}

async function handleRiderDocumentUpload(req, res) {
  try {
    const phone = normalizePhone(
      req.body?.phone ||
      req.headers['x-ubee-rider-phone'] ||
      ''
    );

    const lineUserId = String(
      req.body?.lineUserId ||
      req.headers['x-ubee-rider-line-user-id'] ||
      ''
    ).trim();

    const documentKey = normalizeRiderDocumentKey(
      req.body?.documentType ||
      req.body?.documentKey ||
      req.headers['x-ubee-rider-document-type'] ||
      ''
    );

    if (!/^09\d{8}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: '上傳證件前，請先輸入正確的手機號碼。',
      });
    }

    if (!lineUserId.startsWith('U')) {
      return res.status(400).json({
        success: false,
        message: '缺少正確的 LINE 身分，無法上傳證件。',
      });
    }

    if (!documentKey || !RIDER_REQUIRED_DOCUMENTS[documentKey]) {
      return res.status(400).json({
        success: false,
        message: '證件類型不正確。',
      });
    }

    const uploadFile = req.file;
    const fileBuffer = uploadFile?.buffer;

    if (!uploadFile || !Buffer.isBuffer(fileBuffer) || !fileBuffer.length) {
      return res.status(400).json({
        success: false,
        message: '沒有收到證件檔案，請重新選擇後上傳。',
      });
    }

    if (fileBuffer.length > RIDER_DOCUMENT_MAX_BYTES) {
      return res.status(413).json({
        success: false,
        message: '單一證件檔案不可超過 6 MB。',
      });
    }

    const contentType = String(
      uploadFile.mimetype || ''
    ).trim().toLowerCase();

    const allowedMimeTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
    ]);

    if (!allowedMimeTypes.has(contentType)) {
      return res.status(415).json({
        success: false,
        message: '證件檔案只支援 JPG、PNG、WEBP 或 HEIC。',
      });
    }

    if (
      !RIDER_DOCUMENT_STORAGE_BUCKET ||
      RIDER_DOCUMENT_STORAGE_BUCKET.startsWith('.')
    ) {
      return res.status(503).json({
        success: false,
        code: 'RIDER_DOCUMENT_STORAGE_NOT_CONFIGURED',
        message: 'Firebase Storage Bucket 尚未設定。請在 Render 設定 FIREBASE_STORAGE_BUCKET。',
      });
    }

    const originalName = cleanText(
      uploadFile.originalname || documentKey,
      180
    );

    const applicantKey = buildRiderApplicantStorageKey(
      phone,
      lineUserId
    );

    const uploadId = crypto.randomUUID();
    const extension = riderDocumentExtension(
      contentType,
      originalName
    );

    const storagePath =
      `rider-documents-v2/pending/${applicantKey}/` +
      `${documentKey}/${Date.now()}_${uploadId}.${extension}`;

    const sha256 = crypto
      .createHash('sha256')
      .update(fileBuffer)
      .digest('hex');

    const bucket = admin
      .storage()
      .bucket(RIDER_DOCUMENT_STORAGE_BUCKET);

    const file = bucket.file(storagePath);

    await file.save(fileBuffer, {
      resumable: false,
      validation: 'md5',
      metadata: {
        contentType,
        cacheControl: 'private, max-age=0, no-transform',
        metadata: {
          riderApplicantKey: applicantKey,
          riderDocumentKey: documentKey,
          riderDocumentType: RIDER_REQUIRED_DOCUMENTS[documentKey],
          sha256,
          dataVersion: String(RIDER_V2_DATA_VERSION),
        },
      },
    });

    return res.json({
      success: true,
      document: {
        documentKey,
        documentType: RIDER_REQUIRED_DOCUMENTS[documentKey],
        label: RIDER_DOCUMENT_LABELS[documentKey],
        originalName,
        mimeType: contentType,
        sizeBytes: fileBuffer.length,
        sha256,
        storageBucket: bucket.name,
        storagePath,
        uploadedAtMs: Date.now(),
      },
    });
  } catch (error) {
    console.error('❌ 小U證件上傳失敗：', error);

    return res.status(500).json({
      success: false,
      message: '證件上傳失敗，請稍後再試。',
      error: error.message,
    });
  }
}

async function validateRiderApplicationDocuments(
  documents,
  phone,
  lineUserId
) {
  const safeDocuments =
    documents && typeof documents === 'object'
      ? documents
      : {};

  const applicantKey = buildRiderApplicantStorageKey(
    phone,
    lineUserId
  );

  const bucket = admin
    .storage()
    .bucket(RIDER_DOCUMENT_STORAGE_BUCKET);

  const normalized = {};

  for (const [documentKey, documentType] of Object.entries(
    RIDER_REQUIRED_DOCUMENTS
  )) {
    const item = safeDocuments[documentKey];

    if (!item || typeof item !== 'object') {
      return {
        ok: false,
        message: `請上傳${RIDER_DOCUMENT_LABELS[documentKey]}。`,
      };
    }

    const storagePath = String(item.storagePath || '').trim();
    const storageBucket = String(
      item.storageBucket || RIDER_DOCUMENT_STORAGE_BUCKET
    ).trim();

    const expectedPrefix =
      `rider-documents-v2/pending/${applicantKey}/` +
      `${documentKey}/`;

    if (
      storageBucket !== bucket.name ||
      !storagePath.startsWith(expectedPrefix)
    ) {
      return {
        ok: false,
        message: `${RIDER_DOCUMENT_LABELS[documentKey]}的上傳資料不正確，請重新上傳。`,
      };
    }

    const file = bucket.file(storagePath);
    const [exists] = await file.exists();

    if (!exists) {
      return {
        ok: false,
        message: `找不到${RIDER_DOCUMENT_LABELS[documentKey]}檔案，請重新上傳。`,
      };
    }

    const [metadata] = await file.getMetadata();
    const customMetadata = metadata.metadata || {};

    if (
      String(customMetadata.riderApplicantKey || '') !== applicantKey ||
      String(customMetadata.riderDocumentKey || '') !== documentKey ||
      String(customMetadata.riderDocumentType || '') !== documentType
    ) {
      return {
        ok: false,
        message: `${RIDER_DOCUMENT_LABELS[documentKey]}的檔案驗證失敗，請重新上傳。`,
      };
    }

    normalized[documentKey] = {
      documentKey,
      documentType,
      label: RIDER_DOCUMENT_LABELS[documentKey],
      originalName: cleanText(item.originalName || '', 180),
      mimeType: String(metadata.contentType || item.mimeType || '').trim(),
      sizeBytes: Number(metadata.size || item.sizeBytes || 0),
      sha256: String(customMetadata.sha256 || item.sha256 || '').trim(),
      storageBucket: bucket.name,
      storagePath,
      reviewStatus: 'pending',
      uploadedAtMs: Number(item.uploadedAtMs || Date.now()),
    };
  }

  return {
    ok: true,
    documents: normalized,
  };
}


// =====================================================
// UBee 小U Firebase Token 過渡期設定
//
// false：相容模式。沒有 Bearer Token 時，仍維持現有舊版 API 流程。
// true：強制模式。所有已掛上 riderAuthMiddleware 的 API 都必須有有效 Token。
//
// rider.html 已完成 Firebase Custom Token -> ID Token 串接；正式切換強制模式前仍建議先保持 false 做相容驗證。
// =====================================================
const RIDER_AUTH_ENFORCE =
  String(process.env.RIDER_AUTH_ENFORCE || 'false')
    .trim()
    .toLowerCase() === 'true';

console.log(
  `🔐 UBee 小U Token 強制驗證：${
    RIDER_AUTH_ENFORCE
      ? '已啟用'
      : '尚未啟用（相容模式）'
  }`
);

// =====================================================
// 讀取 Authorization: Bearer <Firebase ID Token>
// =====================================================
function getBearerToken(req) {
  const authorization = String(
    req.headers.authorization || ''
  ).trim();

  if (!authorization) {
    return '';
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return '';
  }

  return String(match[1] || '').trim();
}

// =====================================================
// 驗證 Firebase ID Token
// 注意：前端登入 Custom Token 後取得的 ID Token，才可放在 Bearer Header。
// Custom Token 本身不能直接拿來呼叫受保護 API。
// =====================================================
async function verifyRiderFirebaseIdToken(req) {
  const idToken = getBearerToken(req);

  if (!idToken) {
    return {
      ok: false,
      statusCode: 401,
      code: 'RIDER_TOKEN_REQUIRED',
      message: '登入憑證不存在，請重新登入。',
    };
  }

  try {
    const decodedToken = await admin
      .auth()
      .verifyIdToken(idToken);

    return {
      ok: true,
      statusCode: 200,
      idToken,
      decodedToken,
      uid: String(decodedToken.uid || '').trim(),
    };
  } catch (error) {
    console.warn(
      '⚠️ 小U Firebase ID Token 驗證失敗：',
      error && error.message
        ? error.message
        : error
    );

    return {
      ok: false,
      statusCode: 401,
      code: 'RIDER_TOKEN_INVALID',
      message: '登入憑證無效或已失效，請重新登入。',
    };
  }
}

// =====================================================
// 依 riders 文件 ID 建立固定且合法的 Firebase Auth UID
// =====================================================
function buildRiderFirebaseUid(riderDocId) {
  const safeRiderDocId = String(riderDocId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 110);

  if (!safeRiderDocId) {
    throw new Error('INVALID_RIDER_DOC_ID');
  }

  return `rider_${safeRiderDocId}`;
}

// =====================================================
// 建立小U Firebase Custom Token
//
// 登入 API 回傳 Custom Token 後，rider.html 未來要：
// 1. signInWithCustomToken(firebaseCustomToken)
// 2. 取得 Firebase ID Token
// 3. 用 Authorization: Bearer <ID Token> 呼叫受保護 API
// =====================================================
async function createRiderFirebaseCustomToken(riderDoc) {
  if (!riderDoc || !riderDoc.exists) {
    throw new Error('RIDER_DOCUMENT_NOT_FOUND');
  }

  const rider = riderDoc.data() || {};
  const riderDocId = String(riderDoc.id || '').trim();
  const firebaseUid = buildRiderFirebaseUid(riderDocId);

  const firebaseCustomToken = await admin
    .auth()
    .createCustomToken(firebaseUid, {
      role: 'rider',
      riderDocId,
      riderId: String(
        rider.riderId || riderDocId
      ).trim(),
    });

  return {
    firebaseUid,
    firebaseCustomToken,
  };
}

// =====================================================
// 小U Firebase Token 驗證 Middleware
//
// 目前只完成工具本身，尚未掛到既有騎士 API，避免影響現行流程。
// 未來逐支 API 套用時：
// - 相容模式且沒有 Token：放行舊版身分參數。
// - 有 Token：一定驗證；無效 Token 不放行。
// - 強制模式且沒有 Token：回傳 401。
// =====================================================
async function riderAuthMiddleware(req, res, next) {
  try {
    const idToken = getBearerToken(req);

    if (!idToken) {
      if (!RIDER_AUTH_ENFORCE) {
        req.riderAuth = null;
        return next();
      }

      return res.status(401).json({
        success: false,
        code: 'RIDER_TOKEN_REQUIRED',
        message: '登入憑證不存在，請重新登入。',
      });
    }

    const tokenResult =
      await verifyRiderFirebaseIdToken(req);

    if (!tokenResult.ok) {
      return res
        .status(tokenResult.statusCode)
        .json({
          success: false,
          code: tokenResult.code,
          message: tokenResult.message,
        });
    }

    const decodedToken = tokenResult.decodedToken || {};
    const riderDocId = String(decodedToken.riderDocId || '').trim();
    const riderId = String(decodedToken.riderId || riderDocId || '').trim();

    if (String(decodedToken.role || '').trim() !== 'rider' || !riderDocId) {
      return res.status(403).json({
        success: false,
        code: 'RIDER_TOKEN_FORBIDDEN',
        message: '此登入憑證不具備小U權限，請重新登入。',
      });
    }

    req.riderAuth = {
      idToken: tokenResult.idToken,
      decodedToken,
      uid: tokenResult.uid,
      riderDocId,
      riderId,
    };

    // Token 身分是唯一可信來源。保留舊參數相容，但覆蓋可被竄改的 riderId / phone。
    const trustedPhone = /^09\d{8}$/.test(riderDocId) ? riderDocId : '';
    if (req.body && typeof req.body === 'object') {
      req.body.riderId = riderId;
      if (trustedPhone) {
        req.body.phone = trustedPhone;
        req.body.riderPhone = trustedPhone;
      }
    }
    if (req.query && typeof req.query === 'object') {
      req.query.riderId = riderId;
      if (trustedPhone) {
        req.query.phone = trustedPhone;
        req.query.riderPhone = trustedPhone;
      }
    }

    return next();
  } catch (error) {
    console.error(
      '❌ 小U Token Middleware 發生錯誤：',
      error
    );

    return res.status(500).json({
      success: false,
      code: 'RIDER_AUTH_ERROR',
      message: '小U身分驗證失敗，請稍後再試。',
    });
  }
}

const WEB_PUSH_PUBLIC_KEY = process.env.WEB_PUSH_PUBLIC_KEY || '';
const WEB_PUSH_PRIVATE_KEY = process.env.WEB_PUSH_PRIVATE_KEY || '';
const WEB_PUSH_SUBJECT = process.env.WEB_PUSH_SUBJECT || 'mailto:ubee.service@gmail.com';

if (WEB_PUSH_PUBLIC_KEY && WEB_PUSH_PRIVATE_KEY) {
  webpush.setVapidDetails(
    WEB_PUSH_SUBJECT,
    WEB_PUSH_PUBLIC_KEY,
    WEB_PUSH_PRIVATE_KEY
  );

  console.log('✅ UBee Web Push VAPID 已設定');
} else {
  console.warn('⚠️ 尚未設定 WEB_PUSH_PUBLIC_KEY / WEB_PUSH_PRIVATE_KEY，iPhone Web Push 暫時無法發送');
}

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-UBee-Support-Case-Id, X-UBee-Support-Access-Token, X-UBee-Support-Admin-Key, X-UBee-Support-Operator, X-UBee-Support-File-Name, X-UBee-Support-Evidence-Type, X-UBee-Rider-Phone, X-UBee-Rider-Line-User-Id, X-UBee-Rider-Document-Type, X-UBee-Rider-File-Name');

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
const LINE_SAFETY_GROUP_ID = process.env.LINE_SAFETY_GROUP_ID || LINE_ADMIN_GROUP_ID || LINE_FINISH_GROUP_ID || '';
const RIDER_SOP_GROUP_LINK = process.env.RIDER_SOP_GROUP_LINK || '';


// =====================================================
// UBee 小U營運管理系統 V4：固定營運設定
// - 街口支付：平台款項回繳入口
// - 三大 LINE 社群：公告 / 聊天 / 回報
// - 審核群組只處理申請審核，不承接新任務／轉派通知
// =====================================================
const RIDER_WEB_URL =
  process.env.RIDER_WEB_URL ||
  'https://ubee-rider-web.vercel.app/rider.html';

const UBEE_JKOPAY_ACCOUNT =
  String(process.env.UBEE_JKOPAY_ACCOUNT || '901871793').trim();

const UBEE_RIDER_COMMUNITY_PASSWORD =
  String(process.env.UBEE_RIDER_COMMUNITY_PASSWORD || '1234').trim();

const UBEE_RIDER_COMMUNITIES = Object.freeze({
  announcement: process.env.UBEE_RIDER_ANNOUNCEMENT_GROUP ||
    'https://line.me/ti/g2/B1CTRdDllLZN95W3NhMOcVLk4UK9BbwrZTOn-Q?utm_source=invitation&utm_medium=link_copy&utm_campaign=default',
  chat: process.env.UBEE_RIDER_CHAT_GROUP ||
    'https://line.me/ti/g2/18w2eLfCmxmZH21DkhcOGqTygoE4-C9F3J_SlA?utm_source=invitation&utm_medium=link_copy&utm_campaign=default',
  report: process.env.UBEE_RIDER_REPORT_GROUP ||
    'https://line.me/ti/g2/tCKMgQyxBfiYgaq2mlI9J3iH9vv-swc7OjcjGA?utm_source=invitation&utm_medium=link_copy&utm_campaign=default',
});

const UBEE_RIDER_V4_ADMIN_KEY =
  String(process.env.UBEE_RIDER_V4_ADMIN_KEY || '').trim();
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GOOGLE_MAPS_SERVER_API_KEY =
  process.env.GOOGLE_MAPS_SERVER_API_KEY || GOOGLE_MAPS_API_KEY;

// 可選。
// 未設定也可以正常顯示地圖；未來若建立正式 Google Maps Map ID，
// 只要在 Render 增加 GOOGLE_MAPS_MAP_ID 即可。
const GOOGLE_MAPS_MAP_ID =
  process.env.GOOGLE_MAPS_MAP_ID || '';

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

// ===== UBee 距離分段派單工具 =====

function getDispatchPushCoordinate(value) {
  const numberValue = Number(value);

  return Number.isFinite(numberValue)
    ? numberValue
    : null;
}


function getOrderPickupPointForPush(order = {}) {
  const latCandidates = [
    order.pickupLat,
    order.pickupLatitude,
    order.fromLat,
    order.fromLatitude,
    order.pickupLocation?.lat,
    order.pickupLocation?.latitude,
  ];

  const lngCandidates = [
    order.pickupLng,
    order.pickupLongitude,
    order.fromLng,
    order.fromLongitude,
    order.pickupLocation?.lng,
    order.pickupLocation?.longitude,
  ];

  const lat = latCandidates
    .map(getDispatchPushCoordinate)
    .find(value =>
      value !== null &&
      value >= -90 &&
      value <= 90
    );

  const lng = lngCandidates
    .map(getDispatchPushCoordinate)
    .find(value =>
      value !== null &&
      value >= -180 &&
      value <= 180
    );

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }

  return {
    lat,
    lng,
  };
}


function getRiderCurrentPointForPush(rider = {}) {
  const latCandidates = [
    rider.currentLat,
    rider.currentLocation?.lat,
    rider.latitude,
    rider.lat,
  ];

  const lngCandidates = [
    rider.currentLng,
    rider.currentLocation?.lng,
    rider.longitude,
    rider.lng,
  ];

  const lat = latCandidates
    .map(getDispatchPushCoordinate)
    .find(value =>
      value !== null &&
      value >= -90 &&
      value <= 90
    );

  const lng = lngCandidates
    .map(getDispatchPushCoordinate)
    .find(value =>
      value !== null &&
      value >= -180 &&
      value <= 180
    );

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }

  return {
    lat,
    lng,
  };
}


function getDispatchPushTimeMs(value) {
  if (!value) {
    return 0;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? value
      : 0;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);

    return Number.isFinite(parsed)
      ? parsed
      : 0;
  }

  if (
    value &&
    typeof value.toMillis === 'function'
  ) {
    return value.toMillis();
  }

  if (
    value &&
    typeof value.toDate === 'function'
  ) {
    return value.toDate().getTime();
  }

  if (
    value &&
    typeof value.seconds === 'number'
  ) {
    return value.seconds * 1000;
  }

  if (
    value &&
    typeof value._seconds === 'number'
  ) {
    return value._seconds * 1000;
  }

  return 0;
}


function isRiderLocationFreshForPush(
  rider = {},
  maxAgeMs = 120000
) {
  const updatedAtMs =
    getDispatchPushTimeMs(
      rider.locationUpdatedAtMs
    ) ||
    getDispatchPushTimeMs(
      rider.locationUpdatedAt
    ) ||
    getDispatchPushTimeMs(
      rider.currentLocation?.updatedAt
    );

  if (!updatedAtMs) {
    return false;
  }

  const ageMs =
    Date.now() - updatedAtMs;

  return (
    ageMs >= 0 &&
    ageMs <= maxAgeMs
  );
}


function calcDispatchPushDistanceKm(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const values = [
    lat1,
    lng1,
    lat2,
    lng2,
  ].map(Number);

  if (
    values.some(value =>
      !Number.isFinite(value)
    )
  ) {
    return null;
  }

  const [
    safeLat1,
    safeLng1,
    safeLat2,
    safeLng2,
  ] = values;

  const earthRadiusKm = 6371;

  const toRadians = value =>
    value * Math.PI / 180;

  const deltaLat =
    toRadians(
      safeLat2 - safeLat1
    );

  const deltaLng =
    toRadians(
      safeLng2 - safeLng1
    );

  const a =
    Math.sin(deltaLat / 2) *
    Math.sin(deltaLat / 2) +
    Math.cos(
      toRadians(safeLat1)
    ) *
    Math.cos(
      toRadians(safeLat2)
    ) *
    Math.sin(deltaLng / 2) *
    Math.sin(deltaLng / 2);

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return Number(
    (
      earthRadiusKm * c
    ).toFixed(2)
  );
}


// =====================================================
// UBee 預約任務 V1：時間模式、可接時段與預約媒合工具
// - immediate：立即任務
// - scheduled：指定時間預約
// - flexible：彈性時段預約
// =====================================================
const UBEE_ORDER_TIMING_TYPES = Object.freeze({
  IMMEDIATE: 'immediate',
  SCHEDULED: 'scheduled',
  FLEXIBLE: 'flexible',
});

const UBEE_SCHEDULE_CONFIRM_BEFORE_MS = 60 * 60 * 1000;
const UBEE_SCHEDULE_START_EARLY_MS = 90 * 60 * 1000;
const UBEE_SCHEDULE_EMERGENCY_BEFORE_MS = 15 * 60 * 1000;
const UBEE_SCHEDULE_LATE_GRACE_MS = 15 * 60 * 1000;

function normalizeOrderTimingType(value) {
  const type = String(value || '').trim().toLowerCase();

  if (
    type === UBEE_ORDER_TIMING_TYPES.SCHEDULED ||
    type === 'appointment' ||
    type === 'fixed'
  ) {
    return UBEE_ORDER_TIMING_TYPES.SCHEDULED;
  }

  if (
    type === UBEE_ORDER_TIMING_TYPES.FLEXIBLE ||
    type === 'flex' ||
    type === 'time_window'
  ) {
    return UBEE_ORDER_TIMING_TYPES.FLEXIBLE;
  }

  return UBEE_ORDER_TIMING_TYPES.IMMEDIATE;
}

function isScheduledOrderTiming(order = {}) {
  return normalizeOrderTimingType(
    order.orderTimingType ||
    order.timingType ||
    order.fulfillmentTiming ||
    order.scheduleType
  ) !== UBEE_ORDER_TIMING_TYPES.IMMEDIATE;
}

function getScheduleTimestampMs(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value) : 0;
  }

  if (typeof value === 'string') {
    const numeric = Number(value);

    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.round(numeric);
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (typeof value?.toMillis === 'function') {
    return value.toMillis();
  }

  if (typeof value?.toDate === 'function') {
    return value.toDate().getTime();
  }

  if (typeof value?.seconds === 'number') {
    return value.seconds * 1000;
  }

  return 0;
}

function getTaipeiDateParts(ms) {
  const timestamp = getScheduleTimestampMs(ms);

  if (!timestamp) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestamp))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  const weekdayMap = {
    Mon: 'mon',
    Tue: 'tue',
    Wed: 'wed',
    Thu: 'thu',
    Fri: 'fri',
    Sat: 'sat',
    Sun: 'sun',
  };

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dayKey: weekdayMap[parts.weekday] || '',
    minutes: Number(parts.hour || 0) * 60 + Number(parts.minute || 0),
  };
}

function parseHourMinuteToMinutes(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return hour * 60 + minute;
}

function normalizeRiderAvailabilitySchedule(input = {}) {
  const dayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const result = {};

  dayKeys.forEach(dayKey => {
    const raw = input?.[dayKey];

    if (!raw || typeof raw !== 'object') {
      result[dayKey] = {
        enabled: false,
        start: '',
        end: '',
      };
      return;
    }

    const start = String(raw.start || '').trim();
    const end = String(raw.end || '').trim();
    const startMinutes = parseHourMinuteToMinutes(start);
    const endMinutes = parseHourMinuteToMinutes(end);

    result[dayKey] = {
      enabled:
        raw.enabled === true &&
        startMinutes !== null &&
        endMinutes !== null &&
        startMinutes !== endMinutes,
      start:
        startMinutes !== null
          ? `${String(Math.floor(startMinutes / 60)).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`
          : '',
      end:
        endMinutes !== null
          ? `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`
          : '',
    };
  });

  return result;
}

function normalizeTemporaryAvailability(input = {}) {
  const start = String(input?.start || '').trim();
  const end = String(input?.end || '').trim();
  const date = String(input?.date || '').trim();
  const startMinutes = parseHourMinuteToMinutes(start);
  const endMinutes = parseHourMinuteToMinutes(end);

  return {
    enabled:
      input?.enabled === true &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      startMinutes !== null &&
      endMinutes !== null &&
      startMinutes !== endMinutes,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    start:
      startMinutes !== null
        ? `${String(Math.floor(startMinutes / 60)).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`
        : '',
    end:
      endMinutes !== null
        ? `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`
        : '',
  };
}

function isMinuteWithinAvailability(minutes, startMinutes, endMinutes) {
  if (
    !Number.isFinite(minutes) ||
    !Number.isFinite(startMinutes) ||
    !Number.isFinite(endMinutes) ||
    startMinutes === endMinutes
  ) {
    return false;
  }

  if (endMinutes > startMinutes) {
    return minutes >= startMinutes && minutes <= endMinutes;
  }

  // 支援跨午夜，例如 18:00～01:00。
  return minutes >= startMinutes || minutes <= endMinutes;
}

function riderHasConfiguredAvailability(rider = {}) {
  const schedule =
    rider.availabilitySchedule &&
    typeof rider.availabilitySchedule === 'object'
      ? rider.availabilitySchedule
      : {};

  // 一旦小U曾儲存「我的接單時段」，即使七天全部關閉，也代表明確設定為不接預約。
  const weeklyConfigured =
    Object.keys(schedule).some(key => {
      const day = schedule[key];

      return (
        day &&
        typeof day === 'object' &&
        (
          Object.prototype.hasOwnProperty.call(day, 'enabled') ||
          !!String(day.start || '').trim() ||
          !!String(day.end || '').trim()
        )
      );
    });

  const temporary =
    rider.temporaryAvailability;

  const temporaryConfigured =
    temporary &&
    typeof temporary === 'object' &&
    (
      Object.prototype.hasOwnProperty.call(
        temporary,
        'enabled'
      ) ||
      !!String(temporary.date || '').trim()
    );

  return weeklyConfigured || temporaryConfigured;
}

function doAvailabilityRangesOverlap(
  windowStartMinutes,
  windowEndMinutes,
  availableStartMinutes,
  availableEndMinutes
) {
  const ws = Number(windowStartMinutes);
  const we = Number(windowEndMinutes);
  const as = Number(availableStartMinutes);
  const ae = Number(availableEndMinutes);

  if (
    ![ws, we, as, ae].every(
      Number.isFinite
    )
  ) {
    return false;
  }

  const normalizeIntervals = (start, end) => {
    if (start === end) {
      return [[0, 1440]];
    }

    if (end > start) {
      return [[start, end]];
    }

    return [
      [start, 1440],
      [0, end],
    ];
  };

  const windowIntervals =
    normalizeIntervals(ws, we);

  const availableIntervals =
    normalizeIntervals(as, ae);

  return windowIntervals.some(
    ([windowStart, windowEnd]) =>
      availableIntervals.some(
        ([availableStart, availableEnd]) =>
          Math.max(
            windowStart,
            availableStart
          ) <
          Math.min(
            windowEnd,
            availableEnd
          )
      )
  );
}

function riderMatchesScheduledOrderAvailability(rider = {}, order = {}) {
  if (!isScheduledOrderTiming(order)) {
    return true;
  }

  const timingType =
    normalizeOrderTimingType(order.orderTimingType);

  if (
    timingType === UBEE_ORDER_TIMING_TYPES.SCHEDULED &&
    rider.acceptScheduledOrders === false
  ) {
    return false;
  }

  if (
    timingType === UBEE_ORDER_TIMING_TYPES.FLEXIBLE &&
    rider.acceptFlexibleOrders === false
  ) {
    return false;
  }

  // 尚未設定精細時段的小U仍可看到預約單，避免既有小U突然失去任務。
  if (!riderHasConfiguredAvailability(rider)) {
    return true;
  }

  const startMs =
    getScheduleTimestampMs(order.scheduledStartAtMs) ||
    getScheduleTimestampMs(order.requestedScheduleAtMs) ||
    getScheduleTimestampMs(order.desiredCompletionAtMs);

  if (!startMs) {
    return true;
  }

  const startTaipei =
    getTaipeiDateParts(startMs);

  if (!startTaipei) {
    return true;
  }

  const isFlexible =
    timingType ===
    UBEE_ORDER_TIMING_TYPES.FLEXIBLE;

  const endMs =
    isFlexible
      ? (
          getScheduleTimestampMs(
            order.scheduledEndAtMs
          ) ||
          getScheduleTimestampMs(
            order.flexibleEndAtMs
          )
        )
      : 0;

  const endTaipei =
    endMs
      ? getTaipeiDateParts(endMs)
      : null;

  const matchesAvailability = availability => {
    if (!availability?.enabled) {
      return false;
    }

    const availableStart =
      parseHourMinuteToMinutes(
        availability.start
      );

    const availableEnd =
      parseHourMinuteToMinutes(
        availability.end
      );

    if (!isFlexible || !endTaipei) {
      return isMinuteWithinAvailability(
        startTaipei.minutes,
        availableStart,
        availableEnd
      );
    }

    // 彈性預約採「時段有交集即可」，
    // 例如客人給 18:00～20:00，小U 19:00～22:00 仍可承接。
    if (
      startTaipei.date ===
      endTaipei.date
    ) {
      return doAvailabilityRangesOverlap(
        startTaipei.minutes,
        endTaipei.minutes,
        availableStart,
        availableEnd
      );
    }

    // 跨日彈性時段保守視為涵蓋當日起點到午夜，
    // 後續若開放多日預約再擴充為逐日比對。
    return doAvailabilityRangesOverlap(
      startTaipei.minutes,
      1440,
      availableStart,
      availableEnd
    );
  };

  const temporary =
    normalizeTemporaryAvailability(
      rider.temporaryAvailability || {}
    );

  if (
    temporary.enabled &&
    temporary.date === startTaipei.date &&
    matchesAvailability(temporary)
  ) {
    return true;
  }

  const weekly =
    normalizeRiderAvailabilitySchedule(
      rider.availabilitySchedule || {}
    );

  const day =
    weekly[startTaipei.dayKey];

  return matchesAvailability(day);
}

function formatScheduleLabelFromMs(startMs, endMs = 0, timingType = 'scheduled') {
  const start = getScheduleTimestampMs(startMs);
  const end = getScheduleTimestampMs(endMs);

  if (!start) {
    return '';
  }

  const dateFormatter = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const startText = dateFormatter.format(new Date(start));

  if (
    normalizeOrderTimingType(timingType) === UBEE_ORDER_TIMING_TYPES.FLEXIBLE &&
    end > start
  ) {
    const timeFormatter = new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    return `${startText}～${timeFormatter.format(new Date(end))}`;
  }

  return startText;
}

function buildOrderScheduleMetadata(data = {}, durationSeconds = 0) {
  const timingType =
    normalizeOrderTimingType(data.orderTimingType);

  if (timingType === UBEE_ORDER_TIMING_TYPES.IMMEDIATE) {
    return {
      orderTimingType: timingType,
      scheduleGoal: 'immediate',
      requestedScheduleAtMs: 0,
      desiredCompletionAtMs: 0,
      scheduledStartAtMs: 0,
      scheduledEndAtMs: 0,
      scheduleLabel: '立即任務',
      scheduleStatus: 'not_applicable',
      scheduleConfirmationRequired: false,
    };
  }

  const routeDurationMs =
    Math.max(0, Number(durationSeconds || 0)) * 1000;

  const handlingBufferMs = 15 * 60 * 1000;

  if (timingType === UBEE_ORDER_TIMING_TYPES.FLEXIBLE) {
    const startMs =
      getScheduleTimestampMs(data.flexibleStartAtMs);
    const endMs =
      getScheduleTimestampMs(data.flexibleEndAtMs);

    return {
      orderTimingType: timingType,
      scheduleGoal: 'time_window',
      requestedScheduleAtMs: startMs,
      desiredCompletionAtMs: 0,
      scheduledStartAtMs: startMs,
      scheduledEndAtMs: endMs,
      scheduleLabel:
        formatScheduleLabelFromMs(
          startMs,
          endMs,
          timingType
        ),
      scheduleStatus: 'awaiting_rider',
      scheduleConfirmationRequired: false,
      scheduleConfirmDueAtMs:
        Math.max(
          0,
          startMs - UBEE_SCHEDULE_CONFIRM_BEFORE_MS
        ),
    };
  }

  const goal =
    String(data.scheduleGoal || 'pickup_at')
      .trim()
      .toLowerCase() === 'complete_by'
      ? 'complete_by'
      : 'pickup_at';

  const requestedMs =
    getScheduleTimestampMs(data.requestedScheduleAtMs);

  const plannedStartMs =
    goal === 'complete_by'
      ? Math.max(
          Date.now(),
          requestedMs -
            routeDurationMs -
            handlingBufferMs
        )
      : requestedMs;

  const plannedEndMs =
    goal === 'complete_by'
      ? requestedMs
      : plannedStartMs +
        Math.max(
          60 * 60 * 1000,
          routeDurationMs + handlingBufferMs
        );

  return {
    orderTimingType: timingType,
    scheduleGoal: goal,
    requestedScheduleAtMs: requestedMs,
    desiredCompletionAtMs:
      goal === 'complete_by'
        ? requestedMs
        : 0,
    scheduledStartAtMs: plannedStartMs,
    scheduledEndAtMs: plannedEndMs,
    scheduleLabel:
      formatScheduleLabelFromMs(
        requestedMs,
        0,
        timingType
      ),
    scheduleStatus: 'awaiting_rider',
    scheduleConfirmationRequired: false,
    scheduleConfirmDueAtMs:
      Math.max(
        0,
        plannedStartMs -
          UBEE_SCHEDULE_CONFIRM_BEFORE_MS
      ),
  };
}

async function sendNewOrderPushToRiders(
  order,
  maxRadiusKm = null,
  options = {}
) {
  try {
    const orderId =
      order.id ||
      order.orderId ||
      "";

    if (!orderId) {
      return;
    }

    const fee =
      order.driverFee ||
      order.riderFee ||
      "未設定";

    const pickup =
      order.pickupAddress ||
      order.fromAddress ||
      order.pickup ||
      "附近取件地";

    const dropoff =
      order.dropoffAddress ||
      order.toAddress ||
      order.dropoff ||
      "送達地未提供";

    const isRedispatch =
      Number(order.transferCount || 0) > 0 ||
      !!order.transferredAt ||
      !!order.redispatchStartedAtMs;

    const isScheduledTask =
      isScheduledOrderTiming(order);

    const scheduleLabel =
      String(
        order.scheduleLabel ||
        formatScheduleLabelFromMs(
          order.scheduledStartAtMs ||
          order.requestedScheduleAtMs,
          order.scheduledEndAtMs,
          order.orderTimingType
        ) ||
        ''
      ).trim();

    const skippedRiderIds = new Set(
      (
        Array.isArray(order.skippedRiderIds)
          ? order.skippedRiderIds
          : []
      )
        .map(value =>
          String(value || "").trim()
        )
        .filter(Boolean)
    );

        const normalizedMaxRadiusKm =
      Number(maxRadiusKm);

    const hasRadiusLimit =
      Number.isFinite(normalizedMaxRadiusKm) &&
      normalizedMaxRadiusKm > 0 &&
      normalizedMaxRadiusKm < 999;

    const pickupPoint =
      getOrderPickupPointForPush(order);

    const pushRadiusLabel =
      hasRadiusLimit
        ? `${normalizedMaxRadiusKm}km`
        : "全區";

        const safeOptions =
      options &&
      typeof options === "object"
        ? options
        : {};

    const excludedRiderDocIds =
      new Set(
        (
          Array.isArray(
            safeOptions.excludedRiderDocIds
          )
            ? safeOptions.excludedRiderDocIds
            : []
        )
          .map(value =>
            String(value || "").trim()
          )
          .filter(Boolean)
      );


    const notifiedRiderDocIds = [];
    

    if (
      hasRadiusLimit &&
      !pickupPoint
    ) {
      console.warn(
        `⚠️ UBee 距離派單無法取得取件座標，orderId=${orderId}，radius=${normalizedMaxRadiusKm}km`
      );
    }
    
    // ==============================
    // 1. iPhone / PWA Web Push 派單通知
    // ==============================
    try {
      if (
        !WEB_PUSH_PUBLIC_KEY ||
        !WEB_PUSH_PRIVATE_KEY
      ) {
        console.warn(
          "⚠️ Web Push VAPID 尚未設定，略過 iPhone Web Push 派單通知"
        );

      } else {
        const ridersSnap = await db
          .collection("riders")
          .limit(300)
          .get();

        let webPushSuccess = 0;
        let webPushFail = 0;
        let skippedRiderCount = 0;
        let distanceFilteredRiderCount = 0;
        let staleLocationRiderCount = 0;
        
        const pushPayload = JSON.stringify({
          title:
            isScheduledTask
              ? "UBee 預約任務"
              : isRedispatch
                ? "UBee 轉派任務"
                : "UBee 新任務",

          body:
`${isScheduledTask
  ? `有新的預約任務等待承接${scheduleLabel ? `\n時間：${scheduleLabel}` : ""}`
  : isRedispatch
    ? "有一張任務重新開放接單"
    : "有新的跑腿任務等待接單"}

取件：${pickup}
送達：${dropoff}
騎士收入：$${fee}`,

          url: `/rider.html?orderId=${encodeURIComponent(orderId)}&tab=task&source=push`,
          deepLink: `/rider.html?orderId=${encodeURIComponent(orderId)}&tab=task&source=push`,
          orderId
        });

        const pushTasks = [];

        ridersSnap.forEach((riderDoc) => {
          const rider =
            riderDoc.data() || {};

          const riderApproved =
            rider.approved === true ||
            rider.status === "approved" ||
            rider.status === "active";

          const riderDispatchEligible =
            canRiderAcceptOrdersV4(rider) &&
            riderMeetsOrderV4Requirements(rider, order);

          const riderOnline =
            rider.online === true;

          const webPushEnabled =
            rider.webPushEnabled === true;

          const subscription =
            rider.webPushSubscription;

          const riderIdentityKeys = [
            riderDoc.id,
            rider.riderId,
            normalizePhone(
              rider.phone ||
              rider.mobile ||
              ""
            ),
            rider.lineUserId
          ]
            .map(value =>
              String(value || "").trim()
            )
            .filter(Boolean);

          const riderAlreadySkipped =
            riderIdentityKeys.some(
              key => skippedRiderIds.has(key)
            );

          if (riderAlreadySkipped) {
            skippedRiderCount += 1;
            return;
          }

                    const riderDocId =
            String(
              riderDoc.id || ""
            ).trim();

          if (
            riderDocId &&
            excludedRiderDocIds.has(
              riderDocId
            )
          ) {
            return;
          }
          
          const allowOffline =
            safeOptions.allowOffline === true;

          if (
            !riderApproved ||
            !riderDispatchEligible ||
            (!riderOnline && !allowOffline) ||
            !webPushEnabled ||
            !subscription ||
            !subscription.endpoint
          ) {
            return;
          }

          if (
            isScheduledTask &&
            !riderMatchesScheduledOrderAvailability(
              rider,
              order
            )
          ) {
            return;
          }

                    if (hasRadiusLimit) {
            if (!pickupPoint) {
              distanceFilteredRiderCount += 1;
              return;
            }

            const riderPoint =
              getRiderCurrentPointForPush(rider);

            const riderLocationFresh =
              isRiderLocationFreshForPush(rider);

            if (
              !riderPoint ||
              !riderLocationFresh
            ) {
              staleLocationRiderCount += 1;
              return;
            }

            const distanceKm =
              calcDispatchPushDistanceKm(
                riderPoint.lat,
                riderPoint.lng,
                pickupPoint.lat,
                pickupPoint.lng
              );

            if (
              !Number.isFinite(distanceKm) ||
              distanceKm > normalizedMaxRadiusKm
            ) {
              distanceFilteredRiderCount += 1;
              return;
            }
          }
          
          pushTasks.push(
            webpush
              .sendNotification(
                subscription,
                pushPayload
              )
              .then(() => {
                webPushSuccess += 1;

                if (riderDocId) {
                  notifiedRiderDocIds.push(
                    riderDocId
                  );
                }

                const dispatchRiderId = String(
                  rider.riderId || riderDocId || riderDoc.id || ''
                ).trim();
                Promise.allSettled([
                  logDispatchEvent({
                    type:'RIDER_NOTIFIED',
                    orderId,
                    riderId:dispatchRiderId,
                    riderDocId:riderDocId || riderDoc.id || '',
                    radiusKm:normalizedMaxRadiusKm,
                    dispatchStage:pushRadiusLabel,
                    createdAtMs:Date.now(),
                  }),
                  updateRiderDispatchStats(dispatchRiderId, { receivedOrders:1 }),
                ]).catch(()=>{});
              })
              .catch(async (pushErr) => {
                webPushFail += 1;

                console.error(
                  `UBee Web Push 發送失敗 rider=${riderDoc.id}:`,
                  pushErr &&
                  pushErr.message
                    ? pushErr.message
                    : pushErr
                );

                const statusCode =
                  Number(
                    pushErr &&
                    pushErr.statusCode
                  );

                // 404 / 410 代表這支手機的訂閱已失效，
                // 直接關閉避免之後一直失敗
                if (
                  statusCode === 404 ||
                  statusCode === 410
                ) {
                  await db
                    .collection("riders")
                    .doc(riderDoc.id)
                    .set(
                      {
                        webPushSubscription:
                          admin.firestore.FieldValue.delete(),

                        webPushEnabled: false,

                        webPushUpdatedAt:
                          admin.firestore.FieldValue.serverTimestamp(),

                        webPushError:
                          `expired_subscription_${statusCode}`
                      },
                      {
                        merge: true
                      }
                    );
                }
              })
          );
        });

        await Promise.all(pushTasks);

                console.log(
          `UBee Web Push ${
            isRedispatch
              ? "轉派"
              : "新任務"
          }通知完成：${orderId}，範圍 ${pushRadiusLabel}，成功 ${webPushSuccess}，失敗 ${webPushFail}，略過已取消騎士 ${skippedRiderCount}，距離外 ${distanceFilteredRiderCount}，位置過期或缺失 ${staleLocationRiderCount}`
        );
      }

    } catch (webPushErr) {
      console.error(
        "UBee Web Push 新任務通知失敗:",
        webPushErr
      );
    }

    // UBee 規則：派單／重新轉派只通知小U端，不推送「任務重新轉派」到審核／管理群。
    // 保留重新開放接單、擴圈派單、Web Push 與調度邏輯。
    return {
      success: true,
      orderId,
      notifiedRiderDocIds:
        Array.from(
          new Set(
            notifiedRiderDocIds
          )
        ),
    };

  } catch (err) {
    console.error(
      "UBee 新任務通知失敗:",
      err
    );

    return {
      success: false,

      orderId:
        String(
          order?.id ||
          order?.orderId ||
          ""
        ).trim(),

      notifiedRiderDocIds: [],

      error:
        err &&
        err.message
          ? err.message
          : String(err || ""),
    };
  }
}

// =====================================================
// UBee 多層級距離擴圈派單
//
// 第 0 秒：3 公里
// 第 5 秒：5 公里
// 第 10 秒：8 公里
// 第 15 秒：10 公里
// 第 20 秒：12 公里
// 第 25 秒：15 公里
// 第 30 秒：17 公里
// 第 35 秒：20 公里
// 第 40 秒：全區
//
// 同一輪派單中：
// 1. 已通知過的小U不重複通知。
// 2. 訂單被接走、取消或完成後，停止後續擴圈。
// 3. 使用 dispatchPushCycleId 避免舊計時器干擾新週期。
// 4. 任務通知永遠只走小U端／Web Push，不送進審核群組。
// =====================================================

const DISPATCH_PUSH_WAVES = [
  { delayMs: 0, radiusKm: 3, stage: "3km" },
  { delayMs: 5000, radiusKm: 5, stage: "5km" },
  { delayMs: 10000, radiusKm: 8, stage: "8km" },
  { delayMs: 15000, radiusKm: 10, stage: "10km" },
  { delayMs: 20000, radiusKm: 12, stage: "12km" },
  { delayMs: 25000, radiusKm: 15, stage: "15km" },
  { delayMs: 30000, radiusKm: 17, stage: "17km" },
  { delayMs: 35000, radiusKm: 20, stage: "20km" },
  { delayMs: 40000, radiusKm: null, stage: "all" },
];

// 一輪派單跑完全區後，等待 60 秒再重新跑下一輪
const DISPATCH_PUSH_RESTART_DELAY_MS =
  60000;

// 第一輪完成後，後續重新派單是否直接通知全區
const DISPATCH_PUSH_REPEAT_ALL_ONLY =
  true;

const dispatchPushTimers = new Map();


function buildDispatchPushCycleId(orderId) {
  const safeOrderId =
    String(orderId || "")
      .trim()
      .toUpperCase();

  return (
    `${safeOrderId}_` +
    `${Date.now()}_` +
    `${Math.random()
      .toString(36)
      .slice(2, 8)}`
  );
}


function clearDispatchPushTimers(orderId) {
  const safeOrderId =
    String(orderId || "")
      .trim()
      .toUpperCase();

  if (!safeOrderId) {
    return;
  }

  const timers =
    dispatchPushTimers.get(
      safeOrderId
    );

  if (Array.isArray(timers)) {
    timers.forEach(timer => {
      clearTimeout(timer);
    });
  }

  dispatchPushTimers.delete(
    safeOrderId
  );
}


function getDispatchWaveTimestampField(stage) {
  const safeStage =
    String(stage || "")
      .trim()
      .toLowerCase();

  if (safeStage === "all") {
    return "dispatchPushAllAt";
  }

  const radiusMatch =
    safeStage.match(/^(\d+)km$/);

  if (!radiusMatch) {
    return "";
  }

  return (
    `dispatchPush${radiusMatch[1]}kmAt`
  );
}


async function runDispatchPushWave(
  orderId,
  cycleId,
  maxRadiusKm,
  stage
) {
  const safeOrderId =
    String(orderId || "")
      .trim()
      .toUpperCase();

  const safeCycleId =
    String(cycleId || "")
      .trim();

  const safeStage =
    String(stage || "")
      .trim()
      .toLowerCase();

  if (
    !safeOrderId ||
    !safeCycleId ||
    !safeStage
  ) {
    return false;
  }

  const orderRef =
    db.collection("orders")
      .doc(safeOrderId);

  const orderDoc =
    await orderRef.get();

  if (!orderDoc.exists) {
    clearDispatchPushTimers(
      safeOrderId
    );

    return false;
  }

  const order = {
    id: orderDoc.id,
    ...orderDoc.data(),
  };

  // 訂單已被接單、取消或完成，停止所有後續擴圈。
  if (
    String(order.status || "")
      .trim() !== "pending_dispatch"
  ) {
    clearDispatchPushTimers(
      safeOrderId
    );

    return false;
  }

  // 防止上一輪派單的舊計時器誤觸新週期。
  if (
    String(
      order.dispatchPushCycleId || ""
    ).trim() !== safeCycleId
  ) {
    return false;
  }

  const alreadyNotified =
    Array.isArray(
      order.dispatchPushNotifiedRiderDocIds
    )
      ? order
          .dispatchPushNotifiedRiderDocIds
          .map(value =>
            String(value || "").trim()
          )
          .filter(Boolean)
      : [];

  const pushResult =
    await sendNewOrderPushToRiders(
      order,
      maxRadiusKm,
      {
        excludedRiderDocIds:
          alreadyNotified,
      }
    );

  const newlyNotified =
    Array.isArray(
      pushResult?.notifiedRiderDocIds
    )
      ? pushResult
          .notifiedRiderDocIds
          .map(value =>
            String(value || "").trim()
          )
          .filter(Boolean)
      : [];

  // 推播執行期間可能剛好有人接單，
  // 寫入階段資料前再次確認訂單狀態。
  const latestOrderDoc =
    await orderRef.get();

  if (!latestOrderDoc.exists) {
    clearDispatchPushTimers(
      safeOrderId
    );

    return false;
  }

  const latestOrder =
    latestOrderDoc.data() || {};

  if (
    String(
      latestOrder.status || ""
    ).trim() !== "pending_dispatch"
  ) {
    clearDispatchPushTimers(
      safeOrderId
    );

    return false;
  }

  if (
    String(
      latestOrder.dispatchPushCycleId || ""
    ).trim() !== safeCycleId
  ) {
    return false;
  }

  const nowMs = Date.now();

  const updateData = {
    dispatchPushStage:
      safeStage,

    dispatchPushLastRadiusKm:
      maxRadiusKm === null
        ? 999
        : Number(maxRadiusKm),

    dispatchPushLastRunAtMs:
      nowMs,

    dispatchPushLastRunAt:
      admin.firestore.FieldValue
        .serverTimestamp(),
  };

  const timestampField =
    getDispatchWaveTimestampField(
      safeStage
    );

  if (timestampField) {
    updateData[timestampField] =
      admin.firestore.FieldValue
        .serverTimestamp();
  }

  if (newlyNotified.length) {
    updateData
      .dispatchPushNotifiedRiderDocIds =
        admin.firestore.FieldValue
          .arrayUnion(
            ...newlyNotified
          );
  }

  await orderRef.update(
    updateData
  );

  console.log(
    `UBee 分段派單完成：` +
    `${safeOrderId}，` +
    `階段 ${safeStage}，` +
    `本次新通知 ${newlyNotified.length} 位小U`
  );
  return true;
}

function scheduleNextDispatchPushRound(
  orderId
) {
  const safeOrderId =
    String(orderId || "")
      .trim()
      .toUpperCase();

  if (!safeOrderId) {
    return;
  }

  const restartTimer =
    setTimeout(async () => {
      try {
        const orderRef =
          db.collection("orders")
            .doc(safeOrderId);

        const orderDoc =
          await orderRef.get();

        if (!orderDoc.exists) {
          clearDispatchPushTimers(
            safeOrderId
          );
          return;
        }

        const order = {
          id: orderDoc.id,
          ...orderDoc.data(),
        };

        // 只有仍然等待派單，才重新開始
        if (
          String(order.status || "")
            .trim() !==
          "pending_dispatch"
        ) {
          clearDispatchPushTimers(
            safeOrderId
          );
          return;
        }

        console.log(
          `🔁 UBee 開始新一輪派單：${safeOrderId}`
        );

        const newCycleId =
  buildDispatchPushCycleId(
    safeOrderId
  );

if (DISPATCH_PUSH_REPEAT_ALL_ONLY) {
  await startDispatchPushAllOnlyRound(
    {
      id: safeOrderId,
    },
    newCycleId
  );
} else {
  await startDispatchPushSequence(
    {
      id: safeOrderId,
    },
    newCycleId
  );
}

      } catch (error) {
        console.error(
          "重新派單失敗：",
          error
        );
      }

    }, DISPATCH_PUSH_RESTART_DELAY_MS);

  const existingTimers =
  dispatchPushTimers.get(
    safeOrderId
  );

if (Array.isArray(existingTimers)) {
  existingTimers.push(
    restartTimer
  );

  dispatchPushTimers.set(
    safeOrderId,
    existingTimers
  );
} else {
  dispatchPushTimers.set(
    safeOrderId,
    [restartTimer]
  );
}

// 結束 scheduleNextDispatchPushRound
}

function scheduleDispatchPushWave(
  orderId,
  cycleId,
  waveIndex,
  startedAtMs
) {
  const safeOrderId =
    String(orderId || "")
      .trim()
      .toUpperCase();

  const safeCycleId =
    String(cycleId || "")
      .trim();

  const wave =
    DISPATCH_PUSH_WAVES[waveIndex];

  if (
    !safeOrderId ||
    !safeCycleId ||
    !wave
  ) {
    return;
  }

  const elapsedMs =
    Date.now() - startedAtMs;

  const remainingDelayMs =
    Math.max(
      0,
      Number(wave.delayMs || 0) -
        elapsedMs
    );

  const timer =
    setTimeout(async () => {
      try {
        const waveCompleted =
          await runDispatchPushWave(
            safeOrderId,
            safeCycleId,
            wave.radiusKm,
            wave.stage
          );

        if (!waveCompleted) {
          return;
        }

        const nextWaveIndex =
          waveIndex + 1;

        if (
  nextWaveIndex <
  DISPATCH_PUSH_WAVES.length
) {
  scheduleDispatchPushWave(
    safeOrderId,
    safeCycleId,
    nextWaveIndex,
    startedAtMs
  );
} else {
  // 全部距離波次已完成。
  // 如果訂單仍無人接，等待設定時間後重新跑下一輪。
  scheduleNextDispatchPushRound(
    safeOrderId
  );
}
      } catch (error) {
        console.error(
          `❌ UBee ${wave.stage} 派單失敗：${safeOrderId}`,
          error
        );
      }
    }, remainingDelayMs);

  const existingTimers =
    dispatchPushTimers.get(
      safeOrderId
    );

  if (Array.isArray(existingTimers)) {
    existingTimers.push(timer);

    dispatchPushTimers.set(
      safeOrderId,
      existingTimers
    );
  } else {
    dispatchPushTimers.set(
      safeOrderId,
      [timer]
    );
  }
}

async function startDispatchPushAllOnlyRound(
  order,
  existingCycleId = ""
) {
  const safeOrderId =
    String(
      order?.id ||
      order?.orderId ||
      ""
    )
      .trim()
      .toUpperCase();

  if (!safeOrderId) {
    throw new Error(
      "DISPATCH_ORDER_ID_MISSING"
    );
  }

  clearDispatchPushTimers(
    safeOrderId
  );

  const cycleId =
    String(
      existingCycleId ||
      buildDispatchPushCycleId(
        safeOrderId
      )
    ).trim();

  const startedAtMs =
    Date.now();

  const orderRef =
    db.collection("orders")
      .doc(safeOrderId);

  const orderDoc =
    await orderRef.get();

  if (!orderDoc.exists) {
    throw new Error(
      "DISPATCH_ORDER_NOT_FOUND"
    );
  }

  const currentOrder =
    orderDoc.data() || {};

  if (
    String(
      currentOrder.status || ""
    ).trim() !== "pending_dispatch"
  ) {
    clearDispatchPushTimers(
      safeOrderId
    );

    return cycleId;
  }

  await orderRef.set(
    {
      dispatchPushCycleId:
        cycleId,

      dispatchPushNotifiedRiderDocIds:
        [],

      dispatchPushStage:
        "repeat_all_scheduled",

      dispatchPushStartedAtMs:
        startedAtMs,

      dispatchPushStartedAt:
        admin.firestore.FieldValue
          .serverTimestamp(),

      dispatchStartedAtMs:
        startedAtMs,

      dispatchPushAllAt:
        null,
    },
    {
      merge: true,
    }
  );

  console.log(
    `✅ UBee 後續全區派單已啟動：` +
    `${safeOrderId}，` +
    `週期 ${cycleId}`
  );

  const allWaveCompleted =
    await runDispatchPushWave(
      safeOrderId,
      cycleId,
      null,
      "all",
      false
    );

  if (allWaveCompleted) {
    scheduleNextDispatchPushRound(
      safeOrderId
    );
  }

  return cycleId;
}
  
async function startDispatchPushSequence(
  order,
  existingCycleId = ""
) {
  const safeOrderId =
    String(
      order?.id ||
      order?.orderId ||
      ""
    )
      .trim()
      .toUpperCase();

  if (!safeOrderId) {
    throw new Error(
      "DISPATCH_ORDER_ID_MISSING"
    );
  }

  clearDispatchPushTimers(
    safeOrderId
  );

  const cycleId =
    String(
      existingCycleId ||
      order?.dispatchPushCycleId ||
      buildDispatchPushCycleId(
        safeOrderId
      )
    ).trim();

  const startedAtMs =
    Date.now();

  const orderRef =
    db.collection("orders")
      .doc(safeOrderId);

  await orderRef.set(
    {
      dispatchPushCycleId:
        cycleId,

      dispatchPushNotifiedRiderDocIds:
        [],

      dispatchPushStage:
        "scheduled",

      dispatchPushStartedAtMs:
        startedAtMs,

      dispatchPushStartedAt:
        admin.firestore.FieldValue
          .serverTimestamp(),

      dispatchStartedAtMs:
        startedAtMs,

      dispatchPush3kmAt:
        null,

      dispatchPush5kmAt:
        null,

      dispatchPush8kmAt:
        null,

      dispatchPush10kmAt:
        null,

      dispatchPush12kmAt:
        null,

      dispatchPush15kmAt:
        null,

      dispatchPush17kmAt:
        null,

      dispatchPush20kmAt:
        null,

      dispatchPushAllAt:
        null,
    },
    {
      merge: true,
    }
  );

  order.dispatchPushCycleId =
    cycleId;

  order.dispatchPushNotifiedRiderDocIds =
    [];

  order.dispatchStartedAtMs =
    startedAtMs;

  // 從第一波 3 公里開始。
  // 第一波完成後，才依序建立下一波，
  // 避免多個距離波次同時執行。
  scheduleDispatchPushWave(
    safeOrderId,
    cycleId,
    0,
    startedAtMs
  );

  console.log(
    `✅ UBee 多層級派單已啟動：` +
    `${safeOrderId}，` +
    `週期 ${cycleId}`
  );

  return cycleId;
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
  RIDER_WEB_URL;

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


// UBee 小U資料庫 V2：使用 multipart/form-data 上傳單一證件。
// 欄位名稱固定為 file；其他欄位為 phone、lineUserId、documentType。
app.post('/api/rider/documents/upload', (req, res) => {
  riderDocumentUpload.single('file')(req, res, error => {
    if (error) {
      const isSizeError =
        error instanceof multer.MulterError &&
        error.code === 'LIMIT_FILE_SIZE';

      const isTypeError =
        String(error.message || '') ===
        'RIDER_DOCUMENT_UNSUPPORTED_TYPE';

      return res.status(isSizeError ? 413 : 415).json({
        success: false,
        message: isSizeError
          ? '單一證件檔案不可超過 6 MB。'
          : isTypeError
            ? '證件檔案只支援 JPG、PNG、WEBP 或 HEIC。'
            : '證件檔案格式不正確，請重新選擇。',
      });
    }

    return handleRiderDocumentUpload(req, res);
  });
});

app.get('/api/rider/application-v2/config', (req, res) => {
  return res.json({
    success: true,
    dataVersion: RIDER_V2_DATA_VERSION,
    applicationRound: RIDER_V2_APPLICATION_ROUND,
    applicationCollection: RIDER_V2_COLLECTIONS.applications,
    requiredDocuments: Object.keys(RIDER_REQUIRED_DOCUMENTS).map(key => ({
      key,
      type: RIDER_REQUIRED_DOCUMENTS[key],
      label: RIDER_DOCUMENT_LABELS[key],
      required: true,
    })),
    allowedMimeTypes: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
    ],
    maxFileSizeBytes: RIDER_DOCUMENT_MAX_BYTES,
  });
});

// UBee 第五階段：證據檔案採 raw body，上傳路由必須放在 express.json() 前。
app.post(
  '/api/support/evidence/upload',
  express.raw({ type: '*/*', limit: '8mb' }),
  handleSupportEvidenceUpload
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==============================
// UBee 騎士手機登入 API
// 第一階段：只允許 Firebase riders/{手機號碼} 且審核通過的騎士登入
// ==============================

// =====================================================
// UBee 小U營運管理系統 V4：生命週期 / 教育 / 資格 / 治理
// =====================================================
const RIDER_V4_LIFECYCLE = Object.freeze({
  APPLICANT: 'APPLICANT',
  UNDER_REVIEW: 'UNDER_REVIEW',
  TRAINING: 'TRAINING',
  ACTIVE: 'ACTIVE',
  RETRAINING: 'RETRAINING',
  RESTRICTED: 'RESTRICTED',
  SUSPENDED: 'SUSPENDED',
  BANNED: 'BANNED',
  REJECTED: 'REJECTED',
});

const RIDER_V4_REQUIRED_MODULES = Object.freeze([
  'platform_rules',
  'pre_accept_check',
  'task_flow',
  'pickup_handover',
  'customer_communication',
  'purchase_advance',
  'finance_jkopay',
  'fraud_prevention',
  'incident_handling',
  'location_privacy',
  'fragile_special_items',
  'professional_service',
]);

const RIDER_V4_CERTIFICATIONS = Object.freeze([
  'basic',
  'high_value_advance',
  'cake_flower',
  'car_delivery',
  'business_documents',
  'multi_stop',
]);

const RIDER_V4_QUIZ = Object.freeze([
  {
    id:"q1",
    question:"你目前在北區，看到一張高報酬任務：取件在西屯、送達在太平，備註還要求 25 分鐘內完成。你最正確的接單判斷是？",
    options:[
      "先接單鎖住任務，再邊騎邊研究路線",
      "只要報酬夠高就接，時間不足再請客人等",
      "先評估自己到取件地、取件後到送達地的完整路程、交通狀況與任務要求，確認能安全完成再接",
      "先問其他小U願不願意幫忙，願意就用自己的帳號接下來"
    ],
    answer:2
  },
  {
    id:"q2",
    question:"你已接單，途中機車突然故障，預估至少 40 分鐘無法繼續。下列哪個處理順序最正確？",
    options:[
      "先把 App 關掉，等車修好再重新上線",
      "立即確保自身與車輛安全，保留任務現況並回報 UBee，由平台依流程調度，不自行把任務交給別人",
      "直接打給朋友請他代送，只要客人沒發現就可以",
      "先按完成避免逾時，再慢慢處理商品"
    ],
    answer:1
  },
  {
    id:"q3",
    question:"你距離取件點還有 800 公尺，但店家打電話說餐點已備妥，希望你先按『抵達』讓系統不要催。你應該怎麼做？",
    options:[
      "配合店家先按抵達，反正很快就到了",
      "只有實際抵達後才更新抵達狀態，系統操作必須與真實進度一致",
      "先按取件完成，比按抵達更省時間",
      "只要店家同意，任何任務狀態都可以提前操作"
    ],
    answer:1
  },
  {
    id:"q4",
    question:"取件時，系統顯示 3 件商品，但店家只交 2 件，並說『另一件客人應該不會在意，你先送』。最佳處理是？",
    options:[
      "先送，缺件由客人自己跟店家處理",
      "自行買一件相近商品補上，不必通知平台",
      "先核對缺少的品項，保留現場資訊並依流程確認／回報，在未釐清前不把不完整訂單當成正常取件",
      "把訂單改成 2 件後直接完成取件"
    ],
    answer:2
  },
  {
    id:"q5",
    question:"取件後客人私訊：『送達地址改到另一區，我多給你 100 元，不要跟平台說。』哪個做法符合規範？",
    options:[
      "接受，因為客人願意補錢",
      "只要新地址距離更近就可以私下改",
      "先依 UBee 流程回報地址變更，確認可行性、費用與系統資訊後再執行，不私下收取未核准費用",
      "直接取消任務，不需要回報理由"
    ],
    answer:2
  },
  {
    id:"q6",
    question:"代買指定品牌的無糖豆漿缺貨，店員推薦另一品牌，價格相同。客人暫時聯絡不上。最適當做法是？",
    options:[
      "價格相同就直接換品牌",
      "選更貴的品牌，品質比較有保障",
      "依客戶事前授權或平台流程處理；沒有替代授權時，不自行把『相似』當成『可以替代』",
      "買兩種回去讓客人自己選"
    ],
    answer:2
  },
  {
    id:"q7",
    question:"一張任務要求代墊 9,800 元，報酬很高，但你沒有高額代墊資格，也無法確認商品用途。你應怎麼判斷？",
    options:[
      "只要自己有錢就能接",
      "先接單再詢問，避免被別人搶走",
      "高報酬代表平台已確認安全，所以不用查",
      "不要繞過資格限制；先確認任務合法性、代墊條件與自身資格，無法確認時不應勉強承接"
    ],
    answer:3
  },
  {
    id:"q8",
    question:"代買完成後，實際商品金額比預估高 420 元。客人說『沒關係你先刷，之後再算』。最完整的正確做法是？",
    options:[
      "直接付款，客人口頭同意就足夠",
      "先確認超額金額是否在授權範圍並依平台流程留存確認，再付款並保留完整憑證",
      "先把收據丟掉，避免個資外洩",
      "自行吸收差額，任務會比較快"
    ],
    answer:1
  },
  {
    id:"q9",
    question:"現金任務完成後，你收到客人 1,250 元，而騎士端顯示其中包含平台應收與你的任務收入。哪個觀念正確？",
    options:[
      "收到手上的現金全部都是小U收入",
      "只要當天有其他線上支付訂單，就可以自行互相抵銷",
      "應依系統財務明細區分小U收入、平台款項與其他項目，不能憑印象自行計算",
      "先把現金全部花掉，月底再看平台通知"
    ],
    answer:2
  },
  {
    id:"q10",
    question:"你已用街口支付回繳平台款項，但財務中心尚未顯示銷帳。下列哪個做法最正確？",
    options:[
      "保留付款／交易證明，等待財務核對；若長時間未更新，再依正式管道回報",
      "立刻再繳一次相同金額，避免被停權",
      "刪除付款紀錄，避免手機容量不足",
      "自行把下次應回繳金額扣掉，不需告知平台"
    ],
    answer:0
  },
  {
    id:"q11",
    question:"下列哪一組最符合 UBee 平台款項回繳與社群入職資訊？",
    options:[
      "街口支付代碼 901871793；指定公告、聊天、回報三個社群均屬必要入職項目",
      "街口支付代碼 1234；只需加入聊天群",
      "直接匯給其他小U；加入任一社群即可",
      "現金交給店家；完全不需要加入社群"
    ],
    answer:0
  },
  {
    id:"q12",
    question:"你在社群看到有人貼『客人地址＋電話＋訂單截圖』詢問誰認識這位客人。即使目的是協助任務，最正確原則是？",
    options:[
      "只要是小U社群就能完整公開個資",
      "客人已下單，代表同意資料被所有小U使用",
      "任務資訊只能在完成任務所必要的範圍使用；應避免在非必要範圍公開或轉傳個資，改走正式回報管道",
      "把電話遮掉就能公開完整門牌與姓名"
    ],
    answer:2
  },
  {
    id:"q13",
    question:"陌生客戶要求你先替他購買高價點數卡，並傳來截圖說『UBee 客服已核准，不用再確認』。你應如何處理？",
    options:[
      "截圖看起來像官方就直接買",
      "先少量購買測試是否能報帳",
      "停止自行付款，透過 UBee 正式流程重新驗證任務與指示；可疑截圖不能取代正式確認",
      "請客戶把金額拆成多筆就比較安全"
    ],
    answer:2
  },
  {
    id:"q14",
    question:"配送途中發生擦撞，你人有受傷，商品外盒也破損。下列哪個優先順序最合理？",
    options:[
      "先把商品送完，再處理傷勢與事故",
      "先確保人身與現場安全，必要時報警／就醫；再保留事故與商品證據並回報 UBee，不為了結束畫面而假完成",
      "先按完成，避免客人看到延誤",
      "直接答應客人賠償所有損失，再通知平台"
    ],
    answer:1
  },
  {
    id:"q15",
    question:"客人要求你把包裹放在大樓一樓無人看管處，但原訂單要求『本人簽收』，客人只用電話口頭說『放著就好』。最佳做法是？",
    options:[
      "只要電話中說過就直接放，不需留下任何紀錄",
      "確認交付要求是否允許變更，依平台／任務流程留下必要的授權與完成證明後再處理",
      "把包裹交給任何路過住戶即可",
      "先按完成，再決定包裹放哪裡"
    ],
    answer:1
  },
  {
    id:"q16",
    question:"你正在執行任務，但為了省電把定位關閉，之後又使用模擬定位讓系統看起來仍在移動。這主要違反哪個核心原則？",
    options:[
      "只違反手機省電建議，與平台無關",
      "只要最後有送到就不算問題",
      "任務定位與狀態必須真實；假定位會破壞派單、追蹤、ETA、調度與安全紀錄",
      "只有客人提出申訴才算違規"
    ],
    answer:2
  },
  {
    id:"q17",
    question:"你要配送雙層鮮奶油蛋糕，機車後箱無法保持水平，店家仍說『慢慢騎就好』。你最專業的判斷是？",
    options:[
      "只要綁緊就一定可以用機車載",
      "評估尺寸、固定、溫度與傾倒風險；若車輛條件無法安全承載，就不應勉強，應回報並改用合適方式",
      "把蛋糕橫放，速度慢就不會壞",
      "先接下來，損壞再談賠償"
    ],
    answer:1
  },
  {
    id:"q18",
    question:"任務完成後，客人覺得你服務很好，私訊希望『以後直接找你，不走 UBee，我多給你一點』。正確做法是？",
    options:[
      "只要不是當天的任務就可以私接",
      "客人主動提出就不算私接",
      "不得利用平台任務取得的客戶關係繞過平台私接或私下議價，應維持平台正式流程",
      "可以先加 LINE，但暫時不要收錢"
    ],
    answer:2
  },
  {
    id:"q19",
    question:"哪一種情況最符合『可以按完成』的標準？",
    options:[
      "已到大樓樓下，但客人還沒下來",
      "商品已交付給正確對象或依核准方式完成放置，必要核對／證明已完成，款項與任務狀態也與實際一致",
      "導航顯示距離目的地只剩 100 公尺",
      "客人說等等會自己下樓拿，所以可以先完成"
    ],
    answer:1
  },
  {
    id:"q20",
    question:"一位新小U已審核通過、也加入聊天群，20 題測驗拿到 85 分，但只完成 10／12 堂核心教學，街口與另外兩個指定社群也尚未完成。系統應如何判定？",
    options:[
      "因為測驗超過 80 分，所以立即開通完整資格",
      "因為審核已通過，所以可先接單，其他項目日後補",
      "仍未完成完整入職／L4學習條件；必須依規定完成必要設定、指定社群、全部 12 堂核心教學與測驗門檻，不能只靠單一條件取代",
      "只差兩堂課，因此系統應自動視為完成"
    ],
    answer:2
  }
]);

function getRiderV4LifecycleStatus(rider = {}) {
  const explicit = String(rider.lifecycleStatus || '').trim().toUpperCase();
  if (Object.values(RIDER_V4_LIFECYCLE).includes(explicit)) return explicit;

  const status = String(rider.status || '').trim().toLowerCase();
  if (status === 'rejected') return RIDER_V4_LIFECYCLE.REJECTED;
  if (['banned','blocked'].includes(status) || rider.blocked === true) return RIDER_V4_LIFECYCLE.BANNED;
  if (['suspended','disabled'].includes(status) || rider.suspended === true || rider.disabled === true) return RIDER_V4_LIFECYCLE.SUSPENDED;
  if (status === 'training') return RIDER_V4_LIFECYCLE.TRAINING;
  if (status === 'retraining') return RIDER_V4_LIFECYCLE.RETRAINING;
  if (status === 'restricted') return RIDER_V4_LIFECYCLE.RESTRICTED;
  if (rider.approved === true || status === 'approved' || status === 'active') return RIDER_V4_LIFECYCLE.ACTIVE;
  return RIDER_V4_LIFECYCLE.UNDER_REVIEW;
}

function isRiderV4OnboardingComplete(rider = {}) {
  // 舊版已審核小U沒有 onboarding 欄位時，視為既有有效帳號，避免升級造成全面停單。
  if (rider.approved === true && !rider.onboarding && !rider.lifecycleStatus) return true;
  return rider.onboarding?.completed === true || rider.trainingCompleted === true;
}

function canRiderAcceptOrdersV4(rider = {}) {
  const lifecycle = getRiderV4LifecycleStatus(rider);
  if (lifecycle !== RIDER_V4_LIFECYCLE.ACTIVE) return false;
  if (rider.canAcceptOrders === false) return false;
  if (!isRiderV4OnboardingComplete(rider) && (rider.onboarding || rider.lifecycleStatus)) return false;
  return true;
}

function getRiderV4LevelNumber(rider = {}) {
  const level = String(rider.riderLevel || 'L1').trim().toUpperCase();
  const match = level.match(/^L(\d+)$/);
  return match ? Number(match[1]) : 1;
}

function getOrderV4Requirements(order = {}) {
  const certification = String(
    order.requiredRiderCertification ||
    order.requiredCertification ||
    order.riderCertificationRequired ||
    ''
  ).trim();
  const levelRaw = String(order.requiredRiderLevel || order.minimumRiderLevel || '').trim().toUpperCase();
  const levelMatch = levelRaw.match(/^L(\d+)$/);
  return {
    certification,
    minimumLevel: levelMatch ? Number(levelMatch[1]) : 1,
  };
}

function riderMeetsOrderV4Requirements(rider = {}, order = {}) {
  const req = getOrderV4Requirements(order);
  if (getRiderV4LevelNumber(rider) < req.minimumLevel) return false;
  if (!req.certification) return true;
  return rider.certifications?.[req.certification] === true;
}

function buildRiderV4PublicConfig() {
  return {
    version: 'V4',
    jkoPay: {
      account: UBEE_JKOPAY_ACCOUNT,
      required: true,
    },
    communities: {
      required: true,
      password: UBEE_RIDER_COMMUNITY_PASSWORD,
      announcement: UBEE_RIDER_COMMUNITIES.announcement,
      chat: UBEE_RIDER_COMMUNITIES.chat,
      report: UBEE_RIDER_COMMUNITIES.report,
    },
    requiredModules: RIDER_V4_REQUIRED_MODULES,
    passingScore: 80,
    quiz: RIDER_V4_QUIZ.map(({ answer, ...publicQuestion }) => publicQuestion),
    certifications: RIDER_V4_CERTIFICATIONS,
  };
}

function getRiderUnifiedLearningModules(rider = {}) {
  const onboardingModules = rider.onboarding?.modules || {};
  const learningModules = rider.learning?.modules || {};
  const merged = {
    ...onboardingModules,
    ...learningModules,
  };

  // 相容舊資料：
  // 過去若使用 set({ 'learning.modules.xxx': true }, { merge:true })，
  // Firestore 可能留下 literal dotted field。這裡先讀回，避免已完成課程顯示 0/12。
  for (const id of RIDER_V4_REQUIRED_MODULES) {
    if (
      onboardingModules[id] === true ||
      learningModules[id] === true ||
      rider[`onboarding.modules.${id}`] === true ||
      rider[`learning.modules.${id}`] === true
    ) {
      merged[id] = true;
    }
  }

  return merged;
}

function getRiderUnifiedLearningChecklist(rider = {}) {
  const onboarding = rider.onboarding || {};
  const learningChecklist = rider.learning?.checklist || {};
  return {
    jkopayInstalled:
      onboarding.jkopayInstalled === true ||
      learningChecklist.jkopayInstalled === true ||
      rider['onboarding.jkopayInstalled'] === true ||
      rider['learning.checklist.jkopayInstalled'] === true,
    announcementGroupJoined:
      onboarding.announcementGroupJoined === true ||
      learningChecklist.announcementGroupJoined === true ||
      rider['onboarding.announcementGroupJoined'] === true ||
      rider['learning.checklist.announcementGroupJoined'] === true,
    chatGroupJoined:
      onboarding.chatGroupJoined === true ||
      learningChecklist.chatGroupJoined === true ||
      rider['onboarding.chatGroupJoined'] === true ||
      rider['learning.checklist.chatGroupJoined'] === true,
    reportGroupJoined:
      onboarding.reportGroupJoined === true ||
      learningChecklist.reportGroupJoined === true ||
      rider['onboarding.reportGroupJoined'] === true ||
      rider['learning.checklist.reportGroupJoined'] === true,
  };
}

function getRiderUnifiedLearningQuiz(rider = {}) {
  const learning = rider.learning || {};
  const onboarding = rider.onboarding || {};
  const scores = [
    Number(learning.quizBestScore || 0),
    Number(learning.quizScore || 0),
    Number(onboarding.quizScore || 0),
    Number(rider.trainingQuizScore || 0),
    Number(rider['learning.quizBestScore'] || 0),
    Number(rider['learning.quizScore'] || 0),
    Number(rider['onboarding.quizScore'] || 0),
  ].filter(Number.isFinite);
  const score = scores.length ? Math.max(...scores) : 0;
  const passed =
    learning.quizPassed === true ||
    onboarding.quizPassed === true ||
    rider.trainingQuizPassed === true ||
    rider['learning.quizPassed'] === true ||
    rider['onboarding.quizPassed'] === true ||
    score >= 80;
  return { score, passed };
}


function buildRiderV4LearningRepairPatch(rider = {}) {
  const patch = {};
  const learning = rider.learning || {};
  const onboarding = rider.onboarding || {};
  const learningModules = learning.modules || {};
  const onboardingModules = onboarding.modules || {};
  const unifiedModules = getRiderUnifiedLearningModules(rider);
  const unifiedChecklist = getRiderUnifiedLearningChecklist(rider);
  const unifiedQuiz = getRiderUnifiedLearningQuiz(rider);

  for (const id of RIDER_V4_REQUIRED_MODULES) {
    if (unifiedModules[id] === true && learningModules[id] !== true) {
      patch[`learning.modules.${id}`] = true;
    }

    if (
      (
        onboardingModules[id] === true ||
        rider[`onboarding.modules.${id}`] === true
      ) &&
      onboardingModules[id] !== true
    ) {
      patch[`onboarding.modules.${id}`] = true;
    }
  }

  for (const key of [
    'jkopayInstalled',
    'announcementGroupJoined',
    'chatGroupJoined',
    'reportGroupJoined',
  ]) {
    if (unifiedChecklist[key] === true && learning.checklist?.[key] !== true) {
      patch[`learning.checklist.${key}`] = true;
    }

    if (
      (
        onboarding[key] === true ||
        rider[`onboarding.${key}`] === true
      ) &&
      onboarding[key] !== true
    ) {
      patch[`onboarding.${key}`] = true;
    }
  }

  if (
    Number(unifiedQuiz.score || 0) >
    Number(learning.quizBestScore || learning.quizScore || 0)
  ) {
    patch['learning.quizBestScore'] = Number(unifiedQuiz.score || 0);
    patch['learning.quizScore'] = Number(unifiedQuiz.score || 0);
  }

  if (unifiedQuiz.passed === true && learning.quizPassed !== true) {
    patch['learning.quizPassed'] = true;
  }

  return patch;
}

async function repairRiderV4LearningPersistence(riderDoc, rider = {}) {
  if (!riderDoc || !riderDoc.exists) return rider;

  const patch = buildRiderV4LearningRepairPatch(rider);
  if (!Object.keys(patch).length) return rider;

  const nowMs = Date.now();
  patch['learning.updatedAtMs'] = nowMs;
  patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();

  // update() 正確支援 dotted field path，將舊資料搬回正式 nested 結構。
  await riderDoc.ref.update(patch);

  const updated = await riderDoc.ref.get();
  return { id:updated.id, ...updated.data() };
}

function isRiderL4LearningQualified(rider = {}) {
  const modules = getRiderUnifiedLearningModules(rider);
  const quiz = getRiderUnifiedLearningQuiz(rider);
  return (
    RIDER_V4_REQUIRED_MODULES.every(id => modules[id] === true) &&
    quiz.passed === true &&
    Number(quiz.score || 0) >= 80
  );
}

function getSafeRiderLevel(level, fallback = 'L1') {
  const normalized = String(level || '').trim().toUpperCase();
  return /^L[0-4]$/.test(normalized) ? normalized : fallback;
}

function getNonDowngradeRiderLevel(rider = {}, minimumLevel = 'L1') {
  if (isRiderL4LearningQualified(rider)) return 'L4';
  const current = getSafeRiderLevel(rider.riderLevel, 'L0');
  const currentRank = getRiderV4LevelNumber({ riderLevel: current });
  const minimumRank = getRiderV4LevelNumber({ riderLevel: minimumLevel });
  return currentRank >= minimumRank ? current : minimumLevel;
}

async function syncRiderL4Qualification(riderDoc, rider = {}) {
  if (!riderDoc || !riderDoc.exists || !isRiderL4LearningQualified(rider)) {
    return rider;
  }

  const alreadySynced =
    String(rider.riderLevel || '').toUpperCase() === 'L4' &&
    rider.learning?.l4Qualified === true;

  if (alreadySynced) return rider;

  const nowMs = Date.now();
  await riderDoc.ref.update({
    riderLevel:'L4',
    'learning.l4Qualified':true,
    'learning.l4QualifiedAtMs':
      Number(rider.learning?.l4QualifiedAtMs || 0) || nowMs,
    'learning.updatedAtMs':nowMs,
    updatedAt:admin.firestore.FieldValue.serverTimestamp(),
  });

  const updated = await riderDoc.ref.get();
  return { id:updated.id, ...updated.data() };
}

function getRiderV4Progress(rider = {}) {
  const onboarding = rider.onboarding || {};
  const modules = getRiderUnifiedLearningModules(rider);
  const checklist = getRiderUnifiedLearningChecklist(rider);
  const quiz = getRiderUnifiedLearningQuiz(rider);
  const completedModules = RIDER_V4_REQUIRED_MODULES.filter(id => modules[id] === true);
  const l4Qualified = isRiderL4LearningQualified(rider);
  return {
    lifecycleStatus: getRiderV4LifecycleStatus(rider),
    canAcceptOrders: canRiderAcceptOrdersV4(rider),
    riderLevel: String(rider.riderLevel || (isRiderV4OnboardingComplete(rider) ? 'L1' : 'L0')),
    checklist,
    modules,
    completedModules,
    completedModuleCount: completedModules.length,
    requiredModuleCount: RIDER_V4_REQUIRED_MODULES.length,
    courseProgressPercent: Math.max(
      0,
      Math.min(
        100,
        Math.round(
          completedModules.length /
          Math.max(1, RIDER_V4_REQUIRED_MODULES.length) *
          100
        )
      )
    ),
    quizScore: Number(quiz.score || 0),
    quizPassed: quiz.passed === true,
    l4Qualified,
    learning: rider.learning || {},
    completed: isRiderV4OnboardingComplete(rider),
    certifications: rider.certifications || {},
    governance: rider.governance || {},
    retraining: rider.retraining || null,
  };
}

function requireRiderV4AdminKey(req, res, next) {
  if (!UBEE_RIDER_V4_ADMIN_KEY) {
    return res.status(503).json({
      success: false,
      message: '尚未設定 UBEE_RIDER_V4_ADMIN_KEY，V4 管理功能暫不開放。',
    });
  }
  const key = String(req.headers['x-ubee-admin-key'] || req.body?.adminKey || '').trim();
  if (!key || key !== UBEE_RIDER_V4_ADMIN_KEY) {
    return res.status(401).json({ success:false, message:'V4 管理授權失敗。' });
  }
  return next();
}

function isApprovedRiderData(riderData) {
  if (!riderData) return false;

  return (
    riderData.approved === true ||
    String(riderData.status || '').trim().toLowerCase() === 'approved'
  );
}

function isBlockedRiderData(riderData) {
  if (!riderData) return false;

  const status = String(riderData.status || '').trim().toLowerCase();

  return (
    riderData.disabled === true ||
    riderData.suspended === true ||
    riderData.blocked === true ||
    status === 'disabled' ||
    status === 'suspended' ||
    status === 'blocked' ||
    status === 'banned' ||
    status === 'rejected' ||
    String(riderData.lifecycleStatus || '').trim().toUpperCase() === RIDER_V4_LIFECYCLE.SUSPENDED ||
    String(riderData.lifecycleStatus || '').trim().toUpperCase() === RIDER_V4_LIFECYCLE.BANNED ||
    String(riderData.lifecycleStatus || '').trim().toUpperCase() === RIDER_V4_LIFECYCLE.REJECTED
  );
}

// =====================================================
// UBee 小U資料庫 V2 第二階段：營運資料讀取相容層
// - 所有核心身分查找優先讀取 ridersV2。
// - 找不到時才回退舊 riders，避免遷移期間中斷既有小U。
// - 回傳的 Firestore DocumentSnapshot 會保留實際來源集合，
//   後續 riderDoc.ref.set() 將直接寫回正確集合。
// =====================================================
async function findRiderDocumentV2First(source = {}) {
  const cleanPhone = normalizePhone(
    source.phone || source.riderPhone || ''
  );
  const cleanRiderId = String(
    source.riderId || source.id || ''
  ).trim();
  const cleanLineUserId = String(
    source.lineUserId || ''
  ).trim();

  const collections = [
    RIDER_V2_COLLECTIONS.riders,
    'riders',
  ];

  for (const collectionName of collections) {
    if (/^09\d{8}$/.test(cleanPhone)) {
      let doc = await db.collection(collectionName).doc(cleanPhone).get();
      if (doc.exists) return { riderDoc: doc, sourceCollection: collectionName };

      const phoneSnap = await db.collection(collectionName)
        .where('phone', '==', cleanPhone)
        .limit(1)
        .get();
      if (!phoneSnap.empty) {
        return { riderDoc: phoneSnap.docs[0], sourceCollection: collectionName };
      }
    }

    if (cleanRiderId) {
      let doc = await db.collection(collectionName).doc(cleanRiderId).get();
      if (doc.exists) return { riderDoc: doc, sourceCollection: collectionName };

      const riderIdSnap = await db.collection(collectionName)
        .where('riderId', '==', cleanRiderId)
        .limit(1)
        .get();
      if (!riderIdSnap.empty) {
        return { riderDoc: riderIdSnap.docs[0], sourceCollection: collectionName };
      }
    }

    if (cleanLineUserId.startsWith('U')) {
      const lineSnap = await db.collection(collectionName)
        .where('lineUserId', '==', cleanLineUserId)
        .limit(1)
        .get();
      if (!lineSnap.empty) {
        return { riderDoc: lineSnap.docs[0], sourceCollection: collectionName };
      }
    }
  }

  return { riderDoc: null, sourceCollection: '' };
}

async function writeRiderMigrationCompatible(riderDoc, updateData = {}) {
  if (!riderDoc || !riderDoc.exists) {
    throw new Error('RIDER_DOCUMENT_NOT_FOUND');
  }

  const docId = String(riderDoc.id || '').trim();
  const sourceCollection = String(riderDoc.ref?.parent?.id || '').trim();
  const writes = [riderDoc.ref.set(updateData, { merge: true })];

  // 遷移期間：若另一份對應文件已存在，維持必要營運欄位同步；
  // 不會替只有舊資料的帳號憑空建立 ridersV2。
  const counterpartCollection =
    sourceCollection === RIDER_V2_COLLECTIONS.riders
      ? 'riders'
      : RIDER_V2_COLLECTIONS.riders;

  if (docId && counterpartCollection) {
    const counterpartRef = db.collection(counterpartCollection).doc(docId);
    const counterpartDoc = await counterpartRef.get();
    if (counterpartDoc.exists) {
      writes.push(counterpartRef.set(updateData, { merge: true }));
    }
  }

  await Promise.all(writes);
}

function buildRiderLoginPayload(riderDoc) {
  const riderData = riderDoc.data() || {};
  const cleanPhone = normalizePhone(riderData.phone || riderDoc.id || '');

  return {
    id: riderDoc.id,
    riderId: riderData.riderId || riderDoc.id,
    ...riderData,
    phone: cleanPhone,
  };
}

async function findRiderByPhoneForLogin(phone) {
  const cleanPhone = normalizePhone(phone || '');

  if (!/^09\d{8}$/.test(cleanPhone)) {
    return {
      ok: false,
      statusCode: 400,
      message: '手機號碼格式錯誤，請輸入 09 開頭的 10 碼手機號碼。',
    };
  }

  const found = await findRiderDocumentV2First({ phone: cleanPhone });
  let riderDoc = found.riderDoc;

  if (!riderDoc || !riderDoc.exists) {
    return {
      ok: false,
      statusCode: 404,
      message: '找不到此手機號碼的小U資料，請回到 UBee 騎士端點選「申請成為小U」完成申請。',
    };
  }

  const riderData = riderDoc.data() || {};

  if (isBlockedRiderData(riderData)) {
    return {
      ok: false,
      statusCode: 403,
      message: '此騎士帳號目前無法登入，請聯繫 UBee 跑腿管理員。',
    };
  }

  if (!isApprovedRiderData(riderData)) {
    return {
      ok: false,
      statusCode: 403,
      message: '你的騎士資料尚未審核通過，暫時無法登入騎士端。',
    };
  }

  const loginUpdate = {
    phone: cleanPhone,
    riderId: riderData.riderId || riderDoc.id,
    phoneLoginEnabled: true,
    lastLoginMethod: 'phone',
    lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
    lastLoginAtMs: Date.now(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    operationalDataSource:
      found.sourceCollection === RIDER_V2_COLLECTIONS.riders
        ? 'ridersV2'
        : 'legacy_riders',
  };

  await writeRiderMigrationCompatible(riderDoc, loginUpdate);
  riderDoc = await riderDoc.ref.get();

  return {
    ok: true,
    statusCode: 200,
    riderDoc,
    rider: buildRiderLoginPayload(riderDoc),
    sourceCollection: found.sourceCollection,
  };
}

app.post('/api/rider/login', async (req, res) => {
  try {
    const { phone } = req.body || {};
    const result = await findRiderByPhoneForLogin(phone);

    if (!result.ok) {
      return res.status(result.statusCode).json({
        success: false,
        message: result.message,
      });
    }

    // Token 建立失敗時仍保留原本手機登入成功，
    // 避免 Firebase Auth 過渡期間影響現有接單與訂單流程。
    let firebaseUid = '';
    let firebaseCustomToken = '';

    try {
      const tokenResult =
        await createRiderFirebaseCustomToken(
          result.riderDoc
        );

      firebaseUid = tokenResult.firebaseUid;
      firebaseCustomToken =
        tokenResult.firebaseCustomToken;
    } catch (tokenError) {
      console.warn(
        '⚠️ 建立小U Firebase Custom Token 失敗，暫時維持舊版登入：',
        tokenError && tokenError.message
          ? tokenError.message
          : tokenError
      );
    }

    return res.json({
      success: true,
      message: '登入成功。',
      rider: result.rider,
      riderId: result.rider.id,
      phone: result.rider.phone,

      // Firebase Auth 過渡期資料。
      // rider.html 完成串接前，既有流程仍不依賴這兩個欄位。
      firebaseUid,
      firebaseCustomToken,
    });
  } catch (err) {
    console.error('❌ 騎士手機登入失敗：', err);

    return res.status(500).json({
      success: false,
      message: '騎士登入失敗，請稍後再試。',
      error: err.message,
    });
  }
});


// =====================================================
// UBee 小U持久登入 Session Restore
// - Firebase Auth 使用 LOCAL persistence，重新開啟騎士端時可直接恢復登入。
// - 有 Bearer Token 時，以 Token 內 riderDocId 為唯一可信來源。
// - 相容模式仍允許 phone / riderId / lineUserId 做舊版恢復。
// - 不要求小U每次重新輸入手機號碼。
// =====================================================
app.get('/api/rider/session', riderAuthMiddleware, async (req, res) => {
  try {
    let riderDoc = null;

    const trustedRiderDocId = String(
      req.riderAuth?.riderDocId || ''
    ).trim();

    if (trustedRiderDocId) {
      const found = await findRiderDocumentV2First({
        riderId: trustedRiderDocId,
      });

      if (found.riderDoc?.exists) {
        riderDoc = found.riderDoc;
      }
    }

    if (!riderDoc) {
      const riderResult = await findApprovedRiderForApi({
        lineUserId: req.query?.lineUserId,
        phone: req.query?.phone,
        riderId: req.query?.riderId,
      });

      if (!riderResult.ok) {
        return res.status(riderResult.statusCode).json({
          success: false,
          message: riderResult.message,
        });
      }

      riderDoc = riderResult.riderDoc;
    }

    const riderData = riderDoc?.data?.() || {};

    if (!riderDoc || !riderDoc.exists) {
      return res.status(404).json({
        success: false,
        message: '找不到小U登入資料，請重新登入。',
      });
    }

    if (isBlockedRiderData(riderData)) {
      return res.status(403).json({
        success: false,
        message: '此騎士帳號目前無法登入，請聯繫 UBee 跑腿管理員。',
      });
    }

    if (!isApprovedRiderData(riderData)) {
      return res.status(403).json({
        success: false,
        message: '你的騎士資格目前尚未啟用，請聯繫 UBee 跑腿管理員。',
      });
    }

    const nowMs = Date.now();

    await writeRiderMigrationCompatible(riderDoc, {
      lastSessionRestoreAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSessionRestoreAtMs: nowMs,
      lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSeenAtMs: nowMs,
      connectionState: 'connected',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const refreshedRiderDoc = await riderDoc.ref.get();

    let firebaseUid = '';
    let firebaseCustomToken = '';

    try {
      firebaseUid = buildRiderFirebaseUid(refreshedRiderDoc.id);

      // 沒有 Bearer Token 代表瀏覽器 Firebase Session 可能遺失；
      // 回傳新的 Custom Token，讓前端靜默恢復安全登入，不要求再輸入手機。
      if (!req.riderAuth) {
        const tokenResult = await createRiderFirebaseCustomToken(
          refreshedRiderDoc
        );
        firebaseUid = tokenResult.firebaseUid;
        firebaseCustomToken = tokenResult.firebaseCustomToken;
      }
    } catch (tokenError) {
      console.warn(
        '⚠️ Session Restore 建立小U Firebase Token 失敗，維持相容登入：',
        tokenError && tokenError.message
          ? tokenError.message
          : tokenError
      );
    }

    return res.json({
      success: true,
      restored: true,
      rider: buildRiderLoginPayload(refreshedRiderDoc),
      firebaseUid,
      firebaseCustomToken,
      serverTimeMs: nowMs,
    });
  } catch (err) {
    console.error('❌ 小U Session Restore 失敗：', err);

    return res.status(500).json({
      success: false,
      message: '登入狀態恢復失敗，請稍後再試。',
      error: err.message,
    });
  }
});

// =====================================================
// UBee 小U在線心跳
// - 與 GPS 分離：定位權限被關閉時，調度中心仍可知道小U最後在線時間。
// - 只更新在線／裝置／定位健康狀態，不改變 online 接單開關。
// =====================================================
app.post('/api/rider/heartbeat', riderAuthMiddleware, async (req, res) => {
  try {
    const {
      lineUserId,
      phone,
      riderId,
      reason,
      visibilityState,
      clientOnline,
      locationState,
      lastLocationSuccessAtMs,
      userAgent,
    } = req.body || {};

    const riderResult = await findApprovedRiderForApi({
      lineUserId,
      phone,
      riderId,
    });

    if (!riderResult.ok) {
      return res.status(riderResult.statusCode).json({
        success: false,
        message: riderResult.message,
      });
    }

    const riderDoc = riderResult.riderDoc;
    const rider = riderResult.rider || {};
    const nowMs = Date.now();
    const safeLocationStates = new Set([
      'starting',
      'healthy',
      'stale',
      'error',
      'unsupported',
    ]);
    const normalizedLocationState = String(
      locationState || ''
    ).trim().toLowerCase();
    const safeLocationState = safeLocationStates.has(
      normalizedLocationState
    )
      ? normalizedLocationState
      : 'unknown';

    const updateData = {
      lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSeenAtMs: nowMs,
      lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
      lastHeartbeatAtMs: nowMs,
      lastHeartbeatReason: cleanText(reason || 'interval', 40),
      clientVisibilityState: cleanText(visibilityState || 'unknown', 20),
      clientNetworkOnline: clientOnline !== false,
      connectionState: clientOnline === false ? 'client_offline' : 'connected',
      locationHealthState: safeLocationState,
      locationHealthUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      locationHealthUpdatedAtMs: nowMs,
      lastClientUserAgent: cleanText(userAgent || '', 260),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const safeLastLocationSuccessAtMs = Number(
      lastLocationSuccessAtMs || 0
    );

    if (
      Number.isFinite(safeLastLocationSuccessAtMs) &&
      safeLastLocationSuccessAtMs > 0
    ) {
      updateData.lastLocationSuccessAtMs =
        safeLastLocationSuccessAtMs;
    }

    // 心跳只更新在線與定位健康狀態，不接受前端改寫任務歸屬。
    // currentOrderId / busy 的修復統一由 /api/rider/current-order 驗證後處理。
    await writeRiderMigrationCompatible(riderDoc, updateData);

    return res.json({
      success: true,
      serverTimeMs: nowMs,
      rider: {
        id: riderDoc.id,
        riderId: rider.riderId || riderDoc.id,
        phone: normalizePhone(rider.phone || riderDoc.id || ''),
        online: rider.online === true,
        acceptingOrders:
          rider.acceptingOrders === true || rider.online === true,
        busy: rider.busy === true,
        currentOrderId: String(rider.currentOrderId || '').trim(),
        lastSeenAtMs: nowMs,
        locationHealthState: safeLocationState,
      },
    });
  } catch (err) {
    console.error('❌ 小U心跳同步失敗：', err);

    return res.status(500).json({
      success: false,
      message: '小U在線狀態同步失敗，請稍後再試。',
      error: err.message,
    });
  }
});

// ==============================
// UBee Web Push API
// ==============================

// 取得 Web Push Public Key：給騎士端 pushManager.subscribe 使用
app.get('/api/web-push/public-key', (req, res) => {
  if (!WEB_PUSH_PUBLIC_KEY) {
    return res.status(500).json({
      success: false,
      message: 'WEB_PUSH_PUBLIC_KEY 尚未設定',
    });
  }

  return res.json({
    success: true,
    publicKey: WEB_PUSH_PUBLIC_KEY,
  });
});

// 儲存騎士 iPhone / PWA Web Push 訂閱資料
app.post('/api/rider/push-subscription', riderAuthMiddleware, async (req, res) => {
  try {
    const {
      lineUserId,
      phone,
      riderId,
      subscription,
      userAgent,
      platform,
      app: riderApp
    } = req.body || {};

    const safeLineUserId = String(lineUserId || '').trim();
    const cleanPhone = normalizePhone(phone || '');
    const safeRiderId = String(riderId || '').trim();

    if (
      !subscription ||
      !subscription.endpoint ||
      !subscription.keys ||
      !subscription.keys.p256dh ||
      !subscription.keys.auth
    ) {
      return res.status(400).json({
        success: false,
        message: '缺少正確的 Web Push subscription。',
      });
    }

    const found = await findRiderDocumentV2First({
      phone: cleanPhone,
      riderId: safeRiderId,
      lineUserId: safeLineUserId,
    });
    const riderDoc = found.riderDoc;

    if (!riderDoc) {
      return res.status(404).json({
        success: false,
        message: '找不到騎士資料，無法儲存派單通知。',
      });
    }

    const riderData = riderDoc.data() || {};

    const riderApproved =
      riderData.approved === true ||
      String(riderData.status || '').trim().toLowerCase() === 'approved';

    if (!riderApproved) {
      return res.status(403).json({
        success: false,
        message: '騎士尚未審核通過，無法啟用派單通知。',
      });
    }

    await writeRiderMigrationCompatible(riderDoc, {
      webPushSubscription: subscription,
      webPushEnabled: true,
      webPushUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      webPushUpdatedAtMs: Date.now(),

      pushProvider: 'web-push',
      pushApp: riderApp || 'ubee-rider-web',
      pushPlatform: platform || '',
      pushUserAgent: userAgent || '',

      pushPhone: cleanPhone || riderData.phone || riderDoc.id || '',
      pushRiderId: safeRiderId || riderData.riderId || riderDoc.id || '',
      pushLineUserId: safeLineUserId || riderData.lineUserId || '',

      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      message: 'UBee 派單通知訂閱已儲存。',
      riderId: riderDoc.id,
    });

  } catch (err) {
    console.error('❌ 儲存騎士 Web Push subscription 失敗：', err);

    return res.status(500).json({
      success: false,
      message: '儲存派單通知失敗，請稍後再試。',
      error: err.message,
    });
  }
});


// ============================================================
// UBee 騎士端 V5 Native Bridge API
// - 原生 iOS / Android 裝置資訊與推播 Token 保存
// - App 冷啟動 / Deep Link / Live Activity 重新同步目前任務
// - 不建立第二套任務資料，永遠以 riders + orders 為唯一真相來源
// ============================================================

function buildRiderV5NativeTaskPayload(order = {}) {
  if (!order || typeof order !== 'object') return null;

  const orderId = String(
    order.id || order.orderId || order.orderNo || ''
  ).trim().toUpperCase();

  if (!orderId) return null;

  const status = String(order.status || order.riderStatus || '').trim();

  const stageMap = {
    accepted: ['前往取件', 'pickup'],
    going_to_pickup: ['前往取件', 'pickup'],
    heading_to_pickup: ['前往取件', 'pickup'],
    arrived_pickup: ['已抵達取件點', 'pickup'],
    picked_up: ['配送中', 'delivery'],
    going_to_dropoff: ['配送中', 'delivery'],
    heading_to_dropoff: ['配送中', 'delivery'],
    arrived_dropoff: ['已抵達送達點', 'delivery'],
    completed: ['任務完成', 'completed'],
  };

  const [stage, phase] = stageMap[status] || ['任務進行中', 'task'];

  return {
    orderId,
    status,
    stage,
    phase,
    pickupAddress: String(
      order.pickupAddress || order.fromAddress || order.pickup || ''
    ).slice(0, 180),
    dropoffAddress: String(
      order.dropoffAddress || order.toAddress || order.dropoff || ''
    ).slice(0, 180),
    riderFee: Number(order.riderFee || order.driverFee || 0) || 0,
    estimatedArrivalTime:
      order.estimatedArrivalTime ||
      order.etaAt ||
      order.eta ||
      null,
    remainingDistanceKm:
      Number(order.remainingDistanceKm || order.distanceRemainingKm || 0) || 0,
    deepLink:
      `/rider.html?orderId=${encodeURIComponent(orderId)}&tab=task&source=native`,
    updatedAtMs: Date.now(),
  };
}

app.post('/api/rider/v5/native-device', riderAuthMiddleware, async (req, res) => {
  try {
    const riderResult = await findApprovedRiderForApi(req.body || {});

    if (!riderResult.ok) {
      return res.status(riderResult.statusCode || 403).json({
        success: false,
        message: riderResult.message || '找不到小U資料。',
      });
    }

    const body = req.body || {};
    const platform = String(body.platform || '').trim().toLowerCase().slice(0, 30);
    const deviceToken = String(body.deviceToken || '').trim().slice(0, 500);
    const liveActivityPushToken = String(
      body.liveActivityPushToken || ''
    ).trim().slice(0, 1000);
    const appVersion = String(body.appVersion || '').trim().slice(0, 60);
    const deviceId = String(body.deviceId || '').trim().slice(0, 160);

    const update = {
      nativeAppEnabled: true,
      nativePlatform: platform || 'unknown',
      nativeAppVersion: appVersion,
      nativeDeviceId: deviceId,
      nativeDeviceUpdatedAt:
        admin.firestore.FieldValue.serverTimestamp(),
      nativeDeviceUpdatedAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (deviceToken) {
      update.nativePushToken = deviceToken;
    }

    if (liveActivityPushToken) {
      update.liveActivityPushToken = liveActivityPushToken;
      update.liveActivityPushTokenUpdatedAt =
        admin.firestore.FieldValue.serverTimestamp();
      update.liveActivityPushTokenUpdatedAtMs = Date.now();
    }

    await db.collection('riders')
      .doc(riderResult.riderDoc.id)
      .set(update, { merge: true });

    return res.json({
      success: true,
      riderId: riderResult.riderDoc.id,
      message: 'V5 原生裝置資料已同步。',
    });
  } catch (error) {
    console.error('❌ V5 原生裝置資料同步失敗：', error);
    return res.status(500).json({
      success: false,
      message: '原生裝置資料同步失敗。',
      error: error.message,
    });
  }
});

app.get('/api/rider/v5/native-state', riderAuthMiddleware, async (req, res) => {
  try {
    const riderResult = await findApprovedRiderForApi(req.query || {});

    if (!riderResult.ok) {
      return res.status(riderResult.statusCode || 403).json({
        success: false,
        message: riderResult.message || '找不到小U資料。',
      });
    }

    const rider = riderResult.rider || {};
    const currentOrderId = String(rider.currentOrderId || '').trim().toUpperCase();

    let order = null;

    if (currentOrderId) {
      const orderDoc = await db.collection('orders').doc(currentOrderId).get();
      if (orderDoc.exists) {
        order = {
          id: orderDoc.id,
          ...(orderDoc.data() || {}),
        };
      }
    }

    return res.json({
      success: true,
      version: '5.3.0',
      rider: {
        riderId: rider.riderId || riderResult.riderDoc.id,
        phone: rider.phone || riderResult.riderDoc.id,
        name: rider.name || rider.riderName || '',
        online: rider.online === true,
        busy: rider.busy === true,
        currentOrderId,
        lifecycleStatus: getRiderV4LifecycleStatus(rider),
        riderLevel: rider.riderLevel || '',
      },
      task: buildRiderV5NativeTaskPayload(order),
      generatedAtMs: Date.now(),
    });
  } catch (error) {
    console.error('❌ V5 原生狀態讀取失敗：', error);
    return res.status(500).json({
      success: false,
      message: 'V5 原生狀態讀取失敗。',
      error: error.message,
    });
  }
});


// ==============================
// UBee 騎士系統 API
// ==============================

// 1. 取得騎士資料：正式版，以手機綁定為最高優先，避免 LINE 綁錯人
app.get('/api/rider/profile', riderAuthMiddleware, async (req, res) => {
  try {
    // 正式 Token 流程：直接以 Custom Claims 的 riderDocId 讀取本人資料。
    if (req.riderAuth && req.riderAuth.riderDocId) {
      const riderDoc = await db
        .collection('riders')
        .doc(req.riderAuth.riderDocId)
        .get();

      if (!riderDoc.exists) {
        return res.status(404).json({
          success: false,
          message: '找不到此小U帳號資料。',
        });
      }

      const riderData = riderDoc.data() || {};

      if (isBlockedRiderData(riderData)) {
        return res.status(403).json({
          success: false,
          message: '此小U帳號目前無法使用，請聯繫 UBee 跑腿管理員。',
        });
      }

      if (!isApprovedRiderData(riderData)) {
        return res.status(403).json({
          success: false,
          message: '小U資料尚未審核通過。',
        });
      }

      return res.json({
        success: true,
        rider: {
          id: riderDoc.id,
          ...riderData,
        },
      });
    }

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

// ===== UBee 騎士可接單判斷：正式營運版 =====
// 原則：
// 1. 客人端現金單確認後，可以派給騎士
// 2. 未來街口支付恢復後，只有已確認付款的街口單可以派給騎士
// 3. 店家派單中心的「店家月結 / 店家已收款」可以派給騎士

function getOrderPaymentMethod(order) {
  return String(
    order?.paymentMethod ||
    order?.payMethod ||
    order?.paymentType ||
    order?.payment ||
    order?.payType ||
    ''
  )
    .trim()
    .toLowerCase();
}


// 取得訂單付款狀態
function getOrderPaymentStatus(order) {
  return String(
    order?.paymentStatus ||
    order?.payStatus ||
    ''
  )
    .trim()
    .toLowerCase();
}


// ===== UBee 現金訂單／騎士回繳狀態工具 =====
// ===== UBee 現金訂單／騎士回繳狀態工具 =====

// 統一判斷訂單是否為現金單
function isCashPaymentOrder(order) {
  if (!order) {
    return false;
  }

  const paymentMethod =
    getOrderPaymentMethod(order);

  const paymentStatus =
    getOrderPaymentStatus(order);

  return (
    order.isCashOrder === true ||
    paymentMethod === 'cash' ||
    paymentMethod.includes('cash') ||
    paymentMethod.includes('現金') ||
    paymentStatus === 'cash_on_delivery' ||
    paymentStatus === 'cash_pending' ||
    paymentStatus.includes('現金')
  );
}


// 取得現金回繳狀態
function getOrderCashRemittanceStatus(order) {
  const status = String(
    order?.cashRemittanceStatus ||
    order?.cashSettlementStatus ||
    order?.remittanceStatus ||
    'pending'
  )
    .trim()
    .toLowerCase();

  return status || 'pending';
}


// 判斷這張現金訂單是否已經完成回繳
function isCashRemittanceSettled(order) {
  const status =
    getOrderCashRemittanceStatus(order);

  return [
    'settled',
    'remitted',
    'paid',
    'completed',
  ].includes(status);
}


// 取得騎士應繳回平台的金額
function getOrderCashDueToPlatformAmount(
  order,
  fallbackAmount = 0
) {
  const directAmount =
    getOrderMoneyValue(
      order,
      [
        'cashDueToPlatform',
        'platformReceivable',
        'riderDueToPlatform',
      ]
    );

  if (directAmount !== null) {
    return directAmount;
  }

  const fallback =
    Number(fallbackAmount);

  if (
    Number.isFinite(fallback) &&
    fallback > 0
  ) {
    return Math.round(fallback);
  }

  return 0;
}

function getOrderMoneyValue(order, fields) {
  for (const field of fields) {
    const raw = order?.[field];

    if (raw === null || raw === undefined || raw === '') continue;

    const value = Number(String(raw).replace(/[^\d.-]/g, ''));

    if (Number.isFinite(value) && value >= 0) {
      return Math.round(value);
    }
  }

  return null;
}

function getOrderAdvancePaymentAmount(order) {
  return getOrderMoneyValue(order, [
    'advancePayment',
    'advanceAmount',
    'estimatedAdvancePayment',
    'estimatedAdvanceAmount',
    'riderAdvanceAmount',
  ]) || 0;
}

function getOrderCustomerPayableTotal(order) {
  const directTotal = getOrderMoneyValue(order, [
    'customerPayableTotal',
    'customerPayTotal',
    'customerPayAmount',
    'customerTotalWithAdvance',
    'estimatedPayableTotal',
    'payableTotal',
    'finalPayAmount',
    'collectAmount',
    'amountToCollect',
  ]);

  if (directTotal !== null) return directTotal;

  const serviceTotal = getOrderMoneyValue(order, [
    'serviceSubtotal',
    'serviceTotal',
    'deliveryServiceFee',
    'taskServiceFee',
    'totalFee',
    'total',
    'price',
  ]);

  const advancePayment = getOrderAdvancePaymentAmount(order);

  if (serviceTotal !== null) {
    return serviceTotal + advancePayment;
  }

  return advancePayment > 0 ? advancePayment : 0;
}

function isCashDispatchOrder(order) {
  if (!order) return false;

  const orderStatus = String(order.status || '').trim().toLowerCase();
  const paymentMethod = getOrderPaymentMethod(order);
  const paymentStatus = getOrderPaymentStatus(order);

  const isCash =
    paymentMethod === 'cash' ||
    paymentMethod.includes('cash') ||
    paymentMethod.includes('現金') ||
    paymentStatus === 'cash_on_delivery' ||
    paymentStatus === 'cash_pending' ||
    paymentStatus.includes('現金') ||
    order.isCashOrder === true;

  return (
    orderStatus === 'pending_dispatch' &&
    isCash &&
    order.isCashOrder === true
  );
}

function isPaidJkoDispatchOrder(order) {
  if (!order) return false;

  const orderStatus = String(order.status || '').trim().toLowerCase();
  const paymentMethod = getOrderPaymentMethod(order);
  const paymentStatus = getOrderPaymentStatus(order);

  const isJko =
    paymentMethod === 'jko' ||
    paymentMethod === 'jkopay' ||
    paymentMethod === 'jkpay' ||
    paymentMethod.includes('jko') ||
    paymentMethod.includes('jkopay') ||
    paymentMethod.includes('jkpay') ||
    paymentMethod.includes('街口');

  const isPaidConfirmed =
    paymentStatus === 'paid_confirmed' ||
    paymentStatus === 'paid' ||
    paymentStatus === 'payment_confirmed' ||
    paymentStatus.includes('paid_confirmed') ||
    paymentStatus.includes('已付款') ||
    paymentStatus.includes('付款完成');

  return (
    orderStatus === 'pending_dispatch' &&
    isJko &&
    isPaidConfirmed &&
    order.isPaid === true &&
    order.isCashOrder !== true
  );
}

function isMerchantOrderRecord(order = {}) {
  const source = String(order.source || '').trim().toLowerCase();
  const createdFrom = String(order.createdFrom || '').trim().toLowerCase();
  const orderType = String(order.orderType || '').trim().toLowerCase();

  return (
    source === 'merchant-dashboard' ||
    source === 'merchant' ||
    createdFrom === 'merchant-dashboard' ||
    createdFrom === 'merchant' ||
    orderType === 'merchant_dispatch' ||
    orderType === 'merchant_delivery'
  );
}

function isMerchantDispatchOrder(order) {
  if (!order) return false;

  const orderStatus = String(order.status || '').trim().toLowerCase();
  const paymentMethod = getOrderPaymentMethod(order);
  const paymentStatus = getOrderPaymentStatus(order);

  const deliveryType = String(order.deliveryType || '').trim().toLowerCase();

  const isMerchantOrder = isMerchantOrderRecord(order);

  const isMerchantPaymentReady =
    paymentMethod === 'merchant_settlement' ||
    paymentMethod === 'merchant_paid' ||
    paymentMethod === 'merchant' ||
    paymentStatus === 'merchant_settlement' ||
    paymentStatus === 'paid_by_merchant' ||
    order.merchantPaid === true ||
    order.isPaid === true;

  const isNotCashOrder =
    paymentMethod !== 'cash' &&
    paymentStatus !== 'cash_on_delivery' &&
    order.isCashOrder !== true;

  return (
    orderStatus === 'pending_dispatch' &&
    isMerchantOrder &&
    deliveryType !== 'merchant' &&
    isMerchantPaymentReady &&
    isNotCashOrder
  );
}

function isRiderVisibleScheduledOrder(order) {
  if (!order) return false;

  const status =
    String(order.status || '')
      .trim()
      .toLowerCase();

  if (status !== 'pending_schedule') {
    return false;
  }

  // 付款條件沿用正式派單規則，只把狀態暫時視為 pending_dispatch 檢查。
  const paymentReadyShadow = {
    ...order,
    status: 'pending_dispatch',
  };

  return (
    isPaidJkoDispatchOrder(paymentReadyShadow) ||
    isCashDispatchOrder(paymentReadyShadow) ||
    isMerchantDispatchOrder(paymentReadyShadow)
  );
}

function isRiderVisibleDispatchOrder(order) {
  return (
    isPaidJkoDispatchOrder(order) ||
    isCashDispatchOrder(order) ||
    isMerchantDispatchOrder(order) ||
    isRiderVisibleScheduledOrder(order)
  );
}

// 2. 取得可接任務：手機登入正式版（V2 待接任務＋地圖取件點）
// 支援 phone / riderId，並保留 lineUserId 相容；待接單狀態也回傳 riderMapPickup。
app.get('/api/rider/tasks', riderAuthMiddleware, async (req, res) => {
  try {
    await maintainScheduledOrders();

    const { lineUserId, phone, riderId } = req.query || {};

    const riderResult = await findApprovedRiderForApi({
      lineUserId,
      phone,
      riderId,
    });

    if (!riderResult.ok) {
      return res.status(riderResult.statusCode).json({
        success: false,
        message: riderResult.message,
      });
    }

        const riderDoc = riderResult.riderDoc;
    const rider = riderResult.rider || {};

    const identity = buildRiderApiIdentity(riderDoc, rider, {
      lineUserId,
      phone,
      riderId,
    });
    
    const snap = await db
      .collection('orders')
      .where('status', 'in', ['pending_dispatch', 'pending_schedule'])
      .limit(80)
      .get();

    const nowMs = Date.now();

    const orders = snap.docs
      .map(doc => ({
        id: doc.id,
        ...doc.data()
      }))
      .filter(order => isRiderVisibleDispatchOrder(order))
      .filter(order => !isOrderSkippedForRider(order, identity))
      .filter(order => {
        const status = String(order.status || '').trim();

        if (status !== 'pending_schedule') {
          return true;
        }

        const endMs =
          getScheduleTimestampMs(order.scheduledEndAtMs) ||
          getScheduleTimestampMs(order.requestedScheduleAtMs);

        if (endMs && endMs < nowMs) {
          return false;
        }

        return riderMatchesScheduledOrderAvailability(
          rider,
          order
        );
      })
      .sort((a, b) => {
        const aTime = getDispatchPushTimeMs(
          a.createdAtMs || a.createdAt || a.updatedAtMs || a.updatedAt
        );
        const bTime = getDispatchPushTimeMs(
          b.createdAtMs || b.createdAt || b.updatedAtMs || b.updatedAt
        );
        return bTime - aTime;
      })
      .slice(0, 30)
      .map(order => {
        const pickupPoint = getOrderPickupPointForPush(order);

        return {
          ...order,
          // 騎士端待接任務地圖專用：即使尚未接單，也能可靠顯示取件點。
          // 保留原始 pickupLat / pickupLng 與完整訂單欄位，避免破壞既有流程。
          riderMapPickup: pickupPoint
            ? {
                lat: pickupPoint.lat,
                lng: pickupPoint.lng,
              }
            : null,

          scheduleAvailabilityMatch:
            String(order.status || '').trim() === 'pending_schedule'
              ? riderMatchesScheduledOrderAvailability(rider, order)
              : true,
        };
      });

    return res.json({
      success: true,
      orders,
      tasks: orders,
      availableTaskCount: orders.length,
      mapPickupEnabled: true,
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


// =====================================================
// UBee 預約任務：騎士身分解析
// - 有 Firebase Bearer Token 時，以 Token 的 riderDocId 為唯一可信來源。
// - 相容模式才回退到 phone / riderId / lineUserId。
// =====================================================
async function resolveScheduleRiderForRequest(req, source = {}) {
  if (req?.riderAuth?.riderDocId) {
    const riderDoc = await db
      .collection('riders')
      .doc(String(req.riderAuth.riderDocId).trim())
      .get();

    if (!riderDoc.exists) {
      return { ok:false, statusCode:404, message:'找不到小U資料。' };
    }

    const rider = riderDoc.data() || {};

    if (isBlockedRiderData(rider)) {
      return { ok:false, statusCode:403, message:'此小U帳號目前無法使用。' };
    }

    if (!isApprovedRiderData(rider)) {
      return { ok:false, statusCode:403, message:'小U尚未審核通過。' };
    }

    return {
      ok:true,
      riderDoc,
      rider:{ id:riderDoc.id, ...rider },
    };
  }

  return findApprovedRiderForApi(source || {});
}

// =====================================================
// UBee 預約任務 V1：小U 可接時段、預約承接、再次確認與候補
// =====================================================
async function sendScheduledRiderReminder(
  riderDocId,
  {
    title = 'UBee 預約任務提醒',
    body = '',
    orderId = '',
  } = {}
) {
  try {
    const safeRiderDocId =
      String(riderDocId || '').trim();

    if (!safeRiderDocId) {
      return false;
    }

    const riderDoc =
      await db
        .collection('riders')
        .doc(safeRiderDocId)
        .get();

    if (!riderDoc.exists) {
      return false;
    }

    const rider = riderDoc.data() || {};

    const tasks = [];

    if (
      WEB_PUSH_PUBLIC_KEY &&
      WEB_PUSH_PRIVATE_KEY &&
      rider.webPushEnabled === true &&
      rider.webPushSubscription?.endpoint
    ) {
      tasks.push(
        webpush.sendNotification(
          rider.webPushSubscription,
          JSON.stringify({
            title,
            body,
            url: `/rider.html?tab=task&source=schedule_reminder${orderId ? `&orderId=${encodeURIComponent(orderId)}` : ''}`,
            deepLink: `/rider.html?tab=task&source=schedule_reminder${orderId ? `&orderId=${encodeURIComponent(orderId)}` : ''}`,
            orderId,
          })
        ).catch(async error => {
          const statusCode =
            Number(error?.statusCode || 0);

          if (
            statusCode === 404 ||
            statusCode === 410
          ) {
            await db
              .collection('riders')
              .doc(safeRiderDocId)
              .set(
                {
                  webPushSubscription:
                    admin.firestore.FieldValue.delete(),
                  webPushEnabled: false,
                  webPushUpdatedAt:
                    admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
          }
        })
      );
    }

    // 預約「小U任務前確認」只走騎士端 Web Push／App 深連結。
    // LINE 官方帳號屬於客戶溝通通道，不再把「請進入騎士端」文字推到 LINE，
    // 避免測試帳號或身分綁定混用時，讓下單客戶收到騎士操作指示。
    await Promise.allSettled(tasks);

    return true;
  } catch (error) {
    console.error(
      '預約任務提醒小U失敗：',
      error
    );
    return false;
  }
}

async function releaseScheduledReservation(
  order,
  reason = 'rider_unavailable',
  {
    emergency = false,
  } = {}
) {
  const orderId =
    String(order?.id || order?.orderId || '')
      .trim()
      .toUpperCase();

  if (!orderId) {
    return null;
  }

  const nextStatus =
    emergency
      ? 'pending_dispatch'
      : 'pending_schedule';

  const nowMs = Date.now();

  const updateData = {
    status: nextStatus,
    riderStatus: nextStatus,
    scheduleStatus:
      emergency
        ? 'emergency_dispatch'
        : 'awaiting_rider',
    scheduleReleaseReason:
      String(reason || 'rider_unavailable').slice(0, 80),
    scheduleReleasedAtMs: nowMs,
    scheduleReleasedAt:
      admin.firestore.FieldValue.serverTimestamp(),
    scheduleConfirmationRequired: false,
    reservedRiderId: '',
    reservedRiderDocId: '',
    reservedRiderPhone: '',
    reservedRiderName: '',
    scheduleReservedAtMs: 0,
    scheduleReservedAt: null,
    riderConfirmedAtMs: 0,
    riderConfirmedAt: null,
    isScheduleEmergency: emergency === true,
    updatedAt:
      admin.firestore.FieldValue.serverTimestamp(),
  };

  await db
    .collection('orders')
    .doc(orderId)
    .set(
      updateData,
      { merge: true }
    );

  const updatedOrder = {
    ...order,
    ...updateData,
    id: orderId,
    status: nextStatus,
    riderStatus: nextStatus,
  };

  orders[orderId] = updatedOrder;

  if (emergency) {
    startOrderDispatchInBackground(
      updatedOrder
    );
  } else {
    setImmediate(() => {
      sendNewOrderPushToRiders(
        updatedOrder,
        null,
        {
          allowOffline: true,
          scheduled: true,
        }
      ).catch(() => {});
    });
  }

  return updatedOrder;
}

let scheduledMaintenanceRunning = false;

async function maintainScheduledOrders() {
  if (scheduledMaintenanceRunning) {
    return;
  }

  scheduledMaintenanceRunning = true;

  try {
    const nowMs = Date.now();

    const snap =
      await db
        .collection('orders')
        .where(
          'status',
          'in',
          [
            'pending_schedule',
            'scheduled_reserved',
            'scheduled_confirmed',
          ]
        )
        .limit(120)
        .get();

    for (const doc of snap.docs) {
      const order = {
        id: doc.id,
        ...doc.data(),
      };

      const status =
        String(order.status || '').trim();

      const startMs =
        getScheduleTimestampMs(
          order.scheduledStartAtMs ||
          order.requestedScheduleAtMs
        );

      const endMs =
        getScheduleTimestampMs(
          order.scheduledEndAtMs ||
          order.desiredCompletionAtMs ||
          order.requestedScheduleAtMs
        );

      if (!startMs) {
        continue;
      }

      // 尚未有人承接，接近任務時間時自動轉為緊急即時派單。
      if (
        status === 'pending_schedule' &&
        nowMs >=
          startMs -
            UBEE_SCHEDULE_EMERGENCY_BEFORE_MS
      ) {
        await releaseScheduledReservation(
          order,
          'schedule_near_start_no_rider',
          { emergency: true }
        );
        continue;
      }

      if (status === 'scheduled_reserved') {
        const confirmDueAtMs =
          getScheduleTimestampMs(
            order.scheduleConfirmDueAtMs
          ) ||
          Math.max(
            0,
            startMs -
              UBEE_SCHEDULE_CONFIRM_BEFORE_MS
          );

        if (
          nowMs >= confirmDueAtMs &&
          order.scheduleConfirmationRequired !== true
        ) {
          await db
            .collection('orders')
            .doc(doc.id)
            .set(
              {
                scheduleConfirmationRequired: true,
                scheduleConfirmationRequestedAtMs:
                  nowMs,
                scheduleConfirmationRequestedAt:
                  admin.firestore.FieldValue.serverTimestamp(),
                updatedAt:
                  admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );

          await sendScheduledRiderReminder(
            order.reservedRiderDocId,
            {
              title: 'UBee 預約任務即將開始',
              body:
                `預約時間：${order.scheduleLabel || formatScheduleLabelFromMs(startMs, endMs, order.orderTimingType)}\n` +
                `請在騎士端「任務 → 我的任務」確認是否可以準時執行。`,
              orderId: doc.id,
            }
          );

          // LINE 官方帳號通知下單客戶：只說明預約狀態，不出現騎士端操作指示。
          try {
            await notifyCustomer(
              order,
              createTextMessage(
                `📅 UBee 預約任務即將開始\n\n` +
                `訂單編號：${doc.id}\n` +
                `預約時間：${order.scheduleLabel || formatScheduleLabelFromMs(startMs, endMs, order.orderTimingType)}\n\n` +
                `系統正在向已承接的小U進行任務前確認，確認完成後會再通知您。`
              )
            );
          } catch (_) {}
        }

        // 超過這筆預約自己的最終確認期限仍未確認，才釋放給候補小U。
        // 新近承接的任務會有最少確認緩衝，避免「剛接就消失」。
        const confirmationDeadlineAtMs =
          getScheduleTimestampMs(
            order.scheduleConfirmationDeadlineAtMs
          ) ||
          (startMs - 30 * 60 * 1000);

        if (
          nowMs >= confirmationDeadlineAtMs &&
          !getScheduleTimestampMs(
            order.riderConfirmedAtMs
          )
        ) {
          await releaseScheduledReservation(
            order,
            'rider_not_confirmed_before_schedule',
            {
              emergency:
                nowMs >=
                startMs -
                  UBEE_SCHEDULE_EMERGENCY_BEFORE_MS,
            }
          );

          try {
            await notifyCustomer(
              order,
              createTextMessage(
                `📅 UBee 預約任務正在重新媒合\n\n` +
                `訂單編號：${doc.id}\n` +
                `原承接小U目前無法完成最終確認，系統已重新尋找可執行的小U。`
              )
            );
          } catch (_) {}

          continue;
        }
      }

      // 已確認但超過預計開始 15 分鐘仍未開始，轉入緊急派單。
      if (
        status === 'scheduled_confirmed' &&
        nowMs >
          startMs +
            UBEE_SCHEDULE_LATE_GRACE_MS
      ) {
        await releaseScheduledReservation(
          order,
          'confirmed_rider_did_not_start',
          { emergency: true }
        );

        try {
          await notifyCustomer(
            order,
            createTextMessage(
              `⚠️ UBee 預約任務啟動候補媒合\n\n` +
              `訂單編號：${doc.id}\n` +
              `系統正在重新尋找可立即執行的小U。`
            )
          );
        } catch (_) {}
      }
    }
  } catch (error) {
    console.error(
      'UBee 預約任務維護失敗：',
      error
    );
  } finally {
    scheduledMaintenanceRunning = false;
  }
}

setInterval(() => {
  maintainScheduledOrders().catch(() => {});
}, 5 * 60 * 1000).unref?.();

app.get(
  '/api/rider/schedule-preferences',
  riderAuthMiddleware,
  async (req, res) => {
    try {
      const riderResult =
        await findApprovedRiderForApi(
          req.query || {}
        );

      if (!riderResult.ok) {
        return res
          .status(riderResult.statusCode)
          .json({
            success: false,
            message: riderResult.message,
          });
      }

      const rider =
        riderResult.rider || {};

      return res.json({
        success: true,
        availabilitySchedule:
          normalizeRiderAvailabilitySchedule(
            rider.availabilitySchedule || {}
          ),
        temporaryAvailability:
          normalizeTemporaryAvailability(
            rider.temporaryAvailability || {}
          ),
        acceptImmediate:
          rider.acceptImmediateOrders !== false,
        acceptScheduled:
          rider.acceptScheduledOrders !== false,
        acceptFlexible:
          rider.acceptFlexibleOrders !== false,
      });
    } catch (error) {
      console.error(
        '讀取小U可接時段失敗：',
        error
      );

      return res.status(500).json({
        success: false,
        message: '讀取可接時段失敗。',
      });
    }
  }
);

app.post(
  '/api/rider/schedule-preferences',
  riderAuthMiddleware,
  async (req, res) => {
    try {
      const riderResult =
        await findApprovedRiderForApi(
          req.body || {}
        );

      if (!riderResult.ok) {
        return res
          .status(riderResult.statusCode)
          .json({
            success: false,
            message: riderResult.message,
          });
      }

      const availabilitySchedule =
        normalizeRiderAvailabilitySchedule(
          req.body?.availabilitySchedule || {}
        );

      const temporaryAvailability =
        normalizeTemporaryAvailability(
          req.body?.temporaryAvailability || {}
        );

      const updateData = {
        availabilitySchedule,
        temporaryAvailability,
        acceptImmediateOrders:
          req.body?.acceptImmediate !== false,
        acceptScheduledOrders:
          req.body?.acceptScheduled !== false,
        acceptFlexibleOrders:
          req.body?.acceptFlexible !== false,
        availabilityUpdatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      };

      await db
        .collection('riders')
        .doc(riderResult.riderDoc.id)
        .set(
          updateData,
          { merge: true }
        );

      return res.json({
        success: true,
        availabilitySchedule,
        temporaryAvailability,
        acceptImmediate:
          updateData.acceptImmediateOrders,
        acceptScheduled:
          updateData.acceptScheduledOrders,
        acceptFlexible:
          updateData.acceptFlexibleOrders,
        message: '可接時段已儲存。',
      });
    } catch (error) {
      console.error(
        '儲存小U可接時段失敗：',
        error
      );

      return res.status(500).json({
        success: false,
        message: '儲存可接時段失敗。',
      });
    }
  }
);

app.get(
  '/api/rider/scheduled-orders',
  riderAuthMiddleware,
  async (req, res) => {
    try {
      await maintainScheduledOrders();

      const riderResult =
        await resolveScheduleRiderForRequest(
          req,
          req.query || {}
        );

      if (!riderResult.ok) {
        return res
          .status(riderResult.statusCode)
          .json({
            success: false,
            message: riderResult.message,
          });
      }

      const identity = buildRiderApiIdentity(
        riderResult.riderDoc,
        riderResult.rider || {},
        req.query || {}
      );

      // 新資料以 reservedRiderDocId 為準；同時相容舊資料可能只存 riderId / phone。
      // 這可避免「明明承接成功，但我的任務看不到預約」的身分欄位不一致問題。
      const queryPairs = [
        ['reservedRiderDocId', identity.riderDocId],
        ['reservedRiderId', identity.riderId],
        ['reservedRiderPhone', identity.phone],
      ].filter(([, value]) => String(value || '').trim());

      const snapshots = await Promise.all(
        queryPairs.map(([field, value]) =>
          db.collection('orders')
            .where(field, '==', value)
            .limit(50)
            .get()
            .catch(() => null)
        )
      );

      const byId = new Map();
      snapshots.forEach(snap => {
        if (!snap) return;
        snap.docs.forEach(doc => {
          byId.set(doc.id, {
            id: doc.id,
            ...doc.data(),
          });
        });
      });

      const scheduledOrders =
        Array.from(byId.values())
          .filter(order =>
            [
              'scheduled_reserved',
              'scheduled_confirmed',
            ].includes(
              String(order.status || '').trim()
            )
          )
          .sort(
            (a, b) =>
              getScheduleTimestampMs(
                a.scheduledStartAtMs || a.requestedScheduleAtMs
              ) -
              getScheduleTimestampMs(
                b.scheduledStartAtMs || b.requestedScheduleAtMs
              )
          );

      return res.json({
        success: true,
        orders: scheduledOrders,
        count: scheduledOrders.length,
        riderDocId: identity.riderDocId,
      });
    } catch (error) {
      console.error(
        '讀取小U預約任務失敗：',
        error
      );

      return res.status(500).json({
        success: false,
        message: '讀取預約任務失敗。',
      });
    }
  }
);

app.post(
  '/api/rider/reserve-order',
  riderAuthMiddleware,
  async (req, res) => {
    try {
      const {
        orderId,
        lineUserId,
        phone,
        riderId,
      } = req.body || {};

      const riderResult =
        await resolveScheduleRiderForRequest(
          req,
          { lineUserId, phone, riderId }
        );

      if (!riderResult.ok) {
        return res
          .status(riderResult.statusCode)
          .json({
            success: false,
            message: riderResult.message,
          });
      }

      const safeOrderId =
        String(orderId || '')
          .trim()
          .toUpperCase();

      if (!safeOrderId) {
        return res.status(400).json({
          success: false,
          message: '缺少訂單編號。',
        });
      }

      const identity =
        buildRiderApiIdentity(
          riderResult.riderDoc,
          riderResult.rider || {},
          {
            lineUserId,
            phone,
            riderId,
          }
        );

      const orderRef =
        db.collection('orders').doc(safeOrderId);

      let reservedOrder = null;

      await db.runTransaction(
        async transaction => {
          const orderDoc =
            await transaction.get(orderRef);

          if (!orderDoc.exists) {
            throw new Error(
              'ORDER_NOT_FOUND'
            );
          }

          const order =
            orderDoc.data() || {};

          if (
            String(order.status || '').trim() !==
            'pending_schedule'
          ) {
            throw new Error(
              'ORDER_NOT_AVAILABLE'
            );
          }

          if (
            !isRiderVisibleScheduledOrder(
              order
            )
          ) {
            throw new Error(
              'ORDER_PAYMENT_NOT_CONFIRMED'
            );
          }

          if (
            !canRiderAcceptOrdersV4(
              riderResult.rider || {}
            )
          ) {
            throw new Error(
              'RIDER_NOT_ELIGIBLE'
            );
          }

          if (
            !riderMeetsOrderV4Requirements(
              riderResult.rider || {},
              order
            )
          ) {
            throw new Error(
              'RIDER_V4_QUALIFICATION_REQUIRED'
            );
          }

          if (
            !riderMatchesScheduledOrderAvailability(
              riderResult.rider || {},
              order
            )
          ) {
            throw new Error(
              'RIDER_SCHEDULE_NOT_MATCHED'
            );
          }

          const startMs =
            getScheduleTimestampMs(
              order.scheduledStartAtMs ||
              order.requestedScheduleAtMs
            );

          if (
            !startMs ||
            startMs <= Date.now()
          ) {
            throw new Error(
              'ORDER_SCHEDULE_EXPIRED'
            );
          }

          const nowMs = Date.now();

          const updateData = {
            status: 'scheduled_reserved',
            riderStatus: 'scheduled_reserved',
            scheduleStatus: 'reserved',
            reservedRiderId:
              identity.riderId,
            reservedRiderDocId:
              identity.riderDocId,
            reservedRiderPhone:
              identity.phone,
            reservedRiderName:
              riderResult.rider?.name ||
              riderResult.rider?.riderName ||
              '',
            scheduleReservedAtMs:
              nowMs,
            scheduleReservedAt:
              admin.firestore.FieldValue.serverTimestamp(),
            scheduleConfirmDueAtMs:
              Math.max(
                nowMs,
                startMs -
                  UBEE_SCHEDULE_CONFIRM_BEFORE_MS
              ),
            // 若小U是在接近預約時間才承接，至少保留一段實際可操作的確認時間，
            // 避免剛承接就因「30 分鐘未確認」規則立刻被釋放。
            scheduleConfirmationDeadlineAtMs:
              Math.max(
                startMs - 30 * 60 * 1000,
                Math.min(
                  startMs - 10 * 60 * 1000,
                  nowMs + 10 * 60 * 1000
                )
              ),
            scheduleConfirmationRequired:
              startMs - nowMs <=
                UBEE_SCHEDULE_CONFIRM_BEFORE_MS,
            updatedAt:
              admin.firestore.FieldValue.serverTimestamp(),
          };

          transaction.update(
            orderRef,
            updateData
          );

          reservedOrder = {
            ...order,
            ...updateData,
            id: safeOrderId,
          };
        }
      );

      orders[safeOrderId] =
        reservedOrder;

      try {
        await notifyCustomer(
          reservedOrder,
          createTextMessage(
            `📅 UBee 預約已成立\n\n` +
            `訂單編號：${safeOrderId}\n` +
            `預約時間：${reservedOrder.scheduleLabel || '-'}\n\n` +
            `已有小U提前承接這筆預約。任務前系統會再次確認小U是否可以準時執行。`
          )
        );
      } catch (_) {}

      return res.json({
        success: true,
        orderId: safeOrderId,
        status: 'scheduled_reserved',
        order: reservedOrder,
        message: '已成功預約承接這筆任務。',
      });
    } catch (error) {
      const code =
        String(error?.message || '');

      const map = {
        ORDER_NOT_FOUND:
          [404, '找不到此預約任務。'],
        ORDER_NOT_AVAILABLE:
          [409, '這筆預約任務已被其他小U承接或狀態已更新。'],
        ORDER_PAYMENT_NOT_CONFIRMED:
          [409, '此預約任務尚未符合承接條件。'],
        RIDER_NOT_ELIGIBLE:
          [403, '你的帳號目前無法承接任務，請先確認接單資格。'],
        RIDER_V4_QUALIFICATION_REQUIRED:
          [403, '你的資格目前不符合這筆任務。'],
        RIDER_SCHEDULE_NOT_MATCHED:
          [409, '這筆預約時間不在你設定的可接時段內。'],
        ORDER_SCHEDULE_EXPIRED:
          [409, '這筆預約時間已過，無法再提前承接。'],
      };

      const response =
        map[code] ||
        [500, '預約承接失敗，請稍後再試。'];

      return res
        .status(response[0])
        .json({
          success: false,
          code,
          message: response[1],
        });
    }
  }
);

app.post(
  '/api/rider/confirm-scheduled-order',
  riderAuthMiddleware,
  async (req, res) => {
    try {
      const {
        orderId,
        canExecute,
        lineUserId,
        phone,
        riderId,
      } = req.body || {};

      const riderResult =
        await resolveScheduleRiderForRequest(
          req,
          { lineUserId, phone, riderId }
        );

      if (!riderResult.ok) {
        return res
          .status(riderResult.statusCode)
          .json({
            success: false,
            message: riderResult.message,
          });
      }

      const safeOrderId =
        String(orderId || '')
          .trim()
          .toUpperCase();

      const identity =
        buildRiderApiIdentity(
          riderResult.riderDoc,
          riderResult.rider || {},
          {
            lineUserId,
            phone,
            riderId,
          }
        );

      const orderRef =
        db.collection('orders').doc(safeOrderId);

      const orderDoc =
        await orderRef.get();

      if (!orderDoc.exists) {
        return res.status(404).json({
          success: false,
          message: '找不到此預約任務。',
        });
      }

      const order = {
        id: orderDoc.id,
        ...orderDoc.data(),
      };

      if (
        String(
          order.reservedRiderDocId || ''
        ).trim() !== identity.riderDocId
      ) {
        return res.status(403).json({
          success: false,
          message: '這筆預約不是由目前的小U承接。',
        });
      }

      if (
        ![
          'scheduled_reserved',
          'scheduled_confirmed',
        ].includes(
          String(order.status || '').trim()
        )
      ) {
        return res.status(409).json({
          success: false,
          message: '這筆預約狀態已更新，請重新整理。',
        });
      }

      if (canExecute === false) {
        const startMs =
          getScheduleTimestampMs(
            order.scheduledStartAtMs
          );

        const updated =
          await releaseScheduledReservation(
            order,
            'rider_declined_final_confirmation',
            {
              emergency:
                startMs > 0 &&
                Date.now() >=
                  startMs -
                    UBEE_SCHEDULE_EMERGENCY_BEFORE_MS,
            }
          );

        try {
          await notifyCustomer(
            order,
            createTextMessage(
              `📅 UBee 預約任務正在重新媒合\n\n` +
              `訂單編號：${safeOrderId}\n` +
              `原承接小U臨時無法執行，系統已立即尋找候補小U。`
            )
          );
        } catch (_) {}

        return res.json({
          success: true,
          order: updated,
          message: '已回報無法執行，系統會重新媒合候補小U。',
        });
      }

      const nowMs = Date.now();

      const updateData = {
        status: 'scheduled_confirmed',
        riderStatus: 'scheduled_confirmed',
        scheduleStatus: 'confirmed',
        scheduleConfirmationRequired: false,
        riderConfirmedAtMs: nowMs,
        riderConfirmedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      };

      await orderRef.set(
        updateData,
        { merge: true }
      );

      const updatedOrder = {
        ...order,
        ...updateData,
        id: safeOrderId,
      };

      orders[safeOrderId] =
        updatedOrder;

      try {
        await notifyCustomer(
          updatedOrder,
          createTextMessage(
            `✅ 小U已確認 UBee 預約任務\n\n` +
            `訂單編號：${safeOrderId}\n` +
            `預約時間：${updatedOrder.scheduleLabel || '-'}\n\n` +
            `小U已完成任務前確認，請留意後續出發與取件進度。`
          )
        );
      } catch (_) {}

      return res.json({
        success: true,
        order: updatedOrder,
        status: 'scheduled_confirmed',
        message: '已確認可以準時執行。',
      });
    } catch (error) {
      console.error(
        '確認預約任務失敗：',
        error
      );

      return res.status(500).json({
        success: false,
        message: '確認預約任務失敗。',
      });
    }
  }
);

// 3. 取得騎士目前進行中任務：手機登入正式版
// 支援 phone / riderId，並保留 lineUserId 相容
app.get('/api/rider/current-order', riderAuthMiddleware, async (req, res) => {
  try {
    const { lineUserId, phone, riderId } = req.query || {};

    const riderResult = await findApprovedRiderForApi({
      lineUserId,
      phone,
      riderId,
    });

    if (!riderResult.ok) {
      return res.status(riderResult.statusCode).json({
        success: false,
        message: riderResult.message,
      });
    }

    const riderDoc = riderResult.riderDoc;
    const rider = riderResult.rider || {};
    const identity = buildRiderApiIdentity(riderDoc, rider, {
      lineUserId,
      phone,
      riderId,
    });

    const activeStatuses = [
      'accepted',
      'going_to_pickup',
      'arrived_pickup',
      'picked_up',
      'going_to_dropoff',
      'arrived_dropoff',
    ];

    async function returnOrderIfActive(orderId) {
      const safeOrderId = String(orderId || '').trim().toUpperCase();
      if (!safeOrderId) return null;

      const orderDoc = await db.collection('orders').doc(safeOrderId).get();
      if (!orderDoc.exists) return null;

      const order = {
        id: orderDoc.id,
        ...orderDoc.data(),
      };

      if (!activeStatuses.includes(String(order.status || '').trim())) {
        return null;
      }

      if (!isOrderBelongsToRider(order, identity)) {
        return null;
      }

      return order;
    }

    // 第一優先：騎士資料上的 currentOrderId
    const directOrder = await returnOrderIfActive(rider.currentOrderId);
    if (directOrder) {
      await riderDoc.ref.set({
        busy: true,
        currentOrderId: directOrder.id,
        activeTrackingOrderId: directOrder.id,
        taskTrackingStatus: 'live',
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeenAtMs: Date.now(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return res.json({
        success: true,
        hasOrder: true,
        order: directOrder,
        recoverySource: 'rider_current_order_id',
      });
    }

    // 第二優先：從 orders 反查，不使用複合索引，避免 Firestore index 問題
    const queryFields = [
      ['riderDocId', identity.riderDocId],
      ['riderId', identity.riderId],
      ['riderPhone', identity.phone],
      ['riderLineUserId', identity.lineUserId],
    ].filter(([, value]) => !!value);

    for (const [field, value] of queryFields) {
      const snap = await db.collection('orders')
        .where(field, '==', value)
        .limit(80)
        .get();

      const found = snap.docs
        .map(doc => ({
          id: doc.id,
          ...doc.data(),
        }))
        .find(order => {
          const status = String(order.status || '').trim();
          return activeStatuses.includes(status) && isOrderBelongsToRider(order, identity);
        });

      if (found) {
        // riders.currentOrderId 遺失或不同步時，自動修復，讓重新開啟騎士端仍能找回任務。
        await riderDoc.ref.set({
          busy: true,
          currentOrderId: found.id,
          activeTrackingOrderId: found.id,
          taskTrackingStatus: 'live',
          lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
          lastSeenAtMs: Date.now(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        return res.json({
          success: true,
          hasOrder: true,
          order: found,
          recoverySource: `orders_${field}`,
        });
      }
    }

    // 已確認所有歸屬欄位都沒有進行中任務，才清理 riders 上的殘留 busy/currentOrderId。
    if (rider.busy === true || rider.currentOrderId) {
      await riderDoc.ref.set({
        busy: false,
        currentOrderId: '',
        activeTrackingOrderId: '',
        activeTrackingSessionId: '',
        taskTrackingStatus: 'idle',
        taskTrackingStopReason: 'no_active_order_found',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    return res.json({
      success: true,
      hasOrder: false,
      order: null,
      recoverySource: 'none',
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

// 3. 騎士今日 / 累積統計：手機登入正式版
// 支援 phone / riderId，並保留 lineUserId 舊版相容
app.get('/api/rider/summary', riderAuthMiddleware, async (req, res) => {
  try {
    const {
      lineUserId,
      phone,
      riderId,
    } = req.query || {};

    // ==============================
    // 1. 驗證騎士身分
    // ==============================
    const riderResult = await findApprovedRiderForApi({
      lineUserId,
      phone,
      riderId,
    });

    if (!riderResult.ok) {
      return res.status(riderResult.statusCode).json({
        success: false,
        message: riderResult.message,
      });
    }

    const riderDoc = riderResult.riderDoc;
    const rider = riderResult.rider || {};

    const identity = buildRiderApiIdentity(
      riderDoc,
      rider,
      {
        lineUserId,
        phone,
        riderId,
      }
    );

    // ==============================
    // 2. 台灣時間區間
    // Asia/Taipei 固定 UTC+8
    // ==============================
    const TAIPEI_OFFSET_MS =
      8 * 60 * 60 * 1000;

    const nowMs = Date.now();

    const taipeiNow = new Date(
      nowMs + TAIPEI_OFFSET_MS
    );

    const year =
      taipeiNow.getUTCFullYear();

    const month =
      taipeiNow.getUTCMonth();

    const date =
      taipeiNow.getUTCDate();

    const todayStartMs =
      Date.UTC(
        year,
        month,
        date,
        0,
        0,
        0,
        0
      ) - TAIPEI_OFFSET_MS;

    const tomorrowStartMs =
      Date.UTC(
        year,
        month,
        date + 1,
        0,
        0,
        0,
        0
      ) - TAIPEI_OFFSET_MS;

    // 最近 7 天，包含今天
    const weekStartMs =
      Date.UTC(
        year,
        month,
        date - 6,
        0,
        0,
        0,
        0
      ) - TAIPEI_OFFSET_MS;

    // 本月第一天
    const monthStartMs =
      Date.UTC(
        year,
        month,
        1,
        0,
        0,
        0,
        0
      ) - TAIPEI_OFFSET_MS;

    // ==============================
    // 3. 訂單時間轉毫秒
    // 支援 Firestore Timestamp /
    // number / string
    // ==============================
    function getOrderTimeMs(order) {
      if (!order) return 0;

      const timeCandidates = [
        order.completedAt,

        order.statusTimes &&
        order.statusTimes.completed,

        order.finishedAt,
        order.deliveredAt,
        order.updatedAt,
        order.createdAt,
      ];

      for (const value of timeCandidates) {
        if (!value) continue;

        if (
          typeof value.toDate === 'function'
        ) {
          return value.toDate().getTime();
        }

        if (
          typeof value.seconds === 'number'
        ) {
          return value.seconds * 1000;
        }

        if (
          typeof value._seconds === 'number'
        ) {
          return value._seconds * 1000;
        }

        if (typeof value === 'number') {
          return value;
        }

        if (typeof value === 'string') {
          const parsed =
            new Date(value).getTime();

          if (Number.isFinite(parsed)) {
            return parsed;
          }
        }
      }

      return 0;
    }

    // ==============================
    // 4. 整理查詢條件
    //
    // 不使用複合索引：
    // 分別查 riderDocId / riderId /
    // riderPhone / riderLineUserId
    //
    // 最後再去重複
    // ==============================
    const queryPairs = [];

    function addQueryPair(field, value) {
      const safeValue =
        String(value || '').trim();

      if (!safeValue) return;

      const exists =
        queryPairs.some(
          ([oldField, oldValue]) =>
            oldField === field &&
            oldValue === safeValue
        );

      if (!exists) {
        queryPairs.push([
          field,
          safeValue,
        ]);
      }
    }

    addQueryPair(
      'riderDocId',
      identity.riderDocId
    );

    addQueryPair(
      'riderId',
      identity.riderId
    );

    addQueryPair(
      'riderPhone',
      identity.phone
    );

    addQueryPair(
      'riderLineUserId',
      identity.lineUserId
    );

    // 舊版相容：
    // 過去有些訂單可能把 LINE userId
    // 寫在 riderId
    if (identity.lineUserId) {
      addQueryPair(
        'riderId',
        identity.lineUserId
      );

      addQueryPair(
        'driverId',
        identity.lineUserId
      );
    }

    // driverId 舊欄位相容
    if (identity.riderId) {
      addQueryPair(
        'driverId',
        identity.riderId
      );
    }

    // ==============================
    // 5. 查詢所有屬於這名騎士的訂單
    // ==============================
    const completedOrderMap =
      new Map();

    for (const [field, value] of queryPairs) {
      try {
        const snap = await db
          .collection('orders')
          .where(field, '==', value)
          .limit(500)
          .get();

        snap.docs.forEach(doc => {
          const order = {
            id: doc.id,
            ...doc.data(),
          };

          const status =
            String(
              order.status || ''
            )
              .trim()
              .toLowerCase();

          const isCompleted =
            status === 'completed' ||
            status === 'done';

          if (!isCompleted) {
            return;
          }

          // 再次確認訂單真的屬於這名騎士
          if (
            !isOrderBelongsToRider(
              order,
              identity
            )
          ) {
            // 舊版 riderId = LINE userId 相容
            const oldOrderRiderId =
              String(
                order.riderId ||
                order.driverId ||
                ''
              ).trim();

            if (
              !identity.lineUserId ||
              oldOrderRiderId !==
                identity.lineUserId
            ) {
              return;
            }
          }

          completedOrderMap.set(
            doc.id,
            order
          );
        });

      } catch (queryErr) {
        console.warn(
          `⚠️ 騎士統計查詢失敗 field=${field}:`,
          queryErr.message
        );
      }
    }

    const completedOrders =
      Array.from(
        completedOrderMap.values()
      );

    // ==============================
    // 6. 統計初始化
    // ==============================
    let todayCompleted = 0;
    let todayIncome = 0;

    let totalCompleted = 0;
    let totalIncome = 0;

    let weekIncome = 0;
    let monthIncome = 0;

    let pendingIncome = 0;
    let settledIncome = 0;

    let platformIncome = 0;

    // 現金單
    let cashCollectedTotal = 0;
    let cashDueToPlatform = 0;

    // 非現金單：
    // 平台尚未撥給騎士的總額
    let riderReceivable = 0;

    // ==============================
    // 7. 開始統計
    // ==============================
    completedOrders.forEach(order => {
      totalCompleted += 1;

      // ------------------------------
// 代墊款
// 不列入騎士收入
// ------------------------------
const advancePayment =
  getOrderAdvancePaymentAmount(order);

// ------------------------------
// 客人實際應付總額
// 含代墊
// ------------------------------
const customerTotal =
  getOrderCustomerPayableTotal(order);

// ------------------------------
// 服務費小計
// 不含代墊
// ------------------------------
const directServiceSubtotal =
  getOrderMoneyValue(
    order,
    [
      'serviceSubtotal',
      'serviceTotal',
      'deliveryServiceFee',
      'taskServiceFee',
    ]
  );

const serviceSubtotal =
  directServiceSubtotal !== null
    ? directServiceSubtotal
    : Math.max(
        0,
        customerTotal -
        advancePayment
      );

// ------------------------------
// 騎士收入
//
// 第一優先：使用訂單已儲存的正式騎士收入
//
// 第二優先：如果是舊訂單沒有 driverFee / riderFee，
// 就從 taskSubtotal 或費用明細重新計算
// ------------------------------
const directRiderIncome =
  getOrderMoneyValue(
    order,
    [
      'driverFee',
      'riderFee',
      'riderIncome',
      'riderEarning',
      'riderPayout',
      'riderShare',
      'fee',
    ]
  );

const directTaskSubtotal =
  getOrderMoneyValue(
    order,
    [
      'taskSubtotal',
    ]
  );

const fallbackTaskSubtotal =
  Math.max(
    0,
    Math.round(Number(order.deliveryFee || 0))
  ) +
  Math.max(
    0,
    Math.round(Number(order.speedFee || 0))
  ) +
  Math.max(
    0,
    Math.round(Number(order.upstairsFee || 0))
  ) +
  Math.max(
    0,
    Math.round(Number(order.waitingFee || 0))
  );

const platformServiceFee =
  getOrderMoneyValue(
    order,
    [
      'platformServiceFee',
      'serviceFee',
    ]
  ) || 0;

const calculatedTaskSubtotal =
  directTaskSubtotal !== null
    ? directTaskSubtotal
    : (
        fallbackTaskSubtotal > 0
          ? fallbackTaskSubtotal
          : Math.max(
              0,
              serviceSubtotal -
              platformServiceFee
            )
      );

const fallbackRiderIncome =
  Math.round(
    calculatedTaskSubtotal *
    Number(PRICING.driverRatio || 0.7)
  );

const riderIncome =
  directRiderIncome !== null
    ? directRiderIncome
    : fallbackRiderIncome;

      // ------------------------------
      // 平台收入
      //
      // 新正式規則：
      // 任務費 30%
      // +
      // 完整平台服務費
      // ------------------------------
      const directPlatformIncome =
        getOrderMoneyValue(
          order,
          [
            'platformFee',
            'platformIncome',
          ]
        );

      const orderPlatformIncome =
        directPlatformIncome !== null
          ? directPlatformIncome
          : Math.max(
              0,
              serviceSubtotal -
              riderIncome
            );

      // ------------------------------
      // 累積收入
      // ------------------------------
      totalIncome += riderIncome;

      platformIncome +=
        orderPlatformIncome;

            // ------------------------------
      // 判斷付款方式與結算狀態
      // ------------------------------
      const isCashOrder =
        isCashPaymentOrder(order);

      const cashRemittanceSettled =
        isCashOrder &&
        isCashRemittanceSettled(order);

      const settlementStatus =
        String(
          order.settlementStatus ||
          'pending'
        )
          .trim()
          .toLowerCase();

      // ==============================
      // 現金單
      //
      // 只有尚未回繳的平台款項，
      // 才會顯示在騎士錢包中。
      // ==============================
      if (isCashOrder) {
        if (!cashRemittanceSettled) {
          // 騎士目前尚未結算的現金總額
          cashCollectedTotal +=
            customerTotal;

          // 騎士目前應回繳給平台的金額
          cashDueToPlatform +=
            getOrderCashDueToPlatformAmount(
              order,
              orderPlatformIncome
            );
        }
      }

      // ==============================
      // 街口支付單
      //
      // 財務中心正式規則：
      // 平台待撥款只統計已付款確認的街口支付訂單。
      // 應撥金額 = 騎士收入 + 騎士代墊款。
      // 其他非現金類型不混入「街口待撥款」。
      // ==============================
      else if (isFinancePlatformPayoutOrder(order)) {
        if (
          settlementStatus === 'settled'
        ) {
          settledIncome +=
            riderIncome;

        } else {
          pendingIncome +=
            riderIncome;

          riderReceivable +=
            riderIncome +
            advancePayment;
        }
      }

      // ------------------------------
      // 完成時間
      // ------------------------------
      const completedAtMs =
        getOrderTimeMs(order);

      if (!completedAtMs) {
        return;
      }

      // 今日
      if (
        completedAtMs >= todayStartMs &&
        completedAtMs <
          tomorrowStartMs
      ) {
        todayCompleted += 1;
        todayIncome += riderIncome;
      }

      // 最近 7 天
      if (
        completedAtMs >= weekStartMs &&
        completedAtMs <
          tomorrowStartMs
      ) {
        weekIncome += riderIncome;
      }

      // 本月
      if (
        completedAtMs >= monthStartMs &&
        completedAtMs <
          tomorrowStartMs
      ) {
        monthIncome += riderIncome;
      }
    });

    // ==============================
    // 8. 回傳正式統計資料
    // ==============================
    return res.json({
      success: true,

      rider: {
        id: riderDoc.id,

        riderId:
          rider.riderId ||
          riderDoc.id,

        name:
          rider.name ||
          rider.riderName ||
          '',

        phone:
          normalizePhone(
            rider.phone ||
            riderDoc.id ||
            ''
          ),

        lineUserId:
          rider.lineUserId ||
          identity.lineUserId ||
          '',

        vehicle:
          rider.vehicle ||
          '',

        plateNumber:
          rider.plateNumber ||
          rider.plateNo ||
          rider.licensePlate ||
          '',

        serviceArea:
          rider.serviceArea ||
          rider.area ||
          '',

        approved:
          rider.approved === true ||
          rider.status === 'approved',

        status:
          rider.status ||
          '',

        online:
          rider.online === true,

        busy:
          rider.busy === true,

        currentOrderId:
          rider.currentOrderId ||
          '',
      },

      summary: {
        // 今日
        todayCompleted,
        todayIncome,

        // 累積
        totalCompleted,
        totalIncome,

        // 期間統計
        weekIncome,
        monthIncome,

        // 非現金單結算
        pendingIncome,
        settledIncome,

        // 平台收入
        platformIncome,

        // ============================
        // 現金單錢包
        // ============================
        cashCollectedTotal,

        // rider.html 相容名稱
        cashGrossCollected:
          cashCollectedTotal,

        cashCollectedAmount:
          cashCollectedTotal,

        cashCollected:
          cashCollectedTotal,

        cashReceived:
          cashCollectedTotal,

        // 騎士應回繳平台
        cashDueToPlatform,

        platformReceivable:
          cashDueToPlatform,

        riderDueToPlatform:
          cashDueToPlatform,

        // ============================
        // 平台尚未撥給騎士
        // ============================
        riderReceivable,

        platformPayableToRider:
          riderReceivable,

        // 舊版相容名稱
        platformPayToRider:
          riderReceivable,
      },
    });

  } catch (err) {
    console.error(
      '❌ 取得騎士統計失敗：',
      err
    );

    return res.status(500).json({
      success: false,
      message:
        '取得騎士統計失敗，請稍後再試。',
      error: err.message,
    });
  }
});

// ============================================================
// UBee 財務結算中心 V2：共用工具
// - 現金：小U -> UBee（回繳）
// - 街口：UBee -> 小U（騎士收入 + 騎士代墊）
// - 僅整理財務視圖與結算，不改動既有派單／付款／騎士審核流程
// ============================================================
function financeToMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  return 0;
}

function getFinanceCompletedAtMs(order = {}) {
  return (
    financeToMs(order.completedAt) ||
    financeToMs(order.finishedAt) ||
    financeToMs(order.completedAtMs) ||
    financeToMs(order.updatedAt) ||
    financeToMs(order.createdAt)
  );
}

function getFinanceRiderIdentity(order = {}) {
  const riderDocId = String(order.riderDocId || '').trim();
  const riderId = String(
    order.riderId ||
    order.driverId ||
    order.riderLineUserId ||
    ''
  ).trim();
  const riderPhone = normalizePhone(
    order.riderPhone ||
    order.driverPhone ||
    ''
  );
  const riderLineUserId = String(order.riderLineUserId || '').trim();
  const riderName = String(
    order.riderName ||
    order.driverName ||
    '未設定小U姓名'
  ).trim();

  return {
    riderKey:
      riderDocId ||
      riderId ||
      riderPhone ||
      riderLineUserId ||
      '',
    riderDocId,
    riderId,
    riderPhone,
    riderLineUserId,
    riderName,
  };
}

function isFinancePaidJkoOrder(order = {}) {
  const paymentMethod = getOrderPaymentMethod(order);
  const paymentStatus = getOrderPaymentStatus(order);

  return (
    String(order.status || '').trim().toLowerCase() === 'completed' &&
    (
      paymentMethod === 'jko' ||
      paymentMethod === 'jkopay' ||
      paymentMethod === 'jko_pay' ||
      paymentMethod.includes('jko') ||
      paymentMethod.includes('街口')
    ) &&
    (
      paymentStatus === 'paid_confirmed' ||
      paymentStatus === 'paid' ||
      order.isPaid === true
    ) &&
    order.isCashOrder !== true
  );
}

function isFinancePaidMerchantOrder(order = {}) {
  const status = String(order.status || '').trim().toLowerCase();
  const paymentMethod = getOrderPaymentMethod(order);
  const billingStatus = String(
    order.merchantBillingStatus || ''
  ).trim().toLowerCase();
  const orderType = String(order.orderType || '').trim().toLowerCase();
  const source = String(order.source || '').trim().toLowerCase();
  const deliveryType = String(order.deliveryType || '').trim().toLowerCase();

  const isMerchantOrder =
    orderType === 'merchant_dispatch' ||
    orderType === 'merchant_delivery' ||
    source === 'merchant-dashboard' ||
    source === 'merchant';

  const isMerchantPayment =
    paymentMethod === 'merchant_settlement' ||
    paymentMethod === 'merchant_paid' ||
    paymentMethod === 'merchant';

  return (
    status === 'completed' &&
    isMerchantOrder &&
    isMerchantPayment &&
    deliveryType !== 'merchant' &&
    billingStatus === 'paid' &&
    order.isCashOrder !== true
  );
}

function isFinancePlatformPayoutOrder(order = {}) {
  return (
    isFinancePaidJkoOrder(order) ||
    isFinancePaidMerchantOrder(order)
  );
}

function getFinancePlatformPaymentMeta(order = {}) {
  if (isFinancePaidMerchantOrder(order)) {
    return {
      paymentMethod: getOrderPaymentMethod(order) || 'merchant_settlement',
      paymentMethodLabel:
        order.paymentMethodLabel ||
        (getOrderPaymentMethod(order) === 'merchant_paid'
          ? '店家已付款'
          : '店家月結已入帳'),
      settlementPaymentMethod: 'merchant',
    };
  }

  return {
    paymentMethod: 'jko',
    paymentMethodLabel: '街口支付',
    settlementPaymentMethod: 'jko',
  };
}

function getFinanceJkoAmounts(order = {}) {
  const riderIncome =
    getOrderMoneyValue(order, [
      'riderFee',
      'driverFee',
      'riderIncome',
      'riderEarning',
      'riderPayout',
      'riderShare',
      'fee',
    ]) || 0;

  const advancePayment =
    getOrderAdvancePaymentAmount(order);

  return {
    riderIncome: Math.max(0, Math.round(riderIncome)),
    advancePayment: Math.max(0, Math.round(advancePayment)),
    payoutTotal: Math.max(
      0,
      Math.round(riderIncome + advancePayment)
    ),
  };
}

function getFinanceCashAmounts(order = {}) {
  const customerTotal =
    getOrderCustomerPayableTotal(order);

  const riderIncome =
    getOrderMoneyValue(order, [
      'riderFee',
      'driverFee',
      'riderIncome',
      'riderEarning',
      'riderPayout',
      'riderShare',
      'fee',
      'price',
    ]) || 0;

  const advancePayment =
    getOrderAdvancePaymentAmount(order);

  const fallbackPlatformDue = Math.max(
    0,
    Math.round(
      customerTotal -
      advancePayment -
      riderIncome
    )
  );

  const cashDueToPlatform =
    getOrderCashDueToPlatformAmount(
      order,
      fallbackPlatformDue
    );

  return {
    customerTotal: Math.max(0, Math.round(customerTotal)),
    riderIncome: Math.max(0, Math.round(riderIncome)),
    advancePayment: Math.max(0, Math.round(advancePayment)),
    cashDueToPlatform: Math.max(0, Math.round(cashDueToPlatform)),
  };
}

// ============================================================
// UBee 財務結算中心 V2：總覽／異常／結算紀錄
// ============================================================
app.get('/api/admin/finance-overview', async (req, res) => {
  try {
    const snap = await db
      .collection('orders')
      .limit(1000)
      .get();

    const nowMs = Date.now();
    const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
    const taipeiNow = new Date(nowMs + TAIPEI_OFFSET_MS);
    const todayStartMs = Date.UTC(
      taipeiNow.getUTCFullYear(),
      taipeiNow.getUTCMonth(),
      taipeiNow.getUTCDate(),
      0, 0, 0, 0
    ) - TAIPEI_OFFSET_MS;
    const tomorrowStartMs = todayStartMs + 24 * 60 * 60 * 1000;

    let todayCompletedOrders = 0;
    let cashPendingTotal = 0;
    let jkoPendingTotal = 0;
    let todayCashRemitted = 0;
    let todayRiderPaid = 0;

    const cashRiderKeys = new Set();
    const jkoRiderKeys = new Set();
    const alerts = [];
    const history = [];

    snap.forEach(doc => {
      const order = {
        id: doc.id,
        ...doc.data(),
      };

      const orderStatus = String(order.status || '')
        .trim()
        .toLowerCase();
      const isCompleted =
        orderStatus === 'completed' ||
        orderStatus === 'done';

      const completedAtMs =
        getFinanceCompletedAtMs(order);

      if (
        isCompleted &&
        completedAtMs >= todayStartMs &&
        completedAtMs < tomorrowStartMs
      ) {
        todayCompletedOrders += 1;
      }

      const rider = getFinanceRiderIdentity(order);
      const riderLabel =
        rider.riderName ||
        rider.riderId ||
        rider.riderDocId ||
        '未設定小U';

      // ------------------------------
      // 現金待回繳
      // ------------------------------
      if (
        isCompleted &&
        isCashPaymentOrder(order)
      ) {
        const cashAmounts =
          getFinanceCashAmounts(order);

        if (!isCashRemittanceSettled(order)) {
          if (cashAmounts.cashDueToPlatform > 0) {
            cashPendingTotal +=
              cashAmounts.cashDueToPlatform;

            if (rider.riderKey) {
              cashRiderKeys.add(rider.riderKey);
            }

            const ageMs = completedAtMs
              ? Math.max(0, nowMs - completedAtMs)
              : 0;

            if (
              cashAmounts.cashDueToPlatform >= 5000 ||
              ageMs >= 24 * 60 * 60 * 1000 ||
              !rider.riderKey
            ) {
              alerts.push({
                id: `cash_${doc.id}`,
                type: 'cash_remittance',
                severity:
                  cashAmounts.cashDueToPlatform >= 10000 ||
                  ageMs >= 72 * 60 * 60 * 1000
                    ? 'critical'
                    : 'warning',
                title:
                  !rider.riderKey
                    ? '現金回繳缺少小U識別資料'
                    : cashAmounts.cashDueToPlatform >= 5000
                      ? '高額現金待回繳'
                      : '現金回繳等待時間偏長',
                message:
                  `${riderLabel}｜訂單 ${order.orderNo || doc.id}｜` +
                  `待回繳 NT$${cashAmounts.cashDueToPlatform.toLocaleString('zh-TW')}`,
                orderId: doc.id,
                riderName: riderLabel,
                amount: cashAmounts.cashDueToPlatform,
                ageMs,
                createdAtMs: completedAtMs,
              });
            }
          }
        } else {
          const settledAtMs =
            financeToMs(order.cashRemittedAtMs) ||
            financeToMs(order.cashRemittedAt) ||
            financeToMs(order.financialUpdatedAtMs) ||
            financeToMs(order.financialUpdatedAt);

          const amount =
            getOrderMoneyValue(order, [
              'cashRemittedAmount',
              'cashDueToPlatform',
              'platformReceivable',
              'riderDueToPlatform',
            ]) ||
            cashAmounts.cashDueToPlatform;

          if (
            settledAtMs >= todayStartMs &&
            settledAtMs < tomorrowStartMs
          ) {
            todayCashRemitted += amount;
          }

          if (settledAtMs) {
            history.push({
              id: `cash_${doc.id}`,
              type: 'cash_remittance',
              typeLabel: '現金回繳',
              direction: 'rider_to_platform',
              orderId: doc.id,
              orderNo: order.orderNo || doc.id,
              riderName: riderLabel,
              riderId: rider.riderId || rider.riderDocId || '',
              amount,
              processedBy: order.cashRemittedBy || '',
              processedAtMs: settledAtMs,
            });
          }
        }
      }

      // ------------------------------
      // 街口待撥款／已撥款
      // ------------------------------
      if (isFinancePlatformPayoutOrder(order)) {
        const jkoAmounts =
          getFinanceJkoAmounts(order);

        const settlementStatus = String(
          order.settlementStatus || 'pending'
        )
          .trim()
          .toLowerCase();

        if (settlementStatus !== 'settled') {
          if (jkoAmounts.payoutTotal > 0) {
            jkoPendingTotal +=
              jkoAmounts.payoutTotal;

            if (rider.riderKey) {
              jkoRiderKeys.add(rider.riderKey);
            }

            const ageMs = completedAtMs
              ? Math.max(0, nowMs - completedAtMs)
              : 0;

            if (
              jkoAmounts.payoutTotal >= 5000 ||
              ageMs >= 24 * 60 * 60 * 1000 ||
              !rider.riderKey
            ) {
              alerts.push({
                id: `jko_${doc.id}`,
                type: 'jko_payout',
                severity:
                  jkoAmounts.payoutTotal >= 10000 ||
                  ageMs >= 72 * 60 * 60 * 1000
                    ? 'critical'
                    : 'warning',
                title:
                  !rider.riderKey
                    ? '街口待撥款缺少小U識別資料'
                    : jkoAmounts.payoutTotal >= 5000
                      ? '高額街口待撥款'
                      : '街口待撥款等待時間偏長',
                message:
                  `${riderLabel}｜訂單 ${order.orderNo || doc.id}｜` +
                  `待撥 NT$${jkoAmounts.payoutTotal.toLocaleString('zh-TW')}`,
                orderId: doc.id,
                riderName: riderLabel,
                amount: jkoAmounts.payoutTotal,
                ageMs,
                createdAtMs: completedAtMs,
              });
            }
          }
        } else {
          const settledAtMs =
            financeToMs(order.settledAtMs) ||
            financeToMs(order.settledAt) ||
            financeToMs(order.financialUpdatedAtMs) ||
            financeToMs(order.financialUpdatedAt);

          const amount =
            getOrderMoneyValue(order, [
              'settledAmount',
              'platformPayableToRider',
              'riderReceivable',
            ]) ||
            jkoAmounts.payoutTotal;

          if (
            settledAtMs >= todayStartMs &&
            settledAtMs < tomorrowStartMs
          ) {
            todayRiderPaid += amount;
          }

          if (settledAtMs) {
            history.push({
              id: `jko_${doc.id}`,
              type: 'jko_payout',
              typeLabel: '街口撥款',
              direction: 'platform_to_rider',
              orderId: doc.id,
              orderNo: order.orderNo || doc.id,
              riderName: riderLabel,
              riderId: rider.riderId || rider.riderDocId || '',
              amount,
              processedBy: order.settledBy || '',
              processedAtMs: settledAtMs,
            });
          }
        }
      }
    });

    alerts.sort((a, b) => {
      const rank = {
        critical: 3,
        warning: 2,
        info: 1,
      };
      return (
        (rank[b.severity] || 0) -
        (rank[a.severity] || 0) ||
        Number(b.amount || 0) -
        Number(a.amount || 0)
      );
    });

    history.sort(
      (a, b) =>
        Number(b.processedAtMs || 0) -
        Number(a.processedAtMs || 0)
    );

    const pendingRiderKeys = new Set([
      ...cashRiderKeys,
      ...jkoRiderKeys,
    ]);

    return res.json({
      success: true,
      updatedAtMs: nowMs,
      summary: {
        todayCompletedOrders,
        cashPendingTotal: Math.round(cashPendingTotal),
        jkoPendingTotal: Math.round(jkoPendingTotal),
        pendingRiderCount: pendingRiderKeys.size,
        cashPendingRiderCount: cashRiderKeys.size,
        jkoPendingRiderCount: jkoRiderKeys.size,
        todayCashRemitted: Math.round(todayCashRemitted),
        todayRiderPaid: Math.round(todayRiderPaid),
        todayProcessedTotal: Math.round(
          todayCashRemitted + todayRiderPaid
        ),
        alertCount: alerts.length,
      },
      alerts: alerts.slice(0, 100),
      history: history.slice(0, 100),
    });
  } catch (err) {
    console.error('finance overview error:', err);
    return res.status(500).json({
      success: false,
      message: '讀取財務總覽失敗。',
      error: err.message,
    });
  }
});

// ============================================================
// UBee 財務結算中心 V2：街口待撥款
// 回傳「騎士收入 + 騎士代墊款」作為平台實際應撥總額
// ============================================================
app.get('/api/admin/pending-settlements', async (req, res) => {
  try {
    // 不要求 settlementStatus 欄位一定已存在，
    // 讓舊的已完成街口訂單也能由後端統一判斷是否待撥。
    const snap = await db
      .collection('orders')
      .where('status', '==', 'completed')
      .limit(500)
      .get();

    const orders = [];
    const riderMap = new Map();

    let pendingTotal = 0;
    let riderIncomeTotal = 0;
    let advancePaymentTotal = 0;

    snap.forEach(doc => {
      const order = {
        id: doc.id,
        ...doc.data(),
      };

      if (!isFinancePlatformPayoutOrder(order)) {
        return;
      }

      if (
        String(order.settlementStatus || 'pending')
          .trim()
          .toLowerCase() === 'settled'
      ) {
        return;
      }

      const amounts =
        getFinanceJkoAmounts(order);

      if (amounts.payoutTotal <= 0) {
        return;
      }

      const customerTotal =
        getOrderCustomerPayableTotal(order);

      const rider =
        getFinanceRiderIdentity(order);

      const riderKey =
        rider.riderKey ||
        `unknown_${doc.id}`;

      const paymentMeta =
        getFinancePlatformPaymentMeta(order);

      const item = {
        id: order.id,
        orderNo: order.orderNo || order.id,
        riderKey,
        riderId: rider.riderId,
        riderDocId: rider.riderDocId,
        riderPhone: rider.riderPhone,
        riderLineUserId: rider.riderLineUserId,
        riderName: rider.riderName,
        paymentMethod: paymentMeta.paymentMethod,
        paymentMethodLabel: paymentMeta.paymentMethodLabel,
        paymentStatus: getOrderPaymentStatus(order),
        riderFee: amounts.riderIncome,
        driverFee: amounts.riderIncome,
        fee: amounts.riderIncome,
        riderIncome: amounts.riderIncome,
        advancePayment: amounts.advancePayment,
        payoutTotal: amounts.payoutTotal,
        total: customerTotal,
        completedAt: order.completedAt || order.finishedAt || null,
        updatedAt: order.updatedAt || null,
      };

      orders.push(item);

      pendingTotal += amounts.payoutTotal;
      riderIncomeTotal += amounts.riderIncome;
      advancePaymentTotal += amounts.advancePayment;

      if (!riderMap.has(riderKey)) {
        riderMap.set(riderKey, {
          riderKey,
          riderId: rider.riderId,
          riderDocId: rider.riderDocId,
          riderPhone: rider.riderPhone,
          riderLineUserId: rider.riderLineUserId,
          riderName: rider.riderName,
          riderIncomeTotal: 0,
          advancePaymentTotal: 0,
          payoutTotal: 0,
          orderCount: 0,
          orderIds: [],
          orders: [],
        });
      }

      const group = riderMap.get(riderKey);
      group.riderIncomeTotal += amounts.riderIncome;
      group.advancePaymentTotal += amounts.advancePayment;
      group.payoutTotal += amounts.payoutTotal;
      group.orderCount += 1;
      group.orderIds.push(order.id);
      group.orders.push(item);
    });

    orders.sort(
      (a, b) =>
        getFinanceCompletedAtMs(b) -
        getFinanceCompletedAtMs(a)
    );

    const riders = Array.from(riderMap.values());

    riders.forEach(rider => {
      rider.riderIncomeTotal = Math.round(rider.riderIncomeTotal);
      rider.advancePaymentTotal = Math.round(rider.advancePaymentTotal);
      rider.payoutTotal = Math.round(rider.payoutTotal);
      rider.orders.sort(
        (a, b) =>
          getFinanceCompletedAtMs(b) -
          getFinanceCompletedAtMs(a)
      );
    });

    riders.sort(
      (a, b) =>
        Number(b.payoutTotal || 0) -
        Number(a.payoutTotal || 0)
    );

    return res.json({
      success: true,
      pendingTotal: Math.round(pendingTotal),
      riderIncomeTotal: Math.round(riderIncomeTotal),
      advancePaymentTotal: Math.round(advancePaymentTotal),
      count: orders.length,
      riderCount: riders.length,
      orders,
      riders,
    });
  } catch (err) {
    console.error('pending settlements error:', err);
    return res.status(500).json({
      success: false,
      message: '讀取待撥款資料失敗',
      error: err.message,
    });
  }
});

async function settleFinanceJkoOrders({
  orderIds = [],
  settledBy = 'finance_center',
} = {}) {
  const cleanOrderIds = Array.from(
    new Set(
      (Array.isArray(orderIds) ? orderIds : [])
        .map(value =>
          String(value || '')
            .trim()
            .toUpperCase()
        )
        .filter(Boolean)
    )
  );

  if (!cleanOrderIds.length) {
    const error = new Error('SETTLEMENT_ORDER_IDS_REQUIRED');
    error.statusCode = 400;
    throw error;
  }

  if (cleanOrderIds.length > 200) {
    const error = new Error('SETTLEMENT_TOO_MANY_ORDERS');
    error.statusCode = 400;
    throw error;
  }

  const refs = cleanOrderIds.map(orderId =>
    db.collection('orders').doc(orderId)
  );

  const docs = await Promise.all(
    refs.map(ref => ref.get())
  );

  const validOrders = [];
  const skippedOrders = [];

  let totalSettledAmount = 0;
  let totalRiderIncome = 0;
  let totalAdvancePayment = 0;

  docs.forEach((doc, index) => {
    const orderId = cleanOrderIds[index];

    if (!doc.exists) {
      skippedOrders.push({
        orderId,
        reason: 'order_not_found',
      });
      return;
    }

    const order = {
      id: doc.id,
      ...doc.data(),
    };

    if (!isFinancePlatformPayoutOrder(order)) {
      skippedOrders.push({
        orderId,
        reason: 'not_paid_jko_order',
      });
      return;
    }

    if (
      String(order.settlementStatus || 'pending')
        .trim()
        .toLowerCase() === 'settled'
    ) {
      skippedOrders.push({
        orderId,
        reason: 'already_settled',
      });
      return;
    }

    const amounts =
      getFinanceJkoAmounts(order);

    if (amounts.payoutTotal <= 0) {
      skippedOrders.push({
        orderId,
        reason: 'no_payout_amount',
      });
      return;
    }

    const paymentMeta =
      getFinancePlatformPaymentMeta(order);

    validOrders.push({
      ref: doc.ref,
      orderId,
      ...amounts,
      settlementPaymentMethod:
        paymentMeta.settlementPaymentMethod,
    });

    totalSettledAmount += amounts.payoutTotal;
    totalRiderIncome += amounts.riderIncome;
    totalAdvancePayment += amounts.advancePayment;
  });

  if (!validOrders.length) {
    const error = new Error('NO_SETTLEMENT_ORDERS');
    error.statusCode = 400;
    error.skippedOrders = skippedOrders;
    throw error;
  }

  const batch = db.batch();
  const nowMs = Date.now();
  const safeSettledBy = String(
    settledBy || 'finance_center'
  )
    .trim()
    .slice(0, 100);

  validOrders.forEach(item => {
    batch.set(
      item.ref,
      {
        settlementStatus: 'settled',
        settledAt:
          admin.firestore.FieldValue.serverTimestamp(),
        settledAtMs: nowMs,
        settledBy: safeSettledBy,
        // 正式應撥：騎士收入 + 騎士代墊
        settledAmount: item.payoutTotal,
        settledRiderIncome: item.riderIncome,
        settledAdvancePayment: item.advancePayment,
        settlementPaymentMethod: item.settlementPaymentMethod || 'jko',
        financialUpdatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        financialUpdatedAtMs: nowMs,
      },
      { merge: true }
    );
  });

  await batch.commit();

  return {
    settledOrderCount: validOrders.length,
    settledOrderIds: validOrders.map(item => item.orderId),
    totalSettledAmount: Math.round(totalSettledAmount),
    totalRiderIncome: Math.round(totalRiderIncome),
    totalAdvancePayment: Math.round(totalAdvancePayment),
    skippedOrderCount: skippedOrders.length,
    skippedOrders,
  };
}

// 單筆街口撥款：保留舊 API，相容既有財務中心／外部流程
app.post('/api/admin/settle-order', async (req, res) => {
  try {
    const orderId = String(
      req.body?.orderId || ''
    ).trim();

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: '缺少 orderId',
      });
    }

    const result = await settleFinanceJkoOrders({
      orderIds: [orderId],
      settledBy:
        req.body?.settledBy ||
        req.body?.operator ||
        'finance_center',
    });

    return res.json({
      success: true,
      message: '已完成街口撥款結算',
      orderId,
      settledAmount: result.totalSettledAmount,
      ...result,
    });
  } catch (err) {
    console.error('settle order error:', err);

    const messageMap = {
      SETTLEMENT_ORDER_IDS_REQUIRED: '缺少需要結算的訂單 ID。',
      SETTLEMENT_TOO_MANY_ORDERS: '單次最多只能結算 200 筆訂單。',
      NO_SETTLEMENT_ORDERS: '沒有可結算的街口支付訂單。',
    };

    return res
      .status(Number(err.statusCode || 500))
      .json({
        success: false,
        message:
          messageMap[err.message] ||
          '完成結算失敗',
        skippedOrders:
          err.skippedOrders || [],
        error: err.message,
      });
  }
});

// 批次街口撥款：財務中心可一次確認同一小U全部待撥訂單
app.post('/api/admin/settle-orders', async (req, res) => {
  try {
    const rawOrderIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds
      : [req.body?.orderId];

    const result = await settleFinanceJkoOrders({
      orderIds: rawOrderIds,
      settledBy:
        req.body?.settledBy ||
        req.body?.operator ||
        'finance_center',
    });

    return res.json({
      success: true,
      message: '街口待撥款已完成結算。',
      ...result,
    });
  } catch (err) {
    console.error('settle orders error:', err);

    const messageMap = {
      SETTLEMENT_ORDER_IDS_REQUIRED: '缺少需要結算的訂單 ID。',
      SETTLEMENT_TOO_MANY_ORDERS: '單次最多只能結算 200 筆訂單。',
      NO_SETTLEMENT_ORDERS: '沒有可結算的街口支付訂單。',
    };

    return res
      .status(Number(err.statusCode || 500))
      .json({
        success: false,
        message:
          messageMap[err.message] ||
          '批次結算失敗。',
        skippedOrders:
          err.skippedOrders || [],
        error: err.message,
      });
  }
});

// ==============================
// UBee 店家應收帳款 API
// ==============================

// 取得店家派單應收金額
function getMerchantReceivableAmount(order) {
  const amount = Number(
    order.merchantPayableAmount ||
    order.storePayableAmount ||
    order.merchantFee ||
    order.totalFee ||
    order.deliveryFee ||
    order.total ||
    0
  );

  return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0;
}

// 轉換 Firestore Timestamp / Date / number / string 成毫秒
function getMerchantReceivableTimeMs(value) {
  if (!value) return 0;

  if (typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }

  if (value._seconds) {
    return value._seconds * 1000;
  }

  if (value.seconds) {
    return value.seconds * 1000;
  }

  if (typeof value === 'number') {
    return value;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

// 判斷這筆訂單是不是可以列入「店家應收帳款」
function isMerchantReceivableOrder(order) {
  if (!order) return false;

  const status = String(order.status || '').trim().toLowerCase();
  const orderType = String(order.orderType || '').trim().toLowerCase();
  const source = String(order.source || '').trim().toLowerCase();
  const createdFrom = String(order.createdFrom || '').trim().toLowerCase();
  const deliveryType = String(order.deliveryType || '').trim().toLowerCase();
  const billingStatus = String(order.merchantBillingStatus || '').trim().toLowerCase();

  const isMerchantOrder =
    orderType === 'merchant_dispatch' ||
    orderType === 'merchant_delivery' ||
    source === 'merchant-dashboard' ||
    source === 'merchant' ||
    createdFrom === 'merchant-dashboard';
  
  const isCompleted =
    status === 'completed' ||
    status === 'done';

  const isUbeeDispatch =
    deliveryType !== 'merchant';

  const notCancelled =
    status !== 'merchant_cancelled' &&
    billingStatus !== 'not_billable';

  return (
    isMerchantOrder &&
    isCompleted &&
    isUbeeDispatch &&
    notCancelled
  );
}

// ===== UBee 財務中心：讀取騎士待回繳現金 =====

app.get(
  '/api/admin/cash-remittances',
  async (req, res) => {
    try {
      // 不使用複合索引：
      // 先取得已完成訂單，再由後端判斷付款方式與回繳狀態。
      const snap = await db
        .collection('orders')
        .where('status', '==', 'completed')
        .limit(500)
        .get();

      const riderMap = new Map();

      let totalCashCollected = 0;
      let totalDueToPlatform = 0;
      let pendingOrderCount = 0;

      snap.forEach(doc => {
        const order = {
          id: doc.id,
          ...doc.data(),
        };

        // 只處理現金訂單
        if (!isCashPaymentOrder(order)) {
          return;
        }

        // 已經完成回繳的訂單不再顯示
        if (isCashRemittanceSettled(order)) {
          return;
        }

        // ==============================
        // 客人實際交給騎士的現金總額
        // ==============================
        const customerTotal =
          getOrderMoneyValue(
            order,
            [
              'customerPayableTotal',
              'payableTotal',
              'finalTotal',
              'total',
              'riderDisplayTotal',
              'cashCollectAmount',
              'cashCollectedAmount',
              'cashGrossCollected',
            ]
          ) || 0;

        // ==============================
        // 騎士收入
        // ==============================
        const riderIncome =
          getOrderMoneyValue(
            order,
            [
              'riderFee',
              'driverFee',
              'riderIncome',
              'riderEarning',
              'riderPayout',
              'riderShare',
              'fee',
              'price',
            ]
          ) || 0;

        // ==============================
        // 騎士代墊金額
        // 這筆錢由騎士從客人現金中收回，
        // 不屬於平台應收。
        // ==============================
        const advancePayment =
          getOrderMoneyValue(
            order,
            [
              'advancePayment',
              'advanceAmount',
              'advancePay',
              'advanceFee',
              'cashAdvanceRecovered',
            ]
          ) || 0;

        // ==============================
        // 舊訂單沒有直接儲存平台應收時：
        //
        // 客人現金總額
        // - 騎士代墊款
        // - 騎士收入
        // = 騎士應繳回平台
        // ==============================
        const fallbackPlatformDue =
          Math.max(
            0,
            Math.round(
              customerTotal -
              advancePayment -
              riderIncome
            )
          );

        const cashDueToPlatform =
          getOrderCashDueToPlatformAmount(
            order,
            fallbackPlatformDue
          );

        // 沒有平台應收金額就不需要列入回繳清單
        if (cashDueToPlatform <= 0) {
          return;
        }

        // ==============================
        // 建立騎士分組識別
        // ==============================
        const riderDocId =
          String(
            order.riderDocId || ''
          ).trim();

        const riderId =
          String(
            order.riderId ||
            order.driverId ||
            ''
          ).trim();

        const riderPhone =
          normalizePhone(
            order.riderPhone ||
            order.driverPhone ||
            ''
          );

        const riderLineUserId =
          String(
            order.riderLineUserId ||
            order.lineUserId ||
            ''
          ).trim();

        const riderKey =
          riderDocId ||
          riderId ||
          riderPhone ||
          riderLineUserId ||
          `unknown_${doc.id}`;

        const riderName =
          String(
            order.riderName ||
            order.driverName ||
            '未設定騎士姓名'
          ).trim();

        if (!riderMap.has(riderKey)) {
          riderMap.set(
            riderKey,
            {
              riderKey,

              riderDocId,
              riderId,
              riderPhone,
              riderLineUserId,
              riderName,

              cashCollectedTotal: 0,
              cashDueToPlatform: 0,
              orderCount: 0,
              orderIds: [],
              orders: [],
            }
          );
        }

        const riderGroup =
          riderMap.get(riderKey);

        riderGroup.cashCollectedTotal +=
          customerTotal;

        riderGroup.cashDueToPlatform +=
          cashDueToPlatform;

        riderGroup.orderCount += 1;

        riderGroup.orderIds.push(
          doc.id
        );

        riderGroup.orders.push({
          id: doc.id,

          orderNo:
            order.orderNo ||
            doc.id,

          riderName,
          riderId,
          riderDocId,
          riderPhone,
          riderLineUserId,

          paymentMethod:
            getOrderPaymentMethod(order),

          customerTotal,
          riderIncome,
          advancePayment,
          cashDueToPlatform,

          cashRemittanceStatus:
            getOrderCashRemittanceStatus(
              order
            ),

          completedAt:
            order.completedAt ||
            order.finishedAt ||
            order.updatedAt ||
            null,
        });

        totalCashCollected +=
          customerTotal;

        totalDueToPlatform +=
          cashDueToPlatform;

        pendingOrderCount += 1;
      });

      const riders =
        Array.from(
          riderMap.values()
        );

      // 金額較高的騎士排在前面
      riders.sort(
        (a, b) =>
          Number(
            b.cashDueToPlatform || 0
          ) -
          Number(
            a.cashDueToPlatform || 0
          )
      );

      // 每名騎士的訂單以完成時間新到舊排列
      riders.forEach(rider => {
        rider.orders.sort(
          (a, b) => {
            const getTimeMs = value => {
              if (!value) {
                return 0;
              }

              if (
                typeof value.toDate ===
                'function'
              ) {
                return value
                  .toDate()
                  .getTime();
              }

              if (
                typeof value.seconds ===
                'number'
              ) {
                return (
                  value.seconds * 1000
                );
              }

              if (
                typeof value._seconds ===
                'number'
              ) {
                return (
                  value._seconds * 1000
                );
              }

              const parsed =
                new Date(value).getTime();

              return Number.isFinite(
                parsed
              )
                ? parsed
                : 0;
            };

            return (
              getTimeMs(b.completedAt) -
              getTimeMs(a.completedAt)
            );
          }
        );
      });

      return res.json({
        success: true,

        totalCashCollected:
          Math.round(
            totalCashCollected
          ),

        totalDueToPlatform:
          Math.round(
            totalDueToPlatform
          ),

        pendingOrderCount,

        riderCount:
          riders.length,

        riders,
      });

    } catch (err) {
      console.error(
        '❌ 讀取騎士待回繳現金失敗：',
        err
      );

      return res
        .status(500)
        .json({
          success: false,

          message:
            '讀取騎士待回繳現金失敗。',

          error:
            err.message,
        });
    }
  }
);

// ===== UBee 財務中心：確認騎士現金已回繳 =====

app.post(
  '/api/admin/cash-remittances/settle',
  async (req, res) => {
    try {
      const body =
        req.body &&
        typeof req.body === 'object'
          ? req.body
          : {};

      // 支援單筆 orderId，
      // 也支援財務中心一次傳入多筆 orderIds。
      const rawOrderIds = Array.isArray(
        body.orderIds
      )
        ? body.orderIds
        : [
            body.orderId,
          ];

      const orderIds =
        Array.from(
          new Set(
            rawOrderIds
              .map(value =>
                String(value || '')
                  .trim()
                  .toUpperCase()
              )
              .filter(Boolean)
          )
        );

      if (!orderIds.length) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              '缺少需要確認回繳的訂單 ID。',
          });
      }

      // 避免一次修改過多訂單，
      // 同時保留在 Firestore Batch 限制內。
      if (orderIds.length > 200) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              '單次最多只能確認 200 筆訂單。',
          });
      }

      const remittedBy =
        String(
          body.remittedBy ||
          body.adminUserId ||
          body.operator ||
          'finance_center'
        )
          .trim()
          .slice(0, 100);

      const orderRefs =
        orderIds.map(orderId =>
          db
            .collection('orders')
            .doc(orderId)
        );

      const orderDocs =
        await Promise.all(
          orderRefs.map(ref =>
            ref.get()
          )
        );

      const validOrders = [];
      const skippedOrders = [];

      let totalRemittedAmount = 0;

      orderDocs.forEach(
        (
          orderDoc,
          index
        ) => {
          const orderId =
            orderIds[index];

          if (!orderDoc.exists) {
            skippedOrders.push({
              orderId,
              reason:
                'order_not_found',
            });

            return;
          }

          const order = {
            id: orderDoc.id,
            ...orderDoc.data(),
          };

          const orderStatus =
            String(
              order.status || ''
            )
              .trim()
              .toLowerCase();

          // 只能結算已完成的訂單
          if (
            orderStatus !==
              'completed' &&
            orderStatus !==
              'done'
          ) {
            skippedOrders.push({
              orderId,
              reason:
                'order_not_completed',
            });

            return;
          }

          // 只能處理現金訂單
          if (
            !isCashPaymentOrder(
              order
            )
          ) {
            skippedOrders.push({
              orderId,
              reason:
                'not_cash_order',
            });

            return;
          }

          // 已經回繳過，不重複處理
          if (
            isCashRemittanceSettled(
              order
            )
          ) {
            skippedOrders.push({
              orderId,
              reason:
                'already_settled',
            });

            return;
          }

          // ==============================
          // 計算這張訂單應回繳平台金額
          // ==============================

          const customerTotal =
            getOrderCustomerPayableTotal(
              order
            );

          const advancePayment =
            getOrderAdvancePaymentAmount(
              order
            );

          const riderIncome =
            getOrderMoneyValue(
              order,
              [
                'riderFee',
                'driverFee',
                'riderIncome',
                'riderEarning',
                'riderPayout',
                'riderShare',
                'fee',
              ]
            ) || 0;

          const fallbackPlatformDue =
            Math.max(
              0,
              Math.round(
                customerTotal -
                advancePayment -
                riderIncome
              )
            );

          const cashDueToPlatform =
            getOrderCashDueToPlatformAmount(
              order,
              fallbackPlatformDue
            );

          if (
            cashDueToPlatform <= 0
          ) {
            skippedOrders.push({
              orderId,
              reason:
                'no_remittance_amount',
            });

            return;
          }

          validOrders.push({
            ref: orderDoc.ref,
            orderId,
            cashDueToPlatform,
          });

          totalRemittedAmount +=
            cashDueToPlatform;
        }
      );

      if (!validOrders.length) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              '沒有可確認回繳的現金訂單。',

            settledOrderCount: 0,

            totalRemittedAmount: 0,

            skippedOrders,
          });
      }

      const batch =
        db.batch();

      const nowMs =
        Date.now();

      validOrders.forEach(item => {
        batch.set(
          item.ref,
          {
            // 現金回繳正式完成
            cashRemittanceStatus:
              'settled',

            cashRemittedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp(),

            cashRemittedAtMs:
              nowMs,

            cashRemittedBy:
              remittedBy,

            cashRemittedAmount:
              item.cashDueToPlatform,

            // 現金單不屬於平台撥款流程
            settlementStatus:
              'not_applicable',

            financialUpdatedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp(),

            financialUpdatedAtMs:
              nowMs,
          },
          {
            merge: true,
          }
        );
      });

      await batch.commit();

      return res.json({
        success: true,

        message:
          '騎士現金回繳已確認。',

        settledOrderCount:
          validOrders.length,

        settledOrderIds:
          validOrders.map(
            item =>
              item.orderId
          ),

        totalRemittedAmount:
          Math.round(
            totalRemittedAmount
          ),

        skippedOrderCount:
          skippedOrders.length,

        skippedOrders,
      });

    } catch (err) {
      console.error(
        '❌ 確認騎士現金回繳失敗：',
        err
      );

      return res
        .status(500)
        .json({
          success: false,

          message:
            '確認騎士現金回繳失敗。',

          error:
            err.message,
        });
    }
  }
);

// 讀取所有店家應收帳款
app.get('/api/admin/merchant-receivables', async (req, res) => {
  try {
    const snap = await db.collection('orders')
      .where('orderType', 'in', ['merchant_dispatch', 'merchant_delivery'])
      .limit(500)
      .get();

    const merchantMap = new Map();

    let unpaidTotal = 0;
    let paidTotal = 0;
    let receivableOrderCount = 0;

    snap.forEach(doc => {
      const order = {
        id: doc.id,
        ...doc.data()
      };

      if (!isMerchantReceivableOrder(order)) {
        return;
      }

      const amount = getMerchantReceivableAmount(order);

      if (amount <= 0) {
        return;
      }

      receivableOrderCount += 1;

      const merchantId = String(
        order.merchantId ||
        order.merchantCode ||
        order.merchantPhone ||
        'unknown'
      ).trim();

      const merchantName = order.merchantName || '未命名店家';
      const merchantPhone = order.merchantPhone || '';

      const billingStatus = String(
        order.merchantBillingStatus || 'unpaid'
      ).trim().toLowerCase();

      const isPaid =
        billingStatus === 'paid';

      if (!merchantMap.has(merchantId)) {
        merchantMap.set(merchantId, {
          merchantId,
          merchantName,
          merchantPhone,
          unpaidAmount: 0,
          paidAmount: 0,
          totalAmount: 0,
          orderCount: 0,
          unpaidCount: 0,
          paidCount: 0,
          lastOrderAt: null,
          orders: []
        });
      }

      const merchant = merchantMap.get(merchantId);

      merchant.orderCount += 1;
      merchant.totalAmount += amount;

      if (isPaid) {
        merchant.paidAmount += amount;
        merchant.paidCount += 1;
        paidTotal += amount;
      } else {
        merchant.unpaidAmount += amount;
        merchant.unpaidCount += 1;
        unpaidTotal += amount;

        merchant.orders.push({
          id: order.id,
          orderNo: order.orderNo || order.id,
          amount,
          status: order.status || '',
          billingStatus: billingStatus || 'unpaid',
          completedAt: order.completedAt || order.updatedAt || null,
          createdAt: order.createdAt || null,
          paymentMethod: order.paymentMethod || '',
          paymentMethodLabel: order.paymentMethodLabel || '',
          merchantName,
          merchantPhone
        });
      }

      const orderTime =
        order.completedAt ||
        order.updatedAt ||
        order.createdAt ||
        null;

      if (
        !merchant.lastOrderAt ||
        getMerchantReceivableTimeMs(orderTime) > getMerchantReceivableTimeMs(merchant.lastOrderAt)
      ) {
        merchant.lastOrderAt = orderTime;
      }
    });

    const merchants = Array.from(merchantMap.values())
      .filter(merchant => merchant.unpaidAmount > 0 || merchant.paidAmount > 0)
      .sort((a, b) => {
        if (b.unpaidAmount !== a.unpaidAmount) {
          return b.unpaidAmount - a.unpaidAmount;
        }

        return getMerchantReceivableTimeMs(b.lastOrderAt) - getMerchantReceivableTimeMs(a.lastOrderAt);
      });

    res.json({
      success: true,
      unpaidTotal,
      paidTotal,
      totalAmount: unpaidTotal + paidTotal,
      merchantCount: merchants.length,
      receivableOrderCount,
      merchants
    });

  } catch (err) {
    console.error('merchant receivables error:', err);

    res.status(500).json({
      success: false,
      message: '讀取店家應收帳款失敗',
      error: err.message
    });
  }
});

// 將單筆店家應收帳款標記為已結清
app.post('/api/admin/merchant-receivables/settle-order', async (req, res) => {
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

    const order = {
      id: doc.id,
      ...doc.data()
    };

    if (!isMerchantReceivableOrder(order)) {
      return res.status(400).json({
        success: false,
        message: '此訂單不是可結清的店家派單帳款'
      });
    }

    const currentBillingStatus = String(
      order.merchantBillingStatus || 'unpaid'
    ).trim().toLowerCase();

    if (currentBillingStatus === 'paid') {
      return res.status(409).json({
        success: false,
        message: '此店家帳款已經結清，請勿重複操作'
      });
    }

    const amount = getMerchantReceivableAmount(order);

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: '此訂單缺少正確的店家應付金額'
      });
    }

    await ref.update({
      merchantBillingStatus: 'paid',
      merchantPaidAmount: amount,
      merchantBillingSettledAt: admin.firestore.FieldValue.serverTimestamp(),
      merchantBillingSettledBy: 'admin'
    });

    res.json({
      success: true,
      message: '店家帳款已標記結清',
      orderId,
      paidAmount: amount
    });

  } catch (err) {
    console.error('settle merchant receivable error:', err);

    res.status(500).json({
      success: false,
      message: '店家帳款結清失敗',
      error: err.message
    });
  }
});


// 4. 騎士完成訂單列表：手機登入正式版
// 支援 phone / riderId，並保留 lineUserId 舊版相容
app.get('/api/rider/completed-orders', riderAuthMiddleware, async (req, res) => {
  try {
    const {
      lineUserId,
      phone,
      riderId,
      limit,
    } = req.query || {};

    // ==============================
    // 1. 驗證騎士身分
    // ==============================
    const riderResult = await findApprovedRiderForApi({
      lineUserId,
      phone,
      riderId,
    });

    if (!riderResult.ok) {
      return res.status(riderResult.statusCode).json({
        success: false,
        message: riderResult.message,
      });
    }

    const riderDoc = riderResult.riderDoc;
    const rider = riderResult.rider || {};

    const identity = buildRiderApiIdentity(
      riderDoc,
      rider,
      {
        lineUserId,
        phone,
        riderId,
      }
    );

    const safeLimit = Math.min(
      Math.max(Number(limit || 20), 1),
      50
    );

    // ==============================
    // 2. 完成時間轉毫秒
    // 支援 Firestore Timestamp /
    // number / string
    // ==============================
    function getCompletedOrderTimeMs(order) {
      if (!order) return 0;

      const timeCandidates = [
        order.completedAt,

        order.statusTimes &&
        order.statusTimes.completed,

        order.finishedAt,
        order.deliveredAt,
        order.updatedAt,
        order.createdAt,
      ];

      for (const value of timeCandidates) {
        if (!value) continue;

        if (
          typeof value.toDate === 'function'
        ) {
          return value.toDate().getTime();
        }

        if (
          typeof value.seconds === 'number'
        ) {
          return value.seconds * 1000;
        }

        if (
          typeof value._seconds === 'number'
        ) {
          return value._seconds * 1000;
        }

        if (typeof value === 'number') {
          // 保險相容秒數與毫秒數
          return value < 1000000000000
            ? value * 1000
            : value;
        }

        if (typeof value === 'string') {
          const parsed =
            new Date(value).getTime();

          if (Number.isFinite(parsed)) {
            return parsed;
          }
        }
      }

      return 0;
    }

    // ==============================
    // 3. 建立訂單查詢條件
    //
    // 不使用複合索引：
    // 分別查詢，再自行去重複
    // ==============================
    const queryPairs = [];

    function addQueryPair(field, value) {
      const safeValue =
        String(value || '').trim();

      if (!safeValue) return;

      const alreadyExists =
        queryPairs.some(
          ([oldField, oldValue]) =>
            oldField === field &&
            oldValue === safeValue
        );

      if (!alreadyExists) {
        queryPairs.push([
          field,
          safeValue,
        ]);
      }
    }

    // 手機登入正式欄位
    addQueryPair(
      'riderDocId',
      identity.riderDocId
    );

    addQueryPair(
      'riderId',
      identity.riderId
    );

    addQueryPair(
      'riderPhone',
      identity.phone
    );

    // 舊 LINE 身分欄位
    addQueryPair(
      'riderLineUserId',
      identity.lineUserId
    );

    // ==============================
    // 舊版資料相容
    // 過去部分訂單可能把 LINE userId
    // 存在 riderId 或 driverId
    // ==============================
    if (identity.lineUserId) {
      addQueryPair(
        'riderId',
        identity.lineUserId
      );

      addQueryPair(
        'driverId',
        identity.lineUserId
      );
    }

    if (identity.riderId) {
      addQueryPair(
        'driverId',
        identity.riderId
      );
    }

    // ==============================
    // 4. 查詢所有屬於這名騎士的完成訂單
    // ==============================
    const completedOrderMap =
      new Map();

    for (const [field, value] of queryPairs) {
      try {
        const snap = await db
          .collection('orders')
          .where(field, '==', value)
          .limit(500)
          .get();

        snap.docs.forEach(doc => {
          const order = {
            id: doc.id,
            ...doc.data(),
          };

          const status =
            String(order.status || '')
              .trim()
              .toLowerCase();

          const isCompleted =
            status === 'completed' ||
            status === 'done';

          if (!isCompleted) {
            return;
          }

          // ==========================
          // 正式身分確認
          // ==========================
          const directBelongs =
            isOrderBelongsToRider(
              order,
              identity
            );

          // ==========================
          // 舊版資料相容
          // 某些舊訂單可能把 LINE userId
          // 寫在 riderId / driverId
          // ==========================
          const oldOrderRiderId =
            String(
              order.riderId || ''
            ).trim();

          const oldOrderDriverId =
            String(
              order.driverId || ''
            ).trim();

          const legacyBelongs =
            !!identity.lineUserId &&
            (
              oldOrderRiderId ===
                identity.lineUserId ||

              oldOrderDriverId ===
                identity.lineUserId
            );

          if (
            !directBelongs &&
            !legacyBelongs
          ) {
            return;
          }

          // 同一張訂單只保留一次
          completedOrderMap.set(
            doc.id,
            order
          );
        });

      } catch (queryErr) {
        console.warn(
          `⚠️ 完成訂單查詢失敗 field=${field}:`,
          queryErr.message
        );
      }
    }

    const completedOrders =
      Array.from(
        completedOrderMap.values()
      );

    // ==============================
    // 5. 整理完成訂單資料
    // ==============================
    const resultOrders = completedOrders
      .map(order => {
        const completedAtMs =
          getCompletedOrderTimeMs(order);

        // ----------------------------
        // 付款方式
        // ----------------------------
        const paymentMethod =
          getOrderPaymentMethod(order);

        const paymentStatus =
          getOrderPaymentStatus(order);

        const isCashOrder =
          order.isCashOrder === true ||

          paymentMethod === 'cash' ||

          paymentMethod.includes(
            'cash'
          ) ||

          paymentMethod.includes(
            '現金'
          ) ||

          paymentStatus ===
            'cash_on_delivery' ||

          paymentStatus ===
            'cash_pending' ||

          paymentStatus.includes(
            '現金'
          );

        // ----------------------------
        // 代墊款
        // 不屬於騎士收入
        // ----------------------------
        const advancePayment =
          getOrderAdvancePaymentAmount(
            order
          );

        // ----------------------------
        // 客人實際應付總額
        // 含代墊款
        // ----------------------------
        const directCustomerTotal =
          getOrderMoneyValue(
            order,
            [
              'customerPayableTotal',
              'customerPayTotal',
              'customerPayAmount',
              'customerTotalWithAdvance',
              'riderDisplayTotal',
              'estimatedPayableTotal',
              'payableTotal',
              'finalPayAmount',
              'cashCollectAmount',
              'collectAmount',
              'amountToCollect',
              'total',
              'price',
            ]
          );

        const customerTotal =
          directCustomerTotal !== null
            ? directCustomerTotal
            : 0;

        // ----------------------------
        // 服務總額
        // 不含代墊款
        // ----------------------------
        const directServiceSubtotal =
          getOrderMoneyValue(
            order,
            [
              'serviceSubtotal',
              'serviceTotal',
              'deliveryServiceFee',
              'taskServiceFee',
            ]
          );

        const serviceNet =
          directServiceSubtotal !== null
            ? directServiceSubtotal
            : Math.max(
                0,
                customerTotal -
                advancePayment
              );

        // ============================
        // 騎士收入
        // ============================
        const directRiderIncome =
          getOrderMoneyValue(
            order,
            [
              'driverFee',
              'riderFee',
              'riderIncome',
              'riderEarning',
              'riderPayout',
              'riderShare',
            ]
          );

        // 新正式規則：
        // 配送費 + 急件費 + 樓層費 + 等候費
        // 才參與 70 / 30 分潤
        const fallbackTaskSubtotal =
          Math.max(
            0,
            Math.round(
              Number(
                order.deliveryFee || 0
              )
            )
          ) +

          Math.max(
            0,
            Math.round(
              Number(
                order.speedFee || 0
              )
            )
          ) +

          Math.max(
            0,
            Math.round(
              Number(
                order.upstairsFee || 0
              )
            )
          ) +

          Math.max(
            0,
            Math.round(
              Number(
                order.waitingFee || 0
              )
            )
          );

        const fallbackServiceFee =
          Math.max(
            0,
            Math.round(
              Number(
                order.serviceFee || 0
              )
            )
          );

        const fallbackRiderIncome =
          fallbackTaskSubtotal > 0

            ? Math.round(
                fallbackTaskSubtotal *
                Number(
                  PRICING.driverRatio ||
                  0.7
                )
              )

            : Math.round(
                Math.max(
                  0,
                  serviceNet -
                  fallbackServiceFee
                ) *
                Number(
                  PRICING.driverRatio ||
                  0.7
                )
              );

        const riderIncome =
          directRiderIncome !== null &&
          directRiderIncome > 0

            ? directRiderIncome

            : fallbackRiderIncome;

        // ============================
        // 現金單應回繳平台
        // ============================
        const directCashDueToPlatform =
          getOrderMoneyValue(
            order,
            [
              'cashDueToPlatform',
              'platformReceivable',
              'riderDueToPlatform',
            ]
          );

        const cashDueToPlatform =
          isCashOrder
            ? (
                directCashDueToPlatform !== null &&
                directCashDueToPlatform > 0

                  ? directCashDueToPlatform

                  : Math.max(
                      0,
                      Math.round(
                        serviceNet -
                        riderIncome
                      )
                    )
              )
            : 0;

        return {
          id:
            order.id,

          orderNo:
            order.orderNo ||
            order.id,

          status:
            order.status,

          pickupAddress:
            order.pickupAddress ||
            order.fromAddress ||
            order.pickup ||
            '',

          dropoffAddress:
            order.dropoffAddress ||
            order.toAddress ||
            order.dropoff ||
            '',

          item:
            order.item ||
            '',

          // ==========================
          // 騎士身分相容欄位
          // ==========================
          riderId:
            order.riderId ||
            '',

          riderPhone:
            order.riderPhone ||
            '',

          riderDocId:
            order.riderDocId ||
            '',

          riderLineUserId:
            order.riderLineUserId ||
            '',

          // ==========================
          // 付款資料
          // ==========================
          paymentMethod:
            paymentMethod ||
            order.paymentMethod ||
            '',

          paymentStatus:
            paymentStatus ||
            order.paymentStatus ||
            '',

          isCashOrder,

          // ==========================
          // 騎士收入
          // ==========================
          driverFee:
            riderIncome,

          riderFee:
            riderIncome,

          fee:
            riderIncome,

          // 舊版 rider.html 相容
          // price 保留騎士收入
          price:
            riderIncome,

          // ==========================
          // 客人實際應付總額
          // ==========================
          total:
            customerTotal,

          customerPayableTotal:
            customerTotal,

          payableTotal:
            customerTotal,

          riderDisplayTotal:
            customerTotal,

          // ==========================
          // 服務費小計
          // 不含代墊
          // ==========================
          serviceSubtotal:
            serviceNet,

          serviceTotal:
            serviceNet,

          // ==========================
          // 代墊資料
          // ==========================
          advancePayment,

          advanceAmount:
            advancePayment,

          // ==========================
          // 現金單錢包資料
          // ==========================
          cashCollectAmount:
            isCashOrder
              ? customerTotal
              : 0,

          cashCollectedAmount:
            isCashOrder
              ? customerTotal
              : 0,

          cashGrossCollected:
            isCashOrder
              ? customerTotal
              : 0,

          cashAdvanceRecovered:
            isCashOrder
              ? advancePayment
              : 0,

          cashServiceNet:
            isCashOrder
              ? serviceNet
              : 0,

          cashDueToPlatform,

          platformReceivable:
            cashDueToPlatform,

          riderDueToPlatform:
            cashDueToPlatform,

          // ==========================
          // 完成時間
          // ==========================
          completedAt:
            completedAtMs,

          completedAtText:
            completedAtMs
              ? new Date(
                  completedAtMs
                ).toLocaleString(
                  'zh-TW',
                  {
                    timeZone:
                      'Asia/Taipei',
                  }
                )
              : '',
        };
      })

      .sort(
        (a, b) =>
          Number(
            b.completedAt || 0
          ) -
          Number(
            a.completedAt || 0
          )
      )

      .slice(
        0,
        safeLimit
      );

    // ==============================
    // 6. 回傳完成訂單
    // ==============================
    return res.json({
      success: true,
      orders: resultOrders,
    });

  } catch (err) {
    console.error(
      '❌ 取得騎士完成訂單失敗：',
      err
    );

    return res.status(500).json({
      success: false,
      message:
        '取得騎士完成訂單失敗，請稍後再試。',
      error: err.message,
    });
  }
});


// ============================================================
// UBee 智慧調度控制塔 V4 + V5
// 原則：自動監控、風險分級、備援推薦與處置建議；高風險寫入操作仍需人工確認。
// ============================================================
const UBEE_DISPATCH_INTELLIGENCE_VERSION = 'level4-v3';
const UBEE_DISPATCH_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const UBEE_RIDER_STATS_CACHE_MS = 30 * 1000;
let ubeeLastDispatchSnapshotMs = 0;
let ubeeRiderDispatchStatsCacheAtMs = 0;
let ubeeRiderDispatchStatsCache = new Map();

// 全台調度地區由 UBEE_TAIWAN_REGION_PAIRS 在地區模組初始化後提供。

function dispatchClamp(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function dispatchToMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Date.parse(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  return 0;
}

function getDispatchOrderCreatedAtMs(order = {}) {
  return Number(
    order.createdAtMs ||
    order.orderCreatedAtMs ||
    order.submittedAtMs ||
    0
  ) || dispatchToMs(order.createdAt) || dispatchToMs(order.orderCreatedAt) || dispatchToMs(order.submittedAt);
}

function getDispatchOrderCompletedAtMs(order = {}) {
  return Number(order.completedAtMs || 0) ||
    dispatchToMs(order.completedAt) ||
    dispatchToMs(order.statusTimes?.completed);
}

function inferDispatchRegion(value = '') {
  return inferTaiwanRegion(value);
}

function inferDispatchDistrict(value = '') {
  return inferDispatchRegion(value).district || '';
}

function buildDispatchZoneId(cityOrDistrict = '', districtMaybe = '') {
  let city = normalizeTaiwanCityName(cityOrDistrict);
  let district = normalizeTaiwanRegionText(districtMaybe);

  if (!district) {
    const inferred = inferDispatchRegion(cityOrDistrict);
    city = city || inferred.city;
    district = inferred.district || normalizeTaiwanRegionText(cityOrDistrict);
  }

  return buildNationwideDispatchZoneId(city, district);
}

function getDispatchOrderZone(order = {}) {
  const pickupText =
    order.pickupAddress ||
    order.fromAddress ||
    order.pickup ||
    '';

  const inferred = inferDispatchRegion(pickupText);

  const city = normalizeTaiwanCityName(
    order.pickupCity ||
    order.city ||
    inferred.city ||
    ''
  );

  const district = normalizeTaiwanRegionText(
    order.pickupDistrict ||
    inferred.district ||
    ''
  );

  return {
    city: city || '未分縣市',
    district: district || '未分區',
    zoneId:
      String(order.pickupZoneId || '').trim() ||
      buildNationwideDispatchZoneId(city, district),
  };
}

function getDispatchRiderZone(rider = {}) {
  const residenceText =
    rider.district ||
    rider.cityDistrict ||
    rider.residenceDistrict ||
    rider.serviceArea ||
    rider.area ||
    '';

  const inferred = inferDispatchRegion(residenceText);

  const city = normalizeTaiwanCityName(
    rider.residenceCity ||
    rider.city ||
    rider.serviceCity ||
    inferred.city ||
    ''
  );

  let district = normalizeTaiwanRegionText(
    rider.residenceDistrict ||
    rider.cityDistrict ||
    inferred.district ||
    ''
  );

  if (!district) {
    const serviceDistricts = normalizeTaiwanServiceDistricts(
      rider.serviceDistricts ||
      rider.serviceArea ||
      rider.area ||
      []
    );

    const serviceRegion = inferDispatchRegion(serviceDistricts[0] || '');
    district = serviceRegion.district || '';
  }

  return {
    city: city || '未分縣市',
    district: district || '未分區',
    zoneId: buildNationwideDispatchZoneId(city, district),
  };
}

function dispatchHaversineKm(lat1, lng1, lat2, lng2) {
  const values = [lat1, lng1, lat2, lng2].map(Number);
  if (values.some(v => !Number.isFinite(v))) return null;
  const [aLat, aLng, bLat, bLng] = values;
  const rad = d => d * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function getTaipeiTimeParts(ms = Date.now()) {
  const d = new Date(Number(ms || Date.now()) + 8 * 60 * 60 * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    slot15: Math.floor(d.getUTCMinutes() / 15),
    dateKey: `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`,
  };
}

function buildDispatchOrderMetadata(order = {}, nowMs = Date.now()) {
  const pickupDistrict = inferDispatchDistrict(order.pickupAddress || order.fromAddress || order.pickup || '');
  const dropoffDistrict = inferDispatchDistrict(order.dropoffAddress || order.toAddress || order.dropoff || '');
  const t = getTaipeiTimeParts(nowMs);
  return {
    pickupDistrict: pickupDistrict || '',
    dropoffDistrict: dropoffDistrict || '',
    pickupZoneId: buildDispatchZoneId(pickupDistrict),
    dropoffZoneId: buildDispatchZoneId(dropoffDistrict),
    createdHour: t.hour,
    createdWeekday: t.weekday,
    createdTimeSlot: `${String(t.hour).padStart(2,'0')}:${String(t.slot15*15).padStart(2,'0')}`,
    dispatchIntelligenceVersion: UBEE_DISPATCH_INTELLIGENCE_VERSION,
  };
}

async function logDispatchEvent(payload = {}) {
  try {
    const eventType = String(payload.type || '').trim();
    if (!eventType) return false;
    await db.collection('dispatchEvents').add({
      ...payload,
      type: eventType,
      intelligenceVersion: UBEE_DISPATCH_INTELLIGENCE_VERSION,
      createdAtMs: Number(payload.createdAtMs || Date.now()),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  } catch (error) {
    console.warn('⚠️ Level4 dispatchEvents 紀錄失敗（不影響核心流程）：', error?.message || error);
    return false;
  }
}

async function updateRiderDispatchStats(riderId, changes = {}) {
  const safeRiderId = String(riderId || '').trim();
  if (!safeRiderId) return false;
  try {
    const update = {
      riderId: safeRiderId,
      updatedAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      intelligenceVersion: UBEE_DISPATCH_INTELLIGENCE_VERSION,
    };
    const incrementFields = [
      'receivedOrders','acceptedOrders','skippedOrders','completedOrders','manualAssignments','transferredOrders'
    ];
    for (const key of incrementFields) {
      const n = Number(changes[key] || 0);
      if (Number.isFinite(n) && n !== 0) update[key] = admin.firestore.FieldValue.increment(n);
    }
    for (const key of ['lastAcceptedAtMs','lastSkippedAtMs','lastCompletedAtMs','lastAssignedAtMs']) {
      if (Number.isFinite(Number(changes[key]))) update[key] = Number(changes[key]);
    }
    await db.collection('riderDispatchStats').doc(safeRiderId).set(update, { merge: true });
    return true;
  } catch (error) {
    console.warn('⚠️ Level4 riderDispatchStats 更新失敗（不影響核心流程）：', error?.message || error);
    return false;
  }
}

async function loadRiderDispatchStatsMap() {
  try {
    if (Date.now() - ubeeRiderDispatchStatsCacheAtMs < UBEE_RIDER_STATS_CACHE_MS) {
      return ubeeRiderDispatchStatsCache;
    }
    const snap = await db.collection('riderDispatchStats').limit(1500).get();
    const map = new Map();
    snap.docs.forEach(doc => {
      const v = doc.data() || {};
      const keys = [doc.id, v.riderId, v.riderDocId].filter(Boolean).map(String);
      keys.forEach(key => map.set(key, v));
    });
    ubeeRiderDispatchStatsCache = map;
    ubeeRiderDispatchStatsCacheAtMs = Date.now();
    return map;
  } catch (error) {
    console.warn('⚠️ Level4 riderDispatchStats 讀取失敗，改用既有快取／中性分數：', error?.message || error);
    return ubeeRiderDispatchStatsCache || new Map();
  }
}

function buildRiderCandidateScore(order, rider, stats = {}, nowMs = Date.now()) {
  const distanceKm = dispatchHaversineKm(
    order.pickupLat ?? order.fromLat,
    order.pickupLng ?? order.fromLng,
    rider.currentLat,
    rider.currentLng
  );
  if (distanceKm === null) return null;
  const locationAgeMs = Math.max(0, nowMs - Number(rider.locationUpdatedAtMs || 0));
  const orderZone = getDispatchOrderZone(order);
  const riderZone = getDispatchRiderZone(rider);
  const skippedIds = Array.isArray(order.skippedRiderIds) ? order.skippedRiderIds.map(String) : [];
  const riderKeys = [rider.riderId, rider.riderDocId, rider.phone].filter(Boolean).map(String);
  const skippedThisOrder = riderKeys.some(key => skippedIds.includes(key));

  let score = 100;
  score -= Math.min(55, distanceKm * 7.5);
  if (locationAgeMs > 2 * 60 * 1000) score -= 24;
  else if (locationAgeMs > 60 * 1000) score -= 12;
  else if (locationAgeMs > 30 * 1000) score -= 5;
  if (rider.busy) score -= 50;
  if (orderZone.district !== '未分區' && riderZone.district === orderZone.district) score += 8;
  if (skippedThisOrder) score -= 60;

  const accepted = Number(stats.acceptedOrders || 0);
  const skipped = Number(stats.skippedOrders || 0);
  const received = Number(stats.receivedOrders || 0);
  const decisions = Math.max(received, accepted + skipped);
  const acceptanceRate = decisions > 0 ? accepted / decisions : null;
  if (acceptanceRate !== null && decisions >= 5) {
    score += (acceptanceRate - 0.5) * 16;
  }

  score = Math.round(dispatchClamp(score, 0, 100));
  const etaMinutes = Math.max(3, Math.ceil(distanceKm / 0.32));
  return {
    riderId: rider.riderId,
    riderDocId: rider.riderDocId,
    name: rider.name || '',
    district: riderZone.district,
    distanceKm: Number(distanceKm.toFixed(2)),
    estimatedPickupMinutes: etaMinutes,
    score,
    locationAgeMs,
    connectionState: locationAgeMs > 2 * 60 * 1000 ? 'STALE_LOCATION' : 'LIVE',
    acceptanceRate: acceptanceRate === null ? null : Number(acceptanceRate.toFixed(3)),
    decisions,
    skippedThisOrder,
    reasons: [
      `${distanceKm.toFixed(1)} km 距離取件點`,
      locationAgeMs <= 30 * 1000 ? '定位新鮮' : `定位已 ${Math.floor(locationAgeMs/1000)} 秒`,
      riderZone.district === orderZone.district ? '同區域運力' : '跨區候選',
      skippedThisOrder ? '此小U已略過本任務' : '可列入候選',
    ],
  };
}

function buildOrderRiskInsight(order, riders, zoneSummary, statsMap, nowMs = Date.now()) {
  const createdAtMs = getDispatchOrderCreatedAtMs(order);
  const waitMinutes = createdAtMs ? Math.max(0, (nowMs - createdAtMs) / 60000) : 0;
  const available = riders.filter(r => !r.busy && Number.isFinite(Number(r.currentLat)) && Number.isFinite(Number(r.currentLng)));
  const candidates = available
    .map(r => buildRiderCandidateScore(order, r, statsMap.get(String(r.riderId)) || statsMap.get(String(r.riderDocId)) || {}, nowMs))
    .filter(Boolean)
    .sort((a,b) => b.score - a.score || a.distanceKm - b.distanceKm);

  const within3 = candidates.filter(c => c.distanceKm <= 3 && !c.skippedThisOrder).length;
  const within5 = candidates.filter(c => c.distanceKm <= 5 && !c.skippedThisOrder).length;
  const within8 = candidates.filter(c => c.distanceKm <= 8 && !c.skippedThisOrder).length;
  const nearestKm = candidates.length ? Math.min(...candidates.filter(c=>!c.skippedThisOrder).map(c=>c.distanceKm).concat([999])) : null;
  const skippedCount = Array.isArray(order.skippedRiderIds) ? order.skippedRiderIds.length : 0;
  const radiusKm = Number(order.dispatchManualRadiusKm || order.dispatchManualRedispatchRadiusKm || order.dispatchRadiusKm || 3) || 3;
  const speed = String(order.speedType || '').toLowerCase();

  let score = Math.min(38, waitMinutes * 4.6);
  const reasons = [];
  if (waitMinutes >= 2) reasons.push(`已等待 ${Math.floor(waitMinutes)} 分鐘`);
  if (within3 === 0) { score += 18; reasons.push('3 km 內無可接小U'); }
  else if (within3 <= 1) { score += 8; reasons.push('3 km 內運力偏少'); }
  if (within5 === 0) { score += 10; reasons.push('5 km 內仍無可接小U'); }
  if (nearestKm !== null && nearestKm > 8 && nearestKm < 999) { score += 10; reasons.push(`最近可接小U約 ${nearestKm.toFixed(1)} km`); }
  if (nearestKm === 999 || nearestKm === null) { score += 14; reasons.push('目前找不到可用候選小U'); }
  if (skippedCount >= 2) { score += Math.min(12, skippedCount * 2); reasons.push(`已有 ${skippedCount} 次略過紀錄`); }
  if (radiusKm >= 8) { score += 5; reasons.push(`已擴圈至 ${radiusKm} km`); }
  if (['priority','express','instant','urgent'].includes(speed)) { score += 6; reasons.push('此任務時效要求較高'); }
  if (zoneSummary && Number(zoneSummary.expectedGap15m) < 0) {
    score += Math.min(12, Math.abs(Number(zoneSummary.expectedGap15m)) * 2);
    reasons.push(`${zoneSummary.district} 預測運力缺口 ${zoneSummary.expectedGap15m}`);
  }
  score = Math.round(dispatchClamp(score, 0, 100));

  let level = 'NORMAL';
  if (score >= 80) level = 'CRITICAL';
  else if (score >= 60) level = 'HIGH';
  else if (score >= 35) level = 'WATCH';

  const recommendations = [];
  if (within3 === 0 && radiusKm < 5) recommendations.push({ type:'EXPAND_RADIUS', targetRadiusKm:5, label:'擴大派單至 5 km' });
  else if (within5 === 0 && radiusKm < 8) recommendations.push({ type:'EXPAND_RADIUS', targetRadiusKm:8, label:'擴大派單至 8 km' });
  else if (within8 === 0 && radiusKm < 12) recommendations.push({ type:'EXPAND_RADIUS', targetRadiusKm:12, label:'擴大派單至 12 km' });
  if (candidates[0] && candidates[0].score >= 55) recommendations.push({ type:'REVIEW_CANDIDATE', riderId:candidates[0].riderId, label:`優先檢視 ${candidates[0].name || candidates[0].riderId}` });
  if (score >= 60) recommendations.push({ type:'MANUAL_REVIEW', label:'進入人工調度確認' });

  return {
    orderId: String(order.id || order.orderId || ''),
    score,
    level,
    waitMinutes: Number(waitMinutes.toFixed(1)),
    within3,
    within5,
    within8,
    nearestKm: nearestKm === null || nearestKm === 999 ? null : Number(nearestKm.toFixed(2)),
    skippedCount,
    radiusKm,
    reasons: reasons.slice(0, 6),
    recommendations,
    candidates: candidates.slice(0, 8),
  };
}


// ============================================================
// UBee V3：進行中任務異常監控 / 備援建議
// - 不靠單一條件直接判死刑，使用 GPS、新鮮度、任務階段、停留時間與距離綜合評分。
// - 取件前可由調度中心人工確認後啟動備援轉派。
// - 到達取件點後視為可能已發生貨物交接，禁止直接自動轉派，避免責任斷點。
// ============================================================
function getDispatchOrderStatusAtMs(order = {}, status = '') {
  const keyMap = {
    accepted: ['acceptedAtMs', 'acceptedAt'],
    arrived_pickup: ['arrivedPickupAtMs', 'arrivedPickupAt'],
    picked_up: ['pickedUpAtMs', 'pickedUpAt'],
    arrived_dropoff: ['arrivedDropoffAtMs', 'arrivedDropoffAt'],
  };
  const keys = keyMap[status] || [];
  for (const key of keys) {
    const direct = Number(order[key] || 0);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const parsed = dispatchToMs(order[key]);
    if (parsed) return parsed;
  }
  return dispatchToMs(order.statusTimes?.[status]);
}

function getDispatchOrderTrackingAtMs(order = {}) {
  return Number(order.riderLocationUpdatedAtMs || 0) ||
    dispatchToMs(order.riderLocationUpdatedAt) ||
    dispatchToMs(order.riderCurrentLocation?.updatedAt) ||
    Number(order.trackingUpdatedAtMs || 0) ||
    dispatchToMs(order.trackingUpdatedAt);
}

function getDispatchOrderCurrentPoint(order = {}) {
  const lat = Number(order.riderCurrentLat ?? order.riderCurrentLocation?.lat);
  const lng = Number(order.riderCurrentLng ?? order.riderCurrentLocation?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function getDispatchOrderPickupPoint(order = {}) {
  const lat = Number(order.pickupLat ?? order.fromLat ?? order.pickupLocation?.lat);
  const lng = Number(order.pickupLng ?? order.fromLng ?? order.pickupLocation?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function getDispatchOrderDropoffPoint(order = {}) {
  const lat = Number(order.dropoffLat ?? order.toLat ?? order.dropoffLocation?.lat);
  const lng = Number(order.dropoffLng ?? order.toLng ?? order.dropoffLocation?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function buildActiveOrderRiskInsight(order, riders, statsMap, nowMs = Date.now()) {
  const status = String(order.status || '').trim();
  const prePickupStatuses = new Set(['accepted', 'going_to_pickup', 'heading_to_pickup']);
  const pickupCustodyStatuses = new Set(['arrived_pickup']);
  const postPickupStatuses = new Set(['picked_up', 'going_to_dropoff', 'heading_to_dropoff', 'arrived_dropoff']);

  const acceptedAtMs = getDispatchOrderStatusAtMs(order, 'accepted') || getDispatchOrderCreatedAtMs(order);
  const arrivedPickupAtMs = getDispatchOrderStatusAtMs(order, 'arrived_pickup');
  const pickedUpAtMs = getDispatchOrderStatusAtMs(order, 'picked_up');
  const arrivedDropoffAtMs = getDispatchOrderStatusAtMs(order, 'arrived_dropoff');
  const trackingAtMs = getDispatchOrderTrackingAtMs(order);
  const locationAgeMs = trackingAtMs ? Math.max(0, nowMs - trackingAtMs) : null;
  const currentPoint = getDispatchOrderCurrentPoint(order);
  const pickupPoint = getDispatchOrderPickupPoint(order);
  const dropoffPoint = getDispatchOrderDropoffPoint(order);

  const pickupDistanceKm = currentPoint && pickupPoint
    ? dispatchHaversineKm(currentPoint.lat, currentPoint.lng, pickupPoint.lat, pickupPoint.lng)
    : null;
  const dropoffDistanceKm = currentPoint && dropoffPoint
    ? dispatchHaversineKm(currentPoint.lat, currentPoint.lng, dropoffPoint.lat, dropoffPoint.lng)
    : null;
  const routeDistanceKm = pickupPoint && dropoffPoint
    ? dispatchHaversineKm(pickupPoint.lat, pickupPoint.lng, dropoffPoint.lat, dropoffPoint.lng)
    : null;

  const currentRiderKeys = new Set([
    order.riderId,
    order.riderDocId,
    order.riderPhone,
    order.riderLineUserId,
  ].map(v => String(v || '').trim()).filter(Boolean));

  const available = riders.filter(r => {
    if (r.busy) return false;
    const keys = [r.riderId, r.riderDocId, r.phone, r.lineUserId]
      .map(v => String(v || '').trim())
      .filter(Boolean);
    if (keys.some(k => currentRiderKeys.has(k))) return false;
    return Number.isFinite(Number(r.currentLat)) && Number.isFinite(Number(r.currentLng));
  });

  const candidates = available
    .map(r => buildRiderCandidateScore(
      order,
      r,
      statsMap.get(String(r.riderId)) || statsMap.get(String(r.riderDocId)) || {},
      nowMs
    ))
    .filter(Boolean)
    .filter(c => !c.skippedThisOrder)
    .sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm);

  let score = 0;
  const reasons = [];
  const recommendations = [];
  let stage = 'ACTIVE';
  let stageElapsedMinutes = 0;

  if (!String(order.riderId || order.riderDocId || '').trim()) {
    score += 55;
    reasons.push('任務進行中但缺少承接小U識別資料');
  }

  const acceptedElapsedMin = acceptedAtMs ? Math.max(0, (nowMs - acceptedAtMs) / 60000) : 0;

  // GPS / 任務追蹤健康度
  if (!trackingAtMs) {
    if (acceptedElapsedMin >= 5) score += 55;
    else if (acceptedElapsedMin >= 2) score += 35;
    else score += 18;
    reasons.push('尚未收到任務 GPS 定位');
  } else if (locationAgeMs >= 10 * 60 * 1000) {
    score += 55;
    reasons.push(`小U定位已 ${Math.floor(locationAgeMs / 60000)} 分鐘未更新`);
  } else if (locationAgeMs >= 5 * 60 * 1000) {
    score += 38;
    reasons.push(`小U定位已 ${Math.floor(locationAgeMs / 60000)} 分鐘未更新`);
  } else if (locationAgeMs >= 3 * 60 * 1000) {
    score += 22;
    reasons.push(`小U定位暫停 ${Math.floor(locationAgeMs / 60000)} 分鐘`);
  }

  if (prePickupStatuses.has(status)) {
    stage = 'PRE_PICKUP';
    stageElapsedMinutes = acceptedElapsedMin;

    if (acceptedElapsedMin >= 25) {
      score += 34;
      reasons.push(`接單後已 ${Math.floor(acceptedElapsedMin)} 分鐘仍未抵達取件點`);
    } else if (acceptedElapsedMin >= 15) {
      score += 22;
      reasons.push(`接單後已 ${Math.floor(acceptedElapsedMin)} 分鐘仍在前往取件`);
    } else if (acceptedElapsedMin >= 10) {
      score += 10;
      reasons.push(`取件進度已持續 ${Math.floor(acceptedElapsedMin)} 分鐘`);
    }

    if (pickupDistanceKm !== null && acceptedElapsedMin >= 10) {
      if (pickupDistanceKm >= 5) {
        score += 20;
        reasons.push(`目前仍距取件點約 ${pickupDistanceKm.toFixed(1)} km`);
      } else if (pickupDistanceKm >= 2) {
        score += 10;
        reasons.push(`目前距取件點約 ${pickupDistanceKm.toFixed(1)} km`);
      }
    }
  } else if (pickupCustodyStatuses.has(status)) {
    stage = 'AT_PICKUP';
    const stageStart = arrivedPickupAtMs || acceptedAtMs;
    stageElapsedMinutes = stageStart ? Math.max(0, (nowMs - stageStart) / 60000) : 0;

    if (stageElapsedMinutes >= 35) {
      score += 48;
      reasons.push(`已在取件階段停留 ${Math.floor(stageElapsedMinutes)} 分鐘`);
    } else if (stageElapsedMinutes >= 20) {
      score += 30;
      reasons.push(`取件等待已 ${Math.floor(stageElapsedMinutes)} 分鐘`);
    } else if (stageElapsedMinutes >= 12) {
      score += 16;
      reasons.push(`取件階段停留時間偏長（${Math.floor(stageElapsedMinutes)} 分鐘）`);
    }
  } else if (postPickupStatuses.has(status)) {
    stage = status === 'arrived_dropoff' ? 'AT_DROPOFF' : 'DELIVERY';

    if (status === 'arrived_dropoff') {
      const stageStart = arrivedDropoffAtMs || pickedUpAtMs || acceptedAtMs;
      stageElapsedMinutes = stageStart ? Math.max(0, (nowMs - stageStart) / 60000) : 0;
      if (stageElapsedMinutes >= 20) {
        score += 42;
        reasons.push(`抵達送達點後 ${Math.floor(stageElapsedMinutes)} 分鐘仍未完成`);
      } else if (stageElapsedMinutes >= 10) {
        score += 22;
        reasons.push(`抵達送達點後等待 ${Math.floor(stageElapsedMinutes)} 分鐘`);
      }
    } else {
      const stageStart = pickedUpAtMs || acceptedAtMs;
      stageElapsedMinutes = stageStart ? Math.max(0, (nowMs - stageStart) / 60000) : 0;
      const expectedMinutes = routeDistanceKm !== null
        ? Math.max(15, Math.ceil(routeDistanceKm * 4 + 10))
        : 35;

      if (stageElapsedMinutes >= expectedMinutes * 2) {
        score += 45;
        reasons.push(`配送時間已明顯超過合理區間（${Math.floor(stageElapsedMinutes)} 分鐘）`);
      } else if (stageElapsedMinutes >= expectedMinutes * 1.5) {
        score += 28;
        reasons.push(`配送進度可能延遲（已 ${Math.floor(stageElapsedMinutes)} 分鐘）`);
      } else if (stageElapsedMinutes >= expectedMinutes * 1.2) {
        score += 14;
        reasons.push(`配送時間開始接近延遲門檻`);
      }

      if (
        dropoffDistanceKm !== null &&
        routeDistanceKm !== null &&
        routeDistanceKm >= 1 &&
        dropoffDistanceKm > Math.max(5, routeDistanceKm * 1.8)
      ) {
        score += 16;
        reasons.push(`目前位置距送達點約 ${dropoffDistanceKm.toFixed(1)} km，明顯偏離一般配送區間`);
      }
    }
  }

  if (['priority', 'express', 'instant', 'urgent'].includes(String(order.speedType || '').toLowerCase())) {
    score += 5;
    reasons.push('此任務時效要求較高');
  }

  if (candidates.length === 0 && prePickupStatuses.has(status)) {
    score += 8;
    reasons.push('目前沒有可立即接手的空閒小U');
  }

  score = Math.round(dispatchClamp(score, 0, 100));
  let level = 'NORMAL';
  if (score >= 80) level = 'CRITICAL';
  else if (score >= 60) level = 'HIGH';
  else if (score >= 35) level = 'WATCH';

  const recoveryEligible = prePickupStatuses.has(status);
  const custodyLocked = pickupCustodyStatuses.has(status) || postPickupStatuses.has(status);

  if (!trackingAtMs || (locationAgeMs !== null && locationAgeMs >= 3 * 60 * 1000)) {
    recommendations.push({ type: 'CONTACT_RIDER', label: '聯絡小U確認狀況' });
    recommendations.push({ type: 'VIEW_LAST_LOCATION', label: '查看最後定位' });
  }

  if (level === 'HIGH' || level === 'CRITICAL') {
    if (recoveryEligible) {
      if (candidates[0]) {
        recommendations.push({
          type: 'REVIEW_BACKUP_CANDIDATE',
          riderId: candidates[0].riderId,
          label: `檢視備援 ${candidates[0].name || candidates[0].riderId}`,
        });
      }
      recommendations.push({
        type: 'EMERGENCY_REDISPATCH',
        label: '人工確認後啟動備援轉派',
      });
    } else if (custodyLocked) {
      recommendations.push({
        type: 'MANUAL_INCIDENT',
        label: '進入人工異常處置（不可直接轉派）',
      });
    }
  }

  return {
    orderId: String(order.id || order.orderId || ''),
    kind: 'ACTIVE_TASK_RISK',
    stage,
    status,
    score,
    level,
    stageElapsedMinutes: Number(stageElapsedMinutes.toFixed(1)),
    locationAgeMs,
    pickupDistanceKm: pickupDistanceKm === null ? null : Number(pickupDistanceKm.toFixed(2)),
    dropoffDistanceKm: dropoffDistanceKm === null ? null : Number(dropoffDistanceKm.toFixed(2)),
    recoveryEligible,
    custodyLocked,
    riderId: String(order.riderId || order.riderDocId || ''),
    riderDocId: String(order.riderDocId || ''),
    riderPhone: String(order.riderPhone || order.driverPhone || ''),
    reasons: reasons.slice(0, 8),
    recommendations,
    candidates: candidates.slice(0, 8),
  };
}

async function buildDispatchIntelligence({ riders = [], allOrders = [], waitingStatuses, activeStatuses, nowMs = Date.now(), todayStartMs = 0 }) {
  const statsMap = await loadRiderDispatchStatsMap();
  const zones = new Map();
  const getZone = (district, zoneId) => {
    const id = zoneId || buildDispatchZoneId(district);
    if (!zones.has(id)) {
      zones.set(id, {
        zoneId:id,
        district:district || '未分區',
        onlineRiders:0, availableRiders:0, busyRiders:0,
        waitingOrders:0, activeOrders:0, todayOrders:0,
        recent15Orders:0, previous15Orders:0,
        predictedOrders15m:0, predictedAvailableRiders15m:0,
        expectedGap15m:0, confidence:'LOW', risk:'NORMAL',
      });
    }
    return zones.get(id);
  };

  riders.forEach(r => {
    const z = getDispatchRiderZone(r);
    const bucket = getZone(z.district, z.zoneId);
    bucket.onlineRiders += 1;
    if (r.busy) bucket.busyRiders += 1; else bucket.availableRiders += 1;
  });

  const historical = new Map();
  const nowParts = getTaipeiTimeParts(nowMs);
  const historicalCutoff = nowMs - 28 * 24 * 60 * 60 * 1000;
  allOrders.forEach(order => {
    const createdAtMs = getDispatchOrderCreatedAtMs(order);
    if (!createdAtMs) return;
    const zone = getDispatchOrderZone(order);
    const bucket = getZone(zone.district, zone.zoneId);
    const status = String(order.status || '').trim();
    if (createdAtMs >= todayStartMs) bucket.todayOrders += 1;
    if (waitingStatuses.has(status)) bucket.waitingOrders += 1;
    if (activeStatuses.has(status)) bucket.activeOrders += 1;
    if (createdAtMs >= nowMs - 15*60*1000) bucket.recent15Orders += 1;
    else if (createdAtMs >= nowMs - 30*60*1000) bucket.previous15Orders += 1;

    if (createdAtMs >= historicalCutoff && createdAtMs < nowMs - 30*60*1000) {
      const p = getTaipeiTimeParts(createdAtMs);
      if (p.weekday === nowParts.weekday && p.hour === nowParts.hour && p.slot15 === nowParts.slot15) {
        if (!historical.has(zone.zoneId)) historical.set(zone.zoneId, new Map());
        const byDate = historical.get(zone.zoneId);
        byDate.set(p.dateKey, (byDate.get(p.dateKey) || 0) + 1);
      }
    }
  });

  for (const bucket of zones.values()) {
    const dateSamples = historical.get(bucket.zoneId) || new Map();
    const counts = [...dateSamples.values()];
    const histAvg = counts.length ? counts.reduce((a,b)=>a+b,0) / counts.length : 0;
    let predicted;
    if (counts.length) predicted = bucket.recent15Orders * 0.55 + bucket.previous15Orders * 0.15 + histAvg * 0.30;
    else predicted = bucket.recent15Orders * 0.72 + bucket.previous15Orders * 0.28;
    bucket.predictedOrders15m = Math.max(0, Math.round(predicted));
    bucket.predictedAvailableRiders15m = Math.max(0, bucket.availableRiders + Math.round(bucket.activeOrders * 0.25));
    bucket.expectedGap15m = bucket.predictedAvailableRiders15m - (bucket.waitingOrders + bucket.predictedOrders15m);
    bucket.confidence = counts.length >= 4 ? 'HIGH' : counts.length >= 2 || (bucket.recent15Orders + bucket.previous15Orders) >= 5 ? 'MEDIUM' : 'LOW';
    bucket.risk = bucket.expectedGap15m <= -5 ? 'CRITICAL' : bucket.expectedGap15m <= -2 ? 'HIGH' : bucket.expectedGap15m < 0 ? 'WATCH' : 'NORMAL';
    bucket.historicalSampleDays = counts.length;
    bucket.historicalSameSlotAvg = Number(histAvg.toFixed(1));
    bucket.demandScore = Math.round(dispatchClamp((bucket.waitingOrders * 10) + (bucket.predictedOrders15m * 5), 0, 100));
    bucket.supplyScore = Math.round(dispatchClamp((bucket.availableRiders * 7) + (bucket.predictedAvailableRiders15m * 3), 0, 100));
  }

  const zoneArray = [...zones.values()]
    .filter(z => z.onlineRiders || z.waitingOrders || z.activeOrders || z.todayOrders || z.predictedOrders15m)
    .sort((a,b) => a.expectedGap15m - b.expectedGap15m || b.waitingOrders - a.waitingOrders);
  const zoneMap = new Map(zoneArray.map(z => [z.zoneId, z]));

  const waitingRaw = allOrders.filter(o => waitingStatuses.has(String(o.status || '').trim()));
  const activeRaw = allOrders.filter(o => activeStatuses.has(String(o.status || '').trim()));

  const waitingInsights = waitingRaw.map(order => {
    const z = getDispatchOrderZone(order);
    return {
      ...buildOrderRiskInsight(order, riders, zoneMap.get(z.zoneId), statsMap, nowMs),
      kind: 'WAITING_DISPATCH_RISK',
      recoveryEligible: false,
      custodyLocked: false,
    };
  });

  const activeInsights = activeRaw.map(order =>
    buildActiveOrderRiskInsight(order, riders, statsMap, nowMs)
  );

  const orderInsights = [...waitingInsights, ...activeInsights]
    .sort((a,b)=>b.score-a.score);

  const recommendations = [];
  for (const insight of orderInsights.filter(x => x.score >= 60).slice(0, 10)) {
    recommendations.push({
      id:`order_${insight.orderId}`,
      type:'ORDER_RISK',
      severity:insight.level,
      orderId:insight.orderId,
      title: insight.kind === 'ACTIVE_TASK_RISK'
        ? `${insight.orderId} 任務執行異常`
        : `${insight.orderId} 需要調度關注`,
      message:insight.reasons.slice(0,3).join('；') || '系統判定此任務風險升高',
      actions:insight.recommendations,
      recoveryEligible: insight.recoveryEligible === true,
      custodyLocked: insight.custodyLocked === true,
      requiresHumanConfirmation:true,
    });
  }
  for (const z of zoneArray.filter(x => x.expectedGap15m < 0).slice(0, 8)) {
    recommendations.push({
      id:`zone_${z.zoneId}`,
      type:'ZONE_GAP',
      severity:z.risk,
      zoneId:z.zoneId,
      title:`${z.district} 預測運力不足`,
      message:`15 分鐘預測需求 ${z.predictedOrders15m}、待接 ${z.waitingOrders}、預測可用運力 ${z.predictedAvailableRiders15m}，缺口 ${z.expectedGap15m}`,
      actions:[{type:'CROSS_ZONE_SUPPORT',label:'檢視鄰近區域支援'},{type:'MANUAL_REVIEW',label:'人工確認運力配置'}],
      requiresHumanConfirmation:true,
    });
  }

  const totalPredictedDemand15m = zoneArray.reduce((s,z)=>s+z.predictedOrders15m,0);
  const totalPredictedAvailable15m = zoneArray.reduce((s,z)=>s+z.predictedAvailableRiders15m,0);
  const totalExpectedGap15m = totalPredictedAvailable15m - (waitingRaw.length + totalPredictedDemand15m);
  const highRiskOrders = orderInsights.filter(x => ['HIGH','CRITICAL'].includes(x.level)).length;
  const criticalOrders = orderInsights.filter(x => x.level === 'CRITICAL').length;

  return {
    version:UBEE_DISPATCH_INTELLIGENCE_VERSION,
    generatedAtMs:nowMs,
    autoExecutionEnabled:false,
    humanConfirmationRequired:true,
    summary:{
      highRiskOrders,
      criticalOrders,
      predictedDemand15m:totalPredictedDemand15m,
      predictedAvailable15m:totalPredictedAvailable15m,
      expectedGap15m:totalExpectedGap15m,
      activeRiskZones:zoneArray.filter(z=>z.expectedGap15m<0).length,
    },
    zones:zoneArray,
    orderInsights:orderInsights.slice(0,100),
    recommendations:recommendations.slice(0,20),
  };
}

async function maybePersistDispatchIntelligence(intelligence = {}) {
  const nowMs = Date.now();
  if (nowMs - ubeeLastDispatchSnapshotMs < UBEE_DISPATCH_SNAPSHOT_INTERVAL_MS) return;
  ubeeLastDispatchSnapshotMs = nowMs;
  try {
    const slotMs = Math.floor(nowMs / UBEE_DISPATCH_SNAPSHOT_INTERVAL_MS) * UBEE_DISPATCH_SNAPSHOT_INTERVAL_MS;
    const batch = db.batch();
    (intelligence.zones || []).slice(0, 40).forEach(zone => {
      const safeZone = String(zone.zoneId || 'unknown').replace(/[\\/]/g,'_');
      const snapRef = db.collection('dispatchZoneSnapshots').doc(`${slotMs}_${safeZone}`);
      batch.set(snapRef, {
        ...zone,
        snapshotAtMs:slotMs,
        snapshotAt:admin.firestore.FieldValue.serverTimestamp(),
        intelligenceVersion:UBEE_DISPATCH_INTELLIGENCE_VERSION,
      }, {merge:true});
      const forecastRef = db.collection('dispatchForecasts').doc(safeZone);
      batch.set(forecastRef, {
        zoneId:zone.zoneId,
        district:zone.district,
        forecast15m:zone.predictedOrders15m,
        predictedAvailable15m:zone.predictedAvailableRiders15m,
        expectedGap15m:zone.expectedGap15m,
        confidence:zone.confidence,
        risk:zone.risk,
        updatedAtMs:nowMs,
        updatedAt:admin.firestore.FieldValue.serverTimestamp(),
        intelligenceVersion:UBEE_DISPATCH_INTELLIGENCE_VERSION,
      }, {merge:true});
    });
    await batch.commit();
  } catch (error) {
    console.warn('⚠️ Level4 區域快照寫入失敗（不影響調度）：', error?.message || error);
  }
}



// ============================================================
// UBee 第二階段：調度異常案件中心
// - 系統告警：即時判斷，不會直接改變訂單或自動結案。
// - 異常案件：由調度中心建立後，可分派負責人、開始處理、補充紀錄、結案與重新開啟。
// - 每張訂單、每種異常維持一份可追溯案件；再次發生時會重新開啟並保留歷史。
// ============================================================
const UBEE_DISPATCH_INCIDENT_TYPES = Object.freeze({
  NO_RIDER_ACCEPT: {
    label: '無人接單',
    defaultSeverity: 'HIGH',
  },
  RIDER_UNREACHABLE: {
    label: '小U接單後失聯',
    defaultSeverity: 'CRITICAL',
  },
  LOCATION_STALE: {
    label: '定位長時間未更新',
    defaultSeverity: 'HIGH',
  },
  CUSTOMER_CANCEL: {
    label: '客戶取消',
    defaultSeverity: 'WATCH',
  },
  MERCHANT_OUT_OF_STOCK: {
    label: '店家缺貨',
    defaultSeverity: 'WATCH',
  },
  ADDRESS_ERROR: {
    label: '地址錯誤',
    defaultSeverity: 'HIGH',
  },
  CUSTOMER_UNREACHABLE: {
    label: '聯絡不到客戶',
    defaultSeverity: 'HIGH',
  },
  AMOUNT_DISPUTE: {
    label: '金額爭議',
    defaultSeverity: 'HIGH',
  },
  OTHER: {
    label: '其他異常',
    defaultSeverity: 'WATCH',
  },
});

const UBEE_DISPATCH_INCIDENT_STATUSES = Object.freeze({
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
});

const UBEE_DISPATCH_INCIDENT_SEVERITIES = Object.freeze([
  'WATCH',
  'HIGH',
  'CRITICAL',
]);

function normalizeDispatchIncidentType(value) {
  const safe = String(value || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(
    UBEE_DISPATCH_INCIDENT_TYPES,
    safe
  ) ? safe : 'OTHER';
}

function normalizeDispatchIncidentSeverity(value, type = 'OTHER') {
  const safe = String(value || '').trim().toUpperCase();
  if (UBEE_DISPATCH_INCIDENT_SEVERITIES.includes(safe)) {
    return safe;
  }
  return UBEE_DISPATCH_INCIDENT_TYPES[
    normalizeDispatchIncidentType(type)
  ]?.defaultSeverity || 'WATCH';
}

function normalizeDispatchIncidentStatus(value) {
  const safe = String(value || '').trim().toUpperCase();
  return Object.values(UBEE_DISPATCH_INCIDENT_STATUSES).includes(safe)
    ? safe
    : UBEE_DISPATCH_INCIDENT_STATUSES.OPEN;
}

function sanitizeDispatchIncidentText(value, maxLength = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function buildDispatchIncidentId(orderId, type) {
  const safeOrderId = String(orderId || '').trim().toUpperCase();
  const safeType = normalizeDispatchIncidentType(type);
  const digest = crypto
    .createHash('sha1')
    .update(`${safeOrderId}|${safeType}`)
    .digest('hex')
    .slice(0, 16);
  return `incident_${digest}`;
}

function dispatchIncidentTimeMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value.toMillis === 'function') {
    return value.toMillis();
  }
  if (typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000;
  }
  if (typeof value._seconds === 'number') {
    return value._seconds * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildDispatchIncidentHistoryEntry({
  action,
  actor,
  note,
  status,
  severity,
  createdAtMs = Date.now(),
} = {}) {
  return {
    action: sanitizeDispatchIncidentText(action, 60),
    actor: sanitizeDispatchIncidentText(actor || 'UBee 調度中心', 80),
    note: sanitizeDispatchIncidentText(note, 800),
    status: normalizeDispatchIncidentStatus(status),
    severity: normalizeDispatchIncidentSeverity(severity),
    createdAtMs: Number(createdAtMs || Date.now()),
  };
}

function appendDispatchIncidentHistory(currentHistory, entry) {
  const list = Array.isArray(currentHistory)
    ? currentHistory.filter(item => item && typeof item === 'object')
    : [];
  return [...list, entry].slice(-60);
}

function inferDispatchIncidentTypeFromAlert(alert = {}) {
  const explicit = String(alert.incidentType || '').trim().toUpperCase();
  if (explicit && UBEE_DISPATCH_INCIDENT_TYPES[explicit]) {
    return explicit;
  }
  const type = String(alert.type || '').trim().toLowerCase();
  if (type.startsWith('waiting_')) return 'NO_RIDER_ACCEPT';
  if (type.startsWith('tracking_')) return 'LOCATION_STALE';
  if (type === 'v3_active_task_risk') {
    const message = `${alert.title || ''} ${alert.message || ''}`;
    if (/定位|gps/i.test(message)) return 'LOCATION_STALE';
    return 'RIDER_UNREACHABLE';
  }
  return 'OTHER';
}

function serializeDispatchIncident(doc) {
  const data = doc?.data ? (doc.data() || {}) : (doc || {});
  const incidentId = String(doc?.id || data.incidentId || '').trim();
  const type = normalizeDispatchIncidentType(data.type);
  const status = normalizeDispatchIncidentStatus(data.status);
  const severity = normalizeDispatchIncidentSeverity(data.severity, type);
  return {
    incidentId,
    id: incidentId,
    orderId: String(data.orderId || '').trim().toUpperCase(),
    type,
    typeLabel:
      sanitizeDispatchIncidentText(data.typeLabel, 80) ||
      UBEE_DISPATCH_INCIDENT_TYPES[type].label,
    title:
      sanitizeDispatchIncidentText(data.title, 160) ||
      UBEE_DISPATCH_INCIDENT_TYPES[type].label,
    description: sanitizeDispatchIncidentText(data.description, 1000),
    severity,
    status,
    source: sanitizeDispatchIncidentText(data.source || 'manual', 60),
    assignedTo: sanitizeDispatchIncidentText(data.assignedTo, 100),
    createdBy: sanitizeDispatchIncidentText(data.createdBy, 100),
    updatedBy: sanitizeDispatchIncidentText(data.updatedBy, 100),
    resolutionCode: sanitizeDispatchIncidentText(data.resolutionCode, 80),
    resolutionNote: sanitizeDispatchIncidentText(data.resolutionNote, 1000),
    createdAtMs:
      Number(data.createdAtMs || 0) ||
      dispatchIncidentTimeMs(data.createdAt),
    updatedAtMs:
      Number(data.updatedAtMs || 0) ||
      dispatchIncidentTimeMs(data.updatedAt),
    startedAtMs:
      Number(data.startedAtMs || 0) ||
      dispatchIncidentTimeMs(data.startedAt),
    resolvedAtMs:
      Number(data.resolvedAtMs || 0) ||
      dispatchIncidentTimeMs(data.resolvedAt),
    reopenedAtMs:
      Number(data.reopenedAtMs || 0) ||
      dispatchIncidentTimeMs(data.reopenedAt),
    reopenCount: Number(data.reopenCount || 0),
    history: Array.isArray(data.history)
      ? data.history.slice(-60).map(item => ({
          ...item,
          createdAtMs:
            Number(item?.createdAtMs || 0) ||
            dispatchIncidentTimeMs(item?.createdAt),
        }))
      : [],
  };
}


// ============================================================
// UBee 調度中心：即時監控 Dashboard API
// 僅恢復調度中心讀取資料，不修改派單／接單／財務核心流程。
// 必須放在 express.static(...) 之前。
// ============================================================
app.get('/api/dispatch/dashboard', async (req, res) => {
  try {
    const nowMs = Date.now();
    const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
    const taipeiNow = new Date(nowMs + TAIPEI_OFFSET_MS);
    const todayStartMs = Date.UTC(
      taipeiNow.getUTCFullYear(),
      taipeiNow.getUTCMonth(),
      taipeiNow.getUTCDate(), 0, 0, 0, 0
    ) - TAIPEI_OFFSET_MS;

    const toMs = value => {
      if (!value) return 0;
      if (typeof value.toDate === 'function') return value.toDate().getTime();
      if (typeof value.seconds === 'number') return value.seconds * 1000;
      if (typeof value._seconds === 'number') return value._seconds * 1000;
      if (typeof value === 'number') return value;
      const parsed = new Date(value).getTime();
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const asNumberOrNull = value => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    // 調度中心必須保留「全部已審核小U」，不能因暫停接單或失聯而消失。
    // 目前先支援最多 5,000 名，對應 UBee 台中 5,000 小U密度計畫。
    const riderSnap = await db.collection('riders').limit(5000).get();
    const allApprovedRiders = riderSnap.docs
      .map(doc => {
        const r = doc.data() || {};
        const approved =
          r.approved === true ||
          String(r.status || '').trim().toLowerCase() === 'approved';

        if (!approved) {
          return null;
        }

        // 「最後定位」與「最後活動」分開計算。
        // 即使位置已經很舊，仍保留最後已知座標供調度中心辨識，但必須標示非即時。
        const locationUpdatedAtMs =
          Number(r.locationUpdatedAtMs || 0) ||
          toMs(r.locationUpdatedAt) ||
          toMs(r.currentLocation && r.currentLocation.updatedAt);

        const lastActiveAtMs =
          Number(r.lastActiveMs || r.onlineUpdatedAtMs || 0) ||
          toMs(r.lastActive) ||
          toMs(r.onlineUpdatedAt) ||
          toMs(r.updatedAt) ||
          locationUpdatedAtMs;

        // declaredOnline：小U自己最後一次選擇仍保持「上線」。
        // online：再加上 5 分鐘活動新鮮度，只供即時派單／候選判斷使用。
        // 兩者刻意分開，避免調度地圖因 heartbeat 逾時就看不到仍保持上線的小U。
        const declaredOnline =
          r.online === true ||
          r.acceptingOrders === true;

        const isFresh =
          !!lastActiveAtMs &&
          (nowMs - lastActiveAtMs) >= 0 &&
          (nowMs - lastActiveAtMs) <= 5 * 60 * 1000;

        // online 是「此刻可視為在線」；declaredOnline 是騎士最後一次選擇是否願意接單。
        const online = declaredOnline && isFresh;
        const busy = r.busy === true || !!String(r.currentOrderId || '').trim();

        let dispatchState = 'OFFLINE';
        if (busy) {
          dispatchState = 'BUSY';
        } else if (online) {
          dispatchState = 'AVAILABLE';
        } else if (!declaredOnline) {
          dispatchState = 'PAUSED';
        }

        let connectionState = 'UNKNOWN';
        if (isFresh) {
          connectionState = 'LIVE';
        } else if (lastActiveAtMs) {
          connectionState = 'STALE';
        }

        return {
          riderId: r.riderId || doc.id,
          riderDocId: doc.id,
          name: r.name || r.riderName || '',
          phone: r.phone || '',
          district: r.district || r.cityDistrict || '',
          serviceArea: r.serviceArea || r.area || '',
          approved: true,
          declaredOnline,
          online,
          acceptingOrders: online && !busy,
          busy,
          currentOrderId: r.currentOrderId || '',
          currentLat: asNumberOrNull(r.currentLat ?? r.lat ?? r.latitude),
          currentLng: asNumberOrNull(r.currentLng ?? r.lng ?? r.longitude),
          locationUpdatedAtMs,
          lastActiveAtMs,
          locationAgeMs: locationUpdatedAtMs ? Math.max(0, nowMs - locationUpdatedAtMs) : null,
          lastActiveAgeMs: lastActiveAtMs ? Math.max(0, nowMs - lastActiveAtMs) : null,
          connectionState,
          dispatchState,
          taskTrackingStatus: r.taskTrackingStatus || '',
          taskTrackingSource: r.taskTrackingSource || '',
          taskTrackingUpdatedAtMs:
            Number(r.taskTrackingUpdatedAtMs || 0) ||
            toMs(r.taskTrackingUpdatedAt)
        };
      })
      .filter(Boolean);

    // 智慧候選與既有派單判斷只使用真正在線的小U，避免把暫停／離線者誤列為可派單。
    // 稍後會以 orders 的真實進行中訂單重新校正 BUSY，避免幽靈任務。
    let activeRiders = [];

    // 不使用複合索引，避免新環境第一次部署因 Firestore index 造成讀取失敗。
    let orderSnap;
    try {
      // Level 4 預測優先使用最近資料；createdAt 是單欄位索引，不需複合索引。
      orderSnap = await db.collection('orders').orderBy('createdAt', 'desc').limit(800).get();
    } catch (orderQueryError) {
      console.warn('⚠️ Level4 最新訂單排序讀取失敗，退回既有安全查詢：', orderQueryError?.message || orderQueryError);
      orderSnap = await db.collection('orders').limit(800).get();
    }
    const allOrders = orderSnap.docs.map(doc => ({ id: doc.id, ...(doc.data() || {}) }));

    // 第二階段：讀取異常案件。先不使用複合索引，全部在記憶體排序與分組。
    let incidentSnap;
    try {
      incidentSnap = await db.collection('dispatchIncidents').limit(1000).get();
    } catch (incidentQueryError) {
      console.warn(
        '⚠️ 調度異常案件讀取失敗，暫時只顯示即時系統告警：',
        incidentQueryError?.message || incidentQueryError
      );
      incidentSnap = { docs: [] };
    }

    const allIncidents = incidentSnap.docs
      .map(serializeDispatchIncident)
      .filter(incident => incident.incidentId && incident.orderId)
      .sort((a, b) => Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0));

    const activeIncidentStatuses = new Set([
      UBEE_DISPATCH_INCIDENT_STATUSES.OPEN,
      UBEE_DISPATCH_INCIDENT_STATUSES.IN_PROGRESS,
    ]);

    const openIncidents = allIncidents.filter(incident =>
      activeIncidentStatuses.has(incident.status)
    );

    const incidentsByOrder = new Map();
    allIncidents.forEach(incident => {
      const key = String(incident.orderId || '').trim().toUpperCase();
      if (!key) return;
      if (!incidentsByOrder.has(key)) incidentsByOrder.set(key, []);
      incidentsByOrder.get(key).push(incident);
    });

    const waitingStatuses = new Set([
      'pending_dispatch', 'pending', 'waiting', 'searching', 'dispatching', 'redispatching'
    ]);
    const activeStatuses = new Set([
      'accepted',
      'going_to_pickup', 'heading_to_pickup', 'arrived_pickup',
      'picked_up',
      'going_to_dropoff', 'heading_to_dropoff', 'arrived_dropoff'
    ]);
    const completedStatuses = new Set(['completed']);

    // ============================================================
    // UBee 調度真相層：任務中必須以 orders 真實進行中訂單為準
    // riders.busy / riders.currentOrderId 只能當提示，不能單獨決定 BUSY。
    // ============================================================
    let authoritativeActiveOrders = [];
    let activeOrderTruthReliable = false;

    try {
      const activeOrderSnap = await db
        .collection('orders')
        .where('status', 'in', Array.from(activeStatuses))
        .limit(1000)
        .get();

      authoritativeActiveOrders = activeOrderSnap.docs.map(doc => ({
        id: doc.id,
        ...(doc.data() || {})
      }));
      activeOrderTruthReliable = true;
    } catch (activeOrderTruthError) {
      console.warn(
        '⚠️ 調度中心進行中訂單真相查詢失敗，暫以 dashboard 訂單資料判斷：',
        activeOrderTruthError?.message || activeOrderTruthError
      );
      authoritativeActiveOrders = allOrders.filter(order =>
        activeStatuses.has(String(order.status || '').trim())
      );
    }

    const normalizeDispatchIdentity = value =>
      String(value || '').trim().toLowerCase();

    const normalizeDispatchPhone = value =>
      String(value || '').replace(/\D/g, '');

    const activeOrderForRider = rider => {
      const riderIds = new Set([
        rider.riderDocId,
        rider.riderId
      ].map(normalizeDispatchIdentity).filter(Boolean));
      const riderPhone = normalizeDispatchPhone(rider.phone);

      return authoritativeActiveOrders.find(order => {
        const orderIds = [
          order.riderDocId,
          order.riderId,
          order.driverId
        ].map(normalizeDispatchIdentity).filter(Boolean);
        const orderPhone = normalizeDispatchPhone(
          order.riderPhone || order.driverPhone || ''
        );

        if (rider.currentOrderId &&
            normalizeDispatchIdentity(order.id) === normalizeDispatchIdentity(rider.currentOrderId)) {
          return true;
        }

        if (orderIds.some(id => riderIds.has(id))) {
          return true;
        }

        return !!riderPhone && !!orderPhone && riderPhone === orderPhone;
      }) || null;
    };

    const ghostBusyRiders = [];

    for (const rider of allApprovedRiders) {
      const matchedActiveOrder = activeOrderForRider(rider);
      const hadBusyResidue =
        rider.busy === true ||
        !!String(rider.currentOrderId || '').trim();
      const verifiedBusy = !!matchedActiveOrder;

      // 任務中小U的位置以「riders + orders」兩份資料取最新者。
      // 這讓調度中心不會因一般在線 5 分鐘新鮮度逾時而失去任務中的小U。
      if (matchedActiveOrder) {
        const orderLocationUpdatedAtMs =
          Number(matchedActiveOrder.riderLocationUpdatedAtMs || 0) ||
          toMs(matchedActiveOrder.riderLocationUpdatedAt) ||
          toMs(matchedActiveOrder.riderCurrentLocation && matchedActiveOrder.riderCurrentLocation.updatedAt);

        const orderLat = asNumberOrNull(
          matchedActiveOrder.riderCurrentLat ??
          matchedActiveOrder.riderCurrentLocation?.lat
        );

        const orderLng = asNumberOrNull(
          matchedActiveOrder.riderCurrentLng ??
          matchedActiveOrder.riderCurrentLocation?.lng
        );

        const hasOrderLocation =
          orderLat !== null &&
          orderLng !== null;

        if (
          hasOrderLocation &&
          (
            !Number.isFinite(Number(rider.currentLat)) ||
            !Number.isFinite(Number(rider.currentLng)) ||
            orderLocationUpdatedAtMs >= Number(rider.locationUpdatedAtMs || 0)
          )
        ) {
          rider.currentLat = orderLat;
          rider.currentLng = orderLng;
          rider.locationUpdatedAtMs = orderLocationUpdatedAtMs || rider.locationUpdatedAtMs || 0;
          rider.locationAgeMs = rider.locationUpdatedAtMs
            ? Math.max(0, nowMs - rider.locationUpdatedAtMs)
            : null;
        }

        rider.riderTrackingStatus =
          matchedActiveOrder.riderTrackingStatus ||
          rider.taskTrackingStatus ||
          'starting';

        rider.riderTrackingSource =
          matchedActiveOrder.riderTrackingSource ||
          rider.taskTrackingSource ||
          '';

        rider.trackingUpdatedAtMs =
          Number(matchedActiveOrder.trackingUpdatedAtMs || 0) ||
          orderLocationUpdatedAtMs ||
          0;

        rider.trackingSessionId =
          matchedActiveOrder.trackingSessionId ||
          '';
      }

      rider.busy = verifiedBusy;
      rider.currentOrderId = matchedActiveOrder
        ? String(matchedActiveOrder.id || '').trim()
        : '';
      rider.acceptingOrders = rider.online === true && !verifiedBusy;
      rider.ghostBusy = hadBusyResidue && !verifiedBusy;

      if (verifiedBusy) {
        rider.dispatchState = 'BUSY';
      } else if (rider.online === true) {
        rider.dispatchState = 'AVAILABLE';
      } else if (rider.declaredOnline === false) {
        rider.dispatchState = 'PAUSED';
      } else {
        rider.dispatchState = 'OFFLINE';
      }

      // ============================================================
      // 調度地圖顯示層
      //
      // mapOnline / mapVisible 只控制「地圖上要不要看得到」：
      // - 綠色 U：只顯示目前真正開啟騎士端、近期 heartbeat 仍有效的小U。
      // - 真正進行中任務：藍色 U，永遠優先保留。
      //
      // rider.online 仍是即時在線與派單資格的主要判定。
      // ============================================================
      rider.mapOnline =
        rider.online === true &&
        !verifiedBusy;
      rider.mapVisible =
        verifiedBusy ||
        rider.mapOnline;
      rider.mapState =
        verifiedBusy
          ? 'BUSY'
          : rider.mapOnline
            ? 'ONLINE'
            : rider.dispatchState;
      rider.mapLocationFresh =
        !!rider.locationUpdatedAtMs &&
        (nowMs - Number(rider.locationUpdatedAtMs)) >= 0 &&
        (nowMs - Number(rider.locationUpdatedAtMs)) <= 5 * 60 * 1000;

      if (rider.ghostBusy) {
        ghostBusyRiders.push(rider);
      }
    }

    // 只有查詢真相成功時才自動清除 Firestore 殘留 busy/currentOrderId，避免誤修。
    if (activeOrderTruthReliable && ghostBusyRiders.length) {
      try {
        const repairBatch = db.batch();
        ghostBusyRiders.slice(0, 400).forEach(rider => {
          repairBatch.set(
            db.collection('riders').doc(rider.riderDocId),
            {
              busy: false,
              currentOrderId: '',
              ghostBusyRepairedAtMs: nowMs,
              ghostBusyRepairedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        });
        await repairBatch.commit();
        console.log(`✅ 已自動修復 ${Math.min(ghostBusyRiders.length, 400)} 位小U幽靈任務狀態`);
      } catch (ghostRepairError) {
        console.warn('⚠️ 幽靈任務狀態自動修復失敗（不影響調度畫面）：', ghostRepairError?.message || ghostRepairError);
      }
    }

    // 智慧候選只使用真正在線者；BUSY 已由 orders 真實狀態校正。
    activeRiders = allApprovedRiders.filter(r => r.online);

    const orderTimeMs = o =>
      Number(o.createdAtMs || o.orderCreatedAtMs || o.submittedAtMs || 0) ||
      toMs(o.createdAt) || toMs(o.orderCreatedAt) || toMs(o.submittedAt);

    const completedTimeMs = o =>
      Number(o.completedAtMs || 0) ||
      toMs(o.completedAt) ||
      toMs(o.statusTimes && o.statusTimes.completed);

    const statusLabel = status => {
      if (typeof getStatusLabel === 'function') {
        try { return getStatusLabel(status); } catch (_) {}
      }
      const labels = {
        pending_dispatch: '待派單', pending: '待派單', waiting: '待派單',
        searching: '媒合中', dispatching: '派單中', redispatching: '重新派單中',
        accepted: '小U已接單', going_to_pickup: '前往取件', heading_to_pickup: '前往取件',
        arrived_pickup: '已抵達取件點', picked_up: '已取件',
        going_to_dropoff: '配送中', heading_to_dropoff: '配送中', arrived_dropoff: '已抵達送達點',
        completed: '已完成'
      };
      return labels[String(status || '').trim()] || String(status || '');
    };

    const liveOrders = allOrders
      .filter(o => {
        const status = String(o.status || '').trim();
        return waitingStatuses.has(status) || activeStatuses.has(status);
      })
      .sort((a, b) => orderTimeMs(b) - orderTimeMs(a))
      .slice(0, 150)
      .map(o => ({
        id: o.id,
        orderNo: o.orderNo || o.id,
        status: o.status || '',
        statusLabel: statusLabel(o.status),
        pickupAddress: o.pickupAddress || o.fromAddress || '',
        dropoffAddress: o.dropoffAddress || o.toAddress || '',
        pickupLat: asNumberOrNull(o.pickupLat ?? o.fromLat),
        pickupLng: asNumberOrNull(o.pickupLng ?? o.fromLng),
        dropoffLat: asNumberOrNull(o.dropoffLat ?? o.toLat),
        dropoffLng: asNumberOrNull(o.dropoffLng ?? o.toLng),
        total: Number(o.total || o.customerPayableTotal || o.finalTotal || 0),
        riderName: o.riderName || o.driverName || '',
        riderId: o.riderId || o.riderDocId || '',
        riderDocId: o.riderDocId || '',
        riderPhone: o.riderPhone || o.driverPhone || '',

        // 任務中小U最後位置：即使 Web/PWA 暫時失去背景 GPS，也保留最後已知位置。
        riderCurrentLat: asNumberOrNull(o.riderCurrentLat ?? o.riderCurrentLocation?.lat),
        riderCurrentLng: asNumberOrNull(o.riderCurrentLng ?? o.riderCurrentLocation?.lng),
        riderLocationUpdatedAtMs:
          Number(o.riderLocationUpdatedAtMs || 0) ||
          toMs(o.riderLocationUpdatedAt) ||
          toMs(o.riderCurrentLocation && o.riderCurrentLocation.updatedAt),
        riderTrackingStatus: o.riderTrackingStatus || '',
        riderTrackingSource: o.riderTrackingSource || '',
        riderTrackingIsBackground: o.riderTrackingIsBackground === true,
        trackingSessionId: o.trackingSessionId || '',
        trackingUpdatedAtMs:
          Number(o.trackingUpdatedAtMs || 0) ||
          toMs(o.trackingUpdatedAt),
        riderHeading: o.riderHeading ?? null,
        riderSpeed: o.riderSpeed ?? null,
        riderLocationAccuracy: o.riderLocationAccuracy ?? null,

        dispatchRadiusKm: Number(o.dispatchManualRadiusKm || o.dispatchManualRedispatchRadiusKm || 0) || null,
        speedType: o.speedType || '',
        serviceType: o.serviceType || '',
        orderSource: o.orderSource || o.source || '',
        merchantOrder: o.merchantOrder === true || String(o.orderSource || o.source || '').toLowerCase().includes('merchant'),
        customerName: o.customerName || o.contactName || '',
        customerPhone: o.customerPhone || o.contactPhone || '',
        merchantName: o.merchantName || o.storeName || '',
        pickupDistrict: o.pickupDistrict || inferDispatchDistrict(o.pickupAddress || o.fromAddress || ''),
        pickupZoneId: o.pickupZoneId || buildDispatchZoneId(inferDispatchDistrict(o.pickupAddress || o.fromAddress || '')),
        skippedRiderIds: Array.isArray(o.skippedRiderIds) ? o.skippedRiderIds : [],
        createdAtMs: orderTimeMs(o),
        acceptedAtMs:
          Number(o.acceptedAtMs || 0) ||
          toMs(o.acceptedAt) ||
          toMs(o.statusTimes && o.statusTimes.accepted),
        arrivedPickupAtMs:
          Number(o.arrivedPickupAtMs || 0) ||
          toMs(o.arrivedPickupAt) ||
          toMs(o.statusTimes && o.statusTimes.arrived_pickup),
        pickedUpAtMs:
          Number(o.pickedUpAtMs || 0) ||
          toMs(o.pickedUpAt) ||
          toMs(o.statusTimes && o.statusTimes.picked_up),
        arrivedDropoffAtMs:
          Number(o.arrivedDropoffAtMs || 0) ||
          toMs(o.arrivedDropoffAt) ||
          toMs(o.statusTimes && o.statusTimes.arrived_dropoff),
        riderLocationTrail: Array.isArray(o.riderLocationTrail)
          ? o.riderLocationTrail.slice(-40)
          : []
      }));

    const waitingOrders = liveOrders.filter(o => waitingStatuses.has(String(o.status || '').trim()));
    const activeOrders = liveOrders.filter(o => activeStatuses.has(String(o.status || '').trim()));
    const todayCompleted = allOrders.filter(o =>
      completedStatuses.has(String(o.status || '').trim()) &&
      completedTimeMs(o) >= todayStartMs
    ).length;

    const alerts = [];
    waitingOrders.forEach(o => {
      const createdAtMs = Number(o.createdAtMs || 0);
      if (!createdAtMs) return;
      const ageMs = nowMs - createdAtMs;
      if (ageMs >= 5 * 60 * 1000) {
        alerts.push({
          type: 'waiting_5m',
          incidentType: 'NO_RIDER_ACCEPT',
          severity: ageMs >= 10 * 60 * 1000 ? 'CRITICAL' : 'HIGH',
          title: '超過 5 分鐘無人接單',
          message: `${o.id} 已等待 ${Math.floor(ageMs / 60000)} 分鐘`,
          orderId: o.id
        });
      } else if (ageMs >= 3 * 60 * 1000) {
        alerts.push({
          type: 'waiting_3m',
          incidentType: 'NO_RIDER_ACCEPT',
          severity: 'WATCH',
          title: '超過 3 分鐘無人接單',
          message: `${o.id} 已等待 ${Math.floor(ageMs / 60000)} 分鐘`,
          orderId: o.id
        });
      }
    });

    // 任務中的 GPS 失聯只告警，不把小U從調度地圖移除。
    activeOrders.forEach(o => {
      const locationAtMs = Number(o.riderLocationUpdatedAtMs || 0);

      if (!locationAtMs) {
        alerts.push({
          type: 'tracking_waiting',
          incidentType: 'LOCATION_STALE',
          severity: 'WATCH',
          title: '任務中尚未收到小U定位',
          message: `${o.id} 已接單，但尚未收到任務 GPS。`,
          orderId: o.id
        });
        return;
      }

      const locationAgeMs = Math.max(0, nowMs - locationAtMs);

      if (locationAgeMs >= 10 * 60 * 1000) {
        alerts.push({
          type: 'tracking_stale_10m',
          incidentType: 'LOCATION_STALE',
          severity: 'CRITICAL',
          title: '小U定位長時間未更新',
          message: `${o.id} 的小U定位已 ${Math.floor(locationAgeMs / 60000)} 分鐘未更新，地圖仍保留最後已知位置。`,
          orderId: o.id
        });
      } else if (locationAgeMs >= 3 * 60 * 1000) {
        alerts.push({
          type: 'tracking_stale_3m',
          incidentType: 'LOCATION_STALE',
          severity: 'HIGH',
          title: '小U定位暫時中斷',
          message: `${o.id} 的小U定位已 ${Math.floor(locationAgeMs / 60000)} 分鐘未更新。`,
          orderId: o.id
        });
      }
    });

    const intelligence = await buildDispatchIntelligence({
      riders: activeRiders,
      allOrders,
      waitingStatuses,
      activeStatuses,
      nowMs,
      todayStartMs,
    });

    const insightMap = new Map(
      (intelligence.orderInsights || []).map(item => [String(item.orderId), item])
    );
    const enrichedLiveOrders = liveOrders.map(order => {
      const insight = insightMap.get(String(order.id)) || null;
      const orderIncidents = incidentsByOrder.get(
        String(order.id || '').trim().toUpperCase()
      ) || [];
      const activeOrderIncidents = orderIncidents.filter(incident =>
        activeIncidentStatuses.has(incident.status)
      );
      return {
        ...order,
        incidents: orderIncidents.slice(0, 20),
        openIncidents: activeOrderIncidents.slice(0, 20),
        openIncidentCount: activeOrderIncidents.length,
        highestIncidentSeverity:
          activeOrderIncidents.some(item => item.severity === 'CRITICAL')
            ? 'CRITICAL'
            : activeOrderIncidents.some(item => item.severity === 'HIGH')
              ? 'HIGH'
              : activeOrderIncidents.length
                ? 'WATCH'
                : '',
        riskScore: insight?.score ?? 0,
        riskLevel: insight?.level ?? 'NORMAL',
        riskKind: insight?.kind || '',
        riskStage: insight?.stage || '',
        riskReasons: insight?.reasons || [],
        recoveryEligible: insight?.recoveryEligible === true,
        custodyLocked: insight?.custodyLocked === true,
        stageElapsedMinutes: insight?.stageElapsedMinutes ?? null,
        locationAgeMs: insight?.locationAgeMs ?? null,
        pickupDistanceKm: insight?.pickupDistanceKm ?? null,
        dropoffDistanceKm: insight?.dropoffDistanceKm ?? null,
        candidateRecommendations: insight?.candidates || [],
        intelligenceRecommendations: insight?.recommendations || [],
      };
    });

    // V3：進行中任務使用整合風險提醒，取代舊的單一 GPS 重複告警。
    const activeRiskAlerts = (intelligence.orderInsights || [])
      .filter(insight =>
        insight.kind === 'ACTIVE_TASK_RISK' &&
        insight.level !== 'NORMAL'
      )
      .map(insight => ({
        type: 'v3_active_task_risk',
        incidentType:
          (insight.reasons || []).some(reason => /定位|GPS/i.test(String(reason || '')))
            ? 'LOCATION_STALE'
            : 'RIDER_UNREACHABLE',
        severity: insight.level,
        title:
          insight.level === 'CRITICAL'
            ? '緊急任務異常'
            : insight.level === 'HIGH'
              ? '高風險任務'
              : '任務需要注意',
        message: `${insight.orderId}｜${(insight.reasons || []).slice(0, 3).join('；') || '任務風險升高'}`,
        orderId: insight.orderId,
        recoveryEligible: insight.recoveryEligible === true,
        custodyLocked: insight.custodyLocked === true,
        actions: insight.recommendations || [],
      }));

    const legacyNonTrackingAlerts = alerts.filter(alert =>
      !String(alert.type || '').startsWith('tracking_')
    );

    const persistedIncidentAlerts = openIncidents.map(incident => ({
      type: 'persisted_incident',
      incidentType: incident.type,
      incidentId: incident.incidentId,
      incidentStatus: incident.status,
      severity: incident.severity,
      title: incident.title || incident.typeLabel || '異常案件',
      message:
        `${incident.orderId}｜${incident.description || incident.typeLabel}` +
        `${incident.assignedTo ? `｜負責人：${incident.assignedTo}` : ''}`,
      orderId: incident.orderId,
      assignedTo: incident.assignedTo,
      createdAtMs: incident.createdAtMs,
      updatedAtMs: incident.updatedAtMs,
      source: incident.source,
    }));

    const activeIncidentKeySet = new Set(
      openIncidents.map(incident =>
        `${incident.orderId}|${incident.type}`
      )
    );

    const rawSystemAlerts = [...activeRiskAlerts, ...legacyNonTrackingAlerts]
      .map(alert => ({
        ...alert,
        incidentType: inferDispatchIncidentTypeFromAlert(alert),
        severity: normalizeDispatchIncidentSeverity(
          alert.severity,
          inferDispatchIncidentTypeFromAlert(alert)
        ),
      }))
      .filter(alert =>
        !activeIncidentKeySet.has(
          `${String(alert.orderId || '').trim().toUpperCase()}|${alert.incidentType}`
        )
      );

    const finalAlerts = [...persistedIncidentAlerts, ...rawSystemAlerts]
      .sort((a, b) => {
        const rank = { CRITICAL: 4, HIGH: 3, WATCH: 2, warning: 2, info: 1 };
        const severityDiff =
          (rank[String(b.severity || '').toUpperCase()] || 0) -
          (rank[String(a.severity || '').toUpperCase()] || 0);
        if (severityDiff) return severityDiff;
        return Number(b.updatedAtMs || b.createdAtMs || 0) -
          Number(a.updatedAtMs || a.createdAtMs || 0);
      });

    // ============================================================
    // V4 + V5：全局控制塔 / 任務階段 / 小U健康 / 城市供需視圖
    // ============================================================
    const stageSummary = {
      waitingDispatch: waitingOrders.length,
      goingToPickup: 0,
      waitingPickup: 0,
      delivering: 0,
      arrivedDropoff: 0,
    };

    enrichedLiveOrders.forEach(order => {
      const status = String(order.status || '').trim();
      if (['accepted','going_to_pickup','heading_to_pickup'].includes(status)) {
        stageSummary.goingToPickup += 1;
      } else if (status === 'arrived_pickup') {
        stageSummary.waitingPickup += 1;
      } else if (['picked_up','going_to_dropoff','heading_to_dropoff'].includes(status)) {
        stageSummary.delivering += 1;
      } else if (status === 'arrived_dropoff') {
        stageSummary.arrivedDropoff += 1;
      }
    });

    const riskSummary = { NORMAL:0, WATCH:0, HIGH:0, CRITICAL:0 };
    enrichedLiveOrders.forEach(order => {
      const level = String(order.riskLevel || 'NORMAL').toUpperCase();
      if (Object.prototype.hasOwnProperty.call(riskSummary, level)) riskSummary[level] += 1;
      else riskSummary.NORMAL += 1;
    });

    const orderByRiderKey = new Map();
    enrichedLiveOrders.forEach(order => {
      [order.riderDocId, order.riderId, order.riderPhone].forEach(key => {
        const safeKey = String(key || '').trim().toLowerCase();
        if (safeKey) orderByRiderKey.set(safeKey, order);
      });
    });

    const riderHealthSummary = { HEALTHY:0, TASK:0, UNSTABLE:0, CRITICAL:0, OFFLINE:0 };
    const enrichedRiders = allApprovedRiders.map(rider => {
      const riderKeys = [rider.riderDocId, rider.riderId, rider.phone]
        .map(value => String(value || '').trim().toLowerCase())
        .filter(Boolean);
      const activeOrder = riderKeys.map(key => orderByRiderKey.get(key)).find(Boolean) || null;
      const locationAgeMs = Number(rider.locationAgeMs ?? 0);
      let healthState = 'OFFLINE';
      let healthLabel = '離線';
      let healthReason = '目前沒有即時連線';

      if (activeOrder) {
        const level = String(activeOrder.riskLevel || 'NORMAL').toUpperCase();
        if (['HIGH','CRITICAL'].includes(level)) {
          healthState = 'CRITICAL';
          healthLabel = '任務異常';
          healthReason = (activeOrder.riskReasons || []).slice(0,2).join('；') || '任務風險升高';
        } else {
          healthState = 'TASK';
          healthLabel = '任務執行中';
          healthReason = `訂單 ${activeOrder.id}｜${activeOrder.statusLabel || activeOrder.status || '進行中'}`;
        }
      } else if (rider.online === true) {
        if (!rider.locationUpdatedAtMs || locationAgeMs > 3 * 60 * 1000) {
          healthState = 'UNSTABLE';
          healthLabel = '連線不穩';
          healthReason = rider.locationUpdatedAtMs ? `定位已 ${Math.floor(locationAgeMs/60000)} 分鐘未更新` : '尚無有效定位';
        } else {
          healthState = 'HEALTHY';
          healthLabel = '狀態良好';
          healthReason = '在線且定位正常';
        }
      } else if (rider.declaredOnline === true) {
        healthState = 'UNSTABLE';
        healthLabel = '等待重新連線';
        healthReason = '仍保持上線意願，但 heartbeat 已逾時';
      }

      riderHealthSummary[healthState] = (riderHealthSummary[healthState] || 0) + 1;
      return {
        ...rider,
        healthState,
        healthLabel,
        healthReason,
        healthOrderId: activeOrder?.id || '',
        healthRiskLevel: activeOrder?.riskLevel || 'NORMAL',
      };
    });

    const zoneOperations = (intelligence.zones || []).map(zone => ({
      ...zone,
      operationalState:
        Number(zone.expectedGap15m || 0) <= -5 ? 'CRITICAL' :
        Number(zone.expectedGap15m || 0) <= -2 ? 'HIGH' :
        Number(zone.expectedGap15m || 0) < 0 ? 'WATCH' :
        Number(zone.availableRiders || 0) >= Math.max(8, Number(zone.waitingOrders || 0) * 4) ? 'SURPLUS' :
        'BALANCED',
      operationalLabel:
        Number(zone.expectedGap15m || 0) <= -5 ? '嚴重缺運力' :
        Number(zone.expectedGap15m || 0) <= -2 ? '運力不足' :
        Number(zone.expectedGap15m || 0) < 0 ? '需要注意' :
        Number(zone.availableRiders || 0) >= Math.max(8, Number(zone.waitingOrders || 0) * 4) ? '運力充足' :
        '供需平衡',
    }));

    const operationsV5 = {
      version: 'V4+V5',
      generatedAtMs: nowMs,
      controlTower: {
        totalLiveOrders: enrichedLiveOrders.length,
        riskSummary,
        stageSummary,
      },
      riderHealthSummary,
      zones: zoneOperations,
      cityStatus:
        riskSummary.CRITICAL > 0 ? 'CRITICAL' :
        riskSummary.HIGH > 0 || zoneOperations.some(z => ['CRITICAL','HIGH'].includes(z.operationalState)) ? 'HIGH' :
        riskSummary.WATCH > 0 || zoneOperations.some(z => z.operationalState === 'WATCH') ? 'WATCH' :
        'NORMAL',
    };

    const incidentSummary = {
      open: allIncidents.filter(item => item.status === 'OPEN').length,
      inProgress: allIncidents.filter(item => item.status === 'IN_PROGRESS').length,
      resolvedToday: allIncidents.filter(item =>
        item.status === 'RESOLVED' &&
        Number(item.resolvedAtMs || 0) >= todayStartMs
      ).length,
      totalResolved: allIncidents.filter(item => item.status === 'RESOLVED').length,
      totalActive: openIncidents.length,
      criticalActive: openIncidents.filter(item => item.severity === 'CRITICAL').length,
      highActive: openIncidents.filter(item => item.severity === 'HIGH').length,
    };

    maybePersistDispatchIntelligence(intelligence).catch(()=>{});

    return res.json({
      success: true,
      generatedAtMs: nowMs,
      summary: {
        totalRiders: allApprovedRiders.length,
        onlineRiders: activeRiders.length,
        // 地圖上綠色 U：只計目前真正在線、近期 heartbeat 仍有效的小U。
        mapOnlineRiders: allApprovedRiders.filter(r => r.mapOnline === true).length,

        // 地圖可實際顯示的上線小U：只計入台灣營運範圍內的有效座標，
        // 避免 0,0、測試座標或異常舊座標把 Google Maps 自動縮放到世界地圖。
        mapOnlineWithLocationRiders: allApprovedRiders.filter(r => {
          if (r.mapOnline !== true) return false;
          const lat = Number(r.currentLat);
          const lng = Number(r.currentLng);
          return (
            Number.isFinite(lat) &&
            Number.isFinite(lng) &&
            lat >= 21.5 &&
            lat <= 26.5 &&
            lng >= 118 &&
            lng <= 123.8
          );
        }).length,

        availableRiders: activeRiders.filter(r => !r.busy).length,
        busyRiders: allApprovedRiders.filter(r => r.dispatchState === 'BUSY').length,
        pausedRiders: allApprovedRiders.filter(r => r.dispatchState === 'PAUSED').length,
        offlineRiders: allApprovedRiders.filter(r => r.dispatchState === 'OFFLINE').length,
        ghostBusyRepaired: ghostBusyRiders.length,
        waitingOrders: waitingOrders.length,
        activeOrders: activeOrders.length,
        todayCompleted,
        highRiskOrders: intelligence.summary?.highRiskOrders || 0,
        predictedDemand15m: intelligence.summary?.predictedDemand15m || 0,
        predictedAvailable15m: intelligence.summary?.predictedAvailable15m || 0,
        expectedGap15m: intelligence.summary?.expectedGap15m || 0,
        openIncidents: incidentSummary.open,
        inProgressIncidents: incidentSummary.inProgress,
        resolvedIncidentsToday: incidentSummary.resolvedToday,
        activeIncidentTotal: incidentSummary.totalActive
      },
      orders: enrichedLiveOrders,
      // 回傳全部已審核小U；前端自行以狀態分組／篩選。
      riders: enrichedRiders,
      alerts: finalAlerts.slice(0, 150),
      incidents: allIncidents.slice(0, 300),
      incidentSummary,
      incidentTypes: Object.entries(UBEE_DISPATCH_INCIDENT_TYPES).map(([value, meta]) => ({
        value,
        label: meta.label,
        defaultSeverity: meta.defaultSeverity,
      })),
      intelligence,
      operationsV5
    });
  } catch (err) {
    console.error('❌ UBee 調度中心 dashboard 讀取失敗：', err);
    return res.status(500).json({
      success: false,
      message: '調度中心資料讀取失敗，請稍後再試。',
      error: err.message
    });
  }
});


// ============================================================
// 第二階段：建立／重新開啟異常案件
// 不會自動取消訂單、修改金額或直接重新派單；高風險動作仍由既有調度 API 處理。
// ============================================================
app.post('/api/dispatch/orders/:orderId/incidents', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim().toUpperCase();
    if (!orderId) {
      return res.status(400).json({ success: false, message: '缺少訂單編號。' });
    }

    const type = normalizeDispatchIncidentType(req.body?.type);
    const severity = normalizeDispatchIncidentSeverity(req.body?.severity, type);
    const meta = UBEE_DISPATCH_INCIDENT_TYPES[type];
    const actor = sanitizeDispatchIncidentText(
      req.body?.actor || req.body?.createdBy || 'UBee 調度中心',
      100
    );
    const assignedTo = sanitizeDispatchIncidentText(req.body?.assignedTo, 100);
    const title = sanitizeDispatchIncidentText(req.body?.title, 160) || meta.label;
    const description = sanitizeDispatchIncidentText(req.body?.description, 1000);
    const source = sanitizeDispatchIncidentText(req.body?.source || 'manual', 60);
    const nowMs = Date.now();
    const incidentId = buildDispatchIncidentId(orderId, type);
    const incidentRef = db.collection('dispatchIncidents').doc(incidentId);
    const orderRef = db.collection('orders').doc(orderId);

    let result = null;

    await db.runTransaction(async tx => {
      const [orderDoc, incidentDoc] = await Promise.all([
        tx.get(orderRef),
        tx.get(incidentRef),
      ]);

      if (!orderDoc.exists) {
        const error = new Error('ORDER_NOT_FOUND');
        error.code = 'ORDER_NOT_FOUND';
        throw error;
      }

      const current = incidentDoc.exists ? (incidentDoc.data() || {}) : {};
      const previousStatus = normalizeDispatchIncidentStatus(current.status);
      const isReopen = incidentDoc.exists && previousStatus === 'RESOLVED';
      const nextStatus = isReopen
        ? UBEE_DISPATCH_INCIDENT_STATUSES.OPEN
        : previousStatus;

      const historyEntry = buildDispatchIncidentHistoryEntry({
        action: isReopen ? 'REOPENED' : incidentDoc.exists ? 'UPDATED' : 'CREATED',
        actor,
        note: description || (isReopen ? '異常再次發生，重新開啟案件。' : '建立異常案件。'),
        status: nextStatus,
        severity,
        createdAtMs: nowMs,
      });

      const payload = {
        incidentId,
        orderId,
        type,
        typeLabel: meta.label,
        title,
        description: description || sanitizeDispatchIncidentText(current.description, 1000),
        severity,
        status: nextStatus,
        source,
        assignedTo: assignedTo || sanitizeDispatchIncidentText(current.assignedTo, 100),
        createdBy: sanitizeDispatchIncidentText(current.createdBy, 100) || actor,
        updatedBy: actor,
        updatedAtMs: nowMs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastDetectedAtMs: nowMs,
        lastDetectedAt: admin.firestore.FieldValue.serverTimestamp(),
        history: appendDispatchIncidentHistory(current.history, historyEntry),
      };

      if (!incidentDoc.exists) {
        payload.createdAtMs = nowMs;
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
        payload.firstDetectedAtMs = nowMs;
        payload.firstDetectedAt = admin.firestore.FieldValue.serverTimestamp();
        payload.reopenCount = 0;
      }

      if (isReopen) {
        payload.reopenedAtMs = nowMs;
        payload.reopenedAt = admin.firestore.FieldValue.serverTimestamp();
        payload.reopenCount = Number(current.reopenCount || 0) + 1;
        payload.resolvedAtMs = 0;
        payload.resolutionCode = '';
        payload.resolutionNote = '';
      }

      tx.set(incidentRef, payload, { merge: true });

      result = serializeDispatchIncident({
        id: incidentId,
        data: () => ({ ...current, ...payload }),
      });
    });

    await logDispatchEvent({
      type: result?.reopenedAtMs ? 'INCIDENT_REOPENED' : 'INCIDENT_CREATED',
      orderId,
      incidentId,
      incidentType: type,
      severity,
      reason: description || meta.label,
      createdAtMs: nowMs,
    });

    const latest = await incidentRef.get();
    return res.json({
      success: true,
      incident: serializeDispatchIncident(latest),
      message: result?.reopenedAtMs
        ? '異常案件已重新開啟。'
        : '異常案件已建立。',
    });
  } catch (error) {
    if (error?.code === 'ORDER_NOT_FOUND' || error?.message === 'ORDER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: '找不到此訂單。' });
    }
    console.error('❌ 建立調度異常案件失敗：', error);
    return res.status(500).json({
      success: false,
      message: '異常案件建立失敗，請稍後再試。',
    });
  }
});

// ============================================================
// 第二階段：異常案件狀態轉換
// action: START / NOTE / RESOLVE / REOPEN / ASSIGN
// ============================================================
app.post('/api/dispatch/incidents/:incidentId/transition', async (req, res) => {
  try {
    const incidentId = String(req.params.incidentId || '').trim();
    const action = String(req.body?.action || '').trim().toUpperCase();
    const actor = sanitizeDispatchIncidentText(
      req.body?.actor || req.body?.updatedBy || 'UBee 調度中心',
      100
    );
    const note = sanitizeDispatchIncidentText(req.body?.note, 1000);
    const assignedTo = sanitizeDispatchIncidentText(req.body?.assignedTo, 100);
    const resolutionCode = sanitizeDispatchIncidentText(req.body?.resolutionCode, 80);

    if (!incidentId) {
      return res.status(400).json({ success: false, message: '缺少異常案件編號。' });
    }

    if (!['START', 'NOTE', 'RESOLVE', 'REOPEN', 'ASSIGN'].includes(action)) {
      return res.status(400).json({ success: false, message: '不支援的異常處理動作。' });
    }

    if (['NOTE', 'RESOLVE'].includes(action) && !note) {
      return res.status(400).json({
        success: false,
        message: action === 'RESOLVE' ? '結案時必須填寫處理結果。' : '請填寫處理紀錄。',
      });
    }

    if (action === 'ASSIGN' && !assignedTo) {
      return res.status(400).json({ success: false, message: '請填寫負責人。' });
    }

    const incidentRef = db.collection('dispatchIncidents').doc(incidentId);
    const nowMs = Date.now();
    let eventType = 'INCIDENT_NOTE';
    let orderId = '';

    await db.runTransaction(async tx => {
      const incidentDoc = await tx.get(incidentRef);
      if (!incidentDoc.exists) {
        const error = new Error('INCIDENT_NOT_FOUND');
        error.code = 'INCIDENT_NOT_FOUND';
        throw error;
      }

      const current = incidentDoc.data() || {};
      orderId = String(current.orderId || '').trim().toUpperCase();
      const currentStatus = normalizeDispatchIncidentStatus(current.status);
      let nextStatus = currentStatus;
      const update = {
        updatedBy: actor,
        updatedAtMs: nowMs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (action === 'START') {
        nextStatus = UBEE_DISPATCH_INCIDENT_STATUSES.IN_PROGRESS;
        update.startedAtMs = Number(current.startedAtMs || 0) || nowMs;
        update.startedAt = admin.firestore.FieldValue.serverTimestamp();
        if (assignedTo) update.assignedTo = assignedTo;
        eventType = 'INCIDENT_STARTED';
      } else if (action === 'ASSIGN') {
        update.assignedTo = assignedTo;
        if (currentStatus === UBEE_DISPATCH_INCIDENT_STATUSES.OPEN) {
          nextStatus = UBEE_DISPATCH_INCIDENT_STATUSES.IN_PROGRESS;
          update.startedAtMs = Number(current.startedAtMs || 0) || nowMs;
          update.startedAt = admin.firestore.FieldValue.serverTimestamp();
        }
        eventType = 'INCIDENT_ASSIGNED';
      } else if (action === 'RESOLVE') {
        nextStatus = UBEE_DISPATCH_INCIDENT_STATUSES.RESOLVED;
        update.resolvedAtMs = nowMs;
        update.resolvedAt = admin.firestore.FieldValue.serverTimestamp();
        update.resolutionCode = resolutionCode || 'OTHER';
        update.resolutionNote = note;
        eventType = 'INCIDENT_RESOLVED';
      } else if (action === 'REOPEN') {
        nextStatus = UBEE_DISPATCH_INCIDENT_STATUSES.OPEN;
        update.reopenedAtMs = nowMs;
        update.reopenedAt = admin.firestore.FieldValue.serverTimestamp();
        update.reopenCount = Number(current.reopenCount || 0) + 1;
        update.resolvedAtMs = 0;
        update.resolutionCode = '';
        update.resolutionNote = '';
        eventType = 'INCIDENT_REOPENED';
      }

      update.status = nextStatus;
      update.history = appendDispatchIncidentHistory(
        current.history,
        buildDispatchIncidentHistoryEntry({
          action,
          actor,
          note:
            note ||
            (action === 'START'
              ? '開始處理。'
              : action === 'ASSIGN'
                ? `指派給 ${assignedTo}`
                : action === 'REOPEN'
                  ? '重新開啟案件。'
                  : ''),
          status: nextStatus,
          severity: current.severity,
          createdAtMs: nowMs,
        })
      );

      tx.set(incidentRef, update, { merge: true });
    });

    await logDispatchEvent({
      type: eventType,
      orderId,
      incidentId,
      reason: note || assignedTo || action,
      createdAtMs: nowMs,
    });

    const latest = await incidentRef.get();
    return res.json({
      success: true,
      incident: serializeDispatchIncident(latest),
      message:
        action === 'RESOLVE'
          ? '異常案件已結案。'
          : action === 'REOPEN'
            ? '異常案件已重新開啟。'
            : action === 'START'
              ? '異常案件已開始處理。'
              : action === 'ASSIGN'
                ? '異常案件已指派負責人。'
                : '處理紀錄已新增。',
    });
  } catch (error) {
    if (error?.code === 'INCIDENT_NOT_FOUND' || error?.message === 'INCIDENT_NOT_FOUND') {
      return res.status(404).json({ success: false, message: '找不到此異常案件。' });
    }
    console.error('❌ 更新調度異常案件失敗：', error);
    return res.status(500).json({
      success: false,
      message: '異常案件更新失敗，請稍後再試。',
    });
  }
});


// Level 4：單一訂單調度事件時間軸。
// 不使用複合索引；依 orderId 讀取後在記憶體排序。
app.get('/api/dispatch/orders/:orderId/events', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim().toUpperCase();
    if (!orderId) return res.status(400).json({success:false,message:'缺少訂單編號。'});
    const snap = await db.collection('dispatchEvents').where('orderId','==',orderId).limit(120).get();
    const events = snap.docs.map(doc => ({id:doc.id,...(doc.data()||{})}))
      .sort((a,b)=>Number(b.createdAtMs||0)-Number(a.createdAtMs||0))
      .slice(0,100);
    return res.json({success:true,orderId,events});
  } catch (error) {
    console.error('❌ Level4 調度事件時間軸讀取失敗：',error);
    return res.status(500).json({success:false,message:'調度事件讀取失敗。'});
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

// ============================================================
// UBee 小U註冊 API V2
// 正式分層規則：
// 1. 申請送出時，只建立 riderApplicationsV2/{手機號碼}
// 2. 不提前建立 ridersV2
// 3. 審核通過後，才由審核流程建立正式 ridersV2
// 4. 身分證、駕照、行照、強制險檔案只存 Firebase Storage 路徑
// ============================================================
app.post('/api/rider/register', async (req, res) => {
  try {
    const {
      name,
      phone,
      lineId,
      userId,
      lineUserId,
      birthDate,
      district,
      city,
      residenceCity,
      residenceDistrict,
      vehicle,
      plateNumber,
      vehicleOwnerType,
      vehicleOwnerConsent,
      compulsoryInsuranceExpiryDate,
      area,
      serviceArea,
      serviceCity,
      serviceCities,
      serviceDistricts,
      availableTime,
      emergencyContactName,
      emergencyContactRelationship,
      emergencyContactPhone,
      documents,

      driverLicenseConfirmed,
      vehicleLicenseConfirmed,
      policeRecordConfirmed,

      businessConditionAgree,
      insuranceConfirm,
      violationConfirm,
      contractConfirm,
      riderRuleConfirm,
      liabilityConfirm,
      privacyConfirm,
      identityDocumentConsent,
      documentAuthenticityConfirm,
      locationDataConsent,
      jkoRequirementAgree,
      communityRequirementAgree,
      applicationSource,
    } = req.body || {};

    const cleanPhone = normalizePhone(phone || '');
    const riderLineUserId = String(
      lineUserId || userId || ''
    ).trim();

    const cleanEmergencyPhone = normalizePhone(
      emergencyContactPhone || ''
    );

    const inferredResidence = inferTaiwanRegion(
      district ||
      `${residenceCity || city || ''}${residenceDistrict || ''}`
    );

    const finalResidenceCity = normalizeTaiwanCityName(
      residenceCity ||
      city ||
      inferredResidence.city ||
      ''
    );

    const finalResidenceDistrict = normalizeTaiwanRegionText(
      residenceDistrict ||
      inferredResidence.district ||
      ''
    );

    const finalDistrict =
      buildTaiwanFullDistrict(
        finalResidenceCity,
        finalResidenceDistrict,
        district || ''
      ) ||
      normalizeTaiwanRegionText(district);

    const normalizedServiceDistricts = normalizeTaiwanServiceDistricts(
      serviceDistricts ||
      serviceArea ||
      area ||
      []
    );

    const finalServiceArea =
      normalizedServiceDistricts.join('、') ||
      String(serviceArea || area || '').trim();

    const normalizedServiceCities = [
      ...new Set(
        (
          Array.isArray(serviceCities)
            ? serviceCities
            : [serviceCity]
        )
          .map(normalizeTaiwanCityName)
          .filter(Boolean)
          .concat(
            normalizedServiceDistricts
              .map(item => inferTaiwanRegion(item).city)
              .filter(Boolean)
          )
      ),
    ];

    const finalServiceCity =
      normalizeTaiwanCityName(serviceCity) ||
      normalizedServiceCities[0] ||
      finalResidenceCity ||
      '';

    const nowMs = Date.now();

    const submittedAtText = new Date(nowMs).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      hour12: false,
    });

    const toBool = value =>
      value === true ||
      value === 'true' ||
      value === 1 ||
      value === '1';

    // 良民證目前不列為申請必備文件，也不作為送出條件。
    const requiredAgreements = [
      driverLicenseConfirmed,
      vehicleLicenseConfirmed,
      businessConditionAgree,
      insuranceConfirm,
      violationConfirm,
      contractConfirm,
      riderRuleConfirm,
      liabilityConfirm,
      privacyConfirm,
      identityDocumentConsent,
      documentAuthenticityConfirm,
      locationDataConsent,
      jkoRequirementAgree,
      communityRequirementAgree,
    ];

    if (!requiredAgreements.every(toBool)) {
      return res.status(400).json({
        success: false,
        message: '請先閱讀並同意全部合作、個資與證件規範後再送出申請。',
      });
    }

    if (!riderLineUserId || !riderLineUserId.startsWith('U')) {
      return res.status(400).json({
        success: false,
        message: '缺少正確的 LINE 身分，請從 UBee 騎士端的申請入口重新進入。',
      });
    }

    if (
      !name ||
      !phone ||
      !lineId ||
      !birthDate ||
      !finalDistrict ||
      !vehicle ||
      !plateNumber ||
      !vehicleOwnerType ||
      !compulsoryInsuranceExpiryDate ||
      !finalServiceArea ||
      !availableTime ||
      !emergencyContactName ||
      !emergencyContactRelationship ||
      !emergencyContactPhone
    ) {
      return res.status(400).json({
        success: false,
        message: '資料不完整，請確認基本資料、車輛資料、保險資料與緊急聯絡人都已填寫。',
      });
    }

    if (!/^09\d{8}$/.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: '請輸入正確手機號碼，例如：0912345678。',
      });
    }

    if (!/^09\d{8}$/.test(cleanEmergencyPhone)) {
      return res.status(400).json({
        success: false,
        message: '請輸入正確的緊急聯絡人手機號碼。',
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(birthDate || '').trim())) {
      return res.status(400).json({
        success: false,
        message: '出生年月日格式不正確。',
      });
    }

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(
        String(compulsoryInsuranceExpiryDate || '').trim()
      )
    ) {
      return res.status(400).json({
        success: false,
        message: '強制險到期日格式不正確。',
      });
    }

    if (
      String(name).trim().length < 2 ||
      String(name).trim().length > 20
    ) {
      return res.status(400).json({
        success: false,
        message: '姓名長度需為 2～20 字。',
      });
    }

    if (
      String(lineId).trim().length < 2 ||
      String(lineId).trim().length > 60
    ) {
      return res.status(400).json({
        success: false,
        message: 'LINE ID 長度不正確，請重新確認。',
      });
    }

    if (
      String(finalDistrict).trim().length < 2 ||
      String(finalDistrict).trim().length > 80
    ) {
      return res.status(400).json({
        success: false,
        message: '居住地區請填寫完整，例如：台中市豐原區。',
      });
    }

    if (String(plateNumber).trim().length > 20) {
      return res.status(400).json({
        success: false,
        message: '車牌號碼不可超過 20 字。',
      });
    }

    if (
      finalServiceArea.length < 2 ||
      finalServiceArea.length > 80
    ) {
      return res.status(400).json({
        success: false,
        message: '可服務區域請填寫 2～80 字。',
      });
    }

    const normalizedVehicleOwnerType = String(
      vehicleOwnerType || ''
    ).trim().toLowerCase();

    if (!['self', 'other'].includes(normalizedVehicleOwnerType)) {
      return res.status(400).json({
        success: false,
        message: '請確認車輛是本人所有或經車主同意使用。',
      });
    }

    if (
      normalizedVehicleOwnerType === 'other' &&
      !toBool(vehicleOwnerConsent)
    ) {
      return res.status(400).json({
        success: false,
        message: '使用他人車輛時，必須確認已取得車主同意。',
      });
    }

    const documentValidation =
      await validateRiderApplicationDocuments(
        documents,
        cleanPhone,
        riderLineUserId
      );

    if (!documentValidation.ok) {
      return res.status(400).json({
        success: false,
        message: documentValidation.message,
      });
    }

    const riderId = cleanPhone;

    const applicationRef = db
      .collection(RIDER_V2_COLLECTIONS.applications)
      .doc(riderId);

    const officialRiderRef = db
      .collection(RIDER_V2_COLLECTIONS.riders)
      .doc(riderId);

    const application = {
      riderId,
      id: riderId,
      applicationId: riderId,

      dataVersion: RIDER_V2_DATA_VERSION,
      applicationRound: RIDER_V2_APPLICATION_ROUND,
      sourceCollection: RIDER_V2_COLLECTIONS.applications,

      name: cleanText(name, 20),
      phone: cleanPhone,
      lineId: cleanText(lineId || '', 60),
      userId: riderLineUserId,
      lineUserId: riderLineUserId,
      birthDate: String(birthDate || '').trim(),

      district: cleanText(finalDistrict || '', 80),
      city: cleanText(finalResidenceCity || '', 20),
      residenceCity: cleanText(finalResidenceCity || '', 20),
      residenceDistrict: cleanText(finalResidenceDistrict || '', 20),

      vehicle: cleanText(vehicle || '', 40),
      plateNumber: cleanText(plateNumber || '', 20),
      vehicleOwnerType: normalizedVehicleOwnerType,
      vehicleOwnerConsent:
        normalizedVehicleOwnerType === 'self'
          ? true
          : toBool(vehicleOwnerConsent),
      compulsoryInsuranceExpiryDate:
        String(compulsoryInsuranceExpiryDate || '').trim(),

      area: cleanText(finalServiceArea || '', 80),
      serviceArea: cleanText(finalServiceArea || '', 80),
      serviceCity: cleanText(finalServiceCity || '', 20),
      serviceCities: normalizedServiceCities,
      serviceDistricts: normalizedServiceDistricts,
      availableTime: cleanText(availableTime || '', 80),

      emergencyContact: {
        name: cleanText(emergencyContactName || '', 30),
        relationship: cleanText(
          emergencyContactRelationship || '',
          30
        ),
        phone: cleanEmergencyPhone,
      },

      documents: documentValidation.documents,
      documentsComplete: true,
      documentReviewStatus: 'pending',

      approved: false,
      status: 'pending',
      reviewStatus: 'pending',
      lifecycleStatus: RIDER_V4_LIFECYCLE.UNDER_REVIEW,
      canAcceptOrders: false,
      riderLevel: 'L0',
      onboardingRequired: true,

      source: cleanText(
        applicationSource || 'liff_rider_apply_v2',
        60
      ),
      submittedFrom: cleanText(
        applicationSource || 'rider_apply_v2',
        60
      ),
      applicationType: 'rider_v2',

      driverLicenseConfirmed: toBool(driverLicenseConfirmed),
      vehicleLicenseConfirmed: toBool(vehicleLicenseConfirmed),
      policeRecordConfirmed: toBool(policeRecordConfirmed),
      businessConditionAgree: toBool(businessConditionAgree),
      insuranceConfirm: toBool(insuranceConfirm),
      violationConfirm: toBool(violationConfirm),
      contractConfirm: toBool(contractConfirm),
      riderRuleConfirm: toBool(riderRuleConfirm),
      liabilityConfirm: toBool(liabilityConfirm),
      privacyConfirm: toBool(privacyConfirm),
      identityDocumentConsent: toBool(identityDocumentConsent),
      documentAuthenticityConfirm: toBool(
        documentAuthenticityConfirm
      ),
      locationDataConsent: toBool(locationDataConsent),
      jkoRequirementAgree: toBool(jkoRequirementAgree),
      communityRequirementAgree: toBool(
        communityRequirementAgree
      ),

      adminNotifySent: false,
      adminNotifyStatus: 'pending',

      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: nowMs,
      submittedAtMs: nowMs,
      updatedAtMs: nowMs,
      submittedAtText,
    };

    let duplicatePayload = null;

    await db.runTransaction(async tx => {
      const [applicationDoc, officialRiderDoc] = await Promise.all([
        tx.get(applicationRef),
        tx.get(officialRiderRef),
      ]);

      if (officialRiderDoc.exists) {
        const oldData = officialRiderDoc.data() || {};
        duplicatePayload = {
          riderId,
          status: oldData.status || 'approved',
          message: '此手機號碼已完成新版小U審核，不需要重複申請。',
        };
        return;
      }

      if (applicationDoc.exists) {
        const oldData = applicationDoc.data() || {};
        const oldStatus = String(oldData.status || 'pending');
        duplicatePayload = {
          riderId,
          status: oldStatus,
          message:
            oldStatus === 'rejected'
              ? '此手機號碼的新版申請曾被拒絕，請聯繫 UBee 辦公室協助處理。'
              : oldStatus === 'training' || oldStatus === 'approved'
                ? '此手機號碼已通過新版小U審核。'
                : '此手機號碼已送出新版申請，請等待 UBee 審核。',
        };
        return;
      }

      const applicationLineSnap = await tx.get(
        db.collection(RIDER_V2_COLLECTIONS.applications)
          .where('lineUserId', '==', riderLineUserId)
          .limit(1)
      );

      if (!applicationLineSnap.empty) {
        const oldDoc = applicationLineSnap.docs[0];
        const oldData = oldDoc.data() || {};
        duplicatePayload = {
          riderId: oldData.riderId || oldDoc.id,
          status: oldData.status || 'pending',
          message: '此 LINE 帳號已送出新版小U申請，不能重複申請。',
        };
        return;
      }

      tx.set(applicationRef, application, { merge: false });
    });

    if (duplicatePayload) {
      return res.json({
        success: true,
        duplicate: true,
        alreadyExists: true,
        riderId: duplicatePayload.riderId,
        status: duplicatePayload.status,
        collection: RIDER_V2_COLLECTIONS.applications,
        applicationCollection: RIDER_V2_COLLECTIONS.applications,
        message: duplicatePayload.message,
      });
    }

    console.log('✅ 新版小U申請已寫入 Firebase：', {
      riderId,
      name: application.name,
      phone: application.phone,
      lineUserId: application.lineUserId,
      applicationCollection: RIDER_V2_COLLECTIONS.applications,
      documentsComplete: true,
    });

    let notifyOk = false;
    let notifyErrorMessage = '';

    try {
      if (!LINE_ADMIN_GROUP_ID) {
        throw new Error('LINE_ADMIN_GROUP_ID 未設定');
      }

      await pushToGroup(
        LINE_ADMIN_GROUP_ID,
        createRiderReviewFlex({
          ...application,
          createdAt: submittedAtText,
          submittedAtText,
        })
      );

      notifyOk = true;
    } catch (notifyErr) {
      notifyOk = false;
      notifyErrorMessage = notifyErr?.message || String(notifyErr);
      console.error(
        '⚠️ 新版小U審核通知失敗，但申請資料已成功寫入：',
        notifyErrorMessage
      );
    }

    const notifyUpdate = {
      adminNotifySent: notifyOk,
      adminNotifyStatus: notifyOk ? 'sent' : 'failed',
      adminNotifyUpdatedAt:
        admin.firestore.FieldValue.serverTimestamp(),
      adminNotifyUpdatedAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAtMs: Date.now(),
    };

    if (!notifyOk) {
      notifyUpdate.adminNotifyError = notifyErrorMessage;
    }

    await applicationRef.set(notifyUpdate, { merge: true });

    return res.json({
      success: true,
      riderId,
      collection: RIDER_V2_COLLECTIONS.applications,
      applicationCollection: RIDER_V2_COLLECTIONS.applications,
      officialRiderCreated: false,
      adminNotifySent: notifyOk,
      message: '已送出新版小U申請，等待 UBee 審核。',
    });
  } catch (err) {
    console.error('❌ 新版小U註冊失敗：', err);

    return res.status(500).json({
      success: false,
      message: '申請資料寫入失敗，請稍後再試或聯繫 UBee 辦公室。',
      error: err.message,
    });
  }
});


// ============================================================
// UBee 小U申請狀態查詢 V2
// 查詢順序：ridersV2 -> riderApplicationsV2 -> 舊 riders 相容資料
// ============================================================
app.get('/api/rider/application-status', async (req, res) => {
  try {
    const cleanPhone = normalizePhone(req.query?.phone || '');

    if (!/^09\d{8}$/.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: '請輸入 09 開頭的 10 碼手機號碼。',
      });
    }

    const officialDoc = await db
      .collection(RIDER_V2_COLLECTIONS.riders)
      .doc(cleanPhone)
      .get();

    if (officialDoc.exists) {
      const rider = officialDoc.data() || {};
      const lifecycleStatus = getRiderV4LifecycleStatus(rider);

      return res.json({
        success: true,
        found: true,
        source: RIDER_V2_COLLECTIONS.riders,
        riderId: rider.riderId || officialDoc.id,
        name: rider.name || '',
        approved: rider.approved === true,
        reviewStatus: rider.reviewStatus || rider.status || '',
        status: rider.status || '',
        lifecycleStatus,
        canAcceptOrders: canRiderAcceptOrdersV4(rider),
        riderLevel: rider.riderLevel || '',
        message: '你的新版 UBee 小U資格已建立。',
      });
    }

    const applicationDoc = await db
      .collection(RIDER_V2_COLLECTIONS.applications)
      .doc(cleanPhone)
      .get();

    if (applicationDoc.exists) {
      const application = applicationDoc.data() || {};
      const status = String(application.status || 'pending');

      const messageMap = {
        pending: '新版申請已送出，正在等待 UBee 審核。',
        training: '審核已通過，請登入騎士端完成數位入職。',
        approved: '審核已通過，正式小U資料正在建立。',
        rejected: '此申請未通過審核，如需了解請聯繫 UBee。',
      };

      return res.json({
        success: true,
        found: true,
        source: RIDER_V2_COLLECTIONS.applications,
        riderId: application.riderId || applicationDoc.id,
        name: application.name || '',
        approved: application.approved === true,
        reviewStatus:
          application.reviewStatus || application.status || '',
        status,
        lifecycleStatus:
          application.lifecycleStatus ||
          RIDER_V4_LIFECYCLE.UNDER_REVIEW,
        canAcceptOrders: false,
        riderLevel: application.riderLevel || 'L0',
        documentsComplete:
          application.documentsComplete === true,
        message: messageMap[status] || '已找到新版申請資料。',
      });
    }

    // 過渡期保留舊 riders 查詢，待全員重新申請完成後移除。
    let legacyDoc = await db
      .collection('riders')
      .doc(cleanPhone)
      .get();

    if (!legacyDoc.exists) {
      const snap = await db.collection('riders')
        .where('phone', '==', cleanPhone)
        .limit(1)
        .get();
      if (!snap.empty) legacyDoc = snap.docs[0];
    }

    if (legacyDoc.exists) {
      const rider = legacyDoc.data() || {};
      return res.json({
        success: true,
        found: true,
        source: 'legacy_riders',
        riderId: rider.riderId || legacyDoc.id,
        name: rider.name || '',
        approved: rider.approved === true,
        reviewStatus: rider.reviewStatus || rider.status || '',
        status: rider.status || '',
        lifecycleStatus: 'LEGACY_REAPPLICATION_REQUIRED',
        canAcceptOrders: canRiderAcceptOrdersV4(rider),
        riderLevel: rider.riderLevel || '',
        reapplicationRequired: true,
        message: '此為舊版小U資料，請依公告重新提交新版申請。',
      });
    }

    return res.json({
      success: true,
      found: false,
      status: 'not_found',
      lifecycleStatus: 'NOT_APPLIED',
      message: '查無新版申請資料，可直接申請成為 UBee 小U。',
    });
  } catch (err) {
    console.error('❌ 查詢新版小U申請狀態失敗：', err);
    return res.status(500).json({
      success: false,
      message: '查詢申請狀態失敗，請稍後再試。',
      error: err.message,
    });
  }
});

// ===== 騎士身分查找工具：支援手機登入 / riderId / 舊 LINE 身分 =====
async function findApprovedRiderForApi(source = {}) {
  const found = await findRiderDocumentV2First(source);
  const riderDoc = found.riderDoc;

  if (!riderDoc || !riderDoc.exists) {
    return {
      ok: false,
      statusCode: 404,
      message: '找不到騎士資料，請確認手機號碼是否已審核通過。',
    };
  }

  const rider = riderDoc.data() || {};

  if (isBlockedRiderData(rider)) {
    return {
      ok: false,
      statusCode: 403,
      message: '此騎士帳號目前無法使用，請聯繫 UBee 跑腿管理員。',
    };
  }

  if (!isApprovedRiderData(rider)) {
    return {
      ok: false,
      statusCode: 403,
      message: '騎士尚未審核通過，無法使用騎士端功能。',
    };
  }

  return {
    ok: true,
    riderDoc,
    sourceCollection: found.sourceCollection,
    rider: {
      id: riderDoc.id,
      ...rider,
    },
  };
}

// ============================================================
// UBee 小U營運管理系統 V4 API｜學習進度永久同步修正版 2026-07-22
// ============================================================
async function getRiderV4ApiContext(req) {
  if (req.riderAuth?.riderDocId) {
    const found = await findRiderDocumentV2First({ riderId:req.riderAuth.riderDocId });
    const riderDoc = found.riderDoc;
    if (!riderDoc || !riderDoc.exists) return { ok:false, statusCode:404, message:'找不到小U資料。' };
    const rider = { id:riderDoc.id, ...riderDoc.data() };
    if (isBlockedRiderData(rider)) return { ok:false, statusCode:403, message:'此小U帳號目前無法使用。' };
    if (!isApprovedRiderData(rider)) return { ok:false, statusCode:403, message:'小U尚未審核通過。' };
    return { ok:true, riderDoc, rider };
  }
  return findApprovedRiderForApi({ ...(req.query || {}), ...(req.body || {}) });
}

app.get('/api/rider/v4/bootstrap', riderAuthMiddleware, async (req, res) => {
  try {
    const ctx = await getRiderV4ApiContext(req);
    if (!ctx.ok) return res.status(ctx.statusCode || 403).json({ success:false, message:ctx.message });

    // 先修復舊版可能以 literal dotted field 寫入的學習紀錄，
    // 確保換手機／重新登入後仍能正確取得 12/12 與測驗資格。
    let rider = await repairRiderV4LearningPersistence(ctx.riderDoc, ctx.rider);

    // 只有真的完成全部 12 堂 + 測驗 >= 80 的帳號才同步成 L4。
    // 既有小U不會因為「已加入平台」而自動升級。
    rider = await syncRiderL4Qualification(ctx.riderDoc, rider);

    return res.json({
      success:true,
      config:buildRiderV4PublicConfig(),
      rider,
      progress:getRiderV4Progress(rider),
    });
  } catch (err) {
    console.error('❌ V4 bootstrap 失敗：', err);
    return res.status(500).json({ success:false, message:'讀取 V4 入職資料失敗。', error:err.message });
  }
});

app.post('/api/rider/v4/onboarding/progress', riderAuthMiddleware, async (req, res) => {
  try {
    const ctx = await getRiderV4ApiContext(req);
    if (!ctx.ok) return res.status(ctx.statusCode || 403).json({ success:false, message:ctx.message });

    const step = String(req.body?.step || '').trim();
    const allowed = new Set([
      'jkopayInstalled',
      'announcementGroupJoined',
      'chatGroupJoined',
      'reportGroupJoined',
      ...RIDER_V4_REQUIRED_MODULES.map(id => `module:${id}`),
    ]);
    if (!allowed.has(step)) return res.status(400).json({ success:false, message:'不支援的入職進度項目。' });

    const rider = ctx.rider || {};
    const lifecycle = getRiderV4LifecycleStatus(rider);
    const isMandatoryOnboarding = lifecycle === RIDER_V4_LIFECYCLE.TRAINING;
    const nowMs = Date.now();
    const update = {
      updatedAt:admin.firestore.FieldValue.serverTimestamp(),
    };

    if (isMandatoryOnboarding) {
      // 新申請小U：維持強制入職 gate。
      Object.assign(update, {
        lifecycleStatus:RIDER_V4_LIFECYCLE.TRAINING,
        status:'training',
        canAcceptOrders:false,
        onboardingRequired:true,
        'onboarding.updatedAtMs':nowMs,
      });
      if (step.startsWith('module:')) {
        const moduleId = step.slice(7);
        update[`onboarding.modules.${moduleId}`] = true;
        update[`learning.modules.${moduleId}`] = true;
      } else {
        update[`onboarding.${step}`] = true;
        update[`learning.checklist.${step}`] = true;
      }
      update['learning.updatedAtMs'] = nowMs;
    } else {
      // 既有 ACTIVE 小U：只記錄持續學習／工具確認，絕不改成 TRAINING、絕不停單。
      if (step.startsWith('module:')) {
        const moduleId = step.slice(7);
        update[`learning.modules.${moduleId}`] = true;
      } else {
        update[`learning.checklist.${step}`] = true;
      }
      update['learning.updatedAtMs'] = nowMs;
    }

    await ctx.riderDoc.ref.update(update);
    let updated = await ctx.riderDoc.ref.get();
    let updatedRider = { id:updated.id, ...updated.data() };

    if (isMandatoryOnboarding) {
      // 若測驗已先通過，最後一個必修項目完成時也要自動開通，不要求重考。
      const onboarding = updatedRider.onboarding || {};
      const modules = onboarding.modules || {};
      const checklistComplete =
        onboarding.jkopayInstalled === true &&
        onboarding.announcementGroupJoined === true &&
        onboarding.chatGroupJoined === true &&
        onboarding.reportGroupJoined === true &&
        RIDER_V4_REQUIRED_MODULES.every(id => modules[id] === true);

      const quiz = getRiderUnifiedLearningQuiz(updatedRider);
      if (checklistComplete && quiz.passed === true && !canRiderAcceptOrdersV4(updatedRider)) {
        const finalLevel = isRiderL4LearningQualified(updatedRider)
          ? 'L4'
          : getNonDowngradeRiderLevel(updatedRider, 'L1');
        await ctx.riderDoc.ref.update({
          status:'approved',
          reviewStatus:'approved',
          approved:true,
          lifecycleStatus:RIDER_V4_LIFECYCLE.ACTIVE,
          canAcceptOrders:true,
          riderLevel:finalLevel,
          onboardingRequired:false,
          trainingCompleted:true,
          trainingCompletedAtMs:nowMs,
          'onboarding.completed':true,
          'onboarding.completedAtMs':nowMs,
          'certifications.basic':true,
          ...(finalLevel === 'L4' ? {
            'learning.l4Qualified':true,
            'learning.l4QualifiedAtMs':nowMs,
          } : {}),
          updatedAt:admin.firestore.FieldValue.serverTimestamp(),
        });
        updated = await ctx.riderDoc.ref.get();
        updatedRider = { id:updated.id, ...updated.data() };
      }
    } else if (isRiderL4LearningQualified(updatedRider) && String(updatedRider.riderLevel || '').toUpperCase() !== 'L4') {
      updatedRider = await syncRiderL4Qualification(ctx.riderDoc, updatedRider);
    }

    return res.json({ success:true, rider:updatedRider, progress:getRiderV4Progress(updatedRider) });
  } catch (err) {
    console.error('❌ V4 onboarding/learning progress 失敗：', err);
    return res.status(500).json({ success:false, message:'儲存入職／學習進度失敗。', error:err.message });
  }
});

// ============================================================
// 所有新舊小U共用的持續學習進度 API
// - 不改 lifecycleStatus
// - 不改 canAcceptOrders
// - 不會把既有 ACTIVE 小U誤切回 TRAINING
// ============================================================
app.post('/api/rider/v4/learning/progress', riderAuthMiddleware, async (req, res) => {
  try {
    const ctx = await getRiderV4ApiContext(req);
    if (!ctx.ok) return res.status(ctx.statusCode || 403).json({ success:false, message:ctx.message });

    const step = String(req.body?.step || '').trim();
    const allowed = new Set([
      'jkopayInstalled',
      'announcementGroupJoined',
      'chatGroupJoined',
      'reportGroupJoined',
      ...RIDER_V4_REQUIRED_MODULES.map(id => `module:${id}`),
    ]);
    if (!allowed.has(step)) return res.status(400).json({ success:false, message:'不支援的學習進度項目。' });

    const nowMs = Date.now();
    const update = {
      'learning.updatedAtMs':nowMs,
      updatedAt:admin.firestore.FieldValue.serverTimestamp(),
    };
    if (step.startsWith('module:')) {
      const moduleId = step.slice(7);
      update[`learning.modules.${moduleId}`] = true;
    } else {
      update[`learning.checklist.${step}`] = true;
    }

    await ctx.riderDoc.ref.update(update);
    let updated = await ctx.riderDoc.ref.get();
    let rider = { id:updated.id, ...updated.data() };

    if (isRiderL4LearningQualified(rider)) {
      rider = await syncRiderL4Qualification(ctx.riderDoc, rider);
    }

    return res.json({
      success:true,
      rider,
      progress:getRiderV4Progress(rider),
      l4Qualified:isRiderL4LearningQualified(rider),
    });
  } catch (err) {
    console.error('❌ V4 learning progress 失敗：', err);
    return res.status(500).json({ success:false, message:'儲存學習進度失敗。', error:err.message });
  }
});

app.post('/api/rider/v4/quiz/submit', riderAuthMiddleware, async (req, res) => {
  try {
    const ctx = await getRiderV4ApiContext(req);
    if (!ctx.ok) return res.status(ctx.statusCode || 403).json({ success:false, message:ctx.message });

    const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
    let correct = 0;
    RIDER_V4_QUIZ.forEach(q => {
      if (Number(answers[q.id]) === q.answer) correct += 1;
    });
    const score = Math.round(correct / RIDER_V4_QUIZ.length * 100);
    const passed = score >= 80;
    const rider = ctx.rider || {};
    const onboarding = rider.onboarding || {};
    const modules = onboarding.modules || {};
    const checklistComplete =
      onboarding.jkopayInstalled === true &&
      onboarding.announcementGroupJoined === true &&
      onboarding.chatGroupJoined === true &&
      onboarding.reportGroupJoined === true &&
      RIDER_V4_REQUIRED_MODULES.every(id => modules[id] === true);

    const previousQuiz = getRiderUnifiedLearningQuiz(rider);
    const effectivePassed = previousQuiz.passed === true || passed;
    const effectiveBestScore = Math.max(Number(previousQuiz.score || 0), score);
    const nowMs = Date.now();
    const update = {
      'onboarding.quizScore':score,
      'onboarding.quizPassed':effectivePassed,
      'onboarding.quizAttempts':admin.firestore.FieldValue.increment(1),
      'onboarding.quizLastAtMs':nowMs,
      trainingQuizScore:effectiveBestScore,
      trainingQuizPassed:effectivePassed,
      'learning.quizScore':score,
      'learning.quizLastScore':score,
      'learning.quizBestScore':effectiveBestScore,
      'learning.quizPassed':effectivePassed,
      'learning.quizAttempts':admin.firestore.FieldValue.increment(1),
      'learning.quizLastAtMs':nowMs,
      'learning.updatedAtMs':nowMs,
      updatedAt:admin.firestore.FieldValue.serverTimestamp(),
    };

    // 新申請者：仍必須街口 + 三社群 + 12課 + 測驗才可正式 ACTIVE。
    const activated = effectivePassed && checklistComplete;
    if (activated) {
      const projectedRider = {
        ...rider,
        onboarding:{
          ...onboarding,
          quizScore:effectiveBestScore,
          quizPassed:true,
        },
        trainingQuizScore:effectiveBestScore,
        trainingQuizPassed:true,
        learning:{
          ...(rider.learning || {}),
          quizScore:score,
          quizBestScore:effectiveBestScore,
          quizPassed:true,
        },
      };
      const finalLevel = isRiderL4LearningQualified(projectedRider)
        ? 'L4'
        : getNonDowngradeRiderLevel(rider, 'L1');
      Object.assign(update, {
        status:'approved',
        reviewStatus:'approved',
        approved:true,
        lifecycleStatus:RIDER_V4_LIFECYCLE.ACTIVE,
        canAcceptOrders:true,
        riderLevel:finalLevel,
        onboardingRequired:false,
        trainingCompleted:true,
        trainingCompletedAtMs:nowMs,
        'onboarding.completed':true,
        'onboarding.completedAtMs':nowMs,
        'certifications.basic':true,
        ...(finalLevel === 'L4' ? {
          'learning.l4Qualified':true,
          'learning.l4QualifiedAtMs':nowMs,
        } : {}),
      });
    }

    await ctx.riderDoc.ref.update(update);
    const updated = await ctx.riderDoc.ref.get();
    let updatedRider = { id:updated.id, ...updated.data() };
    if (isRiderL4LearningQualified(updatedRider)) {
      updatedRider = await syncRiderL4Qualification(ctx.riderDoc, updatedRider);
    }
    const l4Qualified = isRiderL4LearningQualified(updatedRider);

    return res.json({
      success:true,
      score,
      passed,
      checklistComplete,
      activated,
      l4Qualified,
      message: activated
        ? (l4Qualified
            ? '恭喜完成 V4 小U入職與全部學習要求，正式接單資格已開通並取得 L4。'
            : '恭喜完成 V4 小U入職，正式接單資格已開通。')
        : passed
          ? '測驗已通過，請先完成所有必修入職項目。'
          : '測驗未達 80 分，請複習後重新作答。',
      rider:updatedRider,
      progress:getRiderV4Progress(updatedRider),
    });
  } catch (err) {
    console.error('❌ V4 quiz submit 失敗：', err);
    return res.status(500).json({ success:false, message:'送出測驗失敗。', error:err.message });
  }
});

// ============================================================
// 全員 L4 學習測驗：既有 ACTIVE 小U也能參加
// - 不變更 ACTIVE / canAcceptOrders
// - 12 堂全部完成 + 80 分以上才由後端正式寫入 L4
// - 已取得 L4 後重考失利不會自動撤銷既有資格
// ============================================================
app.post('/api/rider/v4/learning/quiz/submit', riderAuthMiddleware, async (req, res) => {
  try {
    const ctx = await getRiderV4ApiContext(req);
    if (!ctx.ok) return res.status(ctx.statusCode || 403).json({ success:false, message:ctx.message });

    const rider = ctx.rider || {};
    const modules = getRiderUnifiedLearningModules(rider);
    const modulesComplete = RIDER_V4_REQUIRED_MODULES.every(id => modules[id] === true);
    if (!modulesComplete) {
      return res.status(409).json({
        success:false,
        message:'請先完成全部 12 堂核心教學後再參加 L4 測驗。',
      });
    }

    const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
    let correct = 0;
    RIDER_V4_QUIZ.forEach(q => {
      if (Number(answers[q.id]) === q.answer) correct += 1;
    });
    const score = Math.round(correct / RIDER_V4_QUIZ.length * 100);
    const passedThisAttempt = score >= 80;
    const previousQuiz = getRiderUnifiedLearningQuiz(rider);
    const effectivePassed = previousQuiz.passed === true || passedThisAttempt;
    const bestScore = Math.max(Number(previousQuiz.score || 0), score);
    const nowMs = Date.now();

    const update = {
      'learning.quizScore':score,
      'learning.quizLastScore':score,
      'learning.quizBestScore':bestScore,
      'learning.quizPassed':effectivePassed,
      'learning.quizAttempts':admin.firestore.FieldValue.increment(1),
      'learning.quizLastAtMs':nowMs,
      'learning.updatedAtMs':nowMs,
      updatedAt:admin.firestore.FieldValue.serverTimestamp(),
    };

    if (effectivePassed && modulesComplete) {
      Object.assign(update, {
        riderLevel:'L4',
        'learning.l4Qualified':true,
        'learning.l4QualifiedAtMs':
          Number(rider.learning?.l4QualifiedAtMs || 0) || nowMs,
      });
    }

    await ctx.riderDoc.ref.update(update);
    const updated = await ctx.riderDoc.ref.get();
    const updatedRider = { id:updated.id, ...updated.data() };
    const l4Qualified = isRiderL4LearningQualified(updatedRider);

    return res.json({
      success:true,
      score,
      passed:passedThisAttempt,
      bestScore,
      l4Qualified,
      promotedToL4:l4Qualified && String(rider.riderLevel || '').toUpperCase() !== 'L4',
      message:l4Qualified
        ? 'L4 學習資格已完成，後端已正式保存為 L4。'
        : passedThisAttempt
          ? '測驗已通過，正在確認完整 L4 學習條件。'
          : '本次測驗未達 80 分，請複習後重新作答。',
      rider:updatedRider,
      progress:getRiderV4Progress(updatedRider),
    });
  } catch (err) {
    console.error('❌ V4 learning quiz submit 失敗：', err);
    return res.status(500).json({ success:false, message:'送出 L4 學習測驗失敗。', error:err.message });
  }
});


// ============================================================
// UBee 小U財務中心：街口訂單判斷／結算狀態
// - rider/v4/finance 專用，避免呼叫不存在的舊函式名稱
// - 不改動派單、接單、審核、財務中心既有結算核心
// ============================================================
function isRiderV4FinanceJkoOrder(order = {}) {
  const paymentMethod = getOrderPaymentMethod(order);
  const paymentStatus = getOrderPaymentStatus(order);

  const isJko =
    paymentMethod === 'jko' ||
    paymentMethod === 'jkopay' ||
    paymentMethod === 'jko_pay' ||
    paymentMethod === 'jkpay' ||
    paymentMethod.includes('jko') ||
    paymentMethod.includes('jkpay') ||
    paymentMethod.includes('街口');

  const isPaid =
    paymentStatus === 'paid_confirmed' ||
    paymentStatus === 'paid' ||
    paymentStatus === 'payment_confirmed' ||
    paymentStatus.includes('paid_confirmed') ||
    paymentStatus.includes('已付款') ||
    paymentStatus.includes('付款完成') ||
    order.isPaid === true;

  return (
    isJko &&
    isPaid &&
    order.isCashOrder !== true
  );
}

function isRiderV4FinanceJkoSettled(order = {}) {
  const status = String(
    order.settlementStatus ||
    order.jkoSettlementStatus ||
    order.payoutStatus ||
    'pending'
  )
    .trim()
    .toLowerCase();

  return [
    'settled',
    'paid',
    'completed',
    'done',
  ].includes(status);
}

app.get('/api/rider/v4/finance', riderAuthMiddleware, async (req, res) => {
  try {
    const ctx = await getRiderV4ApiContext(req);
    if (!ctx.ok) return res.status(ctx.statusCode || 403).json({ success:false, message:ctx.message });
    const identity = buildRiderApiIdentity(ctx.riderDoc, ctx.rider, req.query || {});
    const snap = await db.collection('orders').limit(1500).get();
    let cashDueToPlatform = 0;
    let jkoPendingPayout = 0;
    let settledCash = 0;
    let settledJko = 0;
    const cashOrders = [];
    const jkoOrders = [];

    snap.forEach(doc => {
      const order = { id:doc.id, ...doc.data() };
      if (!isOrderBelongsToRider(order, identity)) return;
      const status = String(order.status || '').toLowerCase();
      if (!['completed','done'].includes(status)) return;

      if (isCashPaymentOrder(order)) {
        const amounts = getFinanceCashAmounts(order);
        if (isCashRemittanceSettled(order)) {
          settledCash += amounts.cashDueToPlatform;
        } else if (amounts.cashDueToPlatform > 0) {
          cashDueToPlatform += amounts.cashDueToPlatform;
          cashOrders.push({
            id:doc.id,
            orderNo:order.orderNo || doc.id,
            amount:amounts.cashDueToPlatform,
            completedAt:order.completedAt || order.updatedAt || null,
          });
        }
      }

      if (isRiderV4FinanceJkoOrder(order)) {
        const amounts = getFinanceJkoAmounts(order);
        if (isRiderV4FinanceJkoSettled(order)) {
          settledJko += amounts.payoutTotal;
        } else if (amounts.payoutTotal > 0) {
          jkoPendingPayout += amounts.payoutTotal;
          jkoOrders.push({
            id:doc.id,
            orderNo:order.orderNo || doc.id,
            amount:amounts.payoutTotal,
            completedAt:order.completedAt || order.updatedAt || null,
          });
        }
      }
    });

    return res.json({
      success:true,
      jkoPayAccount:UBEE_JKOPAY_ACCOUNT,
      summary:{
        cashDueToPlatform:Math.round(cashDueToPlatform),
        jkoPendingPayout:Math.round(jkoPendingPayout),
        settledCash:Math.round(settledCash),
        settledJko:Math.round(settledJko),
      },
      cashOrders:cashOrders.slice(0,100),
      jkoOrders:jkoOrders.slice(0,100),
    });
  } catch (err) {
    console.error('❌ V4 rider finance 失敗：', err);
    return res.status(500).json({ success:false, message:'讀取我的財務失敗。', error:err.message });
  }
});

app.get('/api/admin/rider-v4/list', requireRiderV4AdminKey, async (req, res) => {
  try {
    const snap = await db.collection('riders').limit(5000).get();
    const riders = snap.docs.map(doc => {
      const r = { id:doc.id, ...doc.data() };
      return {
        id:doc.id,
        riderId:r.riderId || doc.id,
        name:r.name || r.riderName || '',
        phone:r.phone || doc.id,
        lineUserId:r.lineUserId || '',
        lifecycleStatus:getRiderV4LifecycleStatus(r),
        canAcceptOrders:canRiderAcceptOrdersV4(r),
        riderLevel:String(r.riderLevel || (isRiderV4OnboardingComplete(r) ? 'L1' : 'L0')),
        onboarding:getRiderV4Progress(r),
        certifications:r.certifications || {},
        governance:r.governance || {},
      };
    });
    return res.json({ success:true, riders });
  } catch (err) {
    return res.status(500).json({ success:false, message:'讀取 V4 小U名單失敗。', error:err.message });
  }
});

app.post('/api/admin/rider-v4/action', requireRiderV4AdminKey, async (req, res) => {
  try {
    const riderId = String(req.body?.riderId || '').trim();
    const action = String(req.body?.action || '').trim().toLowerCase();
    const reason = cleanText(req.body?.reason || '', 300);
    const value = String(req.body?.value || '').trim();
    if (!riderId || !action) return res.status(400).json({ success:false, message:'缺少 riderId 或 action。' });

    let doc = await db.collection('riders').doc(riderId).get();
    if (!doc.exists) {
      const snap = await db.collection('riders').where('riderId','==',riderId).limit(1).get();
      if (!snap.empty) doc = snap.docs[0];
    }
    if (!doc.exists) return res.status(404).json({ success:false, message:'找不到小U資料。' });
    const rider = doc.data() || {};
    const nowMs = Date.now();
    const update = { updatedAt:admin.firestore.FieldValue.serverTimestamp(), updatedAtMs:nowMs };
    let eventType = action;

    if (action === 'warn') {
      update['governance.warningCount'] = admin.firestore.FieldValue.increment(1);
      update['governance.lastWarningReason'] = reason;
      update['governance.lastWarningAtMs'] = nowMs;
    } else if (action === 'retraining') {
      update.lifecycleStatus = RIDER_V4_LIFECYCLE.RETRAINING;
      update.status = 'retraining';
      update.canAcceptOrders = false;
      update.online = false;
      update.retraining = { required:true, courseId:value || 'general_rules', reason, assignedAtMs:nowMs };
    } else if (action === 'restrict') {
      update.lifecycleStatus = RIDER_V4_LIFECYCLE.RESTRICTED;
      update.status = 'restricted';
      update.canAcceptOrders = false;
      update.online = false;
      update['governance.restrictionReason'] = reason;
      update['governance.restrictedAtMs'] = nowMs;
    } else if (action === 'suspend') {
      update.lifecycleStatus = RIDER_V4_LIFECYCLE.SUSPENDED;
      update.status = 'suspended';
      update.suspended = true;
      update.canAcceptOrders = false;
      update.online = false;
      update['governance.suspensionReason'] = reason;
      update['governance.suspendedAtMs'] = nowMs;
    } else if (action === 'ban') {
      update.lifecycleStatus = RIDER_V4_LIFECYCLE.BANNED;
      update.status = 'banned';
      update.blocked = true;
      update.canAcceptOrders = false;
      update.online = false;
      update['governance.banReason'] = reason;
      update['governance.bannedAtMs'] = nowMs;
    } else if (action === 'restore') {
      if (!isRiderV4OnboardingComplete(rider)) return res.status(409).json({ success:false, message:'此小U尚未完成入職，不能直接恢復 ACTIVE。' });
      update.lifecycleStatus = RIDER_V4_LIFECYCLE.ACTIVE;
      update.status = 'approved';
      update.suspended = false;
      update.blocked = false;
      update.disabled = false;
      update.canAcceptOrders = true;
      update.retraining = null;
    } else if (action === 'set_level') {
      const targetLevel = value.toUpperCase();
      if (!['L1','L2','L3','L4'].includes(targetLevel)) return res.status(400).json({ success:false, message:'等級只能是 L1/L2/L3/L4。' });
      if (targetLevel === 'L4' && !isRiderL4LearningQualified(rider)) {
        return res.status(409).json({ success:false, message:'此小U尚未完成全部 12 堂核心教學與 80 分以上測驗，不能設定為 L4。' });
      }
      update.riderLevel = targetLevel;
      if (targetLevel === 'L4') {
        update['learning.l4Qualified'] = true;
        update['learning.l4QualifiedAtMs'] = Number(rider.learning?.l4QualifiedAtMs || 0) || nowMs;
      }
    } else if (action === 'grant_cert' || action === 'revoke_cert') {
      if (!RIDER_V4_CERTIFICATIONS.includes(value)) return res.status(400).json({ success:false, message:'未知的認證項目。' });
      update[`certifications.${value}`] = action === 'grant_cert';
    } else {
      return res.status(400).json({ success:false, message:'不支援的 V4 管理動作。' });
    }

    await doc.ref.set(update, { merge:true });
    await db.collection('riderGovernanceEvents').add({
      riderDocId:doc.id,
      riderId:rider.riderId || doc.id,
      riderName:rider.name || '',
      type:eventType,
      value,
      reason,
      createdAtMs:nowMs,
      createdAt:admin.firestore.FieldValue.serverTimestamp(),
    });

    if (rider.lineUserId && ['warn','retraining','restrict','suspend','ban','restore'].includes(action)) {
      const labelMap = {
        warn:'收到平台提醒', retraining:'需要完成重新教育', restrict:'接單資格已限制',
        suspend:'接單資格已暫停', ban:'帳號已停權', restore:'接單資格已恢復',
      };
      client.pushMessage(rider.lineUserId, {
        type:'text',
        text:`UBee 小U通知｜${labelMap[action] || action}${reason ? `\n\n原因：${reason}` : ''}\n\n請開啟騎士端查看最新資格狀態。`,
      }).catch(err => console.warn('V4 管理通知小U失敗：', err?.message || err));
    }

    const updated = await doc.ref.get();
    return res.json({ success:true, rider:{ id:updated.id, ...updated.data() } });
  } catch (err) {
    console.error('❌ V4 admin action 失敗：', err);
    return res.status(500).json({ success:false, message:'V4 管理動作失敗。', error:err.message });
  }
});

// ===== 騎士 API 身分整理：手機登入 / riderId / 舊 LINE 相容 =====
function buildRiderApiIdentity(riderDoc, riderData = {}, source = {}) {
  const riderDocId = String(riderDoc && riderDoc.id ? riderDoc.id : '').trim();

  const phone = normalizePhone(
    riderData.phone ||
    source.phone ||
    source.riderPhone ||
    riderDocId ||
    ''
  );

  const riderId = String(
    riderData.riderId ||
    source.riderId ||
    riderDocId ||
    phone ||
    ''
  ).trim();

  const lineUserId = String(
    riderData.lineUserId ||
    source.lineUserId ||
    ''
  ).trim();

  return {
    riderDocId,
    riderId,
    phone,
    lineUserId,
  };
}

function isOrderBelongsToRider(order = {}, identity = {}) {
  if (!order || !identity) return false;

  const orderRiderDocId = String(order.riderDocId || '').trim();
  const orderRiderId = String(order.riderId || order.driverId || '').trim();
  const orderRiderPhone = normalizePhone(order.riderPhone || order.driverPhone || '');
  const orderLineUserId = String(order.riderLineUserId || order.lineUserId || '').trim();

  if (identity.riderDocId && orderRiderDocId && orderRiderDocId === identity.riderDocId) return true;
  if (identity.riderId && orderRiderId && orderRiderId === identity.riderId) return true;
  if (identity.phone && orderRiderPhone && orderRiderPhone === identity.phone) return true;
  if (identity.lineUserId && orderLineUserId && orderLineUserId === identity.lineUserId) return true;

  return false;
}

function getRiderIdentityKeys(identity = {}) {
  return Array.from(new Set([
    identity.riderDocId,
    identity.riderId,
    identity.phone,
    identity.lineUserId,
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean)));
}

function isOrderSkippedForRider(order = {}, identity = {}) {
  const skippedRiderIds = Array.isArray(order.skippedRiderIds)
    ? order.skippedRiderIds
        .map(value => String(value || '').trim())
        .filter(Boolean)
    : [];

  if (!skippedRiderIds.length) {
    return false;
  }

  const skippedSet = new Set(skippedRiderIds);

  return getRiderIdentityKeys(identity)
    .some(key => skippedSet.has(key));
}

// ===== 騎手接單 / 暫停接單狀態 API =====
// 相容既有 online 欄位：online=true 代表願意接單；online=false 代表暫停接單。
// 注意：暫停接單只影響派單資格，不會讓小U從調度中心消失。
// 手機登入正式版：支援 phone / riderId，並保留 lineUserId 相容
app.post('/api/rider/status', riderAuthMiddleware, async (req, res) => {
  try {
    const { lineUserId, phone, riderId, online } = req.body || {};

    if (typeof online !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: '上線狀態格式錯誤。',
      });
    }

    const riderResult = await findApprovedRiderForApi({
      lineUserId,
      phone,
      riderId,
    });

    if (!riderResult.ok) {
      return res.status(riderResult.statusCode).json({
        success: false,
        message: riderResult.message,
      });
    }

    const riderDoc = riderResult.riderDoc;
    const rider = riderResult.rider || {};

    if (online === true && !canRiderAcceptOrdersV4(rider)) {
      return res.status(403).json({
        success: false,
        code: 'RIDER_V4_NOT_ACTIVE',
        message: '尚未完成 V4 入職／資格目前受限，暫時不能開啟接單。',
        lifecycleStatus: getRiderV4LifecycleStatus(rider),
      });
    }

    const nowMs = Date.now();
    const updateData = {
      // 保留 online 相容既有派單與騎士端；新增 acceptingOrders 讓語意更清楚。
      online,
      acceptingOrders: online,
      busy: rider.busy === true ? true : false,
      currentOrderId: rider.currentOrderId || '',
      lastActive: nowMs,
      lastActiveMs: nowMs,
      onlineUpdatedAt: nowMs,
      onlineUpdatedAtMs: nowMs,
      dispatchPresenceState: online ? 'ACCEPTING' : 'PAUSED',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastIdentityMethod: phone || riderId ? 'phone' : 'line',
    };

    if (!online && rider.busy === true && rider.currentOrderId) {
      return res.status(409).json({
        success: false,
        message: '你目前有進行中的任務，完成後才能暫停接單。',
      });
    }

    if (!online) {
      updateData.busy = false;
      updateData.currentOrderId = '';
    }

    await db.collection('riders').doc(riderDoc.id).set(updateData, { merge: true });

    return res.json({
      success: true,
      message: online ? '已開始接單。' : '已暫停接單。',
      online,
      rider: {
        id: riderDoc.id,
        phone: rider.phone || riderDoc.id,
        name: rider.name || rider.riderName || '',
        online,
        busy: updateData.busy,
        currentOrderId: updateData.currentOrderId,
      },
    });

  } catch (err) {
    console.error('❌ 騎士狀態更新失敗：', err);

    return res.status(500).json({
      success: false,
      message: '騎士狀態更新失敗，請稍後再試。',
      error: err.message,
    });
  }
});

// ===== UBee 騎士即時定位同步 API =====
// 正式營運版：
// 1. 更新 riders/{騎士}
// 2. 若騎士有進行中任務，同步更新 orders/{orderId}
// 3. 客人端只需要監聽訂單文件，就能看到小U即時移動

app.post('/api/rider/location', riderAuthMiddleware, async (req, res) => {
  try {
    const {
      phone,
      riderId,
      lineUserId,

      orderId,

      lat,
      lng,

      accuracy,
      heading,
      speed,

      // 原生 App / Web 前景皆可沿用同一支 API。
      // 舊版未提供時會自動視為 web_foreground，不影響相容性。
      trackingSource,
      isBackground,

    } = req.body || {};

    const latitude = Number(lat);
    const longitude = Number(lng);

    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      return res.status(400).json({
        success: false,
        message: '騎士定位座標格式錯誤。',
      });
    }

    // ==============================
    // 1. 驗證正式騎士身分
    // ==============================
    const riderResult =
      await findApprovedRiderForApi({
        phone,
        riderId,
        lineUserId,
      });

    if (!riderResult.ok) {
      return res
        .status(riderResult.statusCode)
        .json({
          success: false,
          message:
            riderResult.message ||
            '騎士身分驗證失敗。',
        });
    }

    const riderDoc =
      riderResult.riderDoc;

    const nowMs =
      Date.now();

    // ==============================
    // 2. 安全整理 GPS 額外資訊
    // ==============================
    function getOptionalNumber(value) {
      if (
        value === null ||
        value === undefined ||
        value === ''
      ) {
        return null;
      }

      const numberValue =
        Number(value);

      return Number.isFinite(numberValue)
        ? numberValue
        : null;
    }

    const safeAccuracy =
      getOptionalNumber(accuracy);

    const rawHeading =
      getOptionalNumber(heading);

    const safeHeading =
      rawHeading === null
        ? null
        : (
            (
              rawHeading % 360
            ) + 360
          ) % 360;

    const rawSpeed =
      getOptionalNumber(speed);

    const safeSpeed =
      rawSpeed === null
        ? null
        : Math.max(
            0,
            rawSpeed
          );

    const safeTrackingSource = String(
      trackingSource ||
      (isBackground === true ? 'native_background' : 'web_foreground')
    )
      .trim()
      .slice(0, 50) || 'web_foreground';



    // ==============================
    // 3. 使用 Transaction
    //
    // 防止騎士剛好轉派或完成任務時，
    // 舊騎士定位誤寫入訂單
    // ==============================
    const transactionResult =
      await db.runTransaction(
        async transaction => {

          const latestRiderDoc =
            await transaction.get(
              riderDoc.ref
            );

          if (!latestRiderDoc.exists) {
            throw new Error(
              'RIDER_NOT_FOUND'
            );
          }

          const latestRider =
            latestRiderDoc.data() || {};

          const identity =
            buildRiderApiIdentity(
              latestRiderDoc,
              latestRider,
              {
                phone,
                riderId,
                lineUserId,
              }
            );

          const activeOrderId =
            String(
              orderId ||
              latestRider.currentOrderId ||
              ''
            )
              .trim()
              .toUpperCase();

          let orderRef = null;
          let orderDoc = null;
          let order = null;

          // 注意：
          // Transaction 必須先完成讀取，
          // 才能開始寫入。
          if (activeOrderId) {
            orderRef =
              db
                .collection('orders')
                .doc(activeOrderId);

            orderDoc =
              await transaction.get(
                orderRef
              );

            if (orderDoc.exists) {
              order = {
                id: orderDoc.id,
                ...orderDoc.data(),
              };
            }
          }

          const liveLocation = {
            lat: latitude,
            lng: longitude,
            updatedAtMs: nowMs,
          };

          if (safeAccuracy !== null) {
            liveLocation.accuracy =
              safeAccuracy;
          }

          if (safeHeading !== null) {
            liveLocation.heading =
              safeHeading;
          }

          if (safeSpeed !== null) {
            liveLocation.speed =
              safeSpeed;
          }

          // ==========================
          // 4. 更新騎士主資料
          // ==========================
          transaction.set(
            latestRiderDoc.ref,
            {
              currentLat:
                latitude,

              currentLng:
                longitude,

              currentLocation: {
                ...liveLocation,

                updatedAt:
                  admin.firestore
                    .FieldValue
                    .serverTimestamp(),
              },

              locationUpdatedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),

              locationUpdatedAtMs:
                nowMs,

              lastActive:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),

              lastActiveMs:
                nowMs,

              lastSeenAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),

              lastSeenAtMs:
                nowMs,

              connectionState:
                'connected',

              locationHealthState:
                'healthy',

              lastLocationSuccessAtMs:
                nowMs,

              // 任務定位與一般上線狀態分離。
              // 即使 online 新鮮度逾時，只要訂單仍在執行，調度仍可用最後位置追蹤。
              taskTrackingStatus:
                activeOrderId ? 'live' : (latestRider.taskTrackingStatus || 'idle'),

              taskTrackingSource:
                safeTrackingSource,

              taskTrackingUpdatedAtMs:
                nowMs,

              taskTrackingUpdatedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),
            },
            {
              merge: true,
            }
          );

          // ==========================
          // 5. 同步進行中訂單
          // ==========================
          const activeStatuses = [
            'accepted',
            'going_to_pickup',
            'arrived_pickup',
            'picked_up',
            'going_to_dropoff',
            'arrived_dropoff',
          ];

          const orderIsActive =
            order &&
            activeStatuses.includes(
              String(
                order.status || ''
              ).trim()
            );

          const orderBelongsToRider =
            order &&
            isOrderBelongsToRider(
              order,
              identity
            );

          if (
            orderRef &&
            orderIsActive &&
            orderBelongsToRider
          ) {
            // V5 任務軌跡：只保留最近 40 個有效採樣點。
            // 至少間隔 30 秒，或位移 >= 80 公尺才追加，避免 Firestore 文件無限制膨脹。
            const existingTrail = Array.isArray(order.riderLocationTrail)
              ? order.riderLocationTrail
                  .filter(point => point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng)))
                  .slice(-39)
              : [];
            const lastTrailPoint = existingTrail.length
              ? existingTrail[existingTrail.length - 1]
              : null;
            const trailDistanceKm = lastTrailPoint
              ? calcDispatchPushDistanceKm(
                  Number(lastTrailPoint.lat),
                  Number(lastTrailPoint.lng),
                  latitude,
                  longitude
                )
              : null;
            const shouldAppendTrail =
              !lastTrailPoint ||
              !Number(lastTrailPoint.updatedAtMs || 0) ||
              (nowMs - Number(lastTrailPoint.updatedAtMs || 0)) >= 30 * 1000 ||
              (Number.isFinite(trailDistanceKm) && trailDistanceKm >= 0.08);

            const nextTrail = shouldAppendTrail
              ? [
                  ...existingTrail,
                  {
                    lat: latitude,
                    lng: longitude,
                    updatedAtMs: nowMs,
                    heading: safeHeading,
                    speed: safeSpeed,
                    accuracy: safeAccuracy,
                  },
                ].slice(-40)
              : existingTrail;

            const orderLocationUpdate = {
              riderCurrentLat:
                latitude,

              riderCurrentLng:
                longitude,

              riderCurrentLocation: {
                ...liveLocation,

                updatedAt:
                  admin.firestore
                    .FieldValue
                    .serverTimestamp(),
              },

              riderLocationUpdatedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),

              riderLocationUpdatedAtMs:
                nowMs,

              riderTrackingStatus:
                'live',

              riderTrackingSource:
                safeTrackingSource,

              riderTrackingIsBackground:
                isBackground === true || safeTrackingSource === 'native_background',

              trackingUpdatedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),

              trackingUpdatedAtMs:
                nowMs,

              // V5 最近移動軌跡（有新採樣點才更新）。
              ...(shouldAppendTrail ? { riderLocationTrail: nextTrail } : {}),

            };

            if (safeAccuracy !== null) {
              orderLocationUpdate
                .riderLocationAccuracy =
                  safeAccuracy;
            }

            if (safeHeading !== null) {
              orderLocationUpdate
                .riderHeading =
                  safeHeading;
            }

            if (safeSpeed !== null) {
              orderLocationUpdate
                .riderSpeed =
                  safeSpeed;
            }

            transaction.set(
              orderRef,
              orderLocationUpdate,
              {
                merge: true,
              }
            );

            return {
              syncedOrder: true,
              orderId: activeOrderId,
            };
          }

          return {
            syncedOrder: false,
            orderId: '',
          };
        }
      );

    return res.json({
      success: true,

      riderId:
        riderDoc.id,

      syncedOrder:
        transactionResult
          .syncedOrder === true,

      orderId:
        transactionResult
          .orderId ||
        '',

      locationUpdatedAtMs:
        nowMs,
    });

  } catch (err) {
    console.error(
      '❌ 騎士即時定位同步失敗：',
      err
    );

    if (
      err.message ===
      'RIDER_NOT_FOUND'
    ) {
      return res
        .status(404)
        .json({
          success: false,
          message:
            '找不到騎士資料。',
        });
    }

    return res
      .status(500)
      .json({
        success: false,
        message:
          '騎士定位同步失敗，請稍後再試。',
        error:
          err.message,
      });
  }
});

// ===== UBee 騎士安全中心回報 API =====
// 手機登入正式版：支援 phone / riderId / 舊 LINE 身分
app.post('/api/rider/safety-report', riderAuthMiddleware, async (req, res) => {
  try {
    const {
      phone,
      riderId,
      lineUserId,
      reportType,
      reportTitle,
      reportOption,
      note,
      orderId,
      orderNo,
      orderStatus,
      createdFrom,
    } = req.body || {};

    // ==============================
    // 1. 安全回報分類
    // ==============================
    const typeMap = {
      customer: '客人失聯 / 無法交付',
      store: '店家異常',
      money: '金額 / 代墊異常',
      accident: '事故 / 緊急狀況',
      account_system: '帳號與系統',
    };

    const safeReportType = cleanText(
      reportType || '',
      30
    );

    const safeReportTitle = cleanText(
      reportTitle ||
      typeMap[safeReportType] ||
      '',
      60
    );

    const safeReportOption = cleanText(
      reportOption || '',
      80
    );

    const safeNote = cleanLongText(
      note || '',
      500
    );

    const safeOrderId = cleanText(
      orderId || '',
      120
    ).replace(/\//g, '');

    const safeOrderNo = cleanText(
      orderNo || '',
      120
    );

    const safeOrderStatus = cleanText(
      orderStatus || '',
      40
    );

    const safeCreatedFrom = cleanText(
      createdFrom || 'rider-web',
      40
    );

    if (!typeMap[safeReportType]) {
      return res.status(400).json({
        success: false,
        message: '安全回報分類錯誤。',
      });
    }

    if (!safeReportOption) {
      return res.status(400).json({
        success: false,
        message: '請選擇要回報的狀況。',
      });
    }

    // ==============================
    // 2. 驗證正式騎士身分
    //
    // 支援：
    // phone
    // riderId
    // lineUserId
    // ==============================
    const riderResult =
      await findApprovedRiderForApi({
        phone,
        riderId,
        lineUserId,
      });

    if (!riderResult.ok) {
      return res
        .status(riderResult.statusCode || 403)
        .json({
          success: false,
          message:
            riderResult.message ||
            '騎士身分驗證失敗。',
        });
    }

    const riderDoc =
      riderResult.riderDoc;

    const rider =
      riderResult.rider || {};

    // ==============================
    // 3. 統一騎士身分
    // ==============================
    const identity =
      buildRiderApiIdentity(
        riderDoc,
        rider,
        {
          phone,
          riderId,
          lineUserId,
        }
      );

    // ==============================
    // 4. 讀取關聯訂單
    // ==============================
    let orderData = null;

    if (safeOrderId) {
      try {
        const orderDoc =
          await db
            .collection('orders')
            .doc(safeOrderId)
            .get();

        if (orderDoc.exists) {
          orderData = {
            id: orderDoc.id,
            ...orderDoc.data(),
          };
        }

      } catch (orderErr) {
        console.warn(
          '安全中心回報讀取訂單失敗：',
          orderErr.message
        );
      }
    }

    // ==============================
    // 5. 建立安全回報
    // ==============================
    const reportRef =
      db
        .collection('riderSafetyReports')
        .doc();

    const reportId =
      reportRef.id;

    const report = {
      id: reportId,
      reportId,

      status: 'open',

      priority:
        safeReportType === 'accident'
          ? 'urgent'
          : 'normal',

      reportType:
        safeReportType,

      reportTitle:
        safeReportTitle ||
        typeMap[safeReportType],

      reportOption:
        safeReportOption,

      note:
        safeNote,

      // ==============================
      // 騎士身分
      // ==============================
      riderDocId:
        identity.riderDocId ||
        riderDoc.id,

      riderId:
        identity.riderId ||
        '',

      riderName:
        cleanText(
          rider.name ||
          rider.riderName ||
          '',
          40
        ),

      riderPhone:
        identity.phone ||
        normalizePhone(
          rider.phone ||
          riderDoc.id ||
          ''
        ),

      riderLineUserId:
        identity.lineUserId ||
        '',

      riderPlateNumber:
        cleanText(
          rider.plateNumber ||
          rider.plateNo ||
          '',
          30
        ),

      riderServiceArea:
        cleanText(
          rider.serviceArea ||
          rider.area ||
          '',
          80
        ),

      // ==============================
      // 訂單資料
      // ==============================
      orderId:
        orderData?.id ||
        safeOrderId ||
        '',

      orderNo:
        cleanText(
          orderData?.orderNo ||
          safeOrderNo ||
          orderData?.id ||
          '',
          120
        ),

      orderStatus:
        cleanText(
          orderData?.status ||
          safeOrderStatus ||
          '',
          40
        ),

      pickupAddress:
        cleanText(
          orderData?.pickupAddress ||
          orderData?.fromAddress ||
          '',
          160
        ),

      dropoffAddress:
        cleanText(
          orderData?.dropoffAddress ||
          orderData?.toAddress ||
          '',
          160
        ),

      source:
        safeCreatedFrom,

      createdAt:
        admin.firestore.FieldValue.serverTimestamp(),

      createdAtMs:
        Date.now(),

      updatedAt:
        admin.firestore.FieldValue.serverTimestamp(),
    };

    await reportRef.set(report);

    // ==============================
    // 6. 回寫訂單最後安全回報
    // ==============================
    if (report.orderId) {
      await db
        .collection('orders')
        .doc(report.orderId)
        .set({
          lastSafetyReportId:
            reportId,

          lastSafetyReportType:
            report.reportType,

          lastSafetyReportTitle:
            report.reportTitle,

          lastSafetyReportOption:
            report.reportOption,

          lastSafetyReportAt:
            admin.firestore.FieldValue.serverTimestamp(),

        }, {
          merge: true
        });
    }

    // ==============================
    // 7. LINE 安全群通知
    // ==============================
    const adminText =
`🛡️ UBee 騎士安全中心回報

回報分類：${report.reportTitle}
回報狀況：${report.reportOption}
優先等級：${report.priority === 'urgent' ? '緊急' : '一般'}

騎士姓名：${report.riderName || '未提供'}
騎士電話：${report.riderPhone || '未提供'}
騎士 ID：${report.riderId || report.riderDocId || '未提供'}
車牌：${report.riderPlateNumber || '未提供'}
LINE：${report.riderLineUserId || '未綁定'}

訂單編號：${report.orderNo || report.orderId || '目前未綁定訂單'}
訂單狀態：${report.orderStatus || '未提供'}

補充說明：
${report.note || '未填寫'}

回報編號：${reportId}`;

    try {
      await pushToGroup(
        LINE_SAFETY_GROUP_ID,
        createTextMessage(adminText)
      );

      console.log(
        '✅ 安全中心回報已推送到 LINE_SAFETY_GROUP_ID：',
        LINE_SAFETY_GROUP_ID
      );

    } catch (pushErr) {
      console.error(
        '安全中心回報推送安全群失敗：',
        pushErr
      );
    }

    // ==============================
    // 8. 回傳成功
    // ==============================
    return res.json({
      success: true,
      message: '安全中心回報已送出。',
      reportId,
    });

  } catch (err) {
    console.error(
      '❌ 騎士安全中心回報失敗：',
      err
    );

    return res.status(500).json({
      success: false,
      message:
        '安全中心回報失敗，請稍後再試。',
      error:
        err.message,
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
        message: '資料不完整，請確認公司名稱、聯絡人、手機、所在區域與需求資料都有填寫正確。',
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
      message: '合作需求已送出，UBee 跑腿將會進行審核與評估。',
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

// =====================================================
// UBee 店家平台 V3：店家方案、佣金、結算與資料隔離
// =====================================================
const UBEE_MERCHANT_V3_VERSION = '3.1.0';
const UBEE_MERCHANT_DEFAULT_PLAN = 'DIRECT_DISPATCH';
const UBEE_MERCHANT_ORDER_SOURCES = new Set([
  'MERCHANT_DIRECT',
  'CUSTOMER_REQUEST',
  'UBEE_MARKETPLACE',
  'MANUAL_DISPATCH',
  'API',
]);

function merchantV3ToMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function merchantV3Money(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
}

function normalizeMerchantCommissionRate(value) {
  const rate = Number(value || 0);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return rate > 1 ? Math.min(1, rate / 100) : Math.min(1, rate);
}

function buildMerchantV3Profile(merchantId, merchant = {}) {
  const commissionRate = normalizeMerchantCommissionRate(
    merchant.commissionRate || 0
  );

  return {
    id: merchantId,
    merchantId,
    merchantName: merchant.merchantName || '',
    contactPerson: merchant.contactPerson || '',
    phone: merchant.phone || merchant.merchantPhone || '',
    merchantPhone: merchant.phone || merchant.merchantPhone || '',
    pickupAddress: merchant.pickupAddress || merchant.merchantAddress || '',
    merchantAddress: merchant.pickupAddress || merchant.merchantAddress || '',
    businessType: merchant.businessType || merchant.merchantType || '',
    merchantType: merchant.businessType || merchant.merchantType || '',
    settlementType: merchant.settlementType || 'merchant_settlement',
    status: merchant.status || '',
    approved: merchant.approved === true,

    merchantPlan:
      String(merchant.merchantPlan || UBEE_MERCHANT_DEFAULT_PLAN)
        .trim()
        .toUpperCase(),

    platformMode:
      String(merchant.platformMode || 'DELIVERY_ONLY')
        .trim()
        .toUpperCase(),

    commissionEnabled: merchant.commissionEnabled === true,
    commissionRate,
    commissionRatePercent: Math.round(commissionRate * 10000) / 100,
    commissionMinimum: merchantV3Money(merchant.commissionMinimum),
    commissionMaximum: merchantV3Money(merchant.commissionMaximum),
    monthlyFee: merchantV3Money(merchant.monthlyFee),
    billingCycle:
      String(merchant.billingCycle || 'MONTHLY')
        .trim()
        .toUpperCase(),

    marketplaceEnabled: merchant.marketplaceEnabled === true,
    directDispatchEnabled: merchant.directDispatchEnabled !== false,
    maxStopsPerOrder: Math.max(
      1,
      Math.min(8, Number(merchant.maxStopsPerOrder || 8))
    ),
  };
}

function getMerchantLineUserIdFromRequest(req) {
  return String(
    req.headers['x-ubee-merchant-line-user-id'] ||
    req.query?.lineUserId ||
    req.body?.lineUserId ||
    ''
  ).trim();
}

async function resolveApprovedMerchantV3(req) {
  const lineUserId = getMerchantLineUserIdFromRequest(req);

  if (!lineUserId || !lineUserId.startsWith('U')) {
    const error = new Error('缺少正確的店家 LINE 身分。');
    error.statusCode = 401;
    error.code = 'MERCHANT_IDENTITY_REQUIRED';
    throw error;
  }

  const snap = await db
    .collection('merchants')
    .where('lineUserId', '==', lineUserId)
    .limit(1)
    .get();

  if (snap.empty) {
    const error = new Error('尚未綁定店家帳號。');
    error.statusCode = 404;
    error.code = 'MERCHANT_NOT_BOUND';
    throw error;
  }

  const doc = snap.docs[0];
  const merchant = doc.data() || {};

  if (merchant.status !== 'approved' && merchant.approved !== true) {
    const error = new Error('店家帳號尚未審核通過。');
    error.statusCode = 403;
    error.code = 'MERCHANT_NOT_APPROVED';
    throw error;
  }

  return {
    merchantDoc: doc,
    merchantId: doc.id,
    merchant,
    profile: buildMerchantV3Profile(doc.id, merchant),
    lineUserId,
  };
}

function sendMerchantV3Error(res, error) {
  const status = Number(error?.statusCode || 500);
  return res.status(status).json({
    success: false,
    ok: false,
    code: error?.code || 'MERCHANT_V3_ERROR',
    message: error?.message || '店家平台處理失敗。',
  });
}

function calculateMerchantCommissionV3({
  merchant = {},
  orderSource = 'MERCHANT_DIRECT',
  goodsAmount = 0,
}) {
  const normalizedSource = String(orderSource || 'MERCHANT_DIRECT')
    .trim()
    .toUpperCase();

  const commissionEnabled =
    merchant.commissionEnabled === true &&
    (
      normalizedSource === 'UBEE_MARKETPLACE' ||
      merchant.commissionApplyToDirectOrders === true
    );

  const commissionRate = normalizeMerchantCommissionRate(
    merchant.commissionRate || 0
  );

  const baseAmount = merchantV3Money(goodsAmount);

  if (!commissionEnabled || commissionRate <= 0 || baseAmount <= 0) {
    return {
      commissionEnabled: false,
      commissionRate,
      commissionBaseAmount: baseAmount,
      commissionAmount: 0,
      merchantNetAmount: baseAmount,
    };
  }

  let commissionAmount = Math.round(baseAmount * commissionRate);

  const minimum = merchantV3Money(merchant.commissionMinimum);
  const maximum = merchantV3Money(merchant.commissionMaximum);

  if (minimum > 0) commissionAmount = Math.max(minimum, commissionAmount);
  if (maximum > 0) commissionAmount = Math.min(maximum, commissionAmount);
  commissionAmount = Math.min(baseAmount, commissionAmount);

  return {
    commissionEnabled: true,
    commissionRate,
    commissionBaseAmount: baseAmount,
    commissionAmount,
    merchantNetAmount: Math.max(0, baseAmount - commissionAmount),
  };
}

function getMerchantSettlementPeriodV3(value = Date.now()) {
  const date = new Date(value);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
  });
  return formatter.format(date).slice(0, 7);
}

async function listMerchantOrdersV3(merchantId, merchantPhone, limit = 200) {
  const safeLimit = Math.max(1, Math.min(300, Number(limit || 200)));
  const refs = [];
  const seenQuery = new Set();

  const addQuery = (field, value) => {
    const safe = String(value || '').trim();
    const key = `${field}:${safe}`;
    if (!safe || seenQuery.has(key)) return;
    seenQuery.add(key);
    refs.push(
      db.collection('orders')
        .where(field, '==', safe)
        .limit(safeLimit)
        .get()
    );
  };

  addQuery('merchantId', merchantId);
  addQuery('merchantCode', merchantId);
  addQuery('merchantPhone', merchantPhone);

  const snapshots = await Promise.all(refs);
  const map = new Map();

  snapshots.forEach(snapshot => {
    snapshot.docs.forEach(doc => {
      map.set(doc.id, {
        id: doc.id,
        ...(doc.data() || {}),
      });
    });
  });

  return Array.from(map.values())
    .sort((a, b) =>
      merchantV3ToMs(b.createdAt || b.createdAtMs) -
      merchantV3ToMs(a.createdAt || a.createdAtMs)
    )
    .slice(0, safeLimit);
}

function buildMerchantSummaryV3(orders = []) {
  const now = new Date();
  const todayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  const summary = {
    orderCount: orders.length,
    activeOrderCount: 0,
    completedOrderCount: 0,
    cancelledOrderCount: 0,
    todayOrderCount: 0,
    deliveryFeeTotal: 0,
    goodsAmountTotal: 0,
    commissionAmountTotal: 0,
    merchantNetAmountTotal: 0,
    pendingMerchantBillingAmount: 0,
    paidMerchantBillingAmount: 0,
    pendingSettlementAmount: 0,
    settledAmount: 0,
  };

  const activeStatuses = new Set([
    'merchant_pending',
    'merchant_preparing',
    'merchant_ready',
    'pending_dispatch',
    'accepted',
    'arrived_pickup',
    'picked_up',
    'arrived_dropoff',
  ]);

  orders.forEach(order => {
    const status = String(order.status || '').trim().toLowerCase();
    const createdAtMs = merchantV3ToMs(order.createdAt || order.createdAtMs);

    if (activeStatuses.has(status)) summary.activeOrderCount += 1;
    if (status === 'completed' || status === 'done') summary.completedOrderCount += 1;
    if (status.includes('cancel')) summary.cancelledOrderCount += 1;

    if (createdAtMs) {
      const orderDay = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(createdAtMs));
      if (orderDay === todayKey) summary.todayOrderCount += 1;
    }

    summary.deliveryFeeTotal += merchantV3Money(
      order.deliveryFee || order.merchantServiceFee || order.totalFee
    );
    summary.goodsAmountTotal += merchantV3Money(order.goodsAmount);
    summary.commissionAmountTotal += merchantV3Money(order.commissionAmount);
    summary.merchantNetAmountTotal += merchantV3Money(order.merchantNetAmount);

    const billingStatus = String(order.merchantBillingStatus || '').toLowerCase();
    const payable = merchantV3Money(
      order.merchantPayableAmount || order.storePayableAmount
    );

    if (billingStatus === 'paid') {
      summary.paidMerchantBillingAmount += payable;
    } else if (billingStatus !== 'not_billable') {
      summary.pendingMerchantBillingAmount += payable;
    }

    const settlementStatus = String(
      order.settlementStatus || 'NOT_REQUIRED'
    ).toUpperCase();

    const merchantNet = merchantV3Money(order.merchantNetAmount);

    if (settlementStatus === 'PENDING') {
      summary.pendingSettlementAmount += merchantNet;
    }
    if (settlementStatus === 'SETTLED') {
      summary.settledAmount += merchantNet;
    }
  });

  return summary;
}


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

      // 店家平台 V3 預設為「配送工具」方案：
      // 店內商品不抽成，只有日後正式開通商城合作才啟用佣金。
      merchantPlan: UBEE_MERCHANT_DEFAULT_PLAN,
      platformMode: 'DELIVERY_ONLY',
      directDispatchEnabled: true,
      marketplaceEnabled: false,
      commissionEnabled: false,
      commissionRate: 0,
      commissionMinimum: 0,
      commissionMaximum: 0,
      monthlyFee: 0,
      billingCycle: 'MONTHLY',
      maxStopsPerOrder: 8,

      lineUserId: '',
      boundAt: null,

      source: 'merchant-register',
      createdAt: now,
      updatedAt: now,
    });

    return res.json({
      ok: true,
      message: '合作申請已送出，請等待 UBee 跑腿管理端進行審核',
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
      merchant: buildMerchantV3Profile(doc.id, merchant),
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
        message: '此店家帳號已完成綁定，如需更換管理者，請聯繫 UBee 跑腿客服',
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
      merchant: buildMerchantV3Profile(doc.id, {
        ...merchant,
        approved: true,
      }),
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
  // 騎士分潤比例
  driverRatio: 0.7,

  // 一般配送基本價格
  baseFee: 60,
  perKm: 12,
  perMinute: 2,

  // 平台服務費
  serviceFee: 20,

  // 排隊服務設定
  queueBaseFee: 80,
  queuePerMinute: 4,
  queueLongTaskThresholdMinutes: 240,
  queueLongTaskExtraFee: 100,
  maxQuoteTimeMinutes: 480,

  // 舊版相容欄位，先保留，避免其他地方還有引用
  waitingFee: 30,
};

// =====================================================
// UBee「幫我取 / 幫代買」專用即時配送計價
//
// 僅套用：
// - pickup / 幫我取
// - buy / 幫代買 / 幫我買
//
// 其他服務全部維持原本 PRICING + calculatePrice() 邏輯不變。
// 這兩種服務取消導航時間費（每分鐘 $2），避免短程因塞車被放大價格。
// =====================================================
const QUICK_SERVICE_PRICING = {
  pickup: {
    label: '幫我取',
    baseFee: 65,          // 0～3 km：$65
    upTo5KmExtra: 10,     // 3～5 km：總行程費 $75
    upTo8KmExtra: 30,     // 5～8 km：總行程費 $95
    extraPerKm: 12,       // 超過 8 km：每公里 +$12
    serviceFee: 10,       // 專用平台服務費
  },

  buy: {
    label: '幫代買',
    baseFee: 70,          // 0～3 km：$70
    upTo5KmExtra: 15,     // 3～5 km：總行程費 $85
    upTo8KmExtra: 35,     // 5～8 km：總行程費 $105
    extraPerKm: 12,       // 超過 8 km：每公里 +$12
    serviceFee: 10,       // 專用平台服務費
  },
};

const MAX_QUOTE_TIME_MINUTES = 480;

const SPEED_OPTIONS = {
  // 必須與前端快速估價頁 / 正式下單頁的速度費保持一致
  standard: {
    label: '一般件',
    time: '90–120 分鐘',
    fee: 0,
    riderText: '一般任務',
  },

  priority: {
    label: '標準件',
    time: '60–90 分鐘',
    fee: 30,
    riderText: '標準任務',
  },

  express: {
    label: '優先件',
    time: '45–60 分鐘',
    fee: 60,
    riderText: '優先任務',
  },
};

const ETA_OPTIONS = [5, 7, 8, 10, 12, 15, 17, 20, 25];

const orders = {};
const userSessions = {};
const distanceCache = new Map();
const dispatchStartInFlight = new Set();
let orderCounter = 1;

function startOrderDispatchInBackground(order) {
  const orderId =
    String(
      order?.id || ''
    )
      .trim()
      .toUpperCase();

  if (
    !orderId ||
    dispatchStartInFlight.has(orderId)
  ) {
    return;
  }

  dispatchStartInFlight.add(orderId);

  setImmediate(async () => {
    try {
      const orderRef =
        db
          .collection('orders')
          .doc(orderId);

      const orderDoc =
        await orderRef.get();

      if (!orderDoc.exists) {
        return;
      }

      const latestOrder = {
        id: orderDoc.id,
        ...orderDoc.data(),
      };

      if (
        String(
          latestOrder.status || ''
        ).trim() !== 'pending_dispatch' ||
        latestOrder.pushSentAt
      ) {
        return;
      }

      const cycleId =
        await startDispatchPushSequence(
          latestOrder
        );

      await orderRef.set(
        {
          pushSentAt:
            admin.firestore.FieldValue
              .serverTimestamp(),

          dispatchPushCycleId:
            cycleId,
        },
        {
          merge: true,
        }
      );

      if (orders[orderId]) {
        orders[orderId].pushSentAt =
          Date.now();

        orders[orderId].dispatchPushCycleId =
          cycleId;
      }

      console.log(
        `✅ UBee 背景派單已啟動：${orderId}`
      );

    } catch (error) {
      console.error(
        `❌ UBee 背景派單啟動失敗：${orderId}`,
        error
      );

    } finally {
      dispatchStartInFlight.delete(
        orderId
      );
    }
  });
}

async function saveOrder(order) {
  if (!order || !order.id) {
    return order;
  }

  const orderId =
    String(order.id)
      .trim()
      .toUpperCase();

  order.id = orderId;

  orders[orderId] = order;

  await db
    .collection('orders')
    .doc(orderId)
    .set(
      order,
      {
        merge: true
      }
    );

  if (
    order.status ===
      'pending_dispatch' &&
    !order.pushSentAt
  ) {
    startOrderDispatchInBackground(
      order
    );
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

function buildApprovedRiderV2(application, approvedBy) {
  const phone = normalizePhone(
    application.phone || application.riderId || application.id || ''
  );

  if (!/^09\d{8}$/.test(phone)) {
    throw new Error('RIDER_V2_PHONE_INVALID');
  }

  const nowMs = Date.now();

  return {
    riderId: phone,
    id: phone,
    applicationId: application.applicationId || phone,
    applicationCollection: RIDER_V2_COLLECTIONS.applications,
    dataVersion: RIDER_V2_DATA_VERSION,
    applicationRound:
      application.applicationRound || RIDER_V2_APPLICATION_ROUND,

    name: cleanText(application.name || '', 20),
    phone,
    lineId: cleanText(application.lineId || '', 60),
    userId: String(
      application.lineUserId || application.userId || ''
    ).trim(),
    lineUserId: String(
      application.lineUserId || application.userId || ''
    ).trim(),

    district: cleanText(application.district || '', 80),
    city: cleanText(application.city || '', 20),
    residenceCity: cleanText(
      application.residenceCity || application.city || '',
      20
    ),
    residenceDistrict: cleanText(
      application.residenceDistrict || '',
      20
    ),

    vehicle: cleanText(application.vehicle || '', 40),
    plateNumber: cleanText(application.plateNumber || '', 20),
    vehicleOwnerType: String(
      application.vehicleOwnerType || 'self'
    ).trim(),
    compulsoryInsuranceExpiryDate: String(
      application.compulsoryInsuranceExpiryDate || ''
    ).trim(),

    area: cleanText(
      application.serviceArea || application.area || '',
      80
    ),
    serviceArea: cleanText(
      application.serviceArea || application.area || '',
      80
    ),
    serviceCity: cleanText(application.serviceCity || '', 20),
    serviceCities: Array.isArray(application.serviceCities)
      ? application.serviceCities
      : [],
    serviceDistricts: Array.isArray(application.serviceDistricts)
      ? application.serviceDistricts
      : [],
    availableTime: cleanText(application.availableTime || '', 80),

    emergencyContact: {
      name: cleanText(application.emergencyContact?.name || '', 30),
      relationship: cleanText(
        application.emergencyContact?.relationship || '',
        30
      ),
      phone: normalizePhone(
        application.emergencyContact?.phone || ''
      ),
    },

    identityVerified: true,
    driverLicenseVerified: true,
    vehicleLicenseVerified: true,
    compulsoryInsuranceVerified: true,
    documentVerificationStatus: 'approved',

    approved: true,
    reviewStatus: 'approved',
    status: 'training',
    lifecycleStatus: RIDER_V4_LIFECYCLE.TRAINING,
    canAcceptOrders: false,
    riderLevel: 'L0',
    onboardingRequired: true,
    onboarding: {
      jkopayInstalled: false,
      announcementGroupJoined: false,
      chatGroupJoined: false,
      reportGroupJoined: false,
      modules: {},
      quizScore: 0,
      quizPassed: false,
      completed: false,
      startedAtMs: nowMs,
    },
    certifications: { basic: false },
    governance: { warningCount: 0, violationCount: 0 },

    online: false,
    busy: false,
    currentOrderId: '',

    approvedAt: nowMs,
    approvedBy,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

async function saveRiderV2(rider, { mirrorLegacy = true } = {}) {
  const phone = normalizePhone(rider?.phone || rider?.riderId || '');

  if (!/^09\d{8}$/.test(phone)) {
    throw new Error('RIDER_V2_PHONE_INVALID');
  }

  const payload = {
    ...rider,
    id: phone,
    riderId: phone,
    phone,
    dataVersion: RIDER_V2_DATA_VERSION,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAtMs: Date.now(),
  };

  await db
    .collection(RIDER_V2_COLLECTIONS.riders)
    .doc(phone)
    .set(payload, { merge: true });

  if (mirrorLegacy && RIDER_V2_MIRROR_TO_LEGACY_RIDERS) {
    await db
      .collection('riders')
      .doc(phone)
      .set({
        ...payload,
        v2Mirror: true,
        v2SourceCollection: RIDER_V2_COLLECTIONS.riders,
      }, { merge: true });
  }

  riders[phone] = payload;
  return payload;
}

async function getRider(riderId) {
  const id = String(riderId || '').trim();
  if (!id) return null;

  // 審核按鈕必須優先讀取本輪新版申請，避免同手機的舊 riders 資料蓋過新申請。
  const applicationDoc = await db
    .collection(RIDER_V2_COLLECTIONS.applications)
    .doc(id)
    .get();

  if (applicationDoc.exists) {
    return {
      id: applicationDoc.id,
      ...applicationDoc.data(),
      sourceCollection: RIDER_V2_COLLECTIONS.applications,
    };
  }

  const officialDoc = await db
    .collection(RIDER_V2_COLLECTIONS.riders)
    .doc(id)
    .get();

  if (officialDoc.exists) {
    const rider = {
      id: officialDoc.id,
      ...officialDoc.data(),
      sourceCollection: RIDER_V2_COLLECTIONS.riders,
    };
    riders[id] = rider;
    return rider;
  }

  if (riders[id]) return riders[id];

  const legacyDoc = await db.collection('riders').doc(id).get();
  if (!legacyDoc.exists) return null;

  const rider = {
    id: legacyDoc.id,
    ...legacyDoc.data(),
    sourceCollection: 'riders',
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

const UBEE_TAIWAN_REGIONS = {"台北市":["中正區","大同區","中山區","松山區","大安區","萬華區","信義區","士林區","北投區","內湖區","南港區","文山區"],"新北市":["萬里區","金山區","板橋區","汐止區","深坑區","石碇區","瑞芳區","平溪區","雙溪區","貢寮區","新店區","坪林區","烏來區","永和區","中和區","土城區","三峽區","樹林區","鶯歌區","三重區","新莊區","泰山區","林口區","蘆洲區","五股區","八里區","淡水區","三芝區","石門區"],"桃園市":["桃園區","中壢區","平鎮區","八德區","楊梅區","蘆竹區","大溪區","龍潭區","龜山區","大園區","觀音區","新屋區","復興區"],"台中市":["中區","東區","南區","西區","北區","北屯區","西屯區","南屯區","太平區","大里區","霧峰區","烏日區","豐原區","后里區","石岡區","東勢區","和平區","新社區","潭子區","大雅區","神岡區","大肚區","沙鹿區","龍井區","梧棲區","清水區","大甲區","外埔區","大安區"],"台南市":["中西區","東區","南區","北區","安平區","安南區","永康區","歸仁區","新化區","左鎮區","玉井區","楠西區","南化區","仁德區","關廟區","龍崎區","官田區","麻豆區","佳里區","西港區","七股區","將軍區","學甲區","北門區","新營區","後壁區","白河區","東山區","六甲區","下營區","柳營區","鹽水區","善化區","大內區","山上區","新市區","安定區"],"高雄市":["鹽埕區","鼓山區","左營區","楠梓區","三民區","新興區","前金區","苓雅區","前鎮區","旗津區","小港區","鳳山區","林園區","大寮區","大樹區","大社區","仁武區","鳥松區","岡山區","橋頭區","燕巢區","田寮區","阿蓮區","路竹區","湖內區","茄萣區","永安區","彌陀區","梓官區","旗山區","美濃區","六龜區","甲仙區","杉林區","內門區","茂林區","桃源區","那瑪夏區"],"基隆市":["中正區","七堵區","暖暖區","仁愛區","中山區","安樂區","信義區"],"新竹市":["東區","北區","香山區"],"嘉義市":["東區","西區"],"新竹縣":["竹北市","關西鎮","新埔鎮","竹東鎮","湖口鄉","橫山鄉","新豐鄉","芎林鄉","寶山鄉","北埔鄉","峨眉鄉","尖石鄉","五峰鄉"],"苗栗縣":["苗栗市","苑裡鎮","通霄鎮","竹南鎮","頭份市","後龍鎮","卓蘭鎮","大湖鄉","公館鄉","銅鑼鄉","南庄鄉","頭屋鄉","三義鄉","西湖鄉","造橋鄉","三灣鄉","獅潭鄉","泰安鄉"],"彰化縣":["彰化市","鹿港鎮","和美鎮","線西鄉","伸港鄉","福興鄉","秀水鄉","花壇鄉","芬園鄉","員林市","溪湖鎮","田中鎮","大村鄉","埔鹽鄉","埔心鄉","永靖鄉","社頭鄉","二水鄉","北斗鎮","二林鎮","田尾鄉","埤頭鄉","芳苑鄉","大城鄉","竹塘鄉","溪州鄉"],"南投縣":["南投市","埔里鎮","草屯鎮","竹山鎮","集集鎮","名間鄉","鹿谷鄉","中寮鄉","魚池鄉","國姓鄉","水里鄉","信義鄉","仁愛鄉"],"雲林縣":["斗六市","斗南鎮","虎尾鎮","西螺鎮","土庫鎮","北港鎮","古坑鄉","大埤鄉","莿桐鄉","林內鄉","二崙鄉","崙背鄉","麥寮鄉","東勢鄉","褒忠鄉","台西鄉","元長鄉","四湖鄉","口湖鄉","水林鄉"],"嘉義縣":["太保市","朴子市","布袋鎮","大林鎮","民雄鄉","溪口鄉","新港鄉","六腳鄉","東石鄉","義竹鄉","鹿草鄉","水上鄉","中埔鄉","竹崎鄉","梅山鄉","番路鄉","大埔鄉","阿里山鄉"],"屏東縣":["屏東市","潮州鎮","東港鎮","恆春鎮","萬丹鄉","長治鄉","麟洛鄉","九如鄉","里港鄉","鹽埔鄉","高樹鄉","萬巒鄉","內埔鄉","竹田鄉","新埤鄉","枋寮鄉","新園鄉","崁頂鄉","林邊鄉","南州鄉","佳冬鄉","琉球鄉","車城鄉","滿州鄉","枋山鄉","三地門鄉","霧台鄉","瑪家鄉","泰武鄉","來義鄉","春日鄉","獅子鄉","牡丹鄉"],"宜蘭縣":["宜蘭市","羅東鎮","蘇澳鎮","頭城鎮","礁溪鄉","壯圍鄉","員山鄉","冬山鄉","五結鄉","三星鄉","大同鄉","南澳鄉"],"花蓮縣":["花蓮市","鳳林鎮","玉里鎮","新城鄉","吉安鄉","壽豐鄉","光復鄉","豐濱鄉","瑞穗鄉","富里鄉","秀林鄉","萬榮鄉","卓溪鄉"],"台東縣":["台東市","成功鎮","關山鎮","卑南鄉","鹿野鄉","池上鄉","東河鄉","長濱鄉","太麻里鄉","大武鄉","綠島鄉","海端鄉","延平鄉","金峰鄉","達仁鄉","蘭嶼鄉"],"澎湖縣":["馬公市","湖西鄉","白沙鄉","西嶼鄉","望安鄉","七美鄉"],"金門縣":["金城鎮","金沙鎮","金湖鎮","金寧鄉","烈嶼鄉","烏坵鄉"],"連江縣":["南竿鄉","北竿鄉","莒光鄉","東引鄉"]};

const TAIWAN_CITY_COUNTY_NAMES = Object.keys(UBEE_TAIWAN_REGIONS);

// 舊程式仍會引用台中行政區清單，因此保留相容別名。
const TAICHUNG_DISTRICTS = UBEE_TAIWAN_REGIONS['台中市'] || [];

const UBEE_TAIWAN_REGION_PAIRS = Object.entries(UBEE_TAIWAN_REGIONS)
  .flatMap(([city, districts]) =>
    districts.map(district => ({
      city,
      district,
      fullDistrict: `${city}${district}`,
    }))
  );

function normalizeTaiwanRegionText(value) {
  return String(value || '')
    .trim()
    .replace(/臺/g, '台')
    .replace(/\s+/g, '');
}

function normalizeTaiwanCityName(value) {
  const text = normalizeTaiwanRegionText(value);
  if (!text) return '';
  return TAIWAN_CITY_COUNTY_NAMES.find(city => text === city || text.includes(city)) || '';
}

function inferTaiwanRegion(value) {
  const text = normalizeTaiwanRegionText(value);
  if (!text) return { city: '', district: '', fullDistrict: '' };

  const explicitCity = TAIWAN_CITY_COUNTY_NAMES.find(city => text.includes(city)) || '';

  if (explicitCity) {
    const district =
      (UBEE_TAIWAN_REGIONS[explicitCity] || [])
        .find(item => text.includes(item)) || '';

    return {
      city: explicitCity,
      district,
      fullDistrict: district ? `${explicitCity}${district}` : explicitCity,
    };
  }

  const fullPair = UBEE_TAIWAN_REGION_PAIRS.find(pair =>
    text.includes(pair.fullDistrict)
  );

  if (fullPair) return { ...fullPair };

  const districtMatches = UBEE_TAIWAN_REGION_PAIRS
    .filter(pair => text.includes(pair.district));

  const uniqueCities = [...new Set(districtMatches.map(pair => pair.city))];

  if (districtMatches.length && uniqueCities.length === 1) {
    return { ...districtMatches[0] };
  }

  return {
    city: '',
    district: districtMatches[0]?.district || '',
    fullDistrict: '',
  };
}

function buildTaiwanFullDistrict(city, district, fallback = '') {
  const safeCity = normalizeTaiwanCityName(city);
  const safeDistrict = normalizeTaiwanRegionText(district);

  if (
    safeCity &&
    safeDistrict &&
    (UBEE_TAIWAN_REGIONS[safeCity] || []).includes(safeDistrict)
  ) {
    return `${safeCity}${safeDistrict}`;
  }

  const inferred = inferTaiwanRegion(fallback || `${safeCity}${safeDistrict}`);
  return inferred.fullDistrict || normalizeTaiwanRegionText(fallback);
}

function normalizeTaiwanServiceDistricts(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[、,，\n]/);

  const output = [];
  const seen = new Set();

  source.forEach(item => {
    const text = normalizeTaiwanRegionText(item);
    if (!text) return;

    const inferred = inferTaiwanRegion(text);
    const normalized = inferred.fullDistrict || text;

    if (!seen.has(normalized)) {
      seen.add(normalized);
      output.push(normalized);
    }
  });

  return output.slice(0, 8);
}

function buildNationwideDispatchZoneId(city, district) {
  const safeCity = normalizeTaiwanCityName(city);
  const safeDistrict = normalizeTaiwanRegionText(district);

  if (safeCity === '台中市' && safeDistrict) {
    return `taichung_${safeDistrict}`;
  }

  if (safeCity && safeDistrict) {
    return `taiwan_${safeCity}_${safeDistrict}`;
  }

  if (safeCity) {
    return `taiwan_${safeCity}_unknown`;
  }

  return 'taiwan_unknown';
}

function normalizeTaskAddressForMaps(address) {
  let text = String(address || '').trim();

  if (!text) return '';

  // 全部統一成「台」
  text = text.replace(/臺/g, '台');

  // 已經有「台灣」
  if (text.startsWith('台灣')) {
    return text;
  }

  // 已經有完整縣市名稱
  if (
    TAIWAN_CITY_COUNTY_NAMES.some((name) =>
      text.includes(name)
    )
  ) {
    return `台灣 ${text}`;
  }

  // 使用者只輸入「台中...」
  // 例如：台中西屯區台灣大道
  if (text.startsWith('台中')) {
    text = text.replace(/^台中/, '台中市');
    return `台灣 ${text}`;
  }

  // 只有台中行政區
  // 例如：西屯區台灣大道、豐原區中正路
  if (
    TAICHUNG_DISTRICTS.some((district) =>
      text.includes(district)
    )
  ) {
    return `台灣 台中市 ${text}`;
  }

  // 只有道路、巷弄或地標時
  // 預設以目前主要營運城市「台中市」補足
  return `台灣 台中市 ${text}`;
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
    pending_payment: '🟡 待確認現金單',
    pending_schedule: '📅 預約媒合中',
    scheduled_reserved: '📅 預約已承接',
    scheduled_confirmed: '✅ 預約已確認',
    pending_dispatch: '🟡 待派單',
    accepted: '🟢 已接單',
    going_to_pickup: '🛵 前往取件地點',
    arrived_pickup: '🟠 已抵達取件地點',
    picked_up: '🔵 已取件',
    going_to_dropoff: '🛵 配送中',
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

const MAX_ADVANCE_PAYMENT = 1000;

const DUPLICATE_ORDER_WINDOW_MS = 90 * 1000;

function cleanText(value, maxLength = 100) {
  return String(value || '')
    .replace(/[<>]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanLongText(value, maxLength = 500) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function normalizeAdvancePaymentText(text) {
  return String(text || '')
    .replace(/[０-９]/g, function(ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    })
    .replace(/[，,]/g, '')
    .trim();
}

function parseNonNegativeMoney(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const raw = normalizeAdvancePaymentText(value);

  if (!raw) {
    return 0;
  }

  if (/^(無|沒有|不用|免|否|no|none|null|undefined)$/i.test(raw)) {
    return 0;
  }

  let amount = Number(raw);

  if (!Number.isFinite(amount)) {
    const match = raw.match(/\d+(?:\.\d+)?/);

    if (!match) {
      return 0;
    }

    amount = Number(match[0]);
  }

  if (!Number.isFinite(amount) || amount < 0) {
    return 0;
  }

  return Math.max(0, Math.round(amount));
}

function extractAdvancePaymentAmountFromText(text) {
  const source = normalizeAdvancePaymentText(text);

  if (!source) {
    return 0;
  }

  const hasAdvanceKeyword =
    /代墊|墊付|先墊|幫忙墊|幫我墊|代付|先付|先付款|代買金額|商品費|餐費|餐點費|餐點金額|商品金額|購買金額|購買費用|買東西金額|物品金額|預估金額|店家金額/.test(source);

  if (!hasAdvanceKeyword) {
    return 0;
  }

  const moneyRegex = /(?:NT\$|N T\$|新台幣|台幣|\$)?\s*(\d{1,7})(?:\s*(?:元|塊|圓|NTD|台幣))?/gi;

  let maxAmount = 0;
  let match;

  while ((match = moneyRegex.exec(source)) !== null) {
    const amount = Math.round(Number(match[1] || 0));

    if (Number.isFinite(amount) && amount > maxAmount) {
      maxAmount = amount;
    }
  }

  return maxAmount;
}

function getDetectedAdvancePaymentAmountFromOrderInput(data = {}) {
  const fieldAmount = parseNonNegativeMoney(
    data.advancePayment ??
    data.advanceAmount ??
    data.estimatedAdvancePayment ??
    data.estimatedAdvanceAmount ??
    data.riderAdvanceAmount ??
    0
  );

  if (Number.isNaN(fieldAmount)) {
    return NaN;
  }

  const textAmount = Math.max(
    extractAdvancePaymentAmountFromText(data.note || ''),
    extractAdvancePaymentAmountFromText(data.item || '')
  );

  return Math.max(fieldAmount || 0, textAmount || 0);
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

  const hasRemark = !!String(data.note || data.item || '').trim();

  if (!data.pickupAddress || !data.dropoffAddress || !data.pickupPhone || !data.dropoffPhone || !hasRemark) {
    errors.push('請完整填寫取件地址、送達地址、電話與備註。');
  }

  Object.entries(ORDER_INPUT_LIMITS).forEach(([key, limit]) => {
    if (String(data[key] || '').length > limit) {
      errors.push(`${key} 欄位過長，請縮短內容。`);
    }
  });

  const detectedAdvancePayment = getDetectedAdvancePaymentAmountFromOrderInput(data);

  if (detectedAdvancePayment >= MAX_ADVANCE_PAYMENT) {
    errors.push('UBee 跑腿目前不協助騎士代墊 NT$1,000（含）以上金額，請先聯繫 UBee 跑腿客服人工確認。');
  }

  const timingType =
    normalizeOrderTimingType(
      data.orderTimingType
    );

  const minimumFutureMs =
    Date.now() + 30 * 60 * 1000;

  if (
    timingType ===
    UBEE_ORDER_TIMING_TYPES.SCHEDULED
  ) {
    const requestedMs =
      getScheduleTimestampMs(
        data.requestedScheduleAtMs
      );

    if (!requestedMs) {
      errors.push('請選擇正確的預約日期與時間。');
    } else if (requestedMs < minimumFutureMs) {
      errors.push('預約時間至少需要晚於現在 30 分鐘，請重新選擇。');
    }
  }

  if (
    timingType ===
    UBEE_ORDER_TIMING_TYPES.FLEXIBLE
  ) {
    const startMs =
      getScheduleTimestampMs(
        data.flexibleStartAtMs
      );

    const endMs =
      getScheduleTimestampMs(
        data.flexibleEndAtMs
      );

    if (!startMs || !endMs) {
      errors.push('請完整選擇彈性預約的開始與結束時間。');
    } else if (startMs < minimumFutureMs) {
      errors.push('彈性預約開始時間至少需要晚於現在 30 分鐘。');
    } else if (endMs <= startMs) {
      errors.push('彈性預約結束時間必須晚於開始時間。');
    } else if (endMs - startMs > 12 * 60 * 60 * 1000) {
      errors.push('單一彈性預約時段最長為 12 小時，請縮短時間範圍。');
    }
  }

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
    String(data.orderTimingType || 'immediate'),
    String(data.requestedScheduleAtMs || ''),
    String(data.flexibleStartAtMs || ''),
    String(data.flexibleEndAtMs || ''),
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
      '你尚未通過 UBee 跑腿騎士審核，暫時無法接單。\n\n請先完成審核流程後，再開始接收任務。'
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
    await replyText(replyToken, '找不到此新版小U申請資料，請確認申請編號是否正確。');
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
  const etaPayload = getEtaPayloadByStatus(status);
  const now = admin.firestore.FieldValue.serverTimestamp();

  const normalExtra = {};
  const statusTimesExtra = {};

  Object.entries(extra || {}).forEach(([key, value]) => {
    if (key.startsWith('statusTimes.')) {
      const statusKey = key.split('.').slice(1).join('.');
      if (statusKey) {
        statusTimesExtra[statusKey] = value;
      }
    } else {
      normalExtra[key] = value;
    }
  });

  const currentStatusTimes =
    order.statusTimes && typeof order.statusTimes === 'object'
      ? order.statusTimes
      : {};

  const updatePayload = {
    ...normalExtra,
    ...etaPayload,
    status,
    riderStatus: status,
    customerTrackingStatus: status,
    customerTrackingStatusLabel: getStatusLabel(status),
    customerTrackingUpdatedAtMs: Date.now(),
    customerTrackingUpdatedAt: now,
    updatedAt: now,
    statusTimes: {
      ...currentStatusTimes,
      ...statusTimesExtra,
      [status]: statusTimesExtra[status] || now,
    },
  };

  Object.assign(order, updatePayload);

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
    `你的訂單已由 UBee 跑腿客服取消。\n\n` +
    `訂單編號：${order.id}\n` +
    `如有付款或退款問題，請聯繫 UBee 跑腿客服。`
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
  `&language=zh-TW&units=metric&key=${GOOGLE_MAPS_SERVER_API_KEY}`;
  
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

function calculateDistanceTierFee(distanceKm) {
  const km = Number(distanceKm) || 0;

  if (km <= 0) return 0;
  if (km <= 3) return 80;
  if (km <= 5) return 100;
  if (km <= 8) return 130;

  const extraKm = Math.ceil(km - 8);
  return 130 + extraKm * 15;
}

// ==============================
// UBee 唯一財務計算核心
// ==============================
// 正式規則：
// 1. 任務費本體參與 70 / 30 分潤
// 2. 平台服務費 100% 歸 UBee
// 3. 代墊款不屬於平台收入，也不屬於騎士收入
//
// 任務費本體：
// 配送費 + 急件費 + 樓層費 + 等候費
//
// 騎士收入：
// 任務費本體 × 70%
//
// 平台收入：
// 任務費本體剩餘 30% + 完整平台服務費
function calculateFinancialSplit({
  deliveryFee = 0,
  serviceFee = 0,
  speedFee = 0,
  upstairsFee = 0,
  waitingFee = 0,
} = {}) {
  const safeDeliveryFee = Math.max(
    0,
    Math.round(Number(deliveryFee || 0))
  );

  const safeServiceFee = Math.max(
    0,
    Math.round(Number(serviceFee || 0))
  );

  const safeSpeedFee = Math.max(
    0,
    Math.round(Number(speedFee || 0))
  );

  const safeUpstairsFee = Math.max(
    0,
    Math.round(Number(upstairsFee || 0))
  );

  const safeWaitingFee = Math.max(
    0,
    Math.round(Number(waitingFee || 0))
  );

  // 任務費本體：
  // 這部分才參與騎士 70% / 平台 30%
  const taskSubtotal =
    safeDeliveryFee +
    safeSpeedFee +
    safeUpstairsFee +
    safeWaitingFee;

  // 平台服務費 100% 歸 UBee
  const platformServiceFee = safeServiceFee;

  // 服務總額，不含代墊款
  const serviceSubtotal =
    taskSubtotal +
    platformServiceFee;

  // 騎士只從任務費本體取得 70%
  const driverFee = Math.round(
    taskSubtotal * Number(PRICING.driverRatio || 0.7)
  );

  // 平台收入：
  // 任務費剩餘部分 + 完整平台服務費
  const platformFee = Math.max(
    0,
    serviceSubtotal - driverFee
  );

  return {
    deliveryFee: safeDeliveryFee,
    serviceFee: safeServiceFee,
    platformServiceFee,

    speedFee: safeSpeedFee,
    upstairsFee: safeUpstairsFee,
    waitingFee: safeWaitingFee,

    taskSubtotal,
    serviceSubtotal,

    driverFee,
    riderFee: driverFee,

    platformFee,
    platformIncome: platformFee,
  };
}

// =====================================================
// 僅辨識「幫我取 / 幫代買」兩種專用計價服務
// 其他任何服務一律回傳空字串，繼續走原本 calculatePrice()。
// =====================================================
function getQuickServicePricingType({
  serviceKey = '',
  serviceGroup = '',
  serviceType = '',
} = {}) {
  const values = [
    serviceKey,
    serviceGroup,
    serviceType,
  ]
    .map(value =>
      String(value || '')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);

  const isPickup = values.some(value =>
    value === 'pickup' ||
    value === '幫我取'
  );

  if (isPickup) {
    return 'pickup';
  }

  const isBuy = values.some(value =>
    value === 'buy' ||
    value === '幫代買' ||
    value === '幫我買'
  );

  if (isBuy) {
    return 'buy';
  }

  return '';
}

// =====================================================
// UBee「幫我取 / 幫代買」專用計價
//
// 幫我取：
// - 0～3 km：$65
// - 3～5 km：$75
// - 5～8 km：$95
// - 超過 8 km：每公里 +$12
//
// 幫代買：
// - 0～3 km：$70
// - 3～5 km：$85
// - 5～8 km：$105
// - 超過 8 km：每公里 +$12
//
// 兩者：
// - 平台服務費 $10
// - 不收導航時間費
// - 急件費、上樓費與 70/30 分潤全部沿用原本邏輯
// =====================================================
function calculateQuickServicePrice({
  distanceMeters,
  speedType,
  upstairsFee = 0,
  serviceType = '',
}) {
  const km =
    Math.max(
      0,
      Number(distanceMeters || 0)
    ) / 1000;

  const pricing =
    QUICK_SERVICE_PRICING[serviceType];

  if (!pricing) {
    throw new Error(
      `不支援的快速服務計價類型：${serviceType}`
    );
  }

  const speed = getSpeedOption(speedType);

  const baseFee = Math.max(
    0,
    Math.round(Number(pricing.baseFee || 0))
  );

  let distanceFee = 0;

  if (km > 3 && km <= 5) {
    distanceFee =
      Number(pricing.upTo5KmExtra || 0);

  } else if (km > 5 && km <= 8) {
    distanceFee =
      Number(pricing.upTo8KmExtra || 0);

  } else if (km > 8) {
    const extraKm = Math.ceil(km - 8);

    distanceFee =
      Number(pricing.upTo8KmExtra || 0) +
      extraKm *
        Number(pricing.extraPerKm || 0);
  }

  distanceFee = Math.max(
    0,
    Math.round(distanceFee)
  );

  // 「幫我取 / 幫代買」不使用原本每分鐘 $2 的導航時間費。
  const timeFee = 0;

  const deliveryFee =
    baseFee +
    distanceFee;

  const serviceFee = Math.max(
    0,
    Math.round(Number(pricing.serviceFee || 0))
  );

  // 急件速度費維持原本 SPEED_OPTIONS。
  const speedFee = Math.max(
    0,
    Math.round(Number(speed.fee || 0))
  );

  // 上樓費維持原本前端傳入金額與既有分潤方式。
  const safeUpstairsFee = Math.max(
    0,
    Math.round(Number(upstairsFee || 0))
  );

  // 沿用 UBee 唯一財務核心：任務費 70/30、平台服務費 100% 歸平台。
  const financials = calculateFinancialSplit({
    deliveryFee,
    serviceFee,
    speedFee,
    upstairsFee: safeUpstairsFee,
    waitingFee: 0,
  });

  return {
    fareMode: `quick_${serviceType}`,

    distanceKm: Math.round(km * 100) / 100,
    durationMinutes: 0,

    baseFee,
    distanceFee,
    timeFee,

    ...financials,

    // 此階段尚未加入代墊款。
    total: financials.serviceSubtotal,
  };
}

function calculatePrice({
  distanceMeters,
  durationSeconds,
  speedType,
  upstairsFee = 0
}) {
  const km = Number(distanceMeters || 0) / 1000;
  const minutes = Number(durationSeconds || 0) / 60;

  const speed = getSpeedOption(speedType);

  const baseFee = Math.max(
    0,
    Math.round(Number(PRICING.baseFee || 0))
  );

  const distanceFee = Math.max(
    0,
    Math.round(
      km * Number(PRICING.perKm || 0)
    )
  );

  const timeFee = Math.max(
    0,
    Math.round(
      minutes * Number(PRICING.perMinute || 0)
    )
  );

  const deliveryFee =
    baseFee +
    distanceFee +
    timeFee;

  const serviceFee = Math.max(
    0,
    Math.round(Number(PRICING.serviceFee || 0))
  );

  const speedFee = Math.max(
    0,
    Math.round(Number(speed.fee || 0))
  );

  const safeUpstairsFee = Math.max(
    0,
    Math.round(Number(upstairsFee || 0))
  );

  const financials = calculateFinancialSplit({
    deliveryFee,
    serviceFee,
    speedFee,
    upstairsFee: safeUpstairsFee,
    waitingFee: 0,
  });

  return {
    fareMode: 'base_km_minute',

    distanceKm: Math.round(km * 100) / 100,
    durationMinutes: Math.round(minutes),

    baseFee,
    distanceFee,
    timeFee,

    ...financials,

    // 此階段尚未加入代墊款
    total: financials.serviceSubtotal,
  };
}

function recalculateOrderFinancials(order) {
  if (!order) {
    return order;
  }

  const financials = calculateFinancialSplit({
    deliveryFee: order.deliveryFee,
    serviceFee: order.serviceFee,
    speedFee: order.speedFee,
    upstairsFee: order.upstairsFee,
    waitingFee: order.waitingFee,
  });

  const advancePayment = getOrderAdvancePaymentAmount(order);

  const customerPayableTotal =
    financials.serviceSubtotal +
    advancePayment;

  // 基本費用欄位
  order.deliveryFee = financials.deliveryFee;
  order.serviceFee = financials.serviceFee;
  order.speedFee = financials.speedFee;
  order.upstairsFee = financials.upstairsFee;
  order.waitingFee = financials.waitingFee;

  // 財務拆解
  order.taskSubtotal = financials.taskSubtotal;

  order.platformServiceFee =
    financials.platformServiceFee;

  order.serviceSubtotal =
    financials.serviceSubtotal;

  order.serviceTotal =
    financials.serviceSubtotal;

  // 騎士收入
  order.driverFee =
    financials.driverFee;

  order.riderFee =
    financials.riderFee;

  // 平台收入
  order.platformFee =
    financials.platformFee;

  order.platformIncome =
    financials.platformIncome;

  // 代墊款
  order.advancePayment = advancePayment;
  order.advanceAmount = advancePayment;

  // 客人實際應付
  order.customerPayableTotal =
    customerPayableTotal;

  order.payableTotal =
    customerPayableTotal;

  order.riderDisplayTotal =
    customerPayableTotal;

  order.total =
    customerPayableTotal;

  order.finalTotal =
    customerPayableTotal;

  order.customerTotalWithAdvance =
    customerPayableTotal;

  // ==============================
  // 現金單財務同步
  // ==============================
  const paymentMethod =
    getOrderPaymentMethod(order);

  const isCashOrder =
    order.isCashOrder === true ||
    paymentMethod === 'cash' ||
    paymentMethod.includes('cash') ||
    paymentMethod.includes('現金');

  if (isCashOrder) {
    // 客人最後實際要交給騎士的現金總額
    order.cashCollectAmount =
      customerPayableTotal;

    // 現金單服務金額，不包含代墊
    order.cashServiceNet =
      financials.serviceSubtotal;

    // 騎士收到現金後，需要回繳 UBee 的金額
    const cashDueToPlatform = Math.max(
      0,
      financials.serviceSubtotal -
      financials.driverFee
    );

    order.cashDueToPlatform =
      cashDueToPlatform;

    order.platformReceivable =
      cashDueToPlatform;

    order.riderDueToPlatform =
      cashDueToPlatform;
  }
  
  return order;
}

function createMainMenuFlex() {
  return createFlexMessage('UBee 跑腿主選單', createBubble(
    'UBee 跑腿主選單',
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
      createInfoRow(
        '證件資料',
        rider.documentsComplete === true
          ? '5 項已上傳，待管理端審核'
          : '尚未完整'
      ),
      createInfoRow(
        '強制險到期',
        rider.compulsoryInsuranceExpiryDate || '-'
      ),
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
    footerButtons.push(createActionButton(`申請等候費 $${PRICING.waitingFee}`, `requestWaitingFee=${order.id}`));
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
  const total = Math.round(Number(
    order.customerPayableTotal ||
    order.payableTotal ||
    order.total ||
    0
  ));

  return createFlexMessage('現金單資訊', createBubble(
    '現金單資訊',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('付款方式', '現金付款'),
      createInfoRow('預計收取金額', formatCurrency(total)),
      { type: 'separator', margin: 'md' },
      {
        type: 'text',
        text: '目前 UBee 跑腿先開放現金單，任務完成時由騎士向客人收取現金。',
        size: 'sm',
        color: '#111111',
        wrap: true
      },
      {
        type: 'text',
        text: '確認現金單後，系統才會開始媒合騎士。',
        size: 'sm',
        color: '#666666',
        wrap: true
      },
    ]
  ));
}

function createWaitingFeeConfirmFlex(order) {
  return createFlexMessage('等候費確認', createBubble(
    '等候費確認',
    [
      createInfoRow('訂單編號', order.id),
      createInfoRow('申請金額', formatCurrency(PRICING.waitingFee)),
      {
        type: 'text',
        text: `騎士已抵達現場並等候超過 3–5 分鐘，將申請等候費 NT$${PRICING.waitingFee}。請問是否同意加收？`,
        size: 'sm',
        color: '#333333',
        wrap: true
      },
    ],
    [
      createActionButton(`同意加收 $${PRICING.waitingFee}`, `waitingApprove=${order.id}`),
      createActionButton('不同意加收', `waitingReject=${order.id}`, 'secondary'),
    ]
  ));
}

function createFinanceFlex(order) {
  const total = Math.round(Number(
    order.customerPayableTotal ||
    order.payableTotal ||
    order.total ||
    0
  ));

  const driver = Math.round(Number(
    order.driverFee ||
    order.riderFee ||
    order.fee ||
    0
  ));

  const platform = Math.round(Number(
    order.platformFee ||
    order.platformIncome ||
    Math.max(0, Number(order.serviceSubtotal || order.serviceTotal || 0) - driver) ||
    0
  ));

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

// ==============================
// UBee 地圖與 Routes API 工具
// ==============================

function getNullableCoordinate(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const text = String(value).trim();

  if (!text) {
    return null;
  }

  const number = Number(text);

  return Number.isFinite(number)
    ? number
    : null;
}

function isValidLatitude(value) {
  const number = getNullableCoordinate(value);

  return (
    number !== null &&
    number >= -90 &&
    number <= 90
  );
}

function isValidLongitude(value) {
  const number = getNullableCoordinate(value);

  return (
    number !== null &&
    number >= -180 &&
    number <= 180
  );
}

function buildRoutesWaypoint({
  address,
  placeId,
  lat,
  lng,
} = {}) {
  const safePlaceId = cleanText(
    placeId || '',
    200
  );

  // 第一優先：
  // Place ID 最精準，未來地址選擇器取得 Place ID 後直接使用。
  if (safePlaceId) {
    return {
      placeId: safePlaceId,
    };
  }

  // 第二優先：
  // 已有經緯度就直接使用。
  if (
    isValidLatitude(lat) &&
    isValidLongitude(lng)
  ) {
    return {
      location: {
        latLng: {
          latitude: Number(lat),
          longitude: Number(lng),
        },
      },
    };
  }

  // 第三優先：
  // 使用地址字串，由 Routes API 進行路線用地址解析。
  const safeAddress =
    normalizeTaskAddressForMaps(address);

  if (safeAddress) {
    return {
      address: safeAddress,
    };
  }

  return null;
}

function parseGoogleDurationSeconds(value) {
  const text = String(value || '')
    .trim()
    .replace(/s$/i, '');

  const seconds = Number(text);

  return Number.isFinite(seconds)
    ? Math.max(0, Math.round(seconds))
    : 0;
}

function formatRouteDistanceText(distanceMeters) {
  const meters = Math.max(
    0,
    Math.round(Number(distanceMeters || 0))
  );

  if (meters <= 0) {
    return '-';
  }

  if (meters < 1000) {
    return `${meters} 公尺`;
  }

  const km = meters / 1000;

  return `${km.toFixed(1)} 公里`;
}

function formatRouteDurationText(durationSeconds) {
  const seconds = Math.max(
    0,
    Math.round(Number(durationSeconds || 0))
  );

  if (seconds <= 0) {
    return '-';
  }

  const minutes = Math.max(
    1,
    Math.round(seconds / 60)
  );

  if (minutes < 60) {
    return `${minutes} 分鐘`;
  }

  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;

  if (remainMinutes <= 0) {
    return `${hours} 小時`;
  }

  return `${hours} 小時 ${remainMinutes} 分鐘`;
}

function createOrderFromApi(data) {
  const userId = cleanText(
    data.userId || data.customerId || '',
    80
  );

  const rawServiceGroup = cleanText(
    data.serviceGroup || '',
    ORDER_INPUT_LIMITS.serviceGroup
  );

  const serviceKey = cleanText(
    data.serviceKey || rawServiceGroup || '',
    40
  );

  const serviceGroupMap = {
    send: '幫我送',
    pickup: '幫我取',
    buy: '幫代買',
    queue: '幫排隊',
    helper: '全能跑腿',
    urgent: '急件專送',

    life:
      serviceKey === 'urgent'
        ? '急件專送'
        : serviceKey === 'helper'
          ? '全能跑腿'
          : '生活跑腿',
  };

  const serviceGroupLabel =
    serviceGroupMap[rawServiceGroup] ||
    rawServiceGroup ||
    '';

  const nearbyPlace =
    data.nearbyPlace &&
    typeof data.nearbyPlace === 'object'
      ? {
          name: cleanText(
            data.nearbyPlace.name || '',
            80
          ),

          address: cleanText(
            data.nearbyPlace.address || '',
            120
          ),

          placeId: cleanText(
            data.nearbyPlace.placeId || '',
            200
          ),

          phone: normalizePhone(
            cleanText(
              data.nearbyPlace.phone || '',
              30
            )
          ),

          lat: getNullableCoordinate(
            data.nearbyPlace.lat
          ),

          lng: getNullableCoordinate(
            data.nearbyPlace.lng
          ),
        }
      : null;

  const merchantId = cleanText(
    data.merchantId ||
    data.merchantCode ||
    '',
    80
  );

  const merchantName = cleanText(
    data.merchantName || '',
    80
  );

  const merchantPhone = normalizePhone(
    cleanText(
      data.merchantPhone || '',
      30
    )
  );

  const merchantAddress = cleanText(
    data.merchantAddress || '',
    120
  );

  const rawNote = cleanLongText(
    data.note ||
    data.item ||
    '',
    ORDER_INPUT_LIMITS.note
  );

  const rawItem = cleanText(
    data.item ||
    rawNote ||
    data.serviceType ||
    'UBee 跑腿任務',
    ORDER_INPUT_LIMITS.item
  );

  const pickupLat =
    getNullableCoordinate(data.pickupLat);

  const pickupLng =
    getNullableCoordinate(data.pickupLng);

  const dropoffLat =
    getNullableCoordinate(data.dropoffLat);

  const dropoffLng =
    getNullableCoordinate(data.dropoffLng);

  return {
    userId,
    customerId: userId,

    serviceGroup: serviceGroupLabel,

    serviceType: cleanText(
      data.serviceType || '',
      40
    ),

    serviceCategory: cleanText(
      data.serviceCategory || '',
      60
    ),

    serviceMode: cleanText(
      data.serviceMode || 'normal',
      30
    ),

    serviceKey,

    queueMinutes: Math.max(
      0,
      Math.round(
        Number(data.queueMinutes || 0)
      )
    ),

    item: rawItem,

    pickupAddress: cleanText(
      data.pickup ||
      data.pickupAddress ||
      '',
      ORDER_INPUT_LIMITS.pickupAddress
    ),

    pickupPhone: normalizePhone(
      cleanText(
        data.pickupPhone || '',
        ORDER_INPUT_LIMITS.pickupPhone
      )
    ),

    pickupLat:
      isValidLatitude(pickupLat)
        ? pickupLat
        : null,

    pickupLng:
      isValidLongitude(pickupLng)
        ? pickupLng
        : null,

    pickupPlaceId: cleanText(
      data.pickupPlaceId || '',
      200
    ),

    dropoffAddress: cleanText(
      data.dropoff ||
      data.dropoffAddress ||
      '',
      ORDER_INPUT_LIMITS.dropoffAddress
    ),

    dropoffPhone: normalizePhone(
      cleanText(
        data.dropoffPhone || '',
        ORDER_INPUT_LIMITS.dropoffPhone
      )
    ),

    dropoffLat:
      isValidLatitude(dropoffLat)
        ? dropoffLat
        : null,

    dropoffLng:
      isValidLongitude(dropoffLng)
        ? dropoffLng
        : null,

    dropoffPlaceId: cleanText(
      data.dropoffPlaceId || '',
      200
    ),

    speedType: [
      'standard',
      'priority',
      'express'
    ].includes(
      data.speedType || data.speed
    )
      ? (
          data.speedType ||
          data.speed
        )
      : 'standard',

    // UBee 任務時間模式：立即／指定時間／彈性時段
    orderTimingType:
      normalizeOrderTimingType(
        data.orderTimingType ||
        data.timingType ||
        data.fulfillmentTiming
      ),

    scheduleGoal:
      String(
        data.scheduleGoal ||
        'pickup_at'
      )
        .trim()
        .toLowerCase() === 'complete_by'
          ? 'complete_by'
          : 'pickup_at',

    requestedScheduleAtMs:
      getScheduleTimestampMs(
        data.requestedScheduleAtMs ||
        data.scheduledAtMs ||
        data.scheduledAt
      ),

    flexibleStartAtMs:
      getScheduleTimestampMs(
        data.flexibleStartAtMs ||
        data.scheduleWindowStartAtMs
      ),

    flexibleEndAtMs:
      getScheduleTimestampMs(
        data.flexibleEndAtMs ||
        data.scheduleWindowEndAtMs
      ),

    note: rawNote,

    advancePayment:
      parseNonNegativeMoney(
        data.advancePayment
      ),

    upstairsOption: cleanText(
      data.upstairsOption || 'none',
      30
    ),

    upstairsLabel: cleanText(
      data.upstairsLabel || '',
      80
    ),

    upstairsFee: Math.max(
      0,
      Math.round(
        Number(data.upstairsFee || 0)
      )
    ),

    fareMode: cleanText(
      data.fareMode ||
      'base_km_minute',
      40
    ),

    nearbyPlace,

    merchantId,
    merchantCode: merchantId,
    merchantName,
    merchantPhone,
    merchantAddress,

    hasMerchant:
      data.hasMerchant === true ||
      !!merchantId ||
      !!merchantName,
  };
}
// =====================================================
// 客戶端安全服務狀態 API
//
// 僅回傳匿名資訊：
// - 已審核且已按下上線的小U總數
// - 其中定位仍新鮮、可顯示於地圖的小U數量
// - 經 50～80 公尺穩定偏移後的匿名地圖位置
// - 統計更新時間與定位新鮮度門檻
//
// 絕不回傳姓名、電話、LINE ID、riderId、Firestore 文件 ID、
// 真實座標或任何可讓客戶辨識特定小U的固定公開識別碼。
// =====================================================
const CUSTOMER_RIDER_LOCATION_FRESH_MS = 5 * 60 * 1000;
const CUSTOMER_RIDER_PUBLIC_ONLINE_MS = 30 * 60 * 1000;
const CUSTOMER_RIDER_OFFSET_MIN_METERS = 50;
const CUSTOMER_RIDER_OFFSET_MAX_METERS = 80;
const CUSTOMER_RIDER_OFFSET_BUCKET_MS = 15 * 60 * 1000;
const CUSTOMER_RIDER_MAX_MARKERS = 80;

function getCustomerRiderMapSecret() {
  return String(
    process.env.CUSTOMER_RIDER_MAP_SECRET ||
    process.env.CHANNEL_SECRET ||
    process.env.FIREBASE_PROJECT_ID ||
    'ubee-customer-rider-map'
  );
}

function buildStableAnonymousRiderOffset(riderDocId, nowMs = Date.now()) {
  const bucket = Math.floor(nowMs / CUSTOMER_RIDER_OFFSET_BUCKET_MS);
  const digest = crypto
    .createHmac('sha256', getCustomerRiderMapSecret())
    .update(`${String(riderDocId || '')}:${bucket}`)
    .digest();

  const distanceRatio = digest.readUInt32BE(0) / 0xffffffff;
  const angleRatio = digest.readUInt32BE(4) / 0xffffffff;

  return {
    distanceMeters:
      CUSTOMER_RIDER_OFFSET_MIN_METERS +
      distanceRatio *
        (CUSTOMER_RIDER_OFFSET_MAX_METERS - CUSTOMER_RIDER_OFFSET_MIN_METERS),
    angleRadians: angleRatio * Math.PI * 2,
  };
}

function offsetCustomerRiderPoint(point, riderDocId, nowMs = Date.now()) {
  if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) {
    return null;
  }

  const sourceLat = Number(point.lat);
  const sourceLng = Number(point.lng);
  const { distanceMeters, angleRadians } =
    buildStableAnonymousRiderOffset(riderDocId, nowMs);

  const latitudeRadians = sourceLat * Math.PI / 180;
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLng = Math.max(
    1000,
    111320 * Math.cos(latitudeRadians)
  );

  const latOffset =
    Math.cos(angleRadians) * distanceMeters / metersPerDegreeLat;
  const lngOffset =
    Math.sin(angleRadians) * distanceMeters / metersPerDegreeLng;

  return {
    lat: Number((sourceLat + latOffset).toFixed(6)),
    lng: Number((sourceLng + lngOffset).toFixed(6)),
    label: '附近有小U',
  };
}


app.get('/api/customer/service-status', async (req, res) => {
  try {
    const nowMs = Date.now();

    const pickupLat =
      getNullableCoordinate(
        req.query.pickupLat ||
        req.query.lat
      );

    const pickupLng =
      getNullableCoordinate(
        req.query.pickupLng ||
        req.query.lng
      );

    const hasPickupPoint =
      isValidLatitude(pickupLat) &&
      isValidLongitude(pickupLng);

    const ridersSnap = await db
      .collection('riders')
      .limit(500)
      .get();

    let declaredOnlineRiderCount = 0;
    let onlineRiderCount = 0;
    let mapRiderCount = 0;
    let nearbyRiderCount3km = 0;
    let nearbyRiderCount5km = 0;
    let nearbyRiderCount10km = 0;
    let nearestRiderDistanceKm = null;
    const nearbyRiders = [];

    ridersSnap.forEach((riderDoc) => {
      const rider = riderDoc.data() || {};
      const approved =
        rider.approved === true ||
        String(rider.status || '').trim().toLowerCase() === 'approved';
      const online = rider.online === true;

      // Firestore 裡 online=true 只代表小U曾主動按下上線。
      // 先保留這個原始數字供內部診斷，但不直接公開給客人端。
      if (!approved || !online) {
        return;
      }

      declaredOnlineRiderCount += 1;

      const point = getRiderCurrentPointForPush(rider);
      const lastLocationAtMs =
        getDispatchPushTimeMs(rider.locationUpdatedAtMs) ||
        getDispatchPushTimeMs(rider.locationUpdatedAt) ||
        getDispatchPushTimeMs(rider.currentLocation?.updatedAt);

      const locationAgeMs = lastLocationAtMs
        ? nowMs - lastLocationAtMs
        : Number.POSITIVE_INFINITY;

      const publicOnline =
        !!point &&
        Number.isFinite(locationAgeMs) &&
        locationAgeMs >= 0 &&
        locationAgeMs <= CUSTOMER_RIDER_PUBLIC_ONLINE_MS;

      // 超過 30 分鐘沒有定位更新，客人端公開狀態視為離線。
      if (!publicOnline) {
        return;
      }

      onlineRiderCount += 1;

      const fresh =
        locationAgeMs <= CUSTOMER_RIDER_LOCATION_FRESH_MS;

      // 5 分鐘內有定位才顯示匿名 U 圖案並納入即時媒合。
      if (!fresh) {
        return;
      }

      mapRiderCount += 1;

      if (hasPickupPoint) {
        const distanceKm =
          calcDispatchPushDistanceKm(
            pickupLat,
            pickupLng,
            point.lat,
            point.lng
          );

        if (Number.isFinite(distanceKm)) {
          if (
            nearestRiderDistanceKm === null ||
            distanceKm <
              nearestRiderDistanceKm
          ) {
            nearestRiderDistanceKm =
              distanceKm;
          }

          if (distanceKm <= 3) {
            nearbyRiderCount3km += 1;
          }

          if (distanceKm <= 5) {
            nearbyRiderCount5km += 1;
          }

          if (distanceKm <= 10) {
            nearbyRiderCount10km += 1;
          }
        }
      }

      if (nearbyRiders.length >= CUSTOMER_RIDER_MAX_MARKERS) {
        return;
      }

      const anonymousPoint = offsetCustomerRiderPoint(
        point,
        riderDoc.id,
        nowMs
      );

      if (anonymousPoint) {
        nearbyRiders.push(anonymousPoint);
      }
    });

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.json({
      success: true,
      declaredOnlineRiderCount,
      onlineRiderCount,
      mapRiderCount,
      nearbyRiders,

      pickupMatch:
        hasPickupPoint
          ? {
              pickupLat,
              pickupLng,
              nearbyRiderCount3km,
              nearbyRiderCount5km,
              nearbyRiderCount10km,
              nearestRiderDistanceKm:
                nearestRiderDistanceKm === null
                  ? null
                  : Number(
                      nearestRiderDistanceKm
                        .toFixed(2)
                    ),
              matchLevel:
                nearbyRiderCount3km >= 3
                  ? 'good'
                  : nearbyRiderCount5km > 0
                    ? 'limited'
                    : mapRiderCount > 0
                      ? 'expand_required'
                      : 'none',
            }
          : null,

      updatedAt: new Date(nowMs).toISOString(),
      locationFreshSeconds: Math.floor(
        CUSTOMER_RIDER_LOCATION_FRESH_MS / 1000
      ),
      publicOnlineFreshSeconds: Math.floor(
        CUSTOMER_RIDER_PUBLIC_ONLINE_MS / 1000
      ),
      locationPrivacy: {
        mode: 'stable_offset',
        minOffsetMeters: CUSTOMER_RIDER_OFFSET_MIN_METERS,
        maxOffsetMeters: CUSTOMER_RIDER_OFFSET_MAX_METERS,
        refreshMinutes: Math.floor(
          CUSTOMER_RIDER_OFFSET_BUCKET_MS / 60000
        ),
      },
      scope: 'public_online_riders_and_realtime_matchable_locations',
    });
  } catch (error) {
    console.error('❌ 客戶端服務狀態 API 讀取失敗：', error);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.status(503).json({
      success: false,
      code: 'SERVICE_STATUS_UNAVAILABLE',
      message: '即時服務狀態暫時無法取得。',
      updatedAt: new Date().toISOString(),
    });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    success: true,

    liffId: LIFF_ID,
    riderLiffId: RIDER_LIFF_ID,

    businessFormUrl: BUSINESS_FORM_URL,
    partnerFormUrl: PARTNER_FORM_URL,

    // 瀏覽器端 Maps JavaScript API Key
    googleMapsApiKey: GOOGLE_MAPS_API_KEY,

    // 可選的正式 Map ID
    googleMapsMapId: GOOGLE_MAPS_MAP_ID,
  });
});

app.get('/api/nearby-places', async (req, res) => {
  try {
    const lat = req.query.lat;
    const lng = req.query.lng;
    const keyword = req.query.keyword || '餐廳';
    const radius = Math.min(Number(req.query.radius || 2000), 3000);

    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        error: '缺少定位資料'
      });
    }

    function fetchJsonWithTimeout(url, ms = 7000) {
      return Promise.race([
        fetch(url).then(r => r.json()),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Google Places request timeout')), ms);
        })
      ]);
    }

    const url =
      'https://maps.googleapis.com/maps/api/place/nearbysearch/json?' +
      new URLSearchParams({
        location: `${lat},${lng}`,
        radius: String(radius),
        keyword: String(keyword),
        language: 'zh-TW',
        key: GOOGLE_MAPS_SERVER_API_KEY
      }).toString();

    const data = await fetchJsonWithTimeout(url, 7000);

    if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error('Google Nearby Search error:', data.status, data.error_message || '');

      return res.status(502).json({
        success: false,
        error: data.error_message || `Google Places error: ${data.status}`
      });
    }

    const basePlaces = (data.results || []).slice(0, 6).map(place => ({
      name: place.name || '',
      address: place.vicinity || '',
      placeId: place.place_id || '',
      lat: place.geometry?.location?.lat || '',
      lng: place.geometry?.location?.lng || '',
      rating: place.rating || '',
      userRatingsTotal: place.user_ratings_total || '',
      phone: ''
    }));

    const places = await Promise.all(basePlaces.map(async place => {
      if (!place.placeId) return place;

      try {
        const detailUrl =
          'https://maps.googleapis.com/maps/api/place/details/json?' +
          new URLSearchParams({
            place_id: place.placeId,
            fields: 'formatted_phone_number,international_phone_number',
            language: 'zh-TW',
            key: GOOGLE_MAPS_SERVER_API_KEY
          }).toString();

        const detailData = await fetchJsonWithTimeout(detailUrl, 2500);

        return {
          ...place,
          phone:
            detailData.result?.formatted_phone_number ||
            detailData.result?.international_phone_number ||
            ''
        };
      } catch (e) {
        console.warn('place detail phone timeout or error:', e.message);
        return place;
      }
    }));

    return res.json({
      success: true,
      places
    });

  } catch (err) {
    console.error('nearby places error:', err);

    return res.status(500).json({
      success: false,
      error: err.message || '附近地點搜尋失敗'
    });
  }
});

// ==============================
// UBee 客戶端地圖真實路線 API
//
// 功能：
// 1. 取得真正道路路線
// 2. 回傳 encoded polyline
// 3. 回傳取件 / 送達實際路線座標
// 4. 回傳 Place ID
//
// 注意：
// 此 API 只負責地圖顯示。
// 正式金額仍然全部由 /api/quote 計算。
// ==============================
app.post('/api/map-route', async (req, res) => {
  try {
    const body = req.body || {};

    const originWaypoint =
      buildRoutesWaypoint({
        address:
          body.originAddress ||
          body.pickupAddress ||
          body.origin ||
          body.pickup ||
          '',

        placeId:
          body.originPlaceId ||
          body.pickupPlaceId ||
          '',

        lat:
          body.originLat ??
          body.pickupLat,

        lng:
          body.originLng ??
          body.pickupLng,
      });

    const destinationWaypoint =
      buildRoutesWaypoint({
        address:
          body.destinationAddress ||
          body.dropoffAddress ||
          body.destination ||
          body.dropoff ||
          '',

        placeId:
          body.destinationPlaceId ||
          body.dropoffPlaceId ||
          '',

        lat:
          body.destinationLat ??
          body.dropoffLat,

        lng:
          body.destinationLng ??
          body.dropoffLng,
      });

    if (
      !originWaypoint ||
      !destinationWaypoint
    ) {
      return res.status(400).json({
        success: false,
        error:
          '請提供正確的取件地點與送達地點。',
      });
    }

    if (!GOOGLE_MAPS_SERVER_API_KEY) {
      return res.status(500).json({
        success: false,
        error:
          'GOOGLE_MAPS_SERVER_API_KEY 尚未設定。',
      });
    }

    const routesResponse = await fetch(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          'X-Goog-Api-Key':
            GOOGLE_MAPS_SERVER_API_KEY,

          'X-Goog-FieldMask': [
            'routes.distanceMeters',
            'routes.duration',

            'routes.polyline.encodedPolyline',

            'routes.legs.startLocation',
            'routes.legs.endLocation',

            'geocodingResults.origin.placeId',
            'geocodingResults.destination.placeId',
          ].join(','),
        },

        body: JSON.stringify({
          origin: originWaypoint,

          destination:
            destinationWaypoint,

          travelMode: 'DRIVE',

          // 與目前 Distance Matrix 正式估價邏輯保持接近，
          // 地圖本身不另外改變財務計算。
          routingPreference:
            'TRAFFIC_UNAWARE',

          computeAlternativeRoutes: false,

          routeModifiers: {
            avoidTolls: false,
            avoidHighways: false,
            avoidFerries: false,
          },

          languageCode: 'zh-TW',
          regionCode: 'tw',
          units: 'METRIC',

          polylineQuality:
            'HIGH_QUALITY',

          polylineEncoding:
            'ENCODED_POLYLINE',
        }),
      }
    );

    const routesData =
      await routesResponse
        .json()
        .catch(() => ({}));

    if (!routesResponse.ok) {
      console.error(
        '❌ Google Routes API 錯誤：',
        {
          status:
            routesResponse.status,

          data:
            routesData,
        }
      );

      return res.status(502).json({
        success: false,

        error:
          routesData?.error?.message ||
          'Google 路線取得失敗。',
      });
    }

    const route =
      routesData?.routes?.[0];

    if (!route) {
      return res.status(404).json({
        success: false,
        error:
          '找不到可使用的道路路線。',
      });
    }

    const distanceMeters =
      Math.max(
        0,
        Math.round(
          Number(
            route.distanceMeters || 0
          )
        )
      );

    const durationSeconds =
      parseGoogleDurationSeconds(
        route.duration
      );

    const encodedPolyline =
      String(
        route?.polyline
          ?.encodedPolyline ||
        ''
      );

    if (!encodedPolyline) {
      return res.status(502).json({
        success: false,
        error:
          'Google 路線沒有回傳可顯示的路線資料。',
      });
    }

    const firstLeg =
      route?.legs?.[0] || {};

    const startLatLng =
      firstLeg?.startLocation
        ?.latLng || {};

    const endLatLng =
      firstLeg?.endLocation
        ?.latLng || {};

    const originLat =
      getNullableCoordinate(
        startLatLng.latitude
      );

    const originLng =
      getNullableCoordinate(
        startLatLng.longitude
      );

    const destinationLat =
      getNullableCoordinate(
        endLatLng.latitude
      );

    const destinationLng =
      getNullableCoordinate(
        endLatLng.longitude
      );

    const originPlaceId =
      String(
        routesData
          ?.geocodingResults
          ?.origin
          ?.placeId ||
        body.originPlaceId ||
        body.pickupPlaceId ||
        ''
      );

    const destinationPlaceId =
      String(
        routesData
          ?.geocodingResults
          ?.destination
          ?.placeId ||
        body.destinationPlaceId ||
        body.dropoffPlaceId ||
        ''
      );

    return res.json({
      success: true,

      distanceMeters,

      distanceKm:
        Math.round(
          (
            distanceMeters /
            1000
          ) * 100
        ) / 100,

      distanceText:
        formatRouteDistanceText(
          distanceMeters
        ),

      durationSeconds,

      durationMinutes:
        Math.max(
          1,
          Math.round(
            durationSeconds / 60
          )
        ),

      durationText:
        formatRouteDurationText(
          durationSeconds
        ),

      encodedPolyline,

      originLocation: {
        lat: originLat,
        lng: originLng,
      },

      destinationLocation: {
        lat: destinationLat,
        lng: destinationLng,
      },

      routeStartLat:
  originLat,

routeStartLng:
  originLng,

routeEndLat:
  destinationLat,

routeEndLng:
  destinationLng,

      originPlaceId,
      destinationPlaceId,

      pickupPlaceId:
        originPlaceId,

      dropoffPlaceId:
        destinationPlaceId,
    });

  } catch (err) {
    console.error(
      '❌ /api/map-route 失敗：',
      err
    );

    return res.status(500).json({
      success: false,

      error:
        err.message ||
        '地圖路線取得失敗。',
    });
  }
});

app.get('/api/quote', async (req, res) => {
  try {
    const serviceType = String(req.query.serviceType || '').trim();
    const serviceMode = String(req.query.serviceMode || '').trim();
    const serviceKey = String(req.query.serviceKey || '').trim();
    const serviceGroup = String(req.query.serviceGroup || '').trim();

    const from = req.query.from || req.query.pickup;
    const to = req.query.to || req.query.dropoff;

    const speedType = req.query.speed || req.query.speedType || 'standard';
    const speed = getSpeedOption(speedType);

    const advancePayment = Math.max(
      0,
      Math.round(Number(req.query.advancePayment || 0))
    );

    const upstairsFee = Math.max(
      0,
      Math.round(Number(req.query.upstairsFee || 0))
    );

    const isQueueTask =
      serviceMode === 'queue' ||
      serviceType === '幫排隊';

    let distance = null;
    let price = null;
    let queueMinutes = 0;

    if (isQueueTask) {
  queueMinutes = Math.max(
    0,
    Math.round(Number(req.query.queueMinutes || 30))
  );

  if (queueMinutes <= 0) {
    return res.status(400).json({
      success: false,
      error: '請輸入正確的預估排隊時間'
    });
  }

  if (queueMinutes > PRICING.maxQuoteTimeMinutes) {
    return res.status(400).json({
      success: false,
      error: `排隊時間超過 ${PRICING.maxQuoteTimeMinutes} 分鐘，建議改由客服協助確認費用。`
    });
  }

  const queueTimeFee = Math.max(
    0,
    queueMinutes * PRICING.queuePerMinute
  );

  const longTaskExtraFee =
    queueMinutes > PRICING.queueLongTaskThresholdMinutes
      ? PRICING.queueLongTaskExtraFee
      : 0;

  const waitingFee =
    queueTimeFee +
    longTaskExtraFee;

  const serviceFee = Math.max(
    0,
    Math.round(Number(PRICING.serviceFee || 0))
  );

  const deliveryFee = Math.max(
    0,
    Math.round(Number(PRICING.queueBaseFee || 0))
  );

  const speedFee = Math.max(
    0,
    Math.round(Number(speed.fee || 0))
  );

  const financials = calculateFinancialSplit({
    deliveryFee,
    serviceFee,
    speedFee,
    upstairsFee,
    waitingFee,
  });

  price = {
    fareMode: 'queue',

    deliveryFee:
      financials.deliveryFee,

    serviceFee:
      financials.serviceFee,

    platformServiceFee:
      financials.platformServiceFee,

    speedFee:
      financials.speedFee,

    upstairsFee:
      financials.upstairsFee,

    waitingFee:
      financials.waitingFee,

    queueTimeFee,
    longTaskExtraFee,

    taskSubtotal:
      financials.taskSubtotal,

    serviceSubtotal:
      financials.serviceSubtotal,

    total:
      financials.serviceSubtotal,

    driverFee:
      financials.driverFee,

    riderFee:
      financials.riderFee,

    platformFee:
      financials.platformFee,

    platformIncome:
      financials.platformIncome,
  };
} else {
      if (!from || !to) {
        return res.status(400).json({
          success: false,
          error: '請輸入取件地址與送達地址'
        });
      }

      distance = await getDistanceMatrixCached(from, to);

      const quickServiceType =
        getQuickServicePricingType({
          serviceKey,
          serviceGroup,
          serviceType,
        });

      if (quickServiceType) {
        // 只有「幫我取 / 幫代買」走專用即時配送計價。
        price = calculateQuickServicePrice({
          distanceMeters: distance.distanceMeters,
          speedType,
          upstairsFee,
          serviceType: quickServiceType,
        });

      } else {
        // 其他所有服務完全維持原本計價邏輯。
        price = calculatePrice({
          distanceMeters: distance.distanceMeters,
          durationSeconds: distance.durationSeconds,
          speedType,
          upstairsFee,
        });
      }
    }

    const serviceSubtotal = Math.max(
      0,
      Math.round(Number(price.total || 0))
    );

    const customerPayableTotal = serviceSubtotal + advancePayment;

    return res.json({
      success: true,

      serviceType,
      serviceMode: isQueueTask ? 'queue' : 'normal',

      distanceText: isQueueTask ? '排隊任務' : distance.distanceText,
      durationText: isQueueTask ? `${queueMinutes} 分鐘內` : distance.durationText,
      distanceMeters: isQueueTask ? 0 : distance.distanceMeters,
      durationSeconds: isQueueTask ? 0 : distance.durationSeconds,

      queueMinutes,

      speedType,
      speedLabel: speed.label,

      ...price,

      serviceSubtotal,
      advancePayment,
      customerPayableTotal,
      payableTotal: customerPayableTotal,

      // 給快速估價頁直接顯示用
      total: customerPayableTotal,
    });
  } catch (error) {
    console.error('❌ API 估價失敗：', error);
    res.status(500).json({
      success: false,
      error: '估價失敗，請確認地址是否正確'
    });
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
      finalTotal: total,
      customerPayableTotal: total,

      merchantPayableAmount: total,
      storePayableAmount: total,
      totalFee: total,

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

// =====================================================
// UBee 店家平台 V3 API
// 下一版 merchant-dashboard.html 將改由這組 API 建單、更新與讀取。
// 舊 /api/merchant/order 暫時保留相容，不影響既有前端。
// =====================================================

function normalizeMerchantDeliveryStopsV3(payload = {}) {
  const rawStops = Array.isArray(payload.deliveryStops)
    ? payload.deliveryStops
    : [{
        customerName: payload.customerName || payload.receiverName || '',
        customerPhone: payload.customerPhone || payload.dropoffPhone || '',
        dropoffAddress: payload.dropoffAddress || payload.dropoff || '',
        itemName: payload.itemName || payload.item || '',
        note: payload.note || payload.customerNote || '',
      }];

  return rawStops
    .slice(0, 8)
    .map((stop, index) => ({
      index: index + 1,
      customerName: cleanText(
        stop.customerName || stop.receiverName || '',
        40
      ),
      customerPhone: normalizePhone(
        stop.customerPhone || stop.dropoffPhone || ''
      ),
      dropoffAddress: cleanText(
        stop.dropoffAddress || stop.dropoff || '',
        160
      ),
      itemName: cleanLongText(
        stop.itemName || stop.item || '',
        240
      ),
      note: cleanLongText(stop.note || '', 240),
    }))
    .filter(stop => stop.dropoffAddress);
}

function validateMerchantDeliveryStopsV3(stops = []) {
  if (!stops.length) return '請至少建立一個送達點。';

  for (const stop of stops) {
    if (!stop.customerName) return `第 ${stop.index} 點缺少收件人姓名。`;
    if (!/^09\d{8}$/.test(stop.customerPhone)) {
      return `第 ${stop.index} 點收件人手機格式不正確。`;
    }
    if (stop.dropoffAddress.length < 5) {
      return `第 ${stop.index} 點送達地址不完整。`;
    }
    if (!stop.itemName) return `第 ${stop.index} 點缺少配送品項。`;
  }

  return '';
}

function calculateMerchantDeliveryFeeV3(distanceKm, stopCount = 1) {
  const km = Number(distanceKm || 0);
  const stops = Math.max(1, Number(stopCount || 1));

  if (!Number.isFinite(km) || km <= 0) {
    throw new Error('配送距離結果異常。');
  }

  let baseFee = 220;

  if (km <= 5) baseFee = 70;
  else if (km <= 7) baseFee = 80;
  else if (km <= 9) baseFee = 90;
  else if (km <= 10) baseFee = 110;
  else if (km <= 12) baseFee = 130;
  else if (km <= 14) baseFee = 150;
  else if (km <= 16) baseFee = 170;
  else if (km <= 18) baseFee = 200;
  else if (km <= 20) baseFee = 220;
  else baseFee = 220 + Math.ceil(km - 20) * 12;

  const extraStopFee = Math.max(0, stops - 1) * 20;
  return baseFee + extraStopFee;
}

async function getMerchantRouteEndpointCoordinatesV3(originAddress, destinationAddress) {
  if (!GOOGLE_MAPS_SERVER_API_KEY || !originAddress || !destinationAddress) {
    return null;
  }

  try {
    const response = await fetch(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_MAPS_SERVER_API_KEY,
          'X-Goog-FieldMask': [
            'routes.legs.startLocation',
            'routes.legs.endLocation',
          ].join(','),
        },
        body: JSON.stringify({
          origin: { address: originAddress },
          destination: { address: destinationAddress },
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_UNAWARE',
          computeAlternativeRoutes: false,
          languageCode: 'zh-TW',
          regionCode: 'tw',
          units: 'METRIC',
        }),
      }
    );

    const data = await response.json().catch(() => ({}));
    const leg = data?.routes?.[0]?.legs?.[0];

    if (!response.ok || !leg) {
      console.warn(
        '⚠️ 店家 V3 取送件座標取得失敗：',
        data?.error?.message || response.status
      );
      return null;
    }

    const start = leg?.startLocation?.latLng || {};
    const end = leg?.endLocation?.latLng || {};

    const pickupLat = Number(start.latitude);
    const pickupLng = Number(start.longitude);
    const dropoffLat = Number(end.latitude);
    const dropoffLng = Number(end.longitude);

    if (
      !Number.isFinite(pickupLat) ||
      !Number.isFinite(pickupLng) ||
      !Number.isFinite(dropoffLat) ||
      !Number.isFinite(dropoffLng)
    ) {
      return null;
    }

    return {
      pickupLat,
      pickupLng,
      dropoffLat,
      dropoffLng,
    };
  } catch (error) {
    console.warn(
      '⚠️ 店家 V3 取送件座標取得例外：',
      error?.message || error
    );
    return null;
  }
}

async function calculateMerchantRouteV3(pickupAddress, stops = []) {
  let origin = pickupAddress;
  let distanceMeters = 0;
  let durationSeconds = 0;
  const routeSegments = [];

  const primaryEndpointCoordinates = stops[0]
    ? await getMerchantRouteEndpointCoordinatesV3(
        pickupAddress,
        stops[0].dropoffAddress
      )
    : null;

  for (const stop of stops) {
    const route = await getDistanceMatrixCached(
      origin,
      stop.dropoffAddress
    );

    const segmentDistanceMeters = Number(route.distanceMeters || 0);
    const segmentDurationSeconds = Number(route.durationSeconds || 0);

    distanceMeters += segmentDistanceMeters;
    durationSeconds += segmentDurationSeconds;

    routeSegments.push({
      index: stop.index,
      origin,
      destination: stop.dropoffAddress,
      distanceMeters: segmentDistanceMeters,
      durationSeconds: segmentDurationSeconds,
      distanceText: route.distanceText || formatRouteDistanceText(segmentDistanceMeters),
      durationText: route.durationText || formatRouteDurationText(segmentDurationSeconds),
    });

    origin = stop.dropoffAddress;
  }

  return {
    distanceMeters,
    durationSeconds,
    distanceKm: Math.round((distanceMeters / 1000) * 100) / 100,
    distanceText: formatRouteDistanceText(distanceMeters),
    durationText: formatRouteDurationText(durationSeconds),
    routeSegments,
    pickupLat: primaryEndpointCoordinates?.pickupLat ?? null,
    pickupLng: primaryEndpointCoordinates?.pickupLng ?? null,
    dropoffLat: primaryEndpointCoordinates?.dropoffLat ?? null,
    dropoffLng: primaryEndpointCoordinates?.dropoffLng ?? null,
  };
}

async function createMerchantOrderV3({
  merchantContext,
  payload = {},
}) {
  const { merchantId, merchant, profile, lineUserId } = merchantContext;

  const deliveryMode =
    String(payload.deliveryMode || payload.deliveryType || 'ubee')
      .trim()
      .toLowerCase() === 'merchant'
      ? 'merchant'
      : 'ubee';

  const paymentMethodRaw = String(
    payload.paymentMethod || 'merchant_settlement'
  ).trim().toLowerCase();

  const paymentMethod = new Set([
    'merchant_settlement',
    'cash',
    'merchant_paid',
  ]).has(paymentMethodRaw)
    ? paymentMethodRaw
    : 'merchant_settlement';

  const orderSourceRaw = String(
    payload.orderSource || 'MERCHANT_DIRECT'
  ).trim().toUpperCase();

  const orderSource = UBEE_MERCHANT_ORDER_SOURCES.has(orderSourceRaw)
    ? orderSourceRaw
    : 'MERCHANT_DIRECT';

  const pickupAddress = cleanText(
    profile.pickupAddress || '',
    160
  );

  const merchantPhone = normalizePhone(profile.phone || '');
  const stops = normalizeMerchantDeliveryStopsV3(payload);

  const stopError = validateMerchantDeliveryStopsV3(stops);
  if (stopError) {
    const error = new Error(stopError);
    error.statusCode = 400;
    error.code = 'MERCHANT_ORDER_INVALID';
    throw error;
  }

  if (!pickupAddress || !merchantPhone) {
    const error = new Error('店家電話或取件地址尚未設定。');
    error.statusCode = 400;
    error.code = 'MERCHANT_PROFILE_INCOMPLETE';
    throw error;
  }

  if (stops.length > profile.maxStopsPerOrder) {
    const error = new Error(
      `目前方案每筆最多 ${profile.maxStopsPerOrder} 個送達點。`
    );
    error.statusCode = 400;
    error.code = 'MERCHANT_STOP_LIMIT';
    throw error;
  }

  const route = await calculateMerchantRouteV3(
    pickupAddress,
    stops
  );

  const deliveryFee = deliveryMode === 'ubee'
    ? calculateMerchantDeliveryFeeV3(route.distanceKm, stops.length)
    : 0;

  const goodsAmount = merchantV3Money(payload.goodsAmount);
  const advanceAmount = merchantV3Money(payload.advanceAmount);

  if (deliveryMode === 'merchant' && advanceAmount > 0) {
    const error = new Error('店家自送模式不能要求小U代墊。');
    error.statusCode = 400;
    error.code = 'MERCHANT_SELF_DELIVERY_ADVANCE_NOT_ALLOWED';
    throw error;
  }

  const isCashOrder =
    deliveryMode === 'ubee' && paymentMethod === 'cash';

  const merchantChargeAmount =
    deliveryMode === 'ubee' && !isCashOrder
      ? deliveryFee + advanceAmount
      : 0;

  const customerCashCollectAmount =
    isCashOrder
      ? deliveryFee + advanceAmount
      : 0;

  const commission = calculateMerchantCommissionV3({
    merchant,
    orderSource,
    goodsAmount,
  });

  const orderId = generateOrderId();
  const nowMs = Date.now();
  const now = admin.firestore.FieldValue.serverTimestamp();

  const primaryStop = stops[0];
  const lastStop = stops[stops.length - 1];

  const paymentStatusMap = {
    merchant_settlement: 'merchant_settlement',
    cash: 'cash_on_delivery',
    merchant_paid: 'paid_by_merchant',
  };

  const paymentMethodLabelMap = {
    merchant_settlement: '店家月結',
    cash: '現金付款',
    merchant_paid: '店家已收款',
  };

  // 店家選擇「UBee 派小U」後，建立訂單即視為正式派單。
  // 不再停留在 merchant_ready，避免店家還要再按第二次「確認派遣騎士」。
  const orderStatus =
    deliveryMode === 'merchant'
      ? 'merchant_self_delivery'
      : 'pending_dispatch';

  const merchantBillingStatus =
    deliveryMode !== 'ubee' || isCashOrder
      ? 'not_billable'
      : paymentMethod === 'merchant_paid'
        ? 'paid'
        : 'unpaid';

  const marketplaceSettlementRequired =
    orderSource === 'UBEE_MARKETPLACE' &&
    goodsAmount > 0;

  const settlementStatus =
    marketplaceSettlementRequired
      ? 'PENDING'
      : 'NOT_REQUIRED';

  const itemSummary = stops.length === 1
    ? primaryStop.itemName
    : stops.map(stop => `第 ${stop.index} 點：${stop.itemName}`).join('；');

  const noteSummary = stops.length === 1
    ? primaryStop.note
    : `【多點配送】共 ${stops.length} 點\n` +
      stops.map(stop =>
        `第 ${stop.index} 點：${stop.dropoffAddress}｜` +
        `${stop.customerName}｜${stop.itemName}` +
        `${stop.note ? `｜${stop.note}` : ''}`
      ).join('\n');

  const order = {
    id: orderId,
    orderNo: orderId,

    source: 'merchant-dashboard',
    createdFrom: 'merchant-dashboard',
    orderSource,
    orderType: 'merchant_dispatch',

    merchantId,
    merchantCode: merchantId,
    merchantLineUserId: lineUserId,
    merchantName: profile.merchantName,
    merchantPhone,
    merchantAddress: pickupAddress,
    merchantPlan: profile.merchantPlan,
    platformMode: profile.platformMode,
    settlementType: profile.settlementType,

    status: orderStatus,
    deliveryType: deliveryMode,
    deliveryTypeLabel:
      deliveryMode === 'merchant'
        ? '店家自送'
        : 'UBee 跑腿派小U',

    pickupName: profile.merchantName,
    pickupPhone: merchantPhone,
    pickupAddress,
    pickup: pickupAddress,
    pickupLat: route.pickupLat,
    pickupLng: route.pickupLng,
    fromLat: route.pickupLat,
    fromLng: route.pickupLng,

    customerName: primaryStop.customerName,
    receiverName: primaryStop.customerName,
    customerPhone: primaryStop.customerPhone,
    dropoffPhone: primaryStop.customerPhone,
    dropoffAddress: primaryStop.dropoffAddress,
    dropoff: primaryStop.dropoffAddress,
    primaryDropoffAddress: primaryStop.dropoffAddress,
    finalDropoffAddress: lastStop.dropoffAddress,
    dropoffLat: route.dropoffLat,
    dropoffLng: route.dropoffLng,
    toLat: route.dropoffLat,
    toLng: route.dropoffLng,

    itemName: itemSummary,
    item: itemSummary,
    serviceType:
      stops.length > 1
        ? '店家多點派單'
        : '店家派單',

    note: noteSummary,
    customerNote: noteSummary,
    merchantNote: cleanLongText(payload.note || noteSummary, 500),

    deliveryStops: stops.map((stop, index) => ({
      ...stop,
      status: index === 0 ? 'current' : 'pending',
      completedAtMs: 0,
      arrivedAtMs: 0,
    })),
    deliveryStopsText: noteSummary,
    routeSegments: route.routeSegments,
    multiDropoff: stops.length > 1,
    stopCount: stops.length,
    currentDeliveryStopIndex: 0,
    completedDeliveryStopCount: 0,
    extraStopFee: Math.max(0, stops.length - 1) * 20,

    // 新店家單立即從 3 公里開始分段派單；後續仍由原本派單核心擴圈。
    dispatchRadiusKm: deliveryMode === 'ubee' ? 3 : 0,

    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    distanceKm: route.distanceKm,
    distanceText: route.distanceText,
    durationText: route.durationText,

    goodsAmount,
    advanceAmount,
    deliveryFee,
    merchantServiceFee: deliveryFee,

    totalFee: deliveryFee,
    total: deliveryFee,
    finalTotal: deliveryFee,
    price: deliveryFee,
    fee: deliveryFee,
    customerPayableTotal: customerCashCollectAmount,
    cashCollectAmount: customerCashCollectAmount,
    amountToCollect: customerCashCollectAmount,

    // 保留現行店家派單：配送費全額作為小U任務收入。
    // 日後若調整平台服務費，只需改後端，不需再改店家端。
    riderFee: deliveryMode === 'ubee' ? deliveryFee : 0,
    driverFee: deliveryMode === 'ubee' ? deliveryFee : 0,
    platformFee: 0,

    paymentMethod,
    paymentMethodLabel: paymentMethodLabelMap[paymentMethod],
    paymentStatus: paymentStatusMap[paymentMethod],
    merchantPaid: paymentMethod === 'merchant_paid',
    isCashOrder,
    isPaid: paymentMethod === 'merchant_paid',
    paidAmount:
      paymentMethod === 'merchant_paid'
        ? merchantChargeAmount
        : 0,

    billedTo:
      deliveryMode !== 'ubee'
        ? 'none'
        : isCashOrder
          ? 'customer'
          : 'merchant',

    merchantBillingType: 'merchant_dispatch',
    merchantPayableAmount: merchantChargeAmount,

    storePayableAmount: merchantChargeAmount,

    merchantBillingStatus,
    merchantPaidAmount:
      merchantBillingStatus === 'paid'
        ? merchantChargeAmount
        : 0,

    commissionEnabled: commission.commissionEnabled,
    commissionRate: commission.commissionRate,
    commissionBaseAmount: commission.commissionBaseAmount,
    commissionAmount: commission.commissionAmount,
    platformCommissionAmount: commission.commissionAmount,
    merchantNetAmount: commission.merchantNetAmount,

    settlementStatus,
    settlementDirection:
      marketplaceSettlementRequired
        ? 'PLATFORM_TO_MERCHANT'
        : 'NOT_REQUIRED',

    settlementPeriod: getMerchantSettlementPeriodV3(nowMs),
    billingPeriod: getMerchantSettlementPeriodV3(nowMs),

    riderId: '',
    riderLineUserId: '',
    riderName: '',
    riderPhone: '',

    createdAt: now,
    createdAtMs: nowMs,
    updatedAt: now,
    updatedAtMs: nowMs,
    merchantCreatedAt: now,
    merchantBillingCreatedAt: now,

    merchantBillingSettledAt:
      merchantBillingStatus === 'paid'
        ? now
        : null,

    merchantReadyAt:
      deliveryMode === 'ubee'
        ? now
        : null,

    selfDeliveryAt:
      deliveryMode === 'merchant'
        ? now
        : null,
  };

  await db.collection('orders').doc(orderId).set(order, {
    merge: true,
  });

  // 店家新單建立後立即啟動既有分段派單核心。
  // 只保留「新單」通知；不會把重新轉派通知送到辦公室或騎士審核群。
  if (deliveryMode === 'ubee') {
    const dispatchPushCycleId = buildDispatchPushCycleId(orderId);

    await db.collection('orders').doc(orderId).set(
      {
        status: 'pending_dispatch',
        dispatchPushCycleId,
        dispatchPushNotifiedRiderDocIds: [],
        dispatchPushStage: 'scheduled',
        dispatchStartedAtMs: nowMs,
        dispatchStartedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        dispatchedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        updatedAtMs: nowMs,
      },
      { merge: true }
    );

    clearDispatchPushTimers(orderId);

    await startDispatchPushSequence(
      {
        ...order,
        status: 'pending_dispatch',
        dispatchPushCycleId,
        createdAt: nowMs,
        createdAtMs: nowMs,
      },
      dispatchPushCycleId
    );

    try {
      await pushToGroup(
        LINE_ADMIN_GROUP_ID,
        createAdminForceCancelFlex({
          ...order,
          status: 'pending_dispatch',
          createdAt: nowMs,
        })
      );
    } catch (pushError) {
      console.error('⚠️ 店家 V3 新單通知失敗：', pushError);
    }
  }

  return {
    orderId,
    order: {
      ...order,
      createdAt: nowMs,
      updatedAt: nowMs,
      merchantCreatedAt: nowMs,
      merchantBillingCreatedAt: nowMs,
      merchantBillingSettledAt:
        merchantBillingStatus === 'paid'
          ? nowMs
          : null,
      merchantReadyAt:
        deliveryMode === 'ubee'
          ? nowMs
          : null,
      selfDeliveryAt:
        deliveryMode === 'merchant'
          ? nowMs
          : null,
    },
  };
}

app.get('/api/merchant/v3/bootstrap', async (req, res) => {
  try {
    const context = await resolveApprovedMerchantV3(req);
    const orders = await listMerchantOrdersV3(
      context.merchantId,
      context.profile.phone,
      req.query.limit || 200
    );

    return res.json({
      success: true,
      ok: true,
      version: UBEE_MERCHANT_V3_VERSION,
      merchant: context.profile,
      summary: buildMerchantSummaryV3(orders),
      orders,
      generatedAtMs: Date.now(),
    });
  } catch (error) {
    console.error('❌ 店家 V3 bootstrap 失敗：', error);
    return sendMerchantV3Error(res, error);
  }
});

app.get('/api/merchant/v3/orders', async (req, res) => {
  try {
    const context = await resolveApprovedMerchantV3(req);
    const orders = await listMerchantOrdersV3(
      context.merchantId,
      context.profile.phone,
      req.query.limit || 200
    );

    return res.json({
      success: true,
      ok: true,
      orders,
      summary: buildMerchantSummaryV3(orders),
    });
  } catch (error) {
    console.error('❌ 店家 V3 訂單讀取失敗：', error);
    return sendMerchantV3Error(res, error);
  }
});

app.post('/api/merchant/v3/orders', async (req, res) => {
  try {
    const merchantContext = await resolveApprovedMerchantV3(req);
    const result = await createMerchantOrderV3({
      merchantContext,
      payload: req.body || {},
    });

    return res.json({
      success: true,
      ok: true,
      ...result,
      message: '配送已建立。',
    });
  } catch (error) {
    console.error('❌ 店家 V3 建立配送失敗：', error);
    return sendMerchantV3Error(res, error);
  }
});

app.post('/api/merchant/v3/orders/:orderId/status', async (req, res) => {
  try {
    const context = await resolveApprovedMerchantV3(req);
    const orderId = String(req.params.orderId || '').trim().toUpperCase();
    const nextStatus = String(req.body?.status || '').trim();

    const allowedStatuses = new Set([
      'merchant_preparing',
      'merchant_ready',
      'pending_dispatch',
      'completed',
    ]);

    if (!orderId || !allowedStatuses.has(nextStatus)) {
      const error = new Error('訂單編號或目標狀態不正確。');
      error.statusCode = 400;
      error.code = 'MERCHANT_STATUS_INVALID';
      throw error;
    }

    const orderRef = db.collection('orders').doc(orderId);

    await db.runTransaction(async transaction => {
      const snap = await transaction.get(orderRef);

      if (!snap.exists) {
        const error = new Error('找不到此訂單。');
        error.statusCode = 404;
        error.code = 'MERCHANT_ORDER_NOT_FOUND';
        throw error;
      }

      const order = snap.data() || {};
      const orderMerchantId = String(
        order.merchantId || order.merchantCode || ''
      ).trim();

      if (orderMerchantId !== context.merchantId) {
        const error = new Error('這筆訂單不屬於目前登入店家。');
        error.statusCode = 403;
        error.code = 'MERCHANT_ORDER_FORBIDDEN';
        throw error;
      }

      const currentStatus = String(order.status || '').trim();

      const allowedTransitions = {
        merchant_pending: new Set(['merchant_preparing', 'merchant_ready']),
        merchant_preparing: new Set(['merchant_ready']),
        merchant_ready: new Set(['pending_dispatch']),
        merchant_self_delivery: new Set(['completed']),
      };

      if (
        !(allowedTransitions[currentStatus] || new Set())
          .has(nextStatus)
      ) {
        const error = new Error(
          `目前狀態「${currentStatus || '未知'}」不能直接改成「${nextStatus}」。`
        );
        error.statusCode = 409;
        error.code = 'MERCHANT_STATUS_TRANSITION_DENIED';
        throw error;
      }

      const update = {
        status: nextStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAtMs: Date.now(),
      };

      if (nextStatus === 'merchant_preparing') {
        update.merchantAcceptedAt =
          admin.firestore.FieldValue.serverTimestamp();
      }
      if (nextStatus === 'merchant_ready') {
        update.merchantReadyAt =
          admin.firestore.FieldValue.serverTimestamp();
      }
      if (nextStatus === 'pending_dispatch') {
        update.dispatchedAt =
          admin.firestore.FieldValue.serverTimestamp();
      }
      if (nextStatus === 'completed') {
        update.completedAt =
          admin.firestore.FieldValue.serverTimestamp();
        update.completedAtMs = Date.now();
      }

      transaction.update(orderRef, update);
    });

    if (nextStatus === 'pending_dispatch') {
      const latestSnap = await orderRef.get();

      if (latestSnap.exists) {
        const latestOrder = {
          id: orderId,
          ...(latestSnap.data() || {}),
        };

        const dispatchPushCycleId =
          buildDispatchPushCycleId(orderId);

        await orderRef.set(
          {
            dispatchPushCycleId,
            dispatchPushNotifiedRiderDocIds: [],
            dispatchPushStage: 'scheduled',
            dispatchStartedAtMs: Date.now(),
            dispatchStartedAt:
              admin.firestore.FieldValue.serverTimestamp(),
            updatedAt:
              admin.firestore.FieldValue.serverTimestamp(),
            updatedAtMs: Date.now(),
          },
          { merge: true }
        );

        clearDispatchPushTimers(orderId);

        await startDispatchPushSequence(
          {
            ...latestOrder,
            status: 'pending_dispatch',
            dispatchPushCycleId,
          },
          dispatchPushCycleId
        );
      }
    }

    return res.json({
      success: true,
      ok: true,
      orderId,
      status: nextStatus,
      message:
        nextStatus === 'pending_dispatch'
          ? '訂單已正式進入小U派單流程。'
          : '訂單狀態已更新。',
    });
  } catch (error) {
    console.error('❌ 店家 V3 更新狀態失敗：', error);
    return sendMerchantV3Error(res, error);
  }
});

app.post('/api/merchant/v3/orders/:orderId/cancel', async (req, res) => {
  try {
    const context = await resolveApprovedMerchantV3(req);
    const orderId = String(req.params.orderId || '').trim().toUpperCase();
    const orderRef = db.collection('orders').doc(orderId);

    const cancellableStatuses = new Set([
      'merchant_pending',
      'merchant_preparing',
      'merchant_ready',
      'pending_dispatch',
      'merchant_self_delivery',
    ]);

    await db.runTransaction(async transaction => {
      const snap = await transaction.get(orderRef);

      if (!snap.exists) {
        const error = new Error('找不到此訂單。');
        error.statusCode = 404;
        error.code = 'MERCHANT_ORDER_NOT_FOUND';
        throw error;
      }

      const order = snap.data() || {};
      const orderMerchantId = String(
        order.merchantId || order.merchantCode || ''
      ).trim();

      if (orderMerchantId !== context.merchantId) {
        const error = new Error('這筆訂單不屬於目前登入店家。');
        error.statusCode = 403;
        error.code = 'MERCHANT_ORDER_FORBIDDEN';
        throw error;
      }

      const currentStatus = String(order.status || '').trim();

      if (!cancellableStatuses.has(currentStatus)) {
        const error = new Error(
          '此訂單已進入小U接單或配送流程，請聯繫 UBee 協助。'
        );
        error.statusCode = 409;
        error.code = 'MERCHANT_ORDER_NOT_CANCELLABLE';
        throw error;
      }

      transaction.update(orderRef, {
        status: 'merchant_cancelled',
        cancelledBy: 'merchant',
        cancelledReason:
          cleanLongText(
            req.body?.reason || '店家於派單中心取消',
            200
          ),
        cancelledFromStatus: currentStatus,
        cancelledMerchantId: context.merchantId,
        cancelledMerchantName: context.profile.merchantName,
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAtMs: Date.now(),
      });
    });

    clearDispatchPushTimers(orderId);

    return res.json({
      success: true,
      ok: true,
      orderId,
      status: 'merchant_cancelled',
      message: '訂單已取消。',
    });
  } catch (error) {
    console.error('❌ 店家 V3 取消訂單失敗：', error);
    return sendMerchantV3Error(res, error);
  }
});

app.get('/api/merchant/v3/settlements', async (req, res) => {
  try {
    const context = await resolveApprovedMerchantV3(req);
    const orders = await listMerchantOrdersV3(
      context.merchantId,
      context.profile.phone,
      req.query.limit || 300
    );

    const rows = orders
      .filter(order => {
        const billingAmount = merchantV3Money(
          order.merchantPayableAmount ||
          order.storePayableAmount
        );
        const merchantNet = merchantV3Money(order.merchantNetAmount);
        return billingAmount > 0 || merchantNet > 0;
      })
      .map(order => ({
        orderId: order.id,
        orderNo: order.orderNo || order.id,
        createdAtMs: merchantV3ToMs(
          order.createdAt || order.createdAtMs
        ),
        completedAtMs: merchantV3ToMs(
          order.completedAt || order.completedAtMs
        ),
        deliveryFee: merchantV3Money(order.deliveryFee),
        goodsAmount: merchantV3Money(order.goodsAmount),
        commissionAmount: merchantV3Money(order.commissionAmount),
        merchantNetAmount: merchantV3Money(order.merchantNetAmount),
        merchantPayableAmount: merchantV3Money(
          order.merchantPayableAmount ||
          order.storePayableAmount
        ),
        merchantBillingStatus:
          order.merchantBillingStatus || 'unpaid',
        settlementStatus:
          order.settlementStatus || 'NOT_REQUIRED',
        settlementPeriod:
          order.settlementPeriod ||
          order.billingPeriod ||
          '',
      }));

    return res.json({
      success: true,
      ok: true,
      merchant: context.profile,
      summary: buildMerchantSummaryV3(orders),
      settlements: rows,
    });
  } catch (error) {
    console.error('❌ 店家 V3 結算讀取失敗：', error);
    return sendMerchantV3Error(res, error);
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
  const queueMinutes = Math.max(
    0,
    Math.round(Number(data.queueMinutes || 0))
  );

  if (queueMinutes <= 0) {
    return res.status(400).json({
      success: false,
      error: '請輸入正確的預估排隊時間',
    });
  }

  if (queueMinutes > PRICING.maxQuoteTimeMinutes) {
    return res.status(400).json({
      success: false,
      error: `排隊時間超過 ${PRICING.maxQuoteTimeMinutes} 分鐘，建議改由 UBee 跑腿客服協助確認費用。`,
    });
  }

  const deliveryFee = Math.max(
    0,
    Math.round(Number(PRICING.queueBaseFee || 0))
  );

  const serviceFee = Math.max(
    0,
    Math.round(Number(PRICING.serviceFee || 0))
  );

  const upstairsFee = Math.max(
    0,
    Math.round(Number(data.upstairsFee || 0))
  );

  const queueTimeFee = Math.max(
    0,
    queueMinutes * PRICING.queuePerMinute
  );

  const longTaskExtraFee =
    queueMinutes > PRICING.queueLongTaskThresholdMinutes
      ? PRICING.queueLongTaskExtraFee
      : 0;

  const waitingFee =
    queueTimeFee +
    longTaskExtraFee;

  const speed = getSpeedOption(
    data.speedType || 'standard'
  );

  const speedFee = Math.max(
    0,
    Math.round(Number(speed.fee || 0))
  );

  const financials = calculateFinancialSplit({
    deliveryFee,
    serviceFee,
    speedFee,
    upstairsFee,
    waitingFee,
  });

  price = {
    fareMode: 'queue',

    deliveryFee:
      financials.deliveryFee,

    serviceFee:
      financials.serviceFee,

    platformServiceFee:
      financials.platformServiceFee,

    speedFee:
      financials.speedFee,

    upstairsFee:
      financials.upstairsFee,

    waitingFee:
      financials.waitingFee,

    queueTimeFee,
    longTaskExtraFee,

    taskSubtotal:
      financials.taskSubtotal,

    serviceSubtotal:
      financials.serviceSubtotal,

    total:
      financials.serviceSubtotal,

    driverFee:
      financials.driverFee,

    riderFee:
      financials.riderFee,

    platformFee:
      financials.platformFee,

    platformIncome:
      financials.platformIncome,
  };
}else {
  distance = await getDistanceMatrixCached(data.pickupAddress, data.dropoffAddress);

  if(!distance || !distance.distanceMeters){
    return res.status(400).json({
      success: false,
      error: '地址無法計算距離，請確認取件與送達地址是否完整'
    });
  }

  const quickServiceType =
    getQuickServicePricingType({
      serviceKey: data.serviceKey,
      serviceGroup: data.serviceGroup,
      serviceType: data.serviceType,
    });

  if (quickServiceType) {
    // 只有「幫我取 / 幫代買」走專用即時配送計價。
    price = calculateQuickServicePrice({
      distanceMeters: distance.distanceMeters,
      speedType: data.speedType,
      upstairsFee: data.upstairsFee,
      serviceType: quickServiceType,
    });

  } else {
    // 幫我送、全能跑腿、急件專送與其他一般任務完全沿用原本公式。
    price = calculatePrice({
      distanceMeters: distance.distanceMeters,
      durationSeconds: distance.durationSeconds,
      speedType: data.speedType,
      upstairsFee: data.upstairsFee,
    });
  }
}    
    const id = generateOrderId();

    const detectedAdvancePayment = getDetectedAdvancePaymentAmountFromOrderInput(data);

    const advancePayment = Number.isFinite(detectedAdvancePayment)
      ? Math.max(0, Math.round(detectedAdvancePayment))
      : 0;

    if (advancePayment >= MAX_ADVANCE_PAYMENT) {
      return res.status(400).json({
        success: false,
        error: '代墊款項達 NT$1,000（含）以上，請先聯繫 UBee 跑腿客服人工確認。',
      });
    }

const serviceSubtotal = Math.max(0, Math.round(Number(price.total || 0)));
const customerPayableTotal = serviceSubtotal + advancePayment;

    const scheduleMetadata =
      buildOrderScheduleMetadata(
        data,
        data.serviceMode === 'queue'
          ? 0
          : Number(distance?.durationSeconds || 0)
      );

    const order = {
  id,

  userId:
    data.userId,

  customerId:
    data.customerId,

  riderId: '',

  status:
    'pending_payment',

  // ==============================
  // 服務資料
  // ==============================
  serviceGroup:
    data.serviceGroup,

  serviceType:
    data.serviceType,

  serviceCategory:
    data.serviceCategory,

  serviceMode:
    data.serviceMode,

  serviceKey:
    data.serviceKey,

  queueMinutes:
    data.queueMinutes,

  // ==============================
  // 任務內容
  // ==============================
  item:
    data.item,

  note:
    data.note,

  // ==============================
  // 取件資訊
  // ==============================
  pickupAddress:
    data.pickupAddress,

  pickupPhone:
    data.pickupPhone,

  pickupLat:
    data.pickupLat,

  pickupLng:
    data.pickupLng,

  pickupPlaceId:
    data.pickupPlaceId || '',

  // ==============================
  // 送達資訊
  // ==============================
  dropoffAddress:
    data.dropoffAddress,

  dropoffPhone:
    data.dropoffPhone,

  dropoffLat:
    data.dropoffLat,

  dropoffLng:
    data.dropoffLng,

  dropoffPlaceId:
    data.dropoffPlaceId || '',

  // ==============================
  // 任務設定
  // ==============================
  speedType:
    data.speedType,

  // 立即／指定時間／彈性時段預約。
  ...scheduleMetadata,

  upstairsOption:
    data.upstairsOption,

  upstairsLabel:
    data.upstairsLabel,

  upstairsFee:
    data.upstairsFee,

  fareMode:
    data.fareMode,

  // ==============================
  // 附近店家資料
  // ==============================
  nearbyPlace:
    data.nearbyPlace || null,

  // ==============================
  // 合作店家資料
  // ==============================
  merchantId:
    data.merchantId || '',

  merchantCode:
    data.merchantCode ||
    data.merchantId ||
    '',

  merchantName:
    data.merchantName || '',

  merchantPhone:
    data.merchantPhone || '',

  merchantAddress:
    data.merchantAddress || '',

  hasMerchant:
    data.hasMerchant || false,

  // ==============================
  // 代墊資料
  // ==============================
  advancePayment,

  advanceAmount:
    advancePayment,

  estimatedGoodsAmount:
    advancePayment,

  estimatedAdvancePayment:
    advancePayment,

  estimatedAdvanceAmount:
    advancePayment,

  riderAdvanceAmount:
    advancePayment,

  purchaseAdvanceAllowed:
    advancePayment > 0,

  purchasePaymentRule:
    advancePayment > 0
      ? 'rider_advance_then_customer_pay'
      : 'no_advance',

  // ==============================
  // 正式費用
  // ==============================
  serviceSubtotal,

  customerPayableTotal,

  payableTotal:
    customerPayableTotal,

  riderDisplayTotal:
    customerPayableTotal,

  duplicateFingerprint:
    getDuplicateFingerprint(data),

  // ==============================
  // 路線資料
  // ==============================
  distanceMeters:
    data.serviceMode === 'queue'
      ? 0
      : distance.distanceMeters,

  durationSeconds:
    data.serviceMode === 'queue'
      ? 0
      : distance.durationSeconds,

  distanceText:
    data.serviceMode === 'queue'
      ? '排隊任務'
      : distance.distanceText,

  durationText:
    data.serviceMode === 'queue'
      ? `${data.queueMinutes} 分鐘內`
      : distance.durationText,

  // 正式價格計算結果。
  // 這裡仍然完全使用你現在的 calculatePrice /
  // calculateFinancialSplit。
  ...price,

  // ...price 裡面的 total 是服務費小計。
  // 客人實際應付總額必須在這裡覆蓋回來。
  total:
    customerPayableTotal,

  finalTotal:
    customerPayableTotal,

  customerTotalWithAdvance:
    customerPayableTotal,

  serviceTotal:
    serviceSubtotal,

  etaMinutes: null,

  // ==============================
  // UBee 現金單正式流程
  // ==============================
  paymentMethod: '',

  paymentMethodLabel:
    '尚未選擇',

  paymentLabel:
    '尚未選擇',

  paymentStatus:
    'unselected',

  isCashOrder: false,

  cashCollectAmount: 0,

  cashCollected: false,

  isPaid: false,

  paidAt: null,

  // ==============================
  // 等候費
  // ==============================
  waitingFeeRequested: false,

  waitingFeeApproved: false,

  waitingFeeRejected: false,

  waitingFeeRequestedAt: null,

  // ==============================
  // 時間
  // ==============================
  createdAt:
    Date.now(),

  acceptedAt: null,

  arrivedPickupAt: null,

  pickedUpAt: null,

  arrivedDropoffAt: null,

  completedAt: null,
};

    // Level 4：由後端統一產生可信任的區域與時間特徵，不依賴前端判斷。
    Object.assign(order, buildDispatchOrderMetadata(order, Date.now()));

    await saveOrder(order);

    logDispatchEvent({
      type:'ORDER_CREATED',
      orderId:order.id,
      zoneId:order.pickupZoneId || '',
      district:order.pickupDistrict || '',
      serviceType:order.serviceType || '',
      speedType:order.speedType || '',
      createdAtMs:getDispatchOrderCreatedAtMs(order) || Date.now(),
    }).catch(()=>{});

    await notifyCustomer(order, createTextMessage(
      `✅ 訂單已建立：${order.id}\n\n` +
      `目前 UBee 跑腿先開放現金單。\n` +
      `請回到網頁確認使用現金單，確認後系統才會開始媒合騎士。`
    ));

    res.json({
      success: true,
      orderId: id,
      order,
      paymentMethod: '',
      paymentMethodLabel: '尚未選擇',
      paymentLabel: '尚未選擇',
      paymentInfo: '',
      paymentOptions: {
        cash: getPaymentInfo('cash', order.customerPayableTotal),
      },
      total: order.customerPayableTotal,
      serviceSubtotal: order.serviceSubtotal,
      customerPayableTotal: order.customerPayableTotal,
      advancePayment: order.advancePayment,
      message: '訂單已建立，請確認使用現金單。',
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
      return res.status(404).json({
        success: false,
        error: '找不到此訂單',
      });
    }

    if (!isSameCustomerUserId(order, requestUserId)) {
      return res.status(403).json({
        success: false,
        error: '此訂單只能由原本下單的客人設定付款方式',
      });
    }

    const normalizedPaymentMethod = String(paymentMethod || '').trim().toLowerCase();

    if (normalizedPaymentMethod !== 'cash') {
      return res.status(400).json({
        success: false,
        error: '街口支付目前尚未開放，請改用現金單。',
      });
    }

    const currentStatus = String(order.status || '').trim();

    // 正式版保護：
    // 正常情況只允許 pending_payment。
    // 但為了救目前已經被舊邏輯建成 merchant_pending 的單，也允許 merchant_pending 回來設定付款。
    if (!['pending_payment', 'merchant_pending'].includes(currentStatus)) {
      return res.status(400).json({
        success: false,
        error: `此訂單目前狀態為「${getStatusLabel(order.status)}」，不可再變更付款方式`,
      });
    }

    const advancePayment = parseNonNegativeMoney(order.advancePayment);

    const serviceSubtotal = Math.max(0, Math.round(Number(
      order.serviceSubtotal ||
      order.serviceTotal ||
      order.total ||
      order.price ||
      0
    )));

    const customerPayableTotal = Math.max(0, Math.round(Number(
      order.customerPayableTotal ||
      order.payableTotal ||
      order.riderDisplayTotal ||
      (serviceSubtotal + advancePayment) ||
      0
    )));

    order.customerPayableTotal = customerPayableTotal;
    order.payableTotal = customerPayableTotal;
    order.riderDisplayTotal = customerPayableTotal;
    order.advancePayment = advancePayment;

    if (normalizedPaymentMethod === 'cash') {
      order.paymentMethod = 'cash';
      order.paymentMethodLabel = '現金付款';
      order.paymentLabel = '現金付款';
      order.paymentStatus = 'cash_on_delivery';

      order.isCashOrder = true;
      order.cashCollectAmount = customerPayableTotal;
      order.cashCollected = false;

      order.isPaid = false;
      order.paidAt = null;

      const scheduledOrder =
        isScheduledOrderTiming(order);

      // 立即單：直接進入待派單。
      // 預約單：進入預約任務池，不會立刻要求小U出發。
      order.status =
        scheduledOrder
          ? 'pending_schedule'
          : 'pending_dispatch';

      order.riderStatus =
        order.status;

      order.scheduleStatus =
        scheduledOrder
          ? 'awaiting_rider'
          : (
              order.scheduleStatus ||
              'not_applicable'
            );

      order.updatedAt = admin.firestore.FieldValue.serverTimestamp();

      await saveOrder(order);

      if (scheduledOrder) {
        setImmediate(() => {
          sendNewOrderPushToRiders(
            order,
            null,
            {
              allowOffline: true,
              scheduled: true,
            }
          ).catch((pushError) => {
            console.error(
              '⚠️ 預約任務已建立，但通知可承接小U失敗：',
              pushError
            );
          });
        });
      }

      setImmediate(() => {
  notifyCustomer(
    order,
    createTextMessage(
      scheduledOrder
        ? (
            `📅 UBee 預約需求已建立\n\n` +
            `預約時間：${order.scheduleLabel || '-'}\n` +
            `系統正在媒合可以在指定時間執行的小U。\n` +
            `任務完成時由小U向你收取現金，預計收取 NT$${customerPayableTotal}。`
          )
        : (
            `你已選擇付款方式：現金付款\n\n` +
            `本單將由騎士於任務完成時向你收取現金。\n` +
            `預計收取金額：NT$${customerPayableTotal}。`
          )
    )
  ).catch((notifyErr) => {
    console.error(
      '⚠️ 現金單設定成功，但背景通知客人失敗：',
      notifyErr
    );
  });
});

      return res.json({
        success: true,
        orderId,
        status: order.status,
        paymentMethod: 'cash',
        paymentMethodLabel: '現金付款',
        paymentLabel: '現金付款',
        paymentStatus: 'cash_on_delivery',
        isCashOrder: true,
        cashCollectAmount: customerPayableTotal,
        total: customerPayableTotal,
        customerPayableTotal,
        advancePayment,
        paymentInfo: getPaymentInfo('cash', customerPayableTotal),
        message:
          scheduledOrder
            ? '已建立預約需求，系統開始媒合可於指定時間執行的小U。'
            : '已選擇現金單，系統開始媒合騎士。',
      });
    }

  } catch (error) {
    console.error('❌ 設定付款方式失敗：', error);
    return res.status(500).json({
      success: false,
      error: '設定付款方式失敗',
    });
  }
});

app.post('/api/orders/:orderId/paid', async (req, res) => {
  return res.status(400).json({
    success: false,
    error: '街口支付目前尚未開放，現階段不提供線上付款確認。請改用現金單，任務完成時由騎士向客人收取現金。',
  });
});

app.post('/api/rider-distance-to-pickup', riderAuthMiddleware, async (req, res) => {
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

function getEtaPayloadByStatus(status) {
  const normalizedStatus = String(status || '').trim();

  const etaMap = {
    draft_confirm: {
      etaText: '等待訂單確認',
      etaMinutes: null,
    },
    pending_payment: {
      etaText: '等待確認現金單',
      etaMinutes: null,
    },
    merchant_pending: {
      etaText: '等待店家確認',
      etaMinutes: null,
    },
    pending_dispatch: {
      etaText: '媒合騎士中',
      etaMinutes: null,
    },
    accepted: {
      etaText: '約 30～45 分鐘',
      etaMinutes: 45,
    },
    arrived_pickup: {
      etaText: '約 20～30 分鐘',
      etaMinutes: 30,
    },
    picked_up: {
      etaText: '約 10～20 分鐘',
      etaMinutes: 20,
    },
    arrived_dropoff: {
      etaText: '即將完成',
      etaMinutes: 5,
    },
    completed: {
      etaText: '已完成',
      etaMinutes: 0,
    },
    done: {
      etaText: '已完成',
      etaMinutes: 0,
    },
    cancelled: {
      etaText: '已取消',
      etaMinutes: null,
    },
  };

  const eta = etaMap[normalizedStatus] || {
    etaText: '約 35 分鐘',
    etaMinutes: 35,
  };

  return {
    etaText: eta.etaText,
    estimatedTime: eta.etaText,
    etaMinutes: eta.etaMinutes,
    etaStatus: normalizedStatus,
    etaUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}


// Level 4：騎士端輕量調度事件（目前只接受 SKIPPED）。
// 失敗不得影響既有接單畫面流程。
app.post('/api/rider/dispatch-event', riderAuthMiddleware, async (req, res) => {
  try {
    const { orderId, type, lineUserId, phone, riderId } = req.body || {};
    const eventType = String(type || '').trim().toUpperCase();
    if (!orderId || !['SKIPPED'].includes(eventType)) {
      return res.status(400).json({ success:false, message:'調度事件資料不完整。' });
    }
    const riderResult = await findApprovedRiderForApi({ lineUserId, phone, riderId });
    if (!riderResult.ok) {
      return res.status(riderResult.statusCode || 403).json({ success:false, message:riderResult.message || '騎士身分驗證失敗。' });
    }
    const identity = buildRiderApiIdentity(riderResult.riderDoc, riderResult.rider || {}, { lineUserId, phone, riderId });
    const nowMs = Date.now();
    await Promise.allSettled([
      logDispatchEvent({ type:'RIDER_SKIPPED', orderId:String(orderId).trim().toUpperCase(), riderId:identity.riderId, riderDocId:identity.riderDocId, createdAtMs:nowMs }),
      updateRiderDispatchStats(identity.riderId, { skippedOrders:1, lastSkippedAtMs:nowMs }),
    ]);
    return res.json({ success:true });
  } catch (error) {
    console.warn('⚠️ Level4 騎士調度事件失敗：', error?.message || error);
    return res.status(500).json({ success:false, message:'調度事件紀錄失敗。' });
  }
});

// 3. 接受任務：手機登入正式版
// 支援 phone / riderId，並保留 lineUserId 相容
app.post('/api/rider/accept-order', riderAuthMiddleware, async (req, res) => {
  try {
    const { orderId, lineUserId, phone, riderId } = req.body || {};

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: '缺少訂單編號。',
      });
    }

    const riderResult = await findApprovedRiderForApi({
      lineUserId,
      phone,
      riderId,
    });

    if (!riderResult.ok) {
      return res.status(riderResult.statusCode).json({
        success: false,
        message: riderResult.message || '找不到可接單的騎士身分。',
      });
    }

    const riderDoc = riderResult.riderDoc;
    const rider = riderResult.rider || {};
    const identity = buildRiderApiIdentity(riderDoc, rider, {
      lineUserId,
      phone,
      riderId,
    });

    const safeOrderId = String(orderId).toUpperCase();
    const orderRef = db.collection('orders').doc(safeOrderId);
    const riderRef = db.collection('riders').doc(riderDoc.id);

    // UBee 任務即時追蹤：接單即建立 tracking session。
    // 這個 session 與一般 online / heartbeat 分離，直到完成或轉派才結束。
    const trackingStartedAtMs = Date.now();
    const trackingSessionId =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');

    let acceptedOrder = null;

    await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);

      if (!orderDoc.exists) {
        throw new Error('ORDER_NOT_FOUND');
      }

      const order = orderDoc.data() || {};

      const latestRiderDoc = await transaction.get(riderRef);
      const latestRider = latestRiderDoc.exists ? latestRiderDoc.data() : {};

      if (!canRiderAcceptOrdersV4(latestRider)) {
        throw new Error('RIDER_V4_NOT_ACTIVE');
      }

      if (!riderMeetsOrderV4Requirements(latestRider, order)) {
        throw new Error('RIDER_V4_QUALIFICATION_REQUIRED');
      }

      if (
        latestRider.busy === true &&
        latestRider.currentOrderId &&
        latestRider.currentOrderId !== safeOrderId
      ) {
        const oldOrderRef = db.collection('orders').doc(String(latestRider.currentOrderId).toUpperCase());
        const oldOrderDoc = await transaction.get(oldOrderRef);

        if (oldOrderDoc.exists) {
          const oldOrder = oldOrderDoc.data() || {};

          if (!['completed', 'cancelled'].includes(oldOrder.status)) {
            throw new Error('RIDER_ALREADY_BUSY');
          }
        }
      }

      const orderStatus =
        String(order.status || '').trim();

      const isScheduledReservedForThisRider =
        [
          'scheduled_reserved',
          'scheduled_confirmed',
        ].includes(orderStatus) &&
        String(
          order.reservedRiderDocId || ''
        ).trim() === identity.riderDocId;

      if (
        orderStatus !== 'pending_dispatch' &&
        !isScheduledReservedForThisRider
      ) {
        throw new Error('ORDER_ALREADY_ACCEPTED');
      }

      if (
        !isRiderVisibleDispatchOrder(order) &&
        !isScheduledReservedForThisRider
      ) {
        throw new Error('ORDER_PAYMENT_NOT_CONFIRMED');
      }

      if (isScheduledReservedForThisRider) {
        const startMs =
          getScheduleTimestampMs(
            order.scheduledStartAtMs ||
            order.requestedScheduleAtMs
          );

        const endMs =
          getScheduleTimestampMs(
            order.scheduledEndAtMs ||
            order.desiredCompletionAtMs ||
            order.requestedScheduleAtMs
          );

        const nowMs = Date.now();

        if (
          startMs &&
          nowMs <
            startMs -
              UBEE_SCHEDULE_START_EARLY_MS
        ) {
          throw new Error(
            'SCHEDULE_NOT_READY'
          );
        }

        if (
          endMs &&
          nowMs >
            endMs +
              60 * 60 * 1000
        ) {
          throw new Error(
            'ORDER_SCHEDULE_EXPIRED'
          );
        }
      }

      if (isOrderSkippedForRider(order, identity)) {
        throw new Error('RIDER_ALREADY_SKIPPED_ORDER');
      }
      
      const acceptedEtaPayload = getEtaPayloadByStatus('accepted');

      const acceptUpdateData = {
        status: 'accepted',
        riderStatus: 'accepted',
// 手機登入正式識別
        riderId: identity.riderId,
        riderDocId: identity.riderDocId,
        riderPhone: identity.phone,

        // 舊版相容欄位，若騎士資料仍有 lineUserId 就保留
        riderLineUserId: identity.lineUserId || '',

        riderName: rider.name || rider.riderName || '',
        acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        'statusTimes.accepted': admin.firestore.FieldValue.serverTimestamp(),

        // 任務追蹤狀態：接單開始，第一筆 GPS 到達後會切換為 live。
        trackingSessionId,
        riderTrackingStatus: 'starting',
        trackingStartedAtMs,
        trackingStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        trackingUpdatedAtMs: trackingStartedAtMs,
        trackingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        trackingEndedAtMs: null,
        trackingEndedAt: null,
        trackingStopReason: '',

        ...(isScheduledReservedForThisRider
          ? {
              scheduleStatus: 'in_progress',
              scheduleStartedAtMs: trackingStartedAtMs,
              scheduleStartedAt:
                admin.firestore.FieldValue.serverTimestamp(),
              scheduleConfirmationRequired: false,
            }
          : {}),

        ...acceptedEtaPayload,
      };

      acceptedOrder = {
        ...order,
        ...acceptUpdateData,
        id: safeOrderId,
        status: 'accepted',
        riderStatus: 'accepted',
      };

      transaction.update(orderRef, acceptUpdateData);

      transaction.set(riderRef, {
        busy: true,
        currentOrderId: safeOrderId,
        lastActive: trackingStartedAtMs,

        // 與一般在線狀態分離的「任務追蹤」旗標。
        activeTrackingOrderId: safeOrderId,
        activeTrackingSessionId: trackingSessionId,
        taskTrackingStatus: 'starting',
        taskTrackingUpdatedAtMs: trackingStartedAtMs,
        taskTrackingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),

        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    orders[safeOrderId] = acceptedOrder;

    clearDispatchPushTimers(
      safeOrderId
    );

    const acceptedNowMs = Date.now();
    Promise.allSettled([
      logDispatchEvent({
        type:'RIDER_ACCEPTED',
        orderId:safeOrderId,
        riderId:identity.riderId,
        riderDocId:identity.riderDocId,
        createdAtMs:acceptedNowMs,
      }),
      updateRiderDispatchStats(identity.riderId, {
        acceptedOrders:1,
        lastAcceptedAtMs:acceptedNowMs,
      }),
    ]).catch(()=>{});
    
    try {
      await notifyCustomer(
        acceptedOrder,
        createTextMessage(
          `🟢 UBee 跑腿騎士已接單\n\n訂單編號：${acceptedOrder.id}\n騎士將盡快前往取件。`
        )
      );
    } catch (notifyErr) {
      console.error('⚠️ 任務已接單，但通知客人失敗：', notifyErr);
    }

    return res.json({
      success: true,
      orderId: safeOrderId,
      status: 'accepted',
      order: acceptedOrder,
      message: '接單成功',
    });

  } catch (error) {
    console.error('❌ 騎士網頁接單失敗：', error);

    if (error.message === 'RIDER_V4_NOT_ACTIVE') {
      return res.status(403).json({
        success: false,
        code: 'RIDER_V4_NOT_ACTIVE',
        message: '你的 V4 入職／接單資格尚未啟用，請先完成教學、測驗或聯繫 UBee。',
      });
    }

    if (error.message === 'RIDER_V4_QUALIFICATION_REQUIRED') {
      return res.status(403).json({
        success: false,
        code: 'RIDER_V4_QUALIFICATION_REQUIRED',
        message: '此任務需要更高等級或指定專業資格，目前無法承接。',
      });
    }

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

    if (error.message === 'ORDER_PAYMENT_NOT_CONFIRMED') {
      return res.status(409).json({
        success: false,
        message: '此訂單尚未符合可派送條件，請確認付款狀態或店家派單狀態。',
      });
    }

    if (error.message === 'RIDER_ALREADY_BUSY') {
      return res.status(409).json({
        success: false,
        message: '你目前已有進行中的任務，完成後才能接下一張。',
      });
    }

    if (error.message === 'RIDER_ALREADY_SKIPPED_ORDER') {
      return res.status(409).json({
        success: false,
        message: '你已略過或取消這張任務，系統已轉派給其他騎士。',
      });
    }

    if (error.message === 'SCHEDULE_NOT_READY') {
      return res.status(409).json({
        success: false,
        code: 'SCHEDULE_NOT_READY',
        message: '這筆預約任務尚未進入可開始執行的時間，請依預約時間再開始任務。',
      });
    }

    if (error.message === 'ORDER_SCHEDULE_EXPIRED') {
      return res.status(409).json({
        success: false,
        code: 'ORDER_SCHEDULE_EXPIRED',
        message: '這筆預約任務的執行時段已過，系統將重新確認調度狀態。',
      });
    }
    
    return res.status(500).json({
      success: false,
      message: '接單失敗，請稍後再試。',
    });
  }
});

// ===== 騎士取消／轉派 API =====
// 取消的是「騎士承接」，不是取消客人的訂單。
// 只有 accepted 狀態可以直接取消／轉派。
// 成功後訂單退回 pending_dispatch，重新開放給其他騎士。
app.post('/api/rider/transfer-order', riderAuthMiddleware, async (req, res) => {
  try {
    const {
      orderId,
      lineUserId,
      phone,
      riderId,
      reason,
    } = req.body || {};

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: '缺少訂單編號。',
      });
    }

    const safeReason = String(reason || '')
      .trim()
      .slice(0, 120);

    if (!safeReason) {
      return res.status(400).json({
        success: false,
        message: '請選擇取消／轉派原因。',
      });
    }

    const riderResult = await findApprovedRiderForApi({
      lineUserId,
      phone,
      riderId,
    });

    if (!riderResult.ok) {
      return res.status(riderResult.statusCode).json({
        success: false,
        message:
          riderResult.message ||
          '找不到可操作任務的騎士身分。',
      });
    }

    const riderDoc = riderResult.riderDoc;
    const rider = riderResult.rider || {};

    const identity = buildRiderApiIdentity(
      riderDoc,
      rider,
      {
        lineUserId,
        phone,
        riderId,
      }
    );

    const safeOrderId = String(orderId)
      .trim()
      .toUpperCase();

    const orderRef = db
      .collection('orders')
      .doc(safeOrderId);

    const riderRef = db
      .collection('riders')
      .doc(riderDoc.id);

    const nowMs = Date.now();

    const redispatchPushCycleId =
      buildDispatchPushCycleId(
        safeOrderId
      );
    
    let transferredOrder = null;

    await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);

      if (!orderDoc.exists) {
        throw new Error('ORDER_NOT_FOUND');
      }

      const order = orderDoc.data() || {};

      const currentStatus = String(
        order.status || ''
      ).trim();

      if (!isOrderBelongsToRider(order, identity)) {
        throw new Error('NOT_YOUR_ORDER');
      }

      if (currentStatus !== 'accepted') {
        throw new Error('ORDER_ALREADY_STARTED');
      }

      const riderSkipKeys =
        getRiderIdentityKeys(identity);

      const transferUpdateData = {
        status: 'pending_dispatch',
        riderStatus: 'pending_dispatch',

        previousRiderLineUserId:
          identity.lineUserId || '',

        previousRiderDocId:
          identity.riderDocId || '',

        previousRiderId:
          identity.riderId || '',

        previousRiderName:
          rider.name ||
          rider.riderName ||
          '',

        previousRiderPhone:
          identity.phone ||
          rider.phone ||
          '',

        transferReason: safeReason,

        transferCount:
          admin.firestore.FieldValue.increment(1),

        transferRequestedAtMs: nowMs,

        transferredAt:
          admin.firestore.FieldValue.serverTimestamp(),

        dispatchStartedAtMs: nowMs,

        redispatchStartedAtMs: nowMs,

        dispatchPushCycleId:
          redispatchPushCycleId,

        dispatchPushNotifiedRiderDocIds:
          [],

        dispatchPushStage:
          'scheduled',
        
        dispatchUpdatedAt:
          admin.firestore.FieldValue.serverTimestamp(),

        riderId: '',
        riderLineUserId: '',
        riderDocId: '',
        riderName: '',
        riderPhone: '',

        acceptedAt: null,

        // 原承接小U的任務追蹤到此結束；保留最後位置供調度追溯。
        riderTrackingStatus: 'stopped',
        trackingEndedAtMs: nowMs,
        trackingEndedAt: admin.firestore.FieldValue.serverTimestamp(),
        trackingUpdatedAtMs: nowMs,
        trackingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        trackingStopReason: 'transferred',

        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),

        'statusTimes.transferred':
          admin.firestore.FieldValue.serverTimestamp(),

        ...getEtaPayloadByStatus('pending_dispatch'),
      };

      if (riderSkipKeys.length) {
        transferUpdateData.skippedRiderIds =
          admin.firestore.FieldValue.arrayUnion(
            ...riderSkipKeys
          );
      }

      transaction.update(
        orderRef,
        transferUpdateData
      );

      transaction.set(
        riderRef,
        {
          busy: false,
          currentOrderId: '',
          lastActive: nowMs,

          activeTrackingOrderId: '',
          activeTrackingSessionId: '',
          taskTrackingStatus: 'stopped',
          taskTrackingUpdatedAtMs: nowMs,
          taskTrackingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          taskTrackingStopReason: 'transferred',

          updatedAt:
            admin.firestore.FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        }
      );

      transferredOrder = {
        ...order,

        id: safeOrderId,

        status: 'pending_dispatch',
        riderStatus: 'pending_dispatch',

        riderId: '',
        riderLineUserId: '',
        riderDocId: '',
        riderName: '',
        riderPhone: '',

        acceptedAt: null,

        previousRiderLineUserId:
          identity.lineUserId || '',

        previousRiderDocId:
          identity.riderDocId || '',

        previousRiderId:
          identity.riderId || '',

        previousRiderName:
          rider.name ||
          rider.riderName ||
          '',

        previousRiderPhone:
          identity.phone ||
          rider.phone ||
          '',

        transferReason: safeReason,

        transferRequestedAtMs: nowMs,

        dispatchStartedAtMs: nowMs,

        redispatchStartedAtMs: nowMs,

        dispatchPushCycleId:
          redispatchPushCycleId,

        dispatchPushNotifiedRiderDocIds:
          [],

        dispatchPushStage:
          'scheduled',
        
        skippedRiderIds: Array.from(
          new Set([
            ...(
              Array.isArray(order.skippedRiderIds)
                ? order.skippedRiderIds
                : []
            ),
            ...riderSkipKeys,
          ])
        ),
      };
    });

    orders[safeOrderId] = transferredOrder;

            try {
      await startDispatchPushSequence(
        transferredOrder,
        redispatchPushCycleId
      );

      await orderRef.set(
        {
          redispatchPushSentAt:
            admin.firestore.FieldValue
              .serverTimestamp(),

          redispatchPushCycleId:
            redispatchPushCycleId,
        },
        {
          merge: true,
        }
      );

    } catch (pushErr) {
      console.error(
        '⚠️ 任務已成功轉派，但重新分段派單失敗：',
        pushErr
      );
    }
    
    Promise.allSettled([
      logDispatchEvent({
        type:'RIDER_TRANSFERRED',
        orderId:safeOrderId,
        riderId:identity.riderId,
        riderDocId:identity.riderDocId,
        reason:safeReason,
        createdAtMs:Date.now(),
      }),
      updateRiderDispatchStats(identity.riderId, { transferredOrders:1 }),
    ]).catch(()=>{});

    return res.json({
      success: true,

      orderId: safeOrderId,

      status: 'pending_dispatch',

      order: transferredOrder,

      message:
        '已取消目前承接，任務正在轉派給其他騎士。',
    });

  } catch (error) {
    console.error(
      '❌ 騎士取消／轉派失敗：',
      error
    );

    if (error.message === 'ORDER_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        message: '找不到此訂單。',
      });
    }

    if (error.message === 'NOT_YOUR_ORDER') {
      return res.status(403).json({
        success: false,
        message:
          '此訂單不是你目前承接的任務。',
      });
    }

    if (error.message === 'ORDER_ALREADY_STARTED') {
      return res.status(409).json({
        success: false,
        message:
          '任務已開始執行，不能直接取消／轉派。請改用安全中心回報 UBee。',
      });
    }

    return res.status(500).json({
      success: false,

      message:
        '取消／轉派失敗，請稍後再試。',

      error: error.message,
    });
  }
});

// ===== UBee Rider 任務執行 V2.3 TRUE Dock Only API 協作層 =====
// 本版後端狀態機不變；前端新增完成任務後 UI Reset，確保五大 Tab 與一般接單畫面恢復。
// 前端已真正刪除舊 Navigation HUD / V2.4 Context / Next Step 視覺層；後端狀態機維持不變。
// 前端已統一為底部單一 Task Dock；本後端維持既有正式狀態機與導航階段欄位。
// 狀態主流程：accepted -> arrived_pickup -> picked_up -> arrived_dropoff -> completed
// 前端各階段維持單一主 CTA；後端持續以狀態機驗證，不允許跳階。
// ===== 騎士更新任務狀態 API =====
// 4. 更新任務狀態：手機登入正式版
// 支援 phone / riderId，並保留 lineUserId 相容
app.post('/api/rider/update-order-status', riderAuthMiddleware, async (req, res) => {
  try {
    const { orderId, status, lineUserId, phone, riderId } = req.body || {};

    if (!orderId || !status) {
      return res.status(400).json({
        success: false,
        message: '缺少訂單編號或任務狀態。',
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

    const riderResult = await findApprovedRiderForApi({
      lineUserId,
      phone,
      riderId,
    });

    if (!riderResult.ok) {
      return res.status(riderResult.statusCode).json({
        success: false,
        message: riderResult.message || '找不到可更新任務的騎士身分。',
      });
    }

    const riderDoc = riderResult.riderDoc;
    const rider = riderResult.rider || {};

    const identity = buildRiderApiIdentity(riderDoc, rider, {
      lineUserId,
      phone,
      riderId,
    });

    const safeOrderId = String(orderId).toUpperCase();
    const orderRef = db.collection('orders').doc(safeOrderId);
    const riderRef = db.collection('riders').doc(riderDoc.id);

    let updatedOrder = null;
    let multiStopAdvanced = false;
    let completedStopNumber = 0;
    let nextStopNumber = 0;

    await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);

      if (!orderDoc.exists) {
        throw new Error('ORDER_NOT_FOUND');
      }

      const order = orderDoc.data() || {};
      const currentStatus = String(order.status || '').trim();

      if (!isOrderBelongsToRider(order, identity)) {
        throw new Error('NOT_THIS_RIDER');
      }

      if (currentStatus === status) {
        updatedOrder = {
          ...order,
          id: safeOrderId,
          status,
        };
        return;
      }

      if (currentStatus === 'completed' && status === 'completed') {
        updatedOrder = {
          ...order,
          id: safeOrderId,
          status: 'completed',
        };
        return;
      }

      const nextStatuses = allowedFlow[currentStatus] || [];

      if (!nextStatuses.includes(status)) {
        throw new Error('INVALID_TRANSITION');
      }

      // 多點配送：完成目前送達點時，如果後面還有站點，
      // 不結束整張任務，而是切換到下一個送達點。
      const deliveryStops = Array.isArray(order.deliveryStops)
        ? order.deliveryStops.map(stop => ({ ...(stop || {}) }))
        : [];
      const currentDeliveryStopIndex = Math.max(
        0,
        Math.min(
          deliveryStops.length ? deliveryStops.length - 1 : 0,
          Number(order.currentDeliveryStopIndex || 0)
        )
      );
      const shouldAdvanceMultiStop =
        status === 'completed' &&
        currentStatus === 'arrived_dropoff' &&
        deliveryStops.length > 1 &&
        currentDeliveryStopIndex < deliveryStops.length - 1;

      if (shouldAdvanceMultiStop) {
        const nowMs = Date.now();
        const nextIndex = currentDeliveryStopIndex + 1;
        const currentStop = deliveryStops[currentDeliveryStopIndex] || {};
        const nextStop = deliveryStops[nextIndex] || {};

        deliveryStops[currentDeliveryStopIndex] = {
          ...currentStop,
          status: 'completed',
          completedAtMs: nowMs,
        };
        deliveryStops[nextIndex] = {
          ...nextStop,
          status: 'current',
          arrivedAtMs: 0,
        };

        const nextEtaPayload = getEtaPayloadByStatus('picked_up');
        const updateData = {
          status: 'picked_up',
          riderStatus: 'picked_up',
          riderId: identity.riderId,
          riderDocId: identity.riderDocId,
          riderPhone: identity.phone,
          riderLineUserId: identity.lineUserId || '',
          deliveryStops,
          currentDeliveryStopIndex: nextIndex,
          completedDeliveryStopCount: nextIndex,
          lastCompletedDeliveryStopIndex: currentDeliveryStopIndex,
          lastCompletedDeliveryStopAtMs: nowMs,
          lastCompletedDeliveryStopAt:
            admin.firestore.FieldValue.serverTimestamp(),
          customerName:
            nextStop.customerName || nextStop.receiverName || '',
          receiverName:
            nextStop.customerName || nextStop.receiverName || '',
          customerPhone:
            nextStop.customerPhone || nextStop.dropoffPhone || '',
          dropoffPhone:
            nextStop.customerPhone || nextStop.dropoffPhone || '',
          dropoffAddress:
            nextStop.dropoffAddress || nextStop.dropoff || '',
          dropoff:
            nextStop.dropoffAddress || nextStop.dropoff || '',
          itemName:
            nextStop.itemName || nextStop.item || order.itemName || '',
          item:
            nextStop.itemName || nextStop.item || order.item || '',
          currentStopNote: nextStop.note || '',
          arrivedDropoffAt: null,
          riderTrackingStatus: 'live',
          trackingUpdatedAtMs: nowMs,
          trackingUpdatedAt:
            admin.firestore.FieldValue.serverTimestamp(),
          updatedAt:
            admin.firestore.FieldValue.serverTimestamp(),
          updatedAtMs: nowMs,
          'statusTimes.next_stop_started':
            admin.firestore.FieldValue.serverTimestamp(),
          ...nextEtaPayload,
        };

        transaction.update(orderRef, updateData);
        transaction.set(riderRef, {
          busy: true,
          currentOrderId: safeOrderId,
          lastActive: nowMs,
          activeTrackingOrderId: safeOrderId,
          taskTrackingStatus: 'live',
          taskTrackingUpdatedAtMs: nowMs,
          taskTrackingUpdatedAt:
            admin.firestore.FieldValue.serverTimestamp(),
          updatedAt:
            admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        multiStopAdvanced = true;
        completedStopNumber = currentDeliveryStopIndex + 1;
        nextStopNumber = nextIndex + 1;
        updatedOrder = {
          ...order,
          ...updateData,
          id: safeOrderId,
          status: 'picked_up',
          riderStatus: 'picked_up',
        };
        return;
      }

      const etaPayload = getEtaPayloadByStatus(status);

      const updateData = {
        status,
        riderStatus: status,

        // 保留目前任務歸屬資訊，避免後續查詢不到
        riderId: identity.riderId,
        riderDocId: identity.riderDocId,
        riderPhone: identity.phone,
        riderLineUserId: identity.lineUserId || '',

        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        [`statusTimes.${status}`]: admin.firestore.FieldValue.serverTimestamp(),

        // 任務未完成前 tracking session 持續有效；完成才正式停止。
        riderTrackingStatus: status === 'completed' ? 'stopped' : 'live',
        trackingUpdatedAtMs: Date.now(),
        trackingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
...etaPayload,
      };

      if (status === 'completed') {
        updateData.trackingEndedAtMs = Date.now();
        updateData.trackingEndedAt = admin.firestore.FieldValue.serverTimestamp();
        updateData.trackingStopReason = 'completed';
      }

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
  const isCashOrder =
    isCashPaymentOrder(order);

  updateData.completedAt =
    admin.firestore.FieldValue
      .serverTimestamp();

  updateData.finishedAt =
    admin.firestore.FieldValue
      .serverTimestamp();

  // ==============================
  // 現金訂單
  //
  // 客人的款項由騎士收取，
  // 騎士之後需要把平台收入繳回平台。
  // ==============================
  if (isCashOrder) {
    updateData.isCashOrder = true;

    // 現金單不是平台撥款給騎士
    updateData.settlementStatus =
      'not_applicable';

    updateData.settledAt = null;

    // 建立現金回繳狀態
    updateData.cashRemittanceStatus =
      'pending';

    updateData.cashRemittedAt = null;

    updateData.cashRemittedBy = '';

    updateData.cashRemittedAmount = 0;
  }

  // ==============================
  // 非現金訂單
  //
  // 款項由平台收取，
  // 平台之後需要撥款給騎士。
  // ==============================
  else {
    updateData.isCashOrder = false;

    // 建立平台待撥款狀態
    updateData.settlementStatus =
      'pending';

    updateData.settledAt = null;

    // 非現金單不需要騎士回繳
    updateData.cashRemittanceStatus =
      'not_applicable';

    updateData.cashRemittedAt = null;

    updateData.cashRemittedBy = '';

    updateData.cashRemittedAmount = 0;
  }
}
    
      transaction.update(orderRef, updateData);

      if (status === 'completed') {
        transaction.set(riderRef, {
          busy: false,
          currentOrderId: '',
          lastActive: Date.now(),
          activeTrackingOrderId: '',
          activeTrackingSessionId: '',
          taskTrackingStatus: 'stopped',
          taskTrackingUpdatedAtMs: Date.now(),
          taskTrackingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          taskTrackingStopReason: 'completed',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } else {
        transaction.set(riderRef, {
          busy: true,
          currentOrderId: safeOrderId,
          lastActive: Date.now(),
          activeTrackingOrderId: safeOrderId,
          taskTrackingStatus: 'live',
          taskTrackingUpdatedAtMs: Date.now(),
          taskTrackingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      updatedOrder = {
        ...order,
        ...updateData,
        id: safeOrderId,
        status,
        riderStatus: status,
      };
    });

    const effectiveStatus = String(
      updatedOrder?.status || status
    ).trim();

    orders[safeOrderId] = updatedOrder;

    const statusEventType = effectiveStatus === 'completed'
      ? 'ORDER_COMPLETED'
      : multiStopAdvanced
        ? 'ORDER_MULTI_STOP_ADVANCED'
        : `ORDER_STATUS_${String(effectiveStatus || '').toUpperCase()}`;
    const statusEventTasks = [
      logDispatchEvent({
        type:statusEventType,
        orderId:safeOrderId,
        riderId:identity.riderId,
        riderDocId:identity.riderDocId,
        status:effectiveStatus,
        createdAtMs:Date.now(),
      })
    ];
    if (effectiveStatus === 'completed') {
      statusEventTasks.push(updateRiderDispatchStats(identity.riderId, { completedOrders:1, lastCompletedAtMs:Date.now() }));
    }
    Promise.allSettled(statusEventTasks).catch(()=>{});

    try {
      await notifyCustomer(
        updatedOrder,
        createTextMessage(
          multiStopAdvanced
            ? `UBee 跑腿多點配送更新\n\n訂單編號：${updatedOrder.id}\n第 ${completedStopNumber} 點已完成，準備前往第 ${nextStopNumber} 點。`
            : `UBee 跑腿任務狀態更新\n\n訂單編號：${updatedOrder.id}\n目前狀態：${getStatusLabel(effectiveStatus)}`
        )
      );
    } catch (notifyErr) {
      console.error('⚠️ 任務狀態已更新，但通知客人失敗：', notifyErr);
    }

    if (effectiveStatus === 'completed') {
      try {
        // UBee 明確規則：店家派單完成資訊不得推送到騎士審核／完成群組。
        // 店家單仍正常保存完成、財務與調度資料，只是不做此群組通知。
        if (
          LINE_FINISH_GROUP_ID &&
          !isMerchantOrderRecord(updatedOrder)
        ) {
          await pushToGroup(
            LINE_FINISH_GROUP_ID,
            createFinanceFlex(updatedOrder)
          );
        } else if (isMerchantOrderRecord(updatedOrder)) {
          console.log(
            `✅ 店家派單完成，不推送騎士審核／完成群組：${safeOrderId}`
          );
        }
      } catch (finishErr) {
        console.error('⚠️ 任務已完成，但推送財務明細失敗：', finishErr);
      }
    }

    return res.json({
      success: true,
      orderId: safeOrderId,
      status: effectiveStatus,
      statusLabel: getStatusLabel(effectiveStatus),
      order: updatedOrder,
      multiStopAdvanced,
      completedStopNumber,
      nextStopNumber,
      message: multiStopAdvanced
        ? `第 ${completedStopNumber} 個送達點已完成，請前往第 ${nextStopNumber} 點。`
        : '任務狀態已更新',
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
        message: '你不是此任務的接單騎士，無法更新狀態。',
      });
    }

    if (error.message === 'INVALID_TRANSITION') {
      return res.status(409).json({
        success: false,
        message: '任務狀態順序錯誤，請依照接單流程逐步更新。',
      });
    }

    return res.status(500).json({
      success: false,
      message: '任務狀態更新失敗，請稍後再試。',
      error: error.message,
    });
  }
});

app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const orderId =
      String(
        req.params.orderId || ''
      )
        .trim()
        .toUpperCase();

    const requestUserId =
      String(
        req.query.userId || ''
      ).trim();

    const order =
      await getOrder(orderId);

    if (!order) {
      return res
        .status(404)
        .json({
          success: false,
          error:
            '查無此訂單',
        });
    }

    if (
      requestUserId &&
      !isSameCustomerUserId(
        order,
        requestUserId
      )
    ) {
      return res
        .status(403)
        .json({
          success: false,
          error:
            '此訂單只能由原本下單的客人查詢',
        });
    }

    const riderCurrentLat =
      Number(
        order.riderCurrentLat ??
        order.riderCurrentLocation?.lat
      );

    const riderCurrentLng =
      Number(
        order.riderCurrentLng ??
        order.riderCurrentLocation?.lng
      );

    return res.json({
      success: true,

      order: {
        id:
          order.id,

        status:
          order.status,

        riderStatus:
          order.riderStatus ||
          order.status,

        statusLabel:
          getStatusLabel(
            order.status
          ),

        speedType:
          order.speedType,

        speedLabel:
          getSpeedOption(
            order.speedType
          ).label,

        pickupAddress:
          order.pickupAddress,

        dropoffAddress:
          order.dropoffAddress,

        pickupLat:
          order.pickupLat ??
          null,

        pickupLng:
          order.pickupLng ??
          null,

        dropoffLat:
          order.dropoffLat ??
          null,

        dropoffLng:
          order.dropoffLng ??
          null,

        etaMinutes:
          order.etaMinutes,

        etaText:
          order.etaText ||
          order.estimatedTime ||
          '',

        total:
          order.total,

        isPaid:
          order.isPaid,

        paymentMethod:
          order.paymentMethod,

        paymentMethodLabel:
          getPaymentMethodLabel(
            order.paymentMethod
          ),

        // ============================
        // 小U即時定位
        // ============================
        riderCurrentLat:
          Number.isFinite(
            riderCurrentLat
          )
            ? riderCurrentLat
            : null,

        riderCurrentLng:
          Number.isFinite(
            riderCurrentLng
          )
            ? riderCurrentLng
            : null,

        riderCurrentLocation:
          order.riderCurrentLocation ||
          null,

        riderLocationUpdatedAtMs:
          Number(
            order.riderLocationUpdatedAtMs ||
            0
          ),

        riderHeading:
          order.riderHeading ??
          null,

        riderSpeed:
          order.riderSpeed ??
          null,

        riderLocationAccuracy:
          order.riderLocationAccuracy ??
          null,
      },
    });

  } catch (err) {
    console.error(
      '❌ 讀取客人訂單失敗：',
      err
    );

    return res
      .status(500)
      .json({
        success: false,
        error:
          '讀取訂單失敗',
      });
  }
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
`🎉 您的 UBee 跑腿商務合作申請已通過初步審核

公司 / 店家：${business.companyName}

請先加入 UBee 跑腿店家官方帳號：
${MERCHANT_OA_LINK}

加入後請傳送：
我是店家｜${business.companyName}

UBee 跑腿辦公室將會再依照您的需求，
主動與您聯繫並安排後續合作內容。

感謝您使用 UBee 跑腿 🐝`
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
    const application = await getRiderOrReply(
      event.replyToken,
      riderId
    );
    if (!application) return null;

    if (
      application.approved === true ||
      application.reviewStatus === 'approved' ||
      ['approved', 'training', 'active'].includes(
        String(application.status || '').toLowerCase()
      )
    ) {
      return replyText(
        event.replyToken,
        '此小U已經通過審核，不需要重複操作。'
      );
    }

    if (application.status === 'rejected') {
      return replyText(
        event.replyToken,
        '此騎士申請已被拒絕，不能再直接通過。'
      );
    }

    if (application.documentsComplete !== true) {
      return replyText(
        event.replyToken,
        '此新版申請的證件尚未完整，暫時不能通過審核。'
      );
    }

    const approvedRider = buildApprovedRiderV2(
      application,
      userId
    );

    await saveRiderV2(approvedRider, {
      mirrorLegacy: true,
    });

    await db
      .collection(RIDER_V2_COLLECTIONS.applications)
      .doc(approvedRider.riderId)
      .set({
        status: 'training',
        reviewStatus: 'approved',
        lifecycleStatus: RIDER_V4_LIFECYCLE.TRAINING,
        canAcceptOrders: false,
        onboardingRequired: true,
        approved: true,
        documentReviewStatus: 'approved',
        officialRiderCollection: RIDER_V2_COLLECTIONS.riders,
        officialRiderId: approvedRider.riderId,
        approvedAt: approvedRider.approvedAt,
        approvedBy: userId,
        reviewedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        reviewedAtMs: Date.now(),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        updatedAtMs: Date.now(),
      }, { merge: true });

    if (approvedRider.lineUserId) {
      await client.pushMessage(approvedRider.lineUserId, {
        type: 'text',
        text:
          `🎉 恭喜您通過 UBee 跑腿新版小U審核！\n\n` +
          `請點擊下方連結進入 UBee 騎士端：\n\n` +
          `${RIDER_WEB_URL}\n\n` +
          `登入後，請依照騎士端畫面完成後續設定與數位入職流程。\n\n` +
          `— UBee 跑腿`
      });
    }

    return replyText(
      event.replyToken,
      `✅ 已通過新版小U審核\n\n` +
      `姓名：${approvedRider.name}\n` +
      `申請編號：${approvedRider.riderId}\n` +
      `正式資料：${RIDER_V2_COLLECTIONS.riders}`
    );
  }

  if (data.startsWith('rejectRider=')) {
    const permitted = await requireAdminPermission(event, '騎士審核');
    if (!permitted) return null;

    const riderId = getPostbackValue(data, 'rejectRider');
    const application = await getRiderOrReply(
      event.replyToken,
      riderId
    );
    if (!application) return null;

    if (
      application.approved === true ||
      application.reviewStatus === 'approved' ||
      ['approved', 'training', 'active'].includes(
        String(application.status || '').toLowerCase()
      )
    ) {
      return replyText(
        event.replyToken,
        '此小U已通過審核，不能直接拒絕。'
      );
    }

    if (application.status === 'rejected') {
      return replyText(
        event.replyToken,
        '此騎士申請已經被拒絕，不需要重複操作。'
      );
    }

    await db
      .collection(RIDER_V2_COLLECTIONS.applications)
      .doc(riderId)
      .set({
        status: 'rejected',
        reviewStatus: 'rejected',
        lifecycleStatus: RIDER_V4_LIFECYCLE.REJECTED,
        canAcceptOrders: false,
        approved: false,
        rejectedAt: Date.now(),
        rejectedBy: userId,
        reviewedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        reviewedAtMs: Date.now(),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        updatedAtMs: Date.now(),
      }, { merge: true });

    return replyText(
      event.replyToken,
      `已拒絕新版小U申請\n\n` +
      `姓名：${application.name}\n` +
      `申請編號：${riderId}`
    );
  }

  if (data.startsWith('forceCancel=')) {
    const orderId = getPostbackValue(data, 'forceCancel');
    return handleAdminForceCancel(
      event,
      orderId,
      'admin_force_cancel_button',
      '強制取消只能在 UBee 跑腿辦公室審核群組操作。'
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
  createTextMessage(
    `✅ 已確認建立訂單：${order.id}\n\n` +
    `目前 UBee 跑腿先開放現金單。\n` +
    `請回到下單頁面確認使用現金單，確認後系統才會開始媒合騎士。`
  ),
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
      createTextMessage(`🔵 UBee 跑腿騎士已完成取件\n\n訂單編號：${order.id}\n正在前往送達地點。`)
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
      createTextMessage(`🟣 UBee 跑腿騎士已抵達送達地點\n\n訂單編號：${order.id}`)
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
      createTextMessage(`✅ UBee 跑腿任務已完成\n\n訂單編號：${order.id}\n感謝你使用 UBee 跑腿。`)
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

    // 舊 LINE 控制流程同樣遵守：店家派單完成後不推送騎士審核／完成群組。
    if (LINE_FINISH_GROUP_ID && !isMerchantOrderRecord(order)) {
      await pushToGroup(
        LINE_FINISH_GROUP_ID,
        createFinanceFlex(order)
      );
    }

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

    await replyText(event.replyToken, `✅ 已同意加收等候費 $${PRICING.waitingFee}\n\n訂單編號：${order.id}`);
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

  if (normalized === '快速估價' || normalized === '最新優惠') {
    return replyMessages(event.replyToken, [
      {
        type: 'template',
        altText: 'UBee 跑腿快速估價',
        template: {
          type: 'buttons',
          title: 'UBee 跑腿快速估價',
          text: '想先知道跑腿大約多少錢？點選下方按鈕，選擇服務項目與任務地點，系統會協助試算費用。',
          actions: [
            {
              type: 'uri',
              label: '開始快速估價',
              uri: 'https://ubee-line-bot-2-zezw.onrender.com/estimate.html'
            }
          ]
        }
      }
    ]);
  }

  if (normalized === '服務範圍') {
  return replyMessages(event.replyToken, [
    {
      type: 'template',
      altText: 'UBee 跑腿服務範圍',
      template: {
        type: 'buttons',
        title: 'UBee 跑腿服務服務範圍',
        text: '查看 UBee 跑腿目前主要服務區域、可承接任務類型與下單前注意事項。',
        actions: [
          {
            type: 'uri',
            label: '查看服務範圍',
            uri: 'https://ubee-line-bot-2-zezw.onrender.com/service-area.html'
          },
          {
            type: 'uri',
            label: '快速估價',
            uri: 'https://ubee-line-bot-2-zezw.onrender.com/estimate.html'
          }
        ]
      }
    }
  ]);
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
  createTextMessage('歡迎使用 UBee 跑腿 🐝'),
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


// ============================================================
// UBee 調度中心 V4：人工調度寫入 API
// 依賴既有核心函式：
// - findApprovedRiderForApi()
// - buildRiderApiIdentity()
// - isRiderVisibleDispatchOrder()
// - getEtaPayloadByStatus()
// - buildDispatchPushCycleId()
// - clearDispatchPushTimers()
// - startDispatchPushSequence()
// - runDispatchPushWave()
// - notifyCustomer()
// - createTextMessage()
//
// 重要原則：
// 1. 不建立第二套派單核心。
// 2. 指定小U沿用騎士接單的 Transaction 安全模型。
// 3. 重新派單沿用既有多層級 dispatch cycle。
// 4. 擴大半徑沿用既有 runDispatchPushWave()，避免重複通知。
// ============================================================

function normalizeDispatchRadiusKm(value, fallback = 3) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  const allowed = [2, 3, 5, 8, 10, 12, 15, 17, 20];

  if (allowed.includes(n)) {
    return n;
  }

  // 前端目前有 2 / 3 / 5 / 8 / 12 / 20，
  // 後端只允許固定安全級距，避免任意超大範圍。
  return fallback;
}

function getDispatchApiErrorResponse(error) {
  const code = String(error?.message || '').trim();

  const map = {
    ORDER_NOT_FOUND: [404, '找不到此訂單。'],
    RIDER_NOT_FOUND: [404, '找不到指定的小U。'],
    ORDER_NOT_DISPATCHABLE: [409, '此訂單目前已不是待派單狀態，請重新整理調度中心。'],
    ORDER_PAYMENT_NOT_CONFIRMED: [409, '此訂單尚未符合可派送條件。'],
    RIDER_OFFLINE: [409, '這位小U目前已離線，請重新選擇其他小U。'],
    RIDER_ALREADY_BUSY: [409, '這位小U目前已有進行中的任務，請重新選擇。'],
    RIDER_ALREADY_ASSIGNED: [409, '此訂單已經被其他小U接走。'],
    ORDER_RECOVERY_NOT_ALLOWED: [409, '此任務目前不符合安全備援轉派條件，請重新整理後確認。'],
    ORDER_CUSTODY_RISK: [409, '此任務已到達取件或取件後階段，可能已發生貨物交接，禁止直接轉派。請先聯絡小U並人工處置。'],
  };

  if (map[code]) {
    return {
      status: map[code][0],
      body: {
        success: false,
        code,
        message: map[code][1],
      },
    };
  }

  return {
    status: 500,
    body: {
      success: false,
      code: code || 'DISPATCH_INTERNAL_ERROR',
      message: '調度操作失敗，請稍後再試。',
    },
  };
}


// ------------------------------------------------------------
// 1. 人工指定小U
// POST /api/dispatch/orders/:orderId/assign
//
// body:
// {
//   riderId: "09xxxxxxxx",
//   source: "dispatch_center"
// }
// ------------------------------------------------------------
app.post('/api/dispatch/orders/:orderId/assign', async (req, res) => {
  try {
    const safeOrderId = String(req.params.orderId || '')
      .trim()
      .toUpperCase();

    const requestedRiderId = String(
      req.body?.riderId || ''
    ).trim();

    if (!safeOrderId) {
      return res.status(400).json({
        success: false,
        message: '缺少訂單編號。',
      });
    }

    if (!requestedRiderId) {
      return res.status(400).json({
        success: false,
        message: '缺少指定小U資料。',
      });
    }

    const riderResult = await findApprovedRiderForApi({
      riderId: requestedRiderId,
    });

    if (!riderResult.ok) {
      return res.status(riderResult.statusCode || 404).json({
        success: false,
        message: riderResult.message || '找不到指定的小U。',
      });
    }

    const riderDoc = riderResult.riderDoc;
    const rider = riderResult.rider || {};

    const identity = buildRiderApiIdentity(
      riderDoc,
      rider,
      {
        riderId: requestedRiderId,
      }
    );

    const orderRef = db
      .collection('orders')
      .doc(safeOrderId);

    const riderRef = db
      .collection('riders')
      .doc(riderDoc.id);

    const nowMs = Date.now();
    const trackingSessionId =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');
    let assignedOrder = null;

    await db.runTransaction(async transaction => {
      const orderDoc = await transaction.get(orderRef);

      if (!orderDoc.exists) {
        throw new Error('ORDER_NOT_FOUND');
      }

      const latestRiderDoc =
        await transaction.get(riderRef);

      if (!latestRiderDoc.exists) {
        throw new Error('RIDER_NOT_FOUND');
      }

      const order = orderDoc.data() || {};
      const latestRider =
        latestRiderDoc.data() || {};

      const currentStatus =
        String(order.status || '').trim();

      if (currentStatus !== 'pending_dispatch') {
        if (
          currentStatus === 'accepted' ||
          String(order.riderId || '').trim() ||
          String(order.riderDocId || '').trim()
        ) {
          throw new Error('RIDER_ALREADY_ASSIGNED');
        }

        throw new Error('ORDER_NOT_DISPATCHABLE');
      }

      if (!isRiderVisibleDispatchOrder(order)) {
        throw new Error(
          'ORDER_PAYMENT_NOT_CONFIRMED'
        );
      }

      // 人工指定仍要求小U在線。
      // 不用「候選畫面的舊資料」做最終判定，
      // Transaction 內再次讀取 riders 文件。
      if (latestRider.online !== true) {
        throw new Error('RIDER_OFFLINE');
      }

      if (
        latestRider.busy === true &&
        String(
          latestRider.currentOrderId || ''
        ).trim() &&
        String(
          latestRider.currentOrderId || ''
        ).trim().toUpperCase() !== safeOrderId
      ) {
        const oldOrderId = String(
          latestRider.currentOrderId || ''
        )
          .trim()
          .toUpperCase();

        const oldOrderRef = db
          .collection('orders')
          .doc(oldOrderId);

        const oldOrderDoc =
          await transaction.get(oldOrderRef);

        if (oldOrderDoc.exists) {
          const oldOrder =
            oldOrderDoc.data() || {};

          if (
            !['completed', 'cancelled']
              .includes(
                String(oldOrder.status || '')
                  .trim()
              )
          ) {
            throw new Error(
              'RIDER_ALREADY_BUSY'
            );
          }
        }
      }

      const acceptedEtaPayload =
        getEtaPayloadByStatus('accepted');

      const assignUpdateData = {
        status: 'accepted',
        riderStatus: 'accepted',

        riderId: identity.riderId,
        riderDocId: identity.riderDocId,
        riderPhone: identity.phone,
        riderLineUserId:
          identity.lineUserId || '',

        riderName:
          rider.name ||
          rider.riderName ||
          '',

        acceptedAt:
          admin.firestore.FieldValue
            .serverTimestamp(),

        updatedAt:
          admin.firestore.FieldValue
            .serverTimestamp(),

        'statusTimes.accepted':
          admin.firestore.FieldValue
            .serverTimestamp(),

        // 調度中心追蹤欄位
        assignedByDispatch: true,
        dispatchAssignedRiderId:
          identity.riderId,
        dispatchAssignedRiderDocId:
          identity.riderDocId,
        dispatchAssignedAtMs:
          nowMs,
        dispatchAssignedAt:
          admin.firestore.FieldValue
            .serverTimestamp(),
        dispatchAssignedSource:
          String(
            req.body?.source ||
            'dispatch_center'
          ).trim(),

        // 人工指定也建立同一套任務追蹤 session。
        trackingSessionId,
        riderTrackingStatus: 'starting',
        trackingStartedAtMs: nowMs,
        trackingStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        trackingUpdatedAtMs: nowMs,
        trackingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        trackingEndedAtMs: null,
        trackingEndedAt: null,
        trackingStopReason: '',

        ...acceptedEtaPayload,
      };

      transaction.update(
        orderRef,
        assignUpdateData
      );

      transaction.set(
        riderRef,
        {
          busy: true,
          currentOrderId: safeOrderId,
          lastActive: nowMs,
          activeTrackingOrderId: safeOrderId,
          activeTrackingSessionId: trackingSessionId,
          taskTrackingStatus: 'starting',
          taskTrackingUpdatedAtMs: nowMs,
          taskTrackingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt:
            admin.firestore.FieldValue
              .serverTimestamp(),
        },
        {
          merge: true,
        }
      );

      assignedOrder = {
        ...order,
        ...assignUpdateData,
        id: safeOrderId,
        status: 'accepted',
        riderStatus: 'accepted',
      };
    });

    // 訂單已被人工指定，停止舊派單波次。
    clearDispatchPushTimers(
      safeOrderId
    );

    // 舊記憶體快取同步。
    if (
      typeof orders === 'object' &&
      orders
    ) {
      orders[safeOrderId] =
        assignedOrder;
    }

    try {
      await notifyCustomer(
        assignedOrder,
        createTextMessage(
          `🟢 UBee 跑腿已為你安排小U\n\n` +
          `訂單編號：${safeOrderId}\n` +
          `小U將盡快前往取件。`
        )
      );
    } catch (notifyErr) {
      console.error(
        '⚠️ 調度指定成功，但通知客人失敗：',
        notifyErr
      );
    }

    Promise.allSettled([
      logDispatchEvent({
        type:'MANUAL_ASSIGN',
        orderId:safeOrderId,
        riderId:identity.riderId,
        riderDocId:identity.riderDocId,
        source:String(req.body?.source || 'dispatch_center'),
        createdAtMs:Date.now(),
      }),
      updateRiderDispatchStats(identity.riderId, { manualAssignments:1, lastAssignedAtMs:Date.now() }),
    ]).catch(()=>{});

    return res.json({
      success: true,
      orderId: safeOrderId,
      status: 'accepted',
      riderId: identity.riderId,
      riderDocId: identity.riderDocId,
      riderName:
        rider.name ||
        rider.riderName ||
        '',
      order: assignedOrder,
      message: '已成功指定小U。',
    });

  } catch (error) {
    console.error(
      '❌ UBee 調度中心指定小U失敗：',
      error
    );

    const result =
      getDispatchApiErrorResponse(error);

    return res
      .status(result.status)
      .json(result.body);
  }
});



// ------------------------------------------------------------
// V3. 進行中任務：人工確認後啟動備援轉派
// POST /api/dispatch/orders/:orderId/recover
//
// 安全邏輯：
// - 只允許 accepted / going_to_pickup / heading_to_pickup。
// - arrived_pickup 之後可能已發生貨物交接，禁止直接轉派。
// - 這個 API 只在調度中心人工確認後呼叫，不做無人值守強制轉派。
// ------------------------------------------------------------
app.post('/api/dispatch/orders/:orderId/recover', async (req, res) => {
  try {
    const safeOrderId = String(req.params.orderId || '').trim().toUpperCase();
    if (!safeOrderId) {
      return res.status(400).json({ success: false, message: '缺少訂單編號。' });
    }

    const requestedRadiusKm = normalizeDispatchRadiusKm(req.body?.radiusKm, 3);
    const safeReason = String(req.body?.reason || '調度中心 V3 異常備援轉派')
      .trim()
      .slice(0, 160);
    const source = String(req.body?.source || 'dispatch_center_v3').trim();
    const nowMs = Date.now();
    const newCycleId = buildDispatchPushCycleId(safeOrderId);
    const orderRef = db.collection('orders').doc(safeOrderId);
    let recoveredOrder = null;
    let previousRiderId = '';
    let previousRiderDocId = '';

    await db.runTransaction(async transaction => {
      const orderDoc = await transaction.get(orderRef);
      if (!orderDoc.exists) throw new Error('ORDER_NOT_FOUND');

      const order = orderDoc.data() || {};
      const currentStatus = String(order.status || '').trim();
      const recoverable = ['accepted', 'going_to_pickup', 'heading_to_pickup'];
      const custodyRisk = [
        'arrived_pickup', 'picked_up', 'going_to_dropoff',
        'heading_to_dropoff', 'arrived_dropoff', 'completed'
      ];

      if (custodyRisk.includes(currentStatus)) {
        throw new Error('ORDER_CUSTODY_RISK');
      }
      if (!recoverable.includes(currentStatus)) {
        throw new Error('ORDER_RECOVERY_NOT_ALLOWED');
      }

      previousRiderId = String(order.riderId || '').trim();
      previousRiderDocId = String(order.riderDocId || '').trim();
      const previousIdentity = {
        riderId: previousRiderId,
        riderDocId: previousRiderDocId,
        phone: normalizePhone(order.riderPhone || order.driverPhone || ''),
        lineUserId: String(order.riderLineUserId || '').trim(),
      };
      const riderSkipKeys = getRiderIdentityKeys(previousIdentity);

      let previousRiderRef = null;
      let previousRiderDoc = null;
      if (previousRiderDocId) {
        previousRiderRef = db.collection('riders').doc(previousRiderDocId);
        previousRiderDoc = await transaction.get(previousRiderRef);
      }

      const updateData = {
        status: 'pending_dispatch',
        riderStatus: 'pending_dispatch',
        previousRiderId,
        previousRiderDocId,
        previousRiderPhone: previousIdentity.phone || '',
        previousRiderLineUserId: previousIdentity.lineUserId || '',
        previousRiderName: String(order.riderName || order.driverName || ''),
        riderId: '',
        riderDocId: '',
        riderPhone: '',
        riderLineUserId: '',
        riderName: '',

        // 保留原小U最後位置作追溯，但清除目前任務位置，避免待派單畫面誤認仍由原小U執行。
        previousRiderLastLat: order.riderCurrentLat ?? order.riderCurrentLocation?.lat ?? null,
        previousRiderLastLng: order.riderCurrentLng ?? order.riderCurrentLocation?.lng ?? null,
        previousRiderLastLocationAtMs: getDispatchOrderTrackingAtMs(order) || null,
        riderCurrentLat: null,
        riderCurrentLng: null,
        riderCurrentLocation: null,
        riderLocationUpdatedAtMs: null,
        riderLocationUpdatedAt: null,

        acceptedAt: null,
        emergencyRecoveryReason: safeReason,
        emergencyRecoveryCount: admin.firestore.FieldValue.increment(1),
        emergencyRecoveryAtMs: nowMs,
        emergencyRecoveryAt: admin.firestore.FieldValue.serverTimestamp(),
        emergencyRecoverySource: source,
        dispatchStartedAtMs: nowMs,
        redispatchStartedAtMs: nowMs,
        dispatchPushCycleId: newCycleId,
        dispatchPushNotifiedRiderDocIds: [],
        dispatchPushStage: 'v3_emergency_redispatch_scheduled',
        dispatchManualRedispatchRadiusKm: requestedRadiusKm,
        riderTrackingStatus: 'stopped',
        trackingEndedAtMs: nowMs,
        trackingEndedAt: admin.firestore.FieldValue.serverTimestamp(),
        trackingUpdatedAtMs: nowMs,
        trackingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        trackingStopReason: 'dispatch_v3_emergency_recovery',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        dispatchUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        'statusTimes.emergency_redispatch': admin.firestore.FieldValue.serverTimestamp(),
        ...getEtaPayloadByStatus('pending_dispatch'),
      };

      if (riderSkipKeys.length) {
        updateData.skippedRiderIds = admin.firestore.FieldValue.arrayUnion(...riderSkipKeys);
      }

      transaction.update(orderRef, updateData);

      if (previousRiderRef && previousRiderDoc?.exists) {
        const previousRider = previousRiderDoc.data() || {};
        const currentOrderId = String(previousRider.currentOrderId || '').trim().toUpperCase();
        if (!currentOrderId || currentOrderId === safeOrderId) {
          transaction.set(previousRiderRef, {
            busy: false,
            currentOrderId: '',
            activeTrackingOrderId: '',
            activeTrackingSessionId: '',
            taskTrackingStatus: 'stopped',
            taskTrackingUpdatedAtMs: nowMs,
            taskTrackingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            taskTrackingStopReason: 'dispatch_v3_emergency_recovery',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      }

      recoveredOrder = {
        ...order,
        id: safeOrderId,
        status: 'pending_dispatch',
        riderStatus: 'pending_dispatch',
        riderId: '',
        riderDocId: '',
        riderPhone: '',
        riderLineUserId: '',
        riderName: '',
        riderCurrentLat: null,
        riderCurrentLng: null,
        riderCurrentLocation: null,
        riderLocationUpdatedAtMs: null,
        acceptedAt: null,
        previousRiderId,
        previousRiderDocId,
        skippedRiderIds: Array.from(new Set([
          ...(Array.isArray(order.skippedRiderIds) ? order.skippedRiderIds : []),
          ...riderSkipKeys,
        ])),
        dispatchPushCycleId: newCycleId,
        dispatchManualRedispatchRadiusKm: requestedRadiusKm,
        emergencyRecoveryReason: safeReason,
      };
    });

    clearDispatchPushTimers(safeOrderId);
    if (typeof orders === 'object' && orders) orders[safeOrderId] = recoveredOrder;

    try {
      await startDispatchPushSequence(recoveredOrder, newCycleId);
    } catch (pushError) {
      console.error('⚠️ V3 備援轉派已建立，但重新派單通知啟動失敗：', pushError);
    }

    try {
      await notifyCustomer(
        recoveredOrder,
        createTextMessage(
          `🟠 UBee 調度中心正在重新安排小U\n\n` +
          `訂單編號：${safeOrderId}\n` +
          `系統已啟動備援調度，將盡快重新安排配送夥伴。`
        )
      );
    } catch (notifyError) {
      console.error('⚠️ V3 備援轉派成功，但通知客人失敗：', notifyError);
    }

    Promise.allSettled([
      logDispatchEvent({
        type: 'EMERGENCY_REDISPATCH',
        orderId: safeOrderId,
        riderId: previousRiderId,
        riderDocId: previousRiderDocId,
        reason: safeReason,
        radiusKm: requestedRadiusKm,
        source,
        createdAtMs: nowMs,
      }),
      previousRiderId
        ? updateRiderDispatchStats(previousRiderId, { transferredOrders: 1 })
        : Promise.resolve(false),
    ]).catch(() => {});

    return res.json({
      success: true,
      orderId: safeOrderId,
      status: 'pending_dispatch',
      dispatchPushCycleId: newCycleId,
      radiusKm: requestedRadiusKm,
      message: '已啟動 V3 備援轉派，訂單重新進入智慧派單。',
    });
  } catch (error) {
    console.error('❌ UBee V3 備援轉派失敗：', error);
    const result = getDispatchApiErrorResponse(error);
    return res.status(result.status).json(result.body);
  }
});

// ------------------------------------------------------------
// 2. 人工重新派單
// POST /api/dispatch/orders/:orderId/redispatch
//
// body:
// {
//   radiusKm: 3,
//   source: "dispatch_center"
// }
// ------------------------------------------------------------
app.post('/api/dispatch/orders/:orderId/redispatch', async (req, res) => {
  try {
    const safeOrderId = String(
      req.params.orderId || ''
    )
      .trim()
      .toUpperCase();

    if (!safeOrderId) {
      return res.status(400).json({
        success: false,
        message: '缺少訂單編號。',
      });
    }

    const requestedRadiusKm =
      normalizeDispatchRadiusKm(
        req.body?.radiusKm,
        3
      );

    const orderRef = db
      .collection('orders')
      .doc(safeOrderId);

    const nowMs = Date.now();
    const newCycleId =
      buildDispatchPushCycleId(
        safeOrderId
      );

    let currentOrder = null;

    await db.runTransaction(
      async transaction => {
        const orderDoc =
          await transaction.get(orderRef);

        if (!orderDoc.exists) {
          throw new Error(
            'ORDER_NOT_FOUND'
          );
        }

        const order =
          orderDoc.data() || {};

        if (
          String(
            order.status || ''
          ).trim() !==
          'pending_dispatch'
        ) {
          throw new Error(
            'ORDER_NOT_DISPATCHABLE'
          );
        }

        if (
          !isRiderVisibleDispatchOrder(
            order
          )
        ) {
          throw new Error(
            'ORDER_PAYMENT_NOT_CONFIRMED'
          );
        }

        transaction.update(
          orderRef,
          {
            dispatchPushCycleId:
              newCycleId,

            dispatchPushNotifiedRiderDocIds:
              [],

            dispatchPushStage:
              'manual_redispatch_scheduled',

            dispatchManualRedispatchCount:
              admin.firestore.FieldValue
                .increment(1),

            dispatchManualRedispatchAtMs:
              nowMs,

            dispatchManualRedispatchAt:
              admin.firestore.FieldValue
                .serverTimestamp(),

            dispatchManualRedispatchRadiusKm:
              requestedRadiusKm,

            dispatchManualRedispatchSource:
              String(
                req.body?.source ||
                'dispatch_center'
              ).trim(),

            dispatchUpdatedAt:
              admin.firestore.FieldValue
                .serverTimestamp(),

            updatedAt:
              admin.firestore.FieldValue
                .serverTimestamp(),
          }
        );

        currentOrder = {
          id: safeOrderId,
          ...order,
          dispatchPushCycleId:
            newCycleId,
        };
      }
    );

    // 關閉舊週期，重新啟動正式既有多層級派單。
    clearDispatchPushTimers(
      safeOrderId
    );

    await startDispatchPushSequence(
      currentOrder,
      newCycleId
    );

    logDispatchEvent({
      type:'REDISPATCH',
      orderId:safeOrderId,
      radiusKm:requestedRadiusKm,
      source:String(req.body?.source || 'dispatch_center'),
      createdAtMs:Date.now(),
    }).catch(()=>{});

    return res.json({
      success: true,
      orderId: safeOrderId,
      status: 'pending_dispatch',
      dispatchPushCycleId:
        newCycleId,
      radiusKm:
        requestedRadiusKm,
      message:
        '已重新啟動派單。',
    });

  } catch (error) {
    console.error(
      '❌ UBee 調度中心重新派單失敗：',
      error
    );

    const result =
      getDispatchApiErrorResponse(error);

    return res
      .status(result.status)
      .json(result.body);
  }
});


// ------------------------------------------------------------
// 3. 人工擴大派單半徑
// POST /api/dispatch/orders/:orderId/expand-radius
//
// body:
// {
//   radiusKm: 8,
//   previousRadiusKm: 5,
//   source: "dispatch_center"
// }
// ------------------------------------------------------------
app.post('/api/dispatch/orders/:orderId/expand-radius', async (req, res) => {
  try {
    const safeOrderId = String(
      req.params.orderId || ''
    )
      .trim()
      .toUpperCase();

    if (!safeOrderId) {
      return res.status(400).json({
        success: false,
        message: '缺少訂單編號。',
      });
    }

    const radiusKm =
      normalizeDispatchRadiusKm(
        req.body?.radiusKm,
        3
      );

    const previousRadiusKm =
      normalizeDispatchRadiusKm(
        req.body?.previousRadiusKm,
        3
      );

    const orderRef = db
      .collection('orders')
      .doc(safeOrderId);

    let cycleId = '';
    const nowMs = Date.now();

    await db.runTransaction(
      async transaction => {
        const orderDoc =
          await transaction.get(orderRef);

        if (!orderDoc.exists) {
          throw new Error(
            'ORDER_NOT_FOUND'
          );
        }

        const order =
          orderDoc.data() || {};

        if (
          String(
            order.status || ''
          ).trim() !==
          'pending_dispatch'
        ) {
          throw new Error(
            'ORDER_NOT_DISPATCHABLE'
          );
        }

        if (
          !isRiderVisibleDispatchOrder(
            order
          )
        ) {
          throw new Error(
            'ORDER_PAYMENT_NOT_CONFIRMED'
          );
        }

        cycleId = String(
          order.dispatchPushCycleId ||
          buildDispatchPushCycleId(
            safeOrderId
          )
        ).trim();

        transaction.update(
          orderRef,
          {
            dispatchPushCycleId:
              cycleId,

            dispatchManualRadiusKm:
              radiusKm,

            dispatchManualPreviousRadiusKm:
              previousRadiusKm,

            dispatchManualRadiusExpandedAtMs:
              nowMs,

            dispatchManualRadiusExpandedAt:
              admin.firestore.FieldValue
                .serverTimestamp(),

            dispatchManualRadiusSource:
              String(
                req.body?.source ||
                'dispatch_center'
              ).trim(),

            dispatchUpdatedAt:
              admin.firestore.FieldValue
                .serverTimestamp(),

            updatedAt:
              admin.firestore.FieldValue
                .serverTimestamp(),
          }
        );
      }
    );

    // 直接沿用正式派單核心。
    // runDispatchPushWave() 會讀取
    // dispatchPushNotifiedRiderDocIds，
    // 因此已通知過的小U不會重複收到。
    const completed =
      await runDispatchPushWave(
        safeOrderId,
        cycleId,
        radiusKm,
        `${radiusKm}km`,
        false
      );

    if (!completed) {
      // 最常見原因：呼叫期間剛好已被接走。
      const latestDoc =
        await orderRef.get();

      const latestStatus =
        latestDoc.exists
          ? String(
              latestDoc.data()?.status ||
              ''
            ).trim()
          : '';

      if (
        latestStatus &&
        latestStatus !==
          'pending_dispatch'
      ) {
        return res.status(409).json({
          success: false,
          message:
            '此訂單剛剛已被接走或狀態已變更，請重新整理。',
        });
      }
    }

    logDispatchEvent({
      type:'RADIUS_EXPANDED',
      orderId:safeOrderId,
      radiusKm,
      previousRadiusKm,
      source:String(req.body?.source || 'dispatch_center'),
      createdAtMs:Date.now(),
    }).catch(()=>{});

    return res.json({
      success: true,
      orderId: safeOrderId,
      status: 'pending_dispatch',
      radiusKm,
      previousRadiusKm,
      dispatchPushCycleId:
        cycleId,
      message:
        `派單半徑已擴大至 ${radiusKm} km。`,
    });

  } catch (error) {
    console.error(
      '❌ UBee 調度中心擴大派單半徑失敗：',
      error
    );

    const result =
      getDispatchApiErrorResponse(error);

    return res
      .status(result.status)
      .json(result.body);
  }
});






// ============================================================
// UBee 第四階段：財務閉環 V4
// - 訂單級財務快照、付款狀態、人工調整、對帳與完整稽核軌跡
// - 不改動既有派單、騎士審核、重新轉派或店家完成通知規則
// ============================================================
const UBEE_FINANCE_ADJUSTABLE_FIELDS = Object.freeze({
  finalCustomerTotal: ['finalTotal', 'customerPayableTotal', 'payableTotal'],
  actualPaidAmount: ['actualPaidAmount', 'paidAmount', 'receivedAmount'],
  riderAdvance: ['advancePayment', 'advanceAmount'],
  riderIncome: ['riderIncome', 'riderFee', 'driverFee'],
  platformIncome: ['platformIncome', 'platformFee'],
  waitingFee: ['waitingFee'],
  upstairsFee: ['upstairsFee'],
  additionalFee: ['additionalFee'],
  cancellationFee: ['cancellationFee'],
  discountAmount: ['discountAmount'],
  refundAmount: ['refundAmount'],
});

function financeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function firstFinanceMoney(order = {}, fields = [], fallback = 0) {
  for (const field of fields) {
    const raw = order[field];
    if (raw === null || raw === undefined || raw === '') continue;
    const parsed = financeNumber(raw, NaN);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return Math.max(0, financeNumber(fallback, 0));
}

function normalizeFinancePaymentStatus(order = {}) {
  const raw = String(
    order.financePaymentStatus ||
    order.paymentStatus ||
    order.payStatus ||
    ''
  ).trim().toLowerCase();

  if (['paid', 'paid_confirmed', 'settled', 'completed'].includes(raw) || order.isPaid === true) {
    return 'paid';
  }
  if (['partial', 'partially_paid'].includes(raw)) return 'partial';
  if (['refunded', 'refund_completed'].includes(raw)) return 'refunded';
  if (['cancelled', 'void'].includes(raw)) return 'cancelled';
  if (isCashPaymentOrder(order)) {
    const orderStatus = String(order.status || '').trim().toLowerCase();
    return ['completed', 'done'].includes(orderStatus) ? 'cash_collected' : 'cash_pending';
  }
  return raw || 'unpaid';
}

function getFinanceInitialEstimate(order = {}) {
  return firstFinanceMoney(order, [
    'initialEstimatedTotal',
    'estimatedTotal',
    'estimateTotal',
    'quotedTotal',
    'initialTotal',
    'originalTotal',
    'estimatedPayableTotal',
    'serviceSubtotal',
    'totalFee',
  ], 0);
}

function getFinanceFinalCustomerTotal(order = {}) {
  return firstFinanceMoney(order, [
    'finalCustomerTotal',
    'finalTotal',
    'customerPayableTotal',
    'payableTotal',
    'customerPayAmount',
    'customerTotalWithAdvance',
    'collectAmount',
    'amountToCollect',
    'total',
  ], getOrderCustomerPayableTotal(order));
}

function getFinanceActualPaidAmount(order = {}, finalCustomerTotal = 0) {
  const fields = [
    'actualPaidAmount',
    'paidAmount',
    'receivedAmount',
    'customerPaidAmount',
    'cashCollectedAmount',
    'cashCollectAmount',
    'cashGrossCollected',
  ];

  for (const field of fields) {
    const raw = order[field];
    if (raw === null || raw === undefined || raw === '') continue;
    const parsed = financeNumber(raw, NaN);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  const paymentStatus = normalizeFinancePaymentStatus(order);
  if (['paid', 'cash_collected'].includes(paymentStatus)) return finalCustomerTotal;
  return 0;
}

function getFinanceFeeBreakdown(order = {}) {
  return {
    baseFee: firstFinanceMoney(order, ['baseFee', 'startFee', 'startingFee'], 0),
    distanceFee: firstFinanceMoney(order, ['distanceFee'], 0),
    timeFee: firstFinanceMoney(order, ['timeFee'], 0),
    platformServiceFee: firstFinanceMoney(order, ['platformServiceFee', 'serviceFee'], 0),
    waitingFee: firstFinanceMoney(order, ['waitingFee'], 0),
    upstairsFee: firstFinanceMoney(order, ['upstairsFee'], 0),
    speedFee: firstFinanceMoney(order, ['speedFee', 'priorityFee'], 0),
    additionalFee: firstFinanceMoney(order, ['additionalFee', 'extraFee', 'surcharge'], 0),
    cancellationFee: firstFinanceMoney(order, ['cancellationFee'], 0),
    discountAmount: firstFinanceMoney(order, ['discountAmount', 'discount'], 0),
    refundAmount: firstFinanceMoney(order, ['refundAmount', 'refundedAmount'], 0),
  };
}

function buildFinanceClosureSnapshot(order = {}) {
  const orderStatus = String(order.status || '').trim().toLowerCase();
  const isCompleted = ['completed', 'done'].includes(orderStatus);
  const isCancelled = ['cancelled', 'canceled', 'merchant_cancelled'].includes(orderStatus);
  const paymentMethod = getOrderPaymentMethod(order) || 'unknown';
  const paymentStatus = normalizeFinancePaymentStatus(order);
  const initialEstimatedTotal = getFinanceInitialEstimate(order);
  const finalCustomerTotal = getFinanceFinalCustomerTotal(order);
  const actualPaidAmount = getFinanceActualPaidAmount(order, finalCustomerTotal);
  const riderAdvance = getOrderAdvancePaymentAmount(order);
  const riderIncome = firstFinanceMoney(order, [
    'riderIncome', 'riderFee', 'driverFee', 'riderEarning', 'riderPayout', 'riderShare', 'fee'
  ], 0);
  const expectedPlatformIncome = Math.max(0, Math.round(finalCustomerTotal - riderAdvance - riderIncome));
  const recordedPlatformIncome = firstFinanceMoney(order, [
    'platformIncome', 'platformFee', 'cashDueToPlatform', 'platformReceivable'
  ], expectedPlatformIncome);
  const feeBreakdown = getFinanceFeeBreakdown(order);

  const customerVariance = Math.round(actualPaidAmount - finalCustomerTotal);
  const platformVariance = Math.round(recordedPlatformIncome - expectedPlatformIncome);

  let settlementExpected = 0;
  let settlementActual = 0;
  let settlementStatus = 'not_applicable';
  if (isCashPaymentOrder(order)) {
    settlementExpected = getFinanceCashAmounts(order).cashDueToPlatform;
    settlementActual = isCashRemittanceSettled(order)
      ? firstFinanceMoney(order, ['cashRemittedAmount'], settlementExpected)
      : 0;
    settlementStatus = isCashRemittanceSettled(order) ? 'settled' : 'pending';
  } else if (isFinancePlatformPayoutOrder(order)) {
    settlementExpected = getFinanceJkoAmounts(order).payoutTotal;
    settlementActual = String(order.settlementStatus || '').trim().toLowerCase() === 'settled'
      ? firstFinanceMoney(order, ['settledAmount'], settlementExpected)
      : 0;
    settlementStatus = String(order.settlementStatus || 'pending').trim().toLowerCase();
  } else if (String(order.merchantBillingStatus || '').trim()) {
    settlementExpected = firstFinanceMoney(order, [
      'merchantPayableAmount', 'merchantFee', 'storePayableAmount'
    ], 0);
    settlementActual = String(order.merchantBillingStatus || '').trim().toLowerCase() === 'paid'
      ? settlementExpected
      : 0;
    settlementStatus = String(order.merchantBillingStatus || 'pending').trim().toLowerCase();
  }

  const settlementVariance = Math.round(settlementActual - settlementExpected);
  const discrepancyReasons = [];
  if (Math.abs(customerVariance) > 1 && !['unpaid', 'cash_pending'].includes(paymentStatus)) {
    discrepancyReasons.push('客戶實收與最終應收不一致');
  }
  if (Math.abs(platformVariance) > 1) {
    discrepancyReasons.push('平台收入欄位與公式不一致');
  }
  if (settlementStatus === 'settled' && Math.abs(settlementVariance) > 1) {
    discrepancyReasons.push('結算金額與應結算金額不一致');
  }
  if (isCompleted && !isCancelled && finalCustomerTotal <= 0) {
    discrepancyReasons.push('完成訂單缺少最終金額');
  }
  if (isCompleted && !isCancelled && !isCashPaymentOrder(order) && paymentStatus === 'unpaid') {
    discrepancyReasons.push('完成訂單仍顯示未付款');
  }

  let reconciliationStatus = String(order.financeReconciliationStatus || '').trim().toLowerCase();
  if (!reconciliationStatus) {
    if (!isCompleted && !isCancelled) reconciliationStatus = 'in_progress';
    else if (discrepancyReasons.length) reconciliationStatus = 'needs_review';
    else if (['unpaid', 'cash_pending'].includes(paymentStatus)) reconciliationStatus = 'unpaid';
    else if (settlementStatus === 'pending') reconciliationStatus = 'pending_settlement';
    else reconciliationStatus = 'ready';
  }

  if (String(order.financeReconciliationStatus || '').trim().toLowerCase() === 'reconciled') {
    reconciliationStatus = 'reconciled';
  }

  return {
    orderId: String(order.id || order.orderId || '').trim().toUpperCase(),
    orderNo: String(order.orderNo || order.id || '').trim(),
    orderStatus,
    completedAtMs: getFinanceCompletedAtMs(order),
    createdAtMs: financeToMs(order.createdAt) || financeToMs(order.createdAtMs),
    paymentMethod,
    paymentStatus,
    initialEstimatedTotal,
    finalCustomerTotal,
    actualPaidAmount,
    riderAdvance,
    riderIncome,
    expectedPlatformIncome,
    recordedPlatformIncome,
    feeBreakdown,
    customerVariance,
    platformVariance,
    settlementExpected,
    settlementActual,
    settlementVariance,
    settlementStatus,
    reconciliationStatus,
    discrepancyReasons,
    financeAdjustmentCount: Math.max(0, financeNumber(order.financeAdjustmentCount, 0)),
    lastAdjustmentReason: String(order.financeLastAdjustmentReason || ''),
    reconciledBy: String(order.financeReconciledBy || ''),
    reconciledAtMs: financeToMs(order.financeReconciledAtMs) || financeToMs(order.financeReconciledAt),
    rider: getFinanceRiderIdentity(order),
    customerName: String(order.customerName || order.userName || order.contactName || ''),
    merchantName: String(order.merchantName || order.storeName || ''),
    serviceType: String(order.serviceType || order.serviceName || order.orderType || ''),
    source: String(order.source || order.createdFrom || ''),
    updatedAtMs: financeToMs(order.financialUpdatedAtMs) || financeToMs(order.financialUpdatedAt) || financeToMs(order.updatedAt),
  };
}

async function getFinanceOrderDoc(orderId) {
  const raw = String(orderId || '').trim();
  if (!raw) return null;
  const candidates = Array.from(new Set([raw, raw.toUpperCase()]));
  for (const id of candidates) {
    const doc = await db.collection('orders').doc(id).get();
    if (doc.exists) return doc;
  }
  return null;
}

async function writeFinanceAuditLog({ orderId, type, operator, reason, before = null, after = null, metadata = {} }) {
  const nowMs = Date.now();
  await db.collection('finance_audit_logs').add({
    orderId: String(orderId || '').trim().toUpperCase(),
    type: String(type || 'finance_update').trim(),
    operator: String(operator || 'finance_center').trim().slice(0, 100),
    reason: String(reason || '').trim().slice(0, 500),
    before,
    after,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAtMs: nowMs,
  });
  return nowMs;
}

app.get('/api/admin/finance-ledger', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const query = String(req.query.q || req.query.query || '').trim().toLowerCase();
    const statusFilter = String(req.query.status || 'all').trim().toLowerCase();
    const limit = Math.min(1000, Math.max(50, Number(req.query.limit || 500)));
    const snap = await db.collection('orders').limit(limit).get();
    let items = [];
    const nowMs = Date.now();
    const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
    const taipeiNow = new Date(nowMs + TAIPEI_OFFSET_MS);
    const todayStartMs = Date.UTC(
      taipeiNow.getUTCFullYear(), taipeiNow.getUTCMonth(), taipeiNow.getUTCDate(), 0, 0, 0, 0
    ) - TAIPEI_OFFSET_MS;
    const tomorrowStartMs = todayStartMs + 24 * 60 * 60 * 1000;

    snap.forEach(doc => {
      const order = { id: doc.id, ...doc.data() };
      const item = buildFinanceClosureSnapshot(order);
      const searchable = [
        item.orderId, item.orderNo, item.customerName, item.merchantName,
        item.rider?.riderName, item.rider?.riderPhone, item.serviceType,
        item.paymentMethod, item.paymentStatus
      ].join(' ').toLowerCase();
      if (query && !searchable.includes(query)) return;
      if (statusFilter !== 'all' && item.reconciliationStatus !== statusFilter) return;
      items.push(item);
    });

    items.sort((a, b) => Number(b.completedAtMs || b.createdAtMs || 0) - Number(a.completedAtMs || a.createdAtMs || 0));

    const summary = {
      totalOrders: items.length,
      needsReviewCount: 0,
      unpaidCount: 0,
      pendingSettlementCount: 0,
      reconciledCount: 0,
      unpaidAmount: 0,
      todayCustomerRevenue: 0,
      todayPlatformIncome: 0,
      todayRiderIncome: 0,
      todayRiderAdvance: 0,
      totalVarianceAmount: 0,
    };

    items.forEach(item => {
      if (item.reconciliationStatus === 'needs_review') summary.needsReviewCount += 1;
      if (item.reconciliationStatus === 'unpaid') {
        summary.unpaidCount += 1;
        summary.unpaidAmount += Math.max(0, item.finalCustomerTotal - item.actualPaidAmount);
      }
      if (item.reconciliationStatus === 'pending_settlement') summary.pendingSettlementCount += 1;
      if (item.reconciliationStatus === 'reconciled') summary.reconciledCount += 1;
      summary.totalVarianceAmount += Math.abs(item.customerVariance) + Math.abs(item.platformVariance) + Math.abs(item.settlementVariance);

      const when = Number(item.completedAtMs || item.createdAtMs || 0);
      if (when >= todayStartMs && when < tomorrowStartMs) {
        summary.todayCustomerRevenue += item.actualPaidAmount;
        summary.todayPlatformIncome += item.expectedPlatformIncome;
        summary.todayRiderIncome += item.riderIncome;
        summary.todayRiderAdvance += item.riderAdvance;
      }
    });

    Object.keys(summary).forEach(key => {
      if (typeof summary[key] === 'number') summary[key] = Math.round(summary[key]);
    });

    return res.json({ success: true, updatedAtMs: nowMs, summary, orders: items.slice(0, 500) });
  } catch (error) {
    console.error('finance ledger error:', error);
    return res.status(500).json({ success: false, message: '讀取訂單財務總帳失敗。', error: error.message });
  }
});

app.get('/api/admin/finance-orders/:orderId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const doc = await getFinanceOrderDoc(req.params.orderId);
    if (!doc) return res.status(404).json({ success: false, message: '找不到訂單。' });
    const order = { id: doc.id, ...doc.data() };
    const auditSnap = await db.collection('finance_audit_logs')
      .where('orderId', '==', doc.id.toUpperCase())
      .limit(100)
      .get();
    const audit = auditSnap.docs.map(auditDoc => ({ id: auditDoc.id, ...auditDoc.data() }))
      .sort((a, b) => financeToMs(b.createdAtMs) - financeToMs(a.createdAtMs));
    return res.json({ success: true, order: buildFinanceClosureSnapshot(order), rawFinance: {
      paymentMethod: getOrderPaymentMethod(order),
      paymentStatus: normalizeFinancePaymentStatus(order),
      cashRemittanceStatus: getOrderCashRemittanceStatus(order),
      settlementStatus: String(order.settlementStatus || ''),
      merchantBillingStatus: String(order.merchantBillingStatus || ''),
      financeReconciliationNote: String(order.financeReconciliationNote || ''),
    }, audit });
  } catch (error) {
    console.error('finance order detail error:', error);
    return res.status(500).json({ success: false, message: '讀取訂單財務明細失敗。', error: error.message });
  }
});

app.post('/api/admin/finance-orders/:orderId/adjust', async (req, res) => {
  try {
    const field = String(req.body?.field || '').trim();
    const reason = String(req.body?.reason || '').trim();
    const operator = String(req.body?.operator || 'finance_center').trim().slice(0, 100);
    const value = financeNumber(req.body?.value, NaN);
    if (!UBEE_FINANCE_ADJUSTABLE_FIELDS[field]) {
      return res.status(400).json({ success: false, message: '不支援此財務欄位。' });
    }
    if (!Number.isFinite(value) || value < 0) {
      return res.status(400).json({ success: false, message: '金額必須是大於或等於 0 的數字。' });
    }
    if (reason.length < 2) {
      return res.status(400).json({ success: false, message: '請填寫金額調整原因。' });
    }
    const doc = await getFinanceOrderDoc(req.params.orderId);
    if (!doc) return res.status(404).json({ success: false, message: '找不到訂單。' });
    const beforeOrder = { id: doc.id, ...doc.data() };
    const beforeSnapshot = buildFinanceClosureSnapshot(beforeOrder);
    const update = {
      financialUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      financialUpdatedAtMs: Date.now(),
      financeLastAdjustmentReason: reason.slice(0, 500),
      financeLastAdjustedBy: operator,
      financeAdjustmentCount: admin.firestore.FieldValue.increment(1),
      financeReconciliationStatus: 'needs_review',
    };
    UBEE_FINANCE_ADJUSTABLE_FIELDS[field].forEach(target => { update[target] = value; });
    await doc.ref.set(update, { merge: true });
    const updatedDoc = await doc.ref.get();
    const afterOrder = { id: updatedDoc.id, ...updatedDoc.data() };
    const afterSnapshot = buildFinanceClosureSnapshot(afterOrder);
    await writeFinanceAuditLog({
      orderId: doc.id,
      type: 'amount_adjustment',
      operator,
      reason,
      before: { field, value: beforeSnapshot[field] ?? null, snapshot: beforeSnapshot },
      after: { field, value, snapshot: afterSnapshot },
    });
    return res.json({ success: true, message: '財務金額已更新，訂單已標記為待重新對帳。', order: afterSnapshot });
  } catch (error) {
    console.error('finance adjust error:', error);
    return res.status(500).json({ success: false, message: '調整財務金額失敗。', error: error.message });
  }
});

app.post('/api/admin/finance-orders/:orderId/payment-status', async (req, res) => {
  try {
    const allowed = new Set(['unpaid', 'partial', 'paid', 'cash_pending', 'cash_collected', 'refunded', 'cancelled']);
    const status = String(req.body?.status || '').trim().toLowerCase();
    const operator = String(req.body?.operator || 'finance_center').trim().slice(0, 100);
    const reason = String(req.body?.reason || '').trim();
    const paidAmount = req.body?.paidAmount === undefined ? null : financeNumber(req.body.paidAmount, NaN);
    if (!allowed.has(status)) return res.status(400).json({ success: false, message: '付款狀態不正確。' });
    if (reason.length < 2) return res.status(400).json({ success: false, message: '請填寫付款狀態修改原因。' });
    if (paidAmount !== null && (!Number.isFinite(paidAmount) || paidAmount < 0)) {
      return res.status(400).json({ success: false, message: '實收金額格式不正確。' });
    }
    const doc = await getFinanceOrderDoc(req.params.orderId);
    if (!doc) return res.status(404).json({ success: false, message: '找不到訂單。' });
    const beforeOrder = { id: doc.id, ...doc.data() };
    const update = {
      financePaymentStatus: status,
      paymentStatus: status === 'cash_collected' ? 'cash_on_delivery' : status,
      isPaid: ['paid', 'cash_collected'].includes(status),
      financialUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      financialUpdatedAtMs: Date.now(),
      financeReconciliationStatus: 'needs_review',
    };
    if (paidAmount !== null) {
      update.actualPaidAmount = paidAmount;
      update.paidAmount = paidAmount;
    }
    await doc.ref.set(update, { merge: true });
    const updatedDoc = await doc.ref.get();
    const afterOrder = { id: updatedDoc.id, ...updatedDoc.data() };
    await writeFinanceAuditLog({
      orderId: doc.id,
      type: 'payment_status_change',
      operator,
      reason,
      before: { paymentStatus: normalizeFinancePaymentStatus(beforeOrder), actualPaidAmount: getFinanceActualPaidAmount(beforeOrder, getFinanceFinalCustomerTotal(beforeOrder)) },
      after: { paymentStatus: status, actualPaidAmount: getFinanceActualPaidAmount(afterOrder, getFinanceFinalCustomerTotal(afterOrder)) },
    });
    return res.json({ success: true, message: '付款狀態已更新。', order: buildFinanceClosureSnapshot(afterOrder) });
  } catch (error) {
    console.error('finance payment status error:', error);
    return res.status(500).json({ success: false, message: '更新付款狀態失敗。', error: error.message });
  }
});

app.post('/api/admin/finance-orders/:orderId/reconcile', async (req, res) => {
  try {
    const operator = String(req.body?.operator || 'finance_center').trim().slice(0, 100);
    const note = String(req.body?.note || '').trim();
    const force = req.body?.force === true;
    const doc = await getFinanceOrderDoc(req.params.orderId);
    if (!doc) return res.status(404).json({ success: false, message: '找不到訂單。' });
    const order = { id: doc.id, ...doc.data() };
    const snapshot = buildFinanceClosureSnapshot(order);
    if (snapshot.discrepancyReasons.length && !force) {
      return res.status(409).json({ success: false, code: 'FINANCE_DISCREPANCY_EXISTS', message: '這筆訂單仍有財務差異，請先修正或勾選強制結案。', discrepancyReasons: snapshot.discrepancyReasons, order: snapshot });
    }
    const nowMs = Date.now();
    await doc.ref.set({
      financeReconciliationStatus: 'reconciled',
      financeReconciliationNote: note.slice(0, 1000),
      financeReconciledBy: operator,
      financeReconciledAt: admin.firestore.FieldValue.serverTimestamp(),
      financeReconciledAtMs: nowMs,
      financeCustomerVariance: snapshot.customerVariance,
      financePlatformVariance: snapshot.platformVariance,
      financeSettlementVariance: snapshot.settlementVariance,
      financialUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      financialUpdatedAtMs: nowMs,
    }, { merge: true });
    await writeFinanceAuditLog({
      orderId: doc.id,
      type: force && snapshot.discrepancyReasons.length ? 'forced_reconciliation' : 'reconciliation',
      operator,
      reason: note || (force ? '強制完成對帳' : '完成對帳'),
      before: snapshot,
      after: { reconciliationStatus: 'reconciled' },
      metadata: { force, discrepancyReasons: snapshot.discrepancyReasons },
    });
    const updatedDoc = await doc.ref.get();
    return res.json({ success: true, message: '訂單財務已完成對帳。', order: buildFinanceClosureSnapshot({ id: updatedDoc.id, ...updatedDoc.data() }) });
  } catch (error) {
    console.error('finance reconcile error:', error);
    return res.status(500).json({ success: false, message: '完成財務對帳失敗。', error: error.message });
  }
});

// =====================================================
// UBee 第三階段：客戶即時追蹤摘要 API
// - 提供 order.html 與「我的任務」共同使用的單一追蹤資料來源。
// - Firestore 即時監聽失敗、網路重新連線或 App 回到前景時，可用此 API 補抓最新狀態。
// - 僅允許原下單 LINE userId 查詢；不回傳不必要的騎士個資。
// =====================================================

// ============================================================
// UBee 第五階段：客服、申訴與任務證據中心 V5
// - 一般客戶／小U／店家案件
// - 公開回覆與內部備註分離
// - 證據檔案不可覆蓋，建立 SHA-256 與訂單快照
// - 退款只建立財務審核申請，不直接改動款項
// - 不改動重新轉派、店家完成通知或騎士審核群規則
// ============================================================
const UBEE_SUPPORT_ADMIN_KEY = String(
  process.env.UBEE_SUPPORT_ADMIN_KEY ||
  UBEE_RIDER_V4_ADMIN_KEY ||
  ''
).trim();

const UBEE_SUPPORT_STORAGE_BUCKET = String(
  process.env.FIREBASE_STORAGE_BUCKET ||
  `${process.env.FIREBASE_PROJECT_ID || ''}.appspot.com`
).trim();

const UBEE_SUPPORT_CASE_STATUSES = Object.freeze({
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  WAITING_USER: 'WAITING_USER',
  WAITING_FINANCE: 'WAITING_FINANCE',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
  DELETED: 'DELETED',
});

const UBEE_SUPPORT_CATEGORIES = Object.freeze({
  DELIVERY_DELAY: { label: '配送延遲', severity: 'MEDIUM', orderRequired: true },
  ITEM_DAMAGED: { label: '商品損壞', severity: 'HIGH', orderRequired: true },
  ITEM_LOST: { label: '商品遺失', severity: 'CRITICAL', orderRequired: true },
  ITEM_MISSING: { label: '商品缺件', severity: 'HIGH', orderRequired: true },
  NOT_RECEIVED: { label: '未收到商品', severity: 'CRITICAL', orderRequired: true },
  SERVICE_ATTITUDE: { label: '服務態度問題', severity: 'MEDIUM', orderRequired: true },
  AMOUNT_DISPUTE: { label: '金額爭議', severity: 'HIGH', orderRequired: true },
  REFUND_REQUEST: { label: '退款申請', severity: 'HIGH', orderRequired: true },
  ADDRESS_CONTACT: { label: '地址或聯絡問題', severity: 'MEDIUM', orderRequired: true },
  RIDER_REPORT: { label: '小U任務回報', severity: 'MEDIUM', orderRequired: true },
  MERCHANT_REPORT: { label: '店家配送回報', severity: 'MEDIUM', orderRequired: true },
  GENERAL_INQUIRY: { label: '一般客服詢問', severity: 'LOW', orderRequired: false },
  OTHER: { label: '其他問題', severity: 'MEDIUM', orderRequired: false },
});

const UBEE_SUPPORT_EVIDENCE_TYPES = Object.freeze({
  PICKUP_PHOTO: '取件照片',
  DROPOFF_PHOTO: '送達照片',
  ITEM_PHOTO: '商品照片',
  RECEIPT: '收據／代墊證明',
  SIGNATURE: '簽收／確認證明',
  CHAT_SCREENSHOT: '對話截圖',
  OTHER: '其他證據',
});

function supportCleanText(value, maxLength = 500) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function supportNormalizePhone(value) {
  const phone = String(value || '').replace(/\D/g, '');
  return /^09\d{8}$/.test(phone) ? phone : phone.slice(0, 20);
}

function supportNormalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (['customer', 'user', 'client'].includes(role)) return 'customer';
  if (['rider', 'driver', 'courier'].includes(role)) return 'rider';
  if (['merchant', 'store', 'business'].includes(role)) return 'merchant';
  if (['admin', 'support', 'staff'].includes(role)) return 'admin';
  return 'customer';
}

function supportNormalizeCaseStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(UBEE_SUPPORT_CASE_STATUSES, status)
    ? status
    : UBEE_SUPPORT_CASE_STATUSES.OPEN;
}

function supportNormalizeCategory(value) {
  const category = String(value || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(UBEE_SUPPORT_CATEGORIES, category)
    ? category
    : 'OTHER';
}

function supportNormalizeSeverity(value, category) {
  const severity = String(value || '').trim().toUpperCase();
  if (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(severity)) return severity;
  return UBEE_SUPPORT_CATEGORIES[category]?.severity || 'MEDIUM';
}

function supportSha256(value) {
  return crypto
    .createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : String(value || ''))
    .digest('hex');
}

function supportGenerateAccessToken() {
  return crypto.randomBytes(24).toString('hex');
}

function supportTaipeiParts(nowMs = Date.now()) {
  const date = new Date(nowMs + 8 * 60 * 60 * 1000);
  return {
    year: date.getUTCFullYear(),
    month: String(date.getUTCMonth() + 1).padStart(2, '0'),
    day: String(date.getUTCDate()).padStart(2, '0'),
    hour: String(date.getUTCHours()).padStart(2, '0'),
    minute: String(date.getUTCMinutes()).padStart(2, '0'),
    second: String(date.getUTCSeconds()).padStart(2, '0'),
  };
}

function supportGenerateCaseId() {
  const p = supportTaipeiParts();
  return (
    `UBS${p.year}${p.month}${p.day}` +
    `${p.hour}${p.minute}${p.second}` +
    crypto.randomBytes(2).toString('hex').toUpperCase()
  );
}

function supportToMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  return 0;
}

function supportRemoveUndefined(value) {
  if (
    Buffer.isBuffer(value) ||
    value instanceof Date ||
    (value && typeof value.toMillis === 'function') ||
    (value && typeof value.toDate === 'function') ||
    (value && value.constructor && value.constructor.name === 'FieldValue') ||
    (value && typeof value._methodName === 'string')
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(item => supportRemoveUndefined(item))
      .filter(item => item !== undefined);
  }
  if (value && typeof value === 'object') {
    const result = {};
    Object.entries(value).forEach(([key, item]) => {
      const cleaned = supportRemoveUndefined(item);
      if (cleaned !== undefined) result[key] = cleaned;
    });
    return result;
  }
  return value === undefined ? undefined : value;
}

function supportGetAdminKey(req) {
  const headerKey = supportCleanText(
    req.headers['x-ubee-support-admin-key'] || '',
    300
  );
  if (headerKey) return headerKey;
  const bearer = getBearerToken(req);
  return supportCleanText(bearer, 300);
}

function supportRequireAdmin(req, res, next) {
  if (!UBEE_SUPPORT_ADMIN_KEY) {
    return res.status(503).json({
      success: false,
      code: 'SUPPORT_ADMIN_KEY_NOT_CONFIGURED',
      message: '客服中心管理金鑰尚未設定。請在 Render 設定 UBEE_SUPPORT_ADMIN_KEY。',
    });
  }

  const supplied = supportGetAdminKey(req);
  const expected = Buffer.from(UBEE_SUPPORT_ADMIN_KEY);
  const actual = Buffer.from(supplied);
  const valid =
    expected.length === actual.length &&
    expected.length > 0 &&
    crypto.timingSafeEqual(expected, actual);

  if (!valid) {
    return res.status(401).json({
      success: false,
      code: 'SUPPORT_ADMIN_UNAUTHORIZED',
      message: '客服管理金鑰不正確。',
    });
  }

  req.supportAdmin = {
    operator: supportCleanText(
      req.headers['x-ubee-support-operator'] ||
      req.body?.operator ||
      req.query?.operator ||
      'support_center',
      100
    ) || 'support_center',
  };

  return next();
}

function supportGetCaseToken(req) {
  return supportCleanText(
    req.headers['x-ubee-support-access-token'] ||
    req.query?.accessToken ||
    req.body?.accessToken ||
    '',
    300
  );
}

function supportCaseTokenValid(caseData = {}, token = '') {
  const storedHash = supportCleanText(caseData.accessTokenHash || '', 128);
  if (!storedHash || !token) return false;
  const suppliedHash = supportSha256(token);
  const a = Buffer.from(storedHash);
  const b = Buffer.from(suppliedHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function supportIdentitySet(order = {}, role = 'customer') {
  const values = [];
  const push = value => {
    const text = supportCleanText(value, 200).toLowerCase();
    if (text) values.push(text);
    const phone = supportNormalizePhone(value);
    if (phone) values.push(phone.toLowerCase());
  };

  if (role === 'merchant') {
    [
      order.merchantId,
      order.merchantCode,
      order.merchantPhone,
      order.merchantLineUserId,
      order.storeId,
      order.storePhone,
    ].forEach(push);
  } else if (role === 'rider') {
    [
      order.riderId,
      order.riderDocId,
      order.riderPhone,
      order.riderLineUserId,
      order.driverId,
      order.driverPhone,
    ].forEach(push);
  } else {
    [
      order.userId,
      order.customerId,
      order.lineUserId,
      order.customerLineUserId,
      order.customerPhone,
      order.phone,
      order.contactPhone,
      order.dropoffPhone,
    ].forEach(push);
  }

  return new Set(values);
}

function supportVerifyOrderIdentity(order = {}, role, payload = {}) {
  const expected = supportIdentitySet(order, role);
  const submitted = [
    payload.identifier,
    payload.contactPhone,
    payload.lineUserId,
  ]
    .flatMap(value => {
      const list = [];
      const text = supportCleanText(value, 200).toLowerCase();
      if (text) list.push(text);
      const phone = supportNormalizePhone(value);
      if (phone) list.push(phone.toLowerCase());
      return list;
    });

  if (!expected.size) {
    return {
      verified: false,
      verificationMode: 'ORDER_HAS_NO_IDENTITY_FIELDS',
    };
  }

  const verified = submitted.some(value => expected.has(value));
  return {
    verified,
    verificationMode: verified ? 'ORDER_IDENTITY_MATCHED' : 'ORDER_IDENTITY_MISMATCH',
  };
}

function supportCollectExistingEvidence(order = {}) {
  const fields = [
    ['pickupPhotoUrl', 'PICKUP_PHOTO'],
    ['pickupProofUrl', 'PICKUP_PHOTO'],
    ['dropoffPhotoUrl', 'DROPOFF_PHOTO'],
    ['deliveryPhotoUrl', 'DROPOFF_PHOTO'],
    ['proofOfDeliveryUrl', 'DROPOFF_PHOTO'],
    ['receiptUrl', 'RECEIPT'],
    ['advanceReceiptUrl', 'RECEIPT'],
    ['signatureUrl', 'SIGNATURE'],
  ];

  const evidence = [];
  fields.forEach(([field, type]) => {
    const raw = order[field];
    const urls = Array.isArray(raw) ? raw : raw ? [raw] : [];
    urls.forEach(url => {
      const safeUrl = supportCleanText(url, 2000);
      if (!safeUrl) return;
      evidence.push({
        source: 'order_field',
        field,
        evidenceType: type,
        evidenceTypeLabel: UBEE_SUPPORT_EVIDENCE_TYPES[type],
        url: safeUrl,
      });
    });
  });
  return evidence;
}

function supportBuildOrderSnapshot(order = {}) {
  const snapshot = {
    orderId: supportCleanText(order.id || order.orderId || order.orderNo, 100).toUpperCase(),
    orderNo: supportCleanText(order.orderNo || order.id, 100),
    status: supportCleanText(order.status, 80),
    source: supportCleanText(order.source || order.createdFrom, 100),
    orderType: supportCleanText(order.orderType, 100),
    serviceType: supportCleanText(order.serviceType || order.serviceName, 160),
    itemName: supportCleanText(order.itemName || order.item, 600),
    note: supportCleanText(order.note || order.customerNote || order.merchantNote, 1200),
    pickup: {
      name: supportCleanText(order.pickupName || order.merchantName, 160),
      phone: supportCleanText(order.pickupPhone || order.merchantPhone, 40),
      address: supportCleanText(order.pickupAddress || order.pickup, 600),
      lat: Number(order.pickupLat || order.fromLat || 0) || 0,
      lng: Number(order.pickupLng || order.fromLng || 0) || 0,
    },
    dropoff: {
      name: supportCleanText(order.customerName || order.receiverName, 160),
      phone: supportCleanText(order.customerPhone || order.dropoffPhone, 40),
      address: supportCleanText(order.dropoffAddress || order.dropoff, 600),
      lat: Number(order.dropoffLat || order.toLat || 0) || 0,
      lng: Number(order.dropoffLng || order.toLng || 0) || 0,
    },
    merchant: {
      id: supportCleanText(order.merchantId || order.merchantCode, 160),
      lineUserId: supportCleanText(order.merchantLineUserId, 160),
      name: supportCleanText(order.merchantName, 160),
      phone: supportCleanText(order.merchantPhone, 40),
    },
    rider: {
      id: supportCleanText(order.riderId || order.riderDocId, 160),
      lineUserId: supportCleanText(order.riderLineUserId, 160),
      name: supportCleanText(order.riderName, 160),
      phone: supportCleanText(order.riderPhone, 40),
    },
    amounts: {
      total: financeNumber(order.finalTotal ?? order.total ?? order.totalFee, 0),
      paidAmount: financeNumber(order.paidAmount, 0),
      advanceAmount: financeNumber(order.advanceAmount ?? order.advancePayment, 0),
      riderFee: financeNumber(order.riderFee ?? order.driverFee, 0),
      merchantPayableAmount: financeNumber(order.merchantPayableAmount, 0),
      refundAmount: financeNumber(order.refundAmount, 0),
    },
    payment: {
      method: supportCleanText(order.paymentMethod, 100),
      status: supportCleanText(order.paymentStatus, 100),
      merchantBillingStatus: supportCleanText(order.merchantBillingStatus, 100),
      settlementStatus: supportCleanText(order.settlementStatus, 100),
    },
    timeline: {
      createdAtMs: supportToMs(order.createdAtMs) || supportToMs(order.createdAt),
      acceptedAtMs: supportToMs(order.acceptedAtMs) || supportToMs(order.acceptedAt),
      arrivedPickupAtMs: supportToMs(order.arrivedPickupAtMs) || supportToMs(order.arrivedPickupAt),
      pickedUpAtMs: supportToMs(order.pickedUpAtMs) || supportToMs(order.pickedUpAt),
      arrivedDropoffAtMs: supportToMs(order.arrivedDropoffAtMs) || supportToMs(order.arrivedDropoffAt),
      completedAtMs: supportToMs(order.completedAtMs) || supportToMs(order.completedAt),
      cancelledAtMs: supportToMs(order.cancelledAtMs) || supportToMs(order.cancelledAt),
      riderLocationUpdatedAtMs: supportToMs(order.riderLocationUpdatedAtMs) || supportToMs(order.riderLocationUpdatedAt),
    },
    riderLocation: {
      lat: Number(order.riderCurrentLat || 0) || 0,
      lng: Number(order.riderCurrentLng || 0) || 0,
      source: supportCleanText(order.riderTrackingSource, 100),
    },
    deliveryStops: Array.isArray(order.deliveryStops)
      ? order.deliveryStops.slice(0, 20).map(stop => ({
          index: Number(stop.index || 0),
          customerName: supportCleanText(stop.customerName, 160),
          customerPhone: supportCleanText(stop.customerPhone, 40),
          dropoffAddress: supportCleanText(stop.dropoffAddress, 600),
          itemName: supportCleanText(stop.itemName, 400),
          note: supportCleanText(stop.note, 600),
          status: supportCleanText(stop.status, 100),
          arrivedAtMs: supportToMs(stop.arrivedAtMs),
          completedAtMs: supportToMs(stop.completedAtMs),
        }))
      : [],
    existingEvidence: supportCollectExistingEvidence(order),
  };

  return supportRemoveUndefined(snapshot);
}

async function supportGetLinkedIncidents(orderId) {
  if (!orderId) return [];
  try {
    const snap = await db
      .collection('dispatchIncidents')
      .where('orderId', '==', orderId)
      .limit(20)
      .get();

    return snap.docs.map(doc => {
      const data = doc.data() || {};
      return {
        incidentId: doc.id,
        type: supportCleanText(data.type, 100),
        typeLabel: supportCleanText(data.typeLabel, 160),
        status: supportCleanText(data.status, 80),
        severity: supportCleanText(data.severity, 80),
        description: supportCleanText(data.description, 1000),
        assignedTo: supportCleanText(data.assignedTo, 160),
        createdAtMs: supportToMs(data.createdAtMs) || supportToMs(data.createdAt),
        updatedAtMs: supportToMs(data.updatedAtMs) || supportToMs(data.updatedAt),
      };
    });
  } catch (error) {
    console.warn('⚠️ 客服案件讀取調度異常失敗：', error?.message || error);
    return [];
  }
}

async function supportWriteEvent(caseId, event = {}) {
  const nowMs = Date.now();
  const payload = supportRemoveUndefined({
    type: supportCleanText(event.type || 'NOTE', 100).toUpperCase(),
    visibility: String(event.visibility || 'INTERNAL').toUpperCase() === 'PUBLIC'
      ? 'PUBLIC'
      : 'INTERNAL',
    title: supportCleanText(event.title, 300),
    message: supportCleanText(event.message, 3000),
    operator: supportCleanText(event.operator || 'system', 160),
    actorRole: supportNormalizeRole(event.actorRole || 'admin'),
    metadata: event.metadata && typeof event.metadata === 'object'
      ? supportRemoveUndefined(event.metadata)
      : {},
    createdAtMs: nowMs,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const ref = await db
    .collection('supportCases')
    .doc(caseId)
    .collection('events')
    .add(payload);

  return { eventId: ref.id, ...payload, createdAt: undefined };
}

function supportSerializeCase(doc) {
  const data = doc?.data ? (doc.data() || {}) : (doc || {});
  const caseId = supportCleanText(doc?.id || data.caseId, 100).toUpperCase();
  return {
    ...data,
    caseId,
    id: caseId,
    accessTokenHash: undefined,
    createdAtMs: supportToMs(data.createdAtMs) || supportToMs(data.createdAt),
    updatedAtMs: supportToMs(data.updatedAtMs) || supportToMs(data.updatedAt),
    resolvedAtMs: supportToMs(data.resolvedAtMs) || supportToMs(data.resolvedAt),
    closedAtMs: supportToMs(data.closedAtMs) || supportToMs(data.closedAt),
    deletedAtMs: supportToMs(data.deletedAtMs) || supportToMs(data.deletedAt),
    restoredAtMs: supportToMs(data.restoredAtMs) || supportToMs(data.restoredAt),
    permanentlyDeletedRequestedAtMs: supportToMs(data.permanentlyDeletedRequestedAtMs),
    isDeleted: Boolean(data.deletedAtMs || data.deletedAt || data.status === 'DELETED'),
    createdAt: undefined,
    updatedAt: undefined,
    resolvedAt: undefined,
    closedAt: undefined,
    deletedAt: undefined,
    restoredAt: undefined,
  };
}

function supportSerializeEvent(doc) {
  const data = doc?.data ? (doc.data() || {}) : (doc || {});
  return {
    ...data,
    eventId: doc?.id || data.eventId || '',
    createdAtMs: supportToMs(data.createdAtMs) || supportToMs(data.createdAt),
    createdAt: undefined,
  };
}

function supportSerializeEvidence(doc) {
  const data = doc?.data ? (doc.data() || {}) : (doc || {});
  return {
    ...data,
    evidenceId: doc?.id || data.evidenceId || '',
    uploadedAtMs: supportToMs(data.uploadedAtMs) || supportToMs(data.uploadedAt),
    uploadedAt: undefined,
  };
}

async function supportReadCaseDetail(caseId, { includeInternal = false } = {}) {
  const caseRef = db.collection('supportCases').doc(caseId);
  const caseDoc = await caseRef.get();
  if (!caseDoc.exists) return null;

  const [eventsSnap, evidenceSnap] = await Promise.all([
    caseRef.collection('events').limit(300).get(),
    caseRef.collection('evidence').limit(100).get(),
  ]);

  let events = eventsSnap.docs
    .map(supportSerializeEvent)
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  if (!includeInternal) {
    events = events.filter(event => event.visibility === 'PUBLIC');
  }

  const evidence = evidenceSnap.docs
    .map(supportSerializeEvidence)
    .sort((a, b) => a.uploadedAtMs - b.uploadedAtMs);

  return {
    case: supportSerializeCase(caseDoc),
    events,
    evidence,
  };
}

function supportPublicCaseView(detail) {
  if (!detail) return null;
  const data = detail.case || {};
  return {
    case: {
      caseId: data.caseId,
      orderId: data.orderId,
      orderNo: data.orderNo,
      sourceRole: data.sourceRole,
      category: data.category,
      categoryLabel: data.categoryLabel,
      title: data.title,
      description: data.description,
      requestedResolution: data.requestedResolution,
      severity: data.severity,
      status: data.status,
      statusLabel: data.statusLabel,
      assignedTo: data.assignedTo,
      latestPublicReply: data.latestPublicReply,
      refundRequestStatus: data.refundRequestStatus,
      refundRequestedAmount: data.refundRequestedAmount,
      createdAtMs: data.createdAtMs,
      updatedAtMs: data.updatedAtMs,
      resolvedAtMs: data.resolvedAtMs,
      resolution: data.resolution,
    },
    events: detail.events,
    evidence: detail.evidence.map(item => ({
      evidenceId: item.evidenceId,
      evidenceType: item.evidenceType,
      evidenceTypeLabel: item.evidenceTypeLabel,
      originalName: item.originalName,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
      url: item.url,
      uploadedByRole: item.uploadedByRole,
      uploadedAtMs: item.uploadedAtMs,
    })),
  };
}

async function supportValidateCaseAccess(caseId, req, { allowAdmin = true } = {}) {
  const caseDoc = await db.collection('supportCases').doc(caseId).get();
  if (!caseDoc.exists) {
    const error = new Error('找不到客服案件。');
    error.statusCode = 404;
    throw error;
  }

  const data = caseDoc.data() || {};
  const isDeleted = Boolean(data.deletedAtMs || data.deletedAt || data.status === 'DELETED');
  if (isDeleted && !allowAdmin) {
    const error = new Error('此客服案件已由 UBee 客服中心移除。');
    error.statusCode = 410;
    throw error;
  }
  if (allowAdmin && UBEE_SUPPORT_ADMIN_KEY) {
    const supplied = supportGetAdminKey(req);
    if (supplied) {
      const expected = Buffer.from(UBEE_SUPPORT_ADMIN_KEY);
      const actual = Buffer.from(supplied);
      if (
        expected.length === actual.length &&
        expected.length > 0 &&
        crypto.timingSafeEqual(expected, actual)
      ) {
        return { caseDoc, caseData: data, accessMode: 'admin' };
      }
    }
  }

  const token = supportGetCaseToken(req);
  if (!supportCaseTokenValid(data, token)) {
    const error = new Error('案件查詢憑證不正確。');
    error.statusCode = 401;
    throw error;
  }

  return { caseDoc, caseData: data, accessMode: 'public' };
}

function supportEvidenceExtension(mimeType, originalName = '') {
  const extFromName = String(originalName || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
  const allowedNameExt = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf']);
  if (extFromName && allowedNameExt.has(extFromName)) return extFromName;
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'application/pdf': 'pdf',
  };
  return map[mimeType] || 'bin';
}

async function handleSupportEvidenceUpload(req, res) {
  try {
    const caseId = supportCleanText(
      req.headers['x-ubee-support-case-id'] || '',
      100
    ).toUpperCase();

    if (!caseId || !Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({
        success: false,
        message: '缺少案件編號或證據檔案。',
      });
    }

    const access = await supportValidateCaseAccess(caseId, req, { allowAdmin: true });
    const contentType = supportCleanText(req.headers['content-type'] || '', 100).toLowerCase();
    const allowedMimeTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
      'application/pdf',
    ]);

    if (!allowedMimeTypes.has(contentType)) {
      return res.status(415).json({
        success: false,
        message: '證據檔案只支援 JPG、PNG、WEBP、HEIC 或 PDF。',
      });
    }

    if (req.body.length > 6 * 1024 * 1024) {
      return res.status(413).json({
        success: false,
        message: '單一證據檔案不可超過 6 MB。',
      });
    }

    const rawOriginalName = supportCleanText(
      req.headers['x-ubee-support-file-name'] || 'evidence',
      500
    );
    let originalName = rawOriginalName;
    try {
      originalName = decodeURIComponent(rawOriginalName);
    } catch (error) {}
    originalName = supportCleanText(originalName, 300) || 'evidence';

    const evidenceType = String(
      req.headers['x-ubee-support-evidence-type'] || 'OTHER'
    ).trim().toUpperCase();
    const safeEvidenceType = Object.prototype.hasOwnProperty.call(
      UBEE_SUPPORT_EVIDENCE_TYPES,
      evidenceType
    ) ? evidenceType : 'OTHER';

    if (!UBEE_SUPPORT_STORAGE_BUCKET || UBEE_SUPPORT_STORAGE_BUCKET.startsWith('.')) {
      return res.status(503).json({
        success: false,
        code: 'SUPPORT_STORAGE_NOT_CONFIGURED',
        message: 'Firebase Storage Bucket 尚未設定。請設定 FIREBASE_STORAGE_BUCKET。',
      });
    }

    const evidenceId = crypto.randomUUID();
    const extension = supportEvidenceExtension(contentType, originalName);
    const storagePath = `support-evidence/${caseId}/${Date.now()}_${evidenceId}.${extension}`;
    const downloadToken = crypto.randomUUID();
    const sha256 = supportSha256(req.body);
    const bucket = admin.storage().bucket(UBEE_SUPPORT_STORAGE_BUCKET);
    const file = bucket.file(storagePath);

    await file.save(req.body, {
      resumable: false,
      validation: 'md5',
      metadata: {
        contentType,
        cacheControl: 'private, max-age=0, no-transform',
        metadata: {
          firebaseStorageDownloadTokens: downloadToken,
          supportCaseId: caseId,
          supportEvidenceId: evidenceId,
          sha256,
        },
      },
    });

    const url =
      `https://firebasestorage.googleapis.com/v0/b/` +
      `${encodeURIComponent(bucket.name)}/o/` +
      `${encodeURIComponent(storagePath)}?alt=media&token=${encodeURIComponent(downloadToken)}`;

    const nowMs = Date.now();
    const evidenceData = {
      evidenceId,
      caseId,
      orderId: supportCleanText(access.caseData.orderId, 100).toUpperCase(),
      evidenceType: safeEvidenceType,
      evidenceTypeLabel: UBEE_SUPPORT_EVIDENCE_TYPES[safeEvidenceType],
      originalName,
      mimeType: contentType,
      sizeBytes: req.body.length,
      sha256,
      storageBucket: bucket.name,
      storagePath,
      url,
      immutable: true,
      uploadedByRole: access.accessMode === 'admin'
        ? 'admin'
        : supportNormalizeRole(access.caseData.sourceRole),
      uploadedBy: access.accessMode === 'admin'
        ? supportCleanText(req.headers['x-ubee-support-operator'] || 'support_center', 160)
        : supportCleanText(access.caseData.sourceName || access.caseData.sourceRole, 160),
      uploadedAtMs: nowMs,
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const caseRef = db.collection('supportCases').doc(caseId);
    await Promise.all([
      caseRef.collection('evidence').doc(evidenceId).set(evidenceData),
      caseRef.set({
        evidenceCount: admin.firestore.FieldValue.increment(1),
        latestEvidenceAtMs: nowMs,
        latestEvidenceAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAtMs: nowMs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }),
      supportWriteEvent(caseId, {
        type: 'EVIDENCE_UPLOADED',
        visibility: 'PUBLIC',
        title: '已新增任務證據',
        message: `${UBEE_SUPPORT_EVIDENCE_TYPES[safeEvidenceType]}：${originalName}`,
        operator: evidenceData.uploadedBy,
        actorRole: evidenceData.uploadedByRole,
        metadata: { evidenceId, evidenceType: safeEvidenceType, sha256 },
      }),
    ]);

    return res.json({
      success: true,
      evidence: supportSerializeEvidence(evidenceData),
    });
  } catch (error) {
    console.error('❌ 客服證據上傳失敗：', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || '證據上傳失敗。',
    });
  }
}

app.get('/api/support/config', (req, res) => {
  return res.json({
    success: true,
    categories: Object.entries(UBEE_SUPPORT_CATEGORIES).map(([value, meta]) => ({
      value,
      label: meta.label,
      severity: meta.severity,
      orderRequired: meta.orderRequired,
    })),
    evidenceTypes: Object.entries(UBEE_SUPPORT_EVIDENCE_TYPES).map(([value, label]) => ({
      value,
      label,
    })),
    statuses: Object.values(UBEE_SUPPORT_CASE_STATUSES),
    storageEnabled: Boolean(UBEE_SUPPORT_STORAGE_BUCKET && !UBEE_SUPPORT_STORAGE_BUCKET.startsWith('.')),
    maxEvidenceSizeBytes: 6 * 1024 * 1024,
  });
});

app.post('/api/support/cases', async (req, res) => {
  try {
    const sourceRole = supportNormalizeRole(req.body?.sourceRole);
    if (sourceRole === 'admin') {
      return res.status(400).json({ success: false, message: '請選擇客戶、小U或店家身分。' });
    }

    const category = supportNormalizeCategory(req.body?.category);
    const categoryMeta = UBEE_SUPPORT_CATEGORIES[category];
    const orderIdInput = supportCleanText(req.body?.orderId, 100).toUpperCase();
    const description = supportCleanText(req.body?.description, 3000);
    const title = supportCleanText(req.body?.title, 300) || categoryMeta.label;
    const contactPhone = supportNormalizePhone(req.body?.contactPhone);
    const sourceName = supportCleanText(req.body?.sourceName, 160);
    const identifier = supportCleanText(req.body?.identifier, 200);
    const lineUserId = supportCleanText(req.body?.lineUserId, 200);
    const requestedResolution = supportCleanText(req.body?.requestedResolution, 1200);

    if (!description) {
      return res.status(400).json({ success: false, message: '請填寫問題經過。' });
    }
    if (categoryMeta.orderRequired && !orderIdInput) {
      return res.status(400).json({ success: false, message: '此案件類型必須填寫訂單編號。' });
    }
    if (!contactPhone && !identifier && !lineUserId) {
      return res.status(400).json({ success: false, message: '請至少填寫電話或身分識別資料。' });
    }

    let orderDoc = null;
    let order = null;
    let orderId = orderIdInput;
    let identity = { verified: false, verificationMode: 'NO_ORDER' };
    let orderSnapshot = null;
    let financeSnapshot = null;
    let linkedIncidents = [];

    if (orderIdInput) {
      orderDoc = await getFinanceOrderDoc(orderIdInput);
      if (!orderDoc) {
        return res.status(404).json({ success: false, message: '找不到此訂單，請確認訂單編號。' });
      }
      orderId = String(orderDoc.id || '').trim().toUpperCase();
      order = { id: orderDoc.id, ...(orderDoc.data() || {}) };
      identity = supportVerifyOrderIdentity(order, sourceRole, {
        identifier,
        contactPhone,
        lineUserId,
      });

      if (!identity.verified && identity.verificationMode === 'ORDER_IDENTITY_MISMATCH') {
        return res.status(403).json({
          success: false,
          code: 'SUPPORT_ORDER_IDENTITY_MISMATCH',
          message: '提供的身分資料與訂單不一致，無法建立案件。',
        });
      }

      orderSnapshot = supportBuildOrderSnapshot(order);
      financeSnapshot = buildFinanceClosureSnapshot(order);
      linkedIncidents = await supportGetLinkedIncidents(orderId);
    }

    const caseId = supportGenerateCaseId();
    const accessToken = supportGenerateAccessToken();
    const nowMs = Date.now();
    const severity = supportNormalizeSeverity(req.body?.severity, category);
    const caseRef = db.collection('supportCases').doc(caseId);
    const payload = supportRemoveUndefined({
      caseId,
      caseNo: caseId,
      orderId,
      orderNo: supportCleanText(order?.orderNo || orderId, 100),
      orderType: supportCleanText(order?.orderType, 100),
      orderSource: supportCleanText(order?.source || order?.createdFrom, 100),
      sourceRole,
      sourceName,
      sourceIdentifier: identifier,
      sourceLineUserId: lineUserId,
      contactPhone,
      identityVerified: identity.verified,
      identityVerificationMode: identity.verificationMode,
      category,
      categoryLabel: categoryMeta.label,
      title,
      description,
      requestedResolution,
      severity,
      status: UBEE_SUPPORT_CASE_STATUSES.OPEN,
      statusLabel: '待客服處理',
      assignedTo: '',
      latestPublicReply: '',
      resolution: '',
      refundRequestStatus: 'NOT_REQUESTED',
      refundRequestedAmount: 0,
      evidenceCount: 0,
      messageCount: 1,
      linkedIncidentIds: linkedIncidents.map(item => item.incidentId),
      linkedIncidents,
      orderSnapshot,
      orderSnapshotHash: orderSnapshot ? supportSha256(JSON.stringify(orderSnapshot)) : '',
      financeSnapshot,
      accessTokenHash: supportSha256(accessToken),
      active: true,
      createdAtMs: nowMs,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAtMs: nowMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.runTransaction(async tx => {
      tx.set(caseRef, payload);
      if (orderDoc) {
        tx.set(orderDoc.ref, {
          supportCaseCount: admin.firestore.FieldValue.increment(1),
          activeSupportCaseId: caseId,
          supportStatus: 'OPEN',
          latestSupportCaseAtMs: nowMs,
          latestSupportCaseAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });

    await supportWriteEvent(caseId, {
      type: 'CASE_CREATED',
      visibility: 'PUBLIC',
      title: '客服案件已建立',
      message: description,
      operator: sourceName || sourceRole,
      actorRole: sourceRole,
      metadata: { category, orderId, identityVerified: identity.verified },
    });

    return res.status(201).json({
      success: true,
      caseId,
      accessToken,
      message: '客服案件已建立，請妥善保存案件編號與查詢憑證。',
      case: supportSerializeCase(payload),
    });
  } catch (error) {
    console.error('❌ 建立客服案件失敗：', error);
    return res.status(500).json({ success: false, message: error.message || '建立客服案件失敗。' });
  }
});

app.get('/api/support/cases/:caseId', async (req, res) => {
  try {
    const caseId = supportCleanText(req.params.caseId, 100).toUpperCase();
    const access = await supportValidateCaseAccess(caseId, req, { allowAdmin: false });
    const detail = await supportReadCaseDetail(caseId, { includeInternal: false });
    return res.json({ success: true, ...supportPublicCaseView(detail), accessMode: access.accessMode });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || '讀取客服案件失敗。',
    });
  }
});

app.post('/api/support/cases/:caseId/messages', async (req, res) => {
  try {
    const caseId = supportCleanText(req.params.caseId, 100).toUpperCase();
    const access = await supportValidateCaseAccess(caseId, req, { allowAdmin: false });
    const message = supportCleanText(req.body?.message, 3000);
    if (!message) {
      return res.status(400).json({ success: false, message: '請填寫補充內容。' });
    }

    const nowMs = Date.now();
    await Promise.all([
      supportWriteEvent(caseId, {
        type: 'PUBLIC_MESSAGE',
        visibility: 'PUBLIC',
        title: '案件補充說明',
        message,
        operator: supportCleanText(access.caseData.sourceName || access.caseData.sourceRole, 160),
        actorRole: access.caseData.sourceRole,
      }),
      db.collection('supportCases').doc(caseId).set({
        messageCount: admin.firestore.FieldValue.increment(1),
        latestCustomerMessage: message,
        latestCustomerMessageAtMs: nowMs,
        latestCustomerMessageAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAtMs: nowMs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: access.caseData.status === 'WAITING_USER' ? 'IN_PROGRESS' : access.caseData.status,
        statusLabel: access.caseData.status === 'WAITING_USER' ? '客服處理中' : access.caseData.statusLabel,
      }, { merge: true }),
    ]);

    const detail = await supportReadCaseDetail(caseId, { includeInternal: false });
    return res.json({ success: true, ...supportPublicCaseView(detail) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || '新增案件訊息失敗。',
    });
  }
});

app.get('/api/admin/support/cases', supportRequireAdmin, async (req, res) => {
  try {
    const status = supportCleanText(req.query?.status, 80).toUpperCase();
    const sourceRole = supportCleanText(req.query?.sourceRole, 80).toLowerCase();
    const category = supportCleanText(req.query?.category, 100).toUpperCase();
    const search = supportCleanText(req.query?.search, 200).toLowerCase();
    const deletedMode = supportCleanText(req.query?.deleted, 30).toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(req.query?.limit || 300)));

    const snap = await db.collection('supportCases').limit(1500).get();
    const allCases = snap.docs.map(supportSerializeCase);
    const activeCases = allCases.filter(item => !item.isDeleted);
    const deletedCases = allCases.filter(item => item.isDeleted);

    let cases = deletedMode === 'only'
      ? deletedCases
      : deletedMode === 'include'
        ? allCases
        : activeCases;

    if (status) cases = cases.filter(item => item.status === status);
    if (sourceRole) cases = cases.filter(item => item.sourceRole === sourceRole);
    if (category) cases = cases.filter(item => item.category === category);
    if (search) {
      cases = cases.filter(item => [
        item.caseId,
        item.orderId,
        item.orderNo,
        item.sourceName,
        item.contactPhone,
        item.title,
        item.description,
        item.assignedTo,
        item.deletedReason,
      ].some(value => String(value || '').toLowerCase().includes(search)));
    }

    cases.sort((a, b) => {
      const aTime = a.isDeleted ? a.deletedAtMs : a.updatedAtMs;
      const bTime = b.isDeleted ? b.deletedAtMs : b.updatedAtMs;
      return bTime - aTime;
    });
    cases = cases.slice(0, limit);

    const summary = {
      total: activeCases.length,
      open: activeCases.filter(item => item.status === 'OPEN').length,
      inProgress: activeCases.filter(item => item.status === 'IN_PROGRESS').length,
      waitingUser: activeCases.filter(item => item.status === 'WAITING_USER').length,
      waitingFinance: activeCases.filter(item => item.status === 'WAITING_FINANCE').length,
      resolved: activeCases.filter(item => item.status === 'RESOLVED').length,
      closed: activeCases.filter(item => item.status === 'CLOSED').length,
      deleted: deletedCases.length,
      criticalActive: activeCases.filter(item =>
        item.severity === 'CRITICAL' &&
        !['RESOLVED', 'CLOSED'].includes(item.status)
      ).length,
    };

    return res.json({
      success: true,
      summary,
      cases,
      categories: Object.entries(UBEE_SUPPORT_CATEGORIES).map(([value, meta]) => ({ value, ...meta })),
      statuses: Object.values(UBEE_SUPPORT_CASE_STATUSES),
    });
  } catch (error) {
    console.error('❌ 讀取客服案件列表失敗：', error);
    return res.status(500).json({ success: false, message: '讀取客服案件列表失敗。' });
  }
});

app.get('/api/admin/support/cases/:caseId', supportRequireAdmin, async (req, res) => {
  try {
    const caseId = supportCleanText(req.params.caseId, 100).toUpperCase();
    const detail = await supportReadCaseDetail(caseId, { includeInternal: true });
    if (!detail) return res.status(404).json({ success: false, message: '找不到客服案件。' });

    let order = null;
    let finance = null;
    let incidents = [];
    if (detail.case.orderId) {
      const orderDoc = await getFinanceOrderDoc(detail.case.orderId);
      if (orderDoc) {
        order = { id: orderDoc.id, ...(orderDoc.data() || {}) };
        finance = buildFinanceClosureSnapshot(order);
      }
      incidents = await supportGetLinkedIncidents(detail.case.orderId);
    }

    return res.json({
      success: true,
      ...detail,
      orderSnapshot: detail.case.orderSnapshot || null,
      liveOrder: order ? supportBuildOrderSnapshot(order) : null,
      finance,
      incidents,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || '讀取客服案件失敗。' });
  }
});

async function supportUpdateLinkedOrder(orderId, update) {
  const doc = await getFinanceOrderDoc(orderId);
  if (!doc) return false;
  await doc.ref.set(update, { merge: true });
  return true;
}

app.post('/api/admin/support/cases/:caseId/action', supportRequireAdmin, async (req, res) => {
  try {
    const caseId = supportCleanText(req.params.caseId, 100).toUpperCase();
    const action = supportCleanText(req.body?.action, 100).toUpperCase();
    const message = supportCleanText(req.body?.message, 3000);
    const assignedTo = supportCleanText(req.body?.assignedTo, 160);
    const operator = supportCleanText(req.body?.operator || req.supportAdmin?.operator, 160) || 'support_center';
    const caseRef = db.collection('supportCases').doc(caseId);
    const caseDoc = await caseRef.get();
    if (!caseDoc.exists) return res.status(404).json({ success: false, message: '找不到客服案件。' });

    const current = caseDoc.data() || {};
    if (current.deletedAtMs || current.deletedAt || current.status === 'DELETED') {
      return res.status(409).json({
        success: false,
        message: '此案件目前在垃圾桶中，請先復原案件再進行處理。',
      });
    }
    const nowMs = Date.now();
    const update = {
      updatedAtMs: nowMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastHandledBy: operator,
    };
    let event = {
      type: action,
      visibility: 'INTERNAL',
      title: '客服案件已更新',
      message,
      operator,
      actorRole: 'admin',
    };

    if (action === 'ASSIGN') {
      if (!assignedTo) return res.status(400).json({ success: false, message: '請填寫負責人。' });
      update.assignedTo = assignedTo;
      update.assignedAtMs = nowMs;
      update.assignedAt = admin.firestore.FieldValue.serverTimestamp();
      event.title = '已指派客服負責人';
      event.message = `負責人：${assignedTo}${message ? `｜${message}` : ''}`;
    } else if (action === 'START') {
      update.status = 'IN_PROGRESS';
      update.statusLabel = '客服處理中';
      update.startedAtMs = nowMs;
      update.startedAt = admin.firestore.FieldValue.serverTimestamp();
      event.visibility = 'PUBLIC';
      event.title = '客服已開始處理';
      event.message = message || 'UBee 客服已開始處理此案件。';
    } else if (action === 'WAIT_USER') {
      update.status = 'WAITING_USER';
      update.statusLabel = '等待回覆資料';
      event.visibility = 'PUBLIC';
      event.title = '客服等待補充資料';
      event.message = message || '請補充客服所需的資料或證據。';
    } else if (action === 'PUBLIC_REPLY') {
      if (!message) return res.status(400).json({ success: false, message: '請填寫對外回覆。' });
      update.latestPublicReply = message;
      update.latestPublicReplyAtMs = nowMs;
      update.latestPublicReplyAt = admin.firestore.FieldValue.serverTimestamp();
      update.messageCount = admin.firestore.FieldValue.increment(1);
      if (['OPEN', 'WAITING_USER'].includes(current.status)) {
        update.status = 'IN_PROGRESS';
        update.statusLabel = '客服處理中';
      }
      event.visibility = 'PUBLIC';
      event.title = 'UBee 客服回覆';
    } else if (action === 'INTERNAL_NOTE') {
      if (!message) return res.status(400).json({ success: false, message: '請填寫內部備註。' });
      update.latestInternalNote = message;
      update.latestInternalNoteAtMs = nowMs;
      event.title = '新增內部備註';
    } else if (action === 'RESOLVE') {
      if (!message) return res.status(400).json({ success: false, message: '請填寫結案結果。' });
      update.status = 'RESOLVED';
      update.statusLabel = '案件已解決';
      update.resolution = message;
      update.resolvedBy = operator;
      update.resolvedAtMs = nowMs;
      update.resolvedAt = admin.firestore.FieldValue.serverTimestamp();
      update.active = false;
      event.visibility = 'PUBLIC';
      event.title = '客服案件已解決';
    } else if (action === 'CLOSE') {
      update.status = 'CLOSED';
      update.statusLabel = '案件已關閉';
      update.closedBy = operator;
      update.closedAtMs = nowMs;
      update.closedAt = admin.firestore.FieldValue.serverTimestamp();
      update.active = false;
      event.visibility = 'PUBLIC';
      event.title = '客服案件已關閉';
      event.message = message || '此客服案件已正式關閉。';
    } else if (action === 'REOPEN') {
      update.status = 'OPEN';
      update.statusLabel = '待客服處理';
      update.active = true;
      update.reopenedBy = operator;
      update.reopenedAtMs = nowMs;
      update.reopenedAt = admin.firestore.FieldValue.serverTimestamp();
      event.visibility = 'PUBLIC';
      event.title = '客服案件已重新開啟';
      event.message = message || '案件已重新開啟並等待客服處理。';
    } else {
      return res.status(400).json({ success: false, message: '不支援的客服案件操作。' });
    }

    await Promise.all([
      caseRef.set(update, { merge: true }),
      supportWriteEvent(caseId, event),
      current.orderId
        ? supportUpdateLinkedOrder(current.orderId, {
            activeSupportCaseId: caseId,
            supportStatus: update.status || current.status,
            latestSupportCaseAtMs: nowMs,
            latestSupportCaseAt: admin.firestore.FieldValue.serverTimestamp(),
          }).catch(() => false)
        : Promise.resolve(),
    ]);

    const detail = await supportReadCaseDetail(caseId, { includeInternal: true });
    return res.json({ success: true, ...detail });
  } catch (error) {
    console.error('❌ 更新客服案件失敗：', error);
    return res.status(500).json({ success: false, message: error.message || '更新客服案件失敗。' });
  }
});


async function supportDeleteSubcollection(caseRef, subcollectionName) {
  let deletedCount = 0;
  while (true) {
    const snap = await caseRef.collection(subcollectionName).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    deletedCount += snap.size;
    if (snap.size < 400) break;
  }
  return deletedCount;
}

async function supportSyncLinkedOrderAfterRemoval(orderId, removedCaseId) {
  if (!orderId) return false;
  const orderDoc = await getFinanceOrderDoc(orderId);
  if (!orderDoc) return false;
  const orderData = orderDoc.data() || {};
  if (String(orderData.activeSupportCaseId || '').toUpperCase() !== String(removedCaseId || '').toUpperCase()) {
    return false;
  }

  let replacement = null;
  try {
    const snap = await db.collection('supportCases').where('orderId', '==', String(orderId).toUpperCase()).limit(100).get();
    replacement = snap.docs
      .map(supportSerializeCase)
      .filter(item => item.caseId !== removedCaseId && !item.isDeleted && item.active !== false)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0] || null;
  } catch (error) {
    console.warn('⚠️ 重新計算訂單客服案件失敗：', error?.message || error);
  }

  const update = replacement
    ? {
        activeSupportCaseId: replacement.caseId,
        supportStatus: replacement.status,
        latestSupportCaseAtMs: replacement.updatedAtMs || Date.now(),
      }
    : {
        activeSupportCaseId: admin.firestore.FieldValue.delete(),
        supportStatus: 'NONE',
        latestSupportCaseAtMs: Date.now(),
      };
  update.latestSupportCaseAt = admin.firestore.FieldValue.serverTimestamp();
  await orderDoc.ref.set(update, { merge: true });
  return true;
}

app.post('/api/admin/support/cases/:caseId/trash', supportRequireAdmin, async (req, res) => {
  try {
    const caseId = supportCleanText(req.params.caseId, 100).toUpperCase();
    const operator = supportCleanText(req.body?.operator || req.supportAdmin?.operator, 160) || 'support_center';
    const reason = supportCleanText(req.body?.reason, 1200);
    if (!reason) {
      return res.status(400).json({ success: false, message: '請填寫刪除案件的原因。' });
    }

    const caseRef = db.collection('supportCases').doc(caseId);
    const caseDoc = await caseRef.get();
    if (!caseDoc.exists) return res.status(404).json({ success: false, message: '找不到客服案件。' });
    const current = caseDoc.data() || {};
    if (current.deletedAtMs || current.deletedAt || current.status === 'DELETED') {
      const detail = await supportReadCaseDetail(caseId, { includeInternal: true });
      return res.json({ success: true, alreadyDeleted: true, ...detail });
    }

    const nowMs = Date.now();
    await caseRef.set({
      previousStatus: current.status || 'OPEN',
      previousStatusLabel: current.statusLabel || '待客服處理',
      previousActive: current.active !== false,
      status: 'DELETED',
      statusLabel: '已移至垃圾桶',
      active: false,
      deletedReason: reason,
      deletedBy: operator,
      deletedAtMs: nowMs,
      deletedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAtMs: nowMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastHandledBy: operator,
    }, { merge: true });

    await Promise.all([
      supportWriteEvent(caseId, {
        type: 'CASE_MOVED_TO_TRASH',
        visibility: 'INTERNAL',
        title: '案件已移至垃圾桶',
        message: reason,
        operator,
        actorRole: 'admin',
      }),
      supportSyncLinkedOrderAfterRemoval(current.orderId, caseId).catch(() => false),
    ]);

    const detail = await supportReadCaseDetail(caseId, { includeInternal: true });
    return res.json({ success: true, message: '案件已移至垃圾桶，可隨時復原。', ...detail });
  } catch (error) {
    console.error('❌ 刪除客服案件失敗：', error);
    return res.status(500).json({ success: false, message: error.message || '刪除客服案件失敗。' });
  }
});

app.post('/api/admin/support/cases/:caseId/restore', supportRequireAdmin, async (req, res) => {
  try {
    const caseId = supportCleanText(req.params.caseId, 100).toUpperCase();
    const operator = supportCleanText(req.body?.operator || req.supportAdmin?.operator, 160) || 'support_center';
    const message = supportCleanText(req.body?.message, 1200) || '案件已從垃圾桶復原。';
    const caseRef = db.collection('supportCases').doc(caseId);
    const caseDoc = await caseRef.get();
    if (!caseDoc.exists) return res.status(404).json({ success: false, message: '找不到客服案件。' });
    const current = caseDoc.data() || {};
    if (!(current.deletedAtMs || current.deletedAt || current.status === 'DELETED')) {
      return res.status(409).json({ success: false, message: '此案件不在垃圾桶中。' });
    }

    const restoredStatus = String(current.previousStatus || 'OPEN').toUpperCase() === 'DELETED'
      ? 'OPEN'
      : String(current.previousStatus || 'OPEN').toUpperCase();
    const restoredLabel = current.previousStatusLabel || (restoredStatus === 'OPEN' ? '待客服處理' : restoredStatus);
    const restoredActive = !['RESOLVED', 'CLOSED'].includes(restoredStatus);
    const nowMs = Date.now();

    await caseRef.set({
      status: restoredStatus,
      statusLabel: restoredLabel,
      active: restoredActive,
      restoredBy: operator,
      restoredAtMs: nowMs,
      restoredAt: admin.firestore.FieldValue.serverTimestamp(),
      deletedAtMs: admin.firestore.FieldValue.delete(),
      deletedAt: admin.firestore.FieldValue.delete(),
      deletedBy: admin.firestore.FieldValue.delete(),
      deletedReason: admin.firestore.FieldValue.delete(),
      previousStatus: admin.firestore.FieldValue.delete(),
      previousStatusLabel: admin.firestore.FieldValue.delete(),
      previousActive: admin.firestore.FieldValue.delete(),
      updatedAtMs: nowMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastHandledBy: operator,
    }, { merge: true });

    await Promise.all([
      supportWriteEvent(caseId, {
        type: 'CASE_RESTORED',
        visibility: 'INTERNAL',
        title: '案件已從垃圾桶復原',
        message,
        operator,
        actorRole: 'admin',
      }),
      current.orderId && restoredActive
        ? supportUpdateLinkedOrder(current.orderId, {
            activeSupportCaseId: caseId,
            supportStatus: restoredStatus,
            latestSupportCaseAtMs: nowMs,
            latestSupportCaseAt: admin.firestore.FieldValue.serverTimestamp(),
          }).catch(() => false)
        : Promise.resolve(),
    ]);

    const detail = await supportReadCaseDetail(caseId, { includeInternal: true });
    return res.json({ success: true, message: '案件已復原。', ...detail });
  } catch (error) {
    console.error('❌ 復原客服案件失敗：', error);
    return res.status(500).json({ success: false, message: error.message || '復原客服案件失敗。' });
  }
});

app.delete('/api/admin/support/cases/:caseId', supportRequireAdmin, async (req, res) => {
  try {
    const caseId = supportCleanText(req.params.caseId, 100).toUpperCase();
    const confirmCaseId = supportCleanText(req.body?.confirmCaseId, 100).toUpperCase();
    const operator = supportCleanText(req.body?.operator || req.supportAdmin?.operator, 160) || 'support_center';
    if (!caseId || confirmCaseId !== caseId) {
      return res.status(400).json({ success: false, message: '永久刪除前，必須完整輸入案件編號確認。' });
    }

    const caseRef = db.collection('supportCases').doc(caseId);
    const caseDoc = await caseRef.get();
    if (!caseDoc.exists) return res.status(404).json({ success: false, message: '找不到客服案件。' });
    const current = caseDoc.data() || {};
    if (!(current.deletedAtMs || current.deletedAt || current.status === 'DELETED')) {
      return res.status(409).json({ success: false, message: '案件必須先移到垃圾桶，才能永久刪除。' });
    }
    if (current.refundRequestId || current.refundRequestStatus) {
      return res.status(409).json({
        success: false,
        message: '此案件已有退款／財務審核紀錄，基於帳務稽核只能留在垃圾桶，不能永久刪除。',
      });
    }

    const evidenceSnap = await caseRef.collection('evidence').limit(1000).get();
    const storageTargets = evidenceSnap.docs.map(doc => doc.data() || {}).filter(item => item.storagePath);
    const storageWarnings = [];
    for (const item of storageTargets) {
      try {
        const bucketName = supportCleanText(item.storageBucket || UBEE_SUPPORT_STORAGE_BUCKET, 300);
        if (bucketName) await admin.storage().bucket(bucketName).file(item.storagePath).delete({ ignoreNotFound: true });
      } catch (error) {
        storageWarnings.push(item.storagePath);
        console.warn('⚠️ 永久刪除客服證據檔案失敗：', item.storagePath, error?.message || error);
      }
    }

    const [deletedEvents, deletedEvidence] = await Promise.all([
      supportDeleteSubcollection(caseRef, 'events'),
      supportDeleteSubcollection(caseRef, 'evidence'),
    ]);
    await caseRef.delete();
    await supportSyncLinkedOrderAfterRemoval(current.orderId, caseId).catch(() => false);

    console.log(`🗑️ 客服案件已永久刪除：${caseId}，操作人員：${operator}`);
    return res.json({
      success: true,
      caseId,
      deletedEvents,
      deletedEvidence,
      storageWarnings,
      message: storageWarnings.length
        ? '案件資料已永久刪除，但部分 Storage 檔案刪除失敗，請至 Firebase Storage 人工確認。'
        : '案件與任務證據已永久刪除，無法復原。',
    });
  } catch (error) {
    console.error('❌ 永久刪除客服案件失敗：', error);
    return res.status(500).json({ success: false, message: error.message || '永久刪除客服案件失敗。' });
  }
});

app.post('/api/admin/support/cases/:caseId/refund-request', supportRequireAdmin, async (req, res) => {
  try {
    const caseId = supportCleanText(req.params.caseId, 100).toUpperCase();
    const operator = supportCleanText(req.body?.operator || req.supportAdmin?.operator, 160) || 'support_center';
    const reason = supportCleanText(req.body?.reason, 2000);
    const requestedAmount = Math.max(0, financeNumber(req.body?.amount, 0));
    if (!reason || requestedAmount <= 0) {
      return res.status(400).json({ success: false, message: '請填寫退款金額與原因。' });
    }

    const caseRef = db.collection('supportCases').doc(caseId);
    const caseDoc = await caseRef.get();
    if (!caseDoc.exists) return res.status(404).json({ success: false, message: '找不到客服案件。' });
    const caseData = caseDoc.data() || {};
    if (!caseData.orderId) {
      return res.status(400).json({ success: false, message: '此案件沒有關聯訂單，不能送出退款申請。' });
    }

    const orderDoc = await getFinanceOrderDoc(caseData.orderId);
    if (!orderDoc) return res.status(404).json({ success: false, message: '找不到關聯訂單。' });
    const order = { id: orderDoc.id, ...(orderDoc.data() || {}) };
    const finance = buildFinanceClosureSnapshot(order);
    const maximumAmount = Math.max(
      finance.finalCustomerTotal,
      finance.actualPaidAmount,
      finance.riderAdvance,
      0
    );

    if (maximumAmount > 0 && requestedAmount > maximumAmount) {
      return res.status(400).json({
        success: false,
        message: `退款申請金額不可高於目前可核對金額 NT$${maximumAmount}。`,
      });
    }

    const requestId = `refund_${caseId}_${Date.now()}`;
    const nowMs = Date.now();
    const refundRef = db.collection('financeRefundRequests').doc(requestId);
    const payload = {
      requestId,
      caseId,
      orderId: String(orderDoc.id).toUpperCase(),
      orderNo: supportCleanText(order.orderNo || orderDoc.id, 100),
      requestedAmount,
      reason,
      status: 'PENDING_FINANCE_REVIEW',
      requestedBy: operator,
      supportCaseCategory: caseData.category || '',
      financeSnapshot: finance,
      createdAtMs: nowMs,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAtMs: nowMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.runTransaction(async tx => {
      tx.set(refundRef, payload);
      tx.set(caseRef, {
        status: 'WAITING_FINANCE',
        statusLabel: '等待財務審核',
        refundRequestId: requestId,
        refundRequestStatus: 'PENDING_FINANCE_REVIEW',
        refundRequestedAmount: requestedAmount,
        refundRequestedReason: reason,
        refundRequestedBy: operator,
        refundRequestedAtMs: nowMs,
        refundRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAtMs: nowMs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      tx.set(orderDoc.ref, {
        refundRequestId: requestId,
        refundRequestStatus: 'PENDING_FINANCE_REVIEW',
        refundRequestedAmount: requestedAmount,
        refundRequestedReason: reason,
        refundRequestedAtMs: nowMs,
        refundRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
        activeSupportCaseId: caseId,
        supportStatus: 'WAITING_FINANCE',
      }, { merge: true });
    });

    await Promise.all([
      supportWriteEvent(caseId, {
        type: 'REFUND_REQUESTED',
        visibility: 'PUBLIC',
        title: '退款申請已送交財務審核',
        message: `申請金額：NT$${requestedAmount.toLocaleString('zh-TW')}。${reason}`,
        operator,
        actorRole: 'admin',
        metadata: { requestId, requestedAmount },
      }),
      writeFinanceAuditLog({
        orderId: orderDoc.id,
        type: 'refund_requested_from_support',
        operator,
        reason,
        before: { refundRequestStatus: order.refundRequestStatus || 'NOT_REQUESTED' },
        after: { refundRequestStatus: 'PENDING_FINANCE_REVIEW', requestedAmount },
        metadata: { caseId, requestId },
      }).catch(() => {}),
    ]);

    return res.json({
      success: true,
      request: supportRemoveUndefined({ ...payload, createdAt: undefined, updatedAt: undefined }),
      message: '退款申請已送交財務中心審核，不會自動退款。',
    });
  } catch (error) {
    console.error('❌ 客服退款申請失敗：', error);
    return res.status(500).json({ success: false, message: error.message || '退款申請失敗。' });
  }
});

app.get('/api/admin/support/refund-requests', supportRequireAdmin, async (req, res) => {
  try {
    const snap = await db.collection('financeRefundRequests').limit(500).get();
    const requests = snap.docs.map(doc => {
      const data = doc.data() || {};
      return {
        ...data,
        requestId: doc.id,
        createdAtMs: supportToMs(data.createdAtMs) || supportToMs(data.createdAt),
        updatedAtMs: supportToMs(data.updatedAtMs) || supportToMs(data.updatedAt),
      };
    }).sort((a, b) => b.createdAtMs - a.createdAtMs);

    return res.json({ success: true, requests });
  } catch (error) {
    return res.status(500).json({ success: false, message: '讀取退款申請失敗。' });
  }
});


const UBEE_CUSTOMER_TRACKING_STAGES = Object.freeze([
  { key:'created', label:'任務已成立' },
  { key:'matching', label:'等待小U接單' },
  { key:'accepted', label:'小U已接單' },
  { key:'to_pickup', label:'前往取件' },
  { key:'at_pickup', label:'抵達取件' },
  { key:'delivery', label:'配送中' },
  { key:'at_dropoff', label:'抵達送達' },
  { key:'completed', label:'任務完成' },
]);

function normalizeCustomerTrackingStatus(status) {
  const safe = String(status || '').trim().toLowerCase();
  const aliases = {
    done:'completed',
    dispatching:'pending_dispatch',
    searching:'pending_dispatch',
    redispatching:'pending_dispatch',
    going_pickup:'going_to_pickup',
    to_pickup:'going_to_pickup',
    delivering:'going_to_dropoff',
    to_dropoff:'going_to_dropoff',
  };
  return aliases[safe] || safe || 'pending_dispatch';
}

function getCustomerTrackingStage(status) {
  const safe = normalizeCustomerTrackingStatus(status);
  const map = {
    draft_confirm:0,
    pending_payment:0,
    merchant_pending:0,
    merchant_preparing:0,
    merchant_ready:0,
    pending_schedule:0,
    scheduled_reserved:1,
    scheduled_confirmed:1,
    pending_dispatch:1,
    accepted:2,
    going_to_pickup:3,
    arrived_pickup:4,
    picked_up:5,
    going_to_dropoff:5,
    arrived_dropoff:6,
    completed:7,
    cancelled:0,
  };
  const index = Number.isInteger(map[safe]) ? map[safe] : 1;
  return {
    index,
    count:UBEE_CUSTOMER_TRACKING_STAGES.length,
    ...UBEE_CUSTOMER_TRACKING_STAGES[index],
  };
}

function getCustomerTrackingCopy(order = {}, incident = null) {
  const status = normalizeCustomerTrackingStatus(order.status);
  if (incident) {
    return {
      title:'UBee 正在協助處理異常',
      description:incident.typeLabel || incident.title || '調度中心已介入處理，訂單資料會持續保留。',
    };
  }
  const copy = {
    draft_confirm:['任務資料確認中','系統正在確認本次任務資料。'],
    pending_payment:['等待確認現金單','確認後系統會開始媒合附近的小U。'],
    merchant_pending:['等待合作店家確認','店家確認後系統會開始媒合小U。'],
    merchant_preparing:['店家準備中','店家正在準備本次任務內容。'],
    merchant_ready:['店家已備妥','系統正在安排小U前往取件。'],
    pending_schedule:['預約需求已建立','正在媒合可於指定時間執行的小U。'],
    scheduled_reserved:['預約已成立','已有小U提前承接本次預約。'],
    scheduled_confirmed:['預約已確認','小U已確認可以依預約時間執行。'],
    pending_dispatch:['正在尋找附近的小U','小U接單後會顯示距離與預計抵達時間。'],
    accepted:['小U已接下任務','小U正在準備前往取件地點。'],
    going_to_pickup:['小U正在前往取件地點','請保持聯絡方式暢通。'],
    arrived_pickup:['小U已抵達取件地點','正在處理取件。'],
    picked_up:['小U已完成取件','任務進入配送階段。'],
    going_to_dropoff:['小U正在前往送達地點','系統會持續更新剩餘路程。'],
    arrived_dropoff:['小U已抵達送達地點','請準備完成交付。'],
    completed:['任務已完成','感謝使用 UBee 跑腿。'],
    cancelled:['任務已取消','如需協助，請聯繫 UBee 跑腿客服。'],
  }[status] || ['任務狀態更新中','系統正在同步最新進度。'];
  return { title:copy[0], description:copy[1] };
}

function getCustomerTrackingMoney(order = {}) {
  const candidates = [
    order.customerPayableTotal,
    order.customerPayTotal,
    order.customerPayAmount,
    order.customerTotalWithAdvance,
    order.payableTotal,
    order.finalPayAmount,
    order.total,
    order.totalFee,
    order.price,
  ];
  for (const value of candidates) {
    const amount = Number(value);
    if (Number.isFinite(amount) && amount >= 0) return Math.round(amount);
  }
  return null;
}

function getCustomerLocationHealth(order = {}, nowMs = Date.now()) {
  const updatedAtMs =
    Number(order.riderLocationUpdatedAtMs || 0) ||
    Number(order.trackingUpdatedAtMs || 0) ||
    dispatchIncidentTimeMs(order.riderLocationUpdatedAt) ||
    dispatchIncidentTimeMs(order.trackingUpdatedAt);
  if (!updatedAtMs) {
    return { key:'waiting', label:'等待小U定位', updatedAtMs:0, ageMs:null };
  }
  const ageMs = Math.max(0, nowMs - updatedAtMs);
  if (ageMs <= 90 * 1000) return { key:'live', label:'即時定位正常', updatedAtMs, ageMs };
  if (ageMs <= 5 * 60 * 1000) return { key:'delayed', label:'定位更新稍有延遲', updatedAtMs, ageMs };
  return { key:'stale', label:'定位暫時中斷', updatedAtMs, ageMs };
}

async function getCustomerActiveIncident(orderId) {
  try {
    const snap = await db.collection('dispatchIncidents')
      .where('orderId', '==', String(orderId || '').trim().toUpperCase())
      .limit(20)
      .get();
    return snap.docs
      .map(serializeDispatchIncident)
      .filter(item => ['OPEN','IN_PROGRESS'].includes(item.status))
      .sort((a,b) => Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0))[0] || null;
  } catch (error) {
    console.warn('⚠️ 客戶追蹤讀取異常案件失敗（不影響訂單追蹤）：', error?.message || error);
    return null;
  }
}

function buildCustomerTrackingPayload(order = {}, incident = null, nowMs = Date.now()) {
  const status = normalizeCustomerTrackingStatus(order.status);
  const stage = getCustomerTrackingStage(status);
  const copy = getCustomerTrackingCopy(order, incident);
  const locationHealth = getCustomerLocationHealth(order, nowMs);
  const riderCurrentLat = Number(order.riderCurrentLat ?? order.riderCurrentLocation?.lat);
  const riderCurrentLng = Number(order.riderCurrentLng ?? order.riderCurrentLocation?.lng);
  const pickupLat = Number(order.pickupLat ?? order.pickupLocation?.lat);
  const pickupLng = Number(order.pickupLng ?? order.pickupLocation?.lng);
  const dropoffLat = Number(order.dropoffLat ?? order.dropoffLocation?.lat);
  const dropoffLng = Number(order.dropoffLng ?? order.dropoffLocation?.lng);
  const statusTimes = order.statusTimes && typeof order.statusTimes === 'object'
    ? Object.fromEntries(Object.entries(order.statusTimes).map(([key,value]) => [key, dispatchIncidentTimeMs(value)]))
    : {};

  return {
    trackingVersion:'customer-tracking-v3-2026-07-27',
    serverTimeMs:nowMs,
    orderId:String(order.id || '').trim().toUpperCase(),
    status,
    statusLabel:getStatusLabel(status),
    stage,
    title:copy.title,
    description:copy.description,
    isTerminal:['completed','cancelled'].includes(status),
    serviceType:String(order.serviceType || order.serviceName || 'UBee 跑腿任務'),
    serviceGroup:String(order.serviceGroup || order.serviceKey || ''),
    pickupAddress:String(order.pickupAddress || order.pickup || order.fromAddress || ''),
    dropoffAddress:String(order.dropoffAddress || order.dropoff || order.toAddress || ''),
    pickupLat:Number.isFinite(pickupLat) ? pickupLat : null,
    pickupLng:Number.isFinite(pickupLng) ? pickupLng : null,
    dropoffLat:Number.isFinite(dropoffLat) ? dropoffLat : null,
    dropoffLng:Number.isFinite(dropoffLng) ? dropoffLng : null,
    rider:{
      assigned:!!(order.riderDocId || order.riderId || order.riderName),
      name:String(order.riderName || order.riderDisplayName || ''),
      vehicleType:String(order.riderVehicleType || order.vehicleType || ''),
      currentLat:Number.isFinite(riderCurrentLat) ? riderCurrentLat : null,
      currentLng:Number.isFinite(riderCurrentLng) ? riderCurrentLng : null,
      heading:Number.isFinite(Number(order.riderHeading)) ? Number(order.riderHeading) : null,
      speed:Number.isFinite(Number(order.riderSpeed)) ? Number(order.riderSpeed) : null,
      accuracy:Number.isFinite(Number(order.riderLocationAccuracy)) ? Number(order.riderLocationAccuracy) : null,
      locationHealth,
    },
    eta:{
      text:String(order.etaText || order.estimatedTime || order.estimatedCompletionText || ''),
      minutes:Number.isFinite(Number(order.etaMinutes)) ? Number(order.etaMinutes) : null,
      estimatedPickupMinutes:Number.isFinite(Number(order.estimatedPickupMinutes)) ? Number(order.estimatedPickupMinutes) : null,
      estimatedCompletionMinutes:Number.isFinite(Number(order.estimatedCompletionMinutes)) ? Number(order.estimatedCompletionMinutes) : null,
    },
    route:{
      riderToPickupDistanceText:String(order.riderToPickupDistanceText || order.distanceToPickupText || ''),
      riderToDropoffDistanceText:String(order.riderToDropoffDistanceText || order.distanceToDropoffText || order.remainingDistanceText || ''),
      remainingDistanceKm:Number.isFinite(Number(order.remainingDistanceKm)) ? Number(order.remainingDistanceKm) : null,
    },
    total:getCustomerTrackingMoney(order),
    paymentMethod:String(order.paymentMethod || ''),
    paymentStatus:String(order.paymentStatus || ''),
    statusTimes,
    activeIncident:incident ? {
      incidentId:incident.incidentId,
      type:incident.type,
      typeLabel:incident.typeLabel,
      title:incident.title,
      description:incident.description,
      severity:incident.severity,
      status:incident.status,
      assignedTo:incident.assignedTo,
      updatedAtMs:incident.updatedAtMs,
    } : null,
    updatedAtMs:
      Number(order.customerTrackingUpdatedAtMs || 0) ||
      Number(order.trackingUpdatedAtMs || 0) ||
      dispatchIncidentTimeMs(order.updatedAt) ||
      nowMs,
  };
}

app.get('/api/customer/orders/:orderId/tracking', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const orderId = String(req.params.orderId || '').trim().toUpperCase();
    const requestUserId = String(req.query.userId || req.query.customerId || '').trim();
    if (!orderId) {
      return res.status(400).json({ success:false, error:'缺少訂單編號' });
    }
    if (!isValidCustomerUserId(requestUserId)) {
      return res.status(401).json({ success:false, error:'LINE 身分驗證失敗' });
    }
    const order = await getOrder(orderId);
    if (!order) {
      return res.status(404).json({ success:false, error:'查無此訂單' });
    }
    if (!isSameCustomerUserId(order, requestUserId)) {
      return res.status(403).json({ success:false, error:'此訂單只能由原本下單的客人查詢' });
    }
    const incident = await getCustomerActiveIncident(orderId);
    return res.json({
      success:true,
      tracking:buildCustomerTrackingPayload(order, incident, Date.now()),
    });
  } catch (error) {
    console.error('❌ 讀取客戶即時追蹤摘要失敗：', error);
    return res.status(500).json({ success:false, error:'即時追蹤讀取失敗' });
  }
});

// =====================================================
// UBee 網路韌性健康檢查
// 前端只用來判斷「瀏覽器有網路但 UBee 後端是否可達」，不寫入任何資料。
// =====================================================
app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    success: true,
    service: 'ubee-backend',
    serverTime: new Date().toISOString(),
    serverTimeMs: Date.now(),
  });
});

app.listen(PORT, () => {
  console.log(`UBee OMS is running on port ${PORT}`);
});

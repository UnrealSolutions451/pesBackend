const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const dotenv = require('dotenv');
const cors = require('cors');
const admin = require('firebase-admin');
const qs = require('qs');

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());
const port = process.env.PORT || 4000;

// ============================================
// FIREBASE INITIALIZATION
// ============================================
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}
const db = admin.firestore();

// ============================================
// PHONEPE V2 CONFIG
// ============================================
const MODE = process.env.MODE || 'test';

const CONFIG = {
  AUTH_URL:
    MODE === 'live'
      ? 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token'
      : 'https://api-preprod.phonepe.com/apis/identity-manager/v1/oauth/token',

  PG_BASE:
    MODE === 'live'
      ? 'https://api.phonepe.com/apis/pg/checkout/v2'
      : 'https://api-preprod.phonepe.com/apis/pg/checkout/v2',

  CLIENT_ID: process.env.PHONEPE_CLIENT_ID,
  CLIENT_SECRET: process.env.PHONEPE_CLIENT_SECRET,
  MERCHANT_ID: process.env.PHONEPE_MERCHANT_ID,
  FRONTEND_URL: process.env.MERCHANT_BASE_URL,
  BACKEND_URL: 'https://pesbackend.onrender.com'
};

console.log('🚀 PhonePe V2 Configuration:');
console.log(`   Mode: ${MODE === 'live' ? '🔴 PRODUCTION' : '🟡 TEST'}`);
console.log(`   Merchant ID: ${CONFIG.MERCHANT_ID}`);
console.log(`   Client ID: ${CONFIG.CLIENT_ID}`);
console.log(`   Frontend: ${CONFIG.FRONTEND_URL}`);
console.log(`   Backend: ${CONFIG.BACKEND_URL}`);

// ============================================
// OAUTH TOKEN CACHING
// ============================================
let accessToken = null;
let tokenExpiry = null;

// ============================================
// GET OAUTH ACCESS TOKEN (V2 FORMAT)
// ============================================
async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    console.log('✅ Using cached OAuth token');
    return accessToken;
  }

  try {
    console.log('🔑 Fetching new OAuth token from PhonePe V2...');

    // NOTE: No client_version in body, it causes "Api Mapping Not Found"
    const postBody = qs.stringify({
      grant_type: 'client_credentials',
      client_id: CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET
    });

    const response = await axios.post(CONFIG.AUTH_URL, postBody, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (!response.data.access_token) {
      console.error('❌ Invalid token response:', response.data);
      throw new Error('Access token not found in response');
    }

    accessToken = response.data.access_token;
    const expiresIn = response.data.expires_in || 3600;
    tokenExpiry = Date.now() + expiresIn * 1000 - 60000;

    console.log(`✅ Access token obtained, expires in ${expiresIn}s`);
    return accessToken;
  } catch (err) {
    console.error('❌ Token fetch failed:', err.response?.data || err.message);
    throw new Error('Failed to get access token');
  }
}

// ============================================
// CREATE PAYMENT ORDER (V2 API)
// ============================================
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, total, table, sessionId } = req.body;

    if (!items || !total || total <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid order data' });
    }

    const orderId = `PES${Date.now()}`;
    const amountPaise = Math.round(total * 100);

    console.log('\n' + '='.repeat(60));
    console.log('📦 Creating Payment Order:');
    console.log(`   Order ID: ${orderId}`);
    console.log(`   Amount: ₹${total} (${amountPaise} paise)`);
    console.log(`   Session: ${sessionId}`);

    const token = await getAccessToken();

    const payload = {
      merchantId: CONFIG.MERCHANT_ID,
      merchantOrderId: orderId,
      merchantUserId: sessionId || `user_${Date.now()}`,
      amount: amountPaise,
      redirectUrl: `${CONFIG.FRONTEND_URL}/payment-return.html?orderId=${orderId}`,
      redirectMode: 'POST',
      callbackUrl: `${CONFIG.BACKEND_URL}/api/webhook`,
      paymentInstrument: { type: 'PAY_PAGE' }
    };

    console.log('🔹 Payload:', JSON.stringify(payload, null, 2));

    const response = await axios.post(`${CONFIG.PG_BASE}/pay`, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-MERCHANT-ID': CONFIG.MERCHANT_ID
      }
    });

    const phonepeResp = response.data;
    console.log('✅ PhonePe Response:', phonepeResp);

    await db.collection('orders').doc(orderId).set({
      merchantOrderId: orderId,
      items,
      table,
      sessionId,
      amount: total,
      status: 'PENDING',
      mode: MODE,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const checkoutUrl = phonepeResp.data?.instrumentResponse?.redirectInfo?.url;
    if (!checkoutUrl) {
      throw new Error('No checkout URL in PhonePe response');
    }

    console.log('✅ Checkout URL:', checkoutUrl);
    console.log('='.repeat(60) + '\n');

    res.json({ success: true, orderId, checkoutUrl });
  } catch (err) {
    console.error('❌ Order create failed:', {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to create payment order',
      error: err.response?.data || err.message
    });
  }
});

// ============================================
// PHONEPE WEBHOOK HANDLER
// ============================================
app.post('/api/webhook', async (req, res) => {
  try {
    console.log('\n🔔 Webhook received:', JSON.stringify(req.body, null, 2));

    const payload = req.body;
    const orderId = payload.data?.merchantOrderId || payload.merchantOrderId;

    if (!orderId) {
      console.error('❌ Missing order ID in webhook');
      return res.status(400).send('Missing order ID');
    }

    let status = 'PENDING';
    if (payload.code === 'PAYMENT_SUCCESS' || payload.status === 'SUCCESS') status = 'SUCCESS';
    else if (payload.code === 'PAYMENT_ERROR' || payload.status === 'FAILED') status = 'FAILED';

    await db.collection('orders').doc(orderId).update({
      status,
      phonepeCallback: payload,
      callbackReceivedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Order ${orderId} updated to: ${status}`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Webhook processing failed:', err.message);
    res.status(500).send('Webhook error');
  }
});

// ============================================
// ORDER STATUS CHECK
// ============================================
app.get('/api/order-status', async (req, res) => {
  const orderId = req.query.orderId;
  if (!orderId) return res.status(400).json({ success: false, message: 'Order ID required' });

  try {
    const token = await getAccessToken();
    const response = await axios.get(`${CONFIG.PG_BASE}/order/${orderId}/status`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-MERCHANT-ID': CONFIG.MERCHANT_ID
      }
    });

    console.log('📊 Status:', response.data);
    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error('❌ Status check failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// TEST TOKEN
// ============================================
app.get('/api/test-token', async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// START SERVER
// ============================================
app.listen(port, () => {
  console.log('\n' + '='.repeat(70));
  console.log('🎉 PES CANTEEN PAYMENT BACKEND - PHONEPE V2 READY');
  console.log('='.repeat(70));
  console.log(`✅ Running on port ${port}`);
  console.log(`🌍 Mode: ${MODE === 'live' ? 'PRODUCTION' : 'TEST'}`);
  console.log(`📡 AUTH_URL: ${CONFIG.AUTH_URL}`);
  console.log(`💳 PG_BASE: ${CONFIG.PG_BASE}`);
  console.log('='.repeat(70) + '\n');
});

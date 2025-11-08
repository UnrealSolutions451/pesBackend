const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const qs = require('qs');

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
const port = process.env.PORT || 4000;

// ============================================
// FIREBASE SETUP
// ============================================
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      // Parse the JSON string from Render environment variable
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('✅ Firebase initialized from environment variable');
    } else {
      console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not found — Firebase not initialized.');
    }
  } catch (err) {
    console.error('❌ Failed to initialize Firebase:', err.message);
  }
}

const db = admin.firestore();

// ============================================
// PHONEPE SDK INITIALIZATION (V2)
// ============================================
const PHONEPE_ENV = process.env.PHONEPE_ENV || 'TEST';
const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const CLIENT_ID = process.env.PHONEPE_CLIENT_ID;
const CLIENT_SECRET = process.env.PHONEPE_CLIENT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL;
const BACKEND_URL = process.env.BACKEND_URL || 'https://pesbackend.onrender.com';

let phonePeClient = null;
let sdkAvailable = false;

try {
  console.log('🔄 Attempting to load PhonePe SDK...');

  const PhonePeSDK = require('pg-sdk-node');
  console.log('📦 SDK exports:', Object.keys(PhonePeSDK));

  // ✅ Use StandardCheckoutClient from the SDK (V2)
  const { StandardCheckoutClient, Env } = PhonePeSDK;

  if (StandardCheckoutClient) {
    phonePeClient = new StandardCheckoutClient({
      environment: PHONEPE_ENV === 'LIVE' ? Env.PRODUCTION : Env.UAT,
      merchantId: MERCHANT_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET
    });
    sdkAvailable = true;
    console.log('✅ PhonePe SDK client initialized (Standard Checkout)');
  } else {
    console.warn('⚠️  StandardCheckoutClient not found in SDK exports');
  }

} catch (sdkError) {
  console.error('⚠️  PhonePe SDK not available:', sdkError.message);
  console.log('📌 Falling back to manual API integration');
  sdkAvailable = false;
}

console.log('\n' + '='.repeat(70));
console.log('🚀 PES CANTEEN PAYMENT BACKEND');
console.log('='.repeat(70));
console.log(`✅ Environment: ${PHONEPE_ENV === 'LIVE' ? '🔴 PRODUCTION' : '🟡 TEST'}`);
console.log(`📦 SDK Available: ${sdkAvailable ? '✅ YES' : '❌ NO (Using Manual API)'}`);
console.log(`🏪 Merchant ID: ${MERCHANT_ID}`);
console.log(`🔐 Client ID: ${CLIENT_ID}`);
console.log(`🌐 Frontend: ${FRONTEND_URL}`);
console.log(`🔗 Backend: ${BACKEND_URL}`);
console.log('='.repeat(70) + '\n');

// ============================================
// MANUAL API (Fallback) CONFIG
// ============================================
const API_CONFIG = {
  AUTH_URL: PHONEPE_ENV === 'LIVE'
    ? 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token'
    : 'https://api-preprod.phonepe.com/apis/identity-manager/v1/oauth/token',
  PG_BASE: PHONEPE_ENV === 'LIVE'
    ? 'https://api.phonepe.com/apis/pg/checkout/v2'
    : 'https://api-preprod.phonepe.com/apis/pg/checkout/v2'
};

let accessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) return accessToken;

  try {
    const body = qs.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials'
    });

    const response = await axios.post(API_CONFIG.AUTH_URL, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    accessToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in || 3600) * 1000;
    console.log('✅ OAuth token obtained');
    return accessToken;
  } catch (err) {
    console.error('❌ Token fetch failed:', err.response?.data || err.message);
    throw new Error('Failed to get OAuth token');
  }
}

// ============================================
// CREATE ORDER (SDK or Manual)
// ============================================
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, total, table, sessionId } = req.body;
    if (!items || !total || total <= 0)
      return res.status(400).json({ success: false, message: 'Invalid order data' });

    const orderId = `PES${Date.now()}`;
    const amountPaise = Math.round(total * 100);
    console.log(`\n📦 Creating Order: ${orderId} | Amount: ₹${total}`);

    let response;

    if (sdkAvailable && phonePeClient) {
  console.log('🔹 Using PhonePe SDK...');
  const { StandardCheckoutPayRequest, PgPaymentFlow } = require('pg-sdk-node');

  try {
    // 🧩 Debug: see what builder methods exist in this SDK version
    const builder = StandardCheckoutPayRequest.builder();
    console.log('🧩 Builder supports:', Object.keys(builder));

    // ✅ Build the payment request using correct available fields
    const paymentRequest = builder
      .merchantOrderId(orderId)
      .amount(amountPaise)
      .redirectUrl(`${FRONTEND_URL}/payment-return.html?orderId=${orderId}`)
      .metaInfo({
        merchantUserId: `${sessionId || 'user'}_${Date.now()}`,
        callbackUrl: `${BACKEND_URL}/api/webhook`,
        paymentInstrument: 'PAY_PAGE'
      })
      .build();

    // ✅ Pass the flow type explicitly
    response = await phonePeClient.pay(paymentRequest, PgPaymentFlow.STANDARD_CHECKOUT);
    console.log('✅ SDK Payment Response:', JSON.stringify(response, null, 2));

  } catch (sdkErr) {
    console.error('⚠️ SDK payment creation failed, falling back to manual API:', sdkErr.message);
    sdkAvailable = false; // Disable SDK for next attempts
    throw sdkErr;
  }

} else {
  console.log('🔹 Using Manual API...');
  const token = await getAccessToken();

  const payload = {
    merchantId: MERCHANT_ID,
    merchantOrderId: orderId,
    merchantUserId: `${sessionId || 'user'}_${Date.now()}`,
    amount: amountPaise,
    redirectUrl: `${FRONTEND_URL}/payment-return.html?orderId=${orderId}`,
    redirectMode: 'POST',
    callbackUrl: `${BACKEND_URL}/api/webhook`,
    paymentInstrument: { type: 'PAY_PAGE' }
  };

  const apiResponse = await axios.post(`${API_CONFIG.PG_BASE}/pay`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-MERCHANT-ID': MERCHANT_ID
    }
  });

  response = apiResponse.data;
}




    console.log('✅ Payment created:', JSON.stringify(response, null, 2));

    await db.collection('orders').doc(orderId).set({
      merchantOrderId: orderId,
      items, table, sessionId, amount: total,
      status: 'PENDING',
      environment: PHONEPE_ENV,
      method: sdkAvailable ? 'SDK' : 'Manual',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const checkoutUrl = response?.data?.url || response?.data?.instrumentResponse?.redirectInfo?.url;
    if (!checkoutUrl) throw new Error('No checkout URL found in response');

    console.log('✅ Checkout URL:', checkoutUrl);
    res.json({ success: true, orderId, checkoutUrl });

  } catch (err) {
    console.error('❌ Order creation failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// WEBHOOK HANDLER
// ============================================
app.post('/api/webhook', async (req, res) => {
  try {
    console.log('\n🔔 Webhook received:', JSON.stringify(req.body, null, 2));
    const payload = req.body;
    const orderId = payload.data?.merchantOrderId || payload.merchantOrderId;

    if (!orderId) return res.status(400).send('Missing order ID');

    let status = 'PENDING';
    if (payload.code === 'PAYMENT_SUCCESS' || payload.status === 'SUCCESS') status = 'SUCCESS';
    else if (payload.code === 'PAYMENT_ERROR' || payload.status === 'FAILED') status = 'FAILED';

    await db.collection('orders').doc(orderId).update({
      status,
      phonepeCallback: payload,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Order ${orderId} updated to ${status}`);
    res.status(200).send('OK');

  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.status(500).send('Error');
  }
});

// ============================================
// TEST ENDPOINT
// ============================================
app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    status: 'running',
    sdkAvailable,
    config: {
      environment: PHONEPE_ENV,
      merchantId: MERCHANT_ID,
      clientId: CLIENT_ID,
      frontend: FRONTEND_URL,
      backend: BACKEND_URL
    }
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
  console.log(`📡 Ready to process payments!\n`);
});

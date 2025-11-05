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

// FIREBASE SETUP
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}
const db = admin.firestore();

// ============================================
// PHONEPE V2 API CONFIGURATION (CORRECT)
// ============================================
const MODE = process.env.MODE || 'test';

const CONFIG = {
  AUTH_URL: MODE === 'live'
    ? 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token'
    : 'https://api-preprod.phonepe.com/apis/identity-manager/v1/oauth/token',
  
  PG_BASE: MODE === 'live'
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

// Cache for OAuth access token
let accessToken = null;
let tokenExpiry = null;

// ============================================
// GET OAUTH ACCESS TOKEN (V2 Method)
// ============================================
async function getAccessToken() {
  // Return cached token if still valid
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    console.log('✅ Using cached OAuth token');
    return accessToken;
  }

  try {
    console.log('🔑 Fetching new OAuth token from PhonePe V2...');

    const postBody = qs.stringify({
      client_id: CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
      grant_type: 'client_credentials',
      client_version: '1'
    });

    const response = await axios.post(
      CONFIG.AUTH_URL,
      postBody,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    accessToken = response.data.access_token || response.data.accesstoken;
    const expiresIn = response.data.expires_in || response.data.expiresin || 3600;
    tokenExpiry = Date.now() + (expiresIn * 1000) - 60000; // Refresh 1 min early

    console.log(`✅ OAuth token obtained (expires in ${expiresIn}s)`);
    return accessToken;

  } catch (err) {
    console.error('❌ OAuth token fetch failed:', {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    });
    throw new Error('Failed to get OAuth access token');
  }
}

// ============================================
// CREATE PAYMENT ORDER (V2 API)
// ============================================
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, total, table, sessionId } = req.body;

    // Validate input
    if (!items || !total || total <= 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Invalid order data - items and total are required' 
      });
    }

    const orderId = `PES${Date.now()}`;
    const amountPaise = Math.round(total * 100);

    console.log(`\n${'='.repeat(60)}`);
    console.log('📦 Creating Payment Order:');
    console.log(`   Order ID: ${orderId}`);
    console.log(`   Amount: ₹${total} (${amountPaise} paise)`);
    console.log(`   Items: ${items.length} items`);
    console.log(`   Session: ${sessionId}`);

    // Get OAuth token
    const token = await getAccessToken();

    // Build V2 payload (using merchantOrderId, NOT merchantTransactionId)
    const payload = {
      merchantId: CONFIG.MERCHANT_ID,
      merchantOrderId: orderId, // V2 uses merchantOrderId
      amount: amountPaise,
      merchantUserId: sessionId || `user_${Date.now()}`,
      redirectUrl: `${CONFIG.FRONTEND_URL}/payment-return.html?orderId=${orderId}`,
      redirectMode: 'POST',
      callbackUrl: `${CONFIG.BACKEND_URL}/api/webhook`,
      mobileNumber: '9999999999', // Required for some payment methods
      paymentInstrument: {
        type: 'PAY_PAGE'
      }
    };

    console.log('🔹 Payload:', JSON.stringify(payload, null, 2));

    // Call PhonePe V2 Create Payment API
    const response = await axios.post(
      `${CONFIG.PG_BASE}/pay`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-MERCHANT-ID': CONFIG.MERCHANT_ID
        }
      }
    );

    const phonepeResp = response.data;
    console.log('✅ PhonePe V2 Response:', JSON.stringify(phonepeResp, null, 2));

    // Save order in Firestore
    await db.collection('orders').doc(orderId).set({
      merchantOrderId: orderId,
      items,
      table,
      sessionId,
      amount: total,
      status: 'PENDING',
      mode: MODE,
      phonepeResponse: phonepeResp,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Extract checkout URL from V2 response
    const checkoutUrl = phonepeResp.data?.url || phonepeResp.data?.redirectUrl;

    if (!checkoutUrl) {
      console.error('❌ No checkout URL in response');
      throw new Error('No checkout URL returned from PhonePe');
    }

    console.log('✅ Checkout URL:', checkoutUrl);
    console.log(`${'='.repeat(60)}\n`);

    res.json({
      success: true,
      orderId,
      checkoutUrl,
      message: 'Payment initiated successfully'
    });

  } catch (err) {
    console.error('❌ Create order failed:', {
      status: err.response?.status,
      statusText: err.response?.statusText,
      data: err.response?.data,
      message: err.message
    });

    // Handle specific error cases
    if (err.response?.status === 401 || err.response?.data?.code === 'AUTHORIZATION_FAILED') {
      // Clear token cache and suggest retry
      accessToken = null;
      tokenExpiry = null;
      
      return res.status(401).json({
        success: false,
        message: 'Authentication failed. Please try again.',
        error: 'AUTHORIZATION_FAILED'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create payment order',
      error: err.response?.data || err.message
    });
  }
});

// ============================================
// PHONEPE WEBHOOK HANDLER (V2)
// ============================================
app.post('/api/webhook', async (req, res) => {
  try {
    console.log('\n🔔 Webhook received from PhonePe');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body:', JSON.stringify(req.body, null, 2));

    const payload = req.body;

    // Extract order ID (V2 can send in different formats)
    const orderId = 
      payload.merchantOrderId ||
      payload.data?.merchantOrderId ||
      payload.transactionId;

    if (!orderId) {
      console.error('❌ No order ID found in webhook');
      return res.status(400).send('Missing order ID');
    }

    // Determine payment status
    let status = 'PENDING';
    if (payload.code === 'PAYMENT_SUCCESS' || payload.status === 'SUCCESS') {
      status = 'SUCCESS';
    } else if (payload.code === 'PAYMENT_ERROR' || payload.status === 'FAILED') {
      status = 'FAILED';
    }

    console.log(`📝 Updating order ${orderId} to status: ${status}`);

    // Update order in Firestore
    await db.collection('orders').doc(orderId).update({
      status,
      phonepeCallback: payload,
      callbackReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log('✅ Order updated successfully');
    res.status(200).send('OK');

  } catch (err) {
    console.error('❌ Webhook processing error:', err);
    res.status(500).send('Error processing webhook');
  }
});

// ============================================
// CHECK ORDER STATUS (V2 API)
// ============================================
app.get('/api/order-status', async (req, res) => {
  const orderId = req.query.orderId;

  if (!orderId) {
    return res.status(400).json({ 
      success: false,
      message: 'Order ID is required' 
    });
  }

  try {
    console.log(`🔍 Checking status for order: ${orderId}`);

    // Get order from Firestore
    const doc = await db.collection('orders').doc(orderId).get();

    if (!doc.exists) {
      return res.status(404).json({ 
        success: false,
        message: 'Order not found' 
      });
    }

    const orderData = doc.data();

    // Also check with PhonePe V2 API
    try {
      const token = await getAccessToken();

      const statusResponse = await axios.get(
        `${CONFIG.PG_BASE}/order/${orderId}/status`,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-MERCHANT-ID': CONFIG.MERCHANT_ID
          }
        }
      );

      console.log('📊 PhonePe status:', statusResponse.data);

      // Update local status if PhonePe has newer info
      const phonepeStatus = statusResponse.data.status;
      if (phonepeStatus && phonepeStatus !== orderData.status) {
        await db.collection('orders').doc(orderId).update({
          status: phonepeStatus,
          lastStatusCheck: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      return res.json({
        success: true,
        orderId,
        status: phonepeStatus || orderData.status,
        order: orderData,
        phonepeData: statusResponse.data
      });

    } catch (statusErr) {
      // If PhonePe API fails, return local data
      console.warn('⚠️ Could not fetch from PhonePe, using local data');
      
      return res.json({
        success: true,
        orderId,
        status: orderData.status,
        order: orderData,
        note: 'Using cached data (PhonePe API unavailable)'
      });
    }

  } catch (err) {
    console.error('❌ Status check error:', err);
    res.status(500).json({ 
      success: false,
      message: 'Error checking order status' 
    });
  }
});

// ============================================
// TEST TOKEN ENDPOINT
// ============================================
app.get('/api/test-token', async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({
      success: true,
      message: 'OAuth token obtained successfully',
      tokenPreview: token.substring(0, 30) + '...',
      expiresAt: tokenExpiry ? new Date(tokenExpiry).toISOString() : 'N/A',
      config: {
        mode: MODE,
        authUrl: CONFIG.AUTH_URL,
        pgBase: CONFIG.PG_BASE,
        merchantId: CONFIG.MERCHANT_ID
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ============================================
// ROOT ENDPOINT
// ============================================
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    name: 'PES Canteen Payment Backend',
    version: '2.0 (PhonePe V2 API)',
    mode: MODE === 'live' ? 'PRODUCTION' : 'TEST',
    timestamp: new Date().toISOString(),
    endpoints: {
      createOrder: 'POST /api/create-order',
      webhook: 'POST /api/webhook',
      orderStatus: 'GET /api/order-status?orderId=xxx',
      testToken: 'GET /api/test-token'
    },
    documentation: {
      authorization: 'https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/authorization/',
      createPayment: 'https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/create-payment/',
      orderStatus: 'https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/order-status/'
    }
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(port, () => {
  console.log('\n' + '='.repeat(70));
  console.log('🎉 PES CANTEEN PAYMENT BACKEND - PHONEPE V2 API');
  console.log('='.repeat(70));
  console.log(`✅ Server running on port ${port}`);
  console.log(`🌍 Mode: ${MODE === 'live' ? '🔴 PRODUCTION' : '🟡 TEST'}`);
  console.log(`🏪 Merchant ID: ${CONFIG.MERCHANT_ID}`);
  console.log(`🔐 Client ID: ${CONFIG.CLIENT_ID}`);
  console.log(`🌐 Frontend: ${CONFIG.FRONTEND_URL}`);
  console.log(`🔗 Backend: ${CONFIG.BACKEND_URL}`);
  console.log(`📡 Auth URL: ${CONFIG.AUTH_URL}`);
  console.log(`💳 PG Base: ${CONFIG.PG_BASE}`);
  console.log('='.repeat(70) + '\n');
});
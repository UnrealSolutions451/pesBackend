const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const admin = require('firebase-admin');

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const port = process.env.PORT || 4000;

// ============================================
// FIREBASE SETUP
// ============================================
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}
const db = admin.firestore();

// ============================================
// PHONEPE SDK INITIALIZATION (With Error Handling)
// ============================================
const PHONEPE_ENV = process.env.PHONEPE_ENV || 'TEST';
const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const CLIENT_ID = process.env.PHONEPE_CLIENT_ID;
const CLIENT_SECRET = process.env.PHONEPE_CLIENT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL;
const BACKEND_URL = process.env.BACKEND_URL || 'https://pesbackend.onrender.com';

let phonePeClient = null;
let sdkAvailable = false;

// Try to load PhonePe SDK with fallback
try {
  console.log('🔄 Attempting to load PhonePe SDK...');
  
  const PhonePeSDK = require('pg-sdk-node');
  
  // Check what's actually exported
  console.log('📦 SDK exports:', Object.keys(PhonePeSDK));
  
  // Try different possible export structures
  const PhonePeClient = PhonePeSDK.PhonePeClient || PhonePeSDK.default?.PhonePeClient || PhonePeSDK;
  const Environment = PhonePeSDK.Environment || PhonePeSDK.default?.Environment || {
    PRODUCTION: 'PRODUCTION',
    SANDBOX: 'SANDBOX'
  };
  
  // Initialize client
  phonePeClient = new PhonePeClient({
    merchantId: MERCHANT_ID,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    environment: PHONEPE_ENV === 'LIVE' ? Environment.PRODUCTION : Environment.SANDBOX
  });
  
  sdkAvailable = true;
  console.log('✅ PhonePe SDK loaded successfully');
  
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
// MANUAL API INTEGRATION (Fallback)
// ============================================
const axios = require('axios');
const qs = require('qs');

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
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }

  try {
    const postBody = qs.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
      client_version: '1'
    });

    const response = await axios.post(API_CONFIG.AUTH_URL, postBody, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    accessToken = response.data.access_token || response.data.accesstoken;
    const expiresIn = response.data.expires_in || 3600;
    tokenExpiry = Date.now() + (expiresIn * 1000) - 60000;

    console.log('✅ OAuth token obtained');
    return accessToken;

  } catch (err) {
    console.error('❌ Token fetch failed:', err.response?.data || err.message);
    throw new Error('Failed to get OAuth token');
  }
}

// ============================================
// CREATE PAYMENT ORDER (SDK or Manual API)
// ============================================
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, total, table, sessionId } = req.body;

    if (!items || !total || total <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order data'
      });
    }

    const orderId = `PES${Date.now()}`;
    const amountPaise = Math.round(total * 100);

    console.log(`\n📦 Creating Order: ${orderId} | Amount: ₹${total}`);

    // Try SDK first, fallback to manual API
    let response;
    
    if (sdkAvailable && phonePeClient) {
      console.log('🔹 Using PhonePe SDK...');
      
      try {
        const StandardCheckoutPayRequest = require('pg-sdk-node').StandardCheckoutPayRequest;
        
        const paymentRequest = StandardCheckoutPayRequest.builder()
          .merchantOrderId(orderId)
          .amount(amountPaise)
          .merchantUserId(sessionId || `user_${Date.now()}`)
          .redirectUrl(`${FRONTEND_URL}/payment-return.html?orderId=${orderId}`)
          .callbackUrl(`${BACKEND_URL}/api/webhook`)
          .build();

        response = await phonePeClient.pay(paymentRequest);
        
      } catch (sdkErr) {
        console.warn('⚠️  SDK method failed, trying manual API...');
        sdkAvailable = false; // Disable SDK for future requests
        throw sdkErr; // Fall through to manual API
      }
      
    } else {
      console.log('🔹 Using Manual API...');
      
      const token = await getAccessToken();

      const payload = {
        merchantId: MERCHANT_ID,
        merchantOrderId: orderId,
        amount: amountPaise,
        merchantUserId: sessionId || `user_${Date.now()}`,
        redirectUrl: `${FRONTEND_URL}/payment-return.html?orderId=${orderId}`,
        redirectMode: 'POST',
        callbackUrl: `${BACKEND_URL}/api/webhook`,
        mobileNumber: '9999999999',
        paymentInstrument: { type: 'PAY_PAGE' }
      };

      const apiResponse = await axios.post(
        `${API_CONFIG.PG_BASE}/pay`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-MERCHANT-ID': MERCHANT_ID
          }
        }
      );

      response = apiResponse.data;
    }

    console.log('✅ Payment created:', JSON.stringify(response, null, 2));

    // Save order
    await db.collection('orders').doc(orderId).set({
      merchantOrderId: orderId,
      items,
      table,
      sessionId,
      amount: total,
      status: 'PENDING',
      environment: PHONEPE_ENV,
      method: sdkAvailable ? 'SDK' : 'Manual API',
      phonepeResponse: response,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Extract checkout URL
    const checkoutUrl = response.data?.url || response.data?.redirectUrl;

    if (!checkoutUrl) {
      throw new Error('No checkout URL in response');
    }

    console.log('✅ Checkout URL:', checkoutUrl);

    res.json({
      success: true,
      orderId,
      checkoutUrl,
      method: sdkAvailable ? 'SDK' : 'Manual API'
    });

  } catch (err) {
    console.error('❌ Order creation failed:', err.response?.data || err.message);

    res.status(500).json({
      success: false,
      message: 'Failed to create order',
      error: err.response?.data || err.message
    });
  }
});

// ============================================
// WEBHOOK HANDLER
// ============================================
app.post('/api/webhook', async (req, res) => {
  try {
    console.log('\n🔔 Webhook received:', JSON.stringify(req.body, null, 2));

    const payload = req.body;
    const orderId = payload.merchantOrderId || payload.data?.merchantOrderId;

    if (!orderId) {
      return res.status(400).send('Missing order ID');
    }

    let status = 'PENDING';
    if (payload.code === 'PAYMENT_SUCCESS' || payload.status === 'SUCCESS') {
      status = 'SUCCESS';
    } else if (payload.code === 'PAYMENT_ERROR' || payload.status === 'FAILED') {
      status = 'FAILED';
    }

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
// CHECK ORDER STATUS
// ============================================
app.get('/api/order-status', async (req, res) => {
  const orderId = req.query.orderId;

  if (!orderId) {
    return res.status(400).json({ message: 'Order ID required' });
  }

  try {
    const doc = await db.collection('orders').doc(orderId).get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const orderData = doc.data();

    // Try to get latest status from PhonePe
    try {
      let statusResponse;

      if (sdkAvailable && phonePeClient) {
        statusResponse = await phonePeClient.checkStatus(orderId);
      } else {
        const token = await getAccessToken();
        const apiResponse = await axios.get(
          `${API_CONFIG.PG_BASE}/order/${orderId}/status`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'X-MERCHANT-ID': MERCHANT_ID
            }
          }
        );
        statusResponse = apiResponse.data;
      }

      return res.json({
        success: true,
        orderId,
        status: statusResponse.status || orderData.status,
        order: orderData,
        phonepeData: statusResponse
      });

    } catch (statusErr) {
      return res.json({
        success: true,
        orderId,
        status: orderData.status,
        order: orderData
      });
    }

  } catch (err) {
    console.error('❌ Status check error:', err);
    res.status(500).json({ message: 'Error checking status' });
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
// ROOT
// ============================================
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    name: 'PES Canteen Payment Backend',
    version: '2.0',
    sdkAvailable,
    timestamp: new Date().toISOString()
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
  console.log(`📡 Ready to process payments!\n`);
});

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
// FIREBASE SETUP (Fixed)
// ============================================
if (!admin.apps.length) {
  try {
    // Parse the service account from environment variable
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT.replace(/\\n/g, '\n')
    );
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase initialized successfully');
  } catch (firebaseError) {
    console.error('❌ Firebase initialization failed:', firebaseError.message);
    console.log('📌 Continuing without Firebase - some features may not work');
  }
}
const db = admin.apps.length ? admin.firestore() : null;

// ============================================
// PHONEPE CONFIGURATION
// ============================================
const PHONEPE_ENV = process.env.PHONEPE_ENV || 'TEST';
const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const CLIENT_ID = process.env.PHONEPE_CLIENT_ID;
const CLIENT_SECRET = process.env.PHONEPE_CLIENT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL;
const BACKEND_URL = process.env.BACKEND_URL || 'https://pesbackend.onrender.com';

console.log('\n' + '='.repeat(70));
console.log('🚀 PES CANTEEN PAYMENT BACKEND');
console.log('='.repeat(70));
console.log(`✅ Environment: ${PHONEPE_ENV === 'LIVE' ? '🔴 PRODUCTION' : '🟡 TEST'}`);
console.log(`🏪 Merchant ID: ${MERCHANT_ID ? '✅ Set' : '❌ Missing'}`);
console.log(`🔐 Client ID: ${CLIENT_ID ? '✅ Set' : '❌ Missing'}`);
console.log(`🌐 Frontend: ${FRONTEND_URL}`);
console.log(`🔗 Backend: ${BACKEND_URL}`);
console.log(`🔥 Firebase: ${db ? '✅ Connected' : '❌ Not Available'}`);
console.log('='.repeat(70) + '\n');

// ============================================
// MANUAL API INTEGRATION (Primary Method)
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
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    });

    accessToken = response.data.access_token;
    const expiresIn = response.data.expires_in || 3600;
    tokenExpiry = Date.now() + (expiresIn * 1000) - 60000; // 1 minute buffer

    console.log('✅ OAuth token obtained successfully');
    return accessToken;

  } catch (err) {
    console.error('❌ Token fetch failed:', err.response?.data || err.message);
    throw new Error('Failed to get OAuth token: ' + (err.response?.data?.message || err.message));
  }
}

// ============================================
// CREATE PAYMENT ORDER
// ============================================
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, total, table, sessionId } = req.body;

    console.log('📦 Received order request:', { table, sessionId, total });

    if (!items || !total || total <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order data: items and total amount are required'
      });
    }

    // Validate credentials
    if (!MERCHANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
      return res.status(500).json({
        success: false,
        message: 'Payment gateway configuration missing'
      });
    }

    const orderId = `PES${Date.now()}`;
    const amountPaise = Math.round(total * 100);

    console.log(`📦 Creating Order: ${orderId} | Amount: ₹${total} (${amountPaise} paise)`);

    // Get access token
    const token = await getAccessToken();

    const payload = {
      merchantId: MERCHANT_ID,
      merchantOrderId: orderId,
      amount: amountPaise,
      merchantUserId: sessionId || `user_${Date.now()}`,
      redirectUrl: `${FRONTEND_URL}/payment-return.html?orderId=${orderId}`,
      redirectMode: 'POST',
      callbackUrl: `${BACKEND_URL}/api/webhook`,
      mobileNumber: '9999999999', // Default number
      paymentInstrument: { 
        type: 'PAY_PAGE' 
      }
    };

    console.log('🔹 Sending payment request to PhonePe...');
    
    const apiResponse = await axios.post(
      `${API_CONFIG.PG_BASE}/pay`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-MERCHANT-ID': MERCHANT_ID,
          'X-CALLBACK-URL': `${BACKEND_URL}/api/webhook`
        },
        timeout: 10000
      }
    );

    const response = apiResponse.data;
    console.log('✅ Payment API response received');

    // Save order to Firestore if available
    if (db) {
      try {
        await db.collection('orders').doc(orderId).set({
          merchantOrderId: orderId,
          items,
          table,
          sessionId,
          amount: total,
          amountPaise,
          status: 'PENDING',
          environment: PHONEPE_ENV,
          method: 'Manual API',
          phonepeResponse: response,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log('✅ Order saved to Firestore');
      } catch (firestoreError) {
        console.warn('⚠️  Could not save to Firestore:', firestoreError.message);
      }
    }

    // Extract checkout URL
    const checkoutUrl = response.data?.instrumentResponse?.redirectInfo?.url || 
                       response.data?.url;

    if (!checkoutUrl) {
      console.error('❌ No checkout URL in response:', JSON.stringify(response, null, 2));
      throw new Error('No checkout URL received from payment gateway');
    }

    console.log('✅ Checkout URL generated:', checkoutUrl);

    res.json({
      success: true,
      orderId,
      checkoutUrl,
      method: 'Manual API'
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
      console.warn('⚠️  Webhook missing order ID');
      return res.status(400).send('Missing order ID');
    }

    let status = 'PENDING';
    if (payload.code === 'PAYMENT_SUCCESS' || payload.status === 'SUCCESS') {
      status = 'SUCCESS';
    } else if (payload.code === 'PAYMENT_ERROR' || payload.status === 'FAILED') {
      status = 'FAILED';
    }

    console.log(`🔄 Updating order ${orderId} to status: ${status}`);

    // Update Firestore if available
    if (db) {
      try {
        await db.collection('orders').doc(orderId).update({
          status,
          phonepeCallback: payload,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✅ Order ${orderId} updated to ${status}`);
      } catch (firestoreError) {
        console.warn('⚠️  Could not update Firestore:', firestoreError.message);
      }
    }

    res.status(200).send('OK');

  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.status(500).send('Error processing webhook');
  }
});

// ============================================
// CHECK ORDER STATUS
// ============================================
app.get('/api/order-status', async (req, res) => {
  const orderId = req.query.orderId;

  if (!orderId) {
    return res.status(400).json({ 
      success: false,
      message: 'Order ID required' 
    });
  }

  try {
    console.log(`🔍 Checking status for order: ${orderId}`);

    // Try to get latest status from PhonePe
    try {
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

      const statusResponse = apiResponse.data;
      
      // Update Firestore if available and status changed
      if (db) {
        try {
          const doc = await db.collection('orders').doc(orderId).get();
          if (doc.exists) {
            const currentStatus = doc.data().status;
            const newStatus = statusResponse.status || statusResponse.code;
            
            if (currentStatus !== newStatus) {
              await db.collection('orders').doc(orderId).update({
                status: newStatus,
                lastStatusCheck: admin.firestore.FieldValue.serverTimestamp()
              });
            }
          }
        } catch (firestoreError) {
          console.warn('⚠️  Could not update Firestore:', firestoreError.message);
        }
      }

      return res.json({
        success: true,
        orderId,
        status: statusResponse.status || statusResponse.code,
        phonepeData: statusResponse
      });

    } catch (statusErr) {
      console.warn('⚠️  Status check failed:', statusErr.message);
      
      // Fallback to Firestore status
      if (db) {
        try {
          const doc = await db.collection('orders').doc(orderId).get();
          if (doc.exists) {
            const orderData = doc.data();
            return res.json({
              success: true,
              orderId,
              status: orderData.status,
              order: orderData
            });
          }
        } catch (firestoreError) {
          console.warn('⚠️  Firestore fallback failed:', firestoreError.message);
        }
      }
      
      return res.status(404).json({
        success: false,
        message: 'Order not found or status unavailable'
      });
    }

  } catch (err) {
    console.error('❌ Status check error:', err);
    res.status(500).json({ 
      success: false,
      message: 'Error checking status' 
    });
  }
});

// ============================================
// TEST ENDPOINT
// ============================================
app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    status: 'running',
    timestamp: new Date().toISOString(),
    config: {
      environment: PHONEPE_ENV,
      merchantId: MERCHANT_ID ? '✅ Set' : '❌ Missing',
      clientId: CLIENT_ID ? '✅ Set' : '❌ Missing',
      frontend: FRONTEND_URL,
      backend: BACKEND_URL,
      firebase: db ? '✅ Connected' : '❌ Not Available'
    }
  });
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'PES Canteen Payment Backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
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
    timestamp: new Date().toISOString()
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
  console.log(`📡 Ready to process payments!`);
  console.log(`🌐 Health check: http://localhost:${port}/health`);
  console.log(`🔧 Test endpoint: http://localhost:${port}/api/test\n`);
});

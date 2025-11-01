const express = require('express');
const axios = require('axios');
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

// PHONEPE CONFIG - CORRECTED ENDPOINTS
const AUTH_BASE = 'https://api.phonepe.com/apis/identity-manager/';
const PG_BASE = 'https://api.phonepe.com/apis/hermes/pg/'; // Correct PG endpoint
const CLIENTID = process.env.PHONEPE_CLIENT_ID;
const CLIENTSECRET = process.env.PHONEPE_CLIENT_SECRET;
const MERCHANTID = process.env.PHONEPE_MERCHANT_ID;
const MERCHANTBASEURL = process.env.MERCHANT_BASE_URL;

// Cache for access token
let accessToken = null;
let tokenExpiry = null;

// GET ACCESS TOKEN (OAuth)
async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    console.log('✅ Using cached token');
    return accessToken;
  }
  
  try {
    const postBody = qs.stringify({
      client_id: CLIENTID,
      client_secret: CLIENTSECRET,
      grant_type: 'client_credentials',
      client_version: '1'
    });

    console.log('🔑 Fetching new access token...');
    
    const response = await axios.post(
      `${AUTH_BASE}v1/oauth/token`,
      postBody,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    accessToken = response.data.access_token || response.data.accesstoken;
    const expiresIn = response.data.expires_in || response.data.expiresin || 3600;
    tokenExpiry = Date.now() + expiresIn * 1000 - 60000;
    
    console.log('✅ Access token obtained, expires in:', expiresIn, 'seconds');
    return accessToken;
    
  } catch (err) {
    console.error('❌ Token fetch failed:', err.response?.data || err.message);
    throw new Error('Failed to get access token');
  }
}

// CREATE ORDER - Using correct PG API
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, total, table, sessionId } = req.body;

    if (!items || total == null || total <= 0) {
      return res.status(400).json({ message: 'Invalid order data' });
    }

    const orderId = `PES${Date.now()}`;
    const amountPaise = Math.round(total * 100);

    // Get OAuth token
    const token = await getAccessToken();

    // Build payload - using correct field names for PG API
    const payload = {
      merchantId: MERCHANTID,
      merchantTransactionId: orderId, // Note: TransactionId not OrderId
      merchantUserId: sessionId || `MUID${Date.now()}`,
      amount: amountPaise,
      redirectUrl: `${MERCHANTBASEURL}/payment-return.html?orderId=${orderId}`,
      redirectMode: 'POST',
      callbackUrl: `https://pesbackend.onrender.com/api/webhook`,
      mobileNumber: '9999999999',
      paymentInstrument: {
        type: 'PAY_PAGE'
      }
    };

    console.log('🔹 Initiating payment:', {
      orderId,
      amount: amountPaise,
      endpoint: `${PG_BASE}v1/pay`
    });

    // Try Method 1: Standard PG API endpoint
    const response = await axios.post(
      `${PG_BASE}v1/pay`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-MERCHANT-ID': MERCHANTID
        }
      }
    );

    const phonepeResp = response.data;
    console.log('✅ PhonePe Response:', JSON.stringify(phonepeResp, null, 2));

    // Save order in Firestore
    await db.collection('orders').doc(orderId).set({
      merchantOrderId: orderId,
      items,
      table,
      sessionId,
      amount: total,
      status: 'PENDING',
      phonepeResponse: phonepeResp,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Extract redirect URL
    const checkoutUrl = 
      phonepeResp.data?.instrumentResponse?.redirectInfo?.url || 
      phonepeResp.data?.redirectUrl ||
      phonepeResp.redirectUrl;

    if (!checkoutUrl) {
      console.error('❌ No checkout URL found in response:', phonepeResp);
      throw new Error('No checkout URL in response');
    }

    res.json({ 
      success: true, 
      orderId, 
      checkoutUrl 
    });

  } catch (err) {
    console.error('❌ Order create failed:', {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    });

    // If authorization failed, try to get a fresh token and retry once
    if (err.response?.data?.code === 'AUTHORIZATION_FAILED') {
      console.log('🔄 Authorization failed, clearing token cache and retrying...');
      accessToken = null;
      tokenExpiry = null;
      
      return res.status(401).json({ 
        success: false, 
        message: 'Authorization failed. Please try again.',
        error: err.response?.data 
      });
    }

    res.status(500).json({ 
      success: false, 
      message: 'Create order failed', 
      error: err.response?.data || err.message 
    });
  }
});

// PHONEPE WEBHOOK
const crypto = require('crypto');

app.post('/api/webhook', async (req, res) => {
  try {
    // Verify Authorization header
    const authHeader = req.headers['authorization'];
    const expectedAuth = crypto
      .createHash('sha256')
      .update(`${process.env.WEBHOOK_USER}:${process.env.WEBHOOK_PASS}`)
      .digest('hex');

    if (authHeader !== expectedAuth) {
      console.warn('⚠️ Unauthorized webhook access');
      return res.status(401).send('Unauthorized');
    }

    const payload = req.body;
    console.log('🔔 Valid webhook received:', JSON.stringify(payload, null, 2));

    const orderId =
      payload.data?.merchantTransactionId ||
      payload.merchantTransactionId ||
      payload.data?.merchantOrderId;

    const status =
      payload.code === 'PAYMENT_SUCCESS' || payload.data?.state === 'COMPLETED'
        ? 'SUCCESS'
        : 'FAILED';

    if (orderId) {
      await db.collection('orders').doc(orderId).update({
        status,
        phonepeCallback: payload,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log('✅ Order updated:', orderId, status);
    } else {
      console.warn('⚠️ No order ID found in webhook payload');
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.status(500).send('Error');
  }
});


// CHECK ORDER STATUS
app.get('/api/order-status', async (req, res) => {
  const orderId = req.query.orderId;
  
  if (!orderId) {
    return res.status(400).json({ message: 'Missing orderId' });
  }

  try {
    const doc = await db.collection('orders').doc(orderId).get();
    
    if (!doc.exists) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const data = doc.data();

    // Try to get latest status from PhonePe
    try {
      const token = await getAccessToken();

      const statusResponse = await axios.get(
        `${PG_BASE}v1/status/${MERCHANTID}/${orderId}`,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-MERCHANT-ID': MERCHANTID
          }
        }
      );

      console.log('📊 Status check response:', statusResponse.data);

      res.json({
        status: data.status,
        order: data,
        phonepeStatus: statusResponse.data
      });

    } catch (statusErr) {
      console.warn('⚠️ PhonePe status check failed, returning local status');
      res.json({ status: data.status, order: data });
    }

  } catch (err) {
    console.error('❌ Order status error:', err);
    res.status(500).json({ message: 'Error fetching order status' });
  }
});

// TEST TOKEN ENDPOINT (for debugging)
app.get('/api/test-token', async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ 
      success: true, 
      message: 'Token obtained successfully',
      tokenPreview: token.substring(0, 20) + '...',
      expiresAt: new Date(tokenExpiry).toISOString()
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// ROOT ENDPOINT
app.get('/', (req, res) => {
  res.json({ 
    status: 'running', 
    message: 'PES Canteen PhonePe Backend (OAuth v2)', 
    timestamp: new Date().toISOString(),
    endpoints: {
      createOrder: '/api/create-order',
      webhook: '/api/webhook',
      orderStatus: '/api/order-status',
      testToken: '/api/test-token'
    }
  });
});

// START SERVER
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
  console.log(`🔹 Auth Base: ${AUTH_BASE}`);
  console.log(`🔹 PG Base: ${PG_BASE}`);
  console.log(`🔹 Merchant ID: ${MERCHANTID}`);
  console.log(`🔹 Using OAuth authentication`);
});
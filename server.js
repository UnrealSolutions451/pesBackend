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

// PHONEPE CONFIG
const AUTH_BASE = 'https://api.phonepe.com/apis/identity-manager/';
const CLIENTID = process.env.PHONEPE_CLIENT_ID;
const CLIENTSECRET = process.env.PHONEPE_CLIENT_SECRET;
const MERCHANTID = process.env.PHONEPE_MERCHANT_ID;
const MERCHANTBASEURL = process.env.MERCHANT_BASE_URL;

// IMPORTANT: Use the Client Secret as Salt Key for signature-based auth
const SALT_KEY = CLIENTSECRET;
const SALT_INDEX = '1';

// Cache for access token
let accessToken = null;
let tokenExpiry = null;

// GET ACCESS TOKEN (OAuth) - Keep for future use
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

// SIGNATURE GENERATION (Using Client Secret as Salt Key)
function generateSignature(payload) {
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
  const stringToSign = base64Payload + '/pg/v1/pay' + SALT_KEY;
  const sha256 = crypto.createHash('sha256').update(stringToSign).digest('hex');
  const signature = sha256 + '###' + SALT_INDEX;
  
  return { base64Payload, signature };
}

// CREATE ORDER - Using SIGNATURE-BASED authentication (not OAuth)
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, total, table, sessionId } = req.body;

    if (!items || total == null || total <= 0) {
      return res.status(400).json({ message: 'Invalid order data' });
    }

    const orderId = `PES${Date.now()}`;
    const amountPaise = Math.round(total * 100);

    // Build payload for standard PG API
    const payload = {
      merchantId: MERCHANTID,
      merchantTransactionId: orderId,
      merchantUserId: sessionId || `MUID${Date.now()}`,
      amount: amountPaise,
      redirectUrl: `${MERCHANTBASEURL}/payment-return.html?orderId=${orderId}`,
      redirectMode: 'POST',
      callbackUrl: `${MERCHANTBASEURL}/api/webhook`,
      mobileNumber: '9999999999',
      paymentInstrument: {
        type: 'PAY_PAGE'
      }
    };

    console.log('🔹 Creating order with payload:', {
      orderId,
      amount: amountPaise,
      merchantId: MERCHANTID
    });

    // Generate signature using Client Secret as Salt Key
    const { base64Payload, signature } = generateSignature(payload);

    console.log('🔐 Signature generated');

    // Call PhonePe PG API with signature-based auth
    const response = await axios.post(
      'https://api.phonepe.com/apis/hermes/pg/v1/pay',
      {
        request: base64Payload
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': signature
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
      phonepeResp.data?.redirectUrl;

    if (!checkoutUrl) {
      console.error('❌ No checkout URL found in response');
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
      statusText: err.response?.statusText,
      data: err.response?.data,
      message: err.message,
      headers: err.response?.headers
    });

    res.status(500).json({ 
      success: false, 
      message: 'Create order failed', 
      error: err.response?.data || err.message 
    });
  }
});

// PHONEPE WEBHOOK - Verify signature
app.post('/api/webhook', async (req, res) => {
  try {
    console.log('🔔 Webhook received');
    console.log('Headers:', req.headers);
    console.log('Body:', JSON.stringify(req.body, null, 2));

    // PhonePe sends base64 response in body
    const base64Response = req.body.response;
    const receivedSignature = req.headers['x-verify'];

    if (!base64Response) {
      console.error('❌ No response field in webhook body');
      return res.status(400).send('Invalid webhook data');
    }

    // Verify signature
    const expectedSignature = crypto
      .createHash('sha256')
      .update(base64Response + SALT_KEY)
      .digest('hex') + '###' + SALT_INDEX;

    if (receivedSignature !== expectedSignature) {
      console.error('❌ Invalid signature');
      return res.status(401).send('Invalid signature');
    }

    console.log('✅ Signature verified');

    // Decode payload
    const payload = JSON.parse(Buffer.from(base64Response, 'base64').toString());
    console.log('Decoded payload:', payload);

    const orderId = payload.data?.merchantTransactionId;
    const status = payload.code === 'PAYMENT_SUCCESS' ? 'SUCCESS' : 'FAILED';

    if (orderId) {
      await db.collection('orders').doc(orderId).update({
        status,
        phonepeCallback: payload,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log('✅ Order updated:', orderId, status);
    }

    res.status(200).send('OK');
    
  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.status(500).send('Error');
  }
});

// CHECK ORDER STATUS - Using signature-based auth
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

    // Check status with PhonePe using signature
    try {
      const statusEndpoint = `/pg/v1/status/${MERCHANTID}/${orderId}`;
      const stringToSign = statusEndpoint + SALT_KEY;
      const signature = crypto
        .createHash('sha256')
        .update(stringToSign)
        .digest('hex') + '###' + SALT_INDEX;

      const statusResponse = await axios.get(
        `https://api.phonepe.com/apis/hermes${statusEndpoint}`,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-VERIFY': signature,
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
      console.warn('⚠️ PhonePe status check failed:', statusErr.message);
      res.json({ status: data.status, order: data });
    }

  } catch (err) {
    console.error('❌ Order status error:', err);
    res.status(500).json({ message: 'Error fetching order status' });
  }
});

// TEST TOKEN ENDPOINT
app.get('/api/test-token', async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ 
      success: true, 
      message: 'OAuth token obtained successfully',
      tokenPreview: token.substring(0, 20) + '...'
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// TEST SIGNATURE ENDPOINT
app.get('/api/test-signature', (req, res) => {
  const testPayload = {
    merchantId: MERCHANTID,
    merchantTransactionId: 'TEST123',
    amount: 100
  };
  
  const { base64Payload, signature } = generateSignature(testPayload);
  
  res.json({
    success: true,
    message: 'Signature generation test',
    payload: testPayload,
    base64Preview: base64Payload.substring(0, 50) + '...',
    signaturePreview: signature.substring(0, 30) + '...'
  });
});

// ROOT ENDPOINT
app.get('/', (req, res) => {
  res.json({ 
    status: 'running', 
    message: 'PES Canteen PhonePe Backend (Signature Auth)', 
    timestamp: new Date().toISOString(),
    merchantId: MERCHANTID,
    endpoints: {
      createOrder: 'POST /api/create-order',
      webhook: 'POST /api/webhook',
      orderStatus: 'GET /api/order-status?orderId=xxx',
      testToken: 'GET /api/test-token',
      testSignature: 'GET /api/test-signature'
    }
  });
});

// START SERVER
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
  console.log(`🔹 Merchant ID: ${MERCHANTID}`);
  console.log(`🔹 Using SIGNATURE-BASED authentication (Client Secret as Salt Key)`);
  console.log(`🔹 Salt Key length: ${SALT_KEY.length} chars`);
});

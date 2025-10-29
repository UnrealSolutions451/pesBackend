const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const dotenv = require('dotenv');
const cors = require('cors');
const admin = require('firebase-admin');

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

// PHONEPE CONFIG - Support both UAT and Production
const USE_UAT = process.env.USE_UAT === 'true'; // Set this to 'true' for testing

const CONFIG = USE_UAT ? {
  // UAT/SANDBOX CONFIGURATION (for testing)
  API_BASE: 'https://api-preprod.phonepe.com/apis/pg-sandbox',
  MERCHANT_ID: 'PGTESTPAYUAT',
  SALT_KEY: '099eb0cd-02cf-4e2a-8aca-3e6c6aff0399',
  SALT_INDEX: '1'
} : {
  // PRODUCTION CONFIGURATION
  API_BASE: 'https://api.phonepe.com/apis/hermes',
  MERCHANT_ID: process.env.PHONEPE_MERCHANT_ID,
  SALT_KEY: process.env.PHONEPE_CLIENT_SECRET, // Using Client Secret as Salt Key
  SALT_INDEX: '1'
};

const MERCHANTBASEURL = process.env.MERCHANT_BASE_URL;

console.log(`🔹 Environment: ${USE_UAT ? 'UAT/SANDBOX' : 'PRODUCTION'}`);
console.log(`🔹 API Base: ${CONFIG.API_BASE}`);
console.log(`🔹 Merchant ID: ${CONFIG.MERCHANT_ID}`);

// SIGNATURE GENERATION
function generateSignature(payload) {
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
  const stringToSign = base64Payload + '/pg/v1/pay' + CONFIG.SALT_KEY;
  const sha256 = crypto.createHash('sha256').update(stringToSign).digest('hex');
  const signature = sha256 + '###' + CONFIG.SALT_INDEX;
  
  return { base64Payload, signature };
}

// CREATE ORDER
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, total, table, sessionId } = req.body;

    if (!items || total == null || total <= 0) {
      return res.status(400).json({ message: 'Invalid order data' });
    }

    const orderId = `PES${Date.now()}`;
    const amountPaise = Math.round(total * 100);

    // Build payload
    const payload = {
      merchantId: CONFIG.MERCHANT_ID,
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

    console.log('🔹 Creating order:', {
      environment: USE_UAT ? 'UAT' : 'PRODUCTION',
      orderId,
      amount: amountPaise,
      merchantId: CONFIG.MERCHANT_ID
    });

    // Generate signature
    const { base64Payload, signature } = generateSignature(payload);

    console.log('🔐 Request details:', {
      url: `${CONFIG.API_BASE}/pg/v1/pay`,
      signaturePreview: signature.substring(0, 30) + '...',
      payloadPreview: base64Payload.substring(0, 50) + '...'
    });

    // Call PhonePe API
    const response = await axios.post(
      `${CONFIG.API_BASE}/pg/v1/pay`,
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
      environment: USE_UAT ? 'UAT' : 'PRODUCTION',
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

    console.log('✅ Checkout URL:', checkoutUrl);

    res.json({ 
      success: true, 
      orderId, 
      checkoutUrl,
      environment: USE_UAT ? 'UAT' : 'PRODUCTION'
    });

  } catch (err) {
    console.error('❌ Order create failed:', {
      status: err.response?.status,
      statusText: err.response?.statusText,
      data: err.response?.data,
      headers: err.response?.headers,
      message: err.message
    });

    res.status(500).json({ 
      success: false, 
      message: 'Create order failed', 
      error: err.response?.data || err.message,
      hint: USE_UAT ? 
        'UAT error - check PhonePe sandbox status' : 
        'Production error - your merchant account may not be activated for PG API. Try setting USE_UAT=true to test first.'
    });
  }
});

// PHONEPE WEBHOOK
app.post('/api/webhook', async (req, res) => {
  try {
    console.log('🔔 Webhook received');
    console.log('Headers:', req.headers);
    console.log('Body:', JSON.stringify(req.body, null, 2));

    const base64Response = req.body.response;
    const receivedSignature = req.headers['x-verify'];

    if (!base64Response) {
      console.error('❌ No response field in webhook body');
      return res.status(400).send('Invalid webhook data');
    }

    // Verify signature
    const expectedSignature = crypto
      .createHash('sha256')
      .update(base64Response + CONFIG.SALT_KEY)
      .digest('hex') + '###' + CONFIG.SALT_INDEX;

    if (receivedSignature !== expectedSignature) {
      console.error('❌ Invalid signature');
      console.log('Expected:', expectedSignature);
      console.log('Received:', receivedSignature);
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

    // Check status with PhonePe
    try {
      const statusEndpoint = `/pg/v1/status/${CONFIG.MERCHANT_ID}/${orderId}`;
      const stringToSign = statusEndpoint + CONFIG.SALT_KEY;
      const signature = crypto
        .createHash('sha256')
        .update(stringToSign)
        .digest('hex') + '###' + CONFIG.SALT_INDEX;

      const statusResponse = await axios.get(
        `${CONFIG.API_BASE}${statusEndpoint}`,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-VERIFY': signature,
            'X-MERCHANT-ID': CONFIG.MERCHANT_ID
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

// TEST SIGNATURE
app.get('/api/test-signature', (req, res) => {
  const testPayload = {
    merchantId: CONFIG.MERCHANT_ID,
    merchantTransactionId: 'TEST' + Date.now(),
    merchantUserId: 'TESTUSER',
    amount: 100,
    redirectUrl: 'https://example.com',
    redirectMode: 'POST',
    callbackUrl: 'https://example.com/webhook',
    mobileNumber: '9999999999',
    paymentInstrument: { type: 'PAY_PAGE' }
  };
  
  const { base64Payload, signature } = generateSignature(testPayload);
  
  res.json({
    success: true,
    environment: USE_UAT ? 'UAT' : 'PRODUCTION',
    merchantId: CONFIG.MERCHANT_ID,
    testPayload,
    base64Payload: base64Payload.substring(0, 100) + '...',
    signature: signature.substring(0, 50) + '...',
    apiEndpoint: `${CONFIG.API_BASE}/pg/v1/pay`
  });
});

// ROOT ENDPOINT
app.get('/', (req, res) => {
  res.json({ 
    status: 'running', 
    message: 'PES Canteen PhonePe Backend', 
    environment: USE_UAT ? 'UAT/SANDBOX (Testing)' : 'PRODUCTION',
    merchantId: CONFIG.MERCHANT_ID,
    apiBase: CONFIG.API_BASE,
    timestamp: new Date().toISOString(),
    endpoints: {
      createOrder: 'POST /api/create-order',
      webhook: 'POST /api/webhook',
      orderStatus: 'GET /api/order-status?orderId=xxx',
      testSignature: 'GET /api/test-signature'
    },
    instructions: USE_UAT ? 
      '✅ Running in TEST mode with PhonePe sandbox' :
      '⚠️ Running in PRODUCTION mode. Set USE_UAT=true in .env to test first.'
  });
});

// START SERVER
app.listen(port, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ Server running on port ${port}`);
  console.log(`🔹 Environment: ${USE_UAT ? '🧪 UAT/SANDBOX' : '🚀 PRODUCTION'}`);
  console.log(`🔹 API Base: ${CONFIG.API_BASE}`);
  console.log(`🔹 Merchant ID: ${CONFIG.MERCHANT_ID}`);
  console.log(`🔹 Webhook URL: ${MERCHANTBASEURL}/api/webhook`);
  console.log(`${'='.repeat(50)}\n`);
  
  if (!USE_UAT) {
    console.log('⚠️  WARNING: Running in PRODUCTION mode');
    console.log('💡 TIP: Set USE_UAT=true in .env to test with sandbox first\n');
  }
});

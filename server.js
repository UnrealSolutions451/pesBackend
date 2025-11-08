const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

// PhonePe SDK imports
const { PhonePeClient, Environment } = require('pg-sdk-node');
const { StandardCheckoutPayRequest, CreateSdkOrderRequest } = require('pg-sdk-node');

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
// PHONEPE SDK INITIALIZATION (V2)
// ============================================
const PHONEPE_ENV = process.env.PHONEPE_ENV || 'TEST';
const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const CLIENT_ID = process.env.PHONEPE_CLIENT_ID;
const CLIENT_SECRET = process.env.PHONEPE_CLIENT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL;
const BACKEND_URL = process.env.BACKEND_URL;

// Initialize PhonePe Client
const phonePeClient = new PhonePeClient({
  merchantId: MERCHANT_ID,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  environment: PHONEPE_ENV === 'LIVE' ? Environment.PRODUCTION : Environment.SANDBOX
});

console.log('\n' + '='.repeat(70));
console.log('🚀 PES CANTEEN PAYMENT BACKEND - PhonePe SDK V2');
console.log('='.repeat(70));
console.log(`✅ Environment: ${PHONEPE_ENV === 'LIVE' ? '🔴 PRODUCTION' : '🟡 TEST'}`);
console.log(`🏪 Merchant ID: ${MERCHANT_ID}`);
console.log(`🔐 Client ID: ${CLIENT_ID}`);
console.log(`🌐 Frontend: ${FRONTEND_URL}`);
console.log(`🔗 Backend: ${BACKEND_URL}`);
console.log('='.repeat(70) + '\n');

// ============================================
// CREATE PAYMENT ORDER (Using SDK)
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

    // Create payment request using SDK
    const paymentRequest = StandardCheckoutPayRequest.builder()
      .merchantOrderId(orderId)
      .amount(amountPaise)
      .merchantUserId(sessionId || `user_${Date.now()}`)
      .redirectUrl(`${FRONTEND_URL}/payment-return.html?orderId=${orderId}`)
      .callbackUrl(`${BACKEND_URL}/api/webhook`)
      .build();

    console.log('🔹 Initiating payment with PhonePe SDK...');

    // Call PhonePe API using SDK (handles OAuth, signatures, etc.)
    const response = await phonePeClient.pay(paymentRequest);

    console.log('✅ PhonePe Response:', JSON.stringify(response, null, 2));

    // Save order in Firestore
    await db.collection('orders').doc(orderId).set({
      merchantOrderId: orderId,
      items,
      table,
      sessionId,
      amount: total,
      status: 'PENDING',
      environment: PHONEPE_ENV,
      phonepeResponse: response,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Extract checkout URL from SDK response
    const checkoutUrl = response.data?.url || response.data?.instrumentResponse?.redirectInfo?.url;

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
    console.error('❌ Create order failed:', err);

    res.status(500).json({
      success: false,
      message: 'Failed to create payment order',
      error: err.message || 'Unknown error'
    });
  }
});

// ============================================
// ALTERNATIVE: Create SDK Order (Mobile Apps)
// ============================================
app.post('/api/create-sdk-order', async (req, res) => {
  try {
    const { items, total, sessionId } = req.body;

    if (!items || !total || total <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order data'
      });
    }

    const orderId = `PES${Date.now()}`;
    const amountPaise = Math.round(total * 100);

    // Create SDK order request
    const sdkOrderRequest = CreateSdkOrderRequest.builder()
      .merchantOrderId(orderId)
      .amount(amountPaise)
      .merchantUserId(sessionId || `user_${Date.now()}`)
      .build();

    const response = await phonePeClient.createSdkOrder(sdkOrderRequest);

    // Save order
    await db.collection('orders').doc(orderId).set({
      merchantOrderId: orderId,
      items,
      amount: total,
      status: 'PENDING',
      environment: PHONEPE_ENV,
      phonepeResponse: response,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      orderId,
      sdkPayload: response
    });

  } catch (err) {
    console.error('❌ SDK order creation failed:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to create SDK order',
      error: err.message
    });
  }
});

// ============================================
// PHONEPE WEBHOOK HANDLER
// ============================================
app.post('/api/webhook', async (req, res) => {
  try {
    console.log('\n🔔 Webhook received from PhonePe');
    console.log('Body:', JSON.stringify(req.body, null, 2));

    const payload = req.body;

    // Extract order ID
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
// CHECK ORDER STATUS
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

    // Check with PhonePe using SDK
    try {
      const statusResponse = await phonePeClient.checkStatus(orderId);

      console.log('📊 PhonePe status:', statusResponse);

      // Update local status if PhonePe has newer info
      const phonepeStatus = statusResponse.status;
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
        phonepeData: statusResponse
      });

    } catch (statusErr) {
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
// TEST SDK INITIALIZATION
// ============================================
app.get('/api/test-sdk', (req, res) => {
  try {
    res.json({
      success: true,
      message: 'PhonePe SDK initialized successfully',
      config: {
        environment: PHONEPE_ENV,
        merchantId: MERCHANT_ID,
        clientId: CLIENT_ID,
        sdkVersion: 'V2'
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
    version: '2.0 (PhonePe SDK)',
    mode: PHONEPE_ENV === 'LIVE' ? 'PRODUCTION' : 'TEST',
    timestamp: new Date().toISOString(),
    endpoints: {
      createOrder: 'POST /api/create-order',
      createSdkOrder: 'POST /api/create-sdk-order',
      webhook: 'POST /api/webhook',
      orderStatus: 'GET /api/order-status?orderId=xxx',
      testSdk: 'GET /api/test-sdk'
    },
    documentation: 'https://developer.phonepe.com/payment-gateway/backend-sdk/nodejs-be-sdk/'
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
  console.log(`🎯 PhonePe SDK V2 initialized`);
  console.log(`📡 Ready to accept payments!\n`);
});
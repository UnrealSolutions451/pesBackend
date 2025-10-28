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

// PHONEPE CONFIG - OAuth Method
const PHONEPEBASE = 'https://api.phonepe.com/apis/identity-manager/';
const CHECKOUT_BASE = 'https://api.phonepe.com/apis/checkout/v2/';
const CLIENTID = process.env.PHONEPE_CLIENT_ID; // From dashboard
const CLIENTSECRET = process.env.PHONEPE_CLIENT_SECRET; // From Show Key
const MERCHANTID = process.env.PHONEPE_MERCHANT_ID; // M23GZ2KFA4MBL
const MERCHANTBASEURL = process.env.MERCHANT_BASE_URL; // Your merchant base URL

// Cache for access token
let accessToken = null;
let tokenExpiry = null;

// GET ACCESS TOKEN (OAuth)
async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }
  try {
    const postBody = qs.stringify({
      client_id: CLIENTID,
      client_secret: CLIENTSECRET,
      grant_type: 'client_credentials',
      client_version: '1'
    });

    const response = await axios.post(
      `${PHONEPEBASE}v1/oauth/token`,
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
    console.log('Access token obtained, expires in:', expiresIn, 'seconds');
    return accessToken;
  } catch (err) {
    console.error('Token fetch failed:', err.response?.data || err.message);
    throw new Error('Failed to get access token');
  }
}


// CREATE ORDER - OAuth Method with /checkout/v2/pay
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

    // Build payload for checkout/v2/pay
    const payload = {
      merchantId: MERCHANTID,
      merchantOrderId: orderId,
      merchantUserId: sessionId || `user_${Date.now()}`,
      amount: amountPaise,
      redirectUrl: `${MERCHANTBASEURL}/payment-return.html?orderId=${orderId}`,
      redirectMode: 'POST',
      callbackUrl: `${MERCHANTBASEURL}/api/webhook`,
      // Optional: add customer info or payment instruments if needed
      mobileNumber: '9999999999',
      paymentInstrument: {
        type: 'PAY_PAGE'
      }
    };

    console.log('Initiating payment:', payload);

    // Call PhonePe API with OAuth token
    const response = await axios.post(
      `${CHECKOUT_BASE}pay`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-MERCHANT-ID': MERCHANTID
        }
      }
    );

    const phonepeResp = response.data;
    console.log('PhonePe Response:', phonepeResp);

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

    // Extract redirect URL for user to complete payment
    const checkoutUrl = phonepeResp.data?.instrumentResponse?.redirectInfo?.url || phonepeResp.data?.redirectUrl;
    if (!checkoutUrl) {
      throw new Error('No checkout URL in response');
    }

    res.json({ success: true, orderId, checkoutUrl });
  } catch (err) {
    console.error('Order create failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Create order failed', error: err.response?.data || err.message });
  }
});

// PHONEPE WEBHOOK
app.post('/api/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const orderId = payload.data?.merchantTransactionId || payload.merchantTransactionId;
    const status = payload.code === 'PAYMENTSUCCESS' ? 'SUCCESS' : 'FAILED';

    console.log('Webhook received:', orderId, status, payload);

    if (orderId) {
      await db.collection('orders').doc(orderId).update({
        status,
        phonepeCallback: payload,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
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

    // Optionally check status with PhonePe API via OAuth
    try {
      const token = await getAccessToken();

      const statusResponse = await axios.get(
        `${CHECKOUT_BASE}order/${orderId}/status`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'X-MERCHANT-ID': MERCHANTID
          }
        }
      );

      res.json({
        status: data.status,
        order: data,
        phonepeStatus: statusResponse.data
      });
    } catch (statusErr) {
      // If PhonePe API status check fails, still return local status
      res.json({ status: data.status, order: data });
    }
  } catch (err) {
    console.error('Order status error:', err);
    res.status(500).json({ message: 'Error fetching order status' });
  }
});

// ROOT ENDPOINT
app.get('/', (req, res) => {
  res.json({ status: 'running', message: 'PES Canteen PhonePe Backend OAuth', timestamp: new Date().toISOString() });
});

// START SERVER
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log('PhonePe Base:', PHONEPEBASE);
  console.log('Merchant ID:', MERCHANTID);
  console.log('Using OAuth authentication');
});


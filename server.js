// ============================
// PES CANTEEN - PHONEPE BACKEND (OAuth Method)
// ============================

const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");
const admin = require("firebase-admin");
const qs = require("qs"); // for x-www-form-urlencoded body

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const port = process.env.PORT || 4000;

// ============================
// 🔹 FIREBASE SETUP
// ============================

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();

// ============================
// 🔹 PHONEPE CONFIG (OAuth Method)
// ============================

const PHONEPE_BASE = "https://api.phonepe.com/apis/identity-manager"; // UPDATED
const CLIENT_ID = process.env.PHONEPE_CLIENT_ID; // From dashboard
const CLIENT_SECRET = process.env.PHONEPE_CLIENT_SECRET; // From "Show Key"
const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID; // M23GZ2KFA4MBL
const MERCHANT_BASE_URL = process.env.MERCHANT_BASE_URL;

// Cache for access token
let accessToken = null;
let tokenExpiry = null;

// ============================
// 🔹 GET ACCESS TOKEN (OAuth)
// ============================

async function getAccessToken() {
  // Return cached token if still valid
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }
  try {
    // Compose x-www-form-urlencoded body
    const postBody = qs.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
      client_version: "1" // Required for standard checkout
    });

    const response = await axios.post(
      `${PHONEPE_BASE}/v1/oauth/token`,
      postBody,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );
    accessToken = response.data.access_token;
    const expiresIn = response.data.expires_in || 3600; // Usually 1 hour
    tokenExpiry = Date.now() + (expiresIn * 1000) - 60000; // Refresh 1 min early
    console.log("✅ Access token obtained, expires in:", expiresIn, "seconds");
    return accessToken;
  } catch (err) {
    console.error("❌ Token fetch failed:", err.response?.data || err.message);
    throw new Error("Failed to get access token");
  }
}

// ============================
// 🔹 CREATE ORDER (OAuth Method)
// ============================

app.post("/api/create-order", async (req, res) => {
  try {
    const { items, total, table, sessionId } = req.body;
    if (!items || !total || total <= 0) {
      return res.status(400).json({ message: "Invalid order data" });
    }

    const orderId = "PES" + Date.now();
    const amountPaise = Math.round(total * 100);
    // Get OAuth token
    const token = await getAccessToken();
    // Build payload
    const payload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: orderId,
      merchantUserId: sessionId || `MUID${Date.now()}`,
      amount: amountPaise,
      redirectUrl: `${MERCHANT_BASE_URL}/payment-return.html?orderId=${orderId}`,
      redirectMode: "POST",
      callbackUrl: `${MERCHANT_BASE_URL}/api/webhook`,
      mobileNumber: "9999999999",
      paymentInstrument: {
        type: "PAY_PAGE"
      }
    };

    console.log("🔹 Initiating payment:", {
      orderId,
      amount: amountPaise,
      merchantId: MERCHANT_ID
    });

    // Call PhonePe API with OAuth token
    const response = await axios.post(
      "https://api.phonepe.com/apis/hermes/v1/debit", // keep /hermes here, confirmed for debit/order
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "X-MERCHANT-ID": MERCHANT_ID
        }
      }
    );

    const phonepeResp = response.data;
    console.log("✅ PhonePe Response:", phonepeResp);

    // Save order in Firestore
    await db.collection("orders").doc(orderId).set({
      merchantOrderId: orderId,
      items,
      table,
      sessionId,
      amount: total,
      status: "PENDING",
      phonepeResponse: phonepeResp,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Extract redirect URL
    const checkoutUrl =
      phonepeResp.data?.instrumentResponse?.redirectInfo?.url ||
      phonepeResp.data?.redirectUrl;
    if (!checkoutUrl) {
      throw new Error("No checkout URL in response");
    }

    res.json({
      success: true,
      orderId,
      checkoutUrl
    });
  } catch (err) {
    console.error("❌ Order create failed:", err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: "Create order failed",
      error: err.response?.data || err.message,
    });
  }
});

// ============================
// 🔹 PHONEPE WEBHOOK
// ============================

app.post("/api/webhook", async (req, res) => {
  try {
    const payload = req.body;
    const orderId = payload.data?.merchantTransactionId || payload.merchantTransactionId;
    const status = payload.code === "PAYMENT_SUCCESS" ? "SUCCESS" : "FAILED";
    console.log("🔔 Webhook received:", { orderId, status, payload });
    if (orderId) {
      await db.collection("orders").doc(orderId).update({
        status,
        phonepeCallback: payload,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).send("Error");
  }
});

// ============================
// 🔹 CHECK ORDER STATUS
// ============================

app.get("/api/order-status", async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ message: "Missing orderId" });
  try {
    const doc = await db.collection("orders").doc(orderId).get();
    if (!doc.exists) {
      return res.status(404).json({ message: "Order not found" });
    }
    const data = doc.data();
    // Optionally check status with PhonePe
    try {
      const token = await getAccessToken();
      const statusResponse = await axios.get(
        `https://api.phonepe.com/apis/hermes/v1/status/${MERCHANT_ID}/${orderId}`,
        {
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "X-MERCHANT-ID": MERCHANT_ID
          }
        }
      );
      res.json({
        status: data.status,
        order: data,
        phonepeStatus: statusResponse.data
      });
    } catch (statusErr) {
      res.json({ status: data.status, order: data });
    }
  } catch (err) {
    console.error("❌ Order status error:", err);
    res.status(500).json({ message: "Error fetching order status" });
  }
});

// ============================
// 🔹 ROOT ENDPOINT
// ============================

app.get("/", (_, res) => {
  res.json({
    status: "running",
    message: "PES Canteen PhonePe Backend (OAuth) ✅",
    timestamp: new Date().toISOString()
  });
});

// ============================
// 🔹 START SERVER
// ============================

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
  console.log(`🔹 PhonePe Base: ${PHONEPE_BASE}`);
  console.log(`🔹 Merchant ID: ${MERCHANT_ID}`);
  console.log(`🔹 Using OAuth authentication`);
});

const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");
const admin = require("firebase-admin");
const qs = require("qs");
const crypto = require("crypto");

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const port = process.env.PORT || 4000;

// FIREBASE SETUP
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}
const db = admin.firestore();

// MODE CONFIG
const MODE = process.env.MODE || "test";

// ✅ CORRECT V2 ENDPOINTS
const AUTH_BASE =
  MODE === "live"
    ? "https://api.phonepe.com/apis/identity-manager/v1/"
    : "https://api-preprod.phonepe.com/apis/identity-manager/v1/";

const PG_BASE =
  MODE === "live"
    ? "https://api.phonepe.com/apis/pg/checkout/v2/"
    : "https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/";

const CLIENTID = process.env.PHONEPE_CLIENT_ID;
const CLIENTSECRET = process.env.PHONEPE_CLIENT_SECRET;
const MERCHANTID = process.env.PHONEPE_MERCHANT_ID;
const MERCHANTBASEURL = process.env.MERCHANT_BASE_URL;

let accessToken = null;
let tokenExpiry = null;

// 🟢 GET ACCESS TOKEN (OAuth V2)
async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    console.log("✅ Using cached token");
    return accessToken;
  }

  try {
    console.log("🔑 Fetching new access token...");

    const postBody = qs.stringify({
      client_id: CLIENTID,
      client_secret: CLIENTSECRET,
      grant_type: "client_credentials",
    });

    const response = await axios.post(`${AUTH_BASE}oauth/token`, postBody, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    accessToken = response.data.access_token;
    const expiresIn = response.data.expires_in || 3600;
    tokenExpiry = Date.now() + expiresIn * 1000 - 60000;

    console.log("✅ Access token obtained, expires in:", expiresIn, "seconds");
    return accessToken;
  } catch (err) {
    console.error("❌ Token fetch failed:", err.response?.data || err.message);
    throw new Error("Failed to get access token");
  }
}

// 🟣 CREATE ORDER
app.post("/api/create-order", async (req, res) => {
  try {
    const { items, total, table, sessionId } = req.body;

    if (!items || total == null || total <= 0) {
      return res.status(400).json({ message: "Invalid order data" });
    }

    const orderId = `PES${Date.now()}`;
    const amountPaise = Math.round(total * 100);
    const token = await getAccessToken();

    const payload = {
      merchantId: MERCHANTID,
      merchantTransactionId: orderId,
      merchantUserId: sessionId || `MUID${Date.now()}`,
      amount: amountPaise,
      redirectUrl: `${MERCHANTBASEURL}/payment-return.html?orderId=${orderId}`,
      redirectMode: "POST",
      callbackUrl: `https://pesbackend.onrender.com/api/webhook`,
      mobileNumber: "9999999999",
      paymentInstrument: { type: "PAY_PAGE" },
    };

    console.log("🔹 Initiating payment:", {
      orderId,
      amount: amountPaise,
      endpoint: `${PG_BASE}pay`,
    });

    const response = await axios.post(`${PG_BASE}pay`, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `O-Bearer ${token}`,
        "X-MERCHANT-ID": MERCHANTID,
      },
    });

    const phonepeResp = response.data;
    console.log("✅ PhonePe Response:", JSON.stringify(phonepeResp, null, 2));

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

    const checkoutUrl =
      phonepeResp.data?.instrumentResponse?.redirectInfo?.url ||
      phonepeResp.data?.redirectUrl ||
      phonepeResp.redirectUrl;

    if (!checkoutUrl) {
      throw new Error("No checkout URL in response");
    }

    res.json({ success: true, orderId, checkoutUrl });
  } catch (err) {
    console.error("❌ Order create failed:", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    res.status(500).json({
      success: false,
      message: "Create order failed",
      error: err.response?.data || err.message,
    });
  }
});

// 🟡 WEBHOOK HANDLER
app.post("/api/webhook", async (req, res) => {
  try {
    const payload = req.body;
    console.log("🔔 Webhook received:", JSON.stringify(payload, null, 2));

    const orderId =
      payload.data?.merchantTransactionId || payload.merchantTransactionId;

    const status =
      payload.code === "PAYMENT_SUCCESS" ||
      payload.data?.state === "COMPLETED"
        ? "SUCCESS"
        : "FAILED";

    if (orderId) {
      await db.collection("orders").doc(orderId).update({
        status,
        phonepeCallback: payload,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log("✅ Order updated:", orderId, status);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).send("Error");
  }
});

// 🟢 ORDER STATUS CHECK
app.get("/api/order-status", async (req, res) => {
  const orderId = req.query.orderId;
  if (!orderId) return res.status(400).json({ message: "Missing orderId" });

  try {
    const token = await getAccessToken();
    const response = await axios.get(`${PG_BASE}order/${orderId}/status`, {
      headers: {
        Authorization: `O-Bearer ${token}`,
        "X-MERCHANT-ID": MERCHANTID,
      },
    });

    res.json({ success: true, statusData: response.data });
  } catch (err) {
    console.error("❌ Order status failed:", err.response?.data || err.message);
    res.status(500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});

// ROOT
app.get("/", (req, res) =>
  res.json({
    status: "running",
    mode: MODE,
    message: "PES Canteen PhonePe V2 Backend",
    timestamp: new Date().toISOString(),
  })
);

// START SERVER
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
  console.log(`🔹 Auth Base: ${AUTH_BASE}`);
  console.log(`🔹 PG Base: ${PG_BASE}`);
  console.log(`🔹 Merchant ID: ${MERCHANTID}`);
});

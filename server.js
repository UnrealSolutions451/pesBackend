// ============================
//  PES CANTEEN - PHONEPE BACKEND (PRODUCTION READY)
// ============================

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const dotenv = require("dotenv");
const cors = require("cors");
const admin = require("firebase-admin");

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

const port = process.env.PORT || 4000;

// ============================
// 🔹 FIREBASE SETUP
// ============================
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}
const db = admin.firestore();

// ============================
// 🔹 PHONEPE CONFIG
// ============================
const PHONEPE_BASE = process.env.PHONEPE_BASE_URL;          // e.g. https://api.phonepe.com/apis/hermes
const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const MERCHANT_SECRET = process.env.PHONEPE_SECRET;         // Your Salt Key (not merchant secret)
const MERCHANT_BASE_URL = process.env.MERCHANT_BASE_URL;    // e.g. https://pesbackend.onrender.com

// ============================
// 🔹 SIGNATURE HELPER (Base64 + Salt Key + Path)
// ============================
function signPayload(base64Payload) {
  const stringToSign = base64Payload + "/pg/v1/pay" + MERCHANT_SECRET;
  const sha256 = crypto.createHash("sha256").update(stringToSign).digest("hex");
  return sha256 + "###1"; // 1 = salt index (update if different in your PhonePe dashboard)
}

// ============================
// 🔹 CREATE ORDER (PhonePe Pay Page Flow)
// ============================
app.post("/api/create-order", async (req, res) => {
  try {
    const { items, total, table, sessionId } = req.body;
    const orderId = "PES-" + Date.now();
    const amountPaise = Math.round(total * 100);

    // --- Build payload ---
    const createOrderPayload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: orderId,
      merchantUserId: sessionId || "guest",
      amount: amountPaise,
      redirectUrl: `${MERCHANT_BASE_URL}/payment-return.html?orderId=${orderId}`,
      callbackUrl: `${MERCHANT_BASE_URL}/api/webhook`,
      mobileNumber: "9999999999",
      paymentInstrument: { type: "PAY_PAGE" },
    };

    // --- Encode + Sign ---
    const base64Payload = Buffer.from(JSON.stringify(createOrderPayload)).toString("base64");
    const signature = signPayload(base64Payload);

    // --- Call PhonePe ---
    const response = await axios.post(
      `${PHONEPE_BASE}/pg/v1/pay`,
      { request: base64Payload },
      {
        headers: {
          "Content-Type": "application/json",
          "X-VERIFY": signature,
          "X-MERCHANT-ID": MERCHANT_ID,
        },
      }
    );

    const phonepeResp = response.data;

    // --- Save pending order in Firestore ---
    await db.collection("orders").doc(orderId).set({
      merchantOrderId: orderId,
      items,
      table,
      sessionId,
      amount: total,
      status: "created",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // --- Send redirect URL to frontend ---
    res.json({
      checkoutUrl:
        phonepeResp.data?.instrumentResponse?.redirectInfo?.url ||
        phonepeResp.data?.redirectUrl,
    });
  } catch (err) {
    console.error("Order create failed:", err.response?.data || err.message);
    res.status(500).json({
      message: "Create order failed",
      detail: err.response?.data || err.message,
    });
  }
});

// ============================
// 🔹 PHONEPE CALLBACK / WEBHOOK
// ============================
// Note: PhonePe will send transaction status here after payment.
app.post("/api/webhook", async (req, res) => {
  try {
    const payload = req.body;
    const orderId = payload.data?.merchantTransactionId || payload.merchantTransactionId;

    await db.collection("orders").doc(orderId).update({
      status: payload.code || payload.data?.responseCode || "unknown",
      phonepeResponse: payload,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Error");
  }
});

// ============================
// 🔹 CHECK ORDER STATUS (for frontend polling)
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
    res.json({ status: data.status || "PENDING", order: data });
  } catch (err) {
    console.error("Order status error:", err);
    res.status(500).json({ message: "Error fetching order status" });
  }
});

// ============================
// 🔹 ROOT ENDPOINT (for Render uptime check)
// ============================
app.get("/", (_, res) => res.send("PES Canteen PhonePe backend running ✅"));

// ============================
// 🔹 START SERVER
// ============================
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));

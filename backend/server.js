// ============================
//  PES CANTEEN - PHONEPE BACKEND
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

// --- FIREBASE SETUP ---
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}
const db = admin.firestore();

// --- PHONEPE CONFIG (from .env) ---
const PHONEPE_BASE = process.env.PHONEPE_BASE_URL; // e.g. https://api-preprod.phonepe.com/apis/pg-sandbox
const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const MERCHANT_SECRET = process.env.PHONEPE_SECRET;
const MERCHANT_BASE_URL = process.env.MERCHANT_BASE_URL; // your backend base URL (for webhook/redirect)

// Helper: sign payload per PhonePe docs (HMAC SHA256)
function signPayload(payload) {
  const jsonStr = JSON.stringify(payload);
  return crypto.createHmac("sha256", MERCHANT_SECRET).update(jsonStr).digest("hex");
}

// --- CREATE ORDER ---
app.post("/api/create-order", async (req, res) => {
  try {
    const { items, total, table, sessionId } = req.body;
    const orderId = "PES-" + Date.now();
    const amountPaise = Math.round(total * 100);

    const createOrderPayload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: orderId,
      amount: amountPaise,
      merchantUserId: sessionId || "guest",
      redirectUrl: `${MERCHANT_BASE_URL}/payment-return.html?orderId=${orderId}`,
      callbackUrl: `${MERCHANT_BASE_URL}/api/webhook`,
      mobileNumber: "9999999999",
      paymentInstrument: { type: "PAY_PAGE" }
    };

    const signature = signPayload(createOrderPayload);

    const response = await axios.post(`${PHONEPE_BASE}/pg/v1/pay`, createOrderPayload, {
      headers: {
        "Content-Type": "application/json",
        "X-MERCHANT-ID": MERCHANT_ID,
        "X-SIGNATURE": signature,
      },
      timeout: 15000,
    });

    const phonepeResp = response.data;

    await db.collection("orders").doc(orderId).set({
      merchantOrderId: orderId,
      items,
      table,
      sessionId,
      amount: total,
      status: "created",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

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


// --- WEBHOOK (PhonePe callback) ---
app.post("/api/webhook", async (req, res) => {
  try {
    const signatureHeader = req.headers["x-signature"];
    const payload = req.body;

    const expectedSig = signPayload(payload);
    if (signatureHeader !== expectedSig) {
      console.warn("Invalid webhook signature");
      return res.status(400).send("Invalid signature");
    }

    const orderId = payload.merchantOrderId;
    const status = payload.status || "unknown";

    await db.collection("orders").doc(orderId).update({
      status,
      phonepeResponse: payload,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Error");
  }
});
// --- CHECK ORDER STATUS (frontend uses this) ---
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

app.get("/", (_, res) => res.send("PES Canteen PhonePe backend running ✅"));
app.listen(port, () => console.log(`Server listening on port ${port}`));

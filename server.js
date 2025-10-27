// ============================
//  PES CANTEEN - PHONEPE BACKEND (FIXED)
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
// 🔹 PHONEPE CONFIG - FIXED
// ============================
const PHONEPE_BASE = process.env.PHONEPE_BASE_URL; // https://api-preprod.phonepe.com/apis/pg-sandbox (UAT) or https://api.phonepe.com/apis/hermes (PROD)
const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const SALT_KEY = process.env.PHONEPE_SECRET; // This is your Salt Key
const SALT_INDEX = "1"; // Usually 1, check your PhonePe dashboard
const MERCHANT_BASE_URL = process.env.MERCHANT_BASE_URL;

// ============================
// 🔹 SIGNATURE HELPER (FIXED)
// ============================
function generateSignature(payload) {
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString("base64");
  const stringToSign = base64Payload + "/pg/v1/pay" + SALT_KEY;
  const sha256 = crypto.createHash("sha256").update(stringToSign).digest("hex");
  const signature = sha256 + "###" + SALT_INDEX;
  
  return { base64Payload, signature };
}

// ============================
// 🔹 CREATE ORDER (FIXED)
// ============================
app.post("/api/create-order", async (req, res) => {
  try {
    const { items, total, table, sessionId } = req.body;
    
    // Validate inputs
    if (!items || !total || total <= 0) {
      return res.status(400).json({ message: "Invalid order data" });
    }

    const orderId = "PES" + Date.now();
    const amountPaise = Math.round(total * 100);

    // Build payload - FIXED structure
    const payload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: orderId,
      merchantUserId: sessionId || `MUID${Date.now()}`,
      amount: amountPaise,
      redirectUrl: `${MERCHANT_BASE_URL}/payment-return.html?orderId=${orderId}`,
      redirectMode: "POST",
      callbackUrl: `${MERCHANT_BASE_URL}/api/webhook`,
      mobileNumber: "9999999999", // Optional in UAT, required in production
      paymentInstrument: {
        type: "PAY_PAGE"
      }
    };

    // Generate signature
    const { base64Payload, signature } = generateSignature(payload);

    console.log("🔹 Initiating payment:", {
      orderId,
      amount: amountPaise,
      merchantId: MERCHANT_ID
    });

    // Call PhonePe API - FIXED endpoint
    const response = await axios.post(
      `${PHONEPE_BASE}/pg/v1/pay`,
      {
        request: base64Payload
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-VERIFY": signature
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
// 🔹 PHONEPE WEBHOOK (FIXED)
// ============================
app.post("/api/webhook", async (req, res) => {
  try {
    const base64Response = req.body.response;
    const receivedSignature = req.headers["x-verify"];

    // Verify signature
    const expectedSignature = crypto
      .createHash("sha256")
      .update(base64Response + SALT_KEY)
      .digest("hex") + "###" + SALT_INDEX;

    if (receivedSignature !== expectedSignature) {
      console.error("❌ Invalid signature");
      return res.status(401).send("Invalid signature");
    }

    // Decode payload
    const payload = JSON.parse(Buffer.from(base64Response, "base64").toString());
    const orderId = payload.data.merchantTransactionId;
    const status = payload.code === "PAYMENT_SUCCESS" ? "SUCCESS" : "FAILED";

    console.log("🔔 Webhook received:", { orderId, status });

    // Update order in Firestore
    await db.collection("orders").doc(orderId).update({
      status,
      phonepeCallback: payload,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).send("Error");
  }
});

// ============================
// 🔹 CHECK ORDER STATUS (FIXED)
// ============================
app.get("/api/order-status", async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ message: "Missing orderId" });

  try {
    // Check Firestore
    const doc = await db.collection("orders").doc(orderId).get();
    if (!doc.exists) {
      return res.status(404).json({ message: "Order not found" });
    }

    const data = doc.data();

    // Optionally verify with PhonePe API
    const statusCheckUrl = `${PHONEPE_BASE}/pg/v1/status/${MERCHANT_ID}/${orderId}`;
    const stringToSign = `/pg/v1/status/${MERCHANT_ID}/${orderId}` + SALT_KEY;
    const signature = crypto.createHash("sha256").update(stringToSign).digest("hex") + "###" + SALT_INDEX;

    try {
      const statusResponse = await axios.get(statusCheckUrl, {
        headers: {
          "Content-Type": "application/json",
          "X-VERIFY": signature,
          "X-MERCHANT-ID": MERCHANT_ID
        }
      });

      console.log("📊 Status check:", statusResponse.data);

      res.json({
        status: data.status,
        order: data,
        phonepeStatus: statusResponse.data
      });
    } catch (statusErr) {
      // If status check fails, return Firestore data
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
    message: "PES Canteen PhonePe Backend ✅",
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
});

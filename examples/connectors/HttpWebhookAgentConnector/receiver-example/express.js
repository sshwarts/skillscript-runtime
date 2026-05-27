// Reference receiver for HttpWebhookAgentConnector — Node + Express.
// Copy + customize per your substrate. ~30 LOC; readable in 60 seconds.
//
// What this demonstrates:
//   - Accepts POST with JSON body matching the canonical DeliveryPayload shape
//     (kind + content + meta + agent_id at top-level for routing).
//   - Translates skillscript envelope → your substrate's routing layer.
//   - Returns canonical DeliveryReceipt shape (delivered_at + optional delivery_id).
//
// HMAC validation note: if you use HTTP_WEBHOOK_HMAC_SECRET on the sender,
// validate the X-Signature header against the RAW HTTP body BEFORE parsing
// JSON. The pattern below uses express.raw() to expose req.body as a Buffer.

const express = require("express");
const crypto = require("crypto");
const { createHmac } = crypto;

const PORT = parseInt(process.env.PORT ?? "3200", 10);
const HMAC_SECRET = process.env.HMAC_SECRET; // optional

const app = express();
app.use(express.raw({ type: "application/json", limit: "1mb" }));

app.post("/webhook/:channel?", (req, res) => {
  // 1) Validate HMAC signature against raw body (BEFORE parsing).
  if (HMAC_SECRET !== undefined) {
    const expected = `sha256=${createHmac("sha256", HMAC_SECRET).update(req.body).digest("hex")}`;
    if (req.headers["x-signature"] !== expected) {
      return res.status(401).json({ error: "invalid signature" });
    }
  }

  // 2) Parse JSON body. Now safe — signature validated against raw bytes.
  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "malformed JSON" });
  }

  // 3) Translate skillscript envelope → your routing layer.
  // payload.agent_id is the top-level routing key (Model B receivers can
  // dispatch from this alone). req.params.channel is URL-based routing
  // (Model A). Use whichever fits your substrate.
  const text = `[${payload.meta?.origin?.skill_name ?? "skill"}] ${payload.content ?? payload.prompt ?? ""}`;
  const senderName = `skillscript:${payload.meta?.origin?.skill_name ?? "unknown"}`;

  // your-substrate-here:
  console.log(`[${req.params.channel ?? payload.agent_id}] ${senderName}: ${text}`);
  // e.g., NanoClaw-style:
  //   routeInbound({channelType, platformId, threadId: null,
  //                  message: { id: payload.meta?.dispatch_id, body: text, sender: senderName }});

  // 4) Return canonical DeliveryReceipt. delivery_id echoes dispatch_id so
  // sender can correlate. Set delivery_skipped: true if substrate accepts
  // but won't actually deliver (agent offline, rate-limit, etc.).
  res.json({
    delivered_at: Date.now(),
    delivery_id: payload.meta?.dispatch_id,
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HttpWebhookAgentConnector receiver-example listening on :${PORT}`);
});

// Clock-skew note: payload.meta.sent_at is the SENDER's emit-clock; your
// own clock when this request arrives may drift. If you compute staleness
// as `now - payload.meta.sent_at`, use `Math.max(0, delta)` to avoid
// negative values when receiver clock runs ahead.

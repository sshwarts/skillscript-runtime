"""
Reference receiver for HttpWebhookAgentConnector — Python + Flask.
Copy + customize per your substrate. ~30 LOC; readable in 60 seconds.

What this demonstrates:
  - Accepts POST with JSON body matching the canonical DeliveryPayload shape
    (kind + content + meta + agent_id at top-level for routing).
  - Translates skillscript envelope -> your substrate's routing layer.
  - Returns canonical DeliveryReceipt shape (delivered_at + optional delivery_id).

HMAC validation note: if you use HTTP_WEBHOOK_HMAC_SECRET on the sender,
validate the X-Signature header against the RAW HTTP body BEFORE parsing
JSON. Use `request.get_data()` to get the raw bytes; only `request.get_json()`
after signature validates.
"""
import hashlib
import hmac
import json
import os
import time
from flask import Flask, request, jsonify

app = Flask(__name__)
HMAC_SECRET = os.environ.get("HMAC_SECRET")  # optional


@app.route("/webhook", methods=["POST"])
@app.route("/webhook/<channel>", methods=["POST"])
def webhook(channel=None):
    raw_body = request.get_data()

    # 1) Validate HMAC signature against raw body (BEFORE parsing).
    if HMAC_SECRET is not None:
        expected = "sha256=" + hmac.new(HMAC_SECRET.encode(), raw_body, hashlib.sha256).hexdigest()
        if request.headers.get("X-Signature") != expected:
            return jsonify({"error": "invalid signature"}), 401

    # 2) Parse JSON body. Now safe — signature validated against raw bytes.
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except json.JSONDecodeError:
        return jsonify({"error": "malformed JSON"}), 400

    # 3) Translate skillscript envelope -> your routing layer.
    skill_name = payload.get("meta", {}).get("origin", {}).get("skill_name", "skill")
    content = payload.get("content") or payload.get("prompt", "")
    text = f"[{skill_name}] {content}"
    sender_name = f"skillscript:{skill_name}"

    # your-substrate-here:
    print(f"[{channel or payload.get('agent_id')}] {sender_name}: {text}")
    # e.g., NanoClaw-style:
    #   route_inbound(channel_type, platform_id, message={
    #       "id": payload["meta"]["dispatch_id"], "body": text, "sender": sender_name})

    # 4) Return canonical DeliveryReceipt. delivery_id echoes dispatch_id
    # so sender can correlate. Set delivery_skipped: true if substrate
    # accepts but won't actually deliver (agent offline, rate-limit, etc.).
    return jsonify({
        "delivered_at": int(time.time() * 1000),
        "delivery_id": payload.get("meta", {}).get("dispatch_id"),
    })


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3200"))
    app.run(host="0.0.0.0", port=port)

# Clock-skew note: payload.meta.sent_at is the SENDER's emit-clock; your
# own clock when this request arrives may drift. If you compute staleness
# as `now - payload['meta']['sent_at']`, use `max(0, delta)` to avoid
# negative values when receiver clock runs ahead.

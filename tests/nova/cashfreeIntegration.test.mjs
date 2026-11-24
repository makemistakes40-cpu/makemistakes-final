import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import {
  CashfreeClient,
  getCashfreeEnv,
  isCashfreeConfigured,
  verifyCashfreeWebhookSignature,
  resolvePaidPlan,
} from "../../src/lib/cashfree.ts";
import { getPlanConfig } from "../../src/lib/plans.ts";

// --- environment & billing helpers ----------------------------------------

test("cashfree env defaults to TEST and honors PRODUCTION", () => {
  assert.equal(getCashfreeEnv({}), "TEST");
  assert.equal(getCashfreeEnv({ CASHFREE_ENV: "TEST" }), "TEST");
  assert.equal(getCashfreeEnv({ CASHFREE_ENV: "PRODUCTION" }), "PRODUCTION");
  assert.equal(getCashfreeEnv({ CASHFREE_ENV: "PROD" }), "PRODUCTION");
});

test("isCashfreeConfigured requires real app id + secret", () => {
  assert.equal(isCashfreeConfigured({}), false);
  assert.equal(isCashfreeConfigured({ CASHFREE_APP_ID: "a", CASHFREE_SECRET_KEY: "b" }), true);
  assert.equal(
    isCashfreeConfigured({ CASHFREE_APP_ID: "your-app-id", CASHFREE_SECRET_KEY: "b" }),
    false
  );
});

test("resolvePaidPlan maps BUILDER/PRO/MAX, rejects FREE", () => {
  assert.equal(resolvePaidPlan("BUILDER"), "BUILDER");
  assert.equal(resolvePaidPlan("PRO"), "PRO");
  assert.equal(resolvePaidPlan("FREE"), null);
  assert.equal(resolvePaidPlan("SOMETHING"), null);
});

// --- webhook signature verification --------------------------------------

// Cashfree signs the DIRECT concatenation of x-webhook-timestamp + raw body
// (no separator), with base64 HMAC-SHA256 using the API Secret Key.
function signWebhook(rawBody, secret, timestamp) {
  const data = timestamp ? `${timestamp}${rawBody}` : rawBody;
  return crypto.createHmac("sha256", secret).update(data).digest("base64");
}

const TS = () => String(Math.floor(Date.now() / 1000));

test("webhook verifies with exact Cashfree formula (timestamp + raw body)", () => {
  const raw = JSON.stringify({ type: "PAYMENT_SUCCESS", data: {} });
  const secret = "test-secret-key";
  const ts = TS();
  const sig = signWebhook(raw, secret, ts);
  assert.equal(verifyCashfreeWebhookSignature(raw, sig, secret, ts), true);
});

test("webhook rejects invalid signature", () => {
  const raw = JSON.stringify({ type: "PAYMENT_SUCCESS" });
  const secret = "right-secret";
  const ts = TS();
  const sig = signWebhook(raw, secret, ts);
  assert.equal(verifyCashfreeWebhookSignature(raw, "bm90LXRoZS1yaWdodA==", secret, ts), false);
  assert.equal(verifyCashfreeWebhookSignature(raw, sig, "wrong-secret", ts), false);
});

test("webhook rejects modified body", () => {
  const raw = JSON.stringify({ type: "PAYMENT_SUCCESS", amount: 1799 });
  const secret = "right-secret";
  const ts = TS();
  const sig = signWebhook(raw, secret, ts);
  const tampered = JSON.stringify({ type: "PAYMENT_SUCCESS", amount: 999999 });
  assert.equal(verifyCashfreeWebhookSignature(tampered, sig, secret, ts), false);
});

test("webhook rejects modified timestamp", () => {
  const raw = "{}";
  const secret = "right-secret";
  const ts = TS();
  const sig = signWebhook(raw, secret, ts);
  assert.equal(verifyCashfreeWebhookSignature(raw, sig, secret, String(Number(ts) + 1)), false);
});

test("webhook rejects missing secret or signature", () => {
  const raw = "{}";
  const secret = "secret";
  const ts = TS();
  const sig = signWebhook(raw, secret, ts);
  assert.equal(verifyCashfreeWebhookSignature(raw, sig, "", ts), false);
  assert.equal(verifyCashfreeWebhookSignature(raw, "", secret, ts), false);
});

test("webhook rejects stale replay timestamps but allows delayed delivery", () => {
  const raw = "{}";
  const secret = "secret";
  const ts = TS();
  const sig = signWebhook(raw, secret, ts);
  const old = String(Number(ts) - 10_000);
  assert.equal(verifyCashfreeWebhookSignature(raw, sig, secret, old), false);
  assert.equal(verifyCashfreeWebhookSignature(raw, sig, secret, "not-a-number"), false);
  // A delayed but legitimate delivery within the window is accepted.
  const delayed = String(Number(ts) - 60);
  const delayedSig = signWebhook(raw, secret, delayed);
  assert.equal(verifyCashfreeWebhookSignature(raw, delayedSig, secret, delayed), true);
});

test("duplicate webhook with same payload+timestamp verifies (idempotent)", () => {
  const raw = JSON.stringify({ type: "PAYMENT_SUCCESS", data: { order_id: "ord1" } });
  const secret = "secret";
  const ts = TS();
  const sig = signWebhook(raw, secret, ts);
  for (let i = 0; i < 3; i++) {
    assert.equal(verifyCashfreeWebhookSignature(raw, sig, secret, ts), true);
  }
});

// --- order creation (mocked fetch) ---------------------------------------

test("createOrder posts to v4 orders endpoint and returns session id", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      json: async () => ({
        order_id: "cf_order_1",
        payment_session_id: "session_abc",
        order_status: "ACTIVE",
      }),
    };
  };
  try {
    const cf = new CashfreeClient({
      CASHFREE_APP_ID: "app",
      CASHFREE_SECRET_KEY: "secret",
      CASHFREE_ENV: "TEST",
    });
    const order = await cf.createOrder({
      orderId: "ord_mm_1",
      amount: 179900,
      customer: { customerId: "u1", email: "a@b.com", name: "A" },
    });
    assert.equal(order.order_id, "cf_order_1");
    assert.equal(order.payment_session_id, "session_abc");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("/orders"));
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.order_amount, 1799); // paise -> INR
    assert.equal(body.order_currency, "INR");
    // x-client-id / x-client-secret headers are set
    assert.equal(calls[0].opts.headers["x-client-id"], "app");
    assert.equal(calls[0].opts.headers["x-client-secret"], "secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createOrder throws PAYMENT_UNAVAILABLE on gateway error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  try {
    const cf = new CashfreeClient({ CASHFREE_APP_ID: "app", CASHFREE_SECRET_KEY: "secret" });
    await assert.rejects(
      () => cf.createOrder({ orderId: "o", amount: 100, customer: { customerId: "u", email: "e@x.com" } }),
      /PAYMENT_UNAVAILABLE/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createOrder throws on invalid response shape", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ not_an_order: true }) });
  try {
    const cf = new CashfreeClient({ CASHFREE_APP_ID: "app", CASHFREE_SECRET_KEY: "secret" });
    await assert.rejects(
      () => cf.createOrder({ orderId: "o", amount: 100, customer: { customerId: "u", email: "e@x.com" } }),
      /PAYMENT_UNAVAILABLE/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- order payment status (server-side verification) ----------------------

test("getOrderPayments returns payment list; distinguishes statuses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [
      { cf_payment_id: "pay1", payment_status: "PENDING", payment_amount: 1799, payment_currency: "INR" },
      { cf_payment_id: "pay2", payment_status: "SUCCESS", payment_amount: 1799, payment_currency: "INR" },
    ],
  });
  try {
    const cf = new CashfreeClient({ CASHFREE_APP_ID: "app", CASHFREE_SECRET_KEY: "secret" });
    const payments = await cf.getOrderPayments("cf_order_1");
    assert.equal(payments.length, 2);
    assert.equal(payments.find((p) => p.payment_status === "SUCCESS").cf_payment_id, "pay2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- amount/currency + gateway resolution helpers --------------------------

import {
  cashfreeSuccessMatchesOrder,
  normalizeCashfreeEventType,
  cashfreeRefundDecision,
} from "../../src/lib/cashfree.ts";
import { resolveWebhookGateway } from "../../src/lib/gateway.ts";

test("normalizeCashfreeEventType maps documented _WEBHOOK event names to canonical forms", () => {
  // Current official Cashfree PG webhook event names.
  assert.equal(normalizeCashfreeEventType("PAYMENT_SUCCESS_WEBHOOK"), "PAYMENT_SUCCESS");
  assert.equal(normalizeCashfreeEventType("PAYMENT_FAILED_WEBHOOK"), "PAYMENT_FAILED");
  assert.equal(normalizeCashfreeEventType("PAYMENT_CANCELLED_WEBHOOK"), "PAYMENT_CANCELLED");
  assert.equal(normalizeCashfreeEventType("PAYMENT_USER_DROPPED_WEBHOOK"), "PAYMENT_USER_DROPPED");
  assert.equal(normalizeCashfreeEventType("REFUND_STATUS_WEBHOOK"), "REFUND_STATUS");
  assert.equal(normalizeCashfreeEventType("REFUND_SUCCESS_WEBHOOK"), "REFUND_SUCCESS");
  // Legacy unsuffixed names remain supported and are unchanged.
  assert.equal(normalizeCashfreeEventType("PAYMENT_SUCCESS"), "PAYMENT_SUCCESS");
  assert.equal(normalizeCashfreeEventType("REFUND_SUCCESS"), "REFUND_SUCCESS");
  // Unrelated/unrecognized types pass through untouched.
  assert.equal(normalizeCashfreeEventType("ORDER_CREATED"), "ORDER_CREATED");
  assert.equal(normalizeCashfreeEventType(""), "");
});

test("cashfreeSuccessMatchesOrder accepts matching amount/currency", () => {
  const order = { amount: 179900, currency: "INR" }; // 1799 INR in paise
  assert.equal(
    cashfreeSuccessMatchesOrder({ payment_amount: 1799, payment_currency: "INR" }, order),
    true
  );
});

test("cashfreeSuccessMatchesOrder rejects amount mismatch", () => {
  const order = { amount: 179900, currency: "INR" };
  // Mismatch by ₹1.
  assert.equal(
    cashfreeSuccessMatchesOrder({ payment_amount: 1798, payment_currency: "INR" }, order),
    false
  );
  assert.equal(
    cashfreeSuccessMatchesOrder({ payment_amount: 1800, payment_currency: "INR" }, order),
    false
  );
  // Mismatch by ₹0.01 (1 paise).
  assert.equal(
    cashfreeSuccessMatchesOrder({ payment_amount: 1799.01, payment_currency: "INR" }, order),
    false
  );
  // Paise decimals that do not correspond to the stored amount.
  assert.equal(
    cashfreeSuccessMatchesOrder({ payment_amount: 1799.5, payment_currency: "INR" }, order),
    false
  );
});

test("cashfreeSuccessMatchesOrder rejects invalid/missing amounts", () => {
  const order = { amount: 179900, currency: "INR" };
  const invalidAmounts = [
    undefined,
    null,
    "1799", // string, not numeric
    NaN,
    Infinity,
    -Infinity,
    -1,
    -1799,
    {},
    [],
  ];
  for (const payment_amount of invalidAmounts) {
    assert.equal(
      cashfreeSuccessMatchesOrder({ payment_amount, payment_currency: "INR" }, order),
      false,
      `expected rejection for payment_amount=${String(payment_amount)}`
    );
  }
});

test("cashfreeSuccessMatchesOrder rejects currency mismatch", () => {
  const order = { amount: 179900, currency: "INR" };
  assert.equal(
    cashfreeSuccessMatchesOrder({ payment_amount: 1799, payment_currency: "USD" }, order),
    false
  );
});

test("resolveWebhookGateway: explicit gateway wins; hex => Razorpay; base64 => Cashfree", () => {
  assert.equal(resolveWebhookGateway("CASHFREE", "aaaa"), "CASHFREE");
  assert.equal(resolveWebhookGateway("RAZORPAY", "not-hex"), "RAZORPAY");
  const hex = "a".repeat(64);
  const b64 = Buffer.from("not-hex-value").toString("base64");
  assert.equal(resolveWebhookGateway(undefined, hex), "RAZORPAY");
  assert.equal(resolveWebhookGateway(undefined, b64), "CASHFREE");
});

// --- refund decision (documented REFUND_STATUS_WEBHOOK payload) ------------

// Canonical REFUND_STATUS_WEBHOOK payload shape (amounts in rupees).
const orderFixture = { amount: 179900, gatewayPaymentId: "cfpay_123" }; // 1799 INR in paise

function refundPayload(overrides = {}) {
  return {
    refund_id: "cf_refund_1",
    order_id: "cf_order_1",
    cf_payment_id: "cfpay_123",
    refund_amount: 1799,
    refund_status: "SUCCESS",
    ...overrides,
  };
}

test("refund decision: full SUCCESS refund revokes", () => {
  assert.deepEqual(
    cashfreeRefundDecision({
      eventType: "REFUND_STATUS",
      refund: refundPayload(),
      order: orderFixture,
    }),
    { revoke: true }
  );
});

test("refund decision: partial refund does not revoke (amount < order total)", () => {
  assert.deepEqual(
    cashfreeRefundDecision({
      eventType: "REFUND_STATUS",
      refund: refundPayload({ refund_amount: 500 }),
      order: orderFixture,
    }),
    { revoke: false, reason: "partial_refund_not_supported" }
  );
});

test("refund decision: non-SUCCESS status never revokes", () => {
  for (const refund_status of ["PENDING", "PROCESSING", "FAILED", "CANCELLED", "", null]) {
    const r = cashfreeRefundDecision({
      eventType: "REFUND_STATUS",
      refund: refundPayload({ refund_status }),
      order: orderFixture,
    });
    assert.equal(r.revoke, false, `should not revoke for status ${JSON.stringify(refund_status)}`);
  }
});

test("refund decision: mismatched payment id must not revoke", () => {
  const r = cashfreeRefundDecision({
    eventType: "REFUND_STATUS",
    refund: refundPayload({ cf_payment_id: "cfpay_OTHER" }),
    order: orderFixture,
  });
  assert.equal(r.revoke, false);
  assert.equal(r.reason, "refund_payment_id_mismatch");
});

test("refund decision: missing payment id must not revoke", () => {
  const r = cashfreeRefundDecision({
    eventType: "REFUND_STATUS",
    refund: refundPayload({ cf_payment_id: undefined }),
    order: orderFixture,
  });
  assert.equal(r.revoke, false);
  assert.equal(r.reason, "refund_payment_id_missing");
});

test("refund decision: invalid or missing amount must not revoke", () => {
  for (const refund_amount of [undefined, null, "not-a-number", NaN, Infinity, -1]) {
    const r = cashfreeRefundDecision({
      eventType: "REFUND_STATUS",
      refund: refundPayload({ refund_amount }),
      order: orderFixture,
    });
    assert.equal(r.revoke, false, `should not revoke for amount ${String(refund_amount)}`);
  }
});

test("refund decision: amount exceeding order must not revoke", () => {
  const r = cashfreeRefundDecision({
    eventType: "REFUND_STATUS",
    refund: refundPayload({ refund_amount: 9999 }),
    order: orderFixture,
  });
  assert.equal(r.revoke, false);
  assert.equal(r.reason, "refund_amount_exceeds_order");
});

test("refund decision: legacy REFUND_SUCCESS still revokes on valid payload", () => {
  assert.deepEqual(
    cashfreeRefundDecision({
      eventType: "REFUND_SUCCESS",
      refund: refundPayload(),
      order: orderFixture,
    }),
    { revoke: true }
  );
});

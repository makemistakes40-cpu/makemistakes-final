# Cashfree Sandbox — End-to-End Testing Procedure

Goal: exercise the Cashfree Payment Gateway integration end-to-end in **TEST / sandbox**
mode against the **dev database (`makemistakes_dev`)** only. No production credentials, no
production database, and no real money are ever involved.

> Run this procedure exactly as written. Do not skip the environment preflight in Step 0.
> Do not change payment implementation unless a concrete defect is reproduced.

---

## 0. Preflight (must pass before any test)

```powershell
node scripts/probe_env_cashfree.mjs
```

Assert all of the following:

| Probe output | Required value |
| --- | --- |
| `database_name` | `"makemistakes_dev"` (no trailing quote) |
| `mongo_host` | `makemistakes-cluster.ahafizj.mongodb.net` (Atlas dev SRV) |
| `cashfree_mode` | `TEST` |
| `cashfree_configured_overall` | `true` |

Additional safety check — confirm the target database is the dev database and refuse to
continue if it is anything else:

```powershell
node scripts/verify_dev_environment.mjs --allow-cloud-dev
```

Expected tail: `Development environment is isolated and healthy.`

**Abort here** if `cashfree_mode` is `PRODUCTION`, if the database name is anything other
than `makemistakes_dev`, or if `verify_dev_environment` fails.

---

## 1. Start the dev server

```powershell
npm run dev
```

Wait for the Next.js dev server to print its local address (typically
`http://localhost:3000`).

---

## 2. Create a signed-in test account (dev only)

Use the normal sign-up flow against the dev app, or reuse an existing dev test user.
You need a real session cookie because every payment API route requires an authenticated
session (`getAuthSession`).

Do **not** use a production/production account.

---

## 3. Create a Cashfree order (on `makemistakes_dev`)

Call the authenticated order-creation route:

```http
POST /api/payment/create-order
Content-Type: application/json
Cookie: <session-cookie>

{ "planId": "BUILDER" }
```

Assert the response:

- `success: true`
- `order.gateway === "CASHFREE"`
- `order.cashfreeMode === "TEST"`
- `order.paymentSessionId` is a non-empty string (the live checkout session id)
- `order.amount === 179900` (BUILDER in paise / ₹1799), `order.currency === "INR"`

> Note: BUILDER is ₹1799, which matches the target test amount. Plan `PRO` is
> configured at **₹3499** (`PLANS.PRO.price = 3499`); if you choose to test `PRO`,
> expect `order.amount === 349900` and use `payment_amount: 3499` in the webhook
> payloads below.

Record `order.orderId` and `order.gatewayOrderId` — they are needed for the verification
step.

---

## 4. Walk through the hosted checkout in the sandbox

Trigger checkout from the UI (or call the SDK directly). The frontend's `CheckoutModal`
loads the official **Cashfree JS SDK v3** and calls `cashfree.checkout({ paymentSessionId:
order.paymentSessionId, ... })`, with `mode: "sandbox"` for the TEST env. The SDK opens
Cashfree's test payment page. (The API does not expose a `checkoutUrl`; the payment session
id is the key to starting checkout.)

Use a **Cashfree sandbox test card** (obtain the current test card number from the Cashfree
dashboard / docs; the integration code does not hard-code any card data). Complete the
payment with:

- Mode: UPI / Card (whichever is enabled in your sandbox)
- Amount shown must be **₹1799.00** for the BUILDER plan

The payment will be a simulated sandbox transaction; no real money moves.

---

## 5. Server-side verification

After the checkout completes, call the Cashfree verification route with the recorded order:

```http
POST /api/payment/cashfree-verify
Content-Type: application/json
Cookie: <session-cookie>

{ "orderId": "<order.orderId>" }
```

Assert the response:

- `success: true`
- `alreadyProcessed: false` on first verification (true on a duplicate call — idempotency)
- `status === "ACTIVE"`
- `plan === "BUILDER"`
- `expiryDate` is ~30 days in the future
- `creditsGranted` matches the BUILDER plan credit allowance (28,500)
- `totalRemainingCredits` reflects the grant

The Cashfree branch resolves the real `cf_payment_id` from the Cashfree status API
(`getOrderPayments`) and verifies amount/currency match before activating.

---

## 6. Confirm the on-chain entitlements (dev DB)

Via the dev UI (or a dev-only script): after payment the user should have

- a `subscription` record with `plan = "BUILDER"`, `status = "ACTIVE"`, 30-day `expiryDate`;
- an `aiCreditBalance` with the granted credits;
- an `aiCreditTransaction` of type `PURCHASE_GRANT` for the order.

---

## 7. Webhook handling

Simulate the Cashfree webhook **as Cashfree would send it** (sign the raw body with the
Cashfree secret key using the documented formula):

```
signature = base64( HMAC_SHA256( secret, x-webhook-timestamp + rawBody ) )
```

Send the payment-success payload to:

```http
POST /api/payment/webhook
Content-Type: application/json
x-webhook-signature: <signature>
x-webhook-timestamp: <unix-seconds>

{ "type": "PAYMENT_SUCCESS_WEBHOOK", "data": { "order": { "order_id": "<gatewayOrderId>" }, "payment": { "cf_payment_id": "<cf_payment_id>", "payment_amount": 1799, "payment_currency": "INR" } } }
```

Assert:

- Signature verification passes and processing succeeds (idempotent; a duplicate is ignored).
- A tampered body or an invalid signature returns **400**.
- A stale timestamp (> 600s old) is rejected.

Also simulate the documented failure events and assert the order transitions to `FAILED`
only when it is still `CREATED`:

- `PAYMENT_FAILED_WEBHOOK`
- `PAYMENT_CANCELLED_WEBHOOK`
- `PAYMENT_USER_DROPPED_WEBHOOK`

---

## 8. Refund path

Simulate a full `REFUND_STATUS_WEBHOOK` with `refund_status: "SUCCESS"`, matching
`cf_payment_id` and a full `refund_amount` equal to the order total. Assert:

- `success: true`
- the order becomes `REFUNDED`
- the subscription downgrades to `FREE` / `REFUNDED`
- an `aiCreditTransaction` of type `REFUND_DEDUCT` is recorded, and credits are revoked
  exactly once.

Negative cases that must NOT revoke (each returns `success: true` with an ignore message):
partial refund amount, mismatched payment id, non-`SUCCESS` status, invalid/missing amount,
amount exceeding the order total.

---

## 9. Cleanup

- Delete or archive any dev-only test users/orders that a not needed.
- Stop the dev server.
- Verify no `PAYMENT`/`REFUNDED` artifacts exist in a production database (they cannot — the
  app only ever connects to `makemistakes_dev` per Step 0).

---

## Anything that fails

Capture the exact request, response, and the failing assertion. Only touch the payment
implementation if this procedure reproduces a real defect; otherwise report it first.

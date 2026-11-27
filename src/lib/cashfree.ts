import crypto from "crypto";
import dns from "dns";
import { Agent } from "undici";
import { getPlanConfig, type PlanTier } from "./plans";

/**
 * Search Free Payments Gateway (PG) v4 integration.
 *
 * Uses the official Cashfree v4 REST contract (the same contract wrapped by the
 * official `cashfree-pg` SDK). The SDK dependency is pinned in package.json; the
 * runtime here calls the documented endpoints directly via fetch, mirroring how
 * Razorpay is integrated in this codebase.
 */

// Cashfree supports two environments. Test/sandbox uses a distinct API host and
// hosted-checkout host from production.
export const CASHFREE_API_BASE = {
  TEST: "https://sandbox.cashfree.com/pg",
  PRODUCTION: "https://api.cashfree.com/pg",
} as const;

export const CASHFREE_CHECKOUT_HOST = {
  TEST: "https://payments-test.cashfree.com",
  PRODUCTION: "https://payments.cashfree.com",
} as const;

export type CashfreeEnv = keyof typeof CASHFREE_API_BASE;

export function getCashfreeEnv(env: NodeJS.ProcessEnv = process.env): CashfreeEnv {
  const mode = (env.CASHFREE_ENV || "").toUpperCase();
  return mode === "PRODUCTION" || mode === "PROD" ? "PRODUCTION" : "TEST";
}

export function isCashfreeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const appId = env.CASHFREE_APP_ID || "";
  const secret = env.CASHFREE_SECRET_KEY || "";
  return Boolean(appId && secret && !appId.includes("your-"));
}

/**
 * Fast IPv4-only DNS lookup for the Cashfree HTTP transport.
 *
 * This bypasses the OS resolver's `dns.lookup`/getaddrinfo path, which on
 * certain hosts blocks ~11s attempting an AAAA/IPv6 query before returning
 * IPv4 addresses. Undici's default connector uses that slow path, so the
 * `fetch` call hits its hard 10s connect timeout for Cashfree hosts. Using
 * `dns.resolve4` (c-ares, ~15ms) directly removes the delay. TLS verification
 * is untouched (only resolution is overridden).
 */
function fastIpv4Lookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number
  ) => void
): void {
  const wantAll = Boolean(options && typeof options === "object" && options.all);
  dns.resolve4(hostname, (err, addresses) => {
    if (err || !addresses || addresses.length === 0) {
      callback(err || new Error(`DNS lookup failed for ${hostname}`), "");
      return;
    }
    if (wantAll) {
      callback(null, addresses.map((ip) => ({ address: ip, family: 4 })));
    } else {
      callback(null, addresses[0], 4);
    }
  });
}

/** Dedicated transport shared by all Cashfree API calls. */
const cashfreeAgent = new Agent({
  connect: {
    lookup: fastIpv4Lookup,
  },
});

/** RequestInit extended with undici's dispatcher option (not in global types). */
type CashfreeRequestInit = RequestInit & { dispatcher: Agent };

export class CashfreeClient {
  private appId: string;
  private secretKey: string;
  private env: CashfreeEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.appId = env.CASHFREE_APP_ID || "";
    this.secretKey = env.CASHFREE_SECRET_KEY || "";
    this.env = getCashfreeEnv(env);
    if (!this.appId || !this.secretKey) {
      throw new Error("PAYMENT_UNAVAILABLE: Cashfree is not configured.");
    }
  }

  private baseUrl(): string {
    return CASHFREE_API_BASE[this.env];
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-version": "2023-08-01",
      "x-client-id": this.appId,
      "x-client-secret": this.secretKey,
    };
  }

  /**
   * Create a Cashfree order. Amount is passed in paise; Cashfree expects INR.
   * Returns the order object including order_id, payment_session_id and link.
   */
  async createOrder(params: {
    orderId: string;
    amount: number; // paise
    customer: { email: string; name?: string; phone?: string; customerId: string };
    note?: string;
  }): Promise<{ order_id: string; payment_session_id: string; link?: string; order_status?: string }> {
    const res = await fetch(`${this.baseUrl()}/orders`, {
      method: "POST",
      headers: this.headers(),
      dispatcher: cashfreeAgent,
      body: JSON.stringify({
        order_id: params.orderId,
        order_amount: Math.round(params.amount / 100),
        order_currency: "INR",
        order_note: params.note,
        customer_details: {
          customer_id: params.customer.customerId,
          customer_email: params.customer.email,
          customer_name: params.customer.name,
          customer_phone: params.customer.phone,
        },
      }),
    } as CashfreeRequestInit);

    if (!res.ok) {
      console.error("[Cashfree] Order creation failed:", res.status);
      throw new Error("PAYMENT_UNAVAILABLE: Unable to create a Cashfree order.");
    }
    const data = await res.json();
    if (typeof data.order_id !== "string" || typeof data.payment_session_id !== "string") {
      throw new Error("PAYMENT_UNAVAILABLE: Cashfree order response was invalid.");
    }
    return data;
  }

  /**
   * Fetch the list of payments attempted for an order (server-side verification).
   */
  async getOrderPayments(orderId: string): Promise<
    Array<{
      cf_payment_id: string;
      payment_status: string;
      payment_amount: number;
      payment_currency: string;
      payment_time?: string;
    }>
  > {
    const res = await fetch(`${this.baseUrl()}/orders/${encodeURIComponent(orderId)}/payments`, {
      method: "GET",
      headers: this.headers(),
      dispatcher: cashfreeAgent,
    } as CashfreeRequestInit);
    // TEMP DIAGNOSTIC: HTTP status + sanitized payment summary (no secrets/PII).
    if (!res.ok) {
      console.warn(
        `[Cashfree-DIAG] getOrderPayments HTTP ${res.status} for order ${orderId}`
      );
      throw new Error("PAYMENT_UNVERIFIED: Cashfree could not confirm the payment.");
    }
    const data = await res.json();
    const isArray = Array.isArray(data);
    if (!isArray && data && typeof data === "object") {
      console.warn(
        `[Cashfree-DIAG] getOrderPayments HTTP ${res.status} non-array ` +
          `topLevelKeys=${Object.keys(data).join(",")}`
      );
    }
    const payments = isArray ? data : [];
    for (const p of payments) {
      console.warn(
        `[Cashfree-DIAG] order ${orderId} payment cf_id=${p?.cf_payment_id ?? ""} ` +
          `status=${p?.payment_status ?? ""} amount=${p?.payment_amount ?? ""} ` +
          `currency=${p?.payment_currency ?? ""}`
      );
    }
    console.warn(
      `[Cashfree-DIAG] getOrderPayments HTTP ${res.status} OK; ${payments.length} payment(s)`
    );
    return payments;
  }
}

/**
 * Cashfree webhook signature verification.
 *
 * Cashfree signs webhooks with an HMAC-SHA256 (base64) over the direct
 * concatenation of `x-webhook-timestamp` and the raw request body:
 *   signature = base64(HMAC_SHA256(secret, timestamp + rawBody))
 * The signing secret is the API Secret Key (`CASHFREE_SECRET_KEY`); there is no
 * separate webhook secret. We also reject stale payloads (replay protection) using
 * the timestamp header, keeping a configurable window so legitimate delayed
 * deliveries are not rejected.
 */
export function verifyCashfreeWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
  timestamp?: string,
  maxAgeSeconds: number = 600
): boolean {
  if (!secret || !signature) return false;
  const ts = timestamp ? Number(timestamp) : Number.NaN;
  if (timestamp && !Number.isFinite(ts)) return false;
  if (Number.isFinite(ts)) {
    const age = Math.abs(Date.now() / 1000 - ts);
    if (age > maxAgeSeconds) return false;
  }
  // Cashfree signs the concatenation of timestamp and raw body (no separator).
  const data = timestamp ? `${timestamp}${rawBody}` : rawBody;
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Map an approved plan id to its paid tier (reject FREE). */
export function resolvePaidPlan(planId: string): PlanTier | null {
  const config = getPlanConfig(planId);
  if (!config || config.id === "FREE") return null;
  return config.id;
}

/**
 * Validate a successful Cashfree payment payload against the stored order.
 * The order amount is stored in paise; Cashfree reports payment_amount in INR
 * (possibly with paise decimals). Compare in exact paise precision without
 * rounding the order amount. Reject missing, non-numeric, non-finite,
 * negative, or otherwise invalid amounts, and require an exact currency match.
 */
export function cashfreeSuccessMatchesOrder(
  payment: { payment_amount?: unknown; payment_currency?: unknown },
  order: { amount: number; currency: string }
): boolean {
  const amount = payment.payment_amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    return false;
  }
  // Convert the reported INR amount to exact paise and compare to the stored paise amount.
  return (
    Math.round(amount * 100) === order.amount &&
    payment.payment_currency === order.currency
  );
}

/**
 * Normalize a Cashfree webhook event type to its canonical form.
 *
 * Current official Cashfree Payment Gateway webhook documentation names events
 * with a "_WEBHOOK" suffix (e.g. PAYMENT_SUCCESS_WEBHOOK,
 * PAYMENT_FAILED_WEBHOOK, PAYMENT_CANCELLED_WEBHOOK, REFUND_SUCCESS_WEBHOOK).
 * Older payloads use the unsuffixed forms (PAYMENT_SUCCESS, PAYMENT_FAILED,
 * PAYMENT_CANCELLED, REFUND_SUCCESS). We accept both by stripping an optional
 * trailing "_WEBHOOK". Unknown/unrecognized types are returned unchanged.
 */
export function normalizeCashfreeEventType(raw: string): string {
  return raw.replace(/_WEBHOOK$/, "");
}

/**
 * Decide whether a Cashfree refund event should revoke access/credits.
 *
 * Only a successfully completed refund (status SUCCESS, or the legacy
 * REFUND_SUCCESS event) may revoke. Identity and amount are validated before
 * any revocation: missing or mismatched required data is treated as "do not
 * revoke" rather than an error, and only a confirmed successful FULL refund
 * (amount === order total) may revoke; partial refunds are explicitly ignored
 * until proportional credit deductions are supported by the accounting model.
 *
 * Returns { revoke: true } to proceed, or { revoke: false, reason } to skip.
 */
export function cashfreeRefundDecision(opts: {
  eventType: string;
  refund: Record<string, unknown>;
  order: { amount: number; gatewayPaymentId?: string | null };
}): { revoke: boolean; reason?: string } {
  const { eventType, refund, order } = opts;

  // Only a REFUND_STATUS event carries a status field; the legacy REFUND_SUCCESS
  // event is by definition a completed refund.
  const status =
    eventType === "REFUND_STATUS"
      ? String(refund?.refund_status ?? refund?.status ?? "").toUpperCase()
      : "SUCCESS";
  if (status !== "SUCCESS") {
    return { revoke: false, reason: `refund_status=${status || "missing"}` };
  }

  // Refund identity: if we store a payment id, the refund must reference it.
  const refundPaymentId = (refund?.cf_payment_id ?? refund?.payment_id) as
    | string
    | undefined;
  if (!refundPaymentId) {
    return { revoke: false, reason: "refund_payment_id_missing" };
  }
  if (order.gatewayPaymentId && refundPaymentId !== order.gatewayPaymentId) {
    return { revoke: false, reason: "refund_payment_id_mismatch" };
  }

  // Refund amount: Cashfree sends rupees (e.g. 1799.00); order.amount is
  // stored in paise. Convert to paise for comparison, require a finite,
  // non-negative value, and allow partial refunds (amount <= order total).
  const refundAmount = Number(refund?.refund_amount);
  if (!Number.isFinite(refundAmount) || refundAmount < 0) {
    return { revoke: false, reason: "refund_amount_invalid" };
  }
  const refundPaise = Math.round(refundAmount * 100);
  if (refundPaise > order.amount) {
    return { revoke: false, reason: "refund_amount_exceeds_order" };
  }

  if (refundPaise < order.amount) {
    return { revoke: false, reason: "partial_refund_not_supported" };
  }

  return { revoke: true };
}

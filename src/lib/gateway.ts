/**
 * Lightweight gateway-identification helpers (no DB / no app dependencies).
 * Kept tiny so tests can import it without initializing Prisma or the full
 * payment module.
 */

export type GatewayKind = "CASHFREE" | "RAZORPAY";

/**
 * Resolve which gateway a webhook belongs to. An explicit gateway (from the
 * route's header) always wins; otherwise we fall back to the legacy heuristic:
 * Razorpay signatures are 64 lowercase hex chars, Cashfree signatures are
 * base64 (so they are never exactly 64 hex chars).
 */
export function resolveWebhookGateway(gateway: GatewayKind | undefined, signature: string): GatewayKind {
  if (gateway) return gateway;
  return signature.length > 0 && !/^[\da-f]{64}$/i.test(signature) ? "CASHFREE" : "RAZORPAY";
}

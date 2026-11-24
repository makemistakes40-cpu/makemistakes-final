import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/authSession";
import { PaymentService } from "@/lib/paymentService";

export const runtime = "nodejs";

/**
 * Verify a Cashfree hosted-checkout order server-side. Unlike the Razorpay flow,
 * Cashfree's hosted checkout does not hand the browser a client-side signature, so
 * verification is performed by querying Cashfree's payment status API for the order.
 */
export async function POST(req: Request) {
  try {
    const session = await getAuthSession(req);
    if (!session || !session.userId) {
      return NextResponse.json(
        { success: false, error: "UNAUTHORIZED", message: "You must be logged in." },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { orderId } = body;
    if (!orderId) {
      return NextResponse.json(
        { success: false, error: "BAD_REQUEST", message: "orderId is required." },
        { status: 400 }
      );
    }

    // Cashfree verification needs no client-side signature. The real gateway
    // payment id (cf_payment_id) is resolved from the Cashfree status API inside
    // verifyPayment and stored on activation; the placeholders below are unused
    // by the Cashfree branch.
    const result = await PaymentService.verifyPayment({
      session,
      orderId,
      gatewayPaymentId: "PENDING",
      gatewaySignature: "server-side",
    });

    return NextResponse.json(result);
  } catch (err: unknown) {
    const code = err instanceof Error ? err.message : "";
    console.error("[Cashfree Verify Error]:", code.split(":")[0] || "UNKNOWN");
    const status = code.includes("UNAUTHORIZED")
      ? 401
      : code.includes("FORBIDDEN")
      ? 403
      : code.includes("PAYMENT_UNVERIFIED")
      ? 402
      : code.includes("ORDER_NOT_FOUND")
      ? 404
      : code.includes("INVALID_PAYMENT") || code.includes("BAD_REQUEST")
      ? 400
      : code.includes("PAYMENT_UNAVAILABLE")
      ? 503
      : 500;
    return NextResponse.json(
      {
        success: false,
        error: code.includes("PAYMENT_UNVERIFIED")
          ? "Payment has not been confirmed as captured."
          : "Payment verification failed.",
      },
      { status }
    );
  }
}

import { NextResponse } from "next/server";
import { PaymentService } from "@/lib/paymentService";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signature =
      req.headers.get("x-webhook-signature") ||
      req.headers.get("x-razorpay-signature") ||
      req.headers.get("x-signature") ||
      "";
    const timestamp = req.headers.get("x-webhook-timestamp") || undefined;

    // Identify the gateway explicitly from the header that was used to sign the
    // webhook, so we never rely on fingerprinting the signature value alone.
    const gateway =
      req.headers.get("x-webhook-signature")
        ? "CASHFREE"
        : req.headers.get("x-razorpay-signature")
        ? "RAZORPAY"
        : undefined;

    if (!signature) {
      return NextResponse.json(
        { success: false, error: "Missing webhook signature header" },
        { status: 400 }
      );
    }

    const result = await PaymentService.processWebhook({ rawBody, signature, timestamp, gateway });
    return NextResponse.json(result);
  } catch (err: unknown) {
    const code = err instanceof Error ? err.message : "";
    console.error("[Webhook Error]:", code.split(":")[0] || "UNKNOWN");
    const status = code.includes("INVALID_WEBHOOK_SIGNATURE") || code.includes("INVALID_WEBHOOK")
      ? 400
      : code.includes("PAYMENT_UNAVAILABLE")
      ? 503
      : 500;
    return NextResponse.json(
      { success: false, error: "Webhook processing failed" },
      { status }
    );
  }
}

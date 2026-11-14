import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { getAuthenticatedIdentity } from "@/lib/security/sessionIdentity";
import { getEffectivePricingConfig } from "@/lib/nova/pricingConfig";
import { isUserAdmin, updatePricingConfig } from "@/lib/nova/adminControls";

export const runtime = "nodejs";

/**
 * GET — Retrieve current effective pricing configuration and model rates
 * Requires admin authorization.
 */
export async function GET(req: Request) {
  try {
    const identity = await getAuthenticatedIdentity(req);
    if (!identity?.session?.userId) {
      return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
    }

    if (!isUserAdmin(identity.session)) {
      return NextResponse.json({ ok: false, error: "Forbidden: Admin authorization required" }, { status: 403 });
    }

    const db = await getDb();
    const config = await getEffectivePricingConfig(db);
    return NextResponse.json({ ok: true, config });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message || "Could not fetch pricing config" }, { status: 500 });
  }
}

/**
 * POST — Update pricing configuration, tier allocations, model pricing, or emergency disable switches
 * Requires admin authorization. Strictly validates all pricing inputs.
 */
export async function POST(req: Request) {
  try {
    const identity = await getAuthenticatedIdentity(req);
    if (!identity?.session?.userId) {
      return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
    }

    if (!isUserAdmin(identity.session)) {
      return NextResponse.json({ ok: false, error: "Forbidden: Admin authorization required" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const db = await getDb();

    const updated = await updatePricingConfig(db, {
      ...body,
      updatedBy: identity.primaryUserId || identity.session.userId,
    });

    return NextResponse.json({ ok: true, config: updated });
  } catch (err: any) {
    const status = typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
      ? err.status
      : 500;
    return NextResponse.json({ ok: false, error: err.message || "Could not update pricing config" }, { status });
  }
}

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { getAuthenticatedIdentity } from "@/lib/security/sessionIdentity";
import { getNovaUsageAnalytics } from "@/lib/nova/analytics";
import { isUserAdmin } from "@/lib/nova/adminControls";

export const runtime = "nodejs";

/**
 * GET — Retrieve aggregated AI usage analytics
 * Requires admin authorization. Does not expose financial analytics to ordinary users.
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

    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId") || undefined;
    const fromStr = searchParams.get("from");
    const toStr = searchParams.get("to");

    const startDate = fromStr ? new Date(fromStr) : undefined;
    const endDate = toStr ? new Date(toStr) : undefined;

    const db = await getDb();
    const analytics = await getNovaUsageAnalytics(db, {
      userId,
      startDate,
      endDate,
    });

    return NextResponse.json({ ok: true, analytics });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message || "Could not fetch usage analytics" }, { status: 500 });
  }
}

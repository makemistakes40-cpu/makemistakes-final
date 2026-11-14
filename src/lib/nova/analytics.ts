import type { Db } from "mongodb";

export interface NovaUsageAnalyticsSummary {
  totalExpenditureInr: number;
  totalExpenditureUsd: number;
  totalCreditsConsumed: number;
  totalRequests: number;
  averageCostPerRequestInr: number;
  usageByProvider: Array<{ provider: string; model: string; count: number; costInr: number; credits: number }>;
  usageByTier: Array<{ tier: string; count: number; costInr: number; credits: number }>;
  usageByPhase: Array<{ phase: string; count: number; costInr: number; credits: number }>;
  failedRequestsCount: number;
  releasedReservationsCount: number;
}

/**
 * Aggregates platform-wide and segmented AI usage analytics.
 * Clearly separates actual provider expenditure from credit units.
 */
export async function getNovaUsageAnalytics(
  db: Db,
  filter: { startDate?: Date; endDate?: Date; userId?: string } = {}
): Promise<NovaUsageAnalyticsSummary> {
  const match: Record<string, any> = {};
  if (filter.userId) match.userId = filter.userId;
  if (filter.startDate || filter.endDate) {
    match.timestamp = {};
    if (filter.startDate) match.timestamp.$gte = filter.startDate;
    if (filter.endDate) match.timestamp.$lte = filter.endDate;
  }

  const [usageStats] = await db
    .collection("nova_ai_usage_events")
    .aggregate<{
      totalInr: number;
      totalUsd: number;
      totalCredits: number;
      totalRequests: number;
      failedCount: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: null,
          totalInr: { $sum: "$actualCostInr" },
          totalUsd: { $sum: "$actualCostUsd" },
          totalCredits: { $sum: "$novaCreditsCharged" },
          totalRequests: { $sum: 1 },
          failedCount: {
            $sum: { $cond: [{ $eq: ["$executionStatus", "FAILED"] }, 1, 0] },
          },
        },
      },
    ])
    .toArray();

  const providerBreakdown = await db
    .collection("nova_ai_usage_events")
    .aggregate<{
      _id: { provider: string; model: string };
      count: number;
      costInr: number;
      credits: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: { provider: "$provider", model: "$model" },
          count: { $sum: 1 },
          costInr: { $sum: "$actualCostInr" },
          credits: { $sum: "$novaCreditsCharged" },
        },
      },
      { $sort: { costInr: -1 } },
    ])
    .toArray();

  const phaseBreakdown = await db
    .collection("nova_ai_usage_events")
    .aggregate<{
      _id: string;
      count: number;
      costInr: number;
      credits: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: "$buildosPhase",
          count: { $sum: 1 },
          costInr: { $sum: "$actualCostInr" },
          credits: { $sum: "$novaCreditsCharged" },
        },
      },
      { $sort: { count: -1 } },
    ])
    .toArray();

  const releasedReservations = await db
    .collection("nova_credit_reservations")
    .countDocuments({
      status: "RELEASED",
      ...(filter.userId ? { userId: filter.userId } : {}),
    });

  const totalReqs = usageStats?.totalRequests || 0;
  const totalInr = usageStats?.totalInr || 0;

  return {
    totalExpenditureInr: totalInr,
    totalExpenditureUsd: usageStats?.totalUsd || 0,
    totalCreditsConsumed: usageStats?.totalCredits || 0,
    totalRequests: totalReqs,
    averageCostPerRequestInr: totalReqs > 0 ? totalInr / totalReqs : 0,
    usageByProvider: providerBreakdown.map((b) => ({
      provider: b._id?.provider || "unknown",
      model: b._id?.model || "unknown",
      count: b.count,
      costInr: b.costInr,
      credits: b.credits,
    })),
    usageByTier: [],
    usageByPhase: phaseBreakdown.map((b) => ({
      phase: b._id || "general",
      count: b.count,
      costInr: b.costInr,
      credits: b.credits,
    })),
    failedRequestsCount: usageStats?.failedCount || 0,
    releasedReservationsCount: releasedReservations,
  };
}


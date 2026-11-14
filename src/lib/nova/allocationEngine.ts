import type { Db } from "mongodb";
import { getEffectivePricingConfig, type NovaPricingConfig } from "./pricingConfig";

export type SubscriptionTier = "FREE" | "BUILDER" | "PRO";

export interface NovaWalletDocument {
  userId: string;
  tier: SubscriptionTier;
  dailyAllowance: number;
  dailyRemaining: number;
  dailyUsed: number;
  lastDailyAllocationAt: Date;
  nextDailyResetAt: Date;
  monthlyCeiling: number;
  monthlyUsed: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  reservedCredits: number;
  reservedMonthlyCredits: number;
  unbilledOverage: number;
  subscriptionOrderId?: string;
  isPaidActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const WALLET_COLLECTION = "nova_user_wallets";

/**
 * Calculates rolling 24-hour cycle boundaries.
 */
export function computeRollingCycles(
  lastAllocationAt: Date,
  now: Date,
  windowHours = 24
): { cyclesElapsed: number; newAllocationAt: Date; nextResetAt: Date } {
  const windowMs = windowHours * 60 * 60 * 1000;
  const elapsedMs = Math.max(0, now.getTime() - lastAllocationAt.getTime());
  const cyclesElapsed = Math.floor(elapsedMs / windowMs);

  if (cyclesElapsed <= 0) {
    return {
      cyclesElapsed: 0,
      newAllocationAt: lastAllocationAt,
      nextResetAt: new Date(lastAllocationAt.getTime() + windowMs),
    };
  }

  const newAllocationTime = lastAllocationAt.getTime() + cyclesElapsed * windowMs;
  return {
    cyclesElapsed,
    newAllocationAt: new Date(newAllocationTime),
    nextResetAt: new Date(newAllocationTime + windowMs),
  };
}

/**
 * Reconciles and returns the user's Nova wallet.
 * Lazily evaluates rolling 24-hour reset, expires unused daily credits, and enforces monthly caps.
 * Concurrency-safe: uses atomic MongoDB findOneAndUpdate with condition matching.
 */
export async function reconcileAndGetWallet(
  db: Db,
  userId: string,
  userSubscription?: { plan?: string; status?: string; expiryDate?: Date | null; orderId?: string }
): Promise<NovaWalletDocument> {
  const config = await getEffectivePricingConfig(db);
  const now = new Date();

  // Normalize subscription tier
  const hasSubInfo = Boolean(userSubscription);
  const rawPlan = (userSubscription?.plan || "FREE").toUpperCase();
  const isPaidExplicit =
    (rawPlan === "BUILDER" || rawPlan === "PRO" || rawPlan === "MAX") &&
    userSubscription?.status === "ACTIVE" &&
    (!userSubscription.expiryDate || new Date(userSubscription.expiryDate) > now);

  const explicitTier: SubscriptionTier = isPaidExplicit
    ? rawPlan === "PRO" || rawPlan === "MAX"
      ? "PRO"
      : "BUILDER"
    : "FREE";

  const collection = db.collection<NovaWalletDocument>(WALLET_COLLECTION);

  // 1. Fetch or initialize wallet
  let wallet = await collection.findOne({ userId });

  const tier = hasSubInfo ? explicitTier : wallet ? wallet.tier : explicitTier;
  const isPaid = hasSubInfo ? isPaidExplicit : wallet ? wallet.isPaidActive : isPaidExplicit;
  const tierConfig = config.tierAllocations[tier] || config.tierAllocations.FREE;

  if (!wallet) {
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const nextReset = new Date(now.getTime() + tierConfig.rollingWindowHours * 60 * 60 * 1000);

    const initial: NovaWalletDocument = {
      userId,
      tier,
      dailyAllowance: tierConfig.dailyAllocation,
      dailyRemaining: tierConfig.dailyAllocation,
      dailyUsed: 0,
      lastDailyAllocationAt: now,
      nextDailyResetAt: nextReset,
      monthlyCeiling: tierConfig.monthlyAllocation,
      monthlyUsed: 0,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      reservedCredits: 0,
      reservedMonthlyCredits: 0,
      unbilledOverage: 0,
      subscriptionOrderId: userSubscription?.orderId,
      isPaidActive: isPaid,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await collection.insertOne(initial);
      return initial;
    } catch (err: any) {
      if (err?.code === 11000) {
        wallet = await collection.findOne({ userId });
      } else {
        throw err;
      }
    }
  }

  if (!wallet) {
    throw new Error(`Failed to initialize or load wallet for ${userId}`);
  }

  // 1b. Backfill accounting fields for wallets created before Phase 2.2.
  // Pre-2.2 wallets lack `reservedMonthlyCredits` and may lack `unbilledOverage`.
  // Populate them from the wallet's outstanding reservations so that existing holds are
  // included in monthly capacity and decrements never create negative balances.
  if (typeof wallet.reservedMonthlyCredits !== "number") {
    const outstandingReservations = db
      .collection("nova_credit_reservations")
      .find({ userId, status: { $in: ["RESERVED", "SETTLING"] } });
    const outstandingList = await outstandingReservations.toArray();
    const outstandingHoldSum = outstandingList.reduce(
      (sum, r) => sum + (r.estimatedCredits || 0),
      0
    );

    const backfilled = await collection.findOneAndUpdate(
      { userId },
      {
        $set: {
          reservedMonthlyCredits: outstandingHoldSum,
          unbilledOverage: wallet.unbilledOverage || 0,
        },
      },
      { returnDocument: "after" }
    );
    if (backfilled) {
      wallet = backfilled;
    }
  }

  // 2. Check for tier upgrade / downgrade or subscription status change
  // Tier changes must NOT reset the allocation-cycle anchor and must NOT grant a second
  // daily allowance. We adjust the remaining daily capacity against already-consumed usage
  // in the current cycle and preserve monthly usage and all cycle timestamps.
  const tierChanged = wallet.tier !== tier || wallet.isPaidActive !== isPaid;
  if (tierChanged) {
    const monthlyRemaining = Math.max(0, tierConfig.monthlyAllocation - wallet.monthlyUsed);
    const newDailyCapacity = tierConfig.dailyAllocation;
    const usedThisCycle = wallet.dailyUsed || 0;
    // Preserve consumed usage: new remaining = clamp(capacity - used, 0, monthlyRemaining).
    const newDailyRemaining = Math.max(0, Math.min(newDailyCapacity - usedThisCycle, monthlyRemaining));

    const updated = await collection.findOneAndUpdate(
      { userId, tier: wallet.tier },
      {
        $set: {
          tier,
          dailyAllowance: newDailyCapacity,
          dailyRemaining: newDailyRemaining,
          monthlyCeiling: tierConfig.monthlyAllocation,
          isPaidActive: isPaid,
          subscriptionOrderId: userSubscription?.orderId,
          updatedAt: now,
        },
      },
      { returnDocument: "after" }
    );
    if (updated) {
      wallet = updated;
    }
  }

  // 3. Check for Monthly Period Reset (30 days expired)
  if (now > new Date(wallet.currentPeriodEnd)) {
    const newPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const reset = await collection.findOneAndUpdate(
      { userId, currentPeriodEnd: wallet.currentPeriodEnd },
      {
        $set: {
          monthlyUsed: 0,
          currentPeriodStart: now,
          currentPeriodEnd: newPeriodEnd,
          updatedAt: now,
        },
      },
      { returnDocument: "after" }
    );
    if (reset) wallet = reset;
  }

  // 4. Check for Rolling 24-Hour Daily Reset
  const lastAlloc = new Date(wallet.lastDailyAllocationAt);
  const { cyclesElapsed, newAllocationAt, nextResetAt } = computeRollingCycles(
    lastAlloc,
    now,
    tierConfig.rollingWindowHours
  );

  if (cyclesElapsed > 0) {
    // Unused credits from previous day expire (no rollover). Old-cycle reservation holds are
    // dropped so they no longer reduce the new cycle's available daily credits.
    const monthlyRemaining = Math.max(0, wallet.monthlyCeiling - wallet.monthlyUsed);
    const replenishedDaily = Math.min(tierConfig.dailyAllocation, monthlyRemaining);

    // Reconcile outstanding unbilled overage against the fresh daily allowance exactly once.
    // overageApplied = min(newDailyCapacity, existingUnbilledOverage)
    // newUnbilledOverage = existingUnbilledOverage - overageApplied
    // dailyRemaining = newDailyCapacity - overageApplied
    const existingOverage = wallet.unbilledOverage || 0;
    const overageApplied = Math.min(replenishedDaily, existingOverage);
    const newOverage = existingOverage - overageApplied;
    const effectiveDaily = replenishedDaily - overageApplied;

    // Concurrency-safe atomic conditional update matching lastDailyAllocationAt. Because we
    // match the previous anchor and derive newOverage from the pre-reset document, only one
    // concurrent worker can apply the overage deduction (idempotent).
    const updated = await collection.findOneAndUpdate(
      {
        userId,
        lastDailyAllocationAt: wallet.lastDailyAllocationAt,
      },
      {
        $set: {
          dailyRemaining: effectiveDaily,
          dailyUsed: 0,
          unbilledOverage: newOverage,
          reservedCredits: 0, // reset current-cycle reservation pool
          lastDailyAllocationAt: newAllocationAt,
          nextDailyResetAt: nextResetAt,
          updatedAt: now,
        },
      },
      { returnDocument: "after" }
    );

    if (updated) {
      wallet = updated;
    } else {
      // Parallel request updated it first; re-fetch the reconciled doc
      const fresh = await collection.findOne({ userId });
      if (fresh) wallet = fresh;
    }
  }

  return wallet;
}

import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { reconcileAndGetWallet, type NovaWalletDocument } from "./allocationEngine";
import {
  calculateActualCostAndCredits,
  getEffectivePricingConfig,
  type CostAndCreditResult,
  type TokenUsageCounts,
} from "./pricingConfig";
import { recordNovaUsageEvent, type NovaUsageEvent } from "./metering";

export interface NovaReservationDocument {
  _id?: string;
  reservationId: string;
  userId: string;
  conversationId: string;
  problemId?: string;
  estimatedCredits: number;
  allocationCycleAt?: Date;
  status: "RESERVED" | "SETTLING" | "SETTLED" | "RELEASED" | "EXPIRED";
  actualCreditsCharged?: number;
  overageCredits?: number;
  deductedDailyCredits?: number;
  walletDeducted?: boolean;
  provider?: string;
  model?: string;
  tokens?: TokenUsageCounts;
  createdAt: Date;
  expiresAt: Date;
  settlingAt?: Date;
  settledAt?: Date;
  releasedAt?: Date;
  settlementError?: string;
  lastProviderResponseAt?: Date;
}

export interface NovaDeductionReceiptDocument {
  _id: string; // reservationId
  reservationId: string;
  userId: string;
  actualCreditsCharged: number;
  deductedDailyCredits: number;
  overageCredits: number;
  estimatedCredits: number;
  createdAt: Date;
}

const RESERVATION_COLLECTION = "nova_credit_reservations";
const WALLET_COLLECTION = "nova_user_wallets";
const DEDUCTION_RECEIPTS_COLLECTION = "nova_wallet_deduction_receipts";

/**
 * Determines whether a reservation belongs to the wallet's current daily allocation cycle.
 *
 * Backward compatibility:
 * - Reservations created after Phase 2.2 carry an explicit `allocationCycleAt` snapshot.
 * - Legacy reservations (no `allocationCycleAt`) are inferred from their `createdAt`:
 *   if the reservation was created inside the current cycle window it is treated as a
 *   same-cycle reservation (so its daily usage is charged); otherwise it is treated as an
 *   old-cycle reservation (so it never consumes the current day's allowance).
 */
export function isCurrentCycle(
  wallet: NovaWalletDocument | null | undefined,
  reservation: NovaReservationDocument
): boolean {
  if (!wallet) {
    return false;
  }
  const walletAnchor = new Date(wallet.lastDailyAllocationAt).getTime();

  if (reservation.allocationCycleAt) {
    return new Date(reservation.allocationCycleAt).getTime() === walletAnchor;
  }

  if (reservation.createdAt) {
    const created = new Date(reservation.createdAt).getTime();
    const nextReset = wallet.nextDailyResetAt
      ? new Date(wallet.nextDailyResetAt).getTime()
      : Number.POSITIVE_INFINITY;
    return created >= walletAnchor && created < nextReset;
  }

  return false;
}

/**
 * Backfills the Phase 2.2 accounting fields (`reservedMonthlyCredits`, `unbilledOverage`)
 * on wallets created before Phase 2.2. `reservedMonthlyCredits` is derived from the user's
 * outstanding reservations so existing holds are included in monthly capacity and decrements
 * never create negative balances. No-op for wallets that already carry the fields.
 */
async function ensureWalletAccountingFields(
  db: Db,
  wallet: NovaWalletDocument | null | undefined
): Promise<NovaWalletDocument | null | undefined> {
  if (!wallet || typeof wallet.reservedMonthlyCredits === "number") {
    return wallet;
  }

  const reservations = db.collection<NovaReservationDocument>(RESERVATION_COLLECTION);
  const outstanding = await reservations
    .find({ userId: wallet.userId, status: { $in: ["RESERVED", "SETTLING"] } })
    .toArray();
  const holdSum = outstanding.reduce((sum, r) => sum + (r.estimatedCredits || 0), 0);

  const updated = await db
    .collection<NovaWalletDocument>(WALLET_COLLECTION)
    .findOneAndUpdate(
      { userId: wallet.userId },
      {
        $set: {
          reservedMonthlyCredits: holdSum,
          unbilledOverage: wallet.unbilledOverage || 0,
        },
      },
      { returnDocument: "after" }
    );

  return updated || wallet;
}

/**
 * Verifies whether the MongoDB client topology supports multi-document transactions.
 * Transactions require a replica set or sharded cluster (e.g. MongoDB Atlas).
 * Standalone servers ("Single") cannot execute multi-document transactions.
 * Fail-closed policy: returns false if client is missing, startSession is not a function,
 * topology description is missing, or topology type is unknown/unsupported.
 */
export function isClientTransactionCapable(client: any): boolean {
  if (!client || typeof client.startSession !== "function") {
    return false;
  }
  const topologyType = client.topology?.description?.type;
  if (!topologyType) {
    return false;
  }
  return (
    topologyType === "ReplicaSetWithPrimary" ||
    topologyType === "Sharded" ||
    topologyType === "LoadBalanced"
  );
}

export interface ReserveCreditsParams {
  userId: string;
  conversationId: string;
  problemId?: string;
  estimatedCredits?: number;
  userSubscription?: { plan?: string; status?: string; expiryDate?: Date | null; orderId?: string };
}

export interface ReserveCreditsResult {
  success: boolean;
  reservationId?: string;
  estimatedCredits?: number;
  availableDailyCredits?: number;
  reason?: "INSUFFICIENT_CREDITS" | "WALLET_ERROR";
  message?: string;
}

/**
 * Stage A: Credit Reservation
 * Atomically checks allowance and locks estimated credits prior to calling any AI provider.
 */
export async function reserveCredits(
  db: Db,
  params: ReserveCreditsParams
): Promise<ReserveCreditsResult> {
  const { userId, conversationId, problemId } = params;
  const estimatedCredits = Math.max(1, params.estimatedCredits ?? 5);

  // Sweep stale reservations for this user before evaluating availability so expired holds
  // cannot artificially reduce capacity (P1-3). Best-effort; never blocks reservation.
  try {
    await expireStaleReservations(db, { userId });
  } catch {
    // non-blocking
  }

  const wallet = await reconcileAndGetWallet(db, userId, params.userSubscription);
  const unbilledOverage = wallet.unbilledOverage || 0;
  const availableDaily = wallet.dailyRemaining - unbilledOverage - wallet.reservedCredits;
  const availableMonthly = wallet.monthlyCeiling - wallet.monthlyUsed - wallet.reservedMonthlyCredits;

  if (availableDaily < estimatedCredits || availableMonthly < estimatedCredits) {
    return {
      success: false,
      reason: "INSUFFICIENT_CREDITS",
      availableDailyCredits: Math.max(0, availableDaily),
      message: "Insufficient daily AI credits. Please wait for the daily reset or upgrade your plan.",
    };
  }

  const reservationId = `res_${randomUUID()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5-minute timeout window
  const allocationCycleAt = wallet.lastDailyAllocationAt;

  // Atomically increment daily + monthly reservation pools if sufficient capacity remains.
  // Uses $ifNull so pre-existing wallets lacking the new fields do not null-gate the guard.
  const updateResult = await db.collection<NovaWalletDocument>(WALLET_COLLECTION).updateOne(
    {
      userId,
      $expr: {
        $and: [
          {
            $gte: [
              {
                $subtract: [
                  "$dailyRemaining",
                  { $add: [{ $ifNull: ["$reservedCredits", 0] }, { $ifNull: ["$unbilledOverage", 0] }] },
                ],
              },
              estimatedCredits,
            ],
          },
          {
            $gte: [
              {
                $subtract: [
                  "$monthlyCeiling",
                  { $add: [{ $ifNull: ["$monthlyUsed", 0] }, { $ifNull: ["$reservedMonthlyCredits", 0] }] },
                ],
              },
              estimatedCredits,
            ],
          },
        ],
      },
    },
    {
      $inc: { reservedCredits: estimatedCredits, reservedMonthlyCredits: estimatedCredits },
      $set: { updatedAt: now },
    }
  );

  if (updateResult.matchedCount !== 1) {
    return {
      success: false,
      reason: "INSUFFICIENT_CREDITS",
      availableDailyCredits: Math.max(0, availableDaily),
      message: "Concurrent requests exhausted remaining credit allowance.",
    };
  }

  await db.collection<NovaReservationDocument>(RESERVATION_COLLECTION).insertOne({
    reservationId,
    userId,
    conversationId,
    problemId,
    estimatedCredits,
    allocationCycleAt,
    status: "RESERVED",
    createdAt: now,
    expiresAt,
  });

  return {
    success: true,
    reservationId,
    estimatedCredits,
    availableDailyCredits: availableDaily - estimatedCredits,
  };
}

export interface SettleCreditsParams {
  reservationId: string;
  userId: string;
  conversationId: string;
  problemId?: string;
  buildosPhase?: string;
  capability?: string;
  provider: string;
  model: string;
  tokens: TokenUsageCounts;
  executionStatus?: NovaUsageEvent["executionStatus"];
  errorMessage?: string;
}

export interface SettleCreditsResult {
  success: boolean;
  creditsCharged: number;
  actualCostInr: number;
  remainingDailyCredits: number;
  overageCredits?: number;
  alreadySettled?: boolean;
}

/**
 * Stage C: Credit Settlement
 * Deducts exact actual credit charge, releases unused reserved credits, and records audit trail.
 * Uses a recoverable idempotent state-transition ledger that protects against crashes and double deductions.
 */
export async function settleReservation(
  db: Db,
  params: SettleCreditsParams
): Promise<SettleCreditsResult> {
  const { reservationId, userId, provider, model, tokens } = params;
  const now = new Date();
  const reservations = db.collection<NovaReservationDocument>(RESERVATION_COLLECTION);
  const wallets = db.collection<NovaWalletDocument>(WALLET_COLLECTION);
  const receipts = db.collection<NovaDeductionReceiptDocument>(DEDUCTION_RECEIPTS_COLLECTION);

  const config = await getEffectivePricingConfig(db);
  const costCalculation: CostAndCreditResult = calculateActualCostAndCredits(
    provider,
    model,
    tokens,
    config
  );
  const actualCredits = costCalculation.creditsCharged;

  // 1. Fetch reservation to ensure existence and validity
  const existing = await reservations.findOne({ reservationId, userId });
  if (!existing) {
    throw Object.assign(new Error(`Reservation ${reservationId} not found`), { status: 404 });
  }

  if (existing.status === "RELEASED") {
    throw Object.assign(new Error("Cannot settle an already released reservation"), { status: 409 });
  }

  // 2. Idempotency Check: Verify if wallet deduction already occurred (via durable receipt or walletDeducted flag)
  const existingReceipt = await receipts.findOne({ reservationId });
  if (existingReceipt || existing.walletDeducted || existing.status === "SETTLED") {
    const charged = existingReceipt?.actualCreditsCharged ?? existing.actualCreditsCharged ?? actualCredits;
    const deductedDaily = existingReceipt?.deductedDailyCredits ?? existing.deductedDailyCredits ?? charged;
    const overage = existingReceipt?.overageCredits ?? existing.overageCredits ?? 0;

    // Ensure reservation record is marked SETTLED
    await reservations.updateOne(
      { reservationId },
      {
        $set: {
          status: "SETTLED",
          settledAt: now,
          walletDeducted: true,
          actualCreditsCharged: charged,
          deductedDailyCredits: deductedDaily,
          overageCredits: overage,
        },
      }
    );

    const currentWallet = await wallets.findOne({ userId });
    return {
      success: true,
      creditsCharged: charged,
      actualCostInr: costCalculation.actualCostInr,
      remainingDailyCredits: currentWallet?.dailyRemaining ?? 0,
      overageCredits: overage,
      alreadySettled: true,
    };
  }

  // 3. Atomically acquire SETTLING lock if not yet locked
  // Store token usage and provider metadata on reservation document to make recovery durable
  let targetReservation = existing;
  if (existing.status === "RESERVED") {
    const transition = await reservations.findOneAndUpdate(
      { reservationId, userId, status: "RESERVED" },
      {
        $set: {
          status: "SETTLING",
          actualCreditsCharged: actualCredits,
          provider,
          model,
          tokens,
          settlingAt: now,
        },
      },
      { returnDocument: "after" }
    );

    if (!transition) {
      // Race condition: another thread transitioned or settled
      const racedReceipt = await receipts.findOne({ reservationId });
      if (racedReceipt) {
        const currentWallet = await wallets.findOne({ userId });
        return {
          success: true,
          creditsCharged: racedReceipt.actualCreditsCharged,
          actualCostInr: costCalculation.actualCostInr,
          remainingDailyCredits: currentWallet?.dailyRemaining ?? 0,
          overageCredits: racedReceipt.overageCredits,
          alreadySettled: true,
        };
      }
      const racedRes = await reservations.findOne({ reservationId, userId });
      if (racedRes?.status === "SETTLED") {
        const currentWallet = await wallets.findOne({ userId });
        return {
          success: true,
          creditsCharged: racedRes.actualCreditsCharged ?? actualCredits,
          actualCostInr: costCalculation.actualCostInr,
          remainingDailyCredits: currentWallet?.dailyRemaining ?? 0,
          overageCredits: racedRes.overageCredits ?? 0,
          alreadySettled: true,
        };
      }
    } else {
      targetReservation = transition;
    }
  }

  const estimatedCredits = targetReservation.estimatedCredits;
  let currentWallet = await ensureWalletAccountingFields(db, await wallets.findOne({ userId }));
  const currentDaily = currentWallet?.dailyRemaining ?? 0;

  // Cycle-aware accounting: a reservation settled after its original daily allocation cycle
  // has changed must NOT consume the new cycle's daily allowance, must NOT increment the new
  // cycle's dailyUsed, and must NOT decrement the current cycle's reserved balance. Its actual
  // usage still counts toward the applicable monthly accounting period.
  // Uses isCurrentCycle so legacy reservations without an allocationCycleAt are inferred from
  // their createdAt (safe under both same-cycle and old-cycle interpretations).
  const sameCycle = isCurrentCycle(currentWallet, targetReservation);

  let deductedDaily = 0;
  let overage = 0;
  if (sameCycle) {
    deductedDaily = Math.min(currentDaily, actualCredits);
    overage = Math.max(0, actualCredits - deductedDaily);
  }

  // 4. Verify transaction capability on the actual MongoDB client topology
  const client = (db as any).client || (db as any).s?.client || (db as any);
  const isTransactionCapable = isClientTransactionCapable(client);

  if (!isTransactionCapable) {
    // Fail closed: Never silently execute unconfirmed, non-transactional settlement.
    // Preserve full reservation and token usage data on the document so settlement can be recovered.
    await reservations.updateOne(
      { reservationId },
      {
        $set: {
          status: "SETTLING",
          provider,
          model,
          tokens,
          settlingAt: now,
          settlementError: "TRANSACTION_UNAVAILABLE: Multi-document transactions are required for credit settlement to guarantee financial integrity.",
        },
      }
    ).catch(() => {});

    throw Object.assign(
      new Error("TRANSACTION_UNAVAILABLE: Multi-document transactions are required for credit settlement to guarantee financial integrity."),
      {
        code: "TRANSACTION_UNAVAILABLE",
        reservationId,
        userId,
        recoverable: true,
      }
    );
  }

  // 5. Execute receipt insertion, wallet deduction, and reservation finalization in ONE atomic transaction
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await receipts.insertOne(
        {
          _id: reservationId,
          reservationId,
          userId,
          actualCreditsCharged: actualCredits,
          deductedDailyCredits: deductedDaily,
          overageCredits: overage,
          estimatedCredits,
          createdAt: now,
        },
        { session }
      );

      // Same-cycle settlement debits daily + monthly pools and drops both holds.
      // Old-cycle settlement only counts toward monthly usage and releases the monthly hold;
      // it never touches the current cycle's daily or reserved balances.
      const walletInc: Record<string, number> = sameCycle
        ? {
            reservedCredits: -estimatedCredits,
            reservedMonthlyCredits: -estimatedCredits,
            dailyRemaining: -deductedDaily,
            dailyUsed: deductedDaily,
            monthlyUsed: actualCredits,
            ...(overage > 0 ? { unbilledOverage: overage } : {}),
          }
        : {
            reservedMonthlyCredits: -estimatedCredits,
            monthlyUsed: actualCredits,
          };

      await wallets.updateOne(
        { userId },
        {
          $inc: walletInc,
          $set: { updatedAt: now },
        },
        { session }
      );

      await reservations.updateOne(
        { reservationId },
        {
          $set: {
            status: "SETTLED",
            settledAt: now,
            walletDeducted: true,
            deductedDailyCredits: deductedDaily,
            overageCredits: overage,
            actualCreditsCharged: actualCredits,
            provider,
            model,
            tokens,
          },
        },
        { session }
      );
    });
  } catch (txnErr: any) {
    if (txnErr?.code === 11000) {
      // Concurrent transaction already inserted receipt
      const r = await receipts.findOne({ reservationId });
      return {
        success: true,
        creditsCharged: r?.actualCreditsCharged ?? actualCredits,
        actualCostInr: costCalculation.actualCostInr,
        remainingDailyCredits: (await wallets.findOne({ userId }))?.dailyRemaining ?? 0,
        overageCredits: r?.overageCredits ?? 0,
        alreadySettled: true,
      };
    }
    throw txnErr;
  } finally {
    await session.endSession();
  }

  // 5. Record usage event & legacy audit transaction
  await recordNovaUsageEvent(db, {
    requestId: reservationId,
    userId,
    conversationId: params.conversationId,
    problemId: params.problemId,
    buildosPhase: params.buildosPhase,
    capability: params.capability || "nova_chat",
    provider,
    model,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cachedTokens: tokens.cachedTokens || 0,
    reasoningTokens: tokens.reasoningTokens || 0,
    actualCostUsd: costCalculation.actualCostUsd,
    actualCostInr: costCalculation.actualCostInr,
    inrExchangeRate: costCalculation.usdToInrRate,
    novaCreditsCharged: actualCredits,
    pricingConfigVersion: costCalculation.pricingConfigVersion,
    executionStatus: params.executionStatus || "SUCCESS",
    errorMessage: params.errorMessage,
    timestamp: now,
  });

  const finalWallet = await wallets.findOne({ userId });
  const finalDaily = finalWallet?.dailyRemaining ?? 0;

  try {
    await db.collection("ai_credit_transactions").insertOne({
      userId,
      amount: -actualCredits,
      type: "NOVA_DYNAMIC_USAGE",
      referenceId: reservationId,
      balanceAfter: finalDaily,
      createdAt: now,
    });
  } catch {
    // Non-blocking
  }

  return {
    success: true,
    creditsCharged: actualCredits,
    actualCostInr: costCalculation.actualCostInr,
    remainingDailyCredits: finalDaily,
    overageCredits: overage,
  };
}

/**
 * Recovers a reservation that was interrupted during settlement.
 * Safely handles crashes before or after wallet deduction.
 * Never deducts twice.
 */
export async function recoverSettlement(
  db: Db,
  reservationId: string,
  userId?: string
): Promise<SettleCreditsResult> {
  const reservations = db.collection<NovaReservationDocument>(RESERVATION_COLLECTION);
  const receipts = db.collection<NovaDeductionReceiptDocument>(DEDUCTION_RECEIPTS_COLLECTION);
  const wallets = db.collection<NovaWalletDocument>(WALLET_COLLECTION);

  const query: any = { reservationId };
  if (userId) query.userId = userId;

  const reservation = await reservations.findOne(query);
  if (!reservation) {
    throw Object.assign(new Error(`Reservation ${reservationId} not found`), { status: 404 });
  }

  if (reservation.status === "SETTLED") {
    const wallet = await wallets.findOne({ userId: reservation.userId });
    return {
      success: true,
      creditsCharged: reservation.actualCreditsCharged ?? 0,
      actualCostInr: 0,
      remainingDailyCredits: wallet?.dailyRemaining ?? 0,
      overageCredits: reservation.overageCredits ?? 0,
      alreadySettled: true,
    };
  }

  if (reservation.status === "RELEASED") {
    throw Object.assign(new Error("Cannot recover an already released reservation"), { status: 409 });
  }

  // Check if deduction receipt already exists (crash occurred AFTER wallet deduction, but before reservation status update)
  const existingReceipt = await receipts.findOne({ reservationId });
  if (existingReceipt || reservation.walletDeducted) {
    const charged = existingReceipt?.actualCreditsCharged ?? reservation.actualCreditsCharged ?? 0;
    const deductedDaily = existingReceipt?.deductedDailyCredits ?? reservation.deductedDailyCredits ?? charged;
    const overage = existingReceipt?.overageCredits ?? reservation.overageCredits ?? 0;

    // Finalize reservation status without repeating wallet deduction
    await reservations.updateOne(
      { reservationId },
      {
        $set: {
          status: "SETTLED",
          settledAt: new Date(),
          walletDeducted: true,
          actualCreditsCharged: charged,
          deductedDailyCredits: deductedDaily,
          overageCredits: overage,
        },
      }
    );

    const wallet = await wallets.findOne({ userId: reservation.userId });
    return {
      success: true,
      creditsCharged: charged,
      actualCostInr: 0,
      remainingDailyCredits: wallet?.dailyRemaining ?? 0,
      overageCredits: overage,
      alreadySettled: true,
    };
  }

  // No receipt exists yet: recovery must perform settlement using stored tokens
  const tokens = reservation.tokens || {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  };

  return settleReservation(db, {
    reservationId,
    userId: reservation.userId,
    conversationId: reservation.conversationId,
    problemId: reservation.problemId,
    provider: reservation.provider || "fallback",
    model: reservation.model || "fallback",
    tokens,
    executionStatus: "SUCCESS",
  });
}

/**
 * Scans and recovers reservations stuck in SETTLING older than staleThresholdMs.
 */
export async function recoverStaleSettlingReservations(
  db: Db,
  staleThresholdMs = 15000,
  targetUserId?: string
): Promise<{ recoveredCount: number; errors: Array<{ reservationId: string; error: string }> }> {
  const reservations = db.collection<NovaReservationDocument>(RESERVATION_COLLECTION);
  const cutoff = new Date(Date.now() - staleThresholdMs);

  const query: any = {
    status: "SETTLING",
    settlingAt: { $lte: cutoff },
  };
  if (targetUserId) query.userId = targetUserId;

  const staleList = await reservations.find(query).toArray();
  let recoveredCount = 0;
  const errors: Array<{ reservationId: string; error: string }> = [];

  for (const item of staleList) {
    try {
      await recoverSettlement(db, item.reservationId, item.userId);
      recoveredCount++;
    } catch (err: any) {
      errors.push({ reservationId: item.reservationId, error: err?.message || String(err) });
    }
  }

  return { recoveredCount, errors };
}

/**
 * Releases a reserved credit amount when execution fails before billable LLM call.
 */
export async function releaseReservation(
  db: Db,
  reservationId: string,
  userId: string,
  reason = "EXECUTION_ABORTED"
): Promise<boolean> {
  const reservations = db.collection<NovaReservationDocument>(RESERVATION_COLLECTION);
  const wallets = db.collection<NovaWalletDocument>(WALLET_COLLECTION);

  // Atomically acquire release lock to prevent double release
  const reservation = await reservations.findOneAndUpdate(
    {
      reservationId,
      userId,
      status: "RESERVED",
    },
    {
      $set: {
        status: "RELEASED",
        releasedAt: new Date(),
      },
    },
    { returnDocument: "before" }
  );

  if (!reservation) return false;

  const now = new Date();
  const wallet = await ensureWalletAccountingFields(db, await wallets.findOne({ userId }));
  const sameCycle = isCurrentCycle(wallet, reservation);

  // Release the hold. For a same-cycle reservation both the daily and monthly pools are
  // decremented. For an old-cycle reservation the daily pool was already reset at cycle
  // advance, so only the monthly reservation hold is released (never a negative decrement).
  const walletInc: Record<string, number> =
    { reservedMonthlyCredits: -reservation.estimatedCredits };
  if (sameCycle) {
    walletInc.reservedCredits = -reservation.estimatedCredits;
  }

  await wallets.updateOne(
    { userId },
    {
      $inc: walletInc,
      $set: { updatedAt: now },
    }
  );

  return true;
}

/**
 * Expires stale RESERVED reservations (expiresAt < now) and releases their held credits.
 *
 * Safety properties:
 * - Only transitions reservations that are still RESERVED via a conditional atomic update, so
 *   concurrent expiry/settlement workers can never release the same reservation twice.
 * - Never expires SETTLING reservations (those remain recoverable via their saved usage).
 * - Never deletes financial records: EXPIRED reservations are preserved for audit/reconciliation.
 * - Respects the reservation's original daily allocation cycle when releasing holds.
 *
 * Invocation: called lazily from reserveCredits (per-user) so no new background infrastructure is
 * required. It can also be invoked by an external sweeper with a targetUserId for global cleanup.
 */
export async function expireStaleReservations(
  db: Db,
  opts?: { userId?: string; now?: Date }
): Promise<{ expiredCount: number; errors: Array<{ reservationId: string; error: string }> }> {
  const reservations = db.collection<NovaReservationDocument>(RESERVATION_COLLECTION);
  const wallets = db.collection<NovaWalletDocument>(WALLET_COLLECTION);
  const now = opts?.now || new Date();

  const query: any = {
    status: "RESERVED",
    expiresAt: { $lt: now },
  };
  if (opts?.userId) query.userId = opts.userId;

  const staleList = await reservations.find(query).toArray();

  const client = (db as any).client || (db as any).s?.client || (db as any);
  const isTransactionCapable = isClientTransactionCapable(client);

  let expiredCount = 0;
  const errors: Array<{ reservationId: string; error: string }> = [];

  for (const reservation of staleList) {
    // The status transition and the wallet hold release are performed inside a single MongoDB
    // transaction so a crash can never leave a reservation EXPIRED while its reserved credits
    // remain locked. If the transaction fails, it rolls back and the reservation stays
    // RESERVED, so a later sweep will retry it (no permanent leak).
    const transitionAndRelease = async (): Promise<boolean> => {
      // Conditional atomic transition: only one worker can win this update. If another worker
      // settled or released concurrently, the filter no longer matches and we skip it.
      const transitioned = await reservations.findOneAndUpdate(
        {
          reservationId: reservation.reservationId,
          userId: reservation.userId,
          status: "RESERVED",
        },
        {
          $set: {
            status: "EXPIRED",
            releasedAt: now,
          },
        },
        { returnDocument: "before" }
      );

      if (!transitioned) return false; // concurrent worker already handled it

      let wallet = await ensureWalletAccountingFields(
        db,
        await wallets.findOne({ userId: reservation.userId })
      );
      const sameCycle = isCurrentCycle(wallet, reservation);

      const walletInc: Record<string, number> =
        { reservedMonthlyCredits: -reservation.estimatedCredits };
      if (sameCycle) {
        walletInc.reservedCredits = -reservation.estimatedCredits;
      }

      await wallets.updateOne(
        { userId: reservation.userId },
        {
          $inc: walletInc,
          $set: { updatedAt: now },
        }
      );

      return true;
    };

    try {
      let released = false;
      if (!isTransactionCapable) {
        // Fail closed: expiration is a financial operation and must only run inside a
        // transaction. When transactions are unavailable we DO NOT change the reservation
        // status or any wallet balance; the reservation remains RESERVED so a later sweep
        // (once transactions are available) will expire it. No sequential fallback.
        errors.push({
          reservationId: reservation.reservationId,
          error: "TRANSACTION_UNAVAILABLE: Multi-document transactions are required for reservation expiration to guarantee financial integrity.",
        });
        continue;
      }
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          released = await transitionAndRelease();
        });
      } finally {
        await session.endSession();
      }
      if (released) expiredCount++;
    } catch (err: any) {
      errors.push({
        reservationId: reservation.reservationId,
        error: err?.message || String(err),
      });
    }
  }

  return { expiredCount, errors };
}

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

  const wallet = await reconcileAndGetWallet(db, userId, params.userSubscription);
  const unbilledOverage = (wallet as any).unbilledOverage || 0;
  const availableDaily = wallet.dailyRemaining - unbilledOverage - wallet.reservedCredits;
  const availableMonthly = wallet.monthlyCeiling - wallet.monthlyUsed - wallet.reservedCredits;

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

  // Atomically increment reservedCredits if sufficient
  const updateResult = await db.collection<NovaWalletDocument>(WALLET_COLLECTION).updateOne(
    {
      userId,
      $expr: {
        $and: [
          { $gte: [{ $subtract: ["$dailyRemaining", { $add: ["$reservedCredits", unbilledOverage] }] }, estimatedCredits] },
          { $gte: [{ $subtract: ["$monthlyCeiling", { $add: ["$monthlyUsed", "$reservedCredits"] }] }, estimatedCredits] },
        ],
      },
    },
    {
      $inc: { reservedCredits: estimatedCredits },
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
  const currentWallet = await wallets.findOne({ userId });
  const currentDaily = currentWallet?.dailyRemaining ?? 0;
  const deductedDaily = Math.min(currentDaily, actualCredits);
  const overage = Math.max(0, actualCredits - deductedDaily);

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

      await wallets.updateOne(
        { userId },
        {
          $inc: {
            reservedCredits: -estimatedCredits,
            dailyRemaining: -deductedDaily,
            dailyUsed: deductedDaily,
            monthlyUsed: actualCredits,
            ...(overage > 0 ? { unbilledOverage: overage } : {}),
          },
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
  await wallets.updateOne(
    { userId },
    {
      $inc: { reservedCredits: -reservation.estimatedCredits },
      $set: { updatedAt: now },
    }
  );

  return true;
}

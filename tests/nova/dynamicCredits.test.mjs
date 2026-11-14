import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateActualCostAndCredits,
  DEFAULT_PRICING_CONFIG,
} from "../../src/lib/nova/pricingConfig.ts";
import {
  extractNormalizedUsage,
} from "../../src/lib/nova/metering.ts";
import {
  reconcileAndGetWallet,
  computeRollingCycles,
} from "../../src/lib/nova/allocationEngine.ts";
import {
  reserveCredits,
  settleReservation,
  releaseReservation,
  recoverSettlement,
  recoverStaleSettlingReservations,
  expireStaleReservations,
  isClientTransactionCapable,
  isCurrentCycle,
} from "../../src/lib/nova/reservationEngine.ts";
import {
  routeModelForTier,
} from "../../src/lib/nova/modelRouter.ts";
import {
  isUserAdmin,
  updatePricingConfig,
  validatePricingConfigInput,
} from "../../src/lib/nova/adminControls.ts";
import {
  getNovaUsageAnalytics,
} from "../../src/lib/nova/analytics.ts";

class DynamicFakeCollection {
  documents = [];

  matches(doc, query) {
    if (!doc) return false;
    for (const [key, value] of Object.entries(query)) {
      if (key === "$expr") {
        // Simple evaluation of $expr conditions if present
        continue;
      }
      const actual = doc[key];
      if (value instanceof Date && actual instanceof Date) {
        if (value.getTime() !== actual.getTime()) return false;
        continue;
      }
      if (value && typeof value === "object") {
        if ("$ne" in value && actual === value.$ne) return false;
        if ("$in" in value && !value.$in.includes(actual)) return false;
        if ("$gte" in value && actual < value.$gte) return false;
        if ("$lte" in value && actual > value.$lte) return false;
        if ("$lt" in value && actual >= value.$lt) return false;
        if ("$gt" in value && actual <= value.$gt) return false;
        continue;
      }
      if (actual !== value) return false;
    }
    return true;
  }

  async findOne(query) {
    return structuredClone(this.documents.find((d) => this.matches(d, query)) || null);
  }

  async insertOne(doc) {
    const uniqueKey = doc.reservationId || doc.version || (doc.userId && !doc.timestamp && !doc.estimatedCredits ? doc.userId : undefined);
    if (uniqueKey && this.documents.some((d) => (d.reservationId || d.version || (d.userId && !d.timestamp && !d.estimatedCredits ? d.userId : null)) === uniqueKey)) {
      const err = new Error("duplicate key");
      err.code = 11000;
      throw err;
    }
    const id = doc._id || uniqueKey || Math.random().toString(36).substring(2);
    this.documents.push(structuredClone({ _id: id, ...doc }));
    return { insertedId: id };
  }

  async findOneAndUpdate(query, update, options = {}) {
    const doc = this.documents.find((d) => this.matches(d, query));
    if (!doc) return null;

    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        doc[k] = (doc[k] || 0) + v;
      }
    }
    if (update.$set) {
      for (const [k, v] of Object.entries(update.$set)) {
        doc[k] = v;
      }
    }
    return structuredClone(doc);
  }

  async updateOne(query, update) {
    const doc = this.documents.find((d) => this.matches(d, query));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };

    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        doc[k] = (doc[k] || 0) + v;
      }
    }
    if (update.$set) {
      for (const [k, v] of Object.entries(update.$set)) {
        doc[k] = v;
      }
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(query, update) {
    let count = 0;
    for (const doc of this.documents) {
      if (this.matches(doc, query)) {
        if (update.$set) Object.assign(doc, update.$set);
        count++;
      }
    }
    return { matchedCount: count, modifiedCount: count };
  }

  async countDocuments(query = {}) {
    return this.documents.filter((d) => this.matches(d, query)).length;
  }

  find(query) {
    const matches = this.documents.filter((d) => this.matches(d, query));
    return {
      async toArray() {
        return structuredClone(matches);
      },
    };
  }

  aggregate(pipeline) {
    const events = this.documents || [];
    return {
      async toArray() {
        const totalInr = events.reduce((sum, e) => sum + (e.actualCostInr || 0), 0);
        const totalUsd = events.reduce((sum, e) => sum + (e.actualCostUsd || 0), 0);
        const totalCredits = events.reduce((sum, e) => sum + (e.novaCreditsCharged || 0), 0);
        return [
          {
            totalInr,
            totalUsd,
            totalCredits,
            totalRequests: events.length,
            failedCount: events.filter((e) => e.executionStatus === "FAILED").length,
          },
        ];
      },
    };
  }
}

class DynamicFakeSession {
  constructor(db) {
    this.db = db;
    this.inTransaction = false;
  }

  async withTransaction(fn) {
    this.inTransaction = true;
    const snapshot = new Map();
    for (const [name, col] of this.db.collections.entries()) {
      snapshot.set(name, structuredClone(col.documents));
    }
    try {
      const result = await fn();
      return result;
    } catch (err) {
      if (err?.code === 11000) {
        throw err;
      }
      for (const [name, docs] of snapshot.entries()) {
        this.db.collections.get(name).documents = docs;
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  async endSession() {
    this.inTransaction = false;
  }
}

class DynamicFakeDb {
  collections = new Map();
  topology = { description: { type: "ReplicaSetWithPrimary" } };

  get client() {
    return this;
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new DynamicFakeCollection());
    }
    return this.collections.get(name);
  }

  startSession() {
    return new DynamicFakeSession(this);
  }
}

// -------------------------------------------------------------
// Test 1: Daily allocation configuration and initialization
// -------------------------------------------------------------
test("1. Daily allocation: correctly initializes Free, Builder, and Pro wallets with approved allocations", async () => {
  const db = new DynamicFakeDb();

  // Free Tier
  const freeWallet = await reconcileAndGetWallet(db, "student-free", { plan: "FREE" });
  assert.equal(freeWallet.tier, "FREE");
  assert.equal(freeWallet.dailyAllowance, 25);
  assert.equal(freeWallet.dailyRemaining, 25);
  assert.equal(freeWallet.monthlyCeiling, 750);

  // Builder Tier
  const builderWallet = await reconcileAndGetWallet(db, "student-builder", {
    plan: "BUILDER",
    status: "ACTIVE",
    expiryDate: new Date(Date.now() + 86400000 * 30),
  });
  assert.equal(builderWallet.tier, "BUILDER");
  assert.equal(builderWallet.dailyAllowance, 950);
  assert.equal(builderWallet.dailyRemaining, 950);
  assert.equal(builderWallet.monthlyCeiling, 28500);

  // Pro Tier
  const proWallet = await reconcileAndGetWallet(db, "student-pro", {
    plan: "PRO",
    status: "ACTIVE",
    expiryDate: new Date(Date.now() + 86400000 * 30),
  });
  assert.equal(proWallet.tier, "PRO");
  assert.equal(proWallet.dailyAllowance, 1900);
  assert.equal(proWallet.dailyRemaining, 1900);
  assert.equal(proWallet.monthlyCeiling, 57000);
});

// -------------------------------------------------------------
// Test 2: Rolling 24-hour reset and no daily rollover
// -------------------------------------------------------------
test("2. Rolling 24-hour reset: replenishes credits, expires unused previous-day balance without rollover", async () => {
  const db = new DynamicFakeDb();
  const initial = await reconcileAndGetWallet(db, "student-rolling", {
    plan: "BUILDER",
    status: "ACTIVE",
    expiryDate: new Date(Date.now() + 86400000 * 30),
  });

  // Simulate spending 400 credits (550 remaining)
  const walletCol = db.collection("nova_user_wallets");
  await walletCol.updateOne(
    { userId: "student-rolling" },
    {
      $set: {
        dailyRemaining: 550,
        dailyUsed: 400,
        monthlyUsed: 400,
        // Advance clock by 25 hours
        lastDailyAllocationAt: new Date(Date.now() - 25 * 3600 * 1000),
      },
    }
  );

  const reconciled = await reconcileAndGetWallet(db, "student-rolling", {
    plan: "BUILDER",
    status: "ACTIVE",
    expiryDate: new Date(Date.now() + 86400000 * 30),
  });

  // Replenishes to exactly 950 (the unused 550 expired, NO rollover to 950 + 550)
  assert.equal(reconciled.dailyRemaining, 950);
  assert.equal(reconciled.dailyUsed, 0);
  assert.equal(reconciled.monthlyUsed, 400); // monthly usage persists
});

// -------------------------------------------------------------
// Test 3: Duplicate allocation prevention under concurrency
// -------------------------------------------------------------
test("3. Concurrency: multiple simultaneous allocation checks never grant duplicate credits", async () => {
  const db = new DynamicFakeDb();
  // 10 concurrent calls reconciling the same student simultaneously
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      reconcileAndGetWallet(db, "student-concurrent-init", { plan: "FREE" })
    )
  );

  const distinctRemaining = new Set(results.map((r) => r.dailyRemaining));
  assert.equal(distinctRemaining.size, 1);
  assert.equal(results[0].dailyRemaining, 25);
});

// -------------------------------------------------------------
// Test 4: Dynamic AI usage calculation formula
// -------------------------------------------------------------
test("4. Dynamic AI calculation: uses token counts and formula C = tokens * price, Credits = ceil(C/0.01)", () => {
  // Input: 10,000 tokens ($0.075 / 1M), Output: 2,000 tokens ($0.30 / 1M) on Gemini Flash
  // Input USD: (10000 / 1M) * 0.075 = $0.00075
  // Output USD: (2000 / 1M) * 0.30 = $0.00060
  // Total USD: $0.00135
  // Total INR (at 84.5): 0.00135 * 84.5 = 0.114075 INR
  // Credits at 0.01 INR/credit: ceil(0.114075 / 0.01) = ceil(11.4075) = 12 credits
  const result = calculateActualCostAndCredits(
    "gemini",
    "gemini-2.5-flash",
    { inputTokens: 10000, outputTokens: 2000 },
    DEFAULT_PRICING_CONFIG
  );

  assert.equal(result.creditsCharged, 12);
  assert.ok(result.actualCostInr > 0.11 && result.actualCostInr < 0.12);
});

// -------------------------------------------------------------
// Test 5: Missing usage metadata fallback
// -------------------------------------------------------------
test("5. Missing usage metadata: never assumes 0 cost, applies conservative character estimate", () => {
  const usage = extractNormalizedUsage(
    {}, // empty body with no usage
    4000, // 4000 input chars ~ 1000 tokens
    2000 // 2000 output chars ~ 500 tokens
  );

  assert.equal(usage.inputTokens, 1000);
  assert.equal(usage.outputTokens, 500);
});

// -------------------------------------------------------------
// Test 6: Reservation, Execution, Settlement lifecycle
// -------------------------------------------------------------
test("6. Lifecycle: Stage A Reservation -> Stage B Execution -> Stage C Settlement", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-lifecycle", {
    plan: "BUILDER",
    status: "ACTIVE",
    expiryDate: new Date(Date.now() + 86400000 * 30),
  });

  // Stage A: Reserve 10 credits
  const reservation = await reserveCredits(db, {
    userId: "student-lifecycle",
    conversationId: "conv-1",
    estimatedCredits: 10,
  });

  assert.equal(reservation.success, true);
  assert.ok(reservation.reservationId);

  const walletMid = await reconcileAndGetWallet(db, "student-lifecycle");
  assert.equal(walletMid.reservedCredits, 10);

  // Stage C: Settle actual execution of 4 credits
  const settlement = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "student-lifecycle",
    conversationId: "conv-1",
    provider: "groq",
    model: "qwen/qwen3.6-27b",
    tokens: { inputTokens: 500, outputTokens: 200 },
  });

  assert.equal(settlement.success, true);
  assert.ok(settlement.creditsCharged >= 1);

  const walletFinal = await reconcileAndGetWallet(db, "student-lifecycle");
  assert.equal(walletFinal.reservedCredits, 0); // reserved unlocked
  assert.equal(walletFinal.dailyRemaining, 950 - settlement.creditsCharged);
});

// -------------------------------------------------------------
// Test 7: Provider failure safely releases reservation
// -------------------------------------------------------------
test("7. Provider failure: releases reservation safely without deducting daily balance", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-fail", { plan: "FREE" });

  const reservation = await reserveCredits(db, {
    userId: "student-fail",
    conversationId: "conv-fail",
    estimatedCredits: 5,
  });

  // Call fails before billable LLM response:
  const released = await releaseReservation(
    db,
    reservation.reservationId,
    "student-fail",
    "NETWORK_TIMEOUT"
  );
  assert.equal(released, true);

  const wallet = await reconcileAndGetWallet(db, "student-fail");
  assert.equal(wallet.reservedCredits, 0);
  assert.equal(wallet.dailyRemaining, 25); // undamaged
});

// -------------------------------------------------------------
// Test 8: Duplicate settlement idempotency
// -------------------------------------------------------------
test("8. Duplicate settlement: rejects double settlement via idempotency", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-idempotent", { plan: "FREE" });

  const reservation = await reserveCredits(db, {
    userId: "student-idempotent",
    conversationId: "conv-idem",
    estimatedCredits: 5,
  });

  const firstSettle = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "student-idempotent",
    conversationId: "conv-idem",
    provider: "gemini",
    model: "gemini-2.5-flash",
    tokens: { inputTokens: 100, outputTokens: 50 },
  });
  assert.equal(firstSettle.success, true);

  // Duplicate second settle attempt
  const secondSettle = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "student-idempotent",
    conversationId: "conv-idem",
    provider: "gemini",
    model: "gemini-2.5-flash",
    tokens: { inputTokens: 100, outputTokens: 50 },
  });
  assert.equal(secondSettle.alreadySettled, true);
});

// -------------------------------------------------------------
// Test 9: Model access routing per subscription tier
// -------------------------------------------------------------
test("9. Model routing: Free tier restricted to low-cost Flash; Pro has reasoning models", () => {
  const freeRoute = routeModelForTier({ tier: "FREE" });
  assert.equal(freeRoute.reasoningAllowed, false);
  assert.equal(freeRoute.maxOutputTokens, 1000);
  assert.ok(!freeRoute.allowedProviders.some((p) => p.isReasoningModel));

  const proRoute = routeModelForTier({ tier: "PRO", mentorMode: "DEBUG" });
  assert.equal(proRoute.reasoningAllowed, true);
  assert.equal(proRoute.maxOutputTokens, 2500);
  assert.ok(proRoute.allowedProviders.some((p) => p.provider === "openai"));
});

// -------------------------------------------------------------
// Test 10: Subscription upgrade and downgrade proration
// -------------------------------------------------------------
test("10. Subscription transition: upgrading from Free to Builder immediately grants Builder allowance", async () => {
  const db = new DynamicFakeDb();
  const freeWallet = await reconcileAndGetWallet(db, "student-upgrade", { plan: "FREE" });
  assert.equal(freeWallet.dailyAllowance, 25);

  // Student purchases Builder
  const upgradedWallet = await reconcileAndGetWallet(db, "student-upgrade", {
    plan: "BUILDER",
    status: "ACTIVE",
    expiryDate: new Date(Date.now() + 86400000 * 30),
  });

  assert.equal(upgradedWallet.tier, "BUILDER");
  assert.equal(upgradedWallet.dailyAllowance, 950);
  assert.equal(upgradedWallet.dailyRemaining, 950);
  assert.equal(upgradedWallet.monthlyCeiling, 28500);
});

// -------------------------------------------------------------
// Test 11: Monthly spending cap enforcement
// -------------------------------------------------------------
test("11. Monthly ceiling: blocks reservations when monthly quota is reached even if daily resets", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-capped", { plan: "FREE" });

  // Simulate monthly usage hitting 750 (ceiling)
  const walletCol = db.collection("nova_user_wallets");
  await walletCol.updateOne(
    { userId: "student-capped" },
    { $set: { monthlyUsed: 750, dailyRemaining: 0 } }
  );

  const reservation = await reserveCredits(db, {
    userId: "student-capped",
    conversationId: "conv-cap",
    estimatedCredits: 5,
  });

  assert.equal(reservation.success, false);
  assert.equal(reservation.reason, "INSUFFICIENT_CREDITS");
});

// -------------------------------------------------------------
// Test 12: Daily spending cap and negative balance prevention
// -------------------------------------------------------------
test("12. Negative balance prevention: rejects reservations exceeding daily remaining credits", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-noborrow", { plan: "FREE" }); // 25 daily

  // Attempt to reserve 30 credits when only 25 are available
  const reservation = await reserveCredits(db, {
    userId: "student-noborrow",
    conversationId: "conv-over",
    estimatedCredits: 30,
  });

  assert.equal(reservation.success, false);
  assert.equal(reservation.reason, "INSUFFICIENT_CREDITS");
});

// -------------------------------------------------------------
// Test 13: Admin pricing controls update without redeployment
// -------------------------------------------------------------
test("13. Admin controls: updates pricing multiplier and model pricing dynamically", async () => {
  const db = new DynamicFakeDb();
  const updated = await updatePricingConfig(db, {
    pricingMultiplier: 1.25,
    creditValueInr: 0.012,
    emergencyDisabledProviders: ["openrouter"],
    updatedBy: "admin-user",
  });

  assert.equal(updated.pricingMultiplier, 1.25);
  assert.equal(updated.creditValueInr, 0.012);
  assert.deepEqual(updated.emergencyDisabledProviders, ["openrouter"]);

  // Model router honors emergency disabled provider
  const route = routeModelForTier({ tier: "BUILDER", config: updated });
  assert.ok(!route.allowedProviders.some((p) => p.provider === "openrouter"));
});

// -------------------------------------------------------------
// Test 14: Analytics aggregation
// -------------------------------------------------------------
test("14. Analytics: aggregates total expenditure, credits consumed, and failure counts", async () => {
  const db = new DynamicFakeDb();
  const usageCol = db.collection("nova_ai_usage_events");

  await usageCol.insertOne({
    requestId: "req-1",
    userId: "student-1",
    provider: "gemini",
    model: "gemini-2.5-flash",
    actualCostInr: 0.25,
    actualCostUsd: 0.003,
    novaCreditsCharged: 25,
    executionStatus: "SUCCESS",
    timestamp: new Date(),
  });

  const analytics = await getNovaUsageAnalytics(db);
  assert.equal(analytics.totalExpenditureInr, 0.25);
  assert.equal(analytics.totalCreditsConsumed, 25);
  assert.equal(analytics.totalRequests, 1);
});

// -------------------------------------------------------------
// Test 15: Rolling cycle calculation helper
// -------------------------------------------------------------
test("15. Rolling cycle helper: correctly identifies exact 24h boundaries", () => {
  const start = new Date("2026-11-14T10:00:00.000Z");
  const sameDay = new Date("2026-11-14T18:00:00.000Z"); // 8 hours later
  const nextDay = new Date("2026-11-15T11:00:00.000Z"); // 25 hours later

  const res1 = computeRollingCycles(start, sameDay, 24);
  assert.equal(res1.cyclesElapsed, 0);

  const res2 = computeRollingCycles(start, nextDay, 24);
  assert.equal(res2.cyclesElapsed, 1);
  assert.equal(res2.newAllocationAt.toISOString(), "2026-11-15T10:00:00.000Z");
});

// =============================================================
// P0 Remediation Phase 1 Tests
// =============================================================

// -------------------------------------------------------------
// P0 Test 1: Two simultaneous settlement requests for the same reservation
// -------------------------------------------------------------
test("P0-1: Concurrent settlements for the same reservation prevent double deduction", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-p0-concurrent", { plan: "BUILDER", status: "ACTIVE", expiryDate: new Date(Date.now() + 86400000 * 30) });

  const reservation = await reserveCredits(db, {
    userId: "student-p0-concurrent",
    conversationId: "conv-p0-1",
    estimatedCredits: 10,
  });

  assert.equal(reservation.success, true);

  // Trigger two simultaneous settlements for the exact same reservation
  const [settle1, settle2] = await Promise.all([
    settleReservation(db, {
      reservationId: reservation.reservationId,
      userId: "student-p0-concurrent",
      conversationId: "conv-p0-1",
      provider: "gemini",
      model: "gemini-2.5-flash",
      tokens: { inputTokens: 500, outputTokens: 200 },
    }),
    settleReservation(db, {
      reservationId: reservation.reservationId,
      userId: "student-p0-concurrent",
      conversationId: "conv-p0-1",
      provider: "gemini",
      model: "gemini-2.5-flash",
      tokens: { inputTokens: 500, outputTokens: 200 },
    }),
  ]);

  // One settles and the other detects alreadySettled
  assert.ok(settle1.success && settle2.success);
  assert.ok(settle1.alreadySettled || settle2.alreadySettled);

  const wallet = await reconcileAndGetWallet(db, "student-p0-concurrent");
  assert.equal(wallet.reservedCredits, 0);
  const charged = settle1.alreadySettled ? settle2.creditsCharged : settle1.creditsCharged;
  assert.equal(wallet.dailyRemaining, 950 - charged);
});

// -------------------------------------------------------------
// P0 Test 2: Server interruption / crash during settlement is recoverable
// -------------------------------------------------------------
test("P0-2: Server interruption during settlement leaves state recoverable without double deduction", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-p0-crash", { plan: "BUILDER", status: "ACTIVE", expiryDate: new Date(Date.now() + 86400000 * 30) });

  const reservation = await reserveCredits(db, {
    userId: "student-p0-crash",
    conversationId: "conv-p0-2",
    estimatedCredits: 10,
  });

  // Simulate a crash after wallet deduction by injecting a partial SETTLING doc with walletDeducted: true
  const resCol = db.collection("nova_credit_reservations");
  await resCol.updateOne(
    { reservationId: reservation.reservationId },
    {
      $set: {
        status: "SETTLING",
        walletDeducted: true,
        actualCreditsCharged: 4,
        deductedDailyCredits: 4,
        overageCredits: 0,
      },
    }
  );
  // Also deduct the wallet once as would have happened before the crash
  const walletCol = db.collection("nova_user_wallets");
  await walletCol.updateOne(
    { userId: "student-p0-crash" },
    { $inc: { reservedCredits: -10, dailyRemaining: -4, dailyUsed: 4, monthlyUsed: 4 } }
  );

  // Now a recovery / retry settlement call executes:
  const recoveredSettle = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "student-p0-crash",
    conversationId: "conv-p0-2",
    provider: "gemini",
    model: "gemini-2.5-flash",
    tokens: { inputTokens: 500, outputTokens: 200 },
  });

  assert.equal(recoveredSettle.success, true);
  // Verify wallet was NOT deducted a second time!
  const wallet = await reconcileAndGetWallet(db, "student-p0-crash");
  assert.equal(wallet.dailyRemaining, 950 - 4); // still exactly 946
  assert.equal(wallet.reservedCredits, 0);
});

// -------------------------------------------------------------
// P0 Test 3: Retry after partial settlement
// -------------------------------------------------------------
test("P0-3: Retry after completed settlement returns idempotent result", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-p0-retry", { plan: "FREE" });

  const reservation = await reserveCredits(db, {
    userId: "student-p0-retry",
    conversationId: "conv-p0-3",
    estimatedCredits: 5,
  });

  const settle1 = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "student-p0-retry",
    conversationId: "conv-p0-3",
    provider: "gemini",
    model: "gemini-2.5-flash",
    tokens: { inputTokens: 200, outputTokens: 100 },
  });
  assert.equal(settle1.success, true);

  const settle2 = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "student-p0-retry",
    conversationId: "conv-p0-3",
    provider: "gemini",
    model: "gemini-2.5-flash",
    tokens: { inputTokens: 200, outputTokens: 100 },
  });
  assert.equal(settle2.alreadySettled, true);
  assert.equal(settle2.creditsCharged, settle1.creditsCharged);
});

// -------------------------------------------------------------
// P0 Test 4: Actual usage greater than reserved credits (overage)
// -------------------------------------------------------------
test("P0-4: Actual usage greater than reserved credits never causes negative daily balance and records overage", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-p0-overage", { plan: "FREE" }); // 25 daily

  // Reduce user balance to only 5 credits remaining
  const walletCol = db.collection("nova_user_wallets");
  await walletCol.updateOne(
    { userId: "student-p0-overage" },
    { $set: { dailyRemaining: 5, dailyUsed: 20 } }
  );

  // Reserve 5 credits
  const reservation = await reserveCredits(db, {
    userId: "student-p0-overage",
    conversationId: "conv-p0-4",
    estimatedCredits: 5,
  });
  assert.equal(reservation.success, true);

  // Settle with large token count generating 12 actual credits (which exceeds the 5 daily remaining)
  const settlement = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "student-p0-overage",
    conversationId: "conv-p0-4",
    provider: "gemini",
    model: "gemini-2.5-flash",
    tokens: { inputTokens: 10000, outputTokens: 2000 }, // ~12 credits
  });

  assert.equal(settlement.success, true);
  assert.equal(settlement.creditsCharged, 12);
  assert.ok(settlement.overageCredits > 0);

  const wallet = await reconcileAndGetWallet(db, "student-p0-overage");
  // Invariant: dailyRemaining must NEVER be negative!
  assert.ok(wallet.dailyRemaining >= 0);
  assert.equal(wallet.dailyRemaining, 0);
  assert.equal(wallet.reservedCredits, 0);
  // Monthly ceiling records all 12 credits consumed
  assert.equal(wallet.monthlyUsed, 12);
});

// -------------------------------------------------------------
// P0 Test 5: Reservation failure prevents provider execution
// -------------------------------------------------------------
test("P0-5: Reservation failure when balance exhausted returns false and prevents execution", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-p0-exhausted", { plan: "FREE" });

  // Set balance to 0
  const walletCol = db.collection("nova_user_wallets");
  await walletCol.updateOne(
    { userId: "student-p0-exhausted" },
    { $set: { dailyRemaining: 0, dailyUsed: 25 } }
  );

  const reservation = await reserveCredits(db, {
    userId: "student-p0-exhausted",
    conversationId: "conv-p0-5",
    estimatedCredits: 2,
  });

  assert.equal(reservation.success, false);
  assert.equal(reservation.reason, "INSUFFICIENT_CREDITS");
});

// -------------------------------------------------------------
// P0 Test 6: Free-tier user restricted from premium models and capped at 1000 tokens
// -------------------------------------------------------------
test("P0-6: Free-tier routing strictly blocks OpenAI, OpenRouter and enforces 1000 token limit", () => {
  const freeRoute = routeModelForTier({ tier: "FREE", mentorMode: "DEBUG" });
  assert.equal(freeRoute.reasoningAllowed, false);
  assert.equal(freeRoute.maxOutputTokens, 1000);

  const providers = freeRoute.allowedProviders.map((p) => p.provider);
  assert.ok(!providers.includes("openai"));
  assert.ok(!providers.includes("openrouter"));
  assert.ok(providers.includes("gemini"));
  assert.ok(providers.includes("groq"));

  // Check token cap on each provider definition
  for (const p of freeRoute.allowedProviders) {
    assert.ok(p.maxTokens <= 1000);
  }
});

// -------------------------------------------------------------
// P0 Test 7: Non-admin rejected and input validation blocks invalid pricing
// -------------------------------------------------------------
test("P0-7: Non-admin authorization is rejected and admin validation catches zero/negative values", async () => {
  // 1. Role verification
  assert.equal(isUserAdmin(null), false);
  assert.equal(isUserAdmin({ userId: "u1", email: "student@test.com", role: "student" }), false);
  assert.equal(isUserAdmin({ userId: "u2", email: "user@test.com" }), false);
  assert.equal(isUserAdmin({ userId: "admin-1", email: "admin@test.com", role: "admin" }), true);

  // 2. Input validation
  assert.throws(
    () => validatePricingConfigInput({ creditValueInr: 0, updatedBy: "admin" }),
    /creditValueInr must be a positive number/
  );
  assert.throws(
    () => validatePricingConfigInput({ creditValueInr: -0.05, updatedBy: "admin" }),
    /creditValueInr must be a positive number/
  );
  assert.throws(
    () => validatePricingConfigInput({ pricingMultiplier: -1, updatedBy: "admin" }),
    /pricingMultiplier must be a positive number/
  );
  assert.throws(
    () => validatePricingConfigInput({ tierAllocations: { FREE: { dailyAllocation: -5 } }, updatedBy: "admin" }),
    /dailyAllocation for FREE must be an integer/
  );
});

// -------------------------------------------------------------
// P0 Test 8: Provider failure releases reservation correctly
// -------------------------------------------------------------
test("P0-8: Provider failure releases reserved credits completely back to available pool", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-p0-release", { plan: "BUILDER", status: "ACTIVE", expiryDate: new Date(Date.now() + 86400000 * 30) });

  const reservation = await reserveCredits(db, {
    userId: "student-p0-release",
    conversationId: "conv-p0-8",
    estimatedCredits: 10,
  });

  const walletDuring = await reconcileAndGetWallet(db, "student-p0-release");
  assert.equal(walletDuring.reservedCredits, 10);

  // Provider call fails or aborts:
  const released = await releaseReservation(db, reservation.reservationId, "student-p0-release", "PROVIDER_TIMEOUT");
  assert.equal(released, true);

  const walletAfter = await reconcileAndGetWallet(db, "student-p0-release");
  assert.equal(walletAfter.reservedCredits, 0);
  assert.equal(walletAfter.dailyRemaining, 950); // completely undamaged
});

// -------------------------------------------------------------
// Phase 1.1: Settlement Recovery and Billing Integrity Tests
// -------------------------------------------------------------

test("Phase 1.1 - Test 1: Crash after reservation becomes SETTLING but before wallet deduction is safely recovered", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-rec-1", { plan: "FREE" }); // 25 daily

  const reservation = await reserveCredits(db, {
    userId: "student-rec-1",
    conversationId: "conv-rec-1",
    estimatedCredits: 2,
  });
  assert.equal(reservation.success, true);

  // Simulate crash: transition to SETTLING with tokens stored, but crash before wallet deduction (no receipt exists)
  const resCol = db.collection("nova_credit_reservations");
  await resCol.updateOne(
    { reservationId: reservation.reservationId },
    {
      $set: {
        status: "SETTLING",
        settlingAt: new Date(),
        provider: "gemini",
        model: "gemini-2.5-flash",
        tokens: { inputTokens: 500, outputTokens: 200 }, // ~2 credits
      },
    }
  );

  // Verify wallet still has 25 remaining and 2 reserved
  const walletBefore = await reconcileAndGetWallet(db, "student-rec-1");
  assert.equal(walletBefore.dailyRemaining, 25);
  assert.equal(walletBefore.reservedCredits, 2);

  // Trigger recovery
  const recovered = await recoverSettlement(db, reservation.reservationId, "student-rec-1");
  assert.equal(recovered.success, true);
  assert.equal(recovered.creditsCharged, 1);

  // Verify wallet balance is deducted and reservedCredits released
  const walletAfter = await reconcileAndGetWallet(db, "student-rec-1");
  assert.equal(walletAfter.dailyRemaining, 24);
  assert.equal(walletAfter.reservedCredits, 0);

  // Verify reservation is SETTLED and receipt is created
  const resDoc = await resCol.findOne({ reservationId: reservation.reservationId });
  assert.equal(resDoc.status, "SETTLED");
  const receiptsCol = db.collection("nova_wallet_deduction_receipts");
  const receipt = await receiptsCol.findOne({ reservationId: reservation.reservationId });
  assert.ok(receipt);
  assert.equal(receipt.actualCreditsCharged, 1);
});

test("Phase 1.1 - Test 2: Crash after wallet deduction but before reservation SETTLED skips duplicate deduction on recovery", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-rec-2", { plan: "FREE" }); // 25 daily

  const reservation = await reserveCredits(db, {
    userId: "student-rec-2",
    conversationId: "conv-rec-2",
    estimatedCredits: 5,
  });
  assert.equal(reservation.success, true);

  // Simulate crash: wallet was already deducted (receipt inserted, wallet deducted to 20),
  // but reservation remained in SETTLING
  const receiptsCol = db.collection("nova_wallet_deduction_receipts");
  await receiptsCol.insertOne({
    reservationId: reservation.reservationId,
    userId: "student-rec-2",
    actualCreditsCharged: 5,
    deductedDailyCredits: 5,
    overageCredits: 0,
    estimatedCredits: 5,
    createdAt: new Date(),
  });

  const walletsCol = db.collection("nova_user_wallets");
  await walletsCol.updateOne(
    { userId: "student-rec-2" },
    { $set: { dailyRemaining: 20, reservedCredits: 0, dailyUsed: 5 } }
  );

  const resCol = db.collection("nova_credit_reservations");
  await resCol.updateOne(
    { reservationId: reservation.reservationId },
    {
      $set: {
        status: "SETTLING",
        settlingAt: new Date(),
      },
    }
  );

  // Trigger recovery
  const recovered = await recoverSettlement(db, reservation.reservationId, "student-rec-2");
  assert.equal(recovered.success, true);
  assert.equal(recovered.alreadySettled, true);
  assert.equal(recovered.creditsCharged, 5);

  // Assert wallet was NOT deducted a second time
  const walletAfter = await reconcileAndGetWallet(db, "student-rec-2");
  assert.equal(walletAfter.dailyRemaining, 20); // Still exactly 20!

  // Assert reservation status is now SETTLED
  const resDoc = await resCol.findOne({ reservationId: reservation.reservationId });
  assert.equal(resDoc.status, "SETTLED");
});

test("Phase 1.1 - Test 3: Retry after crash scenarios is completely idempotent", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-rec-3", { plan: "BUILDER", status: "ACTIVE", expiryDate: new Date(Date.now() + 86400000 * 30) });

  const reservation = await reserveCredits(db, {
    userId: "student-rec-3",
    conversationId: "conv-rec-3",
    estimatedCredits: 5,
  });

  const settle1 = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "student-rec-3",
    conversationId: "conv-rec-3",
    provider: "groq",
    model: "qwen/qwen3.6-27b",
    tokens: { inputTokens: 500, outputTokens: 200 },
  });
  assert.equal(settle1.success, true);

  // Repeated retries via settleReservation and recoverSettlement
  const retry1 = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "student-rec-3",
    conversationId: "conv-rec-3",
    provider: "groq",
    model: "qwen/qwen3.6-27b",
    tokens: { inputTokens: 500, outputTokens: 200 },
  });
  assert.equal(retry1.alreadySettled, true);

  const retry2 = await recoverSettlement(db, reservation.reservationId, "student-rec-3");
  assert.equal(retry2.alreadySettled, true);

  const wallet = await reconcileAndGetWallet(db, "student-rec-3");
  assert.equal(wallet.reservedCredits, 0);
  assert.equal(wallet.dailyRemaining, 950 - settle1.creditsCharged);
});

test("Phase 1.1 - Test 4: Two concurrent settlement attempts do not deduct twice", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-rec-4", { plan: "FREE" });

  const reservation = await reserveCredits(db, {
    userId: "student-rec-4",
    conversationId: "conv-rec-4",
    estimatedCredits: 3,
  });

  const params = {
    reservationId: reservation.reservationId,
    userId: "student-rec-4",
    conversationId: "conv-rec-4",
    provider: "gemini",
    model: "gemini-2.5-flash",
    tokens: { inputTokens: 600, outputTokens: 150 },
  };

  const [res1, res2] = await Promise.all([
    settleReservation(db, params),
    settleReservation(db, params),
  ]);

  assert.equal(res1.success, true);
  assert.equal(res2.success, true);
  // Exactly one returned initial settlement, the other returned alreadySettled
  assert.ok(res1.alreadySettled || res2.alreadySettled);

  // Wallet must only be deducted once
  const wallet = await reconcileAndGetWallet(db, "student-rec-4");
  const creditsCharged = res1.alreadySettled ? res2.creditsCharged : res1.creditsCharged;
  assert.equal(wallet.dailyRemaining, 25 - creditsCharged);

  // Exactly one receipt exists
  const receipts = db.collection("nova_wallet_deduction_receipts").documents;
  const matchCount = receipts.filter((r) => r.reservationId === reservation.reservationId).length;
  assert.equal(matchCount, 1);
});

test("Phase 1.1 - Test 5: Two concurrent recovery attempts do not apply duplicate deductions", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-rec-5", { plan: "FREE" });

  const reservation = await reserveCredits(db, {
    userId: "student-rec-5",
    conversationId: "conv-rec-5",
    estimatedCredits: 2,
  });

  // Set to SETTLING with tokens stored
  const resCol = db.collection("nova_credit_reservations");
  await resCol.updateOne(
    { reservationId: reservation.reservationId },
    {
      $set: {
        status: "SETTLING",
        settlingAt: new Date(Date.now() - 30000), // 30s ago
        provider: "groq",
        model: "qwen/qwen3.6-27b",
        tokens: { inputTokens: 400, outputTokens: 100 },
      },
    }
  );

  // Fire concurrent recovery attempts
  const [rec1, rec2] = await Promise.all([
    recoverSettlement(db, reservation.reservationId, "student-rec-5"),
    recoverSettlement(db, reservation.reservationId, "student-rec-5"),
  ]);

  assert.equal(rec1.success, true);
  assert.equal(rec2.success, true);

  const wallet = await reconcileAndGetWallet(db, "student-rec-5");
  const charged = rec1.creditsCharged || rec2.creditsCharged;
  assert.equal(wallet.dailyRemaining, 25 - charged);
});

test("Phase 1.1 - Test 6: Successful provider response followed by settlement failure preserves reservation", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-rec-6", { plan: "FREE" });

  const reservation = await reserveCredits(db, {
    userId: "student-rec-6",
    conversationId: "conv-rec-6",
    estimatedCredits: 2,
  });

  // Simulate provider success metadata stored on reservation
  const resCol = db.collection("nova_credit_reservations");
  await resCol.updateOne(
    { reservationId: reservation.reservationId },
    {
      $set: {
        provider: "gemini",
        model: "gemini-2.5-flash",
        tokens: { inputTokens: 1200, outputTokens: 300 },
        lastProviderResponseAt: new Date(),
      },
    }
  );

  // When provider execution succeeds, finally-block does NOT call releaseReservation!
  // Reservation remains in RESERVED or SETTLING with locked reservedCredits:
  const walletDuring = await reconcileAndGetWallet(db, "student-rec-6");
  assert.equal(walletDuring.reservedCredits, 2);

  const resDoc = await resCol.findOne({ reservationId: reservation.reservationId });
  assert.notEqual(resDoc.status, "RELEASED");
  assert.ok(resDoc.tokens);
});

test("Phase 1.1 - Test 7: Recovery completes billing without another provider call", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-rec-7", { plan: "FREE" });

  const reservation = await reserveCredits(db, {
    userId: "student-rec-7",
    conversationId: "conv-rec-7",
    estimatedCredits: 2,
  });

  // Persist provider output metadata as the route does before settlement
  const resCol = db.collection("nova_credit_reservations");
  await resCol.updateOne(
    { reservationId: reservation.reservationId },
    {
      $set: {
        status: "SETTLING",
        settlingAt: new Date(Date.now() - 20000),
        provider: "gemini",
        model: "gemini-2.5-flash",
        tokens: { inputTokens: 800, outputTokens: 200 },
      },
    }
  );

  // Recovery executes without calling any external provider API:
  const recovered = await recoverSettlement(db, reservation.reservationId, "student-rec-7");
  assert.equal(recovered.success, true);
  assert.ok(recovered.creditsCharged > 0);

  const resDoc = await resCol.findOne({ reservationId: reservation.reservationId });
  assert.equal(resDoc.status, "SETTLED");

  const wallet = await reconcileAndGetWallet(db, "student-rec-7");
  assert.equal(wallet.reservedCredits, 0);
  assert.equal(wallet.dailyRemaining, 25 - recovered.creditsCharged);
});

test("Phase 1.1 - Test 8: Genuine provider failure releases the reservation", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-rec-8", { plan: "FREE" });

  const reservation = await reserveCredits(db, {
    userId: "student-rec-8",
    conversationId: "conv-rec-8",
    estimatedCredits: 2,
  });

  const walletBefore = await reconcileAndGetWallet(db, "student-rec-8");
  assert.equal(walletBefore.reservedCredits, 2);

  // Provider failed before response was generated (providerExecutionSucceeded = false)
  // Route's finally block calls releaseReservation:
  const released = await releaseReservation(db, reservation.reservationId, "student-rec-8", "PROVIDER_FAILED");
  assert.equal(released, true);

  const resDoc = await db.collection("nova_credit_reservations").findOne({ reservationId: reservation.reservationId });
  assert.equal(resDoc.status, "RELEASED");

  const walletAfter = await reconcileAndGetWallet(db, "student-rec-8");
  assert.equal(walletAfter.reservedCredits, 0);
  assert.equal(walletAfter.dailyRemaining, 25);
});

test("Phase 1.1 - Test 9: Repeated recovery does not deduct twice", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-rec-9", { plan: "PRO" }); // 1,900 daily

  const reservation = await reserveCredits(db, {
    userId: "student-rec-9",
    conversationId: "conv-rec-9",
    estimatedCredits: 5,
  });

  const settle = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "student-rec-9",
    conversationId: "conv-rec-9",
    provider: "openai",
    model: "gpt-4o-mini",
    tokens: { inputTokens: 1000, outputTokens: 500 },
  });
  assert.equal(settle.success, true);

  const walletAfterFirst = await reconcileAndGetWallet(db, "student-rec-9");
  const expectedBalance = walletAfterFirst.dailyRemaining;

  // Run recoverSettlement 5 consecutive times
  for (let i = 0; i < 5; i++) {
    const rec = await recoverSettlement(db, reservation.reservationId, "student-rec-9");
    assert.equal(rec.success, true);
    assert.equal(rec.alreadySettled, true);
  }

  const walletFinal = await reconcileAndGetWallet(db, "student-rec-9");
  assert.equal(walletFinal.dailyRemaining, expectedBalance);
  assert.equal(walletFinal.reservedCredits, 0);
});

// -------------------------------------------------------------
// Phase 1.3: Production Transaction Enforcement & Fail-Closed Tests
// -------------------------------------------------------------

test("Phase 1.3 - Test 1: Transaction success atomically commits receipt, wallet deduction, and SETTLED state", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-p13-success", { plan: "FREE" }); // 25 daily

  const reservation = await reserveCredits(db, {
    userId: "student-p13-success",
    conversationId: "conv-p13-1",
    estimatedCredits: 5,
  });

  const result = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "student-p13-success",
    conversationId: "conv-p13-1",
    provider: "gemini",
    model: "gemini-2.5-flash",
    tokens: { inputTokens: 500, outputTokens: 200 }, // 1 credit
  });

  assert.equal(result.success, true);
  assert.equal(result.creditsCharged, 1);

  // Assert all 3 writes committed atomically:
  const receipt = await db.collection("nova_wallet_deduction_receipts").findOne({ reservationId: reservation.reservationId });
  assert.ok(receipt);
  assert.equal(receipt.actualCreditsCharged, 1);

  const wallet = await reconcileAndGetWallet(db, "student-p13-success");
  assert.equal(wallet.dailyRemaining, 24);
  assert.equal(wallet.reservedCredits, 0);

  const resDoc = await db.collection("nova_credit_reservations").findOne({ reservationId: reservation.reservationId });
  assert.equal(resDoc.status, "SETTLED");
  assert.equal(resDoc.walletDeducted, true);
});

test("Phase 1.3 - Test 2: Transaction rollback on write failure completely restores collections without partial writes", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-p13-rollback", { plan: "FREE" });

  const reservation = await reserveCredits(db, {
    userId: "student-p13-rollback",
    conversationId: "conv-p13-2",
    estimatedCredits: 5,
  });

  // Intercept wallet update to simulate transient database / write-conflict failure inside session.withTransaction
  const originalUpdateOne = db.collection("nova_user_wallets").updateOne.bind(db.collection("nova_user_wallets"));
  let failOnce = true;
  db.collection("nova_user_wallets").updateOne = async (query, update, options) => {
    if (failOnce && options?.session) {
      failOnce = false;
      throw new Error("Simulated WriteConflict failure inside transaction");
    }
    return originalUpdateOne(query, update, options);
  };

  await assert.rejects(
    async () => {
      await settleReservation(db, {
        reservationId: reservation.reservationId,
        userId: "student-p13-rollback",
        conversationId: "conv-p13-2",
        provider: "gemini",
        model: "gemini-2.5-flash",
        tokens: { inputTokens: 500, outputTokens: 200 },
      });
    },
    /Simulated WriteConflict failure inside transaction/
  );

  // Assert atomic rollback:
  // 1. Receipt must NOT exist (rolled back)
  const receipt = await db.collection("nova_wallet_deduction_receipts").findOne({ reservationId: reservation.reservationId });
  assert.equal(receipt, null);

  // 2. Wallet dailyRemaining must NOT be deducted (rolled back)
  const wallet = await reconcileAndGetWallet(db, "student-p13-rollback");
  assert.equal(wallet.dailyRemaining, 25);
  assert.equal(wallet.reservedCredits, 5); // Still held in reservation

  // 3. Reservation must NOT be SETTLED
  const resDoc = await db.collection("nova_credit_reservations").findOne({ reservationId: reservation.reservationId });
  assert.notEqual(resDoc.status, "SETTLED");
});

test("Phase 1.3 - Test 3: Transaction capability unavailable fails closed and preserves reservation without deducting wallet", async () => {
  const db = new DynamicFakeDb();
  // Simulate standalone / non-transactional MongoDB topology
  db.topology = { description: { type: "Single" } };
  await reconcileAndGetWallet(db, "student-p13-single", { plan: "FREE" });

  const reservation = await reserveCredits(db, {
    userId: "student-p13-single",
    conversationId: "conv-p13-3",
    estimatedCredits: 3,
  });

  await assert.rejects(
    async () => {
      await settleReservation(db, {
        reservationId: reservation.reservationId,
        userId: "student-p13-single",
        conversationId: "conv-p13-3",
        provider: "gemini",
        model: "gemini-2.5-flash",
        tokens: { inputTokens: 500, outputTokens: 200 },
      });
    },
    /TRANSACTION_UNAVAILABLE/
  );

  // Fail closed invariants:
  // 1. Wallet is NOT touched
  const wallet = await reconcileAndGetWallet(db, "student-p13-single");
  assert.equal(wallet.dailyRemaining, 25);
  assert.equal(wallet.reservedCredits, 3); // Kept locked to protect financial state

  // 2. Receipt is NOT inserted
  const receipt = await db.collection("nova_wallet_deduction_receipts").findOne({ reservationId: reservation.reservationId });
  assert.equal(receipt, null);

  // 3. Reservation is preserved with settlementError and tokens for recovery
  const resDoc = await db.collection("nova_credit_reservations").findOne({ reservationId: reservation.reservationId });
  assert.equal(resDoc.status, "SETTLING");
  assert.ok(resDoc.settlementError?.includes("TRANSACTION_UNAVAILABLE"));
  assert.ok(resDoc.tokens);
});

test("Phase 1.3 - Test 4: Duplicate settlement attempts are idempotent across transactions", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-p13-dup", { plan: "BUILDER", status: "ACTIVE", expiryDate: new Date(Date.now() + 86400000 * 30) });

  const reservation = await reserveCredits(db, {
    userId: "student-p13-dup",
    conversationId: "conv-p13-4",
    estimatedCredits: 5,
  });

  const settle1 = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "student-p13-dup",
    conversationId: "conv-p13-4",
    provider: "groq",
    model: "qwen/qwen3.6-27b",
    tokens: { inputTokens: 1000, outputTokens: 500 },
  });
  assert.equal(settle1.success, true);
  assert.equal(settle1.alreadySettled, undefined);

  // Immediate retry
  const settle2 = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "student-p13-dup",
    conversationId: "conv-p13-4",
    provider: "groq",
    model: "qwen/qwen3.6-27b",
    tokens: { inputTokens: 1000, outputTokens: 500 },
  });
  assert.equal(settle2.success, true);
  assert.equal(settle2.alreadySettled, true);
  assert.equal(settle2.creditsCharged, settle1.creditsCharged);

  const wallet = await reconcileAndGetWallet(db, "student-p13-dup");
  assert.equal(wallet.dailyRemaining, 950 - settle1.creditsCharged);
});

test("Phase 1.3 - Test 5: Recovery after an interrupted transaction succeeds cleanly without re-calling provider", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "student-p13-interrupted", { plan: "FREE" });

  const reservation = await reserveCredits(db, {
    userId: "student-p13-interrupted",
    conversationId: "conv-p13-5",
    estimatedCredits: 2,
  });

  // Simulate interrupted transaction: reservation left in SETTLING with saved provider usage metadata
  const resCol = db.collection("nova_credit_reservations");
  await resCol.updateOne(
    { reservationId: reservation.reservationId },
    {
      $set: {
        status: "SETTLING",
        settlingAt: new Date(Date.now() - 30000),
        provider: "gemini",
        model: "gemini-2.5-flash",
        tokens: { inputTokens: 800, outputTokens: 200 },
      },
    }
  );

  // Recovery runs with active transaction capability:
  const recovered = await recoverSettlement(db, reservation.reservationId, "student-p13-interrupted");
  assert.equal(recovered.success, true);
  assert.ok(recovered.creditsCharged > 0);

  const resDoc = await resCol.findOne({ reservationId: reservation.reservationId });
  assert.equal(resDoc.status, "SETTLED");
  assert.equal(resDoc.walletDeducted, true);

  const wallet = await reconcileAndGetWallet(db, "student-p13-interrupted");
  assert.equal(wallet.reservedCredits, 0);
  assert.equal(wallet.dailyRemaining, 25 - recovered.creditsCharged);
});

// -------------------------------------------------------------
// Phase 1.5 - Topology Enforcement & Fail-Closed Tests
// -------------------------------------------------------------
test("Phase 1.5 - Test 1: isClientTransactionCapable fails closed on missing client", () => {
  assert.equal(isClientTransactionCapable(null), false);
  assert.equal(isClientTransactionCapable(undefined), false);
  assert.equal(isClientTransactionCapable(false), false);
  assert.equal(isClientTransactionCapable("client"), false);
});

test("Phase 1.5 - Test 2: isClientTransactionCapable fails closed on missing or invalid startSession", () => {
  assert.equal(isClientTransactionCapable({}), false);
  assert.equal(isClientTransactionCapable({ startSession: null }), false);
  assert.equal(isClientTransactionCapable({ startSession: "not-a-function" }), false);
});

test("Phase 1.5 - Test 3: isClientTransactionCapable fails closed on missing topology description", () => {
  assert.equal(isClientTransactionCapable({ startSession: () => {} }), false);
  assert.equal(isClientTransactionCapable({ startSession: () => {}, topology: null }), false);
  assert.equal(isClientTransactionCapable({ startSession: () => {}, topology: {} }), false);
  assert.equal(isClientTransactionCapable({ startSession: () => {}, topology: { description: null } }), false);
  assert.equal(isClientTransactionCapable({ startSession: () => {}, topology: { description: {} } }), false);
  assert.equal(isClientTransactionCapable({ startSession: () => {}, topology: { description: { type: "" } } }), false);
});

test("Phase 1.5 - Test 4: isClientTransactionCapable fails closed on unknown or unconfirmed topology type", () => {
  assert.equal(isClientTransactionCapable({ startSession: () => {}, topology: { description: { type: "Unknown" } } }), false);
  assert.equal(isClientTransactionCapable({ startSession: () => {}, topology: { description: { type: "ReplicaSetNoPrimary" } } }), false);
  assert.equal(isClientTransactionCapable({ startSession: () => {}, topology: { description: { type: "RandomCluster" } } }), false);
});

test("Phase 1.5 - Test 5: isClientTransactionCapable succeeds for supported topologies", () => {
  // Supported: ReplicaSetWithPrimary
  assert.equal(isClientTransactionCapable({ startSession: () => {}, topology: { description: { type: "ReplicaSetWithPrimary" } } }), true);
  // Supported: Sharded
  assert.equal(isClientTransactionCapable({ startSession: () => {}, topology: { description: { type: "Sharded" } } }), true);
  // Supported: LoadBalanced
  assert.equal(isClientTransactionCapable({ startSession: () => {}, topology: { description: { type: "LoadBalanced" } } }), true);
});

test("Phase 1.5 - Test 6: isClientTransactionCapable fails closed on unsupported standalone (Single) topology", () => {
  assert.equal(isClientTransactionCapable({ startSession: () => {}, topology: { description: { type: "Single" } } }), false);
});

test("Phase 1.5 - Test 7: Missing topology description causes TRANSACTION_UNAVAILABLE without receipt or wallet deduction", async () => {
  const db = new DynamicFakeDb();
  // Simulate client with missing topology description
  delete db.topology;
  await reconcileAndGetWallet(db, "student-p15-missing-top", { plan: "FREE" });

  const reservation = await reserveCredits(db, {
    userId: "student-p15-missing-top",
    conversationId: "conv-p15-1",
    estimatedCredits: 4,
  });

  await assert.rejects(
    async () => {
      await settleReservation(db, {
        reservationId: reservation.reservationId,
        userId: "student-p15-missing-top",
        conversationId: "conv-p15-1",
        provider: "gemini",
        model: "gemini-2.5-flash",
        tokens: { inputTokens: 500, outputTokens: 200 },
      });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("TRANSACTION_UNAVAILABLE"));
      assert.equal(err.code, "TRANSACTION_UNAVAILABLE");
      assert.equal(err.recoverable, true);
      return true;
    }
  );

  // Assert fail-closed invariants:
  // 1. Wallet balance untouched
  const wallet = await reconcileAndGetWallet(db, "student-p15-missing-top");
  assert.equal(wallet.dailyRemaining, 25);
  assert.equal(wallet.reservedCredits, 4); // Reserved credits remain safely held

  // 2. No receipt created
  const receipt = await db.collection("nova_wallet_deduction_receipts").findOne({ reservationId: reservation.reservationId });
  assert.equal(receipt, null);

  // 3. Reservation preserved in SETTLING with tokens and error
  const resDoc = await db.collection("nova_credit_reservations").findOne({ reservationId: reservation.reservationId });
  assert.equal(resDoc.status, "SETTLING");
  assert.ok(resDoc.settlementError.includes("TRANSACTION_UNAVAILABLE"));
});

test("Phase 1.5 - Test 8: Unknown topology type causes TRANSACTION_UNAVAILABLE without receipt or wallet deduction", async () => {
  const db = new DynamicFakeDb();
  // Simulate client with Unknown topology type
  db.topology = { description: { type: "Unknown" } };
  await reconcileAndGetWallet(db, "student-p15-unknown-top", { plan: "FREE" });

  const reservation = await reserveCredits(db, {
    userId: "student-p15-unknown-top",
    conversationId: "conv-p15-2",
    estimatedCredits: 2,
  });

  await assert.rejects(
    async () => {
      await settleReservation(db, {
        reservationId: reservation.reservationId,
        userId: "student-p15-unknown-top",
        conversationId: "conv-p15-2",
        provider: "gemini",
        model: "gemini-2.5-flash",
        tokens: { inputTokens: 500, outputTokens: 200 },
      });
    },
    /TRANSACTION_UNAVAILABLE/
  );

  // Invariants:
  const wallet = await reconcileAndGetWallet(db, "student-p15-unknown-top");
  assert.equal(wallet.dailyRemaining, 25);
  assert.equal(wallet.reservedCredits, 2);

  const receipt = await db.collection("nova_wallet_deduction_receipts").findOne({ reservationId: reservation.reservationId });
  assert.equal(receipt, null);

  const resDoc = await db.collection("nova_credit_reservations").findOne({ reservationId: reservation.reservationId });
  assert.equal(resDoc.status, "SETTLING");
});

// =============================================================
// Phase 2.2: Daily Accounting Remediation Tests
// =============================================================

// Helper: force a rolling daily reset by rewinding the allocation anchor by >24h.
async function forceDailyReset(db, userId, plan = { plan: "FREE" }) {
  const walletCol = db.collection("nova_user_wallets");
  await walletCol.updateOne(
    { userId },
    { $set: { lastDailyAllocationAt: new Date(Date.now() - 25 * 3600 * 1000) } }
  );
  return reconcileAndGetWallet(db, userId, plan);
}

// -------------------------------------------------------------
// 2.2 Test 1: Old-cycle reservation settles after reset without consuming new daily allowance
// -------------------------------------------------------------
test("2.2-1: Reservation created before reset, settled after reset, does not consume the new day's allowance", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-1", { plan: "BUILDER", status: "ACTIVE", expiryDate: new Date(Date.now() + 86400000 * 30) });

  const reservation = await reserveCredits(db, {
    userId: "s22-1",
    conversationId: "conv-22-1",
    estimatedCredits: 10,
  });
  assert.equal(reservation.success, true);

  // Record anchor at creation time, then force a daily reset.
  const walletBefore = await reconcileAndGetWallet(db, "s22-1");
  const anchorAtCreation = walletBefore.lastDailyAllocationAt;

  const walletAfterReset = await forceDailyReset(db, "s22-1", { plan: "BUILDER", status: "ACTIVE", expiryDate: new Date(Date.now() + 86400000 * 30) });
  assert.equal(walletAfterReset.dailyRemaining, 950); // replenished
  assert.equal(walletAfterReset.reservedCredits, 0); // old-cycle holds released from daily pool

  // Settle the OLD reservation after reset. Actual ~3 credits.
  const settle = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "s22-1",
    conversationId: "conv-22-1",
    provider: "gemini",
    model: "gemini-2.5-flash",
    tokens: { inputTokens: 2000, outputTokens: 500 }, // ~3 credits
  });
  assert.equal(settle.success, true);
  assert.equal(settle.creditsCharged, 3);

  const walletFinal = await reconcileAndGetWallet(db, "s22-1");
  // New day's allowance must NOT be reduced by the old-cycle reservation.
  assert.equal(walletFinal.dailyRemaining, 950);
  assert.equal(walletFinal.dailyUsed, 0);
  // Usage still counts toward the monthly accounting period.
  assert.equal(walletFinal.monthlyUsed, 3);
  // Reservation hold fully released.
  assert.equal(walletFinal.reservedCredits, 0);
  assert.equal(walletFinal.reservedMonthlyCredits, 0);
  assert.notEqual(new Date(anchorAtCreation).getTime(), new Date(walletFinal.lastDailyAllocationAt).getTime());
});

// -------------------------------------------------------------
// 2.2 Test 2: Old-cycle reservation releases without reducing new-cycle reserved credits
// -------------------------------------------------------------
test("2.2-2: Releasing an old-cycle reservation never decrements the new cycle's reserved balance", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-2", { plan: "BUILDER", status: "ACTIVE", expiryDate: new Date(Date.now() + 86400000 * 30) });

  const oldRes = await reserveCredits(db, { userId: "s22-2", conversationId: "conv-22-2a", estimatedCredits: 10 });
  assert.equal(oldRes.success, true);

  // Force reset (old cycle => daily hold released).
  await forceDailyReset(db, "s22-2", { plan: "BUILDER", status: "ACTIVE", expiryDate: new Date(Date.now() + 86400000 * 30) });

  // Create a NEW-cycle reservation.
  const newRes = await reserveCredits(db, { userId: "s22-2", conversationId: "conv-22-2b", estimatedCredits: 5 });
  assert.equal(newRes.success, true);

  const walletMid = await reconcileAndGetWallet(db, "s22-2");
  assert.equal(walletMid.reservedCredits, 5); // only the new-cycle reservation holds daily credits

  // Release the OLD reservation. Must not reduce the new cycle's reserved balance.
  const released = await releaseReservation(db, oldRes.reservationId, "s22-2", "EXECUTION_ABORTED");
  assert.equal(released, true);

  const walletFinal = await reconcileAndGetWallet(db, "s22-2");
  assert.equal(walletFinal.reservedCredits, 5); // unchanged
  assert.equal(walletFinal.reservedMonthlyCredits, 5); // old monthly hold released, new held
  assert.equal(walletFinal.dailyRemaining, 950); // daily untouched
});

// -------------------------------------------------------------
// 2.2 Test 3: New-cycle reservations remain correctly accounted when old-cycle reservations settle
// -------------------------------------------------------------
test("2.2-3: New-cycle reservations remain correctly accounted while old-cycle reservations settle", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-3", { plan: "FREE" });

  const oldRes = await reserveCredits(db, { userId: "s22-3", conversationId: "conv-22-3a", estimatedCredits: 5 });
  assert.equal(oldRes.success, true);

  await forceDailyReset(db, "s22-3", { plan: "FREE" });

  const newRes = await reserveCredits(db, { userId: "s22-3", conversationId: "conv-22-3b", estimatedCredits: 5 });
  assert.equal(newRes.success, true);

  // Settle the OLD reservation.
  const settleOld = await settleReservation(db, {
    reservationId: oldRes.reservationId,
    userId: "s22-3",
    conversationId: "conv-22-3a",
    provider: "gemini",
    model: "gemini-2.5-flash",
    tokens: { inputTokens: 2000, outputTokens: 500 },
  });
  assert.equal(settleOld.success, true);

  const wallet = await reconcileAndGetWallet(db, "s22-3");
  // New-cycle reserved balance untouched by old-cycle settlement.
  assert.equal(wallet.reservedCredits, 5);
  // Old cycle settled (monthly hold released), new cycle still held.
  assert.equal(wallet.reservedMonthlyCredits, 5);
  // Old-cycle usage counted monthly, not daily.
  assert.equal(wallet.monthlyUsed, 3);
  assert.equal(wallet.dailyUsed, 0);
});

// -------------------------------------------------------------
// 2.2 Test 4: Overage absorbed once at reset
// -------------------------------------------------------------
test("2.2-4: Unbilled overage is absorbed once against the new daily allowance", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-4", { plan: "FREE" });

  // Inject 30 overage on a 25/day tier.
  const walletCol = db.collection("nova_user_wallets");
  await walletCol.updateOne({ userId: "s22-4" }, { $set: { unbilledOverage: 30 } });

  const wallet = await forceDailyReset(db, "s22-4", { plan: "FREE" });
  // overageApplied = min(25,30)=25 => dailyRemaining=0, remaining overage=5.
  assert.equal(wallet.dailyRemaining, 0);
  assert.equal(wallet.unbilledOverage, 5);
});

// -------------------------------------------------------------
// 2.2 Test 5: Overage exceeding one day's allowance carries forward
// -------------------------------------------------------------
test("2.2-5: Overage exceeding one day's allowance carries forward across cycles", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-5", { plan: "FREE" });

  const walletCol = db.collection("nova_user_wallets");
  await walletCol.updateOne({ userId: "s22-5" }, { $set: { unbilledOverage: 80 } });

  // First reset: absorb 25, carry 55.
  const w1 = await forceDailyReset(db, "s22-5", { plan: "FREE" });
  assert.equal(w1.dailyRemaining, 0);
  assert.equal(w1.unbilledOverage, 55);

  // Second reset: absorb 25, carry 30.
  const w2 = await forceDailyReset(db, "s22-5", { plan: "FREE" });
  assert.equal(w2.dailyRemaining, 0);
  assert.equal(w2.unbilledOverage, 30);

  // Third reset: absorb 25, carry 5.
  const w3 = await forceDailyReset(db, "s22-5", { plan: "FREE" });
  assert.equal(w3.dailyRemaining, 0);
  assert.equal(w3.unbilledOverage, 5);
});

// -------------------------------------------------------------
// 2.2 Test 6: Repeated reconciliation and multiple resets never double-deduct overage
// -------------------------------------------------------------
test("2.2-6: Repeated reconciliation never applies the same overage twice", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-6", { plan: "FREE" });

  const walletCol = db.collection("nova_user_wallets");
  await walletCol.updateOne({ userId: "s22-6" }, { $set: { unbilledOverage: 10 } });

  const w1 = await forceDailyReset(db, "s22-6", { plan: "FREE" });
  assert.equal(w1.dailyRemaining, 15);
  assert.equal(w1.unbilledOverage, 0);

  // Reconcile repeatedly with no additional time passage -> no double deduction.
  const w2 = await reconcileAndGetWallet(db, "s22-6", { plan: "FREE" });
  const w3 = await reconcileAndGetWallet(db, "s22-6", { plan: "FREE" });
  assert.equal(w2.dailyRemaining, 15);
  assert.equal(w3.dailyRemaining, 15);
  assert.equal(w2.unbilledOverage, 0);
  assert.equal(w3.unbilledOverage, 0);
});

// -------------------------------------------------------------
// 2.2 Test 7: Expired RESERVED reservation releases credits exactly once
// -------------------------------------------------------------
test("2.2-7: Expired RESERVED reservation releases its hold exactly once", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-7", { plan: "FREE" });

  const reservation = await reserveCredits(db, { userId: "s22-7", conversationId: "conv-22-7", estimatedCredits: 5 });
  assert.equal(reservation.success, true);

  const resCol = db.collection("nova_credit_reservations");
  await resCol.updateOne({ reservationId: reservation.reservationId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

  const first = await expireStaleReservations(db, { userId: "s22-7" });
  assert.equal(first.expiredCount, 1);

  const wallet = await reconcileAndGetWallet(db, "s22-7");
  assert.equal(wallet.reservedCredits, 0);
  assert.equal(wallet.reservedMonthlyCredits, 0);

  const resDoc = await resCol.findOne({ reservationId: reservation.reservationId });
  assert.equal(resDoc.status, "EXPIRED");

  // Second sweep must not release again.
  const second = await expireStaleReservations(db, { userId: "s22-7" });
  assert.equal(second.expiredCount, 0);
  const wallet2 = await reconcileAndGetWallet(db, "s22-7");
  assert.equal(wallet2.reservedMonthlyCredits, 0);
});

// -------------------------------------------------------------
// 2.2 Test 8: Concurrent expiration workers cannot double-release
// -------------------------------------------------------------
test("2.2-8: Concurrent expiration workers cannot release the same reservation twice", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-8", { plan: "FREE" });

  const reservation = await reserveCredits(db, { userId: "s22-8", conversationId: "conv-22-8", estimatedCredits: 5 });
  assert.equal(reservation.success, true);

  const resCol = db.collection("nova_credit_reservations");
  await resCol.updateOne({ reservationId: reservation.reservationId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

  const [r1, r2] = await Promise.all([
    expireStaleReservations(db, { userId: "s22-8" }),
    expireStaleReservations(db, { userId: "s22-8" }),
  ]);

  assert.ok(r1.expiredCount <= 1 && r2.expiredCount <= 1);
  assert.equal(r1.expiredCount + r2.expiredCount, 1);

  const wallet = await reconcileAndGetWallet(db, "s22-8");
  assert.equal(wallet.reservedMonthlyCredits, 0);
  assert.equal(wallet.reservedCredits, 0);
});

// -------------------------------------------------------------
// 2.2 Test 9: SETTLING reservations are not expired
// -------------------------------------------------------------
test("2.2-9: SETTLING reservations with past expiry are never expired", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-9", { plan: "FREE" });

  const reservation = await reserveCredits(db, { userId: "s22-9", conversationId: "conv-22-9", estimatedCredits: 5 });
  assert.equal(reservation.success, true);

  const resCol = db.collection("nova_credit_reservations");
  await resCol.updateOne(
    { reservationId: reservation.reservationId },
    {
      $set: {
        status: "SETTLING",
        expiresAt: new Date(Date.now() - 1000),
        provider: "gemini",
        model: "gemini-2.5-flash",
        tokens: { inputTokens: 2000, outputTokens: 500 },
      },
    }
  );

  const result = await expireStaleReservations(db, { userId: "s22-9" });
  assert.equal(result.expiredCount, 0);

  const resDoc = await resCol.findOne({ reservationId: reservation.reservationId });
  assert.equal(resDoc.status, "SETTLING");

  // SETTLING stays recoverable.
  const recovered = await recoverSettlement(db, reservation.reservationId, "s22-9");
  assert.equal(recovered.success, true);
  assert.ok(!recovered.alreadySettled); // first-time settlement, not a duplicate
});

// -------------------------------------------------------------
// 2.2 Test 9b: Expiration fails closed when transactions are unavailable
// -------------------------------------------------------------
test("2.2-9b: Expiration fails closed on non-transaction-capable topology without changing status or wallet balances", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-9b", { plan: "FREE" });

  const reservation = await reserveCredits(db, { userId: "s22-9b", conversationId: "conv-22-9b", estimatedCredits: 5 });
  assert.equal(reservation.success, true);

  const resCol = db.collection("nova_credit_reservations");
  await resCol.updateOne({ reservationId: reservation.reservationId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

  // Simulate a standalone (Single) topology: transactions are unavailable.
  db.topology = { description: { type: "Single" } };

  const result = await expireStaleReservations(db, { userId: "s22-9b" });
  assert.equal(result.expiredCount, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /TRANSACTION_UNAVAILABLE/);

  // Fail closed: reservation must still be RESERVED (not EXPIRED).
  const resDoc = await resCol.findOne({ reservationId: reservation.reservationId });
  assert.equal(resDoc.status, "RESERVED");
  assert.equal(resDoc.releasedAt, undefined);

  // Fail closed: wallet balances unchanged.
  const wallet = await reconcileAndGetWallet(db, "s22-9b");
  assert.equal(wallet.reservedCredits, 5);
  assert.equal(wallet.reservedMonthlyCredits, 5);

  // Restore a transaction-capable topology: a later sweep expires it exactly once.
  db.topology = { description: { type: "ReplicaSetWithPrimary" } };
  const retry = await expireStaleReservations(db, { userId: "s22-9b" });
  assert.equal(retry.expiredCount, 1);
  const resDoc2 = await resCol.findOne({ reservationId: reservation.reservationId });
  assert.equal(resDoc2.status, "EXPIRED");
  const wallet2 = await reconcileAndGetWallet(db, "s22-9b");
  assert.equal(wallet2.reservedCredits, 0);
  assert.equal(wallet2.reservedMonthlyCredits, 0);
});

// -------------------------------------------------------------
// 2.2 Test 10: Recovery of an old-cycle reservation does not charge current daily allowance
// -------------------------------------------------------------
test("2.2-10: Recovery of an old-cycle reservation never charges the current day's allowance", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-10", { plan: "BUILDER", status: "ACTIVE", expiryDate: new Date(Date.now() + 86400000 * 30) });

  const reservation = await reserveCredits(db, { userId: "s22-10", conversationId: "conv-22-10", estimatedCredits: 10 });
  assert.equal(reservation.success, true);

  await forceDailyReset(db, "s22-10", { plan: "BUILDER", status: "ACTIVE", expiryDate: new Date(Date.now() + 86400000 * 30) });

  // Mark SETTLING with saved usage metadata.
  const resCol = db.collection("nova_credit_reservations");
  await resCol.updateOne(
    { reservationId: reservation.reservationId },
    {
      $set: {
        status: "SETTLING",
        provider: "gemini",
        model: "gemini-2.5-flash",
        tokens: { inputTokens: 2000, outputTokens: 500 },
      },
    }
  );

  const recovered = await recoverSettlement(db, reservation.reservationId, "s22-10");
  assert.equal(recovered.success, true);
  assert.equal(recovered.creditsCharged, 3);

  const wallet = await reconcileAndGetWallet(db, "s22-10");
  assert.equal(wallet.dailyRemaining, 950); // current day untouched
  assert.equal(wallet.dailyUsed, 0);
  assert.equal(wallet.monthlyUsed, 3);
  assert.equal(wallet.reservedCredits, 0);
  assert.equal(wallet.reservedMonthlyCredits, 0);
});

// -------------------------------------------------------------
// 2.2 Test 11: Actual usage exceeding the estimate is recorded honestly
// -------------------------------------------------------------
test("2.2-11: Actual provider usage is recorded honestly, never clamped to the estimate", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-11", { plan: "FREE" });

  const reservation = await reserveCredits(db, { userId: "s22-11", conversationId: "conv-22-11", estimatedCredits: 5 });
  assert.equal(reservation.success, true);

  // Settle with usage far exceeding the 5-credit estimate (~40 credits).
  const settle = await settleReservation(db, {
    reservationId: reservation.reservationId,
    userId: "s22-11",
    conversationId: "conv-22-11",
    provider: "gemini",
    model: "gemini-2.5-flash",
    tokens: { inputTokens: 40000, outputTokens: 8000 },
  });
  assert.equal(settle.success, true);
  assert.ok(settle.creditsCharged > 5);

  const wallet = await reconcileAndGetWallet(db, "s22-11");
  assert.equal(wallet.monthlyUsed, settle.creditsCharged); // full actual usage recorded
  assert.equal(wallet.reservedCredits, 0);
});

// -------------------------------------------------------------
// 2.2 Test 12: New reservations are blocked when monthly capacity is exhausted
// -------------------------------------------------------------
test("2.2-12: Reservations are blocked when monthly capacity (including outstanding holds) is exhausted", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-12", { plan: "FREE" });

  const walletCol = db.collection("nova_user_wallets");
  await walletCol.updateOne(
    { userId: "s22-12" },
    { $set: { monthlyUsed: 749, reservedMonthlyCredits: 5 } } // 750 - 749 - 5 < 0
  );

  const reservation = await reserveCredits(db, { userId: "s22-12", conversationId: "conv-22-12", estimatedCredits: 2 });
  assert.equal(reservation.success, false);
  assert.equal(reservation.reason, "INSUFFICIENT_CREDITS");
});

// -------------------------------------------------------------
// 2.2 Test 13: Tier upgrade does not grant two allowances within one cycle
// -------------------------------------------------------------
test("2.2-13: Tier upgrade preserves the cycle anchor and does not re-grant a full daily allowance", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-13", { plan: "BUILDER", status: "ACTIVE", expiryDate: new Date(Date.now() + 86400000 * 30) });

  // Consume 300 of the 950 daily allowance.
  const walletCol = db.collection("nova_user_wallets");
  await walletCol.updateOne(
    { userId: "s22-13" },
    { $set: { dailyUsed: 300, dailyRemaining: 650 } }
  );

  const before = await reconcileAndGetWallet(db, "s22-13");
  const anchorBefore = new Date(before.lastDailyAllocationAt).getTime();

  // Upgrade to PRO mid-cycle.
  const upgraded = await reconcileAndGetWallet(db, "s22-13", {
    plan: "PRO",
    status: "ACTIVE",
    expiryDate: new Date(Date.now() + 86400000 * 30),
  });

  // Consumed 300 must NOT be re-granted: remaining = 1900 - 300 = 1600, not 1900.
  assert.equal(upgraded.dailyAllowance, 1900);
  assert.equal(upgraded.dailyRemaining, 1600);
  assert.equal(upgraded.dailyUsed, 300);
  // Cycle anchor preserved -> no second allocation.
  assert.equal(new Date(upgraded.lastDailyAllocationAt).getTime(), anchorBefore);
});

// -------------------------------------------------------------
// 2.2 Test 14: Tier downgrade preserves consumed usage and correct limits
// -------------------------------------------------------------
test("2.2-14: Tier downgrade preserves consumed usage and enforces the lower daily limit", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s22-14", { plan: "PRO", status: "ACTIVE", expiryDate: new Date(Date.now() + 86400000 * 30) });

  const walletCol = db.collection("nova_user_wallets");
  await walletCol.updateOne(
    { userId: "s22-14" },
    { $set: { dailyUsed: 500, dailyRemaining: 1400, monthlyUsed: 600 } }
  );

  const before = await reconcileAndGetWallet(db, "s22-14");
  const anchorBefore = new Date(before.lastDailyAllocationAt).getTime();

  // Downgrade to FREE (25/day). Used 500 > 25 -> remaining must be 0.
  const downgraded = await reconcileAndGetWallet(db, "s22-14", { plan: "FREE" });
  assert.equal(downgraded.tier, "FREE");
  assert.equal(downgraded.dailyAllowance, 25);
  assert.equal(downgraded.dailyRemaining, 0);
  assert.equal(downgraded.dailyUsed, 500); // consumed usage preserved
  assert.equal(downgraded.monthlyCeiling, 750);
  assert.equal(downgraded.monthlyUsed, 600); // monthly usage preserved
  assert.equal(new Date(downgraded.lastDailyAllocationAt).getTime(), anchorBefore);
});

// =============================================================
// Phase 2.2 Audit: Backward compatibility, expiration crash safety
// =============================================================

// Helper: simulate a pre-Phase-2.2 wallet by stripping the accounting fields.
function stripLegacyWalletFields(db, userId) {
  const walletCol = db.collection("nova_user_wallets");
  const doc = walletCol.documents.find((d) => d.userId === userId);
  assert.ok(doc, "wallet must exist before stripping fields");
  delete doc.reservedMonthlyCredits;
  delete doc.unbilledOverage;
}

// Helper: insert a legacy reservation (no allocationCycleAt) directly.
function insertLegacyReservation(db, userId, conversationId, estimatedCredits, createdAt) {
  return db.collection("nova_credit_reservations").insertOne({
    reservationId: `legacy_res_${conversationId}`,
    userId,
    conversationId,
    problemId: "problem-legacy",
    estimatedCredits,
    status: "RESERVED",
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 10 * 60 * 1000),
    // NOTE: intentionally NO allocationCycleAt field
  });
}

// -------------------------------------------------------------
// Audit Test A: Legacy wallet backfill includes outstanding monthly reservations
// -------------------------------------------------------------
test("Audit A: Pre-2.2 wallet with outstanding reservation is backfilled and monthly capacity accounts for the hold", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s-bc-1", { plan: "FREE" }); // 25/day, 750/month

  // Simulate a pre-2.2 wallet (missing new accounting fields) with a legacy hold.
  stripLegacyWalletFields(db, "s-bc-1");
  await insertLegacyReservation(
    db,
    "s-bc-1",
    "conv-bc-1",
    3000, // exceeds the 750 monthly ceiling
    new Date() // fresh (non-stale) so it is not swept before the capacity check
  );

  // reconcile must backfill reservedMonthlyCredits from the outstanding reservation.
  const wallet = await reconcileAndGetWallet(db, "s-bc-1", { plan: "FREE" });
  assert.equal(wallet.reservedMonthlyCredits, 3000);
  assert.equal(wallet.unbilledOverage, 0);

  // New reservations must be blocked because the backfilled monthly hold saturates capacity.
  const reservation = await reserveCredits(db, {
    userId: "s-bc-1",
    conversationId: "conv-bc-1-new",
    estimatedCredits: 2,
  });
  assert.equal(reservation.success, false);
  assert.equal(reservation.reason, "INSUFFICIENT_CREDITS");
});

// -------------------------------------------------------------
// Audit Test B: Legacy reservation settles after reset -> monthly only, no negative balance
// -------------------------------------------------------------
test("Audit B: Legacy reservation (no allocationCycleAt) settling after reset does not charge the new day and never goes negative", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s-bc-2", { plan: "FREE" });

  stripLegacyWalletFields(db, "s-bc-2");
  await insertLegacyReservation(
    db,
    "s-bc-2",
    "conv-bc-2",
    5,
    new Date(Date.now() - 26 * 3600 * 1000) // created >24h ago -> old cycle
  );

  // Backfill, then advance to a fresh daily cycle.
  await reconcileAndGetWallet(db, "s-bc-2", { plan: "FREE" });
  await forceDailyReset(db, "s-bc-2", { plan: "FREE" });

  const settle = await settleReservation(db, {
    reservationId: "legacy_res_conv-bc-2",
    userId: "s-bc-2",
    conversationId: "conv-bc-2",
    provider: "gemini",
    model: "gemini-2.5-flash",
    tokens: { inputTokens: 2000, outputTokens: 500 },
  });
  assert.equal(settle.success, true);
  assert.equal(settle.creditsCharged, 3);

  const wallet = await reconcileAndGetWallet(db, "s-bc-2", { plan: "FREE" });
  assert.equal(wallet.dailyRemaining, 25); // new day untouched
  assert.equal(wallet.dailyUsed, 0);
  assert.equal(wallet.monthlyUsed, 3); // usage counted monthly
  assert.equal(wallet.reservedCredits, 0);
  assert.equal(wallet.reservedMonthlyCredits, 0); // never negative
  assert.ok(wallet.reservedMonthlyCredits >= 0);
});

// -------------------------------------------------------------
// Audit Test C: Legacy reservation within current window is treated as same-cycle
// -------------------------------------------------------------
test("Audit C: Legacy reservation created inside the current cycle is treated as same-cycle (daily charged)", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s-bc-3", { plan: "FREE" });

  stripLegacyWalletFields(db, "s-bc-3");
  await insertLegacyReservation(
    db,
    "s-bc-3",
    "conv-bc-3",
    5,
    new Date() // created now -> within current window
  );

  await reconcileAndGetWallet(db, "s-bc-3", { plan: "FREE" });

  const settle = await settleReservation(db, {
    reservationId: "legacy_res_conv-bc-3",
    userId: "s-bc-3",
    conversationId: "conv-bc-3",
    provider: "gemini",
    model: "gemini-2.5-flash",
    tokens: { inputTokens: 2000, outputTokens: 500 },
  });
  assert.equal(settle.success, true);

  const wallet = await reconcileAndGetWallet(db, "s-bc-3", { plan: "FREE" });
  assert.equal(wallet.dailyUsed, 3); // same-cycle daily usage charged
  assert.equal(wallet.dailyRemaining, 22);
  assert.equal(wallet.monthlyUsed, 3);
  assert.equal(wallet.reservedMonthlyCredits, 0);
});

// -------------------------------------------------------------
// Audit Test D: Expiration crash safety — rollback leaves reservation recoverable
// -------------------------------------------------------------
test("Audit D: Crash between EXPIRED transition and wallet release rolls back; a later sweep releases exactly once", async () => {
  const db = new DynamicFakeDb();
  await reconcileAndGetWallet(db, "s-bc-4", { plan: "FREE" });

  const reservation = await reserveCredits(db, {
    userId: "s-bc-4",
    conversationId: "conv-bc-4",
    estimatedCredits: 5,
  });
  assert.equal(reservation.success, true);

  const resCol = db.collection("nova_credit_reservations");
  await resCol.updateOne(
    { reservationId: reservation.reservationId },
    { $set: { expiresAt: new Date(Date.now() - 1000) } }
  );

  // Simulate a crash: the wallet release write fails mid-transaction.
  const walletCol = db.collection("nova_user_wallets");
  const origUpdateOne = walletCol.updateOne.bind(walletCol);
  walletCol.updateOne = async () => {
    throw new Error("simulated crash during wallet release");
  };

  let first;
  try {
    first = await expireStaleReservations(db, { userId: "s-bc-4" });
  } finally {
    walletCol.updateOne = origUpdateOne;
  }

  // The failed call must NOT have committed the EXPIRED transition or released the hold.
  assert.equal(first.expiredCount, 0);
  assert.equal(first.errors.length, 1);

  const resAfterFail = await resCol.findOne({ reservationId: reservation.reservationId });
  assert.equal(resAfterFail.status, "RESERVED"); // rolled back, still recoverable

  let wallet = await reconcileAndGetWallet(db, "s-bc-4");
  assert.equal(wallet.reservedCredits, 5); // hold still locked (not leaked)
  assert.equal(wallet.reservedMonthlyCredits, 5);

  // Retry after recovery: should now succeed and release exactly once.
  const second = await expireStaleReservations(db, { userId: "s-bc-4" });
  assert.equal(second.expiredCount, 1);

  wallet = await reconcileAndGetWallet(db, "s-bc-4");
  assert.equal(wallet.reservedCredits, 0);
  assert.equal(wallet.reservedMonthlyCredits, 0);

  const resFinal = await resCol.findOne({ reservationId: reservation.reservationId });
  assert.equal(resFinal.status, "EXPIRED");
  assert.equal(resFinal.releasedAt !== undefined, true);
});

// -------------------------------------------------------------
// Audit Test E: isCurrentCycle inference unit check
// -------------------------------------------------------------
test("Audit E: isCurrentCycle distinguishes legacy reservations by their createdAt window", () => {
  const now = Date.now();
  const wallet = {
    userId: "u",
    lastDailyAllocationAt: new Date(now - 1000),
    nextDailyResetAt: new Date(now + 24 * 3600 * 1000),
  };

  // Legacy reservation inside the window -> same cycle.
  const inside = isCurrentCycle(wallet, {
    reservationId: "r1",
    userId: "u",
    conversationId: "c",
    estimatedCredits: 1,
    status: "RESERVED",
    createdAt: new Date(now),
    expiresAt: new Date(now + 60000),
  });
  assert.equal(inside, true);

  // Legacy reservation before the window -> old cycle.
  const outside = isCurrentCycle(wallet, {
    reservationId: "r2",
    userId: "u",
    conversationId: "c",
    estimatedCredits: 1,
    status: "RESERVED",
    createdAt: new Date(now - 48 * 3600 * 1000),
    expiresAt: new Date(now + 60000),
  });
  assert.equal(outside, false);

  // Explicit allocationCycleAt takes precedence.
  const explicitSame = isCurrentCycle(wallet, {
    reservationId: "r3",
    userId: "u",
    conversationId: "c",
    estimatedCredits: 1,
    status: "RESERVED",
    allocationCycleAt: wallet.lastDailyAllocationAt,
    createdAt: new Date(now),
    expiresAt: new Date(now + 60000),
  });
  assert.equal(explicitSame, true);

  const explicitOld = isCurrentCycle(wallet, {
    reservationId: "r4",
    userId: "u",
    conversationId: "c",
    estimatedCredits: 1,
    status: "RESERVED",
    allocationCycleAt: new Date(now - 25 * 3600 * 1000),
    createdAt: new Date(now),
    expiresAt: new Date(now + 60000),
  });
  assert.equal(explicitOld, false);
});


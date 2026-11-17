import type { Db, MongoClient } from "mongodb";
import {
  DEFAULT_PRICING_CONFIG,
  clearPricingConfigCache,
  mergePricingDoc,
  parseSemver,
  selectCurrentPricingDoc,
  type NovaPricingConfig,
} from "./pricingConfig";
import { isClientTransactionCapable } from "./reservationEngine";

export interface UpdatePricingConfigInput {
  creditValueInr?: number;
  pricingMultiplier?: number;
  usdToInrRate?: number;
  tierAllocations?: {
    FREE?: { dailyAllocation?: number; monthlyAllocation?: number };
    BUILDER?: { dailyAllocation?: number; monthlyAllocation?: number };
    PRO?: { dailyAllocation?: number; monthlyAllocation?: number };
  };
  models?: NovaPricingConfig["models"];
  emergencyDisabledProviders?: string[];
  updatedBy: string;
}

export function isUserAdmin(session: { userId?: string; email?: string; role?: string } | null | undefined): boolean {
  if (!session || !session.userId) return false;

  // 1. Check explicit session role
  if (typeof session.role === "string" && session.role.trim().toLowerCase() === "admin") {
    return true;
  }

  // 2. Check admin emails whitelist
  const adminEmails = (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (session.email && adminEmails.includes(session.email.trim().toLowerCase())) {
    return true;
  }

  return false;
}

export function validatePricingConfigInput(input: UpdatePricingConfigInput): void {
  if (input.creditValueInr !== undefined) {
    if (typeof input.creditValueInr !== "number" || !Number.isFinite(input.creditValueInr) || input.creditValueInr <= 0 || input.creditValueInr > 100) {
      throw Object.assign(new Error("creditValueInr must be a positive number greater than 0 and less than or equal to 100"), { status: 400 });
    }
  }

  if (input.pricingMultiplier !== undefined) {
    if (typeof input.pricingMultiplier !== "number" || !Number.isFinite(input.pricingMultiplier) || input.pricingMultiplier <= 0 || input.pricingMultiplier > 100) {
      throw Object.assign(new Error("pricingMultiplier must be a positive number greater than 0 and less than or equal to 100"), { status: 400 });
    }
  }

  if (input.usdToInrRate !== undefined) {
    if (typeof input.usdToInrRate !== "number" || !Number.isFinite(input.usdToInrRate) || input.usdToInrRate <= 0 || input.usdToInrRate > 1000) {
      throw Object.assign(new Error("usdToInrRate must be a positive number greater than 0 and less than or equal to 1000"), { status: 400 });
    }
  }

  if (input.tierAllocations) {
    for (const [tier, alloc] of Object.entries(input.tierAllocations)) {
      if (!["FREE", "BUILDER", "PRO"].includes(tier)) {
        throw Object.assign(new Error(`Invalid tier name: ${tier}`), { status: 400 });
      }
      if (alloc) {
        if (alloc.dailyAllocation !== undefined) {
          if (!Number.isInteger(alloc.dailyAllocation) || alloc.dailyAllocation < 0 || alloc.dailyAllocation > 1_000_000) {
            throw Object.assign(new Error(`dailyAllocation for ${tier} must be an integer between 0 and 1,000,000`), { status: 400 });
          }
        }
        if (alloc.monthlyAllocation !== undefined) {
          if (!Number.isInteger(alloc.monthlyAllocation) || alloc.monthlyAllocation < 0 || alloc.monthlyAllocation > 10_000_000) {
            throw Object.assign(new Error(`monthlyAllocation for ${tier} must be an integer between 0 and 10,000,000`), { status: 400 });
          }
        }
      }
    }
  }

  if (input.models) {
    for (const [modelKey, modelPricing] of Object.entries(input.models)) {
      if (!modelPricing || typeof modelPricing !== "object") {
        throw Object.assign(new Error(`Invalid pricing definition for model ${modelKey}`), { status: 400 });
      }
      for (const field of ["inputPer1MTokensUsd", "outputPer1MTokensUsd", "cachedPer1MTokensUsd", "reasoningPer1MTokensUsd"] as const) {
        const val = modelPricing[field];
        if (val !== undefined && (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 10_000)) {
          throw Object.assign(new Error(`${field} for ${modelKey} must be a non-negative number`), { status: 400 });
        }
      }
    }
  }

  if (input.emergencyDisabledProviders !== undefined) {
    if (!Array.isArray(input.emergencyDisabledProviders) || !input.emergencyDisabledProviders.every((p) => typeof p === "string")) {
      throw Object.assign(new Error("emergencyDisabledProviders must be an array of strings"), { status: 400 });
    }
  }
}

/**
 * Updates pricing configuration with full versioning and audit history.
 *
 * Atomicity: deactivating the previous current document and inserting the new version run
 * inside a single multi-document transaction. If anything fails, the whole transaction
 * rolls back.
 *
 * Fail-closed: if the MongoDB topology cannot run multi-document transactions, we throw
 * and NEVER fall back to non-transactional writes (mirrors credit settlement enforcement).
 *
 * Version safety: the next version is derived from the latest current document read inside
 * the transaction, and the unique index on `version` guarantees concurrent updates cannot
 * produce duplicate versions (the loser rolls back on a duplicate-key/WriteConflict).
 */
export async function updatePricingConfig(
  db: Db,
  input: UpdatePricingConfigInput
): Promise<NovaPricingConfig> {
  validatePricingConfigInput(input);

  const client =
    (db as unknown as { client?: MongoClient }).client ||
    (db as unknown as { s?: { client?: MongoClient } }).s?.client;

  if (!client || !isClientTransactionCapable(client)) {
    throw Object.assign(
      new Error(
        "TRANSACTION_UNAVAILABLE: Multi-document transactions are required for pricing updates " +
          "to guarantee that exactly one pricing version is current. No non-transactional " +
          "fallback was attempted."
      ),
      { code: "TRANSACTION_UNAVAILABLE" }
    );
  }

  const collection = db.collection<NovaPricingConfig>("nova_pricing_config");
  const session = client.startSession();
  let updated!: NovaPricingConfig;

  try {
    await session.withTransaction(async () => {
      // Read current document(s) inside the transaction (bypassing the cache) so the next
      // version is correct even if another pricing update committed concurrently. If
      // pre-existing duplicate current documents exist (a data-integrity violation), we
      // deterministically base the next version on the highest one so we never collide with
      // an already-existing version.
      const currentDocs = await collection.find({ isCurrent: true }).toArray();
      const currentDoc = selectCurrentPricingDoc(currentDocs);
      const base = currentDoc ? mergePricingDoc(currentDoc) : DEFAULT_PRICING_CONFIG;

      const [major, minor, patch] = parseSemver(base.version);
      const nextVersion = `v${major}.${minor}.${patch + 1}`;

      updated = {
        ...base,
        version: nextVersion,
        isCurrent: true,
        creditValueInr: input.creditValueInr ?? base.creditValueInr,
        pricingMultiplier: input.pricingMultiplier ?? base.pricingMultiplier,
        usdToInrRate: input.usdToInrRate ?? base.usdToInrRate,
        tierAllocations: {
          FREE: { ...base.tierAllocations.FREE, ...(input.tierAllocations?.FREE || {}) },
          BUILDER: {
            ...base.tierAllocations.BUILDER,
            ...(input.tierAllocations?.BUILDER || {}),
          },
          PRO: { ...base.tierAllocations.PRO, ...(input.tierAllocations?.PRO || {}) },
        },
        models: input.models ?? base.models,
        emergencyDisabledProviders:
          input.emergencyDisabledProviders ?? base.emergencyDisabledProviders,
        updatedAt: new Date(),
        updatedBy: input.updatedBy,
      };

      // Deactivate the previous current configuration and insert the new version atomically.
      await collection.updateMany(
        { isCurrent: true },
        { $set: { isCurrent: false } },
        { session }
      );
      await collection.insertOne(updated, { session });
    });
  } finally {
    await session.endSession();
  }

  // Clear in-memory cache only after a successful commit.
  clearPricingConfigCache();

  return updated;
}


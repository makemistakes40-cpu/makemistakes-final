import type { Db } from "mongodb";
import {
  clearPricingConfigCache,
  getEffectivePricingConfig,
  type NovaPricingConfig,
} from "./pricingConfig";

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
 * Never requires code deployment to adjust pricing or disable a failing provider.
 */
export async function updatePricingConfig(
  db: Db,
  input: UpdatePricingConfigInput
): Promise<NovaPricingConfig> {
  validatePricingConfigInput(input);
  const current = await getEffectivePricingConfig(db);
  const now = new Date();

  // Generate new semver version
  const [major, minor, patch] = current.version.replace(/^v/, "").split(".").map(Number);
  const nextVersion = `v${major}.${minor}.${(patch || 0) + 1}`;

  const updated: NovaPricingConfig = {
    ...current,
    version: nextVersion,
    isCurrent: true,
    creditValueInr: input.creditValueInr ?? current.creditValueInr,
    pricingMultiplier: input.pricingMultiplier ?? current.pricingMultiplier,
    usdToInrRate: input.usdToInrRate ?? current.usdToInrRate,
    tierAllocations: {
      FREE: {
        ...current.tierAllocations.FREE,
        ...(input.tierAllocations?.FREE || {}),
      },
      BUILDER: {
        ...current.tierAllocations.BUILDER,
        ...(input.tierAllocations?.BUILDER || {}),
      },
      PRO: {
        ...current.tierAllocations.PRO,
        ...(input.tierAllocations?.PRO || {}),
      },
    },
    models: input.models ?? current.models,
    emergencyDisabledProviders:
      input.emergencyDisabledProviders ?? current.emergencyDisabledProviders,
    updatedAt: now,
    updatedBy: input.updatedBy,
  };

  const collection = db.collection<NovaPricingConfig>("nova_pricing_config");

  // Mark prior configs as not current
  await collection.updateMany({ isCurrent: true }, { $set: { isCurrent: false } });

  // Insert new version
  await collection.insertOne(updated);

  // Clear in-memory cache
  clearPricingConfigCache();

  return updated;
}


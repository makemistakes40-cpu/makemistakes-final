import type { Db } from "mongodb";

export interface ModelPricing {
  provider: string;
  model: string;
  inputPer1MTokensUsd: number;
  outputPer1MTokensUsd: number;
  cachedPer1MTokensUsd?: number;
  reasoningPer1MTokensUsd?: number;
  perImageUsd?: number;
}

export interface TierAllocationConfig {
  dailyAllocation: number;
  monthlyAllocation: number;
  monthlyPriceInr: number;
  rollingWindowHours: number;
  allowRollover: boolean;
}

export interface NovaPricingConfig {
  version: string;
  isCurrent: boolean;
  creditValueInr: number; // e.g. 0.01 INR per credit
  pricingMultiplier: number; // default 1.0 (configurable)
  usdToInrRate: number; // e.g. 84.5
  targetAiExpenditureRatio: number; // 0.20 (20% of net receipts)
  tierAllocations: {
    FREE: TierAllocationConfig;
    BUILDER: TierAllocationConfig;
    PRO: TierAllocationConfig;
  };
  models: Record<string, ModelPricing>;
  emergencyDisabledProviders: string[];
  updatedAt: Date;
  updatedBy?: string;
}

export const DEFAULT_PRICING_CONFIG: NovaPricingConfig = {
  version: "v1.0.0",
  isCurrent: true,
  creditValueInr: 0.01, // 1 Nova credit = ₹0.01 of provider expenditure
  pricingMultiplier: 1.0,
  usdToInrRate: 84.5,
  targetAiExpenditureRatio: 0.2, // 20% target
  tierAllocations: {
    FREE: {
      dailyAllocation: 25,
      monthlyAllocation: 750,
      monthlyPriceInr: 0,
      rollingWindowHours: 24,
      allowRollover: false,
    },
    BUILDER: {
      dailyAllocation: 950,
      monthlyAllocation: 28500,
      monthlyPriceInr: 1799,
      rollingWindowHours: 24,
      allowRollover: false,
    },
    PRO: {
      dailyAllocation: 1900,
      monthlyAllocation: 57000,
      monthlyPriceInr: 3499,
      rollingWindowHours: 24,
      allowRollover: false,
    },
  },
  models: {
    "gemini-2.5-flash": {
      provider: "gemini",
      model: "gemini-2.5-flash",
      inputPer1MTokensUsd: 0.075,
      outputPer1MTokensUsd: 0.3,
      cachedPer1MTokensUsd: 0.01875,
    },
    "qwen/qwen3.6-27b": {
      provider: "groq",
      model: "qwen/qwen3.6-27b",
      inputPer1MTokensUsd: 0.2,
      outputPer1MTokensUsd: 0.2,
    },
    "gpt-4o-mini": {
      provider: "openai",
      model: "gpt-4o-mini",
      inputPer1MTokensUsd: 0.15,
      outputPer1MTokensUsd: 0.6,
      cachedPer1MTokensUsd: 0.075,
    },
    "openrouter/auto": {
      provider: "openrouter",
      model: "openrouter/auto",
      inputPer1MTokensUsd: 0.5,
      outputPer1MTokensUsd: 1.5,
    },
  },
  emergencyDisabledProviders: [],
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

let cachedConfig: NovaPricingConfig | null = null;
let lastCacheFetchTime = 0;
const CACHE_TTL_MS = 60_000; // 1 minute in-memory cache

export async function getEffectivePricingConfig(db?: Db | null): Promise<NovaPricingConfig> {
  const now = Date.now();
  if (cachedConfig && now - lastCacheFetchTime < CACHE_TTL_MS) {
    return cachedConfig;
  }

  if (db) {
    try {
      const doc = await db.collection<NovaPricingConfig>("nova_pricing_config").findOne({ isCurrent: true });
      if (doc) {
        cachedConfig = {
          ...DEFAULT_PRICING_CONFIG,
          ...doc,
          tierAllocations: {
            ...DEFAULT_PRICING_CONFIG.tierAllocations,
            ...(doc.tierAllocations || {}),
          },
          models: {
            ...DEFAULT_PRICING_CONFIG.models,
            ...(doc.models || {}),
          },
        };
        lastCacheFetchTime = now;
        return cachedConfig;
      }
    } catch {
      // In-memory fallback if collection or DB error
    }
  }

  cachedConfig = DEFAULT_PRICING_CONFIG;
  lastCacheFetchTime = now;
  return cachedConfig;
}

export function clearPricingConfigCache(): void {
  cachedConfig = null;
  lastCacheFetchTime = 0;
}

export interface TokenUsageCounts {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}

export interface CostAndCreditResult {
  actualCostUsd: number;
  actualCostInr: number;
  creditsCharged: number;
  pricingConfigVersion: string;
  usdToInrRate: number;
  pricingMultiplier: number;
  creditValueInr: number;
}

/**
 * Calculates provider expenditure and required Nova credits.
 * Formula:
 * C = Sum of (token quantity * applicable price per token) converted to INR.
 * Credits = CEILING((C * pricing multiplier) / credit value)
 */
export function calculateActualCostAndCredits(
  provider: string,
  model: string,
  tokens: TokenUsageCounts,
  config: NovaPricingConfig = DEFAULT_PRICING_CONFIG
): CostAndCreditResult {
  const modelKey = model.toLowerCase();
  const pricing =
    config.models[model] ||
    config.models[modelKey] ||
    Object.values(config.models).find(
      (m) => m.model.toLowerCase() === modelKey || m.provider.toLowerCase() === provider.toLowerCase()
    ) || {
      provider,
      model,
      inputPer1MTokensUsd: 0.15,
      outputPer1MTokensUsd: 0.6,
      cachedPer1MTokensUsd: 0.05,
      reasoningPer1MTokensUsd: 0.6,
    };

  const inputCostUsd = ((tokens.inputTokens || 0) / 1_000_000) * pricing.inputPer1MTokensUsd;
  const outputCostUsd = ((tokens.outputTokens || 0) / 1_000_000) * pricing.outputPer1MTokensUsd;
  const cachedCostUsd = ((tokens.cachedTokens || 0) / 1_000_000) * (pricing.cachedPer1MTokensUsd ?? pricing.inputPer1MTokensUsd * 0.5);
  const reasoningCostUsd = ((tokens.reasoningTokens || 0) / 1_000_000) * (pricing.reasoningPer1MTokensUsd ?? pricing.outputPer1MTokensUsd);

  const actualCostUsd = inputCostUsd + outputCostUsd + cachedCostUsd + reasoningCostUsd;
  const actualCostInr = actualCostUsd * config.usdToInrRate;

  // Credit conversion formula: CEILING((C * pricing multiplier) / credit value)
  const rawCredits = (actualCostInr * config.pricingMultiplier) / config.creditValueInr;
  const creditsCharged = Math.max(1, Math.ceil(rawCredits));

  return {
    actualCostUsd,
    actualCostInr,
    creditsCharged,
    pricingConfigVersion: config.version,
    usdToInrRate: config.usdToInrRate,
    pricingMultiplier: config.pricingMultiplier,
    creditValueInr: config.creditValueInr,
  };
}


import type { SubscriptionTier } from "./allocationEngine";
import { type NovaPricingConfig, getEffectivePricingConfig } from "./pricingConfig";

export interface ModelRouteResult {
  allowedProviders: Array<{
    provider: "gemini" | "groq" | "openrouter" | "openai";
    model: string;
    maxTokens: number;
    temperature: number;
    isReasoningModel?: boolean;
  }>;
  reasoningAllowed: boolean;
  maxOutputTokens: number;
  tier: SubscriptionTier;
}

export interface RouteRequestInput {
  tier: SubscriptionTier;
  mentorMode?: string;
  capability?: string;
  config?: NovaPricingConfig;
}

/**
 * Routes requests to allowable models and providers according to subscription tier.
 * Ensures Free tier cannot access expensive reasoning models.
 * Filters out emergency disabled providers.
 */
export function routeModelForTier(input: RouteRequestInput): ModelRouteResult {
  const { tier, mentorMode } = input;
  const disabled = new Set(
    (input.config?.emergencyDisabledProviders || []).map((p) => p.toLowerCase())
  );

  const mode = (mentorMode || "UNDERSTAND").toUpperCase();

  // Tier 1: Free
  if (tier === "FREE") {
    const list: ModelRouteResult["allowedProviders"] = [];
    if (!disabled.has("gemini")) {
      list.push({
        provider: "gemini",
        model: "gemini-2.5-flash",
        maxTokens: 1000,
        temperature: 0.6,
      });
    }
    if (!disabled.has("groq")) {
      list.push({
        provider: "groq",
        model: "qwen/qwen3.6-27b",
        maxTokens: 1000,
        temperature: 0.6,
      });
    }

    return {
      allowedProviders: list,
      reasoningAllowed: false,
      maxOutputTokens: 1000,
      tier,
    };
  }

  // Tier 2: Builder
  if (tier === "BUILDER") {
    const list: ModelRouteResult["allowedProviders"] = [];
    if (!disabled.has("groq")) {
      list.push({
        provider: "groq",
        model: "qwen/qwen3.6-27b",
        maxTokens: 1800,
        temperature: 0.55,
      });
    }
    if (!disabled.has("gemini")) {
      list.push({
        provider: "gemini",
        model: "gemini-2.5-flash",
        maxTokens: 1800,
        temperature: 0.55,
      });
    }
    if (!disabled.has("openrouter")) {
      list.push({
        provider: "openrouter",
        model: "openrouter/auto",
        maxTokens: 1800,
        temperature: 0.55,
      });
    }

    return {
      allowedProviders: list,
      reasoningAllowed: mode === "DEBUG" || mode === "PLAN",
      maxOutputTokens: 1800,
      tier,
    };
  }

  // Tier 3: Pro
  const list: ModelRouteResult["allowedProviders"] = [];
  if (!disabled.has("groq")) {
    list.push({
      provider: "groq",
      model: "qwen/qwen3.6-27b",
      maxTokens: 2500,
      temperature: 0.5,
    });
  }
  if (!disabled.has("gemini")) {
    list.push({
      provider: "gemini",
      model: "gemini-2.5-flash",
      maxTokens: 2500,
      temperature: 0.5,
    });
  }
  if (!disabled.has("openrouter")) {
    list.push({
      provider: "openrouter",
      model: "openrouter/auto",
      maxTokens: 2500,
      temperature: 0.5,
    });
  }
  if (!disabled.has("openai")) {
    list.push({
      provider: "openai",
      model: "gpt-4o-mini",
      maxTokens: 2500,
      temperature: 0.5,
      isReasoningModel: true,
    });
  }

  return {
    allowedProviders: list,
    reasoningAllowed: true,
    maxOutputTokens: 2500,
    tier: "PRO",
  };
}


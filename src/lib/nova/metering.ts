import type { Db } from "mongodb";
import {
  calculateActualCostAndCredits,
  getEffectivePricingConfig,
  type NovaPricingConfig,
  type TokenUsageCounts,
} from "./pricingConfig";

export interface NovaUsageEvent {
  requestId: string;
  userId: string;
  conversationId: string;
  problemId?: string;
  buildosPhase?: string;
  capability: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  actualCostUsd: number;
  actualCostInr: number;
  inrExchangeRate: number;
  novaCreditsCharged: number;
  pricingConfigVersion: string;
  executionStatus: "SUCCESS" | "FAILED" | "TIMEOUT" | "RETRY_FALLBACK";
  errorMessage?: string;
  timestamp: Date;
}

/**
 * Normalizes usage metadata returned from any LLM provider (Groq, Gemini, OpenRouter, OpenAI).
 * Never assumes missing token usage means zero cost — applies a conservative fallback estimate.
 */
export function extractNormalizedUsage(
  rawResponseBody: any,
  fallbackInputChars = 0,
  fallbackOutputChars = 0
): TokenUsageCounts {
  const usage = rawResponseBody?.usage || rawResponseBody?.response?.usage;

  if (usage) {
    const inputTokens = Number(
      usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? 0
    );
    const outputTokens = Number(
      usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? 0
    );
    const cachedTokens = Number(
      usage.prompt_tokens_details?.cached_tokens ??
        usage.cached_tokens ??
        usage.cachedContentTokenCount ??
        0
    );
    const reasoningTokens = Number(
      usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0
    );

    if (inputTokens > 0 || outputTokens > 0) {
      return {
        inputTokens: Math.max(0, inputTokens),
        outputTokens: Math.max(0, outputTokens),
        cachedTokens: Math.max(0, cachedTokens),
        reasoningTokens: Math.max(0, reasoningTokens),
      };
    }
  }

  // Fallback: approximate 1 token ~ 4 characters if provider did not supply usage metadata
  const estimatedInputTokens = Math.max(1, Math.ceil(fallbackInputChars / 4));
  const estimatedOutputTokens = Math.max(1, Math.ceil(fallbackOutputChars / 4));

  return {
    inputTokens: estimatedInputTokens,
    outputTokens: estimatedOutputTokens,
    cachedTokens: 0,
    reasoningTokens: 0,
  };
}

/**
 * Records an immutable usage event in the database for billing audit.
 */
export async function recordNovaUsageEvent(
  db: Db,
  event: NovaUsageEvent
): Promise<void> {
  try {
    await db.collection<NovaUsageEvent>("nova_ai_usage_events").insertOne({
      ...event,
      timestamp: event.timestamp || new Date(),
    });
  } catch (err) {
    console.warn("[Nova Metering] Failed to persist AI usage event:", err);
  }
}


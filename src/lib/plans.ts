export type PlanTier = "FREE" | "BUILDER" | "PRO" | "MAX";

export interface PlanConfig {
  id: PlanTier;
  name: string;
  badge: string;
  description: string;
  price: number; // in INR
  amountInPaise: number; // 1 INR = 100 paise
  currency: "INR";
  billingPeriod: "monthly" | "lifetime";
  dailyAllocation: number;
  aiCreditsPerMonth: number;
  highlighted?: boolean;
  features: string[];
}

export const PLANS: Record<PlanTier, PlanConfig> = {
  FREE: {
    id: "FREE",
    name: "Free Community Tier",
    badge: "Community",
    description: "Full access to foundational engineering challenges and Socratic mentor sandbox.",
    price: 0,
    amountInPaise: 0,
    currency: "INR",
    billingPeriod: "lifetime",
    dailyAllocation: 25,
    aiCreditsPerMonth: 750,
    features: [
      "Full access to all 8 Product Journey phases",
      "25 Nova daily AI credits (750 / month)",
      "Standard test concurrency runner",
      "Public Proof-of-Work portfolio generation",
      "GitHub repository export",
      "Community leaderboard ranking",
    ],
  },
  BUILDER: {
    id: "BUILDER",
    name: "Builder Tier",
    badge: "Most Popular",
    description: "For serious student engineers aiming for top-tier startup roles.",
    price: 1799,
    amountInPaise: 179900,
    currency: "INR",
    billingPeriod: "monthly",
    dailyAllocation: 950,
    aiCreditsPerMonth: 28500,
    highlighted: true,
    features: [
      "Everything in Free Community Tier",
      "950 Nova daily AI credits (28,500 / month)",
      "Rolling 24-hour daily allocation reset",
      "In-depth Socratic Nova AI architectural code reviews",
      "Balanced AI models with code generation and debugging",
      "Verified recruiter showcase & telemetry benchmark",
      "Custom portfolio domain linking",
      "Priority customer & technical support",
    ],
  },
  PRO: {
    id: "PRO",
    name: "Pro Tier",
    badge: "Elite",
    description: "Full unconstrained power for founders and senior engineering candidates.",
    price: 3499,
    amountInPaise: 349900,
    currency: "INR",
    billingPeriod: "monthly",
    dailyAllocation: 1900,
    aiCreditsPerMonth: 57000,
    features: [
      "Everything in Builder Tier",
      "1,900 Nova daily AI credits (57,000 / month)",
      "Rolling 24-hour daily allocation reset",
      "Priority access to reasoning AI models",
      "Complex reasoning & advanced product validation",
      "Direct recruiter introductions & hiring pipeline routing",
      "Automated recruiter-certified Proof-of-Work badges",
      "Early access to new production mission tracks",
    ],
  },
  MAX: {
    // Legacy alias to PRO
    id: "MAX",
    name: "Max Founder Tier (Legacy)",
    badge: "Elite",
    description: "Legacy tier mapped to Pro capabilities.",
    price: 3499,
    amountInPaise: 349900,
    currency: "INR",
    billingPeriod: "monthly",
    dailyAllocation: 1900,
    aiCreditsPerMonth: 57000,
    features: [
      "Full Pro tier entitlements",
      "1,900 Nova daily AI credits (57,000 / month)",
    ],
  },
};

export function getPlanConfig(plan: string): PlanConfig | null {
  const normalized = (plan || "").toString().trim().toUpperCase() as PlanTier;
  return PLANS[normalized] || null;
}

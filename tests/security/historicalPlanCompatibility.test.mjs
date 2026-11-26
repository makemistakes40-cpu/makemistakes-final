/**
 * HISTORICAL PLAN COMPATIBILITY TESTS
 *
 * The pricing correction renamed the old Max Founder plan to Pro and moved the
 * old ₹499/1-month Pro plan to ₹499 Builder. Consumers who paid BEFORE the
 * change must keep the meaning of their original purchase:
 *
 *   - Historical PRO (₹499 = 49,900 paise) -> 1 calendar month
 *   - New PRO (₹1,499 = 149,900 paise)    -> 4 calendar months
 *   - Historical MAX (₹1,499 = 149,900)   -> 4 calendar months (legacy alias)
 *   - BUILDER (₹499 = 49,900 paise)       -> fixed 30 days (never reaches
 *                                              resolveExpiryMonths)
 *
 * These tests lock the expiry-mapping contract used by activateVerifiedOrder.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { resolveExpiryMonths } from "../../src/lib/paymentService.ts";
import { getPlanConfig } from "../../src/lib/plans.ts";

test("historical PRO ₹499 (49,900 paise) maps to ONE calendar month", () => {
  assert.equal(resolveExpiryMonths("PRO", 49900), 1);
  // Plan id casing / whitespace is tolerated.
  assert.equal(resolveExpiryMonths(" pro ", 49900), 1);
});

test("new PRO ₹1,499 (149,900 paise) maps to FOUR calendar months", () => {
  assert.equal(resolveExpiryMonths("PRO", 149900), 4);
});

test("historical MAX ₹1,499 maps to FOUR calendar months (legacy alias)", () => {
  assert.equal(resolveExpiryMonths("MAX", 149900), 4);
  assert.equal(resolveExpiryMonths("max", 149900), 4);
});

// --- plan configuration sanity (amounts are server-authoritative) ----------

test("PRO config: ₹1,499 = 149,900 paise, 4 months, Pro-level Nova credits", () => {
  const pro = getPlanConfig("PRO");
  assert.equal(pro.amountInPaise, 149900);
  assert.equal(pro.accessMonths, 4);
  assert.equal(pro.dailyAllocation, 1900);
  assert.equal(pro.aiCreditsPerMonth, 57000);
});

test("BUILDER config: ₹499 = 49,900 paise, 30 days, 950/28,500 credits", () => {
  const builder = getPlanConfig("BUILDER");
  assert.equal(builder.amountInPaise, 49900);
  assert.equal(builder.dailyAllocation, 950);
  assert.equal(builder.aiCreditsPerMonth, 28500);
});

test("MAX remains a recognized legacy alias with Pro-level entitlements", () => {
  const max = getPlanConfig("MAX");
  assert.equal(max.id, "MAX");
  assert.equal(max.amountInPaise, 149900);
  assert.equal(max.accessMonths, 4);
  assert.equal(max.dailyAllocation, 1900);
  assert.equal(max.aiCreditsPerMonth, 57000);
});

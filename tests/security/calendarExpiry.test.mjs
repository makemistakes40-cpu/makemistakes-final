/**
 * CALENDAR-MONTH EXPIRY TESTS
 *
 * Verifies addCalendarMonths — the helper used for Pro (1 calendar month) and
 * Max Founder (4 calendar months) subscription expiry. Expiry is computed in
 * Indian Standard Time (IST, Asia/Kolkata, UTC+05:30), so the result is
 * identical regardless of the server's configured timezone: the payment's IST
 * time of day is preserved and month-end dates are clamped (Jan 31 -> Feb 28
 * / Feb 29; Mar 31 -> Apr 30).
 *
 * Builder preserves its legacy fixed 30-day duration and is not covered here
 * (it does not use addCalendarMonths).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { addCalendarMonths } from "../../src/lib/subscriptionExpiry.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Format an instant as an IST wall-clock stamp: "YYYY-MM-DD HH:mm:ss".
function istStamp(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms)).replace(", ", " ");
}

const at = (s) => new Date(s).getTime();

test("Pro +1 month: identical absolute instant and preserved IST time of day", () => {
  const base = "2025-01-15T10:00:00.000Z"; // IST 2025-01-15 15:30:00
  const got = addCalendarMonths(new Date(base), 1);
  assert.equal(got.getTime(), at("2025-02-15T10:00:00.000Z"));
  assert.equal(istStamp(got.getTime()), "2025-02-15 15:30:00");
  assert.equal(istStamp(at(base)), "2025-01-15 15:30:00");
});

test("same day-of-month for months with enough days", () => {
  assert.equal(addCalendarMonths(new Date("2025-03-10T10:00:00Z"), 4).getTime(), at("2025-07-10T10:00:00Z"));
  assert.equal(addCalendarMonths(new Date("2025-11-15T10:00:00Z"), 4).getTime(), at("2026-03-15T10:00:00Z"));
});

test("month-end clamp: Jan 31 -> Feb 28 (non-leap)", () => {
  // IST 2025-01-31 15:30 -> 2025-02-28 15:30 IST
  assert.equal(addCalendarMonths(new Date("2025-01-31T10:00:00Z"), 1).getTime(), at("2025-02-28T10:00:00Z"));
});

test("month-end clamp: Mar 31 -> Apr 30", () => {
  // IST 2025-03-31 17:30 -> 2025-04-30 17:30 IST
  assert.equal(addCalendarMonths(new Date("2025-03-31T12:00:00Z"), 1).getTime(), at("2025-04-30T12:00:00Z"));
});

test("arithmetic uses IST date, not UTC date (cross-midnight)", () => {
  // Base UTC 2025-01-31 18:30 = IST 2025-02-01 00:00. +1 month -> 2025-03-01 00:00 IST.
  const got = addCalendarMonths(new Date("2025-01-31T18:30:00Z"), 1);
  assert.equal(got.getTime(), at("2025-02-28T18:30:00Z"));
  assert.equal(istStamp(got.getTime()), "2025-03-01 00:00:00");
});

test("leap year: Jan 31 -> Feb 29, Feb 29 -> Mar 29", () => {
  assert.equal(addCalendarMonths(new Date("2024-01-31T10:00:00Z"), 1).getTime(), at("2024-02-29T10:00:00Z"));
  assert.equal(addCalendarMonths(new Date("2024-02-29T10:00:00Z"), 1).getTime(), at("2024-03-29T10:00:00Z"));
});

test("year rollover across IST date boundary", () => {
  // Base UTC 2025-08-31 18:30 = IST 2025-09-01 00:00. +4 months -> 2026-01-01 00:00 IST.
  const got = addCalendarMonths(new Date("2025-08-31T18:30:00Z"), 4);
  assert.equal(got.getTime(), at("2025-12-31T18:30:00Z"));
  assert.equal(istStamp(got.getTime()), "2026-01-01 00:00:00");
});

test("Max 4 months: Nov 30 -> Mar 30; Oct 31 -> Feb 28", () => {
  assert.equal(addCalendarMonths(new Date("2025-11-30T10:00:00Z"), 4).getTime(), at("2026-03-30T10:00:00Z"));
  assert.equal(addCalendarMonths(new Date("2025-10-31T10:00:00Z"), 4).getTime(), at("2026-02-28T10:00:00Z"));
});

test("preserves milliseconds (time of day) exactly", () => {
  const base = new Date("2025-06-15T07:45:30.123Z"); // IST 13:15:30.123
  const got = addCalendarMonths(base, 1);
  assert.equal(got.getTime(), at("2025-07-15T07:45:30.123Z"));
  assert.equal(istStamp(got.getTime()), "2025-07-15 13:15:30");
  assert.equal(got.getMilliseconds(), 123);
});

test("throws on invalid Date input", () => {
  assert.throws(() => addCalendarMonths(new Date("not-a-date"), 1), /Invalid date/);
  assert.throws(() => addCalendarMonths(new Date(NaN), 1), /Invalid date/);
});

test("throws on negative month values", () => {
  const valid = new Date("2025-01-15T10:00:00Z");
  assert.throws(() => addCalendarMonths(valid, -1), /Months must be a non-negative integer/);
  assert.throws(() => addCalendarMonths(valid, -0.5), /Months must be a non-negative integer/);
});

test("throws on fractional month values", () => {
  const valid = new Date("2025-01-15T10:00:00Z");
  assert.throws(() => addCalendarMonths(valid, 1.5), /Months must be a non-negative integer/);
  assert.throws(() => addCalendarMonths(valid, 1.0001), /Months must be a non-negative integer/);
});

test("accepts zero months (identity)", () => {
  const base = new Date("2025-01-15T10:00:00.000Z");
  assert.equal(addCalendarMonths(base, 0).getTime(), base.getTime());
});

// ---------------------------------------------------------------------------
// Cross-timezone determinism: run the helper in child processes under two
// different server timezones and require byte-identical expiry timestamps.
// ---------------------------------------------------------------------------
const CROSS_TZ_INPUTS = [
  "2025-01-15T10:00:00.000Z",
  "2025-01-31T10:00:00.000Z",
  "2025-01-31T18:30:00.000Z",
  "2024-01-31T10:00:00.000Z",
  "2024-02-29T10:00:00.000Z",
  "2025-03-10T10:00:00.000Z",
  "2025-03-31T12:00:00.000Z",
  "2025-08-31T18:30:00.000Z",
  "2025-11-30T10:00:00.000Z",
  "2025-10-31T10:00:00.000Z",
  "2025-12-31T15:00:00.000Z",
];

function expiryMatrixUnderTz(tz) {
  const script = `
    const { addCalendarMonths } = await import(process.argv[1]);
    const inputs = JSON.parse(process.argv[2]);
    const out = inputs.map((i) => {
      const d = new Date(i);
      return [addCalendarMonths(d, 1).getTime(), addCalendarMonths(d, 4).getTime()];
    });
    process.stdout.write(JSON.stringify(out));
  `;
  const helperUrl = pathToFileURL(join(REPO_ROOT, "src/lib/subscriptionExpiry.ts")).href;
  const env = { ...process.env, TZ: tz };
  const stdout = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script, helperUrl, JSON.stringify(CROSS_TZ_INPUTS)],
    { env, encoding: "utf8" }
  );
  return stdout.trim();
}

test("expiry is identical under UTC and America/Los_Angeles", () => {
  const utc = expiryMatrixUnderTz("UTC");
  const la = expiryMatrixUnderTz("America/Los_Angeles");
  assert.equal(la, utc);
  const parsed = JSON.parse(utc);
  assert.equal(parsed.length, CROSS_TZ_INPUTS.length);
  for (const pair of parsed) {
    assert.ok(typeof pair[0] === "number" && Number.isFinite(pair[0]));
    assert.ok(typeof pair[1] === "number" && Number.isFinite(pair[1]));
  }
});

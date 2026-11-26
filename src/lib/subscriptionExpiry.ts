/**
 * Calendar-month subscription expiry arithmetic, anchored to Indian Standard
 * Time (IST, Asia/Kolkata, UTC+05:30).
 *
 * Used for Pro (1 calendar month) and Max Founder (4 calendar months) access
 * periods. Builder keeps its legacy fixed 30-day duration and does not use this.
 *
 * All arithmetic is performed on IST wall-clock components, so the result is
 * identical regardless of the server's configured timezone and the payment's
 * IST time of day is preserved. Month-end dates are clamped to the last day of
 * the target month (e.g. Jan 31 + 1 month => Feb 28 / Feb 29 in a leap year).
 */

const IST_TIME_ZONE = "Asia/Kolkata";

// UTC+05:30 with no daylight saving -> a fixed offset expressible as a constant.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const istFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: IST_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hour12: false,
  hourCycle: "h23",
});

interface IstFields {
  year: number;
  month: number; // 0-based
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

/** Extract the IST wall-clock fields for an instant. */
function toIstFields(date: Date): IstFields {
  const parts = istFormatter.formatToParts(date);
  const num = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: num("year"),
    month: num("month") - 1,
    day: num("day"),
    hour: num("hour") % 24,
    minute: num("minute"),
    second: num("second"),
    ms: date.getMilliseconds(), // milliseconds are timezone-independent
  };
}

/** Build the instant matching a given IST wall-clock time. */
function fromIstFields(fields: IstFields): Date {
  // IST = UTC + 05:30, so the UTC instant equals the wall clock read as UTC
  // minus the fixed offset.
  return new Date(
    Date.UTC(
      fields.year,
      fields.month,
      fields.day,
      fields.hour,
      fields.minute,
      fields.second,
      fields.ms
    ) - IST_OFFSET_MS
  );
}

/**
 * Add a number of calendar months to an instant, expressed in IST. The day is
 * clamped to the last day of the target month when the source day overflows.
 */
export function addCalendarMonths(date: Date, months: number): Date {
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Invalid date");
  }

  if (!Number.isInteger(months) || months < 0) {
    throw new Error("Months must be a non-negative integer");
  }

  const src = toIstFields(date);

  const targetMonthIndex = src.month + months;
  const targetYear = src.year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

  // Month-end length is computed in pure UTC arithmetic and is timezone-independent.
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(src.day, lastDayOfTargetMonth);

  return fromIstFields({
    year: targetYear,
    month: targetMonth,
    day,
    hour: src.hour,
    minute: src.minute,
    second: src.second,
    ms: src.ms,
  });
}

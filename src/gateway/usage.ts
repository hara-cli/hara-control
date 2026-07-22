export const USAGE_RANGES = ["24h", "7d", "30d"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export interface UsageWindow {
  range: UsageRange;
  from: Date;
  to: Date;
  bucketMs: number;
  bucketCount: number;
  bucketUnit: "hour" | "day";
}

export function parseUsageRange(value: string | undefined): UsageRange {
  const range = value || "24h";
  if (!USAGE_RANGES.includes(range as UsageRange)) {
    throw new Error("usage range must be one of: 24h, 7d, 30d");
  }
  return range as UsageRange;
}

/** UTC-aligned buckets keep charts deterministic across browser/server time zones and DST changes. */
export function usageWindow(range: UsageRange, now = new Date()): UsageWindow {
  if (!Number.isFinite(now.getTime())) throw new Error("usage report time must be valid");
  const hourMs = 60 * 60 * 1_000;
  const dayMs = 24 * hourMs;
  if (range === "24h") {
    const currentHour = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
    );
    return {
      range,
      from: new Date(currentHour - 23 * hourMs),
      to: new Date(currentHour + hourMs),
      bucketMs: hourMs,
      bucketCount: 24,
      bucketUnit: "hour",
    };
  }
  const currentDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const bucketCount = range === "7d" ? 7 : 30;
  return {
    range,
    from: new Date(currentDay - (bucketCount - 1) * dayMs),
    to: new Date(currentDay + dayMs),
    bucketMs: dayMs,
    bucketCount,
    bucketUnit: "day",
  };
}

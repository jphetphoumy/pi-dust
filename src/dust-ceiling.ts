import type { MemberUsage } from "./dust-types.js";

/**
 * Monthly credit ceiling used when Dust reports none.
 *
 * Pool-based seats have a null `memberUsageLimit`, so without a fallback the
 * headline gauge would have nothing to fill against.
 */
export const DEFAULT_MONTHLY_CREDITS = 8000;
export const MONTHLY_CREDITS_ENV = "PI_DUST_MONTHLY_CREDITS";

export interface MonthlyCeiling {
  credits: number;
  /** True when nothing authoritative was available and the default was used. */
  isFallback: boolean;
}

function configuredCeiling(): number | null {
  const raw = process.env[MONTHLY_CREDITS_ENV]?.trim();
  if (!raw) return null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolves the ceiling the month gauge fills against.
 *
 * Order: explicit configuration, then the seat allocation Dust granted, then
 * the per-user spend cap, then the built-in default. Anything Dust reports
 * beats the default, so the panel stays correct across plans without config.
 */
export function resolveMonthlyCeiling(usage: MemberUsage | null): MonthlyCeiling {
  const configured = configuredCeiling();
  if (configured !== null) return { credits: configured, isFallback: false };

  const seatAllocation = usage?.memberUsageLimit;
  if (typeof seatAllocation === "number" && seatAllocation > 0) {
    return { credits: seatAllocation, isFallback: false };
  }

  const spendCap = usage?.spendLimitAwuCredits;
  if (typeof spendCap === "number" && spendCap > 0 && usage?.spendLimitSource !== "none") {
    return { credits: spendCap, isFallback: false };
  }

  return { credits: DEFAULT_MONTHLY_CREDITS, isFallback: true };
}

/** Days in the UTC calendar month containing `at`; buckets are UTC-aligned. */
export function daysInMonth(at: Date): number {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Pro-rates the monthly ceiling onto a shorter period, so a week or a day reads
 * as "ahead of / behind budget" rather than as a share of the whole month. The
 * denominator is the real length of the current month, not a nominal 30.
 */
export function proRatedCeiling(monthly: number, days: number, at: Date): number {
  return (monthly * days) / daysInMonth(at);
}

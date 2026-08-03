import type { CodexQuotaSummary } from "../../core/types";

const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const SEVEN_DAY_WINDOW_MINUTES = 7 * 24 * 60;
const STARTED_WINDOW_MARGIN_SECONDS = 5 * 60;

type QuotaCountdownWindow = {
  key: "hourly" | "weekly";
  percentage: number;
  present?: boolean;
  resetAt?: number;
  windowMinutes?: number;
  fallbackWindowMinutes: number;
};

/**
 * Offer the manual starter only while every primary quota window still looks
 * unused. The service-reported window length is authoritative; when an older
 * payload omits it, retain the five-hour/seven-day legacy defaults.
 */
export function isQuotaCountdownStartEligible(
  quota: CodexQuotaSummary | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!quota) {
    return false;
  }

  const windows = (
    [
      {
        key: "hourly",
        percentage: quota.hourlyPercentage,
        present: quota.hourlyWindowPresent,
        resetAt: quota.hourlyResetTime,
        windowMinutes: quota.hourlyWindowMinutes,
        fallbackWindowMinutes: FIVE_HOUR_WINDOW_MINUTES
      },
      {
        key: "weekly",
        percentage: quota.weeklyPercentage,
        present: quota.weeklyWindowPresent,
        resetAt: quota.weeklyResetTime,
        windowMinutes: quota.weeklyWindowMinutes,
        fallbackWindowMinutes: SEVEN_DAY_WINDOW_MINUTES
      }
    ] satisfies QuotaCountdownWindow[]
  ).filter((window) => window.present === true);

  if (windows.length === 0) {
    return false;
  }

  return windows.every((window) => {
    const windowMinutes = resolveQuotaCountdownWindowMinutes(window);
    if (
      windowMinutes == null ||
      !Number.isFinite(window.percentage) ||
      window.percentage < 100 ||
      window.resetAt == null ||
      !Number.isFinite(window.resetAt)
    ) {
      return false;
    }

    return isQuotaCountdownWindowFresh(window.key, window.resetAt, nowMs, windowMinutes);
  });
}

export function isQuotaCountdownWindowFresh(
  window: "hourly" | "weekly",
  resetAt: number | undefined,
  nowMs: number = Date.now(),
  windowMinutes?: number
): boolean {
  if (resetAt == null || !Number.isFinite(resetAt)) {
    return false;
  }

  const effectiveWindowMinutes =
    windowMinutes ?? (window === "hourly" ? FIVE_HOUR_WINDOW_MINUTES : SEVEN_DAY_WINDOW_MINUTES);
  if (!isUsableWindowMinutes(effectiveWindowMinutes)) {
    return false;
  }

  const minimumFreshSeconds = effectiveWindowMinutes * 60 - STARTED_WINDOW_MARGIN_SECONDS;
  return resetAt - Math.floor(nowMs / 1000) >= minimumFreshSeconds;
}

function resolveQuotaCountdownWindowMinutes(window: QuotaCountdownWindow): number | undefined {
  if (window.windowMinutes == null) {
    return window.fallbackWindowMinutes;
  }
  return isUsableWindowMinutes(window.windowMinutes) ? window.windowMinutes : undefined;
}

function isUsableWindowMinutes(value: number): boolean {
  return Number.isFinite(value) && value > STARTED_WINDOW_MARGIN_SECONDS / 60;
}

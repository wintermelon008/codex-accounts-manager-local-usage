import { describe, expect, it } from "vitest";
import type { CodexQuotaSummary } from "../src/core/types";
import { isQuotaCountdownStartEligible } from "../src/domain/dashboard/quotaCountdown";

const NOW_SECONDS = 1_800_000_000;
const NOW_MS = NOW_SECONDS * 1000;

describe("isQuotaCountdownStartEligible", () => {
  it("offers the starter for full five-hour and seven-day countdowns", () => {
    expect(isQuotaCountdownStartEligible(quota(), NOW_MS)).toBe(true);
  });

  it("keeps the button at the exact five-minute boundary", () => {
    expect(
      isQuotaCountdownStartEligible(
        quota({
          hourlyResetTime: NOW_SECONDS + 4 * 60 * 60 + 55 * 60,
          weeklyResetTime: NOW_SECONDS + 6 * 24 * 60 * 60 + 23 * 60 * 60 + 55 * 60
        }),
        NOW_MS
      )
    ).toBe(true);
  });

  it("hides when either recognized countdown has advanced past the margin", () => {
    expect(
      isQuotaCountdownStartEligible(quota({ hourlyResetTime: NOW_SECONDS + 4 * 60 * 60 + 55 * 60 - 1 }), NOW_MS)
    ).toBe(false);
    expect(
      isQuotaCountdownStartEligible(
        quota({ weeklyResetTime: NOW_SECONDS + 6 * 24 * 60 * 60 + 23 * 60 * 60 + 55 * 60 - 1 }),
        NOW_MS
      )
    ).toBe(false);
  });

  it("uses consumed quota as immediate evidence that a window already started", () => {
    expect(isQuotaCountdownStartEligible(quota({ hourlyPercentage: 99 }), NOW_MS)).toBe(false);
  });

  it("uses the service-reported long-window duration", () => {
    expect(
      isQuotaCountdownStartEligible(
        quota({
          hourlyWindowPresent: false,
          weeklyWindowMinutes: 30 * 24 * 60,
          weeklyResetTime: NOW_SECONDS + 30 * 24 * 60 * 60
        }),
        NOW_MS
      )
    ).toBe(true);
    expect(
      isQuotaCountdownStartEligible(
        quota({
          hourlyWindowPresent: false,
          weeklyWindowMinutes: 30 * 24 * 60,
          weeklyResetTime: NOW_SECONDS + 30 * 24 * 60 * 60 - 5 * 60 - 1
        }),
        NOW_MS
      )
    ).toBe(false);
  });

  it("fails closed for missing or invalid quota windows", () => {
    expect(isQuotaCountdownStartEligible(undefined, NOW_MS)).toBe(false);
    expect(isQuotaCountdownStartEligible(quota({ hourlyWindowMinutes: 0 }), NOW_MS)).toBe(false);
  });
});

function quota(overrides: Partial<CodexQuotaSummary> = {}): CodexQuotaSummary {
  return {
    hourlyPercentage: 100,
    hourlyResetTime: NOW_SECONDS + 5 * 60 * 60,
    hourlyWindowMinutes: 5 * 60,
    hourlyWindowPresent: true,
    weeklyPercentage: 100,
    weeklyResetTime: NOW_SECONDS + 7 * 24 * 60 * 60,
    weeklyWindowMinutes: 7 * 24 * 60,
    weeklyWindowPresent: true,
    codeReviewPercentage: 0,
    ...overrides
  };
}

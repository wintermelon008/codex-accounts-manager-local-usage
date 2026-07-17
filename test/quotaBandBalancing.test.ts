import { describe, expect, it } from "vitest";
import {
  BALANCE_QUOTA_MAX_AGE_MS,
  didQuotaBandDrop,
  getFiveHourQuotaBand,
  selectBalanceCandidate
} from "../src/application/accounts/balanceScheduler";
import type { CodexAccountRecord } from "../src/core/types";
import {
  acknowledgeSeamlessQuotaBand,
  initSeamlessSwitchRuntimeState,
  observeSeamlessQuotaBand,
  resetSeamlessSwitchRuntimeState
} from "../src/presentation/workbench/seamlessSwitchState";

describe("5-hour quota band balancing", () => {
  it("maps exact configured boundaries into stable bands", () => {
    expect([100, 81, 80, 61, 60, 41, 40, 21, 20, 1, 0].map((value) => getFiveHourQuotaBand(value))).toEqual([
      5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0
    ]);
    expect([100, 76, 75, 51, 50, 26, 25, 1, 0].map((value) => getFiveHourQuotaBand(value, 25))).toEqual([
      4, 4, 3, 3, 2, 2, 1, 1, 0
    ]);
    expect([100, 67, 66, 34, 33, 1, 0].map((value) => getFiveHourQuotaBand(value, 33))).toEqual([3, 3, 2, 2, 1, 1, 0]);
    expect([100, 51, 50, 1, 0].map((value) => getFiveHourQuotaBand(value, 50))).toEqual([2, 2, 1, 1, 0]);
    expect(didQuotaBandDrop(undefined, 4)).toBe(false);
    expect(didQuotaBandDrop(4, 4)).toBe(false);
    expect(didQuotaBandDrop(4, 3)).toBe(true);
    expect(didQuotaBandDrop(3, 5)).toBe(false);
  });

  it("selects the strongest fresh pool account and uses least-recently-selected as a stable tie-break", () => {
    const now = 10_000_000;
    const active = account("active", 59, now);
    const accountB = account("b", 82, now, 20_000);
    const accountC = account("c", 82, now, 20_000);
    const stale = account("stale", 100, now - BALANCE_QUOTA_MAX_AGE_MS - 1);
    const outsidePool = account("outside", 100, now);
    outsidePool.balancePoolEnabled = false;

    expect(
      selectBalanceCandidate({
        accounts: [active, accountB, accountC, stale, outsidePool],
        activeAccountId: active.id,
        activeBand: getFiveHourQuotaBand(active.quotaSummary!.hourlyPercentage),
        lastSelectedAt: { b: 9_000, c: 1_000 },
        now
      })?.id
    ).toBe("c");
  });

  it("does not switch to an account in a lower band", () => {
    const now = 10_000_000;
    const active = account("active", 61, now);
    const lower = account("lower", 59, now);

    expect(
      selectBalanceCandidate({
        accounts: [active, lower],
        activeAccountId: active.id,
        activeBand: getFiveHourQuotaBand(active.quotaSummary!.hourlyPercentage),
        lastSelectedAt: {},
        now
      })
    ).toBeUndefined();
  });

  it("uses the configured band size and can exclude emergency-depleted candidates", () => {
    const now = 10_000_000;
    const active = account("active", 25, now);
    const depleted = account("depleted", 1, now);
    const healthy = account("healthy", 26, now);

    expect(
      selectBalanceCandidate({
        accounts: [active, depleted, healthy],
        activeAccountId: active.id,
        activeBand: getFiveHourQuotaBand(active.quotaSummary!.hourlyPercentage, 25),
        quotaBandSize: 25,
        minimumHourlyPercentage: 1,
        lastSelectedAt: {},
        now
      })?.id
    ).toBe("healthy");
  });

  it("rejects malformed percentages and quota timestamps outside the freshness window", () => {
    const now = 10_000_000;
    const active = account("active", 59, now);
    const malformed = account("malformed", 101, now);
    const future = account("future", 100, now + BALANCE_QUOTA_MAX_AGE_MS + 1);

    expect(
      selectBalanceCandidate({
        accounts: [active, malformed, future],
        activeAccountId: active.id,
        activeBand: getFiveHourQuotaBand(active.quotaSummary!.hourlyPercentage),
        lastSelectedAt: {},
        now
      })
    ).toBeUndefined();
  });

  it("keeps a dropped band pending until a candidate switch is acknowledged", () => {
    initSeamlessSwitchRuntimeState({
      globalState: {
        get: () => undefined,
        update: async () => undefined
      }
    } as never);
    resetSeamlessSwitchRuntimeState();

    expect(observeSeamlessQuotaBand("active", 5)).toBe(false);
    expect(observeSeamlessQuotaBand("active", 4)).toBe(true);
    expect(observeSeamlessQuotaBand("active", 4)).toBe(true);

    acknowledgeSeamlessQuotaBand("active", 4);
    expect(observeSeamlessQuotaBand("active", 4)).toBe(false);
  });

  it("establishes a fresh baseline when the configured band size changes", () => {
    initSeamlessSwitchRuntimeState({
      globalState: {
        get: () => undefined,
        update: async () => undefined
      }
    } as never);

    expect(observeSeamlessQuotaBand("active", 5, 20)).toBe(false);
    expect(observeSeamlessQuotaBand("active", 4, 20)).toBe(true);
    expect(observeSeamlessQuotaBand("active", 4, 25)).toBe(false);
  });
});

function account(
  id: string,
  hourlyPercentage: number,
  lastQuotaAt: number,
  hourlyResetTime = 30_000
): CodexAccountRecord {
  return {
    id,
    email: `${id}@example.invalid`,
    isActive: id === "active",
    balancePoolEnabled: true,
    lastQuotaAt,
    quotaSummary: {
      hourlyPercentage,
      hourlyWindowPresent: true,
      hourlyWindowMinutes: 300,
      hourlyResetTime,
      weeklyPercentage: 100,
      weeklyWindowPresent: true,
      weeklyWindowMinutes: 10_080,
      codeReviewPercentage: 100
    },
    createdAt: 1,
    updatedAt: 1
  };
}

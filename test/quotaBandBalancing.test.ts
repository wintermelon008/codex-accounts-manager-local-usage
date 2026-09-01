import { describe, expect, it } from "vitest";
import {
  BALANCE_QUOTA_MAX_AGE_MS,
  didQuotaBandDrop,
  FREE_SWITCH_THRESHOLD_QUOTA_MAX_AGE_MS,
  getBalanceQuotaCapability,
  getFiveHourQuotaBand,
  isFreePlanType,
  selectBalanceCandidate
} from "../src/application/accounts/balanceScheduler";
import type { CodexAccountRecord } from "../src/core/types";
import {
  acknowledgeSeamlessQuotaBand,
  getSeamlessSwitchRuntimeSnapshot,
  initSeamlessSwitchRuntimeState,
  observeSeamlessQuotaBand,
  recordSeamlessSelection,
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

  it("selects the first fresh pool account within the highest available plan tier", () => {
    const now = 10_000_000;
    const active = account("active", 59, now);
    const accountB = account("b", 82, now, 20_000);
    const accountC = account("c", 82, now, 20_000);
    accountB.planType = "plus";
    accountC.planType = "plus";
    const stale = account("stale", 100, now - BALANCE_QUOTA_MAX_AGE_MS - 1);
    const outsidePool = account("outside", 100, now);
    outsidePool.balancePoolEnabled = false;

    expect(
      selectBalanceCandidate({
        accounts: [active, accountB, accountC, stale, outsidePool],
        activeAccountId: active.id,
        activeBand: getFiveHourQuotaBand(active.quotaSummary!.hourlyPercentage),
        now
      })?.id
    ).toBe("b");
  });

  it("uses the current Dashboard order within the same plan tier", () => {
    const now = 10_000_000;
    const active = account("active", 59, now);
    const repositoryFirst = account("repository-first", 82, now, 20_000);
    const dashboardFirst = account("dashboard-first", 82, now, 20_000);
    repositoryFirst.planType = "plus";
    dashboardFirst.planType = "plus";

    expect(
      selectBalanceCandidate({
        accounts: [active, repositoryFirst, dashboardFirst],
        accountOrder: [active.id, dashboardFirst.id, repositoryFirst.id],
        activeAccountId: active.id,
        activeBand: getFiveHourQuotaBand(active.quotaSummary!.hourlyPercentage),
        now
      })?.id
    ).toBe(dashboardFirst.id);
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
        now
      })
    ).toBeUndefined();
  });

  it("never selects hidden accounts and does not switch away from a hidden active account", () => {
    const now = 10_000_000;
    const active = account("active", 59, now);
    const hidden = account("hidden", 100, now);
    hidden.isHidden = true;
    const visible = account("visible", 80, now);

    expect(
      selectBalanceCandidate({
        accounts: [active, hidden, visible],
        activeAccountId: active.id,
        activeBand: getFiveHourQuotaBand(active.quotaSummary!.hourlyPercentage),
        now
      })?.id
    ).toBe("visible");

    active.isHidden = true;
    expect(
      selectBalanceCandidate({
        accounts: [active, visible],
        activeAccountId: active.id,
        activeBand: getFiveHourQuotaBand(active.quotaSummary!.hourlyPercentage),
        now
      })
    ).toBeUndefined();
  });

  it("uses the configured band size and unified threshold", () => {
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
        switchThreshold: 1,
        now
      })?.id
    ).toBe("healthy");
  });

  it("never selects a candidate with at most 3% weekly quota", () => {
    const now = 10_000_000;
    const active = account("active", 80, now);
    const weeklyDepleted = account("weekly-depleted", 100, now);
    weeklyDepleted.quotaSummary!.weeklyPercentage = 3;

    expect(
      selectBalanceCandidate({
        accounts: [active, weeklyDepleted],
        activeAccountId: active.id,
        activeBand: getFiveHourQuotaBand(active.quotaSummary!.hourlyPercentage),
        now
      })
    ).toBeUndefined();
  });

  it("prioritizes five-hour quota during a weekly threshold switch", () => {
    const now = 10_000_000;
    const active = account("active", 100, now);
    active.quotaSummary!.weeklyPercentage = 1;
    const highHourlyLowWeekly = account("high-hourly-low-weekly", 100, now);
    highHourlyLowWeekly.quotaSummary!.weeklyPercentage = 4;
    const lowerHourlyHealthyWeekly = account("lower-hourly-healthy-weekly", 90, now);
    lowerHourlyHealthyWeekly.quotaSummary!.weeklyPercentage = 80;

    expect(
      selectBalanceCandidate({
        accounts: [active, highHourlyLowWeekly, lowerHourlyHealthyWeekly],
        activeAccountId: active.id,
        activeBand: getFiveHourQuotaBand(active.quotaSummary!.hourlyPercentage),
        switchThreshold: 1,
        thresholdQuota: "weekly",
        now
      })?.id
    ).toBe("high-hourly-low-weekly");
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
        now
      })
    ).toBeUndefined();
  });

  it("classifies fresh quota by actual windows instead of plan labels", () => {
    const now = 10_000_000;
    const windowedPlus = account("windowed-plus", 80, now);
    windowedPlus.planType = "plus";
    const reserveFree = reserveAccount("reserve-free", 90, now);
    reserveFree.planType = "free";
    const stale = account("stale", 100, now - BALANCE_QUOTA_MAX_AGE_MS - 1);
    const failed = account("failed", 100, now);
    failed.quotaError = { message: "refresh failed", timestamp: now };
    const ambiguous = reserveAccount("ambiguous", 100, now);
    ambiguous.quotaSummary!.hourlyWindowPresent = undefined;

    expect(getBalanceQuotaCapability(windowedPlus, now)).toBe("windowed");
    expect(getBalanceQuotaCapability(reserveFree, now)).toBe("reserve");
    expect(getBalanceQuotaCapability(stale, now)).toBe("unknown");
    expect(getBalanceQuotaCapability(failed, now)).toBe("unknown");
    expect(getBalanceQuotaCapability(ambiguous, now)).toBe("unknown");
  });

  it("prefers a recovered windowed account and uses reserve only after all windowed accounts reach the floor", () => {
    const now = 10_000_000;
    const active = account("active", 2, now);
    const recovered = account("recovered", 10, now);
    const reserve = reserveAccount("reserve", 90, now);
    const params = {
      accounts: [active, recovered, reserve],
      activeAccountId: active.id,
      activeBand: getFiveHourQuotaBand(active.quotaSummary!.hourlyPercentage),
      switchThreshold: 3 as const,
      now
    };

    expect(selectBalanceCandidate(params)?.id).toBe("recovered");
    recovered.quotaSummary!.hourlyPercentage = 2;
    expect(selectBalanceCandidate(params)?.id).toBe("reserve");
  });

  it("leaves a depleted reserve for recovered windowed quota before choosing the first reserve in pool order", () => {
    const now = 10_000_000;
    const active = reserveAccount("active", 3, now);
    const recovered = account("recovered", 20, now);
    const lowerReserve = reserveAccount("reserve-low", 60, now);
    const strongerReserve = reserveAccount("reserve-high", 90, now);
    const params = {
      accounts: [active, lowerReserve, strongerReserve, recovered],
      activeAccountId: active.id,
      activeBand: 0,
      switchThreshold: 3 as const,
      now
    };

    expect(selectBalanceCandidate(params)?.id).toBe("recovered");
    recovered.quotaSummary!.hourlyPercentage = 2;
    expect(selectBalanceCandidate(params)?.id).toBe("reserve-low");
  });

  it("uses a windowed candidate strictly above the unified threshold before reserve", () => {
    const now = 10_000_000;
    const active = account("active", 1, now);
    active.quotaSummary!.weeklyPercentage = 1;
    const emergencyFallback = account("fallback", 2, now);
    const reserve = reserveAccount("reserve", 90, now);
    const params = {
      accounts: [active, emergencyFallback, reserve],
      activeAccountId: active.id,
      activeBand: 1,
      switchThreshold: 1 as const,
      thresholdQuota: "weekly" as const,
      now
    };

    expect(selectBalanceCandidate(params)?.id).toBe("fallback");
    emergencyFallback.quotaSummary!.hourlyPercentage = 1;
    expect(selectBalanceCandidate(params)?.id).toBe("reserve");
  });

  it("prioritizes plan tier before quota and recognizes K12 as Free", () => {
    const now = 10_000_000;
    const active = account("active", 1, now);
    active.planType = "free";
    const k12 = account("k12", 80, now);
    k12.planType = "ChatGPT K-12 Plan";
    const plus = account("plus", 81, now);
    plus.planType = "plus";
    const pro = account("pro", 80, now);
    pro.planType = "pro";
    const params = {
      accounts: [active, k12, plus, pro],
      activeAccountId: active.id,
      activeBand: 1,
      switchThreshold: 1 as const,
      requireFreshFreeCandidates: true,
      now
    };

    expect(selectBalanceCandidate(params)?.id).toBe("pro");
    pro.quotaSummary!.hourlyPercentage = 1;
    expect(selectBalanceCandidate(params)?.id).toBe("plus");
    expect(isFreePlanType("ChatGPT Free Plan")).toBe(true);
    expect(isFreePlanType("ChatGPT K-12 Plan")).toBe(true);
  });

  it("uses plan tier and pool order for fresh Free/K12 reserve candidates", () => {
    const now = 10_000_000;
    const active = account("active", 1, now);
    active.planType = "free";
    const freeReserve = reserveAccount("free-reserve", 100, now);
    freeReserve.planType = "free";
    const staleK12Reserve = reserveAccount("stale-k12-reserve", 100, now - FREE_SWITCH_THRESHOLD_QUOTA_MAX_AGE_MS - 1);
    staleK12Reserve.planType = "k12";
    const plusReserve = reserveAccount("plus-reserve", 99, now);
    plusReserve.planType = "plus";
    const params = {
      accounts: [active, freeReserve, staleK12Reserve, plusReserve],
      activeAccountId: active.id,
      activeBand: 1,
      switchThreshold: 1 as const,
      requireFreshFreeCandidates: true,
      now
    };

    expect(selectBalanceCandidate(params)?.id).toBe("plus-reserve");
    plusReserve.lastQuotaAt = now - BALANCE_QUOTA_MAX_AGE_MS - 1;
    expect(selectBalanceCandidate(params)?.id).toBe("free-reserve");
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

  it("clears a stale hourly band when a selected account is currently reserve-only", () => {
    initSeamlessSwitchRuntimeState({
      globalState: {
        get: () => undefined,
        update: async () => undefined
      }
    } as never);

    recordSeamlessSelection("reserve", 4);
    expect(getSeamlessSwitchRuntimeSnapshot().hourlyBands?.["reserve"]).toBe(4);
    recordSeamlessSelection("reserve", undefined);
    expect(getSeamlessSwitchRuntimeSnapshot().hourlyBands?.["reserve"]).toBeUndefined();
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

function reserveAccount(id: string, weeklyPercentage: number, lastQuotaAt: number): CodexAccountRecord {
  const result = account(id, 0, lastQuotaAt);
  result.quotaSummary!.hourlyWindowPresent = false;
  result.quotaSummary!.hourlyWindowMinutes = undefined;
  result.quotaSummary!.weeklyPercentage = weeklyPercentage;
  return result;
}

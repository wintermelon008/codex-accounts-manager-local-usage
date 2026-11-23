import { afterEach, describe, expect, it } from "vitest";
import type { CodexAccountRecord } from "../src/core/types";
import {
  moveDashboardAccountPriority,
  orderAccountsByPriority,
  toggleDashboardAccountPriority
} from "../src/domain/dashboard/accountPriority";
import { selectBalanceCandidate } from "../src/application/accounts/balanceScheduler";
import { selectGatewayFallbackCandidates } from "../src/application/accounts/gatewayFallbackSelection";
import {
  clearSeamlessSwitchPriority,
  getSeamlessSwitchPriority,
  setSeamlessSwitchPriority
} from "../src/presentation/dashboard/accountPriority";

afterEach(() => {
  clearSeamlessSwitchPriority();
});

describe("Dashboard account priority", () => {
  it("appends, removes, caps, and reorders priority accounts", () => {
    expect(toggleDashboardAccountPriority([], "a")).toEqual(["a"]);
    expect(toggleDashboardAccountPriority(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleDashboardAccountPriority(["a", "b", "c", "d", "e"], "f")).toEqual(["a", "b", "c", "d", "e"]);
    expect(moveDashboardAccountPriority(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("puts visible priority accounts before the current Dashboard order", () => {
    const accounts = [{ id: "ordinary" }, { id: "second" }, { id: "first" }];

    expect(orderAccountsByPriority(accounts, ["first", "second"]).map((account) => account.id)).toEqual([
      "first",
      "second",
      "ordinary"
    ]);
    expect(orderAccountsByPriority(accounts, ["first", "second"], "ordinary").map((account) => account.id)).toEqual([
      "ordinary",
      "first",
      "second"
    ]);
  });

  it("uses priority order among eligible seamless candidates and consumes hidden entries", () => {
    const now = 10_000_000;
    const active = quotaAccount("active", now, 10);
    const later = quotaAccount("later", now, 80);
    const first = quotaAccount("first", now, 90);
    setSeamlessSwitchPriority(["first", "later"]);

    const params = {
      accounts: [active, later, first],
      activeAccountId: active.id,
      activeBand: 1,
      accountOrder: [active.id, later.id, first.id],
      now
    };

    expect(selectBalanceCandidate(params)?.id).toBe("first");
    first.isHidden = true;
    expect(selectBalanceCandidate(params)?.id).toBe("later");
    expect(getSeamlessSwitchPriority()).toEqual(["later"]);
  });

  it.each(["free", "plus"])("puts a queued %s account ahead of an unqueued Pro account", (planType) => {
    const now = 10_000_000;
    const active = quotaAccount("active", now, 40);
    const pro = quotaAccount("pro", now, 100);
    pro.planType = "pro";
    const first = quotaAccount("first", now, 60);
    first.planType = planType;
    setSeamlessSwitchPriority([first.id]);

    expect(
      selectBalanceCandidate({
        accounts: [active, pro, first],
        activeAccountId: active.id,
        activeBand: 2,
        accountOrder: [pro.id, first.id],
        now
      })?.id
    ).toBe(first.id);
  });

  it("honors queue order across reserve and windowed candidates before plan tier", () => {
    const now = 10_000_000;
    const active = quotaAccount("active", now, 1);
    const pro = quotaAccount("pro", now, 100);
    pro.planType = "pro";
    const plus = quotaAccount("plus", now, 90);
    plus.planType = "plus";
    const freeReserve = quotaAccount("free-reserve", now, 0);
    freeReserve.planType = "free";
    freeReserve.quotaSummary!.hourlyWindowPresent = false;
    setSeamlessSwitchPriority([freeReserve.id, plus.id]);
    const params = {
      accounts: [active, pro, plus, freeReserve],
      activeAccountId: active.id,
      activeBand: 1,
      now
    };

    expect(selectBalanceCandidate(params)?.id).toBe(freeReserve.id);
    setSeamlessSwitchPriority([plus.id, freeReserve.id]);
    expect(selectBalanceCandidate(params)?.id).toBe(plus.id);
    clearSeamlessSwitchPriority();
    expect(selectBalanceCandidate(params)?.id).toBe(pro.id);
  });

  it("skips queued targets with unsafe quota or outside the visible scope", () => {
    const now = 10_000_000;
    const active = quotaAccount("active", now, 1);
    const depleted = quotaAccount("depleted", now, 1);
    const filteredOut = quotaAccount("filtered-out", now, 90);
    const safe = quotaAccount("safe", now, 80);
    setSeamlessSwitchPriority([depleted.id, filteredOut.id, safe.id]);

    expect(
      selectBalanceCandidate({
        accounts: [active, depleted, filteredOut, safe],
        activeAccountId: active.id,
        activeBand: 1,
        visibleAccountIds: new Set([active.id, depleted.id, safe.id]),
        now
      })?.id
    ).toBe(safe.id);
    expect(getSeamlessSwitchPriority()).toEqual([depleted.id, filteredOut.id, safe.id]);
  });

  it("uses priority order for Gateway fallback after freshness eligibility", () => {
    const now = 10_000_000;
    const first = quotaAccount("first", now, 40);
    first.planType = "free";
    first.quotaSummary!.hourlyWindowPresent = false;
    const later = quotaAccount("later", now, 95);
    later.planType = "pro";
    setSeamlessSwitchPriority(["first", "later"]);

    const config = {
      get<T>(key: string, defaultValue?: T): T {
        return (key === "seamlessSwitchEnabled" ? true : defaultValue) as T;
      }
    };

    expect(selectGatewayFallbackCandidates([later, first], config, now).map((account) => account.id)).toEqual([
      "first",
      "later"
    ]);
    clearSeamlessSwitchPriority();
    expect(selectGatewayFallbackCandidates([first, later], config, now).map((account) => account.id)).toEqual([
      "later",
      "first"
    ]);
  });
});

function quotaAccount(id: string, now: number, hourlyPercentage: number): CodexAccountRecord {
  return {
    id,
    email: `${id}@example.invalid`,
    accountKind: "chatgpt",
    quotaMode: "chatgpt",
    isActive: id === "active",
    providerActive: id === "active",
    balancePoolEnabled: true,
    createdAt: 1,
    updatedAt: 1,
    lastQuotaAt: now,
    quotaSummary: {
      hourlyPercentage,
      hourlyWindowPresent: true,
      hourlyWindowMinutes: 300,
      weeklyPercentage: 100,
      weeklyWindowPresent: true,
      weeklyWindowMinutes: 10_080,
      codeReviewPercentage: 100
    }
  };
}

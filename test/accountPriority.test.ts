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

  it("uses priority order for Gateway fallback after freshness eligibility", () => {
    const now = 10_000_000;
    const first = quotaAccount("first", now, 40);
    const later = quotaAccount("later", now, 95);
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

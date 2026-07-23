import { describe, expect, it } from "vitest";
import type { CodexAccountRecord } from "../src/core/types";
import {
  selectFreshSub2ApiGatewayFallbackCandidate,
  selectSub2ApiGatewayFallbackCandidates
} from "../src/local/sub2apiGateway/fallbackSelection";

describe("Sub2API Gateway fallback candidate selection", () => {
  it("uses only fresh visible pool accounts and ranks usable five-hour windows ahead of reserves", () => {
    const now = Date.now();
    const candidates = selectSub2ApiGatewayFallbackCandidates(
      [
        account("windowed-low", { hourly: 30, weekly: 99, now }),
        account("windowed-high", { hourly: 80, weekly: 40, now }),
        reserveAccount("reserve-high", { weekly: 100, now }),
        account("hidden", { hourly: 100, weekly: 100, now, isHidden: true }),
        account("not-in-pool", { hourly: 100, weekly: 100, now, balancePoolEnabled: false }),
        account("stale", { hourly: 100, weekly: 100, now: now - 16 * 60 * 1_000 }),
        account("at-floor", { hourly: 100, weekly: 3, now }),
        account("group-a-hidden", { hourly: 100, weekly: 100, now, accountGroup: "A" })
      ],
      configuration({ seamlessSwitchThreshold: 3, seamlessSwitchGroupAVisible: false }),
      now
    );

    expect(candidates.map((account) => account.id)).toEqual(["windowed-high", "windowed-low", "reserve-high"]);
  });

  it("ranks equally capable accounts by remaining weekly quota and then stable account ID", () => {
    const now = Date.now();
    const candidates = selectSub2ApiGatewayFallbackCandidates(
      [
        account("zeta", { hourly: 50, weekly: 70, now }),
        account("alpha", { hourly: 50, weekly: 70, now }),
        account("weekly-best", { hourly: 50, weekly: 80, now })
      ],
      configuration({}),
      now
    );

    expect(candidates.map((account) => account.id)).toEqual(["weekly-best", "alpha", "zeta"]);
  });

  it("force-refreshes a newly leading candidate before selecting a Gateway fallback target", async () => {
    const now = Date.now();
    const first = account("first", { hourly: 50, weekly: 90, now });
    const second = account("second", { hourly: 50, weekly: 80, now });
    const accounts = [first, second];
    const refreshed: string[] = [];

    const candidate = await selectFreshSub2ApiGatewayFallbackCandidate(
      {
        listAccounts: async () => accounts,
        refreshQuota: async (accountId) => {
          refreshed.push(accountId);
          if (accountId === first.id) {
            first.quotaSummary!.weeklyPercentage = 50;
          } else {
            second.quotaSummary!.weeklyPercentage = 70;
          }
          const refreshedAccount = accounts.find((account) => account.id === accountId)!;
          refreshedAccount.lastQuotaAt = now;
        }
      },
      configuration({}),
      { now: () => now }
    );

    expect(refreshed).toEqual(["first", "second"]);
    expect(candidate?.id).toBe("second");
  });

  it("excludes a candidate whose mandatory quota refresh fails during one fallback transaction", async () => {
    const now = Date.now();
    const first = account("first", { hourly: 90, weekly: 90, now });
    const second = account("second", { hourly: 80, weekly: 80, now });
    const excludedAccountIds = new Set<string>();

    const candidate = await selectFreshSub2ApiGatewayFallbackCandidate(
      {
        listAccounts: async () => [first, second],
        refreshQuota: async (accountId) => {
          if (accountId === first.id) {
            throw new Error("refresh failed");
          }
        }
      },
      configuration({}),
      { excludedAccountIds, now: () => now }
    );

    expect(excludedAccountIds).toEqual(new Set(["first"]));
    expect(candidate?.id).toBe("second");
  });
});

function configuration(values: Record<string, unknown>): { get<T>(section: string, fallback?: T): T } {
  return {
    get: <T>(section: string, fallback?: T): T => (values[section] as T | undefined) ?? (fallback as T)
  };
}

function account(
  id: string,
  params: {
    hourly: number;
    weekly: number;
    now: number;
    isHidden?: boolean;
    balancePoolEnabled?: boolean;
    accountGroup?: "A" | "B" | "C";
  }
): CodexAccountRecord {
  return {
    id,
    email: `${id}@example.invalid`,
    isActive: false,
    isHidden: params.isHidden,
    balancePoolEnabled: params.balancePoolEnabled ?? true,
    accountGroup: params.accountGroup,
    lastQuotaAt: params.now,
    quotaSummary: {
      hourlyPercentage: params.hourly,
      hourlyWindowPresent: true,
      hourlyWindowMinutes: 300,
      weeklyPercentage: params.weekly,
      weeklyWindowPresent: true,
      weeklyWindowMinutes: 10_080,
      codeReviewPercentage: 100
    },
    createdAt: 1,
    updatedAt: 1
  };
}

function reserveAccount(id: string, params: { weekly: number; now: number }): CodexAccountRecord {
  const result = account(id, { hourly: 0, weekly: params.weekly, now: params.now });
  result.quotaSummary!.hourlyWindowPresent = false;
  result.quotaSummary!.hourlyWindowMinutes = undefined;
  return result;
}

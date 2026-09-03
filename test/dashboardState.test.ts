import { describe, expect, it } from "vitest";
import {
  buildMetrics,
  resolveAccountTokenUsage,
  sortDashboardAccounts
} from "../src/application/dashboard/buildDashboardState";
import type { AccountTokenUsageSnapshot } from "../src/services/localUsageAnalytics";
import { formatPlanType, getDashboardCopy } from "../src/application/dashboard/copy";
import { sortDashboardAccountsForDisplay } from "../webview-src/dashboard/helpers";

describe("sortDashboardAccounts", () => {
  it("puts the current window account before active accounts", () => {
    const accounts = [
      { id: "active", isActive: true, createdAt: 3, email: "active@example.com" },
      { id: "current", isActive: false, createdAt: 2, email: "current@example.com" },
      { id: "other", isActive: false, createdAt: 1, email: "other@example.com" }
    ];

    const sorted = sortDashboardAccounts(accounts, "current");

    expect(sorted.map((account) => account.id)).toEqual(["current", "active", "other"]);
  });
});

describe("formatPlanType", () => {
  it("normalizes raw ChatGPT plan identifiers", () => {
    expect(formatPlanType("chatgptteamplan", "zh")).toBe("Team");
    expect(formatPlanType("chatgptplusplan", "zh")).toBe("Plus");
  });
});

describe("buildMetrics", () => {
  it("labels a Free 30-day quota as monthly", () => {
    const metrics = buildMetrics(
      {
        id: "free-account",
        email: "free@example.com",
        isActive: true,
        planType: "chatgptfreeplan",
        createdAt: 1,
        updatedAt: 1,
        quotaSummary: {
          hourlyPercentage: 0,
          weeklyPercentage: 1,
          weeklyWindowMinutes: 43_200,
          weeklyWindowPresent: true
        }
      },
      getDashboardCopy("zh"),
      "zh"
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.label).toBe("每月");
  });

  it.each(["chatgptfreeplan", "ChatGPT K-12 Plan", "plus", "pro"])(
    "keeps a restored 5-hour metric visible for %s accounts",
    (planType) => {
      const metrics = buildMetrics(
        {
          id: "free-windowed-account",
          email: "free-windowed@example.com",
          isActive: true,
          planType,
          createdAt: 1,
          updatedAt: 1,
          quotaSummary: {
            hourlyPercentage: 100,
            hourlyResetTime: 1_800_018_000,
            hourlyWindowMinutes: 300,
            hourlyWindowPresent: true,
            weeklyPercentage: 100,
            weeklyWindowMinutes: 43_200,
            weeklyWindowPresent: true
          }
        },
        getDashboardCopy("zh"),
        "zh"
      );

      expect(metrics.map((metric) => metric.key)).toEqual(["hourly", "weekly"]);
      expect(metrics[0]?.label).toBe("5小时");
      expect(metrics[1]?.label).toBe("每月");
    }
  );
});

describe("resolveAccountTokenUsage", () => {
  it("falls back to and aggregates the current weekly window when reset timestamps drift", () => {
    const weeklyResetAt = 1_800_604_800;
    const snapshot: AccountTokenUsageSnapshot = {
      status: "ready",
      isRefreshing: false,
      calculatedAt: weeklyResetAt * 1_000,
      windowsByAccount: {
        account: [
          {
            window: "weekly",
            resetAt: weeklyResetAt - 300,
            eventCount: 2,
            lastObservedAt: 1_800_000_100 * 1_000,
            byModel: [
              {
                model: "gpt-5.6-luna",
                inputTokens: 90,
                cachedInputTokens: 10,
                outputTokens: 20,
                reasoningOutputTokens: 5,
                totalTokens: 110
              }
            ],
            inputTokens: 90,
            cachedInputTokens: 10,
            outputTokens: 20,
            reasoningOutputTokens: 5,
            totalTokens: 110
          },
          {
            window: "weekly",
            resetAt: weeklyResetAt - 900,
            eventCount: 1,
            lastObservedAt: 1_800_100_000 * 1_000,
            byModel: [],
            inputTokens: 60,
            cachedInputTokens: 0,
            outputTokens: 10,
            reasoningOutputTokens: 0,
            totalTokens: 70
          }
        ]
      }
    };

    const usage = resolveAccountTokenUsage(
      {
        id: "account",
        email: "account@example.com",
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
        quotaSummary: {
          hourlyWindowPresent: true,
          hourlyResetTime: 1_800_000_000,
          weeklyWindowPresent: true,
          weeklyResetTime: weeklyResetAt,
          weeklyWindowMinutes: 10_080
        }
      },
      snapshot
    );

    expect(usage).toMatchObject({
      status: "tracking",
      window: "weekly",
      resetAt: weeklyResetAt,
      totalTokens: 180
    });
  });
});

describe("sortDashboardAccountsForDisplay", () => {
  const account = (
    id: string,
    displayName: string,
    createdAt: number | undefined,
    quota: number | undefined,
    quotaResetAt: number | undefined,
    isActive = false,
    lastQuotaAt: number | undefined = undefined
  ) =>
    ({
      id,
      displayName,
      email: `${id}@example.com`,
      createdAt,
      isActive,
      lastQuotaAt,
      metrics: [
        {
          key: "weekly",
          label: "Weekly",
          percentage: quota,
          resetAt: quotaResetAt,
          visible: quota !== undefined
        }
      ]
    }) as DashboardState["accounts"][number];

  const accounts = [
    account("beta", "Beta", 200, 40, 30, false, 300),
    account("alpha", "Alpha", 100, 90, 20, false, 100),
    account("gamma", "Gamma", 300, 10, 40, false, 200)
  ];

  it("sorts by name, import time, remaining quota, and displayed quota reset time in both directions", () => {
    expect(sortDashboardAccountsForDisplay(accounts, { key: "name", direction: "asc" }).map((item) => item.id)).toEqual(
      ["alpha", "beta", "gamma"]
    );
    expect(
      sortDashboardAccountsForDisplay(accounts, { key: "name", direction: "desc" }).map((item) => item.id)
    ).toEqual(["gamma", "beta", "alpha"]);
    expect(
      sortDashboardAccountsForDisplay(accounts, { key: "createdAt", direction: "asc" }).map((item) => item.id)
    ).toEqual(["alpha", "beta", "gamma"]);
    expect(
      sortDashboardAccountsForDisplay(accounts, { key: "createdAt", direction: "desc" }).map((item) => item.id)
    ).toEqual(["gamma", "beta", "alpha"]);
    expect(
      sortDashboardAccountsForDisplay(accounts, { key: "quota", direction: "asc" }).map((item) => item.id)
    ).toEqual(["gamma", "beta", "alpha"]);
    expect(
      sortDashboardAccountsForDisplay(accounts, { key: "quota", direction: "desc" }).map((item) => item.id)
    ).toEqual(["alpha", "beta", "gamma"]);
    expect(
      sortDashboardAccountsForDisplay(accounts, { key: "quotaUpdatedAt", direction: "asc" }).map((item) => item.id)
    ).toEqual(["alpha", "beta", "gamma"]);
    expect(
      sortDashboardAccountsForDisplay(accounts, { key: "quotaUpdatedAt", direction: "desc" }).map((item) => item.id)
    ).toEqual(["gamma", "beta", "alpha"]);
  });

  it("uses the reset time shown below the main quota bar instead of the hourly bar", () => {
    const hourlyFirst = {
      ...account("hourly-first", "Hourly first", 100, 50, 2),
      metrics: [
        { key: "hourly", label: "5-hour", resetAt: 2, visible: true },
        { key: "weekly", label: "Weekly", resetAt: 200, visible: true }
      ]
    } as DashboardState["accounts"][number];
    const weeklyFirst = {
      ...account("weekly-first", "Weekly first", 200, 50, 1),
      metrics: [
        { key: "hourly", label: "5-hour", resetAt: 100, visible: true },
        { key: "weekly", label: "Weekly", resetAt: 50, visible: true }
      ]
    } as DashboardState["accounts"][number];

    expect(
      sortDashboardAccountsForDisplay([hourlyFirst, weeklyFirst], { key: "quotaUpdatedAt", direction: "asc" }).map(
        (item) => item.id
      )
    ).toEqual(["weekly-first", "hourly-first"]);
  });

  it("sorts names by the visible account email instead of the workspace label", () => {
    const zuluEmail = { ...account("zulu", "Personal", 100, 50, 100), email: "zulu@example.com" };
    const alphaEmail = { ...account("alpha", "Personal", 200, 50, 100), email: "alpha@example.com" };

    expect(
      sortDashboardAccountsForDisplay([zuluEmail, alphaEmail], { key: "name", direction: "asc" }).map((item) => item.id)
    ).toEqual(["alpha", "zulu"]);
  });

  it("keeps accounts without a sortable value at the end in either direction", () => {
    const withMissingQuota = [...accounts, account("missing", "Missing", 400, undefined, undefined)];

    expect(sortDashboardAccountsForDisplay(withMissingQuota, { key: "quota", direction: "asc" }).at(-1)?.id).toBe(
      "missing"
    );
    expect(sortDashboardAccountsForDisplay(withMissingQuota, { key: "quota", direction: "desc" }).at(-1)?.id).toBe(
      "missing"
    );
  });

  it("keeps the active account first and uses a stable identity tie-breaker", () => {
    const active = account("active", "Zulu", 500, 1, 500, true);
    const sameValue = account("same-value", "Alpha", 100, 50, 100);
    const other = account("other", "Beta", 100, 50, 100);

    expect(
      sortDashboardAccountsForDisplay([sameValue, active, other], { key: "name", direction: "asc" }).map(
        (item) => item.id
      )
    ).toEqual(["active", "other", "same-value"]);
    expect(
      sortDashboardAccountsForDisplay([other, sameValue], { key: "quotaUpdatedAt", direction: "desc" }).map(
        (item) => item.id
      )
    ).toEqual(["other", "same-value"]);
  });

  it("keeps the account loaded by this window before the globally active account", () => {
    const currentWindow = { ...account("current-window", "Zulu", 1, 10, 1), isCurrentWindowAccount: true };
    const globallyActive = account("global-active", "Alpha", 2, 90, 2, true);

    expect(
      sortDashboardAccountsForDisplay([globallyActive, currentWindow], { key: "name", direction: "asc" }).map(
        (item) => item.id
      )
    ).toEqual(["current-window", "global-active"]);
  });
});

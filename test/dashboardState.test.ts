import { describe, expect, it } from "vitest";
import { buildMetrics, sortDashboardAccounts } from "../src/application/dashboard/buildDashboardState";
import { formatPlanType, getDashboardCopy } from "../src/application/dashboard/copy";

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

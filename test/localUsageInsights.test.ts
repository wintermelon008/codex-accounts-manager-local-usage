import { describe, expect, it } from "vitest";
import type {
  DashboardLocalUsageDayViewModel,
  DashboardLocalUsageModelViewModel,
  DashboardLocalUsageViewModel
} from "../src/domain/dashboard/types";
import { deriveLocalUsageRange, estimateStandardApiCost } from "../webview-src/dashboard/localUsageInsights";

describe("deriveLocalUsageRange", () => {
  it("uses the selected trailing dates for totals, event count, and model distribution", () => {
    const usage = usageSnapshot();

    const range = deriveLocalUsageRange(usage, 7);

    expect(range.days).toBe(7);
    expect(range.byDay).toHaveLength(7);
    expect(range.byDay[0]?.date).toBe("2026-07-24");
    expect(range.eventCount).toBe(2);
    expect(range.total.totalTokens).toBe(300);
    expect(range.byModel).toEqual([
      expect.objectContaining({ model: "gpt-5.6-terra", totalTokens: 200 }),
      expect.objectContaining({ model: "gpt-5.6-sol", totalTokens: 100 })
    ]);
    expect(range.byModel.some((row) => row.model === "gpt-5.5")).toBe(false);
  });
});

describe("estimateStandardApiCost", () => {
  it("prices uncached input, cached input, and output separately while excluding unknown models", () => {
    const price = estimateStandardApiCost([
      modelUsage("gpt-5.6-sol", {
        inputTokens: 1_000_000,
        cachedInputTokens: 200_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000
      }),
      modelUsage("unknown", {
        inputTokens: 40,
        cachedInputTokens: 0,
        outputTokens: 10,
        totalTokens: 50
      })
    ]);

    expect(price.amountUsd).toBeCloseTo(7.1, 8);
    expect(price.pricedTokens).toBe(1_100_000);
    expect(price.unpricedTokens).toBe(50);
  });
});

function usageSnapshot(): DashboardLocalUsageViewModel {
  const byDay: DashboardLocalUsageDayViewModel[] = Array.from({ length: 30 }, (_, index) => {
    const date = `2026-07-${String(index + 1).padStart(2, "0")}`;
    if (date === "2026-07-24") {
      return dayUsage(date, 1, 200);
    }
    if (date === "2026-07-30") {
      return dayUsage(date, 1, 100);
    }
    if (date === "2026-07-01") {
      return dayUsage(date, 1, 999);
    }
    return dayUsage(date, 0, 0);
  });

  return {
    status: "ready",
    isRefreshing: false,
    periodDays: 30,
    calculatedAt: 1,
    nextRefreshAt: 2,
    sourceFileCount: 1,
    eventCount: 3,
    total: totals(1_299),
    byDay,
    byModel: [],
    byDayAndModel: [
      { date: "2026-07-01", ...modelUsage("gpt-5.5", { totalTokens: 999 }) },
      { date: "2026-07-24", ...modelUsage("gpt-5.6-terra", { totalTokens: 200 }) },
      { date: "2026-07-30", ...modelUsage("gpt-5.6-sol", { totalTokens: 100 }) }
    ]
  };
}

function dayUsage(date: string, eventCount: number, totalTokens: number): DashboardLocalUsageDayViewModel {
  return {
    date,
    eventCount,
    ...totals(totalTokens)
  };
}

function modelUsage(
  model: string,
  values: Partial<DashboardLocalUsageModelViewModel>
): DashboardLocalUsageModelViewModel {
  return {
    model,
    ...totals(values.totalTokens ?? 0),
    ...values
  };
}

function totals(totalTokens: number) {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens
  };
}

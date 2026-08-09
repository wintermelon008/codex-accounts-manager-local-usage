import { describe, expect, it } from "vitest";
import type {
  DashboardLocalUsageBucketModelViewModel,
  DashboardLocalUsageBucketViewModel,
  DashboardLocalUsageDayViewModel,
  DashboardLocalUsageModelViewModel,
  DashboardLocalUsageViewModel
} from "../src/domain/dashboard/types";
import { deriveLocalUsageRange, estimateStandardApiCost } from "../webview-src/dashboard/localUsageInsights";

describe("deriveLocalUsageRange", () => {
  it("uses the selected trailing dates for totals, event count, and model distribution", () => {
    const range = deriveLocalUsageRange(usageSnapshot(), "7d");

    expect(range.range).toBe("7d");
    expect(range.bars).toHaveLength(7);
    expect(range.bars[0]?.date).toBe("2026-07-08");
    expect(range.eventCount).toBe(2);
    expect(range.total.totalTokens).toBe(300);
    expect(range.byModel).toEqual([
      expect.objectContaining({ model: "gpt-5.6-terra", totalTokens: 200 }),
      expect.objectContaining({ model: "gpt-5.6-sol", totalTokens: 100 })
    ]);
    expect(range.byModel.some((row) => row.model === "gpt-5.5")).toBe(false);
  });

  it("projects 24h into eight three-hour bars and 3d into six half-day bars", () => {
    const usage = shortUsageSnapshot();

    expect(deriveLocalUsageRange(usage, "24h").bars).toHaveLength(8);
    const threeDay = deriveLocalUsageRange(usage, "3d");
    expect(threeDay.bars).toHaveLength(6);
    expect(threeDay.bars.slice(0, 2).map((bar) => bar.total.totalTokens)).toEqual([10, 26]);
    expect(threeDay.bars.slice(-2).map((bar) => bar.total.totalTokens)).toEqual([810, 826]);
    expect(threeDay.total.totalTokens).toBe(2_508);
  });

  it("keeps every selectable range within the seven-row display limit", () => {
    const usage = shortUsageSnapshot();
    expect(deriveLocalUsageRange(usage, "7d").bars).toHaveLength(7);
    expect(deriveLocalUsageRange(usage, "14d").bars).toHaveLength(7);
    expect(deriveLocalUsageRange(usage, "7w").bars).toHaveLength(7);
    expect(deriveLocalUsageRange(usage, "7m").bars).toHaveLength(7);
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
      modelUsage("gpt-5.6-terra", {
        inputTokens: 1_000_000,
        cachedInputTokens: 500_000,
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

    expect(price.amountUsd).toBeCloseTo(9.975, 8);
    expect(price.pricedTokens).toBe(2_200_000);
    expect(price.unpricedTokens).toBe(50);
  });
});

function usageSnapshot(): DashboardLocalUsageViewModel {
  const byDay: DashboardLocalUsageDayViewModel[] = Array.from({ length: 14 }, (_, index) => {
    const date = `2026-07-${String(index + 1).padStart(2, "0")}`;
    if (date === "2026-07-08") {
      return dayUsage(date, 1, 200);
    }
    if (date === "2026-07-14") {
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
    periodDays: 14,
    timeZone: "Asia/Shanghai",
    calculatedAt: 1,
    nextRefreshAt: 2,
    sourceFileCount: 1,
    eventCount: 3,
    total: totals(1_299),
    by3Hour: [],
    by3HourAndModel: [],
    byDay,
    byModel: [],
    byDayAndModel: [
      { date: "2026-07-01", ...modelUsage("gpt-5.5", { totalTokens: 999 }) },
      { date: "2026-07-08", ...modelUsage("gpt-5.6-terra", { totalTokens: 200 }) },
      { date: "2026-07-14", ...modelUsage("gpt-5.6-sol", { totalTokens: 100 }) }
    ]
  };
}

function shortUsageSnapshot(): DashboardLocalUsageViewModel {
  const dates = ["2026-07-12", "2026-07-13", "2026-07-14"];
  const by3Hour: DashboardLocalUsageBucketViewModel[] = [];
  const by3HourAndModel: DashboardLocalUsageBucketModelViewModel[] = [];
  const byDay: DashboardLocalUsageDayViewModel[] = [];
  for (const [dayIndex, date] of dates.entries()) {
    let dailyTotal = 0;
    for (let bucketIndex = 0; bucketIndex < 8; bucketIndex += 1) {
      const startAt = shanghaiTimestamp(date, bucketIndex * 3);
      const endAt = shanghaiTimestamp(date, bucketIndex * 3 + 3);
      const totalTokens = dayIndex * 100 + bucketIndex + 1;
      dailyTotal += totalTokens;
      by3Hour.push({
        startAt,
        endAt,
        eventCount: 1,
        ...totals(totalTokens)
      });
      by3HourAndModel.push({
        startAt,
        model: "gpt-5.6-sol",
        ...totals(totalTokens)
      });
    }
    byDay.push({ date, eventCount: 8, ...totals(dailyTotal) });
  }
  return {
    status: "ready",
    isRefreshing: false,
    periodDays: 3,
    timeZone: "Asia/Shanghai",
    calculatedAt: Date.parse("2026-07-14T12:00:00.000Z"),
    nextRefreshAt: Date.parse("2026-07-14T13:00:00.000Z"),
    sourceFileCount: 1,
    eventCount: 24,
    total: totals(2_508),
    by3Hour,
    by3HourAndModel,
    byDay,
    byModel: [],
    byDayAndModel: []
  };
}

function shanghaiTimestamp(date: string, hour: number): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1), hour) - 8 * 60 * 60 * 1000;
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

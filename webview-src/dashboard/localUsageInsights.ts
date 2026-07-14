import type {
  DashboardLocalUsageModelViewModel,
  DashboardLocalUsageRange,
  DashboardLocalUsageTokenTotals,
  DashboardLocalUsageViewModel
} from "../../src/domain/dashboard/types";

export const LOCAL_USAGE_RANGE_OPTIONS: readonly DashboardLocalUsageRange[] = ["24h", "7d", "14d"];

export type LocalUsagePriceEstimate = {
  amountUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
};

export type LocalUsageRangeBar = {
  key: string;
  date?: string;
  startAt?: number;
  endAt?: number;
  eventCount: number;
  total: DashboardLocalUsageTokenTotals;
  price: LocalUsagePriceEstimate;
};

export type LocalUsageRangeViewModel = {
  range: DashboardLocalUsageRange;
  eventCount: number;
  total: DashboardLocalUsageTokenTotals;
  bars: LocalUsageRangeBar[];
  byModel: DashboardLocalUsageModelViewModel[];
};

type ApiRateCard = {
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
  outputPerMillionUsd: number;
};

const API_RATE_CARDS: Array<{ matches: (model: string) => boolean; rates: ApiRateCard }> = [
  {
    matches: (model) => model.startsWith("gpt-5.6-terra"),
    rates: { inputPerMillionUsd: 2.5, cachedInputPerMillionUsd: 0.25, outputPerMillionUsd: 15 }
  },
  {
    matches: (model) => model.startsWith("gpt-5.6-luna"),
    rates: { inputPerMillionUsd: 1, cachedInputPerMillionUsd: 0.1, outputPerMillionUsd: 6 }
  },
  {
    matches: (model) => model === "gpt-5.6" || model.startsWith("gpt-5.6-sol"),
    rates: { inputPerMillionUsd: 5, cachedInputPerMillionUsd: 0.5, outputPerMillionUsd: 30 }
  },
  {
    matches: (model) => model === "gpt-5.5" || /^gpt-5\.5-\d{4}-\d{2}-\d{2}$/u.test(model),
    rates: { inputPerMillionUsd: 5, cachedInputPerMillionUsd: 0.5, outputPerMillionUsd: 30 }
  }
];

export function deriveLocalUsageRange(
  usage: DashboardLocalUsageViewModel,
  requestedRange: DashboardLocalUsageRange
): LocalUsageRangeViewModel {
  if (requestedRange === "24h") {
    return deriveThreeHourRange(usage);
  }

  const days = requestedRange === "14d" ? 14 : 7;
  const byDay = usage.byDay.slice(-days);
  const includedDates = new Set(byDay.map((day) => day.date));
  const modelsByDate = new Map<string, DashboardLocalUsageModelViewModel[]>();
  const includedModels: DashboardLocalUsageModelViewModel[] = [];

  for (const row of usage.byDayAndModel) {
    if (!includedDates.has(row.date)) {
      continue;
    }

    const bucket = modelsByDate.get(row.date) ?? [];
    bucket.push(row);
    modelsByDate.set(row.date, bucket);
    includedModels.push(row);
  }

  const bars = byDay.map((day) => {
    const modelUsage = aggregateModelUsage(modelsByDate.get(day.date) ?? []);
    return {
      key: `day-${day.date}`,
      date: day.date,
      eventCount: day.eventCount,
      total: copyTotals(day),
      price: estimateStandardApiCost(modelUsage)
    };
  });

  return {
    range: requestedRange,
    eventCount: bars.reduce((count, bar) => count + bar.eventCount, 0),
    total: sumTotals(bars.map((bar) => bar.total)),
    bars,
    byModel: aggregateModelUsage(includedModels)
  };
}

export function estimateStandardApiCost(
  byModel: readonly DashboardLocalUsageModelViewModel[]
): LocalUsagePriceEstimate {
  let amountUsd = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;

  for (const usage of byModel) {
    const rates = rateCardForModel(usage.model);
    if (!rates) {
      unpricedTokens += usage.totalTokens;
      continue;
    }

    const cachedInputTokens = Math.min(usage.inputTokens, usage.cachedInputTokens);
    const uncachedInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);
    amountUsd +=
      (uncachedInputTokens / 1_000_000) * rates.inputPerMillionUsd +
      (cachedInputTokens / 1_000_000) * rates.cachedInputPerMillionUsd +
      (usage.outputTokens / 1_000_000) * rates.outputPerMillionUsd;
    pricedTokens += usage.totalTokens;
  }

  return { amountUsd, pricedTokens, unpricedTokens };
}

function deriveThreeHourRange(usage: DashboardLocalUsageViewModel): LocalUsageRangeViewModel {
  const modelsByBucket = new Map<number, DashboardLocalUsageModelViewModel[]>();
  for (const row of usage.byThreeHourAndModel) {
    const bucket = modelsByBucket.get(row.startAt) ?? [];
    bucket.push(row);
    modelsByBucket.set(row.startAt, bucket);
  }

  const bars = usage.byThreeHour.map((bucket) => {
    const modelUsage = aggregateModelUsage(modelsByBucket.get(bucket.startAt) ?? []);
    return {
      key: `three-hour-${bucket.startAt}`,
      startAt: bucket.startAt,
      endAt: bucket.endAt,
      eventCount: bucket.eventCount,
      total: copyTotals(bucket),
      price: estimateStandardApiCost(modelUsage)
    };
  });

  return {
    range: "24h",
    eventCount: bars.reduce((count, bar) => count + bar.eventCount, 0),
    total: sumTotals(bars.map((bar) => bar.total)),
    bars,
    byModel: aggregateModelUsage(usage.byThreeHourAndModel)
  };
}

function aggregateModelUsage(
  rows: readonly DashboardLocalUsageModelViewModel[]
): DashboardLocalUsageModelViewModel[] {
  const byModel = new Map<string, DashboardLocalUsageModelViewModel>();
  for (const row of rows) {
    const existing = byModel.get(row.model) ?? { model: row.model, ...emptyTotals() };
    addTotals(existing, row);
    byModel.set(row.model, existing);
  }

  return [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
}

function rateCardForModel(model: string): ApiRateCard | undefined {
  const normalized = model.trim().toLowerCase();
  return API_RATE_CARDS.find((entry) => entry.matches(normalized))?.rates;
}

function copyTotals(source: DashboardLocalUsageTokenTotals): DashboardLocalUsageTokenTotals {
  return {
    inputTokens: source.inputTokens,
    cachedInputTokens: source.cachedInputTokens,
    outputTokens: source.outputTokens,
    reasoningOutputTokens: source.reasoningOutputTokens,
    totalTokens: source.totalTokens
  };
}

function sumTotals(rows: readonly DashboardLocalUsageTokenTotals[]): DashboardLocalUsageTokenTotals {
  return rows.reduce<DashboardLocalUsageTokenTotals>((total, row) => addTotals(total, row), emptyTotals());
}

function emptyTotals(): DashboardLocalUsageTokenTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function addTotals(
  target: DashboardLocalUsageTokenTotals,
  source: DashboardLocalUsageTokenTotals
): DashboardLocalUsageTokenTotals {
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
  return target;
}

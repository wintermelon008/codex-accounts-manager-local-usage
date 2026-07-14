import type {
  DashboardLocalUsageModelViewModel,
  DashboardLocalUsageRangeDays,
  DashboardLocalUsageTokenTotals,
  DashboardLocalUsageViewModel
} from "../../src/domain/dashboard/types";

export const LOCAL_USAGE_RANGE_OPTIONS: readonly DashboardLocalUsageRangeDays[] = [7, 14, 30];

export type LocalUsageRangeViewModel = {
  days: number;
  eventCount: number;
  total: DashboardLocalUsageTokenTotals;
  byDay: DashboardLocalUsageViewModel["byDay"];
  byModel: DashboardLocalUsageModelViewModel[];
};

export type LocalUsagePriceEstimate = {
  amountUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
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
  requestedDays: DashboardLocalUsageRangeDays
): LocalUsageRangeViewModel {
  const days = Math.min(requestedDays, usage.byDay.length);
  const byDay = usage.byDay.slice(-days);
  const includedDates = new Set(byDay.map((day) => day.date));
  const byModel = new Map<string, DashboardLocalUsageModelViewModel>();

  for (const row of usage.byDayAndModel) {
    if (!includedDates.has(row.date)) {
      continue;
    }

    const existing = byModel.get(row.model) ?? {
      model: row.model,
      ...emptyTotals()
    };
    addTotals(existing, row);
    byModel.set(row.model, existing);
  }

  return {
    days,
    eventCount: byDay.reduce((count, day) => count + day.eventCount, 0),
    total: byDay.reduce<DashboardLocalUsageTokenTotals>((total, day) => addTotals(total, day), emptyTotals()),
    byDay,
    byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model))
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

function rateCardForModel(model: string): ApiRateCard | undefined {
  const normalized = model.trim().toLowerCase();
  return API_RATE_CARDS.find((entry) => entry.matches(normalized))?.rates;
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

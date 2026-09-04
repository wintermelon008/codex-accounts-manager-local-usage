import {
  DASHBOARD_LOCAL_USAGE_RANGE_OPTIONS,
  type DashboardLocalUsageBucketModelViewModel,
  type DashboardLocalUsageBucketViewModel,
  type DashboardLocalUsageDayModelViewModel,
  type DashboardLocalUsageDayViewModel,
  type DashboardLocalUsageModelViewModel,
  type DashboardLocalUsageRange,
  type DashboardLocalUsageTokenTotals,
  type DashboardLocalUsageViewModel
} from "../../src/domain/dashboard/types";

export const LOCAL_USAGE_RANGE_OPTIONS: readonly DashboardLocalUsageRange[] = DASHBOARD_LOCAL_USAGE_RANGE_OPTIONS;

export type LocalUsagePriceEstimate = {
  amountUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
};

export type LocalUsageRangeBar = {
  key: string;
  label: string;
  /** Retained as a date-key alias for callers that used the former daily view. */
  date?: string;
  startAt: number;
  endAt: number;
  eventCount: number;
  total: DashboardLocalUsageTokenTotals;
  byModel: DashboardLocalUsageModelViewModel[];
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

type ZonedDateTimeParts = {
  date: string;
  year: number;
  month: number;
  day: number;
  hour: number;
};

const API_RATE_CARDS: Array<{ matches: (model: string) => boolean; rates: ApiRateCard }> = [
  {
    matches: (model) => model.startsWith("gpt-5.6-terra"),
    rates: { inputPerMillionUsd: 2, cachedInputPerMillionUsd: 0.2, outputPerMillionUsd: 12 }
  },
  {
    matches: (model) => model.startsWith("gpt-5.6-luna"),
    rates: { inputPerMillionUsd: 0.2, cachedInputPerMillionUsd: 0.02, outputPerMillionUsd: 1.2 }
  },
  {
    matches: (model) => model === "gpt-5.6" || model.startsWith("gpt-5.6-sol"),
    rates: { inputPerMillionUsd: 4, cachedInputPerMillionUsd: 0.4, outputPerMillionUsd: 20 }
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
  const range = LOCAL_USAGE_RANGE_OPTIONS.includes(requestedRange) ? requestedRange : "24h";
  const now = effectiveUsageNow(usage);
  const bars =
    range === "24h"
      ? deriveShortBars(usage, now)
      : range === "3d"
        ? deriveHalfDayBars(usage, now)
        : range === "7d"
          ? deriveDailyBars(usage, now, 7)
          : range === "14d"
            ? deriveGroupedDailyBars(usage, now, 14, 2)
            : range === "7w"
              ? deriveWeeklyBars(usage, now)
              : deriveMonthlyBars(usage, now);
  return {
    range,
    eventCount: bars.reduce((count, bar) => count + bar.eventCount, 0),
    total: sumTotals(bars.map((bar) => bar.total)),
    bars,
    byModel: aggregateModelUsage(bars.flatMap((bar) => bar.byModel))
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

function deriveShortBars(usage: DashboardLocalUsageViewModel, now: number): LocalUsageRangeBar[] {
  const rows = new Map(usage.by3Hour.map((row) => [row.startAt, row]));
  const models = new Map<number, DashboardLocalUsageBucketModelViewModel[]>();
  for (const row of usage.by3HourAndModel) {
    const bucket = models.get(row.startAt) ?? [];
    bucket.push(row);
    models.set(row.startAt, bucket);
  }

  const currentStart = localBucketStartAt(now, usage.timeZone);
  return Array.from({ length: 8 }, (_, index) => {
    const startAt = shiftLocalHours(currentStart, -(7 - index) * 3, usage.timeZone);
    const row = rows.get(startAt) ?? emptyBucket(startAt, shiftLocalHours(startAt, 3, usage.timeZone));
    return createBar(
      `3h-${startAt}`,
      formatBucketLabel(startAt, row.endAt, usage.timeZone),
      row.startAt,
      row.endAt,
      row.eventCount,
      row,
      models.get(startAt) ?? []
    );
  });
}

function deriveHalfDayBars(usage: DashboardLocalUsageViewModel, now: number): LocalUsageRangeBar[] {
  const buckets = new Map(usage.by3Hour.map((row) => [row.startAt, row]));
  const models = new Map<number, DashboardLocalUsageBucketModelViewModel[]>();
  for (const row of usage.by3HourAndModel) {
    const bucket = models.get(row.startAt) ?? [];
    bucket.push(row);
    models.set(row.startAt, bucket);
  }

  const today = localDateKey(now, usage.timeZone);
  const bars: LocalUsageRangeBar[] = [];
  for (let dayOffset = -2; dayOffset <= 0; dayOffset += 1) {
    const date = shiftDateKey(today, dayOffset);
    const parts = dateParts(date);
    for (const hour of [0, 12]) {
      const startAt = localDateTimeToTimestamp({ ...parts, hour }, usage.timeZone);
      const endAt = localDateTimeToTimestamp({ ...parts, hour: hour + 12 }, usage.timeZone);
      const total = emptyTotals();
      let eventCount = 0;
      const byModel: DashboardLocalUsageModelViewModel[] = [];
      for (let bucketIndex = 0; bucketIndex < 4; bucketIndex += 1) {
        const bucketStartAt = localDateTimeToTimestamp({ ...parts, hour: hour + bucketIndex * 3 }, usage.timeZone);
        const bucket = buckets.get(bucketStartAt);
        if (bucket) {
          addTotals(total, bucket);
          eventCount += bucket.eventCount;
        }
        for (const model of models.get(bucketStartAt) ?? []) {
          byModel.push(model);
        }
      }
      bars.push(
        createBar(
          `12h-${startAt}`,
          formatHalfDayLabel(startAt, endAt, usage.timeZone),
          startAt,
          endAt,
          eventCount,
          total,
          byModel
        )
      );
    }
  }
  return bars;
}

function deriveDailyBars(usage: DashboardLocalUsageViewModel, now: number, days: number): LocalUsageRangeBar[] {
  const rows = new Map(usage.byDay.map((row) => [row.date, row]));
  const models = modelsByDate(usage.byDayAndModel);
  const today = localDateKey(now, usage.timeZone);
  return Array.from({ length: days }, (_, index) => {
    const date = shiftDateKey(today, index - days + 1);
    const row = rows.get(date) ?? emptyDay(date);
    const startAt = localDateTimeToTimestamp({ ...dateParts(date), hour: 0 }, usage.timeZone);
    const endAt = localDateTimeToTimestamp({ ...dateParts(date), hour: 24 }, usage.timeZone);
    return createBar(
      `day-${date}`,
      formatDateLabel(date, usage.timeZone),
      startAt,
      endAt,
      row.eventCount,
      row,
      models.get(date) ?? [],
      date
    );
  });
}

function deriveGroupedDailyBars(
  usage: DashboardLocalUsageViewModel,
  now: number,
  days: number,
  groupSize: number
): LocalUsageRangeBar[] {
  const daily = deriveDailyBars(usage, now, days);
  return Array.from({ length: Math.ceil(days / groupSize) }, (_, index) => {
    const group = daily.slice(index * groupSize, (index + 1) * groupSize);
    return createBar(
      `days-${index}-${group[0]?.startAt ?? 0}`,
      formatDateSpanLabel(group[0]?.startAt ?? 0, group.at(-1)?.endAt ?? 0, usage.timeZone),
      group[0]?.startAt ?? 0,
      group.at(-1)?.endAt ?? 0,
      group.reduce((count, row) => count + row.eventCount, 0),
      sumTotals(group.map((row) => row.total)),
      group.flatMap((row) => row.byModel)
    );
  });
}

function deriveWeeklyBars(usage: DashboardLocalUsageViewModel, now: number): LocalUsageRangeBar[] {
  const rows = new Map(usage.byDay.map((row) => [row.date, row]));
  const models = modelsByDate(usage.byDayAndModel);
  const currentWeek = startOfWeek(localDateKey(now, usage.timeZone));
  return Array.from({ length: 7 }, (_, index) => {
    const weekStart = shiftDateKey(currentWeek, (index - 6) * 7);
    const dates = Array.from({ length: 7 }, (_, dayIndex) => shiftDateKey(weekStart, dayIndex));
    const total = emptyTotals();
    const byModel: DashboardLocalUsageModelViewModel[] = [];
    let eventCount = 0;
    for (const date of dates) {
      const row = rows.get(date);
      if (row) {
        addTotals(total, row);
        eventCount += row.eventCount;
      }
      byModel.push(...(models.get(date) ?? []));
    }
    const startAt = localDateTimeToTimestamp({ ...dateParts(weekStart), hour: 0 }, usage.timeZone);
    const endAt = localDateTimeToTimestamp({ ...dateParts(shiftDateKey(weekStart, 7)), hour: 0 }, usage.timeZone);
    return createBar(
      `week-${weekStart}`,
      formatDateSpanLabel(startAt, endAt, usage.timeZone),
      startAt,
      endAt,
      eventCount,
      total,
      byModel
    );
  });
}

function deriveMonthlyBars(usage: DashboardLocalUsageViewModel, now: number): LocalUsageRangeBar[] {
  const rows = new Map(usage.byDay.map((row) => [row.date, row]));
  const models = modelsByDate(usage.byDayAndModel);
  const currentMonth = monthStart(localDateKey(now, usage.timeZone));
  return Array.from({ length: 7 }, (_, index) => {
    const month = shiftMonthKey(currentMonth, index - 6);
    const nextMonth = shiftMonthKey(month, 1);
    const lastDate = shiftDateKey(nextMonth, -1);
    const total = emptyTotals();
    const byModel: DashboardLocalUsageModelViewModel[] = [];
    let eventCount = 0;
    for (let date = month; date <= lastDate; date = shiftDateKey(date, 1)) {
      const row = rows.get(date);
      if (row) {
        addTotals(total, row);
        eventCount += row.eventCount;
      }
      byModel.push(...(models.get(date) ?? []));
    }
    const startAt = localDateTimeToTimestamp({ ...dateParts(month), hour: 0 }, usage.timeZone);
    const endAt = localDateTimeToTimestamp({ ...dateParts(nextMonth), hour: 0 }, usage.timeZone);
    return createBar(`month-${month}`, month.slice(0, 7), startAt, endAt, eventCount, total, byModel);
  });
}

function effectiveUsageNow(usage: DashboardLocalUsageViewModel): number {
  const calculatedAt = usage.calculatedAt ?? Date.now();
  const latestDate = usage.byDay.at(-1)?.date;
  if (!latestDate || latestDate <= localDateKey(calculatedAt, usage.timeZone)) {
    return calculatedAt;
  }
  return localDateTimeToTimestamp({ ...dateParts(latestDate), hour: 23 }, usage.timeZone);
}

function createBar(
  key: string,
  label: string,
  startAt: number,
  endAt: number,
  eventCount: number,
  total: DashboardLocalUsageTokenTotals,
  models: readonly (DashboardLocalUsageModelViewModel | DashboardLocalUsageBucketModelViewModel)[],
  date?: string
): LocalUsageRangeBar {
  const byModel = aggregateModelUsage(models);
  return {
    key,
    label,
    date,
    startAt,
    endAt,
    eventCount,
    total: copyTotals(total),
    byModel,
    price: estimateStandardApiCost(byModel)
  };
}

function modelsByDate(rows: readonly DashboardLocalUsageDayModelViewModel[]): Map<string, DashboardLocalUsageDayModelViewModel[]> {
  const result = new Map<string, DashboardLocalUsageDayModelViewModel[]>();
  for (const row of rows) {
    const bucket = result.get(row.date) ?? [];
    bucket.push(row);
    result.set(row.date, bucket);
  }
  return result;
}

function aggregateModelUsage(
  rows: readonly (DashboardLocalUsageModelViewModel | DashboardLocalUsageBucketModelViewModel)[]
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

function emptyBucket(startAt: number, endAt: number): DashboardLocalUsageBucketViewModel {
  return { startAt, endAt, eventCount: 0, ...emptyTotals() };
}

function emptyDay(date: string): DashboardLocalUsageDayViewModel {
  return { date, eventCount: 0, ...emptyTotals() };
}

function formatBucketLabel(startAt: number, endAt: number, timeZone: string): string {
  const start = zonedDateTimeParts(startAt, timeZone);
  const end = zonedDateTimeParts(endAt, timeZone);
  return `${formatDateLabel(start.date, timeZone)} ${padHour(start.hour)}–${padHour(end.hour)}`;
}

function formatHalfDayLabel(startAt: number, endAt: number, timeZone: string): string {
  const start = zonedDateTimeParts(startAt, timeZone);
  const end = zonedDateTimeParts(endAt, timeZone);
  return `${formatDateLabel(start.date, timeZone)} ${padHour(start.hour)}–${padHour(end.hour)}`;
}

function formatDateLabel(date: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone, month: "2-digit", day: "2-digit" }).format(
    new Date(localDateTimeToTimestamp({ ...dateParts(date), hour: 12 }, timeZone))
  );
}

function formatDateSpanLabel(startAt: number, endAt: number, timeZone: string): string {
  const start = zonedDateTimeParts(startAt, timeZone);
  const end = zonedDateTimeParts(endAt - 1, timeZone);
  return `${formatDateLabel(start.date, timeZone)}–${formatDateLabel(end.date, timeZone)}`;
}

function padHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function localBucketStartAt(timestamp: number, timeZone: string): number {
  const local = zonedDateTimeParts(timestamp, timeZone);
  return localDateTimeToTimestamp(
    { year: local.year, month: local.month, day: local.day, hour: Math.floor(local.hour / 3) * 3 },
    timeZone
  );
}

function shiftLocalHours(timestamp: number, deltaHours: number, timeZone: string): number {
  const local = zonedDateTimeParts(timestamp, timeZone);
  return localDateTimeToTimestamp(
    { year: local.year, month: local.month, day: local.day, hour: local.hour + deltaHours },
    timeZone
  );
}

function localDateKey(timestamp: number, timeZone: string): string {
  return zonedDateTimeParts(timestamp, timeZone).date;
}

function zonedDateTimeParts(timestamp: number, timeZone: string): ZonedDateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  const year = Number(parts["year"]);
  const month = Number(parts["month"]);
  const day = Number(parts["day"]);
  const hour = Number(parts["hour"]) % 24;
  return { date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`, year, month, day, hour };
}

function dateParts(date: string): Pick<ZonedDateTimeParts, "year" | "month" | "day"> {
  const [yearText, monthText, dayText] = date.split("-");
  return { year: Number(yearText), month: Number(monthText), day: Number(dayText) };
}

function localDateTimeToTimestamp(
  target: Pick<ZonedDateTimeParts, "year" | "month" | "day" | "hour">,
  timeZone: string
): number {
  let timestamp = Date.UTC(target.year, target.month - 1, target.day, target.hour);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedDateTimeParts(timestamp, timeZone);
    const adjustment =
      Date.UTC(target.year, target.month - 1, target.day, target.hour) -
      Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour);
    if (adjustment === 0) {
      return timestamp;
    }
    timestamp += adjustment;
  }
  return timestamp;
}

function shiftDateKey(date: string, deltaDays: number): string {
  const parts = dateParts(date);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays)).toISOString().slice(0, 10);
}

function startOfWeek(date: string): string {
  const parts = dateParts(date);
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return shiftDateKey(date, -(weekday === 0 ? 6 : weekday - 1));
}

function monthStart(date: string): string {
  const parts = dateParts(date);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-01`;
}

function shiftMonthKey(date: string, deltaMonths: number): string {
  const parts = dateParts(date);
  return new Date(Date.UTC(parts.year, parts.month - 1 + deltaMonths, 1)).toISOString().slice(0, 10);
}

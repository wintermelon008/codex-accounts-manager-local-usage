import { createReadStream, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type {
  DashboardLocalUsageDayModelViewModel,
  DashboardLocalUsageDayViewModel,
  DashboardLocalUsageModelViewModel,
  DashboardLocalUsageThreeHourModelViewModel,
  DashboardLocalUsageThreeHourViewModel,
  DashboardLocalUsageTokenTotals,
  DashboardLocalUsageViewModel
} from "../domain/dashboard/types";

export const LOCAL_USAGE_CACHE_TTL_MS = 15 * 60 * 1000;
export const LOCAL_USAGE_PERIOD_DAYS = 14;
export const LOCAL_USAGE_THREE_HOUR_BUCKET_COUNT = 8;

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const CACHE_FILE_NAME = "local-usage-analytics-v3.json";
const CACHE_SCHEMA_VERSION = 3;
const UNKNOWN_MODEL = "unknown";

type LocalUsageScanInput = {
  sessionsPath: string;
  periodDays: number;
  timeZone: string;
  now: number;
};

export type LocalUsageScanner = (input: LocalUsageScanInput) => Promise<DashboardLocalUsageViewModel>;

export type LocalUsageAnalyticsOptions = {
  globalStoragePath: string;
  sessionsPath?: string;
  periodDays?: number;
  timeZone?: string;
  now?: () => number;
  scanner?: LocalUsageScanner;
};

type LocalUsageCache = {
  schemaVersion: number;
  snapshot: DashboardLocalUsageViewModel;
};

type MutableTotals = DashboardLocalUsageTokenTotals;

/**
 * Reads only token-count metadata from local Codex session JSONL files. Raw
 * conversation text, credentials, account identifiers, and session paths are
 * deliberately excluded from the returned view model and persisted cache.
 */
export class LocalUsageAnalyticsService {
  private cacheLoaded = false;
  private cacheLoadPromise: Promise<void> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private snapshot: DashboardLocalUsageViewModel | undefined;
  private readonly sessionsPath: string;
  private readonly periodDays: number;
  private readonly timeZone: string;
  private readonly now: () => number;
  private readonly scanner: LocalUsageScanner;

  constructor(private readonly options: LocalUsageAnalyticsOptions) {
    this.sessionsPath = options.sessionsPath ?? defaultSessionsPath();
    this.periodDays = options.periodDays ?? LOCAL_USAGE_PERIOD_DAYS;
    this.timeZone = options.timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    this.now = options.now ?? Date.now;
    this.scanner = options.scanner ?? scanLocalUsageSessions;
  }

  async getSnapshot(onRefreshed?: () => void): Promise<DashboardLocalUsageViewModel> {
    await this.loadCache();

    if (!this.snapshot) {
      this.startRefresh(onRefreshed);
      return createEmptySnapshot("loading", this.periodDays, this.timeZone, this.now());
    }

    if (isSnapshotFresh(this.snapshot, this.now())) {
      return this.snapshot;
    }

    this.startRefresh(onRefreshed);
    return {
      ...this.snapshot,
      isRefreshing: true
    };
  }

  private async loadCache(): Promise<void> {
    if (this.cacheLoaded) {
      return;
    }

    this.cacheLoadPromise ??= this.readCache().finally(() => {
      this.cacheLoaded = true;
    });
    await this.cacheLoadPromise;
  }

  private async readCache(): Promise<void> {
    try {
      const raw = await fs.readFile(this.cachePath(), "utf8");
      const cache = parseCache(raw);
      if (cache?.snapshot.periodDays === this.periodDays) {
        this.snapshot = cache.snapshot;
      }
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        console.warn("[codexAccounts] local usage cache ignored", error);
      }
    }
  }

  private startRefresh(onRefreshed?: () => void): void {
    if (this.refreshPromise) {
      return;
    }

    this.refreshPromise = this.refresh()
      .catch(async (error: unknown) => {
        console.warn("[codexAccounts] local usage scan failed", error);
        if (!this.snapshot) {
          this.snapshot = {
            ...createEmptySnapshot("unavailable", this.periodDays, this.timeZone, this.now()),
            calculatedAt: this.now(),
            nextRefreshAt: this.now() + LOCAL_USAGE_CACHE_TTL_MS
          };
          await this.writeCache(this.snapshot).catch(() => undefined);
        }
      })
      .finally(() => {
        this.refreshPromise = undefined;
        onRefreshed?.();
      });
  }

  private async refresh(): Promise<void> {
    const snapshot = await this.scanner({
      sessionsPath: this.sessionsPath,
      periodDays: this.periodDays,
      timeZone: this.timeZone,
      now: this.now()
    });
    this.snapshot = {
      ...snapshot,
      isRefreshing: false
    };
    await this.writeCache(this.snapshot);
  }

  private async writeCache(snapshot: DashboardLocalUsageViewModel): Promise<void> {
    const cachePath = this.cachePath();
    const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    const value: LocalUsageCache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      snapshot
    };

    await fs.mkdir(this.options.globalStoragePath, { recursive: true });
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(value)}\n`, "utf8");
      await fs.rename(tempPath, cachePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private cachePath(): string {
    return path.join(this.options.globalStoragePath, CACHE_FILE_NAME);
  }
}

export async function scanLocalUsageSessions(input: LocalUsageScanInput): Promise<DashboardLocalUsageViewModel> {
  const empty = createEmptySnapshot("unavailable", input.periodDays, input.timeZone, input.now);
  if (!(await isDirectory(input.sessionsPath))) {
    return withRefreshWindow(empty, input.now);
  }

  const allowedDates = new Set(recentDateKeys(input.now, input.periodDays, input.timeZone));
  const byDate = new Map(empty.byDay.map((row) => [row.date, row]));
  const byModel = new Map<string, DashboardLocalUsageModelViewModel>();
  const byDayAndModel = new Map<string, DashboardLocalUsageDayModelViewModel>();
  const byThreeHour = new Map(empty.byThreeHour.map((row) => [row.startAt, row]));
  const byThreeHourAndModel = new Map<string, DashboardLocalUsageThreeHourModelViewModel>();
  const sourceFiles = new Set<string>();
  const total = empty.total;
  let eventCount = 0;

  const files = await findJsonlFiles(input.sessionsPath);
  for (const file of files) {
    let currentModel = UNKNOWN_MODEL;
    let fileHasUsage = false;

    try {
      const lines = readline.createInterface({
        input: createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity
      });

      for await (const line of lines) {
        const event = parseRecord(line);
        if (!event) {
          continue;
        }

        const payload = asRecord(event["payload"]);
        if (!payload) {
          continue;
        }

        if (event["type"] === "turn_context") {
          const model = payload["model"];
          if (typeof model === "string" && model.trim()) {
            currentModel = model.trim();
          }
          continue;
        }

        if (event["type"] !== "event_msg" || payload["type"] !== "token_count") {
          continue;
        }

        const timestamp = timestampFromEvent(event["timestamp"]);
        if (timestamp == null) {
          continue;
        }

        const date = dateKey(timestamp, input.timeZone);
        if (!allowedDates.has(date)) {
          continue;
        }

        const usage = readLastTokenUsage(payload);
        if (!usage) {
          continue;
        }

        const day = byDate.get(date);
        if (!day) {
          continue;
        }

        const model = currentModel || UNKNOWN_MODEL;
        const modelBucket = getOrCreateModelBucket(byModel, model);
        const dayModelBucket = getOrCreateDayModelBucket(byDayAndModel, date, model);
        addTotals(total, usage);
        addTotals(day, usage);
        addTotals(modelBucket, usage);
        addTotals(dayModelBucket, usage);
        day.eventCount += 1;

        const threeHourBucketStartAt = threeHourBucketStart(timestamp, input.now);
        const threeHourBucket =
          threeHourBucketStartAt == null ? undefined : byThreeHour.get(threeHourBucketStartAt);
        if (threeHourBucket) {
          const threeHourModelBucket = getOrCreateThreeHourModelBucket(byThreeHourAndModel, threeHourBucket.startAt, model);
          addTotals(threeHourBucket, usage);
          addTotals(threeHourModelBucket, usage);
          threeHourBucket.eventCount += 1;
        }

        eventCount += 1;
        fileHasUsage = true;
      }
    } catch (error) {
      // Session files can rotate while Codex is running. Ignore only this file
      // and retain the rest of the aggregate rather than affecting the host UI.
      console.warn("[codexAccounts] local usage session file skipped", error);
      continue;
    }

    if (fileHasUsage) {
      sourceFiles.add(file);
    }
  }

  const status = eventCount > 0 ? "ready" : "unavailable";
  return withRefreshWindow(
    {
      status,
      isRefreshing: false,
      periodDays: input.periodDays,
      calculatedAt: input.now,
      sourceFileCount: sourceFiles.size,
      eventCount,
      total,
      byDay: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
      byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)),
      byDayAndModel: [...byDayAndModel.values()].sort(
        (a, b) => a.date.localeCompare(b.date) || b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)
      ),
      byThreeHour: [...byThreeHour.values()].sort((a, b) => a.startAt - b.startAt),
      byThreeHourAndModel: [...byThreeHourAndModel.values()].sort(
        (a, b) => a.startAt - b.startAt || b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)
      )
    },
    input.now
  );
}

export function isSnapshotFresh(snapshot: DashboardLocalUsageViewModel, now: number): boolean {
  return snapshot.calculatedAt != null && now - snapshot.calculatedAt < LOCAL_USAGE_CACHE_TTL_MS;
}

function defaultSessionsPath(): string {
  const codexHome = process.env["CODEX_HOME"]?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}

function createEmptySnapshot(
  status: DashboardLocalUsageViewModel["status"],
  periodDays: number,
  timeZone: string,
  now: number
): DashboardLocalUsageViewModel {
  return {
    status,
    isRefreshing: false,
    periodDays,
    sourceFileCount: 0,
    eventCount: 0,
    total: emptyTotals(),
    byDay: recentDateKeys(now, periodDays, timeZone).map((date) => ({
      date,
      eventCount: 0,
      ...emptyTotals()
    })),
    byModel: [],
    byDayAndModel: [],
    byThreeHour: recentThreeHourBuckets(now),
    byThreeHourAndModel: []
  };
}

function withRefreshWindow(snapshot: DashboardLocalUsageViewModel, calculatedAt: number): DashboardLocalUsageViewModel {
  return {
    ...snapshot,
    calculatedAt,
    nextRefreshAt: calculatedAt + LOCAL_USAGE_CACHE_TTL_MS
  };
}

function emptyTotals(): MutableTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function addTotals(target: MutableTotals, usage: DashboardLocalUsageTokenTotals): void {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningOutputTokens += usage.reasoningOutputTokens;
  target.totalTokens += usage.totalTokens;
}

function getOrCreateModelBucket(
  buckets: Map<string, DashboardLocalUsageModelViewModel>,
  model: string
): DashboardLocalUsageModelViewModel {
  const existing = buckets.get(model);
  if (existing) {
    return existing;
  }

  const created: DashboardLocalUsageModelViewModel = {
    model,
    ...emptyTotals()
  };
  buckets.set(model, created);
  return created;
}

function getOrCreateDayModelBucket(
  buckets: Map<string, DashboardLocalUsageDayModelViewModel>,
  date: string,
  model: string
): DashboardLocalUsageDayModelViewModel {
  const key = `${date}\u0000${model}`;
  const existing = buckets.get(key);
  if (existing) {
    return existing;
  }

  const created: DashboardLocalUsageDayModelViewModel = {
    date,
    model,
    ...emptyTotals()
  };
  buckets.set(key, created);
  return created;
}

function getOrCreateThreeHourModelBucket(
  buckets: Map<string, DashboardLocalUsageThreeHourModelViewModel>,
  startAt: number,
  model: string
): DashboardLocalUsageThreeHourModelViewModel {
  const key = `${startAt}\u0000${model}`;
  const existing = buckets.get(key);
  if (existing) {
    return existing;
  }

  const created: DashboardLocalUsageThreeHourModelViewModel = {
    startAt,
    model,
    ...emptyTotals()
  };
  buckets.set(key, created);
  return created;
}

function readLastTokenUsage(payload: Record<string, unknown>): DashboardLocalUsageTokenTotals | undefined {
  const info = asRecord(payload["info"]);
  const usage = asRecord(info?.["last_token_usage"]);
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: readNonNegativeInteger(usage["input_tokens"]),
    cachedInputTokens: readNonNegativeInteger(usage["cached_input_tokens"]),
    outputTokens: readNonNegativeInteger(usage["output_tokens"]),
    reasoningOutputTokens: readNonNegativeInteger(usage["reasoning_output_tokens"]),
    totalTokens: readNonNegativeInteger(usage["total_tokens"])
  };
}

function readNonNegativeInteger(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function timestampFromEvent(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function recentThreeHourBuckets(now: number): DashboardLocalUsageThreeHourViewModel[] {
  const earliestStartAt = now - LOCAL_USAGE_THREE_HOUR_BUCKET_COUNT * THREE_HOURS_MS;
  return Array.from({ length: LOCAL_USAGE_THREE_HOUR_BUCKET_COUNT }, (_, index) => {
    const startAt = earliestStartAt + index * THREE_HOURS_MS;
    return {
      startAt,
      endAt: startAt + THREE_HOURS_MS,
      eventCount: 0,
      ...emptyTotals()
    };
  });
}

function threeHourBucketStart(timestamp: number, now: number): number | undefined {
  const earliestStartAt = now - LOCAL_USAGE_THREE_HOUR_BUCKET_COUNT * THREE_HOURS_MS;
  if (timestamp < earliestStartAt || timestamp > now) {
    return undefined;
  }

  const index = Math.min(
    LOCAL_USAGE_THREE_HOUR_BUCKET_COUNT - 1,
    Math.floor((timestamp - earliestStartAt) / THREE_HOURS_MS)
  );
  return earliestStartAt + index * THREE_HOURS_MS;
}

function recentDateKeys(now: number, periodDays: number, timeZone: string): string[] {
  const today = dateKey(now, timeZone);
  const days = Math.max(1, Math.floor(periodDays));
  return Array.from({ length: days }, (_, index) => shiftDateKey(today, index - days + 1));
}

function dateKey(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (!year || !month || !day) {
    throw new Error("Unable to resolve local usage date");
  }
  return `${year}-${month}-${day}`;
}

function shiftDateKey(date: string, deltaDays: number): string {
  const [yearText, monthText, dayText] = date.split("-");
  if (!yearText || !monthText || !dayText) {
    throw new Error("Invalid local usage date");
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return shifted.toISOString().slice(0, 10);
}

async function findJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await visit(root, files);
  return files;
}

async function visit(directory: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      throw error;
    }
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function parseCache(raw: string): LocalUsageCache | undefined {
  try {
    const candidate = asRecord(JSON.parse(raw));
    if (!candidate || candidate["schemaVersion"] !== CACHE_SCHEMA_VERSION) {
      return undefined;
    }

    const snapshot = candidate["snapshot"];
    return isUsageSnapshot(snapshot)
      ? {
          schemaVersion: CACHE_SCHEMA_VERSION,
          snapshot
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function isUsageSnapshot(value: unknown): value is DashboardLocalUsageViewModel {
  const candidate = asRecord(value);
  if (!candidate || !isUsageStatus(candidate["status"]) || typeof candidate["isRefreshing"] !== "boolean") {
    return false;
  }

  return (
    isFiniteNumber(candidate["periodDays"]) &&
    (candidate["calculatedAt"] == null || isFiniteNumber(candidate["calculatedAt"])) &&
    (candidate["nextRefreshAt"] == null || isFiniteNumber(candidate["nextRefreshAt"])) &&
    isFiniteNumber(candidate["sourceFileCount"]) &&
    isFiniteNumber(candidate["eventCount"]) &&
    isTokenTotals(candidate["total"]) &&
    Array.isArray(candidate["byDay"]) &&
    candidate["byDay"].every(isUsageDay) &&
    Array.isArray(candidate["byModel"]) &&
    candidate["byModel"].every(isUsageModel) &&
    Array.isArray(candidate["byDayAndModel"]) &&
    candidate["byDayAndModel"].every(isUsageDayModel) &&
    Array.isArray(candidate["byThreeHour"]) &&
    candidate["byThreeHour"].every(isUsageThreeHour) &&
    Array.isArray(candidate["byThreeHourAndModel"]) &&
    candidate["byThreeHourAndModel"].every(isUsageThreeHourModel)
  );
}

function isUsageStatus(value: unknown): value is DashboardLocalUsageViewModel["status"] {
  return value === "loading" || value === "ready" || value === "unavailable";
}

function isUsageDay(value: unknown): value is DashboardLocalUsageDayViewModel {
  const candidate = asRecord(value);
  return Boolean(
    candidate &&
    typeof candidate["date"] === "string" &&
    isFiniteNumber(candidate["eventCount"]) &&
    isTokenTotals(candidate)
  );
}

function isUsageModel(value: unknown): value is DashboardLocalUsageModelViewModel {
  const candidate = asRecord(value);
  return Boolean(candidate && typeof candidate["model"] === "string" && isTokenTotals(candidate));
}

function isUsageDayModel(value: unknown): value is DashboardLocalUsageDayModelViewModel {
  const candidate = asRecord(value);
  return Boolean(
    candidate &&
    typeof candidate["date"] === "string" &&
    typeof candidate["model"] === "string" &&
    isTokenTotals(candidate)
  );
}

function isUsageThreeHour(value: unknown): value is DashboardLocalUsageThreeHourViewModel {
  const candidate = asRecord(value);
  return Boolean(
    candidate &&
      isFiniteNumber(candidate["startAt"]) &&
      isFiniteNumber(candidate["endAt"]) &&
      candidate["endAt"] > candidate["startAt"] &&
      isFiniteNumber(candidate["eventCount"]) &&
      isTokenTotals(candidate)
  );
}

function isUsageThreeHourModel(value: unknown): value is DashboardLocalUsageThreeHourModelViewModel {
  const candidate = asRecord(value);
  return Boolean(candidate && isFiniteNumber(candidate["startAt"]) && typeof candidate["model"] === "string" && isTokenTotals(candidate));
}

function isTokenTotals(value: unknown): value is DashboardLocalUsageTokenTotals {
  const candidate = asRecord(value);
  return Boolean(
    candidate &&
    isFiniteNumber(candidate["inputTokens"]) &&
    isFiniteNumber(candidate["cachedInputTokens"]) &&
    isFiniteNumber(candidate["outputTokens"]) &&
    isFiniteNumber(candidate["reasoningOutputTokens"]) &&
    isFiniteNumber(candidate["totalTokens"])
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

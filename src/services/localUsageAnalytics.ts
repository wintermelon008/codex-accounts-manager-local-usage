import { randomUUID } from "node:crypto";
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
import { tryAcquireSharedFileLease } from "../storage/accountsWriteCoordinator";

export const LOCAL_USAGE_CACHE_TTL_MS = 15 * 60 * 1000;
export const LOCAL_USAGE_PERIOD_DAYS = 14;
export const LOCAL_USAGE_THREE_HOUR_BUCKET_COUNT = 8;
export const LOCAL_USAGE_SCAN_LEASE_MS = 60 * 1000;

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE_NAME = "local-usage-analytics-v4.json";
export const LOCAL_USAGE_SCAN_LEASE_FILE_NAME = `${CACHE_FILE_NAME}.scan-lease`;
const CACHE_SCHEMA_VERSION = 4;
const UNKNOWN_MODEL = "unknown";
const PEER_REFRESH_WAIT_MS = 2_000;
const PEER_REFRESH_POLL_MS = 50;
const LOCAL_USAGE_EVENT_MARKER =
  /"type"\s*:\s*"(?:session_meta|turn_context|token_count|inter_agent_communication_metadata)"/;
const DATE_KEY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

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

type CumulativeTokenUsage = {
  totals: MutableTotals;
  hasCompleteComponents: boolean;
};

type TokenUsageHighWater = {
  totals: MutableTotals;
  hasCompleteComponents: boolean;
};

type TokenUsageAdvance = {
  highWater: TokenUsageHighWater;
  delta?: MutableTotals;
};

/**
 * Reads only token-count metadata from local Codex session JSONL files. Raw
 * conversation text, credentials, account identifiers, and session paths are
 * deliberately excluded from the returned view model and persisted cache.
 */
export class LocalUsageAnalyticsService {
  private refreshPromise: Promise<void> | undefined;
  private readonly refreshCallbacks = new Set<() => void>();
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
    await this.syncSnapshotFromCache();

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

  private async syncSnapshotFromCache(): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.cachePath(), "utf8");
      const cache = parseCache(raw);
      if (cache?.snapshot.periodDays !== this.periodDays) {
        return false;
      }

      const cachedCalculatedAt = cache.snapshot.calculatedAt ?? Number.NEGATIVE_INFINITY;
      const currentCalculatedAt = this.snapshot?.calculatedAt ?? Number.NEGATIVE_INFINITY;
      if (this.snapshot && cachedCalculatedAt <= currentCalculatedAt) {
        return false;
      }

      this.snapshot = {
        ...cache.snapshot,
        isRefreshing: false
      };
      return true;
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        console.warn("[codexAccounts] local usage cache ignored", error);
      }
      return false;
    }
  }

  private startRefresh(onRefreshed?: () => void): void {
    if (onRefreshed) {
      this.refreshCallbacks.add(onRefreshed);
    }
    if (this.refreshPromise) {
      return;
    }

    this.refreshPromise = this.refreshWithLease()
      .catch((error: unknown) => {
        console.warn("[codexAccounts] local usage scan failed", error);
      })
      .finally(() => {
        this.refreshPromise = undefined;
        const callbacks = [...this.refreshCallbacks];
        this.refreshCallbacks.clear();
        for (const callback of callbacks) {
          callback();
        }
      });
  }

  private async refreshWithLease(): Promise<void> {
    const previousCalculatedAt = this.snapshot?.calculatedAt;
    const lease = await tryAcquireSharedFileLease(this.scanLeasePath(), LOCAL_USAGE_SCAN_LEASE_MS);
    if (!lease) {
      await this.waitForPeerRefresh(previousCalculatedAt);
      return;
    }

    try {
      await this.syncSnapshotFromCache();
      if (this.snapshot && isSnapshotFresh(this.snapshot, this.now())) {
        return;
      }

      await this.scanAndPersist();
    } catch (error) {
      await this.persistUnavailableSnapshotIfEmpty();
      throw error;
    } finally {
      await lease.release();
    }
  }

  private async scanAndPersist(): Promise<void> {
    const scanned = await this.scanner({
      sessionsPath: this.sessionsPath,
      periodDays: this.periodDays,
      timeZone: this.timeZone,
      now: this.now()
    });
    const snapshot: DashboardLocalUsageViewModel = {
      ...scanned,
      isRefreshing: false
    };

    await this.syncSnapshotFromCache();
    if (
      (this.snapshot?.calculatedAt ?? Number.NEGATIVE_INFINITY) > (snapshot.calculatedAt ?? Number.NEGATIVE_INFINITY)
    ) {
      return;
    }

    await this.writeCache(snapshot);
    this.snapshot = snapshot;
  }

  private async persistUnavailableSnapshotIfEmpty(): Promise<void> {
    if (this.snapshot) {
      return;
    }

    const calculatedAt = this.now();
    this.snapshot = {
      ...createEmptySnapshot("unavailable", this.periodDays, this.timeZone, calculatedAt),
      calculatedAt,
      nextRefreshAt: calculatedAt + LOCAL_USAGE_CACHE_TTL_MS
    };
    await this.writeCache(this.snapshot).catch(() => undefined);
  }

  private async waitForPeerRefresh(previousCalculatedAt: number | undefined): Promise<void> {
    const deadline = Date.now() + PEER_REFRESH_WAIT_MS;
    do {
      await delay(PEER_REFRESH_POLL_MS);
      const adopted = await this.syncSnapshotFromCache();
      if (
        adopted &&
        (this.snapshot?.calculatedAt ?? Number.NEGATIVE_INFINITY) > (previousCalculatedAt ?? Number.NEGATIVE_INFINITY)
      ) {
        return;
      }
    } while (Date.now() < deadline);
  }

  private async writeCache(snapshot: DashboardLocalUsageViewModel): Promise<void> {
    const cachePath = this.cachePath();
    const tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
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

  private scanLeasePath(): string {
    return path.join(this.options.globalStoragePath, LOCAL_USAGE_SCAN_LEASE_FILE_NAME);
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

  // mtime must be at least as recent as the newest record in a session file.
  // Keep one extra day for timezone and daylight-saving boundaries.
  const oldestRelevantMtime = input.now - (Math.max(1, Math.floor(input.periodDays)) + 1) * DAY_MS;
  const files = await findJsonlFiles(input.sessionsPath, oldestRelevantMtime);
  for (const file of files) {
    let currentModel = UNKNOWN_MODEL;
    let fileHasUsage = false;
    let firstSessionMetaSeen = false;
    let shouldCountUsage = true;
    let usageHighWater: TokenUsageHighWater | undefined;

    try {
      const lines = readline.createInterface({
        input: createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity
      });

      for await (const line of lines) {
        // Conversation and tool-output records dominate session bytes. Avoid
        // allocating parsed object graphs unless the line can affect usage.
        if (!LOCAL_USAGE_EVENT_MARKER.test(line)) {
          continue;
        }

        const event = parseRecord(line);
        if (!event) {
          continue;
        }

        const payload = asRecord(event["payload"]);
        if (!payload) {
          continue;
        }

        if (event["type"] === "session_meta") {
          if (!firstSessionMetaSeen) {
            firstSessionMetaSeen = true;
            shouldCountUsage = !isSpawnedSubagentSession(payload);
          }
          continue;
        }

        if (event["type"] === "inter_agent_communication_metadata") {
          if (payload["trigger_turn"] === true) {
            shouldCountUsage = true;
          }
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

        const advanced = advanceTokenUsageHighWater(payload, usageHighWater);
        usageHighWater = advanced?.highWater ?? usageHighWater;
        const usage = advanced?.delta;
        if (!usage || !shouldCountUsage) {
          continue;
        }

        const timestamp = timestampFromEvent(event["timestamp"]);
        if (timestamp == null || timestamp > input.now) {
          continue;
        }

        const date = dateKey(timestamp, input.timeZone);
        if (!allowedDates.has(date)) {
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
        const threeHourBucket = threeHourBucketStartAt == null ? undefined : byThreeHour.get(threeHourBucketStartAt);
        if (threeHourBucket) {
          const threeHourModelBucket = getOrCreateThreeHourModelBucket(
            byThreeHourAndModel,
            threeHourBucket.startAt,
            model
          );
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
  if (snapshot.nextRefreshAt != null) {
    return now < snapshot.nextRefreshAt;
  }
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

function isSpawnedSubagentSession(payload: Record<string, unknown>): boolean {
  const source = asRecord(payload["source"]);
  const subagent = asRecord(source?.["subagent"]);
  return Boolean(asRecord(subagent?.["thread_spawn"]));
}

function advanceTokenUsageHighWater(
  payload: Record<string, unknown>,
  previous: TokenUsageHighWater | undefined
): TokenUsageAdvance | undefined {
  const cumulative = readCumulativeTokenUsage(payload);
  const last = readLastTokenUsage(payload);

  if (!cumulative) {
    if (!last) {
      return undefined;
    }
    return {
      highWater: {
        totals: addTokenTotals(previous?.totals ?? emptyTotals(), last),
        hasCompleteComponents: previous?.hasCompleteComponents ?? true
      },
      delta: last
    };
  }

  const previousTotalTokens = previous?.totals.totalTokens ?? 0;
  if (cumulative.totals.totalTokens <= previousTotalTokens) {
    return previous ? { highWater: previous } : undefined;
  }

  const totalTokensDelta = cumulative.totals.totalTokens - previousTotalTokens;
  let delta: MutableTotals | undefined;
  if (cumulative.hasCompleteComponents && (!previous || previous.hasCompleteComponents)) {
    delta = subtractTokenTotals(cumulative.totals, previous?.totals ?? emptyTotals());
  }
  if (!delta && last?.totalTokens === totalTokensDelta) {
    delta = last;
  }

  let highWater: TokenUsageHighWater;
  if (cumulative.hasCompleteComponents) {
    highWater = {
      totals: cumulative.totals,
      hasCompleteComponents: true
    };
  } else if (last?.totalTokens === totalTokensDelta && (!previous || previous.hasCompleteComponents)) {
    highWater = {
      totals: addTokenTotals(previous?.totals ?? emptyTotals(), last),
      hasCompleteComponents: true
    };
  } else {
    highWater = {
      totals: {
        ...emptyTotals(),
        totalTokens: cumulative.totals.totalTokens
      },
      hasCompleteComponents: false
    };
  }

  return { highWater, delta };
}

function readCumulativeTokenUsage(payload: Record<string, unknown>): CumulativeTokenUsage | undefined {
  const info = asRecord(payload["info"]);
  const usage = asRecord(info?.["total_token_usage"]);
  if (!usage) {
    return undefined;
  }

  const totalTokens = readOptionalNonNegativeInteger(usage["total_tokens"]);
  if (totalTokens == null) {
    return undefined;
  }

  const inputTokens = readOptionalNonNegativeInteger(usage["input_tokens"]);
  const cachedInputTokens = readOptionalNonNegativeInteger(usage["cached_input_tokens"]);
  const outputTokens = readOptionalNonNegativeInteger(usage["output_tokens"]);
  const reasoningOutputTokens = readOptionalNonNegativeInteger(usage["reasoning_output_tokens"]);
  return {
    totals: {
      inputTokens: inputTokens ?? 0,
      cachedInputTokens: cachedInputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      reasoningOutputTokens: reasoningOutputTokens ?? 0,
      totalTokens
    },
    hasCompleteComponents:
      inputTokens != null && cachedInputTokens != null && outputTokens != null && reasoningOutputTokens != null
  };
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

function addTokenTotals(left: MutableTotals, right: MutableTotals): MutableTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens
  };
}

function subtractTokenTotals(current: MutableTotals, previous: MutableTotals): MutableTotals | undefined {
  const delta: MutableTotals = {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningOutputTokens: current.reasoningOutputTokens - previous.reasoningOutputTokens,
    totalTokens: current.totalTokens - previous.totalTokens
  };
  if (
    delta.inputTokens < 0 ||
    delta.cachedInputTokens < 0 ||
    delta.outputTokens < 0 ||
    delta.reasoningOutputTokens < 0 ||
    delta.totalTokens <= 0 ||
    delta.cachedInputTokens > delta.inputTokens ||
    delta.reasoningOutputTokens > delta.outputTokens ||
    delta.inputTokens + delta.outputTokens !== delta.totalTokens
  ) {
    return undefined;
  }
  return delta;
}

function readOptionalNonNegativeInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : undefined;
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
  let formatter = DATE_KEY_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    DATE_KEY_FORMATTERS.set(timeZone, formatter);
  }

  let year: string | undefined;
  let month: string | undefined;
  let day: string | undefined;
  for (const part of formatter.formatToParts(new Date(timestamp))) {
    if (part.type === "year") {
      year = part.value;
    } else if (part.type === "month") {
      month = part.value;
    } else if (part.type === "day") {
      day = part.value;
    }
  }
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

async function findJsonlFiles(root: string, oldestRelevantMtime: number): Promise<string[]> {
  const files: string[] = [];
  await visit(root, files, oldestRelevantMtime);
  return files;
}

async function visit(directory: string, files: string[], oldestRelevantMtime: number): Promise<void> {
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
      await visit(fullPath, files, oldestRelevantMtime);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        if ((await fs.stat(fullPath)).mtimeMs >= oldestRelevantMtime) {
          files.push(fullPath);
        }
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
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
  return Boolean(
    candidate &&
    isFiniteNumber(candidate["startAt"]) &&
    typeof candidate["model"] === "string" &&
    isTokenTotals(candidate)
  );
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

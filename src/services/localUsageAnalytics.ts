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
export const ACCOUNT_TOKEN_USAGE_CACHE_FILE_NAME = "account-token-usage-v1.json";
export const ACCOUNT_USAGE_ATTRIBUTION_DIRECTORY_NAME = "account-usage-attribution";
export const LOCAL_USAGE_SCAN_LEASE_FILE_NAME = `${CACHE_FILE_NAME}.scan-lease`;
const CACHE_SCHEMA_VERSION = 4;
const ACCOUNT_TOKEN_USAGE_CACHE_SCHEMA_VERSION = 1;
const UNKNOWN_MODEL = "unknown";
const PEER_REFRESH_WAIT_MS = 2_000;
const PEER_REFRESH_POLL_MS = 50;
const MAX_USAGE_ATTRIBUTION_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_USAGE_ATTRIBUTION_LINE_BYTES = 1_024;
const MAX_USAGE_ATTRIBUTION_THREAD_ID_LENGTH = 256;
const RESET_TIME_MATCH_TOLERANCE_SECONDS = 5;
const LOCAL_USAGE_EVENT_MARKER =
  /"type"\s*:\s*"(?:session_meta|turn_context|token_count|inter_agent_communication_metadata)"/;
const DATE_KEY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

export type LocalUsageScanInput = {
  sessionsPath: string;
  periodDays: number;
  timeZone: string;
  now: number;
};

export type LocalUsageScanner = (input: LocalUsageScanInput) => Promise<DashboardLocalUsageViewModel>;

export type AccountTokenUsageWindow = DashboardLocalUsageTokenTotals & {
  window: "hourly" | "weekly";
  resetAt: number;
  eventCount: number;
  lastObservedAt: number;
};

export type AccountTokenUsageSnapshot = {
  status: "loading" | "ready" | "unavailable";
  isRefreshing: boolean;
  calculatedAt?: number;
  nextRefreshAt?: number;
  windowsByAccount: Record<string, AccountTokenUsageWindow[]>;
};

export type LocalUsageSnapshots = {
  localUsage: DashboardLocalUsageViewModel;
  accountTokenUsage: AccountTokenUsageSnapshot;
};

export type LocalUsageCombinedScanInput = LocalUsageScanInput & {
  usageAttributionDirectory: string;
};

export type LocalUsageCombinedScanner = (input: LocalUsageCombinedScanInput) => Promise<LocalUsageSnapshots>;

export type LocalUsageAnalyticsOptions = {
  globalStoragePath: string;
  sessionsPath?: string;
  periodDays?: number;
  timeZone?: string;
  now?: () => number;
  scanner?: LocalUsageScanner;
  combinedScanner?: LocalUsageCombinedScanner;
  usageAttributionDirectory?: string;
};

type LocalUsageCache = {
  schemaVersion: number;
  snapshot: DashboardLocalUsageViewModel;
};

type AccountTokenUsageCache = {
  schemaVersion: number;
  snapshot: AccountTokenUsageSnapshot;
};

type UsageAttributionRecord = {
  t: number;
  th: string;
  a: string;
};

type UsageAttributionIndex = {
  byThread: Map<string, UsageAttributionRecord[]>;
  recordCount: number;
};

type TokenUsageQuotaWindowCandidate = {
  fallbackWindow: AccountTokenUsageWindow["window"];
  resetAt: number;
  windowMinutes?: number;
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
  private accountTokenUsage: AccountTokenUsageSnapshot | undefined;
  private readonly sessionsPath: string;
  private readonly periodDays: number;
  private readonly timeZone: string;
  private readonly now: () => number;
  private readonly combinedScanner: LocalUsageCombinedScanner;
  private readonly usageAttributionDirectory: string;

  constructor(private readonly options: LocalUsageAnalyticsOptions) {
    this.sessionsPath = options.sessionsPath ?? defaultSessionsPath();
    this.periodDays = options.periodDays ?? LOCAL_USAGE_PERIOD_DAYS;
    this.timeZone = options.timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    this.now = options.now ?? Date.now;
    this.usageAttributionDirectory =
      options.usageAttributionDirectory ??
      path.join(options.globalStoragePath, "hot-switch-runtime", ACCOUNT_USAGE_ATTRIBUTION_DIRECTORY_NAME);
    this.combinedScanner =
      options.combinedScanner ??
      (options.scanner
        ? async (input) => ({
            localUsage: await options.scanner!(input),
            accountTokenUsage: createEmptyAccountTokenUsageSnapshot("unavailable", input.now)
          })
        : scanLocalUsageAndAccountTokenUsage);
  }

  async getSnapshot(onRefreshed?: () => void): Promise<DashboardLocalUsageViewModel> {
    return (await this.getSnapshots(onRefreshed)).localUsage;
  }

  async getSnapshots(onRefreshed?: () => void): Promise<LocalUsageSnapshots> {
    await this.syncSnapshotsFromCache();

    if (!this.snapshot) {
      this.startRefresh(onRefreshed);
      const now = this.now();
      return {
        localUsage: createEmptySnapshot("loading", this.periodDays, this.timeZone, now),
        accountTokenUsage: createEmptyAccountTokenUsageSnapshot("loading", now)
      };
    }

    if (isSnapshotFresh(this.snapshot, this.now())) {
      return {
        localUsage: this.snapshot,
        accountTokenUsage:
          this.accountTokenUsage ??
          createEmptyAccountTokenUsageSnapshot("unavailable", this.snapshot.calculatedAt ?? this.now())
      };
    }

    this.startRefresh(onRefreshed);
    return {
      localUsage: {
        ...this.snapshot,
        isRefreshing: true
      },
      accountTokenUsage: {
        ...(this.accountTokenUsage ?? createEmptyAccountTokenUsageSnapshot("unavailable", this.now())),
        isRefreshing: true
      }
    };
  }

  private async syncSnapshotsFromCache(): Promise<boolean> {
    const [usageUpdated, accountUsageUpdated] = await Promise.all([
      this.syncSnapshotFromCache(),
      this.syncAccountTokenUsageFromCache()
    ]);
    return usageUpdated || accountUsageUpdated;
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

  private async syncAccountTokenUsageFromCache(): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.accountTokenUsageCachePath(), "utf8");
      const cache = parseAccountTokenUsageCache(raw);
      const cachedCalculatedAt = cache?.snapshot.calculatedAt ?? Number.NEGATIVE_INFINITY;
      const currentCalculatedAt = this.accountTokenUsage?.calculatedAt ?? Number.NEGATIVE_INFINITY;
      if (!cache || (this.accountTokenUsage && cachedCalculatedAt <= currentCalculatedAt)) {
        return false;
      }

      this.accountTokenUsage = {
        ...cache.snapshot,
        isRefreshing: false
      };
      return true;
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        console.warn("[codexAccounts] account token usage cache ignored", error);
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
      await this.syncSnapshotsFromCache();
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
    const scanned = await this.combinedScanner({
      sessionsPath: this.sessionsPath,
      periodDays: this.periodDays,
      timeZone: this.timeZone,
      now: this.now(),
      usageAttributionDirectory: this.usageAttributionDirectory
    });
    const snapshot: DashboardLocalUsageViewModel = {
      ...scanned.localUsage,
      isRefreshing: false
    };
    const accountTokenUsage: AccountTokenUsageSnapshot = {
      ...scanned.accountTokenUsage,
      isRefreshing: false
    };

    await this.syncSnapshotsFromCache();
    if (
      (this.snapshot?.calculatedAt ?? Number.NEGATIVE_INFINITY) > (snapshot.calculatedAt ?? Number.NEGATIVE_INFINITY)
    ) {
      return;
    }

    await this.writeAccountTokenUsageCache(accountTokenUsage);
    await this.writeCache(snapshot);
    this.snapshot = snapshot;
    this.accountTokenUsage = accountTokenUsage;
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
    this.accountTokenUsage = createEmptyAccountTokenUsageSnapshot("unavailable", calculatedAt);
    await this.writeCache(this.snapshot).catch(() => undefined);
    await this.writeAccountTokenUsageCache(this.accountTokenUsage).catch(() => undefined);
  }

  private async waitForPeerRefresh(previousCalculatedAt: number | undefined): Promise<void> {
    const deadline = Date.now() + PEER_REFRESH_WAIT_MS;
    do {
      await delay(PEER_REFRESH_POLL_MS);
      const adopted = await this.syncSnapshotsFromCache();
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

  private async writeAccountTokenUsageCache(snapshot: AccountTokenUsageSnapshot): Promise<void> {
    const cachePath = this.accountTokenUsageCachePath();
    const tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    const value: AccountTokenUsageCache = {
      schemaVersion: ACCOUNT_TOKEN_USAGE_CACHE_SCHEMA_VERSION,
      snapshot
    };

    await fs.mkdir(this.options.globalStoragePath, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tempPath, cachePath);
      await fs.chmod(cachePath, 0o600).catch(() => undefined);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private cachePath(): string {
    return path.join(this.options.globalStoragePath, CACHE_FILE_NAME);
  }

  private accountTokenUsageCachePath(): string {
    return path.join(this.options.globalStoragePath, ACCOUNT_TOKEN_USAGE_CACHE_FILE_NAME);
  }

  private scanLeasePath(): string {
    return path.join(this.options.globalStoragePath, LOCAL_USAGE_SCAN_LEASE_FILE_NAME);
  }
}

export async function scanLocalUsageSessions(input: LocalUsageScanInput): Promise<DashboardLocalUsageViewModel> {
  return (await scanLocalUsageSessionsInternal(input, emptyUsageAttributionIndex())).localUsage;
}

export async function scanLocalUsageAndAccountTokenUsage(
  input: LocalUsageCombinedScanInput
): Promise<LocalUsageSnapshots> {
  const attribution = await readUsageAttributionIndex(input.usageAttributionDirectory);
  return scanLocalUsageSessionsInternal(input, attribution);
}

async function scanLocalUsageSessionsInternal(
  input: LocalUsageScanInput,
  attribution: UsageAttributionIndex
): Promise<LocalUsageSnapshots> {
  const empty = createEmptySnapshot("unavailable", input.periodDays, input.timeZone, input.now);
  const accountUsageWindows = new Map<string, Map<string, AccountTokenUsageWindow>>();
  if (!(await isDirectory(input.sessionsPath))) {
    return {
      localUsage: withRefreshWindow(empty, input.now),
      accountTokenUsage: createAccountTokenUsageSnapshot(
        attribution.recordCount > 0 ? "ready" : "unavailable",
        accountUsageWindows,
        input.now
      )
    };
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
  let attributedEventCount = 0;

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
    const sessionThreadIds = new Set<string>();

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
            for (const threadId of readSessionThreadIds(payload)) {
              sessionThreadIds.add(threadId);
            }
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

        const attributionRecord = findUsageAttribution(sessionThreadIds, timestamp, attribution.byThread);
        if (attributionRecord) {
          const quotaWindows = readTokenUsageQuotaWindows(payload);
          if (quotaWindows.length > 0) {
            addAccountTokenUsage(accountUsageWindows, attributionRecord.a, quotaWindows, usage, timestamp);
            attributedEventCount += 1;
          }
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
  const localUsage = withRefreshWindow(
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
  return {
    localUsage,
    accountTokenUsage: createAccountTokenUsageSnapshot(
      attributedEventCount > 0 || attribution.recordCount > 0 ? "ready" : "unavailable",
      accountUsageWindows,
      input.now
    )
  };
}

export function isSnapshotFresh(snapshot: DashboardLocalUsageViewModel, now: number): boolean {
  if (snapshot.nextRefreshAt != null) {
    return now < snapshot.nextRefreshAt;
  }
  return snapshot.calculatedAt != null && now - snapshot.calculatedAt < LOCAL_USAGE_CACHE_TTL_MS;
}

export function findAccountTokenUsageWindow(
  snapshot: AccountTokenUsageSnapshot | undefined,
  accountId: string,
  window: AccountTokenUsageWindow["window"],
  resetAt: number | undefined
): AccountTokenUsageWindow | undefined {
  if (!snapshot || resetAt == null || !Number.isFinite(resetAt)) {
    return undefined;
  }
  return snapshot.windowsByAccount[accountId]?.reduce<AccountTokenUsageWindow | undefined>((latest, candidate) => {
    if (
      candidate.window !== window ||
      Math.abs(candidate.resetAt - Math.floor(resetAt)) > RESET_TIME_MATCH_TOLERANCE_SECONDS
    ) {
      return latest;
    }
    return !latest || candidate.lastObservedAt > latest.lastObservedAt ? candidate : latest;
  }, undefined);
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

function createEmptyAccountTokenUsageSnapshot(
  status: AccountTokenUsageSnapshot["status"],
  calculatedAt: number
): AccountTokenUsageSnapshot {
  return {
    status,
    isRefreshing: false,
    calculatedAt,
    nextRefreshAt: calculatedAt + LOCAL_USAGE_CACHE_TTL_MS,
    windowsByAccount: {}
  };
}

function createAccountTokenUsageSnapshot(
  status: AccountTokenUsageSnapshot["status"],
  windowsByAccount: Map<string, Map<string, AccountTokenUsageWindow>>,
  calculatedAt: number
): AccountTokenUsageSnapshot {
  const serializedWindows: Record<string, AccountTokenUsageWindow[]> = {};
  for (const [accountId, windows] of windowsByAccount) {
    serializedWindows[accountId] = [...windows.values()]
      .map((window) => ({ ...window }))
      .sort((a, b) => a.window.localeCompare(b.window) || a.resetAt - b.resetAt);
  }
  return {
    ...createEmptyAccountTokenUsageSnapshot(status, calculatedAt),
    windowsByAccount: serializedWindows
  };
}

function emptyUsageAttributionIndex(): UsageAttributionIndex {
  return { byThread: new Map(), recordCount: 0 };
}

function readSessionThreadIds(payload: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const key of ["id", "session_id", "sessionId"]) {
    const value = readBoundedString(payload[key], MAX_USAGE_ATTRIBUTION_THREAD_ID_LENGTH);
    if (value) {
      ids.add(value);
    }
  }
  return [...ids];
}

function findUsageAttribution(
  sessionThreadIds: ReadonlySet<string>,
  timestamp: number,
  byThread: ReadonlyMap<string, readonly UsageAttributionRecord[]>
): UsageAttributionRecord | undefined {
  let latest: UsageAttributionRecord | undefined;
  for (const threadId of sessionThreadIds) {
    const records = byThread.get(threadId);
    if (!records) {
      continue;
    }
    const candidate = findLatestAttributionBefore(records, timestamp);
    if (candidate && (!latest || candidate.t > latest.t)) {
      latest = candidate;
    }
  }
  return latest;
}

function findLatestAttributionBefore(
  records: readonly UsageAttributionRecord[],
  timestamp: number
): UsageAttributionRecord | undefined {
  let low = 0;
  let high = records.length - 1;
  let result: UsageAttributionRecord | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = records[middle];
    if (!candidate) {
      break;
    }
    if (candidate.t <= timestamp) {
      result = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function readTokenUsageQuotaWindows(
  payload: Record<string, unknown>
): Array<Pick<AccountTokenUsageWindow, "window" | "resetAt">> {
  const info = asRecord(payload["info"]);
  const rateLimits =
    asRecord(payload["rate_limits"]) ??
    asRecord(payload["rateLimits"]) ??
    asRecord(payload["rate_limit"]) ??
    asRecord(info?.["rate_limits"]) ??
    asRecord(info?.["rateLimits"]);
  if (!rateLimits) {
    return [];
  }

  const primary =
    asRecord(rateLimits["primary"]) ?? asRecord(rateLimits["primary_window"]) ?? asRecord(rateLimits["primaryWindow"]);
  const secondary =
    asRecord(rateLimits["secondary"]) ??
    asRecord(rateLimits["secondary_window"]) ??
    asRecord(rateLimits["secondaryWindow"]);
  const hourlyResetAt = readResetAtSeconds(primary);
  const weeklyResetAt = readResetAtSeconds(secondary);
  const candidates: TokenUsageQuotaWindowCandidate[] = [];
  if (hourlyResetAt != null) {
    candidates.push({
      fallbackWindow: "hourly",
      resetAt: hourlyResetAt,
      windowMinutes: readQuotaWindowMinutes(primary)
    });
  }
  if (weeklyResetAt != null) {
    candidates.push({
      fallbackWindow: "weekly",
      resetAt: weeklyResetAt,
      windowMinutes: readQuotaWindowMinutes(secondary)
    });
  }
  return classifyTokenUsageQuotaWindows(candidates);
}

function classifyTokenUsageQuotaWindows(
  candidates: readonly TokenUsageQuotaWindowCandidate[]
): Array<Pick<AccountTokenUsageWindow, "window" | "resetAt">> {
  if (candidates.length === 0) {
    return [];
  }
  if (candidates.length === 1) {
    const [candidate] = candidates;
    if (!candidate) {
      return [];
    }
    return [
      {
        window: isLongTermQuotaWindow(candidate.windowMinutes) ? "weekly" : candidate.fallbackWindow,
        resetAt: candidate.resetAt
      }
    ];
  }

  if (candidates.every((candidate) => candidate.windowMinutes != null)) {
    return [...candidates]
      .sort((left, right) => (left.windowMinutes ?? 0) - (right.windowMinutes ?? 0))
      .map((candidate, index) => ({
        window: index === 0 ? "hourly" : "weekly",
        resetAt: candidate.resetAt
      }));
  }

  return candidates.map((candidate) => ({
    window: candidate.fallbackWindow,
    resetAt: candidate.resetAt
  }));
}

function isLongTermQuotaWindow(windowMinutes: number | undefined): boolean {
  return windowMinutes != null && windowMinutes >= 24 * 60;
}

function readQuotaWindowMinutes(value: Record<string, unknown> | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const rawMinutes = value["window_minutes"] ?? value["windowMinutes"];
  const minutes =
    typeof rawMinutes === "number" ? rawMinutes : typeof rawMinutes === "string" ? Number(rawMinutes) : NaN;
  if (Number.isFinite(minutes) && minutes > 0) {
    return minutes;
  }

  const rawSeconds = value["limit_window_seconds"] ?? value["limitWindowSeconds"];
  const seconds =
    typeof rawSeconds === "number" ? rawSeconds : typeof rawSeconds === "string" ? Number(rawSeconds) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : undefined;
}

function readResetAtSeconds(value: Record<string, unknown> | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const raw = value["resets_at"] ?? value["reset_at"] ?? value["resetAt"] ?? value["reset_time"];
  const numeric = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  return Math.floor(numeric > 1_000_000_000_000 ? numeric / 1_000 : numeric);
}

function addAccountTokenUsage(
  windowsByAccount: Map<string, Map<string, AccountTokenUsageWindow>>,
  accountId: string,
  quotaWindows: readonly Pick<AccountTokenUsageWindow, "window" | "resetAt">[],
  usage: DashboardLocalUsageTokenTotals,
  observedAt: number
): void {
  let accountWindows = windowsByAccount.get(accountId);
  if (!accountWindows) {
    accountWindows = new Map();
    windowsByAccount.set(accountId, accountWindows);
  }
  for (const quotaWindow of quotaWindows) {
    const key = `${quotaWindow.window}:${quotaWindow.resetAt}`;
    let target = accountWindows.get(key);
    if (!target) {
      target = {
        window: quotaWindow.window,
        resetAt: quotaWindow.resetAt,
        eventCount: 0,
        lastObservedAt: observedAt,
        ...emptyTotals()
      };
      accountWindows.set(key, target);
    }
    addTotals(target, usage);
    target.eventCount += 1;
    target.lastObservedAt = Math.max(target.lastObservedAt, observedAt);
  }
}

async function readUsageAttributionIndex(directory: string): Promise<UsageAttributionIndex> {
  const index = emptyUsageAttributionIndex();
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      console.warn("[codexAccounts] usage attribution directory ignored", error);
    }
    return index;
  }

  const journals = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map(async (entry) => {
        const journalPath = path.join(directory, entry.name);
        try {
          const stat = await fs.stat(journalPath);
          return stat.isFile() && stat.size > 0 ? { journalPath, mtimeMs: stat.mtimeMs, size: stat.size } : undefined;
        } catch (error) {
          if (!isErrorCode(error, "ENOENT")) {
            console.warn("[codexAccounts] usage attribution journal ignored", error);
          }
          return undefined;
        }
      })
  );

  let remainingBytes = MAX_USAGE_ATTRIBUTION_JOURNAL_BYTES;
  for (const journal of journals
    .filter((candidate): candidate is { journalPath: string; mtimeMs: number; size: number } => Boolean(candidate))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (remainingBytes <= 0) {
      break;
    }
    try {
      const raw = await readJournalTail(journal.journalPath, Math.min(remainingBytes, journal.size));
      remainingBytes -= Buffer.byteLength(raw, "utf8");
      for (const line of raw.split(/\r?\n/u)) {
        const record = parseUsageAttributionRecord(line);
        if (!record) {
          continue;
        }
        const records = index.byThread.get(record.th) ?? [];
        records.push(record);
        index.byThread.set(record.th, records);
        index.recordCount += 1;
      }
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        console.warn("[codexAccounts] usage attribution journal skipped", error);
      }
    }
  }

  for (const records of index.byThread.values()) {
    records.sort((a, b) => a.t - b.t || a.a.localeCompare(b.a));
  }
  return index;
}

async function readJournalTail(journalPath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(journalPath, "r");
  try {
    const stat = await handle.stat();
    const length = Math.max(0, Math.min(stat.size, maxBytes));
    if (length === 0) {
      return "";
    }
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    let raw = buffer.subarray(0, bytesRead).toString("utf8");
    if (stat.size > length) {
      const firstNewline = raw.indexOf("\n");
      raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
    }
    return raw;
  } finally {
    await handle.close();
  }
}

function parseUsageAttributionRecord(line: string): UsageAttributionRecord | undefined {
  if (!line || Buffer.byteLength(line, "utf8") > MAX_USAGE_ATTRIBUTION_LINE_BYTES) {
    return undefined;
  }
  const candidate = parseRecord(line);
  if (!candidate || (candidate["v"] !== undefined && candidate["v"] !== 1)) {
    return undefined;
  }
  const timestamp = candidate["t"];
  const t = typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Number(timestamp) : Number.NaN;
  const threadId = readBoundedString(candidate["th"], MAX_USAGE_ATTRIBUTION_THREAD_ID_LENGTH);
  const accountId = readBoundedString(candidate["a"], MAX_USAGE_ATTRIBUTION_THREAD_ID_LENGTH);
  if (!Number.isFinite(t) || t <= 0 || !threadId || !accountId) {
    return undefined;
  }
  return { t: Math.floor(t), th: threadId, a: accountId };
}

function readBoundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
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

function parseAccountTokenUsageCache(raw: string): AccountTokenUsageCache | undefined {
  try {
    const candidate = asRecord(JSON.parse(raw));
    if (!candidate || candidate["schemaVersion"] !== ACCOUNT_TOKEN_USAGE_CACHE_SCHEMA_VERSION) {
      return undefined;
    }
    const snapshot = candidate["snapshot"];
    return isAccountTokenUsageSnapshot(snapshot)
      ? {
          schemaVersion: ACCOUNT_TOKEN_USAGE_CACHE_SCHEMA_VERSION,
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

function isAccountTokenUsageSnapshot(value: unknown): value is AccountTokenUsageSnapshot {
  const candidate = asRecord(value);
  if (!candidate || !isUsageStatus(candidate["status"]) || typeof candidate["isRefreshing"] !== "boolean") {
    return false;
  }
  const windowsByAccount = asRecord(candidate["windowsByAccount"]);
  if (!windowsByAccount) {
    return false;
  }
  return (
    (candidate["calculatedAt"] == null || isFiniteNumber(candidate["calculatedAt"])) &&
    (candidate["nextRefreshAt"] == null || isFiniteNumber(candidate["nextRefreshAt"])) &&
    Object.entries(windowsByAccount).every(
      ([accountId, windows]) =>
        accountId.length > 0 &&
        accountId.length <= MAX_USAGE_ATTRIBUTION_THREAD_ID_LENGTH &&
        Array.isArray(windows) &&
        windows.every(isAccountTokenUsageWindow)
    )
  );
}

function isUsageStatus(value: unknown): value is DashboardLocalUsageViewModel["status"] {
  return value === "loading" || value === "ready" || value === "unavailable";
}

function isAccountTokenUsageWindow(value: unknown): value is AccountTokenUsageWindow {
  const candidate = asRecord(value);
  return Boolean(
    candidate &&
    (candidate["window"] === "hourly" || candidate["window"] === "weekly") &&
    isFiniteNumber(candidate["resetAt"]) &&
    candidate["resetAt"] > 0 &&
    isFiniteNumber(candidate["eventCount"]) &&
    candidate["eventCount"] >= 0 &&
    isFiniteNumber(candidate["lastObservedAt"]) &&
    candidate["lastObservedAt"] > 0 &&
    isTokenTotals(candidate)
  );
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

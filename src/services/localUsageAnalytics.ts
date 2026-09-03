import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type {
  DashboardLocalUsageBucketModelViewModel,
  DashboardLocalUsageBucketViewModel,
  DashboardLocalUsageDayModelViewModel,
  DashboardLocalUsageDayViewModel,
  DashboardLocalUsageRange,
  DashboardLocalUsageModelViewModel,
  DashboardLocalUsageTokenTotals,
  DashboardLocalUsageViewModel
} from "../domain/dashboard/types";
import { DASHBOARD_LOCAL_USAGE_RANGE_OPTIONS as LOCAL_USAGE_RANGE_OPTIONS } from "../domain/dashboard/types";
import { tryAcquireSharedFileLease } from "../storage/accountsWriteCoordinator";

export const LOCAL_USAGE_CACHE_TTL_MS = 15 * 60 * 1000;
export const LOCAL_USAGE_PERIOD_DAYS = 14;
export const LOCAL_USAGE_SHORT_PERIOD_DAYS = 4;
export const LOCAL_USAGE_DAILY_RETENTION_DAYS = 370;
export const LOCAL_USAGE_SCAN_LEASE_MS = 60 * 1000;
export const ACCOUNT_TOKEN_USAGE_RETENTION_DAYS = 31;

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE_NAME = "local-usage-analytics-v9.json";
export const ACCOUNT_TOKEN_USAGE_CACHE_FILE_NAME = "account-token-usage-v4.json";
export const ACCOUNT_USAGE_ATTRIBUTION_DIRECTORY_NAME = "account-usage-attribution";
export const LOCAL_USAGE_SCAN_LEASE_FILE_NAME = `${CACHE_FILE_NAME}.scan-lease`;
const CACHE_SCHEMA_VERSION = 9;
const ACCOUNT_TOKEN_USAGE_CACHE_SCHEMA_VERSION = 4;
const UNKNOWN_MODEL = "unknown";
const PEER_REFRESH_WAIT_MS = 2_000;
const PEER_REFRESH_POLL_MS = 50;
const MAX_USAGE_ATTRIBUTION_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_USAGE_ATTRIBUTION_LINE_BYTES = 1_024;
const MAX_USAGE_ATTRIBUTION_THREAD_ID_LENGTH = 256;
// Older subagent rollouts copied the parent transcript and cumulative token
// snapshots into the child file during startup. Newer rollouts can omit
// inter_agent_communication_metadata entirely, so use the short dense startup
// burst as a fallback boundary detector for those files.
const SUBAGENT_INHERITED_HISTORY_DETECTION_WINDOW_MS = 1_000;
const SUBAGENT_INHERITED_HISTORY_MIN_TOKEN_EVENTS = 16;
// Legacy lookup callers can see the same quota reset boundary a few seconds
// apart across adjacent token events. A real five-hour or long-term quota
// reset is much farther away, so keep one minute of room for that jitter.
const ACCOUNT_USAGE_RESET_DRIFT_TOLERANCE_SECONDS = 60;
const LOCAL_USAGE_EVENT_MARKER =
  /"type"\s*:\s*"(?:session_meta|turn_context|token_count|inter_agent_communication_metadata|task_started)"/;
const ZONED_DATE_TIME_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

type ZonedDateTimeParts = {
  date: string;
  year: number;
  month: number;
  day: number;
  hour: number;
};

export type LocalUsageScanInput = {
  sessionsPath: string;
  periodDays: number;
  shortPeriodDays?: number;
  timeZone: string;
  now: number;
};

export type LocalUsageScanner = (input: LocalUsageScanInput) => Promise<DashboardLocalUsageViewModel>;

export type AccountTokenUsageWindow = DashboardLocalUsageTokenTotals & {
  byModel: DashboardLocalUsageModelViewModel[];
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
  backgroundRefreshEnabled?: boolean;
  enabledRanges?: DashboardLocalUsageRange[];
};

type LocalUsageCacheCoverage = {
  dailyStartDate: string;
  dailyEndDate: string;
};

type LocalUsageCache = {
  schemaVersion: number;
  snapshot: DashboardLocalUsageViewModel;
  coverage: LocalUsageCacheCoverage;
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

type ScannedTokenUsage = {
  usage: MutableTotals;
  timestamp: number;
  model: string;
  attributionAccountId?: string;
  quotaWindows: Array<Pick<AccountTokenUsageWindow, "window" | "resetAt">>;
  afterSubagentBoundary: boolean;
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
  private cacheCoverage: LocalUsageCacheCoverage | undefined;
  private readonly sessionsPath: string;
  private readonly defaultPeriodDays: number;
  private readonly timeZone: string;
  private readonly now: () => number;
  private readonly combinedScanner: LocalUsageCombinedScanner;
  private readonly usageAttributionDirectory: string;
  private readonly backgroundRefreshEnabled: boolean;
  private enabledRanges: DashboardLocalUsageRange[];

  constructor(private readonly options: LocalUsageAnalyticsOptions) {
    this.sessionsPath = options.sessionsPath ?? defaultSessionsPath();
    this.defaultPeriodDays = options.periodDays ?? LOCAL_USAGE_SHORT_PERIOD_DAYS;
    this.timeZone = options.timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    this.now = options.now ?? Date.now;
    this.backgroundRefreshEnabled = options.backgroundRefreshEnabled ?? true;
    this.enabledRanges = normalizeEnabledRanges(options.enabledRanges);
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

  setEnabledRanges(ranges: readonly DashboardLocalUsageRange[]): void {
    this.enabledRanges = normalizeEnabledRanges(ranges);
  }

  /**
   * Forces one fresh local token scan, bypassing the normal 15-minute cache
   * window while preserving the shared cross-host scan lease.
   */
  async refresh(onRefreshed?: () => void): Promise<void> {
    await this.syncSnapshotsFromCache();
    await this.startRefresh(onRefreshed, true);
  }

  async getSnapshots(onRefreshed?: () => void): Promise<LocalUsageSnapshots> {
    await this.syncSnapshotsFromCache();

    if (!this.snapshot) {
      if (this.backgroundRefreshEnabled) {
        void this.startRefresh(onRefreshed);
      }
      const now = this.now();
      return {
        localUsage: createEmptySnapshot(
          "loading",
          this.defaultPeriodDays,
          this.timeZone,
          now,
          LOCAL_USAGE_SHORT_PERIOD_DAYS
        ),
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

    if (this.backgroundRefreshEnabled) {
      void this.startRefresh(onRefreshed);
    }
    return {
      localUsage: {
        ...this.snapshot,
        isRefreshing: this.backgroundRefreshEnabled
      },
      accountTokenUsage: {
        ...(this.accountTokenUsage ?? createEmptyAccountTokenUsageSnapshot("unavailable", this.now())),
        isRefreshing: this.backgroundRefreshEnabled
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
      if (!cache) {
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
      this.cacheCoverage = cache.coverage;
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

  private startRefresh(onRefreshed?: () => void, force = false): Promise<void> {
    if (onRefreshed) {
      this.refreshCallbacks.add(onRefreshed);
    }
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshWithLease(force)
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
    return this.refreshPromise;
  }

  private async refreshWithLease(force = false): Promise<void> {
    const previousCalculatedAt = this.snapshot?.calculatedAt;
    const lease = await tryAcquireSharedFileLease(this.scanLeasePath(), LOCAL_USAGE_SCAN_LEASE_MS);
    if (!lease) {
      await this.waitForPeerRefresh(previousCalculatedAt);
      return;
    }

    try {
      await this.syncSnapshotsFromCache();
      if (!force && this.snapshot && isSnapshotFresh(this.snapshot, this.now())) {
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
    const scanPeriodDays = this.resolveScanPeriodDays();
    const scanned = await this.combinedScanner({
      sessionsPath: this.sessionsPath,
      periodDays: scanPeriodDays,
      shortPeriodDays: LOCAL_USAGE_SHORT_PERIOD_DAYS,
      timeZone: this.timeZone,
      now: this.now(),
      usageAttributionDirectory: this.usageAttributionDirectory
    });
    const snapshot = mergeLocalUsageSnapshots(this.snapshot, scanned.localUsage, this.timeZone, this.now());
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
    const coverage = mergeUsageCoverage(this.cacheCoverage, scanned.localUsage, this.timeZone);
    await this.writeCache(snapshot, coverage);
    this.snapshot = snapshot;
    this.cacheCoverage = coverage;
    this.accountTokenUsage = accountTokenUsage;
  }

  private async persistUnavailableSnapshotIfEmpty(): Promise<void> {
    if (this.snapshot) {
      return;
    }

    const calculatedAt = this.now();
    this.snapshot = {
      ...createEmptySnapshot(
        "unavailable",
        this.defaultPeriodDays,
        this.timeZone,
        calculatedAt,
        LOCAL_USAGE_SHORT_PERIOD_DAYS
      ),
      calculatedAt,
      nextRefreshAt: nextLocalUsageRefreshAt(calculatedAt, this.timeZone)
    };
    this.cacheCoverage = createUsageCoverage(this.snapshot);
    this.accountTokenUsage = createEmptyAccountTokenUsageSnapshot("unavailable", calculatedAt);
    await this.writeCache(this.snapshot, this.cacheCoverage).catch(() => undefined);
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

  private async writeCache(snapshot: DashboardLocalUsageViewModel, coverage: LocalUsageCacheCoverage): Promise<void> {
    const cachePath = this.cachePath();
    const tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    const value: LocalUsageCache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      snapshot,
      coverage
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

  private resolveScanPeriodDays(): number {
    const now = this.now();
    const today = dateKey(now, this.timeZone);
    const requiredStart = earliestRequiredDailyDate(today, this.enabledRanges);
    const coveredStart = this.cacheCoverage?.dailyStartDate;
    const coveredEnd = this.cacheCoverage?.dailyEndDate;
    if (requiredStart && (!coveredStart || coveredStart > requiredStart)) {
      return Math.max(this.defaultPeriodDays, daysBetweenDateKeys(requiredStart, today) + 1);
    }
    if (requiredStart && (!coveredEnd || coveredEnd < today)) {
      return Math.max(this.defaultPeriodDays, daysBetweenDateKeys(coveredEnd ?? today, today) + 1);
    }
    return Math.max(this.defaultPeriodDays, LOCAL_USAGE_SHORT_PERIOD_DAYS);
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
  const shortPeriodDays = Math.max(1, Math.floor(input.shortPeriodDays ?? LOCAL_USAGE_SHORT_PERIOD_DAYS));
  const empty = createEmptySnapshot("unavailable", input.periodDays, input.timeZone, input.now, shortPeriodDays);
  const accountUsageWindows = new Map<string, Map<string, AccountTokenUsageWindow>>();
  const tracksAccountUsage = attribution.recordCount > 0;
  if (!(await isDirectory(input.sessionsPath))) {
    return {
      localUsage: withRefreshWindow(empty, input.now, input.timeZone),
      accountTokenUsage: createAccountTokenUsageSnapshot(
        attribution.recordCount > 0 ? "ready" : "unavailable",
        accountUsageWindows,
        input.now
      )
    };
  }

  const allowedDates = new Set(recentDateKeys(input.now, input.periodDays, input.timeZone));
  const shortStartDate = shiftLocalDate(zonedDateTimeParts(input.now, input.timeZone), -(shortPeriodDays - 1));
  const shortUsageStartAt = localDateTimeToTimestamp({ ...shortStartDate, hour: 0 }, input.timeZone);
  const oldestAccountUsageTimestamp = tracksAccountUsage
    ? input.now - ACCOUNT_TOKEN_USAGE_RETENTION_DAYS * DAY_MS
    : Number.POSITIVE_INFINITY;
  const byDate = new Map(empty.byDay.map((row) => [row.date, row]));
  const by3Hour = new Map(empty.by3Hour.map((row) => [row.startAt, row]));
  const byModel = new Map<string, DashboardLocalUsageModelViewModel>();
  const by3HourAndModel = new Map<string, DashboardLocalUsageBucketModelViewModel>();
  const byDayAndModel = new Map<string, DashboardLocalUsageDayModelViewModel>();
  const sourceFiles = new Set<string>();
  const total = empty.total;
  let eventCount = 0;
  let attributedEventCount = 0;

  // mtime must be at least as recent as the newest record in a session file.
  // Account quota windows can be longer than the 14-day local dashboard, so
  // retain the known 30-day long-term window plus one day for boundaries.
  const oldestRelevantMtime =
    input.now -
    (Math.max(
      1,
      Math.floor(input.periodDays),
      shortPeriodDays,
      tracksAccountUsage ? ACCOUNT_TOKEN_USAGE_RETENTION_DAYS : 0
    ) +
      1) *
      DAY_MS;
  const files = await findJsonlFiles(input.sessionsPath, oldestRelevantMtime);
  for (const file of files) {
    let currentModel = UNKNOWN_MODEL;
    let fileHasLocalUsage = false;
    let firstSessionMetaSeen = false;
    let shouldCountUsage = true;
    let isSpawnedSubagent = false;
    let sawTaskStarted = false;
    let subagentUsageBoundaryReached = false;
    let subagentStartupAt: number | undefined;
    let subagentStartupTokenEvents = 0;
    let usageHighWater: TokenUsageHighWater | undefined;
    const sessionThreadIds = new Set<string>();
    const pendingSubagentUsage: ScannedTokenUsage[] = [];

    const recordUsage = (observation: ScannedTokenUsage): void => {
      const localTimestamp = zonedDateTimeParts(observation.timestamp, input.timeZone);
      const date = localTimestamp.date;
      const includesLocalUsage = allowedDates.has(date);
      const includesShortUsage = observation.timestamp >= shortUsageStartAt;
      const includesAccountUsage = tracksAccountUsage && observation.timestamp >= oldestAccountUsageTimestamp;

      if (includesAccountUsage && observation.attributionAccountId && observation.quotaWindows.length > 0) {
        addAccountTokenUsage(
          accountUsageWindows,
          observation.attributionAccountId,
          observation.quotaWindows,
          observation.model,
          observation.usage,
          observation.timestamp
        );
        attributedEventCount += 1;
      }

      if (includesShortUsage) {
        const bucketStartAt = localUsageBucketStartAt(observation.timestamp, input.timeZone);
        const bucket = by3Hour.get(bucketStartAt);
        if (bucket) {
          addTotals(bucket, observation.usage);
          bucket.eventCount += 1;
        }
        const bucketModel = getOrCreateBucketModelBucket(by3HourAndModel, bucketStartAt, observation.model);
        addTotals(bucketModel, observation.usage);
      }

      if (!includesLocalUsage) {
        return;
      }

      const day = byDate.get(date);
      if (!day) {
        return;
      }

      const modelBucket = getOrCreateModelBucket(byModel, observation.model);
      const dayModelBucket = getOrCreateDayModelBucket(byDayAndModel, date, observation.model);
      addTotals(total, observation.usage);
      addTotals(day, observation.usage);
      addTotals(modelBucket, observation.usage);
      addTotals(dayModelBucket, observation.usage);
      day.eventCount += 1;

      eventCount += 1;
      fileHasLocalUsage = true;
    };

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
            isSpawnedSubagent = isSpawnedSubagentSession(payload);
            shouldCountUsage = !isSpawnedSubagent;
            if (isSpawnedSubagent) {
              subagentStartupAt = timestampFromEvent(event["timestamp"]);
            }
          }
          continue;
        }

        if (event["type"] === "inter_agent_communication_metadata") {
          if (payload["trigger_turn"] === true) {
            shouldCountUsage = true;
            if (isSpawnedSubagent) {
              // A trigger is the authoritative child-turn boundary. Any
              // observations buffered before it came from copied history.
              pendingSubagentUsage.length = 0;
            }
          }
          continue;
        }

        if (event["type"] === "event_msg" && payload["type"] === "task_started") {
          sawTaskStarted = true;
          continue;
        }

        if (event["type"] === "turn_context") {
          if (isSpawnedSubagent && !shouldCountUsage && sawTaskStarted) {
            // Older spawned session files do not always contain the
            // inter-agent marker. Their first task_started -> turn_context
            // boundary is the best available child-owned usage boundary.
            subagentUsageBoundaryReached = true;
          }
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
        if (!usage) {
          continue;
        }

        const timestamp = timestampFromEvent(event["timestamp"]);
        if (timestamp == null || timestamp > input.now) {
          continue;
        }

        const localTimestamp = zonedDateTimeParts(timestamp, input.timeZone);
        const date = localTimestamp.date;
        const includesLocalUsage = allowedDates.has(date);
        const includesShortUsage = timestamp >= shortUsageStartAt;
        const includesAccountUsage = tracksAccountUsage && timestamp >= oldestAccountUsageTimestamp;
        if (!includesLocalUsage && !includesShortUsage && !includesAccountUsage) {
          continue;
        }

        const model = currentModel || UNKNOWN_MODEL;
        const attributionRecord = includesAccountUsage
          ? findUsageAttribution(sessionThreadIds, timestamp, attribution.byThread)
          : undefined;
        const observation: ScannedTokenUsage = {
          usage,
          timestamp,
          model,
          attributionAccountId: attributionRecord?.a,
          quotaWindows: includesAccountUsage ? readTokenUsageQuotaWindows(payload) : [],
          afterSubagentBoundary: subagentUsageBoundaryReached
        };

        if (isSpawnedSubagent && !shouldCountUsage && !sawTaskStarted && !subagentUsageBoundaryReached) {
          const startupOffset = subagentStartupAt == null ? undefined : timestamp - subagentStartupAt;
          if (
            startupOffset != null &&
            startupOffset >= 0 &&
            startupOffset <= SUBAGENT_INHERITED_HISTORY_DETECTION_WINDOW_MS
          ) {
            subagentStartupTokenEvents += 1;
            if (subagentStartupTokenEvents < SUBAGENT_INHERITED_HISTORY_MIN_TOKEN_EVENTS) {
              pendingSubagentUsage.push(observation);
            } else {
              // Once the startup burst is dense enough to identify copied
              // history, discard the buffered snapshots as well.
              pendingSubagentUsage.length = 0;
            }
            continue;
          }

          shouldCountUsage = true;
          if (subagentStartupTokenEvents < SUBAGENT_INHERITED_HISTORY_MIN_TOKEN_EVENTS) {
            for (const pending of pendingSubagentUsage) {
              recordUsage(pending);
            }
          }
          pendingSubagentUsage.length = 0;
        }

        if (!shouldCountUsage) {
          pendingSubagentUsage.push(observation);
          continue;
        }

        recordUsage(observation);
      }

      if (isSpawnedSubagent && !shouldCountUsage) {
        if (subagentUsageBoundaryReached) {
          for (const observation of pendingSubagentUsage) {
            if (observation.afterSubagentBoundary) {
              recordUsage(observation);
            }
          }
        } else if (!sawTaskStarted) {
          // A short fresh subagent can finish before its first token event
          // leaves the startup window. If no dense copied-history prefix was
          // detected, those buffered observations are real usage.
          for (const observation of pendingSubagentUsage) {
            recordUsage(observation);
          }
        }
      }
    } catch (error) {
      // Session files can rotate while Codex is running. Ignore only this file
      // and retain the rest of the aggregate rather than affecting the host UI.
      console.warn("[codexAccounts] local usage session file skipped", error);
      continue;
    }

    if (fileHasLocalUsage) {
      sourceFiles.add(file);
    }
  }

  const status = eventCount > 0 ? "ready" : "unavailable";
  const localUsage = withRefreshWindow(
    {
      status,
      isRefreshing: false,
      periodDays: input.periodDays,
      timeZone: input.timeZone,
      calculatedAt: input.now,
      sourceFileCount: sourceFiles.size,
      eventCount,
      total,
      by3Hour: [...by3Hour.values()].sort((a, b) => a.startAt - b.startAt),
      by3HourAndModel: [...by3HourAndModel.values()].sort(
        (a, b) => a.startAt - b.startAt || b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)
      ),
      byDay: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
      byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)),
      byDayAndModel: [...byDayAndModel.values()].sort(
        (a, b) => a.date.localeCompare(b.date) || b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)
      )
    },
    input.now,
    input.timeZone
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
  resetAt: number | undefined,
  windowMinutes?: number
): AccountTokenUsageWindow | undefined {
  if (!snapshot || resetAt == null || !Number.isFinite(resetAt)) {
    return undefined;
  }
  const targetResetAt = Math.floor(resetAt);
  const accountWindows = snapshot.windowsByAccount[accountId];
  // Some provider reset timestamps are derived from a moving countdown rather
  // than a fixed boundary. When the current window duration is known, use the
  // observed event time to collect the current window; retain the exact match
  // path for callers that only have the legacy reset timestamp.
  const normalizedWindowMinutes =
    windowMinutes != null && Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : undefined;
  const matchingWindows = accountWindows?.filter((candidate) => {
    if (candidate.window !== window) {
      return false;
    }
    if (normalizedWindowMinutes != null) {
      const windowStartAt = (targetResetAt - normalizedWindowMinutes * 60) * 1_000;
      const latestObservedAt = snapshot.calculatedAt ?? Number.POSITIVE_INFINITY;
      return candidate.lastObservedAt >= windowStartAt && candidate.lastObservedAt <= latestObservedAt;
    }
    return Math.abs(candidate.resetAt - targetResetAt) <= ACCOUNT_USAGE_RESET_DRIFT_TOLERANCE_SECONDS;
  });
  if (!matchingWindows || matchingWindows.length === 0) {
    return undefined;
  }

  const aggregate: AccountTokenUsageWindow = {
    window,
    resetAt: targetResetAt,
    eventCount: 0,
    lastObservedAt: 0,
    byModel: [],
    ...emptyTotals()
  };
  const modelBuckets = new Map<string, DashboardLocalUsageModelViewModel>();
  for (const candidate of matchingWindows) {
    addTotals(aggregate, candidate);
    for (const modelUsage of candidate.byModel) {
      addTotals(getOrCreateModelBucket(modelBuckets, modelUsage.model), modelUsage);
    }
    aggregate.eventCount += candidate.eventCount;
    aggregate.lastObservedAt = Math.max(aggregate.lastObservedAt, candidate.lastObservedAt);
  }
  aggregate.byModel = sortModelBuckets(modelBuckets);
  return aggregate;
}

function defaultSessionsPath(): string {
  const codexHome = process.env["CODEX_HOME"]?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}

function createEmptySnapshot(
  status: DashboardLocalUsageViewModel["status"],
  periodDays: number,
  timeZone: string,
  now: number,
  shortPeriodDays = LOCAL_USAGE_SHORT_PERIOD_DAYS
): DashboardLocalUsageViewModel {
  return {
    status,
    isRefreshing: false,
    periodDays,
    timeZone,
    sourceFileCount: 0,
    eventCount: 0,
    total: emptyTotals(),
    by3Hour: recent3HourBuckets(now, shortPeriodDays, timeZone),
    by3HourAndModel: [],
    byDay: recentDateKeys(now, periodDays, timeZone).map((date) => ({
      date,
      eventCount: 0,
      ...emptyTotals()
    })),
    byModel: [],
    byDayAndModel: []
  };
}

function mergeLocalUsageSnapshots(
  previous: DashboardLocalUsageViewModel | undefined,
  scanned: DashboardLocalUsageViewModel,
  timeZone: string,
  calculatedAt: number
): DashboardLocalUsageViewModel {
  const scannedByDay = scanned.byDay ?? [];
  const scannedByDayAndModel = scanned.byDayAndModel ?? [];
  const scannedBy3Hour = scanned.by3Hour ?? [];
  const scannedBy3HourAndModel = scanned.by3HourAndModel ?? [];
  if (
    scannedByDay.length === 0 &&
    scannedByDayAndModel.length === 0 &&
    scannedBy3Hour.length === 0 &&
    scannedBy3HourAndModel.length === 0
  ) {
    return {
      ...scanned,
      timeZone,
      by3Hour: scannedBy3Hour,
      by3HourAndModel: scannedBy3HourAndModel,
      byDay: scannedByDay,
      byDayAndModel: scannedByDayAndModel,
      isRefreshing: false
    };
  }

  const dailyRows = new Map(previous?.byDay.map((row) => [row.date, row]) ?? []);
  const scannedDates = new Set(scannedByDay.map((row) => row.date));
  for (const date of scannedDates) {
    dailyRows.delete(date);
  }
  for (const row of scannedByDay) {
    dailyRows.set(row.date, row);
  }

  const dailyModelRows = new Map(previous?.byDayAndModel.map((row) => [`${row.date}\u0000${row.model}`, row]) ?? []);
  for (const key of [...dailyModelRows.keys()]) {
    if (scannedDates.has(key.split("\u0000", 1)[0] ?? "")) {
      dailyModelRows.delete(key);
    }
  }
  for (const row of scanned.byDayAndModel) {
    dailyModelRows.set(`${row.date}\u0000${row.model}`, row);
  }

  const shortBucketStarts = new Set(scannedBy3Hour.map((row) => row.startAt));
  const shortRows = new Map(previous?.by3Hour.map((row) => [row.startAt, row]) ?? []);
  for (const startAt of shortBucketStarts) {
    shortRows.delete(startAt);
  }
  for (const row of scannedBy3Hour) {
    shortRows.set(row.startAt, row);
  }
  const retainedShortStarts = new Set(
    recent3HourBuckets(calculatedAt, LOCAL_USAGE_SHORT_PERIOD_DAYS, timeZone).map((row) => row.startAt)
  );
  for (const startAt of shortRows.keys()) {
    if (!retainedShortStarts.has(startAt)) {
      shortRows.delete(startAt);
    }
  }

  const shortModelRows = new Map(
    previous?.by3HourAndModel.map((row) => [`${row.startAt}\u0000${row.model}`, row]) ?? []
  );
  for (const key of [...shortModelRows.keys()]) {
    const startAt = Number(key.split("\u0000", 1)[0]);
    if (shortBucketStarts.has(startAt) || !retainedShortStarts.has(startAt)) {
      shortModelRows.delete(key);
    }
  }
  for (const row of scannedBy3HourAndModel) {
    shortModelRows.set(`${row.startAt}\u0000${row.model}`, row);
  }

  const sortedDays = [...dailyRows.values()]
    .filter((row) => isWithinDailyRetention(row.date, calculatedAt, timeZone))
    .sort((a, b) => a.date.localeCompare(b.date));
  const sortedDayModels = [...dailyModelRows.values()]
    .filter((row) => isWithinDailyRetention(row.date, calculatedAt, timeZone))
    .sort((a, b) => a.date.localeCompare(b.date) || b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
  const total = sumUsageTotals(sortedDays);
  const byModel = aggregateUsageModels(sortedDayModels);
  const eventCount = sortedDays.reduce((count, row) => count + row.eventCount, 0);

  return withRefreshWindow(
    {
      status: eventCount > 0 ? "ready" : "unavailable",
      isRefreshing: false,
      periodDays: sortedDays.length,
      timeZone,
      sourceFileCount: scanned.sourceFileCount,
      eventCount,
      total,
      by3Hour: [...shortRows.values()].sort((a, b) => a.startAt - b.startAt),
      by3HourAndModel: [...shortModelRows.values()].sort(
        (a, b) => a.startAt - b.startAt || b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)
      ),
      byDay: sortedDays,
      byModel,
      byDayAndModel: sortedDayModels
    },
    calculatedAt,
    timeZone
  );
}

function mergeUsageCoverage(
  previous: LocalUsageCacheCoverage | undefined,
  scanned: DashboardLocalUsageViewModel,
  timeZone: string
): LocalUsageCacheCoverage {
  const scannedDates = scanned.byDay.map((row) => row.date).sort();
  const fallback = previous ?? {
    dailyStartDate: dateKey(scanned.calculatedAt ?? Date.now(), timeZone),
    dailyEndDate: dateKey(scanned.calculatedAt ?? Date.now(), timeZone)
  };
  if (scannedDates.length === 0) {
    return fallback;
  }
  return {
    dailyStartDate:
      [fallback.dailyStartDate, scannedDates[0] ?? fallback.dailyStartDate].sort()[0] ?? fallback.dailyStartDate,
    dailyEndDate:
      [fallback.dailyEndDate, scannedDates[scannedDates.length - 1] ?? fallback.dailyEndDate].sort().at(-1) ??
      fallback.dailyEndDate
  };
}

function createUsageCoverage(snapshot: DashboardLocalUsageViewModel): LocalUsageCacheCoverage {
  const dates = snapshot.byDay.map((row) => row.date).sort();
  const fallback = dateKey(snapshot.calculatedAt ?? Date.now(), snapshot.timeZone);
  return {
    dailyStartDate: dates[0] ?? fallback,
    dailyEndDate: dates.at(-1) ?? fallback
  };
}

function sumUsageTotals(rows: readonly DashboardLocalUsageTokenTotals[]): MutableTotals {
  return rows.reduce<MutableTotals>((total, row) => {
    addTotals(total, row);
    return total;
  }, emptyTotals());
}

function aggregateUsageModels(
  rows: readonly DashboardLocalUsageDayModelViewModel[]
): DashboardLocalUsageModelViewModel[] {
  const models = new Map<string, DashboardLocalUsageModelViewModel>();
  for (const row of rows) {
    addTotals(getOrCreateModelBucket(models, row.model), row);
  }
  return sortModelBuckets(models);
}

function isWithinDailyRetention(date: string, now: number, timeZone: string): boolean {
  const today = dateKey(now, timeZone);
  return date >= shiftDateKey(today, -(LOCAL_USAGE_DAILY_RETENTION_DAYS - 1)) && date <= today;
}

function withRefreshWindow(
  snapshot: DashboardLocalUsageViewModel,
  calculatedAt: number,
  timeZone: string
): DashboardLocalUsageViewModel {
  return {
    ...snapshot,
    calculatedAt,
    nextRefreshAt: nextLocalUsageRefreshAt(calculatedAt, timeZone)
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
      .map((window) => ({
        ...window,
        byModel: [...window.byModel].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model))
      }))
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
        window: classifyQuotaWindowByDuration(candidate.windowMinutes) ?? candidate.fallbackWindow,
        resetAt: candidate.resetAt
      }
    ];
  }

  const assigned = new Map<TokenUsageQuotaWindowCandidate, AccountTokenUsageWindow["window"]>();
  const usedWindows = new Set<AccountTokenUsageWindow["window"]>();
  for (const candidate of candidates) {
    const classified = classifyQuotaWindowByDuration(candidate.windowMinutes);
    if (classified && !usedWindows.has(classified)) {
      assigned.set(candidate, classified);
      usedWindows.add(classified);
    }
  }

  return candidates.map((candidate) => {
    const classified = assigned.get(candidate);
    if (classified) {
      return { window: classified, resetAt: candidate.resetAt };
    }

    const fallback = !usedWindows.has(candidate.fallbackWindow)
      ? candidate.fallbackWindow
      : usedWindows.has("hourly")
        ? "weekly"
        : "hourly";
    usedWindows.add(fallback);
    return { window: fallback, resetAt: candidate.resetAt };
  });
}

function classifyQuotaWindowByDuration(
  windowMinutes: number | undefined
): AccountTokenUsageWindow["window"] | undefined {
  if (windowMinutes == null) {
    return undefined;
  }
  if (windowMinutes > 0 && windowMinutes <= 6 * 60) {
    return "hourly";
  }
  if (isLongTermQuotaWindow(windowMinutes)) {
    return "weekly";
  }
  return undefined;
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
  model: string,
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
        byModel: [],
        ...emptyTotals()
      };
      accountWindows.set(key, target);
    }
    addTotals(target, usage);
    addTotals(getOrCreateAccountModelBucket(target.byModel, model), usage);
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

function getOrCreateAccountModelBucket(
  buckets: DashboardLocalUsageModelViewModel[],
  model: string
): DashboardLocalUsageModelViewModel {
  const existing = buckets.find((bucket) => bucket.model === model);
  if (existing) {
    return existing;
  }

  const created: DashboardLocalUsageModelViewModel = {
    model,
    ...emptyTotals()
  };
  buckets.push(created);
  return created;
}

function sortModelBuckets(
  buckets: Map<string, DashboardLocalUsageModelViewModel>
): DashboardLocalUsageModelViewModel[] {
  return [...buckets.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
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

function getOrCreateBucketModelBucket(
  buckets: Map<string, DashboardLocalUsageBucketModelViewModel>,
  startAt: number,
  model: string
): DashboardLocalUsageBucketModelViewModel {
  const key = `${startAt}\u0000${model}`;
  const existing = buckets.get(key);
  if (existing) {
    return existing;
  }

  const created: DashboardLocalUsageBucketModelViewModel = {
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
  if (cumulative.totals.totalTokens < previousTotalTokens) {
    const highWater: TokenUsageHighWater = cumulative.hasCompleteComponents
      ? {
          totals: cumulative.totals,
          hasCompleteComponents: true
        }
      : {
          totals: {
            ...emptyTotals(),
            totalTokens: cumulative.totals.totalTokens
          },
          hasCompleteComponents: false
        };
    return { highWater, delta: last };
  }

  if (cumulative.totals.totalTokens === previousTotalTokens) {
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

function nextLocalUsageRefreshAt(calculatedAt: number, timeZone: string): number {
  return Math.min(calculatedAt + LOCAL_USAGE_CACHE_TTL_MS, nextLocalDayStartAt(calculatedAt, timeZone));
}

function nextLocalDayStartAt(timestamp: number, timeZone: string): number {
  const local = zonedDateTimeParts(timestamp, timeZone);
  const nextDate = shiftLocalDate(local, 1);
  return localDateTimeToTimestamp({ year: nextDate.year, month: nextDate.month, day: nextDate.day, hour: 0 }, timeZone);
}

function recentDateKeys(now: number, periodDays: number, timeZone: string): string[] {
  const today = dateKey(now, timeZone);
  const days = Math.max(1, Math.floor(periodDays));
  return Array.from({ length: days }, (_, index) => shiftDateKey(today, index - days + 1));
}

function recent3HourBuckets(now: number, periodDays: number, timeZone: string): DashboardLocalUsageBucketViewModel[] {
  const today = dateKey(now, timeZone);
  const days = Math.max(1, Math.floor(periodDays));
  const currentBucketStartAt = localUsageBucketStartAt(now, timeZone);
  const buckets: DashboardLocalUsageBucketViewModel[] = [];
  for (let dayOffset = -days + 1; dayOffset <= 0; dayOffset += 1) {
    const date = shiftDateKey(today, dayOffset);
    const [yearText, monthText, dayText] = date.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    for (let hour = 0; hour < 24; hour += 3) {
      const startAt = localDateTimeToTimestamp({ year, month, day, hour }, timeZone);
      if (startAt > currentBucketStartAt) {
        continue;
      }
      const endAt = localDateTimeToTimestamp({ year, month, day, hour: hour + 3 }, timeZone);
      buckets.push({ startAt, endAt, eventCount: 0, ...emptyTotals() });
    }
  }
  return buckets;
}

function localUsageBucketStartAt(timestamp: number, timeZone: string): number {
  const local = zonedDateTimeParts(timestamp, timeZone);
  return localDateTimeToTimestamp(
    {
      year: local.year,
      month: local.month,
      day: local.day,
      hour: Math.floor(local.hour / 3) * 3
    },
    timeZone
  );
}

function dateKey(timestamp: number, timeZone: string): string {
  return zonedDateTimeParts(timestamp, timeZone).date;
}

function zonedDateTimeParts(timestamp: number, timeZone: string): ZonedDateTimeParts {
  let formatter = ZONED_DATE_TIME_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23"
    });
    ZONED_DATE_TIME_FORMATTERS.set(timeZone, formatter);
  }

  let year: string | undefined;
  let month: string | undefined;
  let day: string | undefined;
  let hour: string | undefined;
  for (const part of formatter.formatToParts(new Date(timestamp))) {
    if (part.type === "year") {
      year = part.value;
    } else if (part.type === "month") {
      month = part.value;
    } else if (part.type === "day") {
      day = part.value;
    } else if (part.type === "hour") {
      hour = part.value;
    }
  }
  if (!year || !month || !day || !hour) {
    throw new Error("Unable to resolve local usage date");
  }
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour) % 24;
  if (![yearNumber, monthNumber, dayNumber, hourNumber].every(Number.isFinite)) {
    throw new Error("Unable to resolve local usage date");
  }
  return {
    date: `${year}-${month}-${day}`,
    year: yearNumber,
    month: monthNumber,
    day: dayNumber,
    hour: hourNumber
  };
}

function shiftLocalDate(
  dateTime: ZonedDateTimeParts,
  days: number
): Pick<ZonedDateTimeParts, "year" | "month" | "day"> {
  const shifted = new Date(Date.UTC(dateTime.year, dateTime.month - 1, dateTime.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
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

function normalizeEnabledRanges(ranges: readonly DashboardLocalUsageRange[] | undefined): DashboardLocalUsageRange[] {
  const configured = new Set(ranges ?? []);
  const normalized = LOCAL_USAGE_RANGE_OPTIONS.filter((range) => configured.has(range));
  return normalized.length > 0 ? [...normalized] : ["24h"];
}

function earliestRequiredDailyDate(today: string, ranges: readonly DashboardLocalUsageRange[]): string | undefined {
  const starts = ranges.flatMap((range) => {
    switch (range) {
      case "7d":
        return [shiftDateKey(today, -6)];
      case "14d":
        return [shiftDateKey(today, -13)];
      case "7w": {
        const currentWeekStart = startOfLocalWeek(today);
        return [shiftDateKey(currentWeekStart, -42)];
      }
      case "7m":
        return [shiftMonthKey(today, -6)];
      default:
        return [];
    }
  });
  return starts.sort()[0];
}

function startOfLocalWeek(date: string): string {
  const [yearText, monthText, dayText] = date.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  return shiftDateKey(date, -daysSinceMonday);
}

function shiftMonthKey(date: string, deltaMonths: number): string {
  const [yearText, monthText] = date.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  return new Date(Date.UTC(year, month - 1 + deltaMonths, 1)).toISOString().slice(0, 10);
}

function daysBetweenDateKeys(start: string, end: string): number {
  const startAt = Date.parse(`${start}T00:00:00Z`);
  const endAt = Date.parse(`${end}T00:00:00Z`);
  return Math.max(0, Math.round((endAt - startAt) / DAY_MS));
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
    const coverage = candidate["coverage"];
    return isUsageSnapshot(snapshot) && isUsageCoverage(coverage)
      ? {
          schemaVersion: CACHE_SCHEMA_VERSION,
          snapshot,
          coverage
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
    typeof candidate["timeZone"] === "string" &&
    (candidate["calculatedAt"] == null || isFiniteNumber(candidate["calculatedAt"])) &&
    (candidate["nextRefreshAt"] == null || isFiniteNumber(candidate["nextRefreshAt"])) &&
    isFiniteNumber(candidate["sourceFileCount"]) &&
    isFiniteNumber(candidate["eventCount"]) &&
    isTokenTotals(candidate["total"]) &&
    Array.isArray(candidate["by3Hour"]) &&
    candidate["by3Hour"].every(isUsageBucket) &&
    Array.isArray(candidate["by3HourAndModel"]) &&
    candidate["by3HourAndModel"].every(isUsageBucketModel) &&
    Array.isArray(candidate["byDay"]) &&
    candidate["byDay"].every(isUsageDay) &&
    Array.isArray(candidate["byModel"]) &&
    candidate["byModel"].every(isUsageModel) &&
    Array.isArray(candidate["byDayAndModel"]) &&
    candidate["byDayAndModel"].every(isUsageDayModel)
  );
}

function isUsageCoverage(value: unknown): value is LocalUsageCacheCoverage {
  const candidate = asRecord(value);
  return Boolean(
    candidate &&
    typeof candidate["dailyStartDate"] === "string" &&
    typeof candidate["dailyEndDate"] === "string" &&
    candidate["dailyStartDate"] <= candidate["dailyEndDate"]
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
    isTokenTotals(candidate) &&
    Array.isArray(candidate["byModel"]) &&
    candidate["byModel"].every(isUsageModel)
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

function isUsageBucket(value: unknown): value is DashboardLocalUsageBucketViewModel {
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

function isUsageBucketModel(value: unknown): value is DashboardLocalUsageBucketModelViewModel {
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

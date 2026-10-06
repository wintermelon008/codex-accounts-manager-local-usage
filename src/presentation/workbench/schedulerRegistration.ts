import * as vscode from "vscode";
import { needsTokenRefresh } from "../../auth/oauth";
import { ensureFreshAccountTokens } from "../../auth/tokenRefreshCoordinator";
import type { CodexHotSwitchRuntime, HotSwitchIdentity, HotSwitchStatus } from "../../codex";
import {
  isAutomaticAccount,
  type CodexQuotaSummary,
  type CodexAccountRecord,
  type CodexTokens,
  type TokenRefreshErrorKind
} from "../../core/types";
import { ErrorCode, getErrorMessage, sanitizeApiErrorText } from "../../core/errors";
import { DASHBOARD_AUTOMATIC_REFRESH_PAGE_SIZE } from "../../domain/dashboard/types";
import { isQuotaCountdownWindowFresh } from "../../domain/dashboard/quotaCountdown";
import {
  getAutoRefreshMinutes,
  getCodexAccountsConfiguration,
  getSeamlessSwitchThreshold,
  isAutoStartQuotaCountdownEnabled,
  isBackgroundTokenRefreshEnabled,
  isSeamlessSwitchEnabled,
  isSeamlessSwitchLowQuotaEnabled
} from "../../infrastructure/config/extensionSettings";
import type { AccountsRepository, QuotaChangeListener } from "../../storage";
import { runWithConcurrencyLimit } from "../../utils/concurrency";
import { getTokenExpiryEpochSeconds } from "../../utils/jwt";
import { isRetriableHttpStatus, isRetriableNetworkError } from "../../utils/network";
import { shouldRunAccountScheduler } from "./refreshSignature";
import {
  startQuotaCountdownAfterRefreshForAccount,
  startQuotaCountdownForAccount,
  type QuotaCountdownStartResult
} from "../../application/accounts/quotaCountdown";
import {
  clearTokenAutomationError,
  configureTokenAutomation,
  hydrateTokenAutomationState,
  markTokenAutomationCheck,
  markTokenAutomationRefreshFailure,
  markTokenAutomationRefreshSuccess,
  markTokenAutomationSweepFinished,
  markTokenAutomationSweepStarted,
  setTokenAutomationNextSweep
} from "./tokenAutomationState";

const SCHEDULER_LEASE_MS = 2 * 60 * 1000;
export const SCHEDULER_LEASE_RENEW_INTERVAL_MS = Math.floor(SCHEDULER_LEASE_MS / 2);
const HOT_SWITCH_ENABLED = "hotSwitchEnabled";
const SEAMLESS_SWITCH_GROUP_A_VISIBLE = "seamlessSwitchGroupAVisible";
const SEAMLESS_SWITCH_GROUP_B_VISIBLE = "seamlessSwitchGroupBVisible";
const SEAMLESS_SWITCH_GROUP_C_VISIBLE = "seamlessSwitchGroupCVisible";

async function withSchedulerLease<T>(
  repo: AccountsRepository,
  name: string,
  task: (leaseIsActive: () => boolean) => Promise<T>
): Promise<T | undefined> {
  const lease = await repo.tryAcquireSchedulerLease(name, SCHEDULER_LEASE_MS);
  if (!lease) {
    return undefined;
  }

  let leaseLost = false;
  let renewalInFlight = false;
  const renewalTimer = setInterval(() => {
    if (renewalInFlight || leaseLost) {
      return;
    }

    renewalInFlight = true;
    void lease
      .renew(SCHEDULER_LEASE_MS)
      .then((renewed) => {
        leaseLost = !renewed;
        if (!renewed) {
          console.warn(`[codexAccounts] ${name} scheduler lease renewal was rejected`);
        }
      })
      .catch((error: unknown) => {
        leaseLost = true;
        console.warn(`[codexAccounts] ${name} scheduler lease renewal failed: ${getErrorMessage(error)}`);
      })
      .finally(() => {
        renewalInFlight = false;
      });
  }, SCHEDULER_LEASE_RENEW_INTERVAL_MS);

  try {
    return await task(() => !leaseLost);
  } finally {
    clearInterval(renewalTimer);
    await lease.release();
  }
}

// This monitor deliberately only consumes the runtime's bounded scalar status
// response. It never asks the runtime for thread IDs, conversation text, or
// history, so a one-minute quota refresh cannot turn into a growing cache.
export const SEAMLESS_USAGE_LIMIT_POLL_INTERVAL_MS = 2_000;
export const SEAMLESS_USAGE_LIMIT_RETRY_MS = 10_000;
export const SEAMLESS_USAGE_LIMIT_FAILURE_BACKOFF_MS = 30_000;

type SeamlessUsageLimitRuntime = Pick<CodexHotSwitchRuntime, "isEnabled" | "getStatus" | "getIdentity"> &
  Partial<Pick<CodexHotSwitchRuntime, "configureUsageLimitObservation" | "resetUsageLimitObservation">>;
export type SeamlessUsageLimitTrigger = "runtimeUsageLimit" | "runtimeUsageLimitExhaustion";
export type SeamlessUsageLimitMonitor = vscode.Disposable & {
  reset(): Promise<void>;
};

export function registerSeamlessUsageLimitMonitor(params: {
  context: vscode.ExtensionContext;
  runtime: SeamlessUsageLimitRuntime;
  onUsageLimitExceeded: (activeAccountId: string | undefined, trigger: SeamlessUsageLimitTrigger) => Promise<boolean>;
}): SeamlessUsageLimitMonitor {
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;
  let inFlight = false;
  let generation = 0;
  let observationGeneration = 0;
  let lastShimPid: number | undefined;
  let lastObservedUsageLimitFailures: number | undefined;
  let lastUsageLimitExhaustionBatchId: number | undefined;
  let retryPending = false;
  let nextAttemptAt = 0;
  let statusErrorReported = false;
  let lastUsageLimitObservationEnabled: boolean | undefined;

  const shouldObserveUsageLimits = (): boolean => {
    const config = getCodexAccountsConfiguration();
    return (
      params.runtime.isEnabled() &&
      config.get<boolean>(HOT_SWITCH_ENABLED, false) &&
      isSeamlessSwitchEnabled(config) &&
      isSeamlessSwitchLowQuotaEnabled(config)
    );
  };

  const synchronizeUsageLimitObservation = (enabled: boolean): void => {
    const wasConfigured = lastUsageLimitObservationEnabled !== undefined;
    if (lastUsageLimitObservationEnabled === enabled) {
      return;
    }
    lastUsageLimitObservationEnabled = enabled;
    // Preserve an enabled runtime's existing observation across extension-host
    // activation. Every explicit transition, and an initially disabled mode,
    // clears the shim-side journal/batch so old exhaustion cannot replay later.
    if (enabled && !wasConfigured) {
      return;
    }
    void params.runtime.configureUsageLimitObservation?.(enabled).catch(() => undefined);
  };

  const resetRuntimeObservation = (): void => {
    // A status/identity request may still be awaiting the runtime while an
    // explicit account switch resets the observation. Invalidate that
    // request's snapshot as well as the scalar retry state; otherwise its
    // response can recreate a stale exhaustion decision immediately after the
    // reset has completed.
    observationGeneration += 1;
    lastShimPid = undefined;
    lastObservedUsageLimitFailures = undefined;
    lastUsageLimitExhaustionBatchId = undefined;
    retryPending = false;
    nextAttemptAt = 0;
    statusErrorReported = false;
  };

  const pollRuntime = async (pollGeneration: number): Promise<void> => {
    if (disposed || inFlight || pollGeneration !== generation || Date.now() < nextAttemptAt) {
      return;
    }

    const pollObservationGeneration = observationGeneration;
    inFlight = true;
    try {
      const status = await params.runtime.getStatus();
      if (
        disposed ||
        pollGeneration !== generation ||
        pollObservationGeneration !== observationGeneration
      ) {
        return;
      }
      statusErrorReported = false;
      const exhaustionOnly = getSeamlessSwitchThreshold(getCodexAccountsConfiguration()) === 0;
      observeUsageLimitStatus(status, exhaustionOnly);
      const recoverableRecentUsageLimitedThreads =
        status.recoverableRecentUsageLimitedThreads ?? status.recentUsageLimitedThreads;
      const hasEligibleUsageSignal = exhaustionOnly
        ? status.usageLimitExhaustionReady
        : recoverableRecentUsageLimitedThreads > 0;
      if (!status.ready || !hasEligibleUsageSignal) {
        retryPending = false;
        return;
      }

      if (status.pendingSwitch || status.switching) {
        retryPending = true;
        nextAttemptAt = Date.now() + SEAMLESS_USAGE_LIMIT_RETRY_MS;
        return;
      }
      if (!retryPending || Date.now() < nextAttemptAt) {
        return;
      }

      // Identity is a fixed-size response too. Supplying it lets a remote
      // window converge its stopped conversation to a decision made elsewhere.
      const identity = await params.runtime.getIdentity().catch(() => undefined);
      if (
        disposed ||
        pollGeneration !== generation ||
        pollObservationGeneration !== observationGeneration
      ) {
        return;
      }
      const switched = await params.onUsageLimitExceeded(
        getManagedLocalAccountId(identity),
        exhaustionOnly ? "runtimeUsageLimitExhaustion" : "runtimeUsageLimit"
      );
      if (
        disposed ||
        pollGeneration !== generation ||
        pollObservationGeneration !== observationGeneration
      ) {
        return;
      }
      retryPending = !switched;
      nextAttemptAt = switched ? 0 : Date.now() + SEAMLESS_USAGE_LIMIT_RETRY_MS;
    } catch (error) {
      if (!statusErrorReported) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[codexAccounts] seamless usage-limit monitor is temporarily unavailable: ${message}`);
        statusErrorReported = true;
      }
      nextAttemptAt = Date.now() + SEAMLESS_USAGE_LIMIT_FAILURE_BACKOFF_MS;
    } finally {
      inFlight = false;
    }
  };

  const observeUsageLimitStatus = (status: HotSwitchStatus, exhaustionOnly: boolean): void => {
    const runtimeChanged = lastShimPid === undefined || lastShimPid !== status.shimPid;
    const failuresIncreased =
      !runtimeChanged &&
      lastObservedUsageLimitFailures !== undefined &&
      status.observedUsageLimitFailures > lastObservedUsageLimitFailures;
    const failuresReset =
      !runtimeChanged &&
      lastObservedUsageLimitFailures !== undefined &&
      status.observedUsageLimitFailures < lastObservedUsageLimitFailures;

    const exhaustionBatchChanged =
      !runtimeChanged &&
      lastUsageLimitExhaustionBatchId !== undefined &&
      status.usageLimitExhaustionBatchId !== lastUsageLimitExhaustionBatchId;

    if (runtimeChanged || (exhaustionOnly ? exhaustionBatchChanged : failuresIncreased || failuresReset)) {
      retryPending =
        exhaustionOnly
          ? status.usageLimitExhaustionReady
          : (status.recoverableRecentUsageLimitedThreads ?? status.recentUsageLimitedThreads) > 0;
      nextAttemptAt = 0;
    }
    lastShimPid = status.shimPid;
    lastObservedUsageLimitFailures = status.observedUsageLimitFailures;
    lastUsageLimitExhaustionBatchId = status.usageLimitExhaustionBatchId;
  };

  const applySchedule = (): void => {
    generation += 1;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    resetRuntimeObservation();
    const usageLimitObservationEnabled = shouldObserveUsageLimits();
    synchronizeUsageLimitObservation(usageLimitObservationEnabled);
    if (!usageLimitObservationEnabled) {
      return;
    }

    const pollGeneration = generation;
    timer = setInterval(() => {
      void pollRuntime(pollGeneration);
    }, SEAMLESS_USAGE_LIMIT_POLL_INTERVAL_MS);
    void pollRuntime(pollGeneration);
  };

  applySchedule();
  const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration("codexAccounts.hotSwitchEnabled") ||
      event.affectsConfiguration("codexAccounts.seamlessSwitchEnabled") ||
      event.affectsConfiguration("codexAccounts.seamlessSwitchQuotaBandsEnabled") ||
      event.affectsConfiguration("codexAccounts.seamlessSwitchLowQuotaEnabled") ||
      event.affectsConfiguration("codexAccounts.seamlessSwitchThreshold") ||
      event.affectsConfiguration("codexAccounts.seamlessSwitchGroupAVisible") ||
      event.affectsConfiguration("codexAccounts.seamlessSwitchGroupBVisible") ||
      event.affectsConfiguration("codexAccounts.seamlessSwitchGroupCVisible")
    ) {
      applySchedule();
    }
  });
  params.context.subscriptions.push(configDisposable);

  return {
    async reset(): Promise<void> {
      resetRuntimeObservation();
      await params.runtime.resetUsageLimitObservation?.();
    },
    dispose(): void {
      disposed = true;
      generation += 1;
      configDisposable.dispose();
      if (timer) {
        clearInterval(timer);
      }
      resetRuntimeObservation();
    }
  };
}

function getManagedLocalAccountId(
  identity: Pick<HotSwitchIdentity, "managedLocalAccountId"> | undefined
): string | undefined {
  return identity?.managedLocalAccountId ?? undefined;
}

export function registerAutoRefreshScheduler(params: {
  context: vscode.ExtensionContext;
  repo: AccountsRepository;
  onRefresh: () => void;
}): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;

  const applySchedule = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }

    const minutes = getAutoRefreshMinutes();
    if (!minutes || minutes <= 0) {
      return;
    }

    const runAutoRefresh = async (): Promise<void> => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        const accounts = await params.repo.listAccounts();
        const configuration = getCodexAccountsConfiguration();
        const autoStartEnabled = isAutoStartQuotaCountdownEnabled();
        const automaticAccountIds = autoStartEnabled
          ? getAutomaticQuotaCountdownAccountIds(accounts)
          : getAutomaticQuotaRefreshAccountIds(accounts, configuration);
        const accountIds = automaticAccountIds;
        if (!shouldRunAccountScheduler(accountIds.length)) {
          return;
        }

        await withSchedulerLease(params.repo, "quota-refresh", async (leaseIsActive) => {
          if (!leaseIsActive()) {
            return;
          }
          await vscode.commands.executeCommand("codexAccounts.refreshAllQuotas", {
            silent: true,
            forceRefresh: true,
            accountIds
          });
          if (!leaseIsActive()) {
            console.warn("[codexAccounts] quota refresh completed after losing its shared lease");
          }
        });
      } finally {
        inFlight = false;
      }
    };

    timer = setInterval(
      () => {
        void runAutoRefresh();
      },
      minutes * 60 * 1000
    );
  };

  applySchedule();

  const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration("codexAccounts.autoRefreshMinutes") ||
      event.affectsConfiguration("codexAccounts.seamlessSwitchGroupAVisible") ||
      event.affectsConfiguration("codexAccounts.seamlessSwitchGroupBVisible") ||
      event.affectsConfiguration("codexAccounts.seamlessSwitchGroupCVisible")
    ) {
      applySchedule();
    }
  });

  params.context.subscriptions.push(configDisposable);
  return {
    dispose(): void {
      configDisposable.dispose();
      if (timer) {
        clearInterval(timer);
      }
    }
  };
}

export const QUOTA_COUNTDOWN_REFRESH_POLL_INTERVAL_MS = 60_000;

export type ExpiredQuotaCountdownRefreshTarget = {
  accountId: string;
  hourlyResetTime?: number;
  weeklyResetTime?: number;
};

/**
 * Accounts outside the regular visible-page refresh schedule are handled by
 * default. When automatic countdown start is enabled, the caller can include
 * visible accounts too so every eligible account is considered.
 */
export function getExpiredQuotaCountdownRefreshTargets(
  accounts: readonly CodexAccountRecord[],
  nowMs: number = Date.now(),
  options: { includeVisibleAccounts?: boolean } = {}
): ExpiredQuotaCountdownRefreshTarget[] {
  const nowSeconds = Math.floor(nowMs / 1000);
  return accounts.flatMap((account) => {
    if (!isQuotaCountdownRefreshable(account, options.includeVisibleAccounts === true)) {
      return [];
    }

    const quota = account.quotaSummary;
    const hourlyResetTime = getExpiredResetTime(quota?.hourlyWindowPresent, quota?.hourlyResetTime, nowSeconds);
    const weeklyResetTime = getExpiredResetTime(quota?.weeklyWindowPresent, quota?.weeklyResetTime, nowSeconds);
    if (hourlyResetTime === undefined && weeklyResetTime === undefined) {
      return [];
    }

    return [{ accountId: account.id, hourlyResetTime, weeklyResetTime }];
  });
}

const QUOTA_COUNTDOWN_RETRY_DELAY_MS = 60_000;
const QUOTA_COUNTDOWN_LEASE_RETRY_DELAY_MS = 1_000;
const QUOTA_COUNTDOWN_GLOBAL_STATE_KEY = "codexAccounts.quotaCountdownAutomationState";
const QUOTA_COUNTDOWN_STATE_VERSION = 2;
const MAX_TIMER_DELAY_MS = 2_000_000_000;

type QuotaCountdownAccountState = {
  nextCheckAt?: number;
  observedUpdatedAt?: number;
  observedLastQuotaAt?: number;
  pendingStart?: boolean;
  manualResetPending?: boolean;
  startAfterRefresh?: boolean;
  pendingHourlyResetTime?: number;
  pendingWeeklyResetTime?: number;
  handledHourlyResetTime?: number;
  handledWeeklyResetTime?: number;
};

type PersistedQuotaCountdownState = {
  version: 2;
  scanValid: boolean;
  accountIds: string[];
  accounts: Record<string, QuotaCountdownAccountState>;
};

type QuotaCountdownQueueEntry = {
  accountId: string;
  dueAt: number;
  version: number;
};

class QuotaCountdownMinHeap {
  private readonly entries: QuotaCountdownQueueEntry[] = [];

  clear(): void {
    this.entries.length = 0;
  }

  peek(): QuotaCountdownQueueEntry | undefined {
    return this.entries[0];
  }

  push(entry: QuotaCountdownQueueEntry): void {
    this.entries.push(entry);
    this.bubbleUp(this.entries.length - 1);
  }

  pop(): QuotaCountdownQueueEntry | undefined {
    const first = this.entries[0];
    if (!first) {
      return undefined;
    }
    const last = this.entries.pop();
    if (last && this.entries.length > 0) {
      this.entries[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.entries[parent]!, this.entries[index]!) <= 0) {
        return;
      }
      [this.entries[parent], this.entries[index]] = [this.entries[index]!, this.entries[parent]!];
      index = parent;
    }
  }

  private bubbleDown(index: number): void {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.entries.length && this.compare(this.entries[left]!, this.entries[smallest]!) < 0) {
        smallest = left;
      }
      if (right < this.entries.length && this.compare(this.entries[right]!, this.entries[smallest]!) < 0) {
        smallest = right;
      }
      if (smallest === index) {
        return;
      }
      [this.entries[index], this.entries[smallest]] = [this.entries[smallest]!, this.entries[index]!];
      index = smallest;
    }
  }

  private compare(left: QuotaCountdownQueueEntry, right: QuotaCountdownQueueEntry): number {
    return left.dueAt - right.dueAt || left.accountId.localeCompare(right.accountId);
  }
}

function createEmptyQuotaCountdownState(): PersistedQuotaCountdownState {
  return {
    version: QUOTA_COUNTDOWN_STATE_VERSION,
    scanValid: false,
    accountIds: [],
    accounts: {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPersistedQuotaCountdownState(context?: vscode.ExtensionContext): PersistedQuotaCountdownState {
  const raw = context?.globalState?.get<unknown>(QUOTA_COUNTDOWN_GLOBAL_STATE_KEY);
  if (!isRecord(raw) || raw["version"] !== QUOTA_COUNTDOWN_STATE_VERSION || !isRecord(raw["accounts"])) {
    return createEmptyQuotaCountdownState();
  }

  const accounts: Record<string, QuotaCountdownAccountState> = {};
  Object.entries(raw["accounts"]).forEach(([accountId, value]) => {
    if (!isRecord(value)) {
      return;
    }
    accounts[accountId] = {
      nextCheckAt: readFiniteNumber(value["nextCheckAt"]),
      observedUpdatedAt: readFiniteNumber(value["observedUpdatedAt"]),
      observedLastQuotaAt: readFiniteNumber(value["observedLastQuotaAt"]),
      pendingStart: value["pendingStart"] === true,
      manualResetPending: value["manualResetPending"] === true,
      startAfterRefresh: value["startAfterRefresh"] === true,
      pendingHourlyResetTime: readFiniteNumber(value["pendingHourlyResetTime"]),
      pendingWeeklyResetTime: readFiniteNumber(value["pendingWeeklyResetTime"]),
      handledHourlyResetTime: readFiniteNumber(value["handledHourlyResetTime"]),
      handledWeeklyResetTime: readFiniteNumber(value["handledWeeklyResetTime"])
    };
  });

  return {
    version: QUOTA_COUNTDOWN_STATE_VERSION,
    scanValid: raw["scanValid"] === true,
    accountIds: Array.isArray(raw["accountIds"])
      ? [...new Set(raw["accountIds"].filter((value): value is string => typeof value === "string"))].sort()
      : [],
    accounts
  };
}

function cloneQuotaCountdownState(state: PersistedQuotaCountdownState): PersistedQuotaCountdownState {
  return {
    version: state.version,
    scanValid: state.scanValid,
    accountIds: [...state.accountIds],
    accounts: Object.fromEntries(Object.entries(state.accounts).map(([id, value]) => [id, { ...value }]))
  };
}

/**
 * Enabled mode is event-driven. The only timer is for the earliest persisted
 * reset boundary; stale heap entries are discarded by their version number.
 * Disabled mode retains the old hidden-account refresh behavior.
 */
class QuotaCountdownAutomationController {
  private readonly queue = new QuotaCountdownMinHeap();
  private readonly queueVersions = new Map<string, number>();
  private readonly startingAccounts = new Set<string>();
  private readonly handledWindows = new Map<string, ExpiredQuotaCountdownRefreshTarget>();
  private state: PersistedQuotaCountdownState;
  private timer: NodeJS.Timeout | undefined;
  private legacyTimer: NodeJS.Timeout | undefined;
  private legacyInFlight = false;
  private processingDue = false;
  private disposed = false;
  private mode: boolean | undefined;
  private generation = 0;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly configurationDisposable: vscode.Disposable;
  private readonly accountChangeDisposable: vscode.Disposable | undefined;
  private readonly quotaChangeDisposable: vscode.Disposable | undefined;
  private readonly startQuotaCountdown: (accountId: string) => Promise<QuotaCountdownStartResult>;
  private readonly startQuotaCountdownAfterRefresh: (accountId: string) => Promise<QuotaCountdownStartResult>;

  constructor(private readonly params: {
    context?: vscode.ExtensionContext;
    repo: AccountsRepository;
    onRefresh: () => void;
    startQuotaCountdown?: (accountId: string) => Promise<QuotaCountdownStartResult>;
    startQuotaCountdownAfterRefresh?: (accountId: string) => Promise<QuotaCountdownStartResult>;
  }) {
    this.state = readPersistedQuotaCountdownState(params.context);
    this.startQuotaCountdown = params.startQuotaCountdown ?? ((accountId) =>
      startQuotaCountdownForAccount(params.repo, accountId));
    this.startQuotaCountdownAfterRefresh = params.startQuotaCountdownAfterRefresh ?? ((accountId) =>
      startQuotaCountdownAfterRefreshForAccount(params.repo, accountId));
    this.configurationDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexAccounts.autoStartQuotaCountdownEnabled")) {
        void this.applyMode();
      }
    }) ?? { dispose: () => undefined };
    this.accountChangeDisposable = params.repo.onDidChangeAccounts?.(() => {
      if (this.mode === true) {
        this.invalidateAndRescan();
      }
    });
    this.quotaChangeDisposable = params.repo.onDidUpdateQuota?.((event) => {
      this.handleQuotaChange(event);
    });
  }

  start(): void {
    void this.applyMode();
  }

  requestManualReset(accountId: string): void {
    if (this.disposed) {
      return;
    }
    void this.enqueueManualReset(accountId);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.configurationDisposable.dispose();
    this.accountChangeDisposable?.dispose();
    this.quotaChangeDisposable?.dispose();
    this.stopTimer();
    this.stopLegacyTimer();
    this.queue.clear();
    this.queueVersions.clear();
    this.handledWindows.clear();
  }

  private async applyMode(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const enabled = isAutoStartQuotaCountdownEnabled();
    if (this.mode === enabled) {
      return;
    }

    this.mode = enabled;
    this.generation += 1;
    const generation = this.generation;
    this.stopTimer();
    this.queue.clear();
    this.queueVersions.clear();
    if (!enabled) {
      this.resetPersistentState();
      this.startLegacyTimer();
      await this.runLegacyRefresh();
      return;
    }

    this.stopLegacyTimer();
    await this.initializeEnabled(generation);
  }

  private async initializeEnabled(generation: number): Promise<void> {
    const accounts = await this.params.repo.listAccounts();
    if (this.disposed || this.mode !== true || generation !== this.generation) {
      return;
    }

    const accountIds = accounts.map((account) => account.id).sort();
    const stateIsValid = this.state.scanValid && sameStringArray(this.state.accountIds, accountIds);

    if (stateIsValid) {
      let stateChanged = false;
      accounts.forEach((account) => {
        const accountState = this.ensureAccountState(account.id);
        if (
          accountState.observedUpdatedAt !== account.updatedAt ||
          accountState.observedLastQuotaAt !== account.lastQuotaAt
        ) {
          this.reconcileAccountSnapshot(account, accountState, true);
          stateChanged = true;
        }
      });
      this.rebuildQueueFromState();
      if (stateChanged) {
        this.persistState();
      }
      this.scheduleTimer();
      void this.processDueAccounts();
      return;
    }

    const now = Date.now();
    const nextAccounts: Record<string, QuotaCountdownAccountState> = {};
    accounts.forEach((account) => {
      const accountState: QuotaCountdownAccountState = {
        manualResetPending: this.state.accounts[account.id]?.manualResetPending,
        handledHourlyResetTime: this.state.accounts[account.id]?.handledHourlyResetTime,
        handledWeeklyResetTime: this.state.accounts[account.id]?.handledWeeklyResetTime
      };
      this.reconcileAccountSnapshot(account, accountState, false, now);
      nextAccounts[account.id] = accountState;
    });

    this.state = {
      version: QUOTA_COUNTDOWN_STATE_VERSION,
      scanValid: true,
      accountIds,
      accounts: nextAccounts
    };
    this.rebuildQueueFromState();
    this.persistState();
    this.scheduleTimer();
    void this.processDueAccounts();
  }

  private reconcileAccountSnapshot(
    account: CodexAccountRecord,
    accountState: QuotaCountdownAccountState,
    preservePending: boolean,
    now = Date.now()
  ): void {
    accountState.observedUpdatedAt = account.updatedAt;
    accountState.observedLastQuotaAt = account.lastQuotaAt;
    if (!preservePending) {
      accountState.pendingStart = accountState.manualResetPending === true;
      accountState.startAfterRefresh = false;
      accountState.pendingHourlyResetTime = undefined;
      accountState.pendingWeeklyResetTime = undefined;
    }
    if (!isQuotaCountdownRefreshable(account, true)) {
      accountState.pendingStart = false;
      accountState.manualResetPending = false;
      accountState.startAfterRefresh = false;
      accountState.nextCheckAt = undefined;
      this.cancelQueuedAccount(account.id);
      return;
    }

    const expiredTarget = getExpiredQuotaCountdownRefreshTargets([account], now, {
      includeVisibleAccounts: true
    })[0];
    const freshTarget = getFreshQuotaCountdownStartTarget(account, now);
    const target = mergeQuotaCountdownTargets(account.id, expiredTarget, freshTarget);
    if (!accountState.pendingStart && target && hasUnhandledTarget(target, accountState, now)) {
      markPendingTarget(accountState, target, false);
      return;
    }
    if (!accountState.pendingStart) {
      accountState.nextCheckAt = getNextQuotaCheckAt(account.quotaSummary, now);
    }
  }

  private handleQuotaChange(event: Parameters<QuotaChangeListener>[0]): void {
    if (this.disposed || this.mode !== true || this.startingAccounts.has(event.accountId)) {
      return;
    }
    void this.reconcileQuotaChange(event);
  }

  private async reconcileQuotaChange(event: Parameters<QuotaChangeListener>[0]): Promise<void> {
    const account = await this.params.repo.getAccount(event.accountId);
    if (!account || this.disposed || this.mode !== true) {
      return;
    }

    const scanWasValid = this.state.scanValid;
    const accountState = this.ensureAccountState(account.id);
    if (accountState.manualResetPending) {
      accountState.pendingStart = true;
    }
    const now = Date.now();
    const previousTarget = getExpiredTargetFromQuota(account.id, event.previousQuota, now);
    const freshTarget = getFreshQuotaCountdownStartTarget(account, now);
    const refreshedTarget = mergeQuotaCountdownTargets(account.id, previousTarget, freshTarget);
    if (event.refreshed && refreshedTarget && hasUnhandledTarget(refreshedTarget, accountState, now)) {
      markPendingTarget(accountState, refreshedTarget, true);
    } else if (!accountState.pendingStart) {
      accountState.nextCheckAt = getNextQuotaCheckAt(event.nextQuota ?? account.quotaSummary, now);
      this.cancelQueuedAccount(account.id);
    }

    if (event.failed && previousTarget && hasUnhandledTarget(previousTarget, accountState, now)) {
      markPendingTarget(accountState, previousTarget, false);
      accountState.nextCheckAt = now + QUOTA_COUNTDOWN_RETRY_DELAY_MS;
    }

    this.state.accountIds = [...new Set([...this.state.accountIds, account.id])].sort();
    accountState.observedUpdatedAt = account.updatedAt;
    accountState.observedLastQuotaAt = account.lastQuotaAt;
    this.enqueueState(account.id, accountState);
    this.state.scanValid = scanWasValid;
    this.persistState();
    this.scheduleTimer();
    void this.processDueAccounts();
  }

  private async enqueueManualReset(accountId: string): Promise<void> {
    if (this.mode === undefined) {
      await this.applyMode();
    }
    if (this.disposed || this.mode !== true) {
      return;
    }

    const account = await this.params.repo.getAccount(accountId);
    if (!account || this.disposed || this.mode !== true || !isQuotaCountdownRefreshable(account, true)) {
      return;
    }

    const accountState = this.ensureAccountState(accountId);
    accountState.manualResetPending = true;
    accountState.pendingStart = true;
    accountState.startAfterRefresh = false;
    accountState.pendingHourlyResetTime = undefined;
    accountState.pendingWeeklyResetTime = undefined;
    accountState.nextCheckAt = Date.now();
    accountState.observedUpdatedAt = account.updatedAt;
    accountState.observedLastQuotaAt = account.lastQuotaAt;
    this.state.accountIds = [...new Set([...this.state.accountIds, accountId])].sort();
    this.enqueueState(accountId, accountState);
    this.persistState();
    this.scheduleTimer();
    void this.processDueAccounts();
  }

  private invalidateAndRescan(): void {
    if (this.disposed || this.mode !== true) {
      return;
    }
    this.state.scanValid = false;
    this.persistState();
    const generation = ++this.generation;
    this.stopTimer();
    this.queue.clear();
    this.queueVersions.clear();
    void this.initializeEnabled(generation);
  }

  private async processDueAccounts(): Promise<void> {
    if (this.disposed || this.mode !== true || this.processingDue) {
      return;
    }
    this.processingDue = true;
    try {
      const dueAccountIds = this.takeDueAccountIds(Date.now());
      if (dueAccountIds.length === 0) {
        this.scheduleTimer();
        return;
      }

      let leaseAcquired = false;
      const processedAccountIds = new Set<string>();
      await withSchedulerLease(this.params.repo, "quota-refresh", async (leaseIsActive) => {
        leaseAcquired = true;
        for (const accountId of dueAccountIds) {
          if (!leaseIsActive()) {
            break;
          }
          await this.processDueAccount(accountId);
          processedAccountIds.add(accountId);
        }
      });
      if (!leaseAcquired || processedAccountIds.size !== dueAccountIds.length) {
        dueAccountIds.filter((accountId) => !processedAccountIds.has(accountId)).forEach((accountId) => {
          const accountState = this.state.accounts[accountId];
          if (accountState) {
            accountState.nextCheckAt = Date.now() + QUOTA_COUNTDOWN_LEASE_RETRY_DELAY_MS;
            this.enqueueState(accountId, accountState);
          }
        });
        this.persistState();
      }
    } catch (error) {
      console.warn(`[codexAccounts] quota countdown queue processing failed: ${getErrorMessage(error)}`);
    } finally {
      this.processingDue = false;
      this.scheduleTimer();
    }
  }

  private async processDueAccount(accountId: string): Promise<void> {
    const accountState = this.state.accounts[accountId];
    if (!accountState) {
      return;
    }
    const account = await this.params.repo.getAccount(accountId);
    if (!account) {
      delete this.state.accounts[accountId];
      this.state.accountIds = this.state.accountIds.filter((id) => id !== accountId);
      this.cancelQueuedAccount(accountId);
      this.persistState();
      return;
    }

    const now = Date.now();
    if (accountState.manualResetPending) {
      accountState.pendingStart = true;
    }
    if (!accountState.pendingStart) {
      const expiredTarget = getExpiredQuotaCountdownRefreshTargets([account], now, {
        includeVisibleAccounts: true
      })[0];
      const freshTarget = getFreshQuotaCountdownStartTarget(account, now);
      const target = mergeQuotaCountdownTargets(account.id, expiredTarget, freshTarget);
      if (!target || !hasUnhandledTarget(target, accountState, now)) {
        accountState.nextCheckAt = getNextQuotaCheckAt(account.quotaSummary, now);
        this.cancelQueuedAccount(accountId);
        this.persistState();
        return;
      }
      markPendingTarget(accountState, target, false);
    }

    this.startingAccounts.add(accountId);
    try {
      const result = accountState.startAfterRefresh
        ? await this.startQuotaCountdownAfterRefresh(accountId)
        : await this.startQuotaCountdown(accountId);
      const latest = await this.params.repo.getAccount(accountId);
      const latestState = this.state.accounts[accountId];
      if (!latestState) {
        return;
      }
      const latestFreshTarget = latest ? getFreshQuotaCountdownStartTarget(latest, Date.now()) : undefined;
      if (latestState.manualResetPending && result === "already-started" && !latestFreshTarget) {
        latestState.pendingStart = true;
        latestState.startAfterRefresh = false;
        latestState.nextCheckAt = Date.now() + QUOTA_COUNTDOWN_RETRY_DELAY_MS;
        this.enqueueState(accountId, latestState);
        this.persistState();
        return;
      }
      latestState.pendingStart = false;
      latestState.manualResetPending = false;
      latestState.startAfterRefresh = false;
      if (latestState.pendingHourlyResetTime !== undefined) {
        latestState.handledHourlyResetTime = latestState.pendingHourlyResetTime;
      }
      if (latestState.pendingWeeklyResetTime !== undefined) {
        latestState.handledWeeklyResetTime = latestState.pendingWeeklyResetTime;
      }
      latestState.pendingHourlyResetTime = undefined;
      latestState.pendingWeeklyResetTime = undefined;
      latestState.observedUpdatedAt = latest?.updatedAt;
      latestState.observedLastQuotaAt = latest?.lastQuotaAt;
      if (latestFreshTarget?.hourlyResetTime !== undefined) {
        latestState.handledHourlyResetTime = latestFreshTarget.hourlyResetTime;
      }
      if (latestFreshTarget?.weeklyResetTime !== undefined) {
        latestState.handledWeeklyResetTime = latestFreshTarget.weeklyResetTime;
      }
      latestState.nextCheckAt = latest ? getNextQuotaCheckAt(latest.quotaSummary, Date.now()) : undefined;
      this.enqueueState(accountId, latestState);
      this.persistState();
      if (result === "started" || result === "already-started") {
        this.params.onRefresh();
      }
    } catch (error) {
      accountState.pendingStart = true;
      accountState.nextCheckAt = Date.now() + QUOTA_COUNTDOWN_RETRY_DELAY_MS;
      this.enqueueState(accountId, accountState);
      this.persistState();
      console.warn(
        `[codexAccounts] automatic quota countdown start failed for ${accountId}: ${getErrorMessage(error)}`
      );
    } finally {
      this.startingAccounts.delete(accountId);
    }
  }

  private takeDueAccountIds(now: number): string[] {
    const accountIds = new Set<string>();
    for (;;) {
      const entry = this.queue.peek();
      if (!entry || entry.dueAt > now) {
        break;
      }
      this.queue.pop();
      if (this.queueVersions.get(entry.accountId) !== entry.version) {
        continue;
      }
      accountIds.add(entry.accountId);
    }
    return [...accountIds];
  }

  private rebuildQueueFromState(): void {
    this.queue.clear();
    this.queueVersions.clear();
    Object.entries(this.state.accounts).forEach(([accountId, accountState]) => {
      this.enqueueState(accountId, accountState);
    });
  }

  private enqueueState(accountId: string, accountState: QuotaCountdownAccountState): void {
    const dueAt = accountState.pendingStart ? accountState.nextCheckAt ?? Date.now() : accountState.nextCheckAt;
    const version = (this.queueVersions.get(accountId) ?? 0) + 1;
    this.queueVersions.set(accountId, version);
    if (dueAt !== undefined && Number.isFinite(dueAt)) {
      this.queue.push({ accountId, dueAt, version });
    }
  }

  private cancelQueuedAccount(accountId: string): void {
    this.queueVersions.set(accountId, (this.queueVersions.get(accountId) ?? 0) + 1);
  }

  private ensureAccountState(accountId: string): QuotaCountdownAccountState {
    this.state.accounts[accountId] ??= {};
    return this.state.accounts[accountId];
  }

  private resetPersistentState(): void {
    this.state = createEmptyQuotaCountdownState();
    this.handledWindows.clear();
    this.queue.clear();
    this.queueVersions.clear();
    this.persistState();
  }

  private persistState(): void {
    const globalState = this.params.context?.globalState;
    if (!globalState) {
      return;
    }
    const snapshot = cloneQuotaCountdownState(this.state);
    this.persistChain = this.persistChain
      .then(() => globalState.update(QUOTA_COUNTDOWN_GLOBAL_STATE_KEY, snapshot))
      .catch((error) => {
        console.warn(`[codexAccounts] failed to persist quota countdown state: ${getErrorMessage(error)}`);
      });
  }

  private scheduleTimer(): void {
    this.stopTimer();
    if (this.mode !== true || this.disposed) {
      return;
    }
    const entry = this.queue.peek();
    if (!entry) {
      return;
    }
    const delay = Math.min(Math.max(0, entry.dueAt - Date.now()), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.processDueAccounts();
    }, delay);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private startLegacyTimer(): void {
    if (this.legacyTimer) {
      return;
    }
    this.legacyTimer = setInterval(() => {
      void this.runLegacyRefresh();
    }, QUOTA_COUNTDOWN_REFRESH_POLL_INTERVAL_MS);
  }

  private stopLegacyTimer(): void {
    if (this.legacyTimer) {
      clearInterval(this.legacyTimer);
      this.legacyTimer = undefined;
    }
  }

  private async runLegacyRefresh(): Promise<void> {
    if (this.disposed || this.mode !== false || this.legacyInFlight) {
      return;
    }
    this.legacyInFlight = true;
    try {
      const accounts = await this.params.repo.listAccounts();
      this.pruneLegacyHandledWindows(accounts);
      const pending = getExpiredQuotaCountdownRefreshTargets(accounts).filter((target) =>
        this.hasUnhandledLegacyTarget(target)
      );
      if (pending.length === 0) {
        return;
      }
      const refreshed = await withSchedulerLease(this.params.repo, "quota-refresh", async (leaseIsActive) => {
        if (!leaseIsActive()) {
          return false;
        }
        this.params.repo.invalidateExternalStateCaches({ invalidateTokens: false });
        const currentAccounts = await this.params.repo.listAccounts();
        this.pruneLegacyHandledWindows(currentAccounts);
        const currentPending = getExpiredQuotaCountdownRefreshTargets(currentAccounts).filter((target) =>
          this.hasUnhandledLegacyTarget(target)
        );
        if (currentPending.length === 0 || !leaseIsActive()) {
          return false;
        }
        await vscode.commands.executeCommand("codexAccounts.refreshAllQuotas", {
          silent: true,
          forceRefresh: true,
          accountIds: currentPending.map((target) => target.accountId)
        });
        currentPending.forEach((target) => {
          this.handledWindows.set(target.accountId, target);
        });
        return true;
      });
      if (refreshed) {
        this.params.onRefresh();
      }
    } catch (error) {
      console.warn(`[codexAccounts] expired quota countdown refresh failed: ${getErrorMessage(error)}`);
    } finally {
      this.legacyInFlight = false;
    }
  }

  private pruneLegacyHandledWindows(accounts: readonly CodexAccountRecord[]): void {
    const accountIds = new Set(accounts.map((account) => account.id));
    this.handledWindows.forEach((_target, accountId) => {
      if (!accountIds.has(accountId)) {
        this.handledWindows.delete(accountId);
      }
    });
  }

  private hasUnhandledLegacyTarget(target: ExpiredQuotaCountdownRefreshTarget): boolean {
    const handled = this.handledWindows.get(target.accountId);
    return (
      (target.hourlyResetTime !== undefined && target.hourlyResetTime !== handled?.hourlyResetTime) ||
      (target.weeklyResetTime !== undefined && target.weeklyResetTime !== handled?.weeklyResetTime)
    );
  }
}

export type QuotaCountdownRefreshScheduler = vscode.Disposable & {
  requestManualReset(accountId: string): void;
};

export function registerQuotaCountdownRefreshScheduler(params: {
  context?: vscode.ExtensionContext;
  repo: AccountsRepository;
  onRefresh: () => void;
  startQuotaCountdown?: (accountId: string) => Promise<QuotaCountdownStartResult>;
  startQuotaCountdownAfterRefresh?: (accountId: string) => Promise<QuotaCountdownStartResult>;
}): QuotaCountdownRefreshScheduler {
  const controller = new QuotaCountdownAutomationController(params);
  controller.start();
  return {
    requestManualReset: (accountId: string): void => controller.requestManualReset(accountId),
    dispose: (): void => controller.dispose()
  };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function getExpiredTargetFromQuota(
  accountId: string,
  quota: CodexQuotaSummary | undefined,
  nowMs: number
): ExpiredQuotaCountdownRefreshTarget | undefined {
  if (!quota) {
    return undefined;
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  const hourlyResetTime = getExpiredResetTime(quota.hourlyWindowPresent, quota.hourlyResetTime, nowSeconds);
  const weeklyResetTime = getExpiredResetTime(quota.weeklyWindowPresent, quota.weeklyResetTime, nowSeconds);
  if (hourlyResetTime === undefined && weeklyResetTime === undefined) {
    return undefined;
  }
  return { accountId, hourlyResetTime, weeklyResetTime };
}

function getFreshQuotaCountdownStartTarget(
  account: CodexAccountRecord,
  nowMs: number
): ExpiredQuotaCountdownRefreshTarget | undefined {
  if (!isQuotaCountdownRefreshable(account, true) || !account.quotaSummary) {
    return undefined;
  }

  const quota = account.quotaSummary;
  const hourlyResetTime = getFreshQuotaCountdownResetTime(
    "hourly",
    quota.hourlyPercentage,
    quota.hourlyWindowPresent,
    quota.hourlyResetTime,
    quota.hourlyWindowMinutes,
    nowMs
  );
  const weeklyResetTime = getFreshQuotaCountdownResetTime(
    "weekly",
    quota.weeklyPercentage,
    quota.weeklyWindowPresent,
    quota.weeklyResetTime,
    quota.weeklyWindowMinutes,
    nowMs
  );
  if (hourlyResetTime === undefined && weeklyResetTime === undefined) {
    return undefined;
  }
  return { accountId: account.id, hourlyResetTime, weeklyResetTime };
}

function getFreshQuotaCountdownResetTime(
  window: "hourly" | "weekly",
  percentage: number,
  windowPresent: boolean | undefined,
  resetTime: number | undefined,
  windowMinutes: number | undefined,
  nowMs: number
): number | undefined {
  if (
    windowPresent !== true ||
    !Number.isFinite(percentage) ||
    percentage < 100 ||
    !isQuotaCountdownWindowFresh(window, resetTime, nowMs, windowMinutes)
  ) {
    return undefined;
  }
  return resetTime;
}

function mergeQuotaCountdownTargets(
  accountId: string,
  ...targets: readonly (ExpiredQuotaCountdownRefreshTarget | undefined)[]
): ExpiredQuotaCountdownRefreshTarget | undefined {
  const hourlyResetTime = targets.find((target) => target?.hourlyResetTime !== undefined)?.hourlyResetTime;
  const weeklyResetTime = targets.find((target) => target?.weeklyResetTime !== undefined)?.weeklyResetTime;
  if (hourlyResetTime === undefined && weeklyResetTime === undefined) {
    return undefined;
  }
  return { accountId, hourlyResetTime, weeklyResetTime };
}

function hasUnhandledTarget(
  target: ExpiredQuotaCountdownRefreshTarget,
  accountState: QuotaCountdownAccountState,
  nowMs: number
): boolean {
  return (
    isUnhandledResetTime(target.hourlyResetTime, accountState.handledHourlyResetTime, nowMs) ||
    isUnhandledResetTime(target.weeklyResetTime, accountState.handledWeeklyResetTime, nowMs)
  );
}

function isUnhandledResetTime(target: number | undefined, handled: number | undefined, nowMs: number): boolean {
  if (target === undefined || handled === undefined) {
    return target !== undefined;
  }
  if (target !== handled) {
    return target > handled;
  }
  return target <= Math.floor(nowMs / 1000);
}

function markPendingTarget(
  accountState: QuotaCountdownAccountState,
  target: ExpiredQuotaCountdownRefreshTarget,
  startAfterRefresh: boolean
): void {
  accountState.pendingStart = true;
  accountState.startAfterRefresh = startAfterRefresh;
  accountState.pendingHourlyResetTime = target.hourlyResetTime;
  accountState.pendingWeeklyResetTime = target.weeklyResetTime;
  accountState.nextCheckAt = Date.now();
}

function getNextQuotaCheckAt(quota: CodexQuotaSummary | undefined, nowMs: number): number | undefined {
  if (!quota) {
    return undefined;
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  const resetTimes = [
    quota.hourlyWindowPresent === true ? quota.hourlyResetTime : undefined,
    quota.weeklyWindowPresent === true ? quota.weeklyResetTime : undefined
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > nowSeconds);
  if (resetTimes.length === 0) {
    return undefined;
  }
  return Math.min(...resetTimes) * 1000;
}

function isQuotaCountdownRefreshable(account: CodexAccountRecord, includeVisibleAccounts: boolean): boolean {
  return (
    isAutomaticAccount(account) &&
    (includeVisibleAccounts || account.isHidden === true) &&
    account.sharing?.direction !== "outgoing"
  );
}

function getExpiredResetTime(
  windowPresent: boolean | undefined,
  resetTime: number | undefined,
  nowSeconds: number
): number | undefined {
  return windowPresent === true &&
    typeof resetTime === "number" &&
    Number.isFinite(resetTime) &&
    resetTime > 0 &&
    resetTime <= nowSeconds
    ? resetTime
    : undefined;
}

/**
 * Automatic quota refresh follows the same persisted visibility controls as
 * the Dashboard: hidden accounts and disabled groups are outside the working
 * set. It intentionally uses only the first bounded page so a short interval
 * cannot turn a large account archive into a permanent refresh queue.
 */
export function getAutomaticQuotaRefreshAccountIds(
  accounts: readonly CodexAccountRecord[],
  config: vscode.WorkspaceConfiguration,
  pageSize = DASHBOARD_AUTOMATIC_REFRESH_PAGE_SIZE
): string[] {
  const normalizedPageSize = Math.max(1, Math.floor(pageSize));
  return accounts
    .filter((account) => isAutomaticallyRefreshable(account, config))
    .sort(compareAutomaticQuotaRefreshAccounts)
    .slice(0, normalizedPageSize)
    .map((account) => account.id);
}

/**
 * The countdown automation opt-in is deliberately broader than the legacy
 * visible-page refresh. Once enabled, every non-Gateway account, including
 * hidden accounts and accounts outside the visible groups, gets a chance to
 * refresh. Expired accounts are removed from this ordinary batch so the
 * countdown scheduler can refresh and start them in the correct order.
 */
export function getAutomaticQuotaCountdownAccountIds(accounts: readonly CodexAccountRecord[]): string[] {
  return accounts
    .filter((account) => isQuotaCountdownRefreshable(account, true))
    .map((account) => account.id);
}

function isAutomaticallyRefreshable(account: CodexAccountRecord, config: vscode.WorkspaceConfiguration): boolean {
  if (!isAutomaticAccount(account) || account.quotaMode === "none" || account.isHidden) {
    return false;
  }

  switch (account.accountGroup) {
    case "A":
      return config.get<boolean>(SEAMLESS_SWITCH_GROUP_A_VISIBLE, true);
    case "B":
      return config.get<boolean>(SEAMLESS_SWITCH_GROUP_B_VISIBLE, true);
    case "C":
      return config.get<boolean>(SEAMLESS_SWITCH_GROUP_C_VISIBLE, true);
    default:
      return true;
  }
}

function compareAutomaticQuotaRefreshAccounts(left: CodexAccountRecord, right: CodexAccountRecord): number {
  return (
    Number(right.isActive) - Number(left.isActive) ||
    right.createdAt - left.createdAt ||
    left.email.localeCompare(right.email) ||
    left.id.localeCompare(right.id)
  );
}

const TOKEN_REFRESH_CONCURRENCY = 4;
type TokenScheduleKind = "accessToken" | "idToken" | "retry";

type TokenScheduleEntry = {
  accountId: string;
  kind: TokenScheduleKind;
  dueAt: number;
  version: number;
};

type TokenScheduleState = {
  version: number;
  accessTokenDueAt?: number;
  idTokenDueAt?: number;
  retryAt?: number;
};

/**
 * Small min-heap used by the credential scheduler. Stale entries are left in
 * the heap and discarded when they reach the head; replacing one account's
 * credentials therefore never requires rebuilding or sorting the full queue.
 */
class TokenExpiryPriorityQueue {
  private readonly entries: TokenScheduleEntry[] = [];

  push(entry: TokenScheduleEntry): void {
    this.entries.push(entry);
    this.bubbleUp(this.entries.length - 1);
  }

  peek(): TokenScheduleEntry | undefined {
    return this.entries[0];
  }

  pop(): TokenScheduleEntry | undefined {
    const first = this.entries[0];
    if (!first) {
      return undefined;
    }

    const last = this.entries.pop();
    if (last && this.entries.length > 0) {
      this.entries[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  clear(): void {
    this.entries.length = 0;
  }

  private bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (compareTokenScheduleEntries(this.entries[current]!, this.entries[parent]!) >= 0) {
        return;
      }
      [this.entries[current], this.entries[parent]] = [this.entries[parent]!, this.entries[current]!];
      current = parent;
    }
  }

  private bubbleDown(index: number): void {
    let current = index;
    while (current < this.entries.length) {
      const left = current * 2 + 1;
      const right = left + 1;
      let smallest = current;
      if (left < this.entries.length && compareTokenScheduleEntries(this.entries[left]!, this.entries[smallest]!) < 0) {
        smallest = left;
      }
      if (
        right < this.entries.length &&
        compareTokenScheduleEntries(this.entries[right]!, this.entries[smallest]!) < 0
      ) {
        smallest = right;
      }
      if (smallest === current) {
        break;
      }
      [this.entries[current], this.entries[smallest]] = [this.entries[smallest]!, this.entries[current]!];
      current = smallest;
    }
  }
}

function compareTokenScheduleEntries(left: TokenScheduleEntry, right: TokenScheduleEntry): number {
  return (
    left.dueAt - right.dueAt ||
    left.accountId.localeCompare(right.accountId) ||
    left.kind.localeCompare(right.kind) ||
    left.version - right.version
  );
}

export type TokenRefreshScheduler = vscode.Disposable & {
  /** Re-read all accounts, or only the supplied accounts, and rebuild entries. */
  resync(accountIds?: readonly string[]): Promise<void>;
};

export function registerTokenRefreshScheduler(params: {
  context: vscode.ExtensionContext;
  repo: AccountsRepository;
  view: { refresh(): void };
  checkIntervalMs: number;
  skewSeconds: number;
}): TokenRefreshScheduler {
  let timer: NodeJS.Timeout | undefined;
  let resyncRetryTimer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let disposed = false;
  let enabled = false;
  let nextScheduleVersion = 0;
  let nextAttemptNotBefore = 0;
  let resyncInFlight: Promise<void> | undefined;
  let pendingFullResync = false;
  const pendingAccountIds = new Set<string>();
  const scheduleQueue = new TokenExpiryPriorityQueue();
  const schedules = new Map<string, TokenScheduleState>();
  const accountRecords = new Map<string, CodexAccountRecord>();

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const clearResyncRetryTimer = (): void => {
    if (resyncRetryTimer) {
      clearTimeout(resyncRetryTimer);
      resyncRetryTimer = undefined;
    }
  };

  const invalidateAccountSchedule = (accountId: string): void => {
    schedules.delete(accountId);
    accountRecords.delete(accountId);
  };

  const setTokenSchedule = (
    accountId: string,
    tokens: { idToken?: string; accessToken?: string },
    retryAt?: number
  ): void => {
    const version = ++nextScheduleVersion;
    const accessTokenDueAt = getRefreshDueAt(tokens.accessToken, params.skewSeconds);
    const idTokenDueAt = getRefreshDueAt(tokens.idToken, params.skewSeconds);
    const next: TokenScheduleState = {
      version,
      accessTokenDueAt,
      idTokenDueAt,
      retryAt
    };
    schedules.set(accountId, next);
    if (accessTokenDueAt !== undefined) {
      scheduleQueue.push({ accountId, kind: "accessToken", dueAt: accessTokenDueAt, version });
    }
    if (idTokenDueAt !== undefined) {
      scheduleQueue.push({ accountId, kind: "idToken", dueAt: idTokenDueAt, version });
    }
    if (retryAt !== undefined) {
      scheduleQueue.push({ accountId, kind: "retry", dueAt: retryAt, version });
    }
  };

  const setRetrySchedule = (accountId: string, retryAt: number): void => {
    setTokenSchedule(accountId, {}, retryAt);
  };

  const isCurrentQueueEntry = (entry: TokenScheduleEntry): boolean => {
    const state = schedules.get(entry.accountId);
    if (state?.version !== entry.version) {
      return false;
    }
    const dueAt =
      entry.kind === "accessToken"
        ? state.accessTokenDueAt
        : entry.kind === "idToken"
          ? state.idTokenDueAt
          : state.retryAt;
    return dueAt === entry.dueAt;
  };

  const discardStaleQueueHead = (): void => {
    let head = scheduleQueue.peek();
    while (head && !isCurrentQueueEntry(head)) {
      scheduleQueue.pop();
      head = scheduleQueue.peek();
    }
  };

  const peekNextDueAt = (): number | undefined => {
    discardStaleQueueHead();
    return scheduleQueue.peek()?.dueAt;
  };

  const takeDueAccountIds = (now: number): string[] => {
    const dueAccountIds = new Set<string>();
    discardStaleQueueHead();
    let entry = scheduleQueue.peek();
    while (entry && entry.dueAt <= now) {
      scheduleQueue.pop();
      dueAccountIds.add(entry.accountId);
      discardStaleQueueHead();
      entry = scheduleQueue.peek();
    }
    return [...dueAccountIds];
  };

  const scheduleNextSweep = (): void => {
    clearTimer();
    if (disposed || !enabled) {
      setTokenAutomationNextSweep(undefined);
      return;
    }
    if (inFlight || resyncInFlight) {
      setTokenAutomationNextSweep(undefined);
      return;
    }

    const nextDueAt = peekNextDueAt();
    if (nextDueAt === undefined) {
      setTokenAutomationNextSweep(undefined);
      return;
    }

    const nextAttemptAt = Math.max(nextDueAt, nextAttemptNotBefore);
    const delayMs = Math.max(0, nextAttemptAt - Date.now());
    setTokenAutomationNextSweep(nextAttemptAt);
    timer = setTimeout(() => {
      timer = undefined;
      void runTokenRefreshSweep();
    }, delayMs);
  };

  const scheduleResyncRetry = (): void => {
    if (disposed || !enabled || resyncRetryTimer) {
      return;
    }
    resyncRetryTimer = setTimeout(() => {
      resyncRetryTimer = undefined;
      startResyncDrain();
    }, params.checkIntervalMs);
  };

  const persistTokenRefreshStatus = async (
    accountId: string,
    update: Partial<
      Pick<
        CodexAccountRecord,
        | "tokenRefreshLastAttemptAt"
        | "tokenRefreshLastSuccessAt"
        | "tokenRefreshLastError"
        | "tokenRefreshLastErrorAt"
        | "tokenRefreshLastErrorKind"
        | "tokenRefreshNextRetryAt"
      >
    >
  ): Promise<void> => {
    if (typeof params.repo.updateTokenRefreshStatus !== "function") {
      return;
    }
    try {
      await params.repo.updateTokenRefreshStatus(accountId, update);
    } catch (error) {
      console.warn(`[codexAccounts] token refresh status persistence failed: ${getErrorMessage(error)}`);
    }
  };

  const synchronizeAccount = async (account: CodexAccountRecord, credentialsChanged = false): Promise<void> => {
    try {
      const tokens = await params.repo.getTokens(account.id);
      if (disposed || !enabled) {
        return;
      }
      markTokenAutomationCheck(account.id);
      if (!tokens?.accessToken) {
        setTokenSchedule(account.id, {});
        return;
      }

      if (credentialsChanged) {
        clearTokenAutomationError(account.id);
        await persistTokenRefreshStatus(account.id, {
          tokenRefreshLastError: undefined,
          tokenRefreshLastErrorAt: undefined,
          tokenRefreshLastErrorKind: undefined,
          tokenRefreshNextRetryAt: undefined
        });
      }
      setTokenSchedule(account.id, tokens);
    } catch (error) {
      const message = getErrorMessage(error);
      markTokenAutomationRefreshFailure(account.id, message);
      setRetrySchedule(account.id, Date.now() + params.checkIntervalMs);
      console.warn(`[codexAccounts] token expiry lookup failed for ${account.email}: ${message}`);
    }
  };

  const synchronizeSchedules = async (accountIds?: readonly string[]): Promise<void> => {
    const accounts = await params.repo.listAccounts();
    hydrateTokenAutomationState(accounts);
    const eligibleAccounts = accounts.filter(
      (account) =>
        isAutomaticAccount(account) &&
        account.quotaMode !== "none" &&
        account.sharing?.direction !== "outgoing"
    );
    const eligibleById = new Map(eligibleAccounts.map((account) => [account.id, account]));

    if (accountIds === undefined) {
      for (const accountId of accountRecords.keys()) {
        if (!eligibleById.has(accountId)) {
          invalidateAccountSchedule(accountId);
        }
      }
      accountRecords.clear();
      for (const account of eligibleAccounts) {
        accountRecords.set(account.id, account);
      }
    }

    const targets =
      accountIds === undefined
        ? eligibleAccounts
        : [...new Set(accountIds)]
            .map((accountId) => eligibleById.get(accountId))
            .filter((account): account is CodexAccountRecord => Boolean(account));

    if (accountIds !== undefined) {
      for (const accountId of new Set(accountIds)) {
        const account = eligibleById.get(accountId);
        if (account) {
          accountRecords.set(account.id, account);
        } else {
          invalidateAccountSchedule(accountId);
        }
      }
    }

    await runWithConcurrencyLimit(targets, TOKEN_REFRESH_CONCURRENCY, async (account) => {
      await synchronizeAccount(account, accountIds !== undefined);
    });
  };

  const drainResync = async (): Promise<void> => {
    while (!disposed && enabled && (pendingFullResync || pendingAccountIds.size > 0)) {
      const fullResync = pendingFullResync;
      const accountIds = [...pendingAccountIds];
      pendingFullResync = false;
      pendingAccountIds.clear();
      try {
        await synchronizeSchedules(fullResync ? undefined : accountIds);
      } catch (error) {
        console.warn(`[codexAccounts] token expiry resync failed: ${getErrorMessage(error)}`);
        if (fullResync) {
          pendingFullResync = true;
        } else {
          accountIds.forEach((accountId) => pendingAccountIds.add(accountId));
        }
        scheduleResyncRetry();
        return;
      }
    }
  };

  function startResyncDrain(): void {
    if (disposed || !enabled || resyncInFlight || (!pendingFullResync && pendingAccountIds.size === 0)) {
      return;
    }

    const task = drainResync();
    const wrapped = task.finally(() => {
      if (resyncInFlight === wrapped) {
        resyncInFlight = undefined;
        if ((pendingFullResync || pendingAccountIds.size > 0) && !resyncRetryTimer) {
          startResyncDrain();
        } else {
          scheduleNextSweep();
        }
      }
    });
    resyncInFlight = wrapped;
  }

  const requestResync = (accountIds?: readonly string[]): Promise<void> => {
    if (disposed || !enabled) {
      return Promise.resolve();
    }
    clearResyncRetryTimer();
    if (accountIds === undefined || accountIds.length === 0) {
      pendingFullResync = true;
    } else {
      accountIds.forEach((accountId) => pendingAccountIds.add(accountId));
    }
    startResyncDrain();
    return resyncInFlight ?? Promise.resolve();
  };

  const refreshScheduledAccount = async (
    account: CodexAccountRecord,
    leaseIsActive: () => boolean,
    counters: { checked: number; refreshed: number; lastFailureMessage?: string }
  ): Promise<void> => {
    let attemptAt: number | undefined;
    let tokens: CodexTokens | undefined;
    try {
      // Sharing transfers ownership of the usable credential for the lease
      // duration. Re-read the account before a due entry starts so a sweep
      // already queued before the share cannot refresh or rotate it.
      const latestAccount =
        typeof params.repo.getAccount === "function" ? await params.repo.getAccount(account.id) : account;
      if (!latestAccount || latestAccount.sharing?.direction === "outgoing") {
        setTokenSchedule(account.id, {});
        return;
      }
      tokens = await params.repo.getTokens(account.id);
      markTokenAutomationCheck(account.id);
      counters.checked += 1;
      if (!leaseIsActive()) {
        console.warn("[codexAccounts] token refresh skipped after losing its shared lease");
        setRetrySchedule(account.id, Date.now() + params.checkIntervalMs);
        return;
      }
      if (!tokens?.accessToken) {
        setTokenSchedule(account.id, {});
        return;
      }
      if (!needsTokenRefresh(tokens, params.skewSeconds)) {
        clearTokenAutomationError(account.id);
        await persistTokenRefreshStatus(account.id, {
          tokenRefreshLastError: undefined,
          tokenRefreshLastErrorAt: undefined,
          tokenRefreshLastErrorKind: undefined,
          tokenRefreshNextRetryAt: undefined
        });
        setTokenSchedule(account.id, tokens);
        return;
      }

      attemptAt = Date.now();
      await persistTokenRefreshStatus(account.id, {
        tokenRefreshLastAttemptAt: attemptAt,
        tokenRefreshLastError: undefined,
        tokenRefreshLastErrorAt: undefined,
        tokenRefreshLastErrorKind: undefined,
        tokenRefreshNextRetryAt: undefined
      });
      const refreshed = await ensureFreshAccountTokens(params.repo, account.id, {
        fallbackTokens: tokens,
        notifyTokenChange: false,
        providerAccountId: account.accountId
      });
      if (!refreshed?.accessToken) {
        throw new Error("Token expired and no refreshed access token is available");
      }
      if (!leaseIsActive()) {
        console.warn("[codexAccounts] token refresh skipped its write after losing the shared lease");
        setRetrySchedule(account.id, Date.now() + params.checkIntervalMs);
        return;
      }

      const effectiveTokens = {
        ...refreshed,
        accountId: refreshed.accountId ?? account.accountId ?? tokens.accountId
      };
      const idTokenDueAt = getRefreshDueAt(tokens.idToken, params.skewSeconds);
      const idTokenWasDue = idTokenDueAt !== undefined && idTokenDueAt <= Date.now();
      // OAuth refresh responses are allowed to omit id_token. The access token
      // is still usable; do not immediately requeue the unchanged, already
      // expired id token and turn a successful refresh into a failure loop.
      setTokenSchedule(
        account.id,
        idTokenWasDue && effectiveTokens.idToken === tokens.idToken
          ? { accessToken: effectiveTokens.accessToken }
          : effectiveTokens
      );
      markTokenAutomationRefreshSuccess(account.id);
      await persistTokenRefreshStatus(account.id, {
        tokenRefreshLastAttemptAt: attemptAt,
        tokenRefreshLastSuccessAt: Date.now(),
        tokenRefreshLastError: undefined,
        tokenRefreshLastErrorAt: undefined,
        tokenRefreshLastErrorKind: undefined,
        tokenRefreshNextRetryAt: undefined
      });
      counters.refreshed += 1;
    } catch (error) {
      const message = sanitizeApiErrorText(getErrorMessage(error)) || "Token refresh failed";
      const failure = classifyTokenRefreshFailure(error);
      const retryAt = failure.retry ? Date.now() + params.checkIntervalMs : undefined;
      counters.lastFailureMessage = message;
      if (retryAt !== undefined) {
        setRetrySchedule(account.id, retryAt);
      } else {
        setTokenSchedule(account.id, {});
      }
      markTokenAutomationRefreshFailure(account.id, message, failure.kind, retryAt);
      await persistTokenRefreshStatus(account.id, {
        tokenRefreshLastAttemptAt: attemptAt ?? Date.now(),
        tokenRefreshLastError: message,
        tokenRefreshLastErrorAt: Date.now(),
        tokenRefreshLastErrorKind: failure.kind,
        tokenRefreshNextRetryAt: retryAt
      });
      console.warn(
        `[codexAccounts] background token refresh failed for ${account.email} (${failure.kind}): ${message}`
      );
    }
  };

  async function runTokenRefreshSweep(): Promise<void> {
    if (inFlight || disposed || !enabled || resyncInFlight) {
      scheduleNextSweep();
      return;
    }

    const dueAccountIds = takeDueAccountIds(Date.now());
    if (dueAccountIds.length === 0) {
      scheduleNextSweep();
      return;
    }

    inFlight = true;
    const counters: { checked: number; refreshed: number; lastFailureMessage?: string } = {
      checked: 0,
      refreshed: 0
    };
    let sweepStarted = false;
    let leaseAcquired = false;
    let leaseError: string | undefined;
    try {
      let result: boolean | undefined;
      try {
        result = await withSchedulerLease(params.repo, "token-refresh", async (leaseIsActive) => {
          leaseAcquired = true;
          markTokenAutomationSweepStarted();
          sweepStarted = true;
          await runWithConcurrencyLimit(dueAccountIds, TOKEN_REFRESH_CONCURRENCY, async (accountId) => {
            const account = accountRecords.get(accountId);
            if (!account) {
              return;
            }
            if (!leaseIsActive()) {
              setRetrySchedule(accountId, Date.now() + params.checkIntervalMs);
              return;
            }
            await refreshScheduledAccount(account, leaseIsActive, counters);
          });
          return true;
        });
      } catch (error) {
        leaseError = getErrorMessage(error);
        counters.lastFailureMessage = leaseError;
        console.warn(`[codexAccounts] token refresh lease operation failed: ${leaseError}`);
      }

      if ((!result || leaseError) && !leaseAcquired) {
        const retryAt = Date.now() + params.checkIntervalMs;
        dueAccountIds.forEach((accountId) => setRetrySchedule(accountId, retryAt));
        nextAttemptNotBefore = retryAt;
      } else {
        nextAttemptNotBefore = 0;
      }
    } finally {
      inFlight = false;
      if (sweepStarted) {
        markTokenAutomationSweepFinished(counters.lastFailureMessage);
        console.info(
          `[codexAccounts] background token refresh sweep: checked=${counters.checked}, refreshed=${counters.refreshed}` +
            (counters.lastFailureMessage ? `, lastError=${counters.lastFailureMessage}` : ""),
          { checked: counters.checked, refreshed: counters.refreshed }
        );
        params.view.refresh();
      }
      scheduleNextSweep();
    }
  }

  const applySchedule = (): void => {
    enabled = isBackgroundTokenRefreshEnabled();
    configureTokenAutomation(enabled, params.checkIntervalMs, params.skewSeconds);

    clearTimer();
    nextAttemptNotBefore = 0;

    if (!enabled) {
      clearResyncRetryTimer();
      pendingFullResync = false;
      pendingAccountIds.clear();
      scheduleQueue.clear();
      schedules.clear();
      accountRecords.clear();
      params.view.refresh();
      return;
    }

    void requestResync();
  };

  const tokenChangeDisposable = params.repo.onDidChangeTokens?.((accountIds) => {
    void requestResync(accountIds);
  });
  if (tokenChangeDisposable) {
    params.context.subscriptions.push(tokenChangeDisposable);
  }
  const accountChangeDisposable = params.repo.onDidChangeAccounts?.((accountIds) => {
    void requestResync(accountIds);
  });
  if (accountChangeDisposable) {
    params.context.subscriptions.push(accountChangeDisposable);
  }

  applySchedule();

  const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codexAccounts.backgroundTokenRefreshEnabled")) {
      applySchedule();
    }
  });

  if (configDisposable) {
    params.context.subscriptions.push(configDisposable);
  }
  return {
    resync: requestResync,
    dispose(): void {
      disposed = true;
      configDisposable?.dispose();
      tokenChangeDisposable?.dispose();
      clearTimer();
      clearResyncRetryTimer();
      scheduleQueue.clear();
      schedules.clear();
      accountRecords.clear();
      pendingAccountIds.clear();
      pendingFullResync = false;
    }
  };
}

function getRefreshDueAt(token: string | undefined, skewSeconds: number): number | undefined {
  if (!token) {
    return undefined;
  }
  const expirySeconds = getTokenExpiryEpochSeconds(token);
  if (typeof expirySeconds !== "number" || !Number.isFinite(expirySeconds) || expirySeconds <= 0) {
    return undefined;
  }
  return Math.floor(expirySeconds * 1000) - skewSeconds * 1000;
}

function classifyTokenRefreshFailure(error: unknown): { kind: TokenRefreshErrorKind; retry: boolean } {
  const details = asErrorDetails(error);
  const statusCode = typeof details.statusCode === "number" ? details.statusCode : undefined;
  const errorCode = readErrorCode(details.context) ?? readString(details.code);
  const normalized = getErrorMessage(error).toLowerCase();

  if (errorCode === "refresh_token_reused" || normalized.includes("refresh_token_reused")) {
    return { kind: "reauthorize", retry: false };
  }

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    errorCode === "invalid_grant" ||
    errorCode === "unauthorized_client" ||
    normalized.includes("invalid_grant") ||
    normalized.includes("no refresh token is available")
  ) {
    return { kind: "reauthorize", retry: false };
  }

  if (statusCode === 408 || (statusCode !== undefined && isRetriableHttpStatus(statusCode)) || isRetriableNetworkError(error)) {
    return { kind: "network", retry: true };
  }

  if (
    details.code === ErrorCode.AUTH_TOKEN_MISSING ||
    normalized.includes("missing id_token") ||
    normalized.includes("invalid json") ||
    normalized.includes("unexpected token")
  ) {
    return { kind: "provider_response", retry: true };
  }

  if (details.code === ErrorCode.STORAGE_READ_FAILED || details.code === ErrorCode.STORAGE_WRITE_FAILED) {
    return { kind: "storage", retry: true };
  }

  return { kind: "unknown", retry: true };
}

function asErrorDetails(error: unknown): {
  code?: unknown;
  statusCode?: unknown;
  context?: unknown;
} {
  if (!error || typeof error !== "object") {
    return {};
  }
  const candidate = error as Record<string, unknown>;
  return {
    code: candidate["code"],
    statusCode: candidate["statusCode"],
    context: candidate["context"]
  };
}

function readErrorCode(context: unknown): string | undefined {
  if (!context || typeof context !== "object") {
    return undefined;
  }
  return readString((context as Record<string, unknown>)['errorCode']);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

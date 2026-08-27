import * as vscode from "vscode";
import { needsTokenRefresh, refreshTokens } from "../../auth/oauth";
import type { CodexHotSwitchRuntime, HotSwitchIdentity, HotSwitchStatus } from "../../codex";
import { isAutomaticAccount, type CodexAccountRecord, type TokenRefreshErrorKind } from "../../core/types";
import { ErrorCode, getErrorMessage, sanitizeApiErrorText } from "../../core/errors";
import { DASHBOARD_AUTOMATIC_REFRESH_PAGE_SIZE } from "../../domain/dashboard/types";
import {
  getAutoRefreshMinutes,
  getCodexAccountsConfiguration,
  getSeamlessSwitchThreshold,
  isBackgroundTokenRefreshEnabled,
  isSeamlessSwitchEnabled,
  isSeamlessSwitchLowQuotaEnabled
} from "../../infrastructure/config/extensionSettings";
import type { AccountsRepository } from "../../storage";
import { runWithConcurrencyLimit } from "../../utils/concurrency";
import { getTokenExpiryEpochSeconds } from "../../utils/jwt";
import { isRetriableHttpStatus, isRetriableNetworkError } from "../../utils/network";
import { shouldRunAccountScheduler } from "./refreshSignature";
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

    inFlight = true;
    try {
      const status = await params.runtime.getStatus();
      if (disposed || pollGeneration !== generation) {
        return;
      }
      statusErrorReported = false;
      const exhaustionOnly = getSeamlessSwitchThreshold(getCodexAccountsConfiguration()) === 0;
      observeUsageLimitStatus(status, exhaustionOnly);
      const hasEligibleUsageSignal = exhaustionOnly
        ? status.usageLimitExhaustionReady
        : status.recentUsageLimitedThreads > 0;
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
      if (disposed || pollGeneration !== generation) {
        return;
      }
      const switched = await params.onUsageLimitExceeded(
        getManagedLocalAccountId(identity),
        exhaustionOnly ? "runtimeUsageLimitExhaustion" : "runtimeUsageLimit"
      );
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
      retryPending = exhaustionOnly ? status.usageLimitExhaustionReady : status.recentUsageLimitedThreads > 0;
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
        const accountIds = getAutomaticQuotaRefreshAccountIds(accounts, getCodexAccountsConfiguration());
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
    void params.repo.listAccounts().then((accounts) => {
      if (
        shouldRunAccountScheduler(getAutomaticQuotaRefreshAccountIds(accounts, getCodexAccountsConfiguration()).length)
      ) {
        void runAutoRefresh();
      }
    });
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
    const eligibleAccounts = accounts.filter((account) => isAutomaticAccount(account) && account.quotaMode !== "none");
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
    try {
      const tokens = await params.repo.getTokens(account.id);
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
        setTokenSchedule(account.id, tokens);
        return;
      }

      if (!tokens.refreshToken) {
        throw new Error("Token expired and no refresh token is available");
      }

      attemptAt = Date.now();
      await persistTokenRefreshStatus(account.id, {
        tokenRefreshLastAttemptAt: attemptAt,
        tokenRefreshLastError: undefined,
        tokenRefreshLastErrorAt: undefined,
        tokenRefreshLastErrorKind: undefined,
        tokenRefreshNextRetryAt: undefined
      });
      const refreshed = await refreshTokens(tokens.refreshToken, tokens.idToken);
      if (!leaseIsActive()) {
        console.warn("[codexAccounts] token refresh skipped its write after losing the shared lease");
        setRetrySchedule(account.id, Date.now() + params.checkIntervalMs);
        return;
      }

      const effectiveTokens = {
        ...refreshed,
        accountId: refreshed.accountId ?? account.accountId ?? tokens.accountId
      };
      await params.repo.updateTokens(account.id, effectiveTokens, { notifyTokenChange: false });
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

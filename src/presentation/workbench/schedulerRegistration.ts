import * as vscode from "vscode";
import { needsRefresh, refreshTokens } from "../../auth/oauth";
import type { CodexHotSwitchRuntime, HotSwitchIdentity, HotSwitchStatus } from "../../codex";
import { isAutomaticAccount, type CodexAccountRecord } from "../../core/types";
import { getErrorMessage } from "../../core/errors";
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
import { shouldRunAccountScheduler } from "./refreshSignature";
import {
  clearTokenAutomationError,
  configureTokenAutomation,
  markTokenAutomationCheck,
  markTokenAutomationRefreshFailure,
  markTokenAutomationRefreshSuccess,
  markTokenAutomationSweepFinished,
  markTokenAutomationSweepStarted
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

export function registerTokenRefreshScheduler(params: {
  context: vscode.ExtensionContext;
  repo: AccountsRepository;
  view: { refresh(): void };
  checkIntervalMs: number;
  skewSeconds: number;
}): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;

  const runTokenRefreshSweep = async (): Promise<void> => {
    if (inFlight) {
      return;
    }

    inFlight = true;
    let lastFailureMessage: string | undefined;
    let checked = 0;
    let refreshedCount = 0;
    let sweepStarted = false;
    try {
      const accounts = await params.repo.listAccounts();
      if (!shouldRunAccountScheduler(accounts.length)) {
        return;
      }
      await withSchedulerLease(params.repo, "token-refresh", async (leaseIsActive) => {
        markTokenAutomationSweepStarted();
        sweepStarted = true;

        for (const account of accounts) {
          if (!isAutomaticAccount(account) || account.quotaMode === "none") {
            continue;
          }

          if (!leaseIsActive()) {
            console.warn("[codexAccounts] token refresh stopped after losing its shared lease");
            break;
          }

          try {
            const tokens = await params.repo.getTokens(account.id);
            markTokenAutomationCheck(account.id);
            checked += 1;
            if (!leaseIsActive()) {
              console.warn("[codexAccounts] token refresh stopped after losing its shared lease");
              break;
            }
            if (!tokens?.accessToken || !needsRefresh(tokens.accessToken, params.skewSeconds)) {
              clearTokenAutomationError(account.id);
              continue;
            }

            if (!tokens.refreshToken) {
              throw new Error("Token expired and no refresh token is available");
            }

            const refreshed = await refreshTokens(tokens.refreshToken, tokens.idToken);
            if (!leaseIsActive()) {
              console.warn("[codexAccounts] token refresh skipped its write after losing the shared lease");
              break;
            }
            await params.repo.updateTokens(account.id, {
              ...refreshed,
              accountId: refreshed.accountId ?? account.accountId ?? tokens.accountId
            });
            markTokenAutomationRefreshSuccess(account.id);
            refreshedCount += 1;
          } catch (error) {
            lastFailureMessage = getErrorMessage(error);
            markTokenAutomationRefreshFailure(account.id, lastFailureMessage);
            console.warn(`[codexAccounts] background token refresh failed for ${account.email}: ${lastFailureMessage}`);
          }
        }
      });
    } finally {
      inFlight = false;
      if (sweepStarted) {
        markTokenAutomationSweepFinished(lastFailureMessage);
        console.info(
          `[codexAccounts] background token refresh sweep: checked=${checked}, refreshed=${refreshedCount}` +
            (lastFailureMessage ? `, lastError=${lastFailureMessage}` : ""),
          { checked, refreshed: refreshedCount }
        );
        params.view.refresh();
      }
    }
  };

  const applySchedule = (): void => {
    const enabled = isBackgroundTokenRefreshEnabled();
    configureTokenAutomation(enabled, params.checkIntervalMs, params.skewSeconds);

    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }

    if (!enabled) {
      params.view.refresh();
      return;
    }

    timer = setInterval(() => {
      void runTokenRefreshSweep();
    }, params.checkIntervalMs);
    void params.repo.listAccounts().then((accounts) => {
      if (shouldRunAccountScheduler(accounts.length)) {
        void runTokenRefreshSweep();
      }
    });
  };

  applySchedule();

  const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codexAccounts.backgroundTokenRefreshEnabled")) {
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

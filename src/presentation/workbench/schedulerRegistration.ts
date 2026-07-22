import * as vscode from "vscode";
import { needsRefresh, refreshTokens } from "../../auth/oauth";
import type { CodexHotSwitchRuntime, HotSwitchIdentity, HotSwitchStatus } from "../../codex";
import type { CodexAccountRecord } from "../../core/types";
import { DASHBOARD_ACCOUNTS_PAGE_SIZE } from "../../domain/dashboard/types";
import {
  getAutoRefreshMinutes,
  getCodexAccountsConfiguration,
  isBackgroundTokenRefreshEnabled,
  isSeamlessSwitchEnabled,
  isSeamlessSwitchQuotaBandsEnabled
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
const HOT_SWITCH_ENABLED = "hotSwitchEnabled";
const SEAMLESS_EMERGENCY_SWITCH_ENABLED = "seamlessSwitchEmergencySwitchEnabled";
const SEAMLESS_SWITCH_GROUP_A_VISIBLE = "seamlessSwitchGroupAVisible";
const SEAMLESS_SWITCH_GROUP_B_VISIBLE = "seamlessSwitchGroupBVisible";
const SEAMLESS_SWITCH_GROUP_C_VISIBLE = "seamlessSwitchGroupCVisible";

// This monitor deliberately only consumes the runtime's bounded scalar status
// response. It never asks the runtime for thread IDs, conversation text, or
// history, so a one-minute quota refresh cannot turn into a growing cache.
export const SEAMLESS_USAGE_LIMIT_POLL_INTERVAL_MS = 2_000;
export const SEAMLESS_USAGE_LIMIT_RETRY_MS = 10_000;
export const SEAMLESS_USAGE_LIMIT_FAILURE_BACKOFF_MS = 30_000;

type SeamlessUsageLimitRuntime = Pick<CodexHotSwitchRuntime, "isEnabled" | "getStatus" | "getIdentity">;

export function registerSeamlessUsageLimitMonitor(params: {
  context: vscode.ExtensionContext;
  runtime: SeamlessUsageLimitRuntime;
  onUsageLimitExceeded: (activeAccountId?: string) => Promise<boolean>;
}): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;
  let inFlight = false;
  let generation = 0;
  let lastShimPid: number | undefined;
  let lastObservedUsageLimitFailures: number | undefined;
  let retryPending = false;
  let nextAttemptAt = 0;
  let statusErrorReported = false;

  const isEnabled = (): boolean => {
    const config = getCodexAccountsConfiguration();
    return (
      params.runtime.isEnabled() &&
      config.get<boolean>(HOT_SWITCH_ENABLED, false) &&
      isSeamlessSwitchEnabled(config) &&
      isSeamlessSwitchQuotaBandsEnabled(config) &&
      config.get<boolean>(SEAMLESS_EMERGENCY_SWITCH_ENABLED, false)
    );
  };

  const resetRuntimeObservation = (): void => {
    lastShimPid = undefined;
    lastObservedUsageLimitFailures = undefined;
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
      observeUsageLimitStatus(status);
      if (!status.ready || status.recentUsageLimitedThreads <= 0) {
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
      const switched = await params.onUsageLimitExceeded(getManagedLocalAccountId(identity));
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

  const observeUsageLimitStatus = (status: HotSwitchStatus): void => {
    const runtimeChanged = lastShimPid === undefined || lastShimPid !== status.shimPid;
    const failuresIncreased =
      !runtimeChanged &&
      lastObservedUsageLimitFailures !== undefined &&
      status.observedUsageLimitFailures > lastObservedUsageLimitFailures;
    const failuresReset =
      !runtimeChanged &&
      lastObservedUsageLimitFailures !== undefined &&
      status.observedUsageLimitFailures < lastObservedUsageLimitFailures;

    if (runtimeChanged || failuresIncreased || failuresReset) {
      retryPending = status.recentUsageLimitedThreads > 0;
      nextAttemptAt = 0;
    }
    lastShimPid = status.shimPid;
    lastObservedUsageLimitFailures = status.observedUsageLimitFailures;
  };

  const applySchedule = (): void => {
    generation += 1;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    resetRuntimeObservation();
    if (!isEnabled()) {
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
      event.affectsConfiguration("codexAccounts.seamlessSwitchEmergencySwitchEnabled") ||
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

        const lease = await params.repo.tryAcquireSchedulerLease("quota-refresh", SCHEDULER_LEASE_MS);
        if (!lease) {
          return;
        }
        try {
          await vscode.commands.executeCommand("codexAccounts.refreshAllQuotas", {
            silent: true,
            forceRefresh: true,
            accountIds
          });
        } finally {
          await lease.release();
        }
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
      if (shouldRunAccountScheduler(getAutomaticQuotaRefreshAccountIds(accounts, getCodexAccountsConfiguration()).length)) {
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
  pageSize = DASHBOARD_ACCOUNTS_PAGE_SIZE
): string[] {
  const normalizedPageSize = Math.max(1, Math.floor(pageSize));
  return accounts
    .filter((account) => isAutomaticallyRefreshable(account, config))
    .sort(compareAutomaticQuotaRefreshAccounts)
    .slice(0, normalizedPageSize)
    .map((account) => account.id);
}

function isAutomaticallyRefreshable(account: CodexAccountRecord, config: vscode.WorkspaceConfiguration): boolean {
  if (account.isHidden) {
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
    let lease: Awaited<ReturnType<AccountsRepository["tryAcquireSchedulerLease"]>>;
    try {
      const accounts = await params.repo.listAccounts();
      if (!shouldRunAccountScheduler(accounts.length)) {
        return;
      }
      lease = await params.repo.tryAcquireSchedulerLease("token-refresh", SCHEDULER_LEASE_MS);
      if (!lease) {
        return;
      }
      markTokenAutomationSweepStarted();
      sweepStarted = true;

      for (const account of accounts) {
        try {
          const tokens = await params.repo.getTokens(account.id);
          markTokenAutomationCheck(account.id);
          checked += 1;
          if (!tokens?.accessToken || !needsRefresh(tokens.accessToken, params.skewSeconds)) {
            clearTokenAutomationError(account.id);
            continue;
          }

          if (!tokens.refreshToken) {
            throw new Error("Token expired and no refresh token is available");
          }

          const refreshed = await refreshTokens(tokens.refreshToken, tokens.idToken);
          await params.repo.updateTokens(account.id, {
            ...refreshed,
            accountId: refreshed.accountId ?? account.accountId ?? tokens.accountId
          });
          markTokenAutomationRefreshSuccess(account.id);
          refreshedCount += 1;
        } catch (error) {
          lastFailureMessage = error instanceof Error ? error.message : String(error);
          markTokenAutomationRefreshFailure(account.id, lastFailureMessage);
          console.warn(`[codexAccounts] background token refresh failed for ${account.email}:`, error);
        }
      }
    } finally {
      inFlight = false;
      await lease?.release();
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

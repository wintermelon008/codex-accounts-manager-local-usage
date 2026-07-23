import * as vscode from "vscode";
import type { RuntimeAccountSwitchOptions, RuntimeAccountSwitchOutcome } from "../../codex";
import { createError } from "../../core";
import { CodexAccountRecord } from "../../core/types";
import {
  getCodexAccountsConfiguration,
  getSeamlessSwitchThreshold,
  isSeamlessSwitchEnabled,
  isSeamlessSwitchQuotaBandsEnabled,
  normalizeAutoSwitchThreshold,
  normalizeQuotaWarningThreshold,
  normalizeSeamlessQuotaBandSize
} from "../../infrastructure/config/extensionSettings";
import { QuotaRefreshResult, refreshQuota, fetchResetCredits } from "../../services";
import { AccountsRepository } from "../../storage";
import { needsWindowReloadForAccount } from "../../presentation/workbench/windowRuntimeAccount";
import {
  clearAutoSwitchLock,
  isAutoSwitchLocked,
  recordAutoSwitchReason
} from "../../presentation/workbench/autoSwitchState";
import {
  acknowledgeSeamlessQuotaBand,
  getSeamlessSwitchRuntimeSnapshot,
  observeSeamlessQuotaBand,
  recordSeamlessSelection
} from "../../presentation/workbench/seamlessSwitchState";
import { clearTokenAutomationError } from "../../presentation/workbench/tokenAutomationState";
import { getCommandCopy, getLanguage, getQuotaWarningCopy } from "../../utils";
import { getDashboardCopy } from "../dashboard/copy";
import { autoReloadWindowForAccount, handleCodexAppRestartPreference } from "./switchEffects";
import {
  getBalanceQuotaCapability,
  getFiveHourQuotaBand,
  isFreePlanType,
  isVerifiedFreeWindowedAccount,
  selectBalanceCandidate,
  selectFreeExhaustionCandidate
} from "./balanceScheduler";

const AUTO_SWITCH_ENABLED = "autoSwitchEnabled";
const HOT_SWITCH_ENABLED = "hotSwitchEnabled";
const HOURLY_QUOTA_CONTROL_ENABLED = "hourlyQuotaControlEnabled";
const AUTO_SWITCH_RELOAD_WINDOW_ENABLED = "autoSwitchReloadWindowEnabled";
const AUTO_SWITCH_HOURLY_THRESHOLD = "autoSwitchHourlyThreshold";
const AUTO_SWITCH_WEEKLY_THRESHOLD = "autoSwitchWeeklyThreshold";
const QUOTA_WARNING_ENABLED = "quotaWarningEnabled";
const QUOTA_WARNING_THRESHOLD = "quotaWarningThreshold";
const SEAMLESS_QUOTA_BAND_SIZE = "seamlessSwitchQuotaBandSize";
const SEAMLESS_SWITCH_GROUP_A_VISIBLE = "seamlessSwitchGroupAVisible";
const SEAMLESS_SWITCH_GROUP_B_VISIBLE = "seamlessSwitchGroupBVisible";
const SEAMLESS_SWITCH_GROUP_C_VISIBLE = "seamlessSwitchGroupCVisible";
const SEAMLESS_SWITCH_LEASE_MS = 2 * 60 * 1000;
const MAX_WARNINGS_PER_CYCLE = 3;
const quotaWarningCounts = new Map<string, number>();
let seamlessSwitchInFlight: Promise<boolean> | undefined;

export type RefreshView = {
  refresh(): void;
  markObservedAuthIdentity?: (accountId?: string) => void;
  switchRuntimeAccount?: (
    accountId: string,
    options?: RuntimeAccountSwitchOptions
  ) => Promise<RuntimeAccountSwitchOutcome>;
};

export type SeamlessQuotaSwitchOptions = {
  /** The local runtime observed a structured usageLimitExceeded failure. */
  trigger?: "runtimeUsageLimit";
  /** The account currently loaded by this window's runtime, if known. */
  activeAccountId?: string;
};

type RefreshSingleQuotaOptions = {
  announce?: boolean;
  awaitSubscriptionRefresh?: boolean;
  forceRefresh?: boolean;
  refreshView?: boolean;
  warnQuota?: boolean;
};

export async function refreshSingleQuota(
  repo: AccountsRepository,
  view: RefreshView,
  accountId: string,
  options: RefreshSingleQuotaOptions = {}
): Promise<void> {
  const announce = options.announce ?? true;
  const forceRefresh = options.forceRefresh ?? announce;
  const awaitSubscriptionRefresh = options.awaitSubscriptionRefresh ?? false;
  const shouldRefreshView = options.refreshView ?? true;
  const warnQuota = options.warnQuota ?? true;
  const account = await repo.getAccount(accountId);
  if (!account) {
    return;
  }

  const tokens = await repo.getTokens(accountId);
  if (!tokens) {
    throw createError.accountNotFound(account.email);
  }

  const result = await refreshQuota(account, tokens, forceRefresh);
  const updatedAccount = await repo.updateQuota(
    accountId,
    result.quota,
    result.error,
    result.updatedTokens,
    result.updatedPlanType,
    result.updatedSubscriptionActiveUntil
  );
  const subscriptionRefresh = repo.refreshSubscriptionState(accountId, forceRefresh).catch(() => undefined);
  if (awaitSubscriptionRefresh) {
    // 账号信息同步需要等订阅写入完成后再发布页面状态，避免继续展示旧套餐和旧到期时间。
    await subscriptionRefresh;
  } else {
    // 普通配额刷新保持后台更新，避免订阅接口拖慢操作。
    void subscriptionRefresh;
  }
  // 后台异步拉取重置次数明细（含最新可用次数与最近到期时间），不阻塞配额刷新
  if (!result.error && updatedAccount.quotaSummary) {
    const credTokens = result.updatedTokens ?? tokens;
    const credAccountId = updatedAccount.accountId ?? account.accountId ?? undefined;
    void syncResetCreditsSnapshot(repo, view, accountId, updatedAccount, credTokens.accessToken, credAccountId);
  }
  if (!result.error) {
    clearTokenAutomationError(accountId);
  }
  if (shouldRefreshView) {
    view.refresh();
  }
  const switched = warnQuota && account.isActive ? await maybeSwitchForActiveQuota(repo, view) : false;
  if (warnQuota) {
    if (switched) {
      return;
    }
    await maybeWarnForAccount(repo, accountId);
  }

  if (announce) {
    const copy = getCommandCopy();
    const label = formatAccountToastLabel(account);
    if (result.error) {
      void vscode.window.showWarningMessage(copy.failedToRefresh(label, result.error.message));
    } else {
      void vscode.window.showInformationMessage(copy.quotaRefreshed(label));
    }
  }
}

export async function refreshImportedAccountQuota(
  repo: AccountsRepository,
  accountId: string
): Promise<QuotaRefreshResult> {
  const account = await repo.getAccount(accountId);
  if (!account) {
    throw createError.accountNotFound(accountId);
  }

  const tokens = await repo.getTokens(accountId);
  if (!tokens) {
    throw createError.accountNotFound(account.email);
  }

  const result = await refreshQuota(account, tokens, true);
  const updatedAccount = await repo.updateQuota(
    accountId,
    result.quota,
    result.error,
    result.updatedTokens,
    result.updatedPlanType,
    result.updatedSubscriptionActiveUntil
  );
  // 后台异步刷新订阅到期时间
  void repo.refreshSubscriptionState(accountId, true).catch(() => undefined);
  if (!result.error && updatedAccount.quotaSummary) {
    const credTokens = result.updatedTokens ?? tokens;
    const credAccountId = updatedAccount.accountId ?? account.accountId ?? undefined;
    void syncResetCreditsSnapshot(repo, undefined, accountId, updatedAccount, credTokens.accessToken, credAccountId);
  }
  if (!result.error) {
    clearTokenAutomationError(accountId);
  }
  await maybeWarnForAccount(repo, accountId);
  return result;
}

async function syncResetCreditsSnapshot(
  repo: AccountsRepository,
  view: RefreshView | undefined,
  accountId: string,
  updatedAccount: CodexAccountRecord,
  accessToken: string,
  remoteAccountId?: string
): Promise<void> {
  try {
    const snapshot = await fetchResetCredits(accessToken, remoteAccountId);
    if (updatedAccount.quotaSummary) {
      updatedAccount.quotaSummary.resetCreditsAvailable = snapshot.availableCount;
      updatedAccount.quotaSummary.resetCreditsNextExpiresAt = snapshot.nextExpiresAt;
    }
    await repo
      .updateResetCreditsSnapshot(accountId, snapshot.availableCount, snapshot.nextExpiresAt)
      .catch(() => undefined);
    view?.refresh();
  } catch {
    return;
  }
}

export async function refreshSingleQuotaSafely(
  repo: AccountsRepository,
  view: RefreshView,
  accountId: string,
  options: { forceRefresh?: boolean } = {}
): Promise<void> {
  try {
    await refreshSingleQuota(repo, view, accountId, {
      announce: false,
      forceRefresh: options.forceRefresh ?? false,
      refreshView: false,
      warnQuota: false
    });
  } catch (error) {
    const account = await repo.getAccount(accountId);
    const label = account ? formatAccountToastLabel(account) : accountId;
    console.warn(`[codexAccounts] auto refresh failed for ${label}:`, error);
  }
}

export async function maybeWarnForActiveQuota(repo: AccountsRepository): Promise<void> {
  const accounts = await repo.listAccounts();
  const active = accounts.find((account) => account.isActive);
  if (!active) {
    return;
  }
  await maybeWarnForAccount(repo, active.id);
}

export async function maybeSwitchForActiveQuota(repo: AccountsRepository, view: RefreshView): Promise<boolean> {
  const config = getCodexAccountsConfiguration();
  if (isSeamlessSwitchEnabled(config) && isSeamlessSwitchQuotaBandsEnabled(config)) {
    return maybeSeamlessBalanceSwitchForActiveQuota(repo, view);
  }
  return maybeAutoSwitchForActiveQuota(repo, view);
}

export async function maybeSeamlessBalanceSwitchForActiveQuota(
  repo: AccountsRepository,
  view: RefreshView,
  options: SeamlessQuotaSwitchOptions = {}
): Promise<boolean> {
  if (seamlessSwitchInFlight) {
    return false;
  }

  const attempt = runSeamlessBalanceSwitchForActiveQuota(repo, view, options);
  seamlessSwitchInFlight = attempt;
  try {
    return await attempt;
  } finally {
    if (seamlessSwitchInFlight === attempt) {
      seamlessSwitchInFlight = undefined;
    }
  }
}

async function runSeamlessBalanceSwitchForActiveQuota(
  repo: AccountsRepository,
  view: RefreshView,
  options: SeamlessQuotaSwitchOptions
): Promise<boolean> {
  const config = getCodexAccountsConfiguration();
  if (
    !isSeamlessSwitchEnabled(config) ||
    !isSeamlessSwitchQuotaBandsEnabled(config) ||
    !config.get<boolean>(HOT_SWITCH_ENABLED, false)
  ) {
    return false;
  }
  if (options.trigger === "runtimeUsageLimit" && getSeamlessSwitchThreshold(config) === 0) {
    return false;
  }

  const accounts = await repo.listAccounts();
  const globallyActive = accounts.find((account) => account.isActive);
  const active = options.activeAccountId
    ? accounts.find((account) => account.id === options.activeAccountId)
    : globallyActive;
  if (
    options.trigger === "runtimeUsageLimit" &&
    options.activeAccountId &&
    globallyActive &&
    globallyActive.id !== options.activeAccountId
  ) {
    return convergeUsageLimitedRuntimeToGlobalAccount(view, globallyActive);
  }

  const now = Date.now();
  const activeCapability = active ? getBalanceQuotaCapability(active, now) : "unknown";
  // A disabled group only removes potential targets. Keep the currently active
  // account in this one decision so it can safely rotate out after reaching its
  // existing band/threshold condition instead of being forced away immediately.
  const scopedAccounts = active
    ? accounts.filter((account) => account.id === active.id || isAccountVisibleToSeamlessSwitch(account, config))
    : accounts;
  if (
    !active?.quotaSummary ||
    active.isHidden ||
    active.balancePoolEnabled !== true ||
    activeCapability === "unknown" ||
    scopedAccounts.filter((account) => account.balancePoolEnabled === true && !account.isHidden).length < 2
  ) {
    return false;
  }

  const lease = await repo.tryAcquireSchedulerLease("seamless-switch", SEAMLESS_SWITCH_LEASE_MS);
  if (!lease) {
    return false;
  }

  try {
    return await executeSeamlessBalanceSwitch({
      accounts: scopedAccounts,
      active,
      activeCapability,
      config,
      now,
      view,
      runtimeUsageLimit: options.trigger === "runtimeUsageLimit"
    });
  } finally {
    await lease.release();
  }
}

function isAccountVisibleToSeamlessSwitch(account: CodexAccountRecord, config: vscode.WorkspaceConfiguration): boolean {
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

async function executeSeamlessBalanceSwitch(params: {
  accounts: CodexAccountRecord[];
  active: CodexAccountRecord;
  activeCapability: ReturnType<typeof getBalanceQuotaCapability>;
  config: vscode.WorkspaceConfiguration;
  now: number;
  view: RefreshView;
  runtimeUsageLimit: boolean;
}): Promise<boolean> {
  const { accounts, active, activeCapability, config, now, view, runtimeUsageLimit } = params;
  const quotaBandSize = normalizeSeamlessQuotaBandSize(config.get<number>(SEAMLESS_QUOTA_BAND_SIZE, 20));
  const switchThreshold = getSeamlessSwitchThreshold(config);
  const thresholdEnabled = switchThreshold > 0;
  const activeIsFreeWindowed = isVerifiedFreeWindowedAccount(active, now);
  const hourlyThresholdReached =
    thresholdEnabled &&
    activeCapability === "windowed" &&
    (active.quotaSummary!.hourlyPercentage <= switchThreshold || runtimeUsageLimit);
  const weeklyThresholdReached =
    thresholdEnabled &&
    (active.quotaSummary!.weeklyPercentage <= switchThreshold || (runtimeUsageLimit && activeCapability === "reserve"));
  const thresholdSwitch = hourlyThresholdReached || weeklyThresholdReached;
  const thresholdQuota =
    weeklyThresholdReached && !hourlyThresholdReached ? "weekly" : hourlyThresholdReached ? "hourly" : undefined;
  const activeBand =
    activeCapability === "windowed" ? getFiveHourQuotaBand(active.quotaSummary!.hourlyPercentage, quotaBandSize) : 0;
  // Free accounts do not participate in ordinary band balancing. They only
  // move at the unified hard-switch threshold or from a structured runtime
  // usage-limit signal, so the chosen threshold has the same meaning for
  // Free, Plus, and reserve accounts.
  const bandDropped =
    activeCapability === "windowed" &&
    !activeIsFreeWindowed &&
    observeSeamlessQuotaBand(active.id, activeBand, quotaBandSize);
  if (!thresholdSwitch && !bandDropped) {
    return false;
  }

  const lastSelectedAt = getSeamlessSwitchRuntimeSnapshot().lastSelectedAt ?? {};
  const freeThresholdCandidate =
    thresholdSwitch && activeIsFreeWindowed
      ? selectFreeExhaustionCandidate({
          accounts,
          activeAccountId: active.id,
          switchThreshold,
          lastSelectedAt,
          now
        })
      : undefined;
  // If no Free peer passed the two-minute/safety checks, do not let the
  // ordinary 15-minute selector pick a stale Free peer. The required fallback
  // is the normal mixed pool (for example a Plus/reserve account), not a
  // second-best Free candidate whose five-hour view may already be obsolete.
  const normalSelectionAccounts =
    thresholdSwitch && activeIsFreeWindowed
      ? accounts.filter(
          (account) => !account.isHidden && (account.id === active.id || !isFreePlanType(account.planType))
        )
      : accounts;
  const next =
    freeThresholdCandidate ??
    selectBalanceCandidate({
      accounts: normalSelectionAccounts,
      activeAccountId: active.id,
      activeBand,
      quotaBandSize,
      switchThreshold,
      thresholdQuota,
      forceRecoveryMode: thresholdSwitch && runtimeUsageLimit,
      lastSelectedAt,
      now
    });
  if (!next) {
    return false;
  }

  const runtimeOutcome = (await (thresholdSwitch
    ? view.switchRuntimeAccount?.(next.id, {
        gracePeriodMs: 0,
        longTurnPolicy: "interruptAndContinue",
        recoverRecentUsageLimitedTurns: true
      })
    : view.switchRuntimeAccount?.(next.id))) ?? { status: "unavailable" as const };
  const reason = formatSeamlessSwitchReason({
    freeThresholdCandidate,
    switchThreshold,
    thresholdQuota,
    runtimeUsageLimit
  });
  if (runtimeOutcome.status === "deferred") {
    console.info(
      `[codexAccounts] seamless ${reason}switch deferred with ${runtimeOutcome.activeTurns} active turn(s): ${runtimeOutcome.reason}`
    );
    return false;
  }
  if (runtimeOutcome.status === "failed") {
    console.warn(`[codexAccounts] seamless ${reason}switch failed safely: ${runtimeOutcome.message}`);
    return false;
  }
  if (runtimeOutcome.status === "unavailable") {
    console.warn("[codexAccounts] seamless quota-band switch skipped because the no-reload runtime is unavailable");
    return false;
  }

  if (activeCapability === "windowed") {
    acknowledgeSeamlessQuotaBand(active.id, activeBand, quotaBandSize);
  }
  const nextCapability = getBalanceQuotaCapability(next, now);
  recordSeamlessSelection(
    next.id,
    nextCapability === "windowed"
      ? getFiveHourQuotaBand(next.quotaSummary!.hourlyPercentage, quotaBandSize)
      : undefined,
    quotaBandSize
  );
  view.markObservedAuthIdentity?.(next.id);
  view.refresh();
  return true;
}

async function convergeUsageLimitedRuntimeToGlobalAccount(
  view: RefreshView,
  globallyActive: CodexAccountRecord
): Promise<boolean> {
  const runtimeOutcome = (await view.switchRuntimeAccount?.(globallyActive.id, {
    gracePeriodMs: 0,
    longTurnPolicy: "interruptAndContinue",
    recoverRecentUsageLimitedTurns: true
  })) ?? { status: "unavailable" as const };
  if (runtimeOutcome.status !== "switched") {
    if (runtimeOutcome.status === "failed") {
      console.warn(`[codexAccounts] seamless usage-limit convergence failed safely: ${runtimeOutcome.message}`);
    }
    return false;
  }

  view.markObservedAuthIdentity?.(globallyActive.id);
  view.refresh();
  return true;
}

function formatSeamlessSwitchReason(params: {
  freeThresholdCandidate?: CodexAccountRecord;
  switchThreshold: number;
  thresholdQuota?: "hourly" | "weekly";
  runtimeUsageLimit: boolean;
}): string {
  if (params.freeThresholdCandidate) {
    return params.runtimeUsageLimit
      ? "Free usage-limit priority "
      : `Free ${params.switchThreshold}% threshold priority `;
  }
  if (params.runtimeUsageLimit) {
    return "usage-limit recovery ";
  }
  if (params.thresholdQuota) {
    return `${params.thresholdQuota} ${params.switchThreshold}% threshold `;
  }
  return "quota-band ";
}

export async function maybeAutoSwitchForActiveQuota(repo: AccountsRepository, view: RefreshView): Promise<boolean> {
  const config = getCodexAccountsConfiguration();
  if (!config.get<boolean>(AUTO_SWITCH_ENABLED, false)) {
    return false;
  }

  const hourlyThreshold = normalizeAutoSwitchThreshold(config.get<number>(AUTO_SWITCH_HOURLY_THRESHOLD, 20));
  const weeklyThreshold = normalizeAutoSwitchThreshold(config.get<number>(AUTO_SWITCH_WEEKLY_THRESHOLD, 20));
  const hourlyQuotaControlEnabled = config.get<boolean>(HOURLY_QUOTA_CONTROL_ENABLED, false);
  const accounts = await repo.listAccounts();
  const active = accounts.find((account) => account.isActive);
  if (!active?.quotaSummary || active.quotaError || active.isHidden) {
    return false;
  }
  if (isAutoSwitchLocked(active.id)) {
    return false;
  }

  const activeHourlyTriggered =
    hourlyQuotaControlEnabled &&
    hasComparableHourlyWindow(active) &&
    active.quotaSummary.hourlyPercentage <= hourlyThreshold;
  const activeWeeklyTriggered =
    hasComparableWeeklyWindow(active) && active.quotaSummary.weeklyPercentage <= weeklyThreshold;
  const shouldSwitch = activeHourlyTriggered || activeWeeklyTriggered;
  if (!shouldSwitch) {
    return false;
  }

  const candidates = accounts
    .filter(
      (account) =>
        !account.isActive &&
        !account.isHidden &&
        !!account.quotaSummary &&
        !account.quotaError &&
        (!activeHourlyTriggered ||
          (hasComparableHourlyWindow(account) && account.quotaSummary.hourlyPercentage > hourlyThreshold)) &&
        (!activeWeeklyTriggered ||
          (hasComparableWeeklyWindow(account) && account.quotaSummary.weeklyPercentage > weeklyThreshold))
    )
    .sort(compareAutoSwitchCandidate(hourlyThreshold, weeklyThreshold, activeHourlyTriggered, activeWeeklyTriggered));

  const next = candidates[0];
  if (!next) {
    return false;
  }

  const matchedRules = buildMatchedRules();
  await repo.switchAccount(next.id);
  clearAutoSwitchLock(active.id);
  recordAutoSwitchReason({
    fromAccountId: active.id,
    fromEmail: active.email,
    toAccountId: next.id,
    toEmail: next.email,
    trigger:
      activeHourlyTriggered && activeWeeklyTriggered
        ? "hourly_and_weekly"
        : activeHourlyTriggered
          ? "hourly"
          : "weekly",
    matchedRules,
    hourlyThreshold,
    weeklyThreshold,
    createdAt: Date.now()
  });
  view.markObservedAuthIdentity?.(next.id);
  view.refresh();

  if (!needsWindowReloadForAccount(next.id)) {
    return true;
  }

  if (config.get<boolean>(AUTO_SWITCH_RELOAD_WINDOW_ENABLED, false)) {
    await handleCodexAppRestartPreference({ allowManualPrompt: false });
    await autoReloadWindowForAccount(next.id);
    return true;
  }

  const copy = getDashboardCopy(getLanguage());
  const commandCopy = getCommandCopy();
  const choice = await vscode.window.showInformationMessage(
    `${copy.autoSwitchToastSwitched.replace("{account}", formatAccountToastLabel(next))} (${formatAutoSwitchReasonText(
      matchedRules,
      copy
    )}) ${commandCopy.switchedAndAskReload(next.email)}`,
    commandCopy.reloadNow,
    commandCopy.later
  );
  if (choice === commandCopy.reloadNow) {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
  return true;
}

export async function maybeWarnForAccount(repo: AccountsRepository, accountId: string): Promise<void> {
  const config = getCodexAccountsConfiguration();
  if (!config.get<boolean>(QUOTA_WARNING_ENABLED, false)) {
    quotaWarningCounts.clear();
    return;
  }

  const threshold = normalizeQuotaWarningThreshold(config.get<number>(QUOTA_WARNING_THRESHOLD, 20));
  const hourlyQuotaControlEnabled = config.get<boolean>(HOURLY_QUOTA_CONTROL_ENABLED, false);
  const account = await repo.getAccount(accountId);
  if (!account?.isActive || !account.quotaSummary) {
    return;
  }

  const copy = getQuotaWarningCopy();
  if (!hourlyQuotaControlEnabled) {
    clearQuotaWarningCountsForDimension("hourly");
  }

  const checks: Array<{ dimension: "hourly" | "weekly"; label: string; value: number }> = [];
  if (hourlyQuotaControlEnabled && hasComparableHourlyWindow(account)) {
    checks.push({ dimension: "hourly", label: copy.hourlyLabel, value: account.quotaSummary.hourlyPercentage });
  } else {
    clearQuotaWarningCount(account.id, "hourly");
  }
  if (hasComparableWeeklyWindow(account)) {
    checks.push({ dimension: "weekly", label: copy.weeklyLabel, value: account.quotaSummary.weeklyPercentage });
  } else {
    clearQuotaWarningCount(account.id, "weekly");
  }

  for (const check of checks) {
    const warnKey = `${account.id}:${check.dimension}:${threshold}`;
    if (typeof check.value !== "number" || check.value > threshold) {
      quotaWarningCounts.delete(warnKey);
      continue;
    }

    const warningCount = quotaWarningCounts.get(warnKey) ?? 0;
    if (warningCount >= MAX_WARNINGS_PER_CYCLE) {
      continue;
    }

    quotaWarningCounts.set(warnKey, warningCount + 1);
    void vscode.window
      .showWarningMessage(
        copy.message(formatAccountToastLabel(account), check.label, check.value, threshold),
        copy.dismiss,
        copy.switchNow
      )
      .then((selection) => {
        if (selection === copy.switchNow) {
          void vscode.commands.executeCommand("codexAccounts.switchAccount");
        }
      });
  }
}

function clearQuotaWarningCountsForDimension(dimension: "hourly" | "weekly"): void {
  for (const key of quotaWarningCounts.keys()) {
    if (key.includes(`:${dimension}:`)) {
      quotaWarningCounts.delete(key);
    }
  }
}

function clearQuotaWarningCount(accountId: string, dimension: "hourly" | "weekly"): void {
  const prefix = `${accountId}:${dimension}:`;
  for (const key of quotaWarningCounts.keys()) {
    if (key.startsWith(prefix)) {
      quotaWarningCounts.delete(key);
    }
  }
}

export function formatAccountToastLabel(account: CodexAccountRecord): string {
  const team = account.accountName?.trim();
  if (team) {
    return `${team} · ${account.email}`;
  }
  return account.email;
}

function compareAutoSwitchCandidate(
  hourlyThreshold: number,
  weeklyThreshold: number,
  activeHourlyTriggered: boolean,
  activeWeeklyTriggered: boolean
) {
  return (left: CodexAccountRecord, right: CodexAccountRecord): number => {
    const leftScore = getAutoSwitchScore(
      left,
      hourlyThreshold,
      weeklyThreshold,
      activeHourlyTriggered,
      activeWeeklyTriggered
    );
    const rightScore = getAutoSwitchScore(
      right,
      hourlyThreshold,
      weeklyThreshold,
      activeHourlyTriggered,
      activeWeeklyTriggered
    );
    return rightScore - leftScore;
  };
}

function getAutoSwitchScore(
  account: CodexAccountRecord,
  hourlyThreshold: number,
  weeklyThreshold: number,
  activeHourlyTriggered: boolean,
  activeWeeklyTriggered: boolean
): number {
  const quota = account.quotaSummary;
  if (!quota) {
    return Number.NEGATIVE_INFINITY;
  }

  const margins: number[] = [];
  if (activeHourlyTriggered && hasComparableHourlyWindow(account)) {
    margins.push(quota.hourlyPercentage - hourlyThreshold);
  }
  if (activeWeeklyTriggered && hasComparableWeeklyWindow(account)) {
    margins.push(quota.weeklyPercentage - weeklyThreshold);
  }
  if (!margins.length) {
    return Number.NEGATIVE_INFINITY;
  }

  const safetyFloor = Math.min(...margins);
  const quotaTotal = margins.reduce((sum, margin) => sum + margin, 0);
  const freshness = account.lastQuotaAt ?? 0;

  return safetyFloor * 1_000_000 + quotaTotal * 1000 + freshness / 1_000_000_000_000;
}

function hasComparableHourlyWindow(account: CodexAccountRecord): boolean {
  const quota = account.quotaSummary;
  if (!quota?.hourlyWindowPresent) {
    return false;
  }

  const windowMinutes = quota.hourlyWindowMinutes;
  return (
    typeof quota.hourlyPercentage === "number" &&
    Number.isFinite(quota.hourlyPercentage) &&
    typeof windowMinutes === "number" &&
    windowMinutes > 0 &&
    windowMinutes <= 360
  );
}

function hasComparableWeeklyWindow(account: CodexAccountRecord): boolean {
  const quota = account.quotaSummary;
  if (!quota?.weeklyWindowPresent) {
    return false;
  }

  const windowMinutes = quota.weeklyWindowMinutes;
  return (
    typeof quota.weeklyPercentage === "number" &&
    Number.isFinite(quota.weeklyPercentage) &&
    typeof windowMinutes === "number" &&
    windowMinutes >= 1440
  );
}

function buildMatchedRules(): string[] {
  return ["quota"];
}

function formatAutoSwitchReasonText(matchedRules: string[], copy: ReturnType<typeof getDashboardCopy>): string {
  const labels = matchedRules.map(() => copy.autoSwitchRuleQuota);
  return labels.join(" · ");
}

import {
  DashboardAccountViewModel,
  DashboardLocalUsageViewModel,
  DashboardMetricViewModel,
  DashboardState
} from "../../domain/dashboard/types";
import { findAccountTokenUsageWindow, type AccountTokenUsageSnapshot } from "../../services/localUsageAnalytics";
import { AccountsRepository } from "../../storage";
import { ExtensionSettingsStore } from "../../infrastructure/config/extensionSettings";
import { formatAccountStructure, formatAuthProvider, formatPlanType, getDashboardCopy } from "./copy";
import {
  CodexAccountRecord,
  CodexCreditsSummary,
  CodexTokens,
  isSub2ApiAccount,
  type CodexAnnouncementState
} from "../../core/types";
import { resolveCodexAppLaunchPath } from "../../utils/codexApp";
import { getCurrentWindowRuntimeAccountId } from "../../presentation/workbench/windowRuntimeAccount";
import { getQuotaIssueKind } from "../../utils/quotaIssue";
import { getTokenAutomationSnapshot } from "../../presentation/workbench/tokenAutomationState";
import { getAutoSwitchRuntimeSnapshot } from "../../presentation/workbench/autoSwitchState";
import { getAccountAutomationState, isHealthDismissed, resolveAccountHealth } from "../accounts/health";
import { getActiveManagerIntegrationHost } from "../../integrations";
import { isQuotaCountdownStartAvailable } from "../accounts/quotaCountdown";

export async function buildDashboardState(
  repo: AccountsRepository,
  settingsStore: ExtensionSettingsStore,
  logoUri: string,
  announcements: CodexAnnouncementState,
  localUsage?: DashboardLocalUsageViewModel,
  accountTokenUsage?: AccountTokenUsageSnapshot
): Promise<DashboardState> {
  const lang = settingsStore.resolveLanguage();
  const baseSettings = settingsStore.getDashboardSettings();
  const settings = {
    ...baseSettings,
    resolvedCodexAppPath: (await resolveCodexAppLaunchPath(baseSettings.codexAppPath)) ?? ""
  };
  const copy = getDashboardCopy(lang);
  const currentWindowAccountId = getCurrentWindowRuntimeAccountId();
  const tokenAutomation = getTokenAutomationSnapshot();
  const autoSwitchRuntime = getAutoSwitchRuntimeSnapshot();
  const integrationHost = getActiveManagerIntegrationHost();
  const integrations = integrationHost?.getDashboardIntegrations();
  const integrationSettings = integrationHost?.getIntegrationSettings();
  const providerCards = new Map(
    integrationHost?.getVirtualAccountCards().map(({ accountId, card }) => [accountId, card] as const) ?? []
  );
  const visibleVirtualAccountIds = integrationHost?.getVisibleVirtualAccountIds();
  const indexHealth = await repo.getIndexHealthSummary();
  const accounts = (await repo.listAccounts()).filter(
    (account) =>
      !isSub2ApiAccount(account) ||
      visibleVirtualAccountIds === undefined ||
      visibleVirtualAccountIds.has(account.id)
  );
  const tokenEntries = await Promise.all(
    accounts.map(async (account) =>
      [account.id, isSub2ApiAccount(account) ? undefined : await repo.getTokens(account.id, { syncExternal: false })] as const
    )
  );
  const tokensByAccountId = new Map(tokenEntries);
  const accountViewStateById = new Map(
    accounts.map((account) => {
      const tokens = tokensByAccountId.get(account.id);
      const health: ReturnType<typeof resolveAccountHealth> = isSub2ApiAccount(account)
        ? { kind: "healthy", issueKey: "virtual" }
        : resolveAccountHealth(account, tokens, tokenAutomation);
      return [
        account.id,
        {
          tokens,
          health,
          dismissedHealth: isHealthDismissed(account, health),
          automationState: getAccountAutomationState(tokenAutomation, account.id),
          healthPriority: getHealthPriority(health)
        }
      ] as const;
    })
  );
  const sortedAccounts = sortDashboardAccounts(accounts, currentWindowAccountId, accountViewStateById);
  const extraSelectedCount = sortedAccounts.filter((account) => !account.isActive && account.showInStatusBar).length;

  return {
    lang,
    panelTitle: copy.panelTitle,
    brandSub: copy.brandSub,
    logoUri,
    settings,
    copy,
    tokenAutomation: {
      enabled: settings.backgroundTokenRefreshEnabled,
      lastCheckAt: tokenAutomation.lastSweepAt,
      nextCheckAt: tokenAutomation.nextSweepAt,
      lastRefreshAt: tokenAutomation.lastSuccessAt,
      lastFailureMessage: tokenAutomation.lastFailureMessage
    },
    announcements,
    indexHealth,
    localUsage,
    integrations,
    integrationSettings,
    accounts: sortedAccounts.map((account) =>
      mapAccount(
        account,
        accountViewStateById.get(account.id),
        extraSelectedCount,
        lang,
        copy,
        currentWindowAccountId,
        autoSwitchRuntime,
        accountTokenUsage,
        providerCards.get(account.id)
      )
    )
  };
}

export function sortDashboardAccounts<
  T extends Pick<CodexAccountRecord, "id" | "isActive" | "createdAt" | "email"> &
    Partial<Pick<CodexAccountRecord, "providerActive">>
>(
  accounts: readonly T[],
  currentWindowAccountId?: string,
  accountViewStateById?: Map<string, { healthPriority: number }>
): T[] {
  return [...accounts].sort(
    (a, b) =>
      Number(b.id === currentWindowAccountId) - Number(a.id === currentWindowAccountId) ||
      Number(b.isActive || b.providerActive) - Number(a.isActive || a.providerActive) ||
      (accountViewStateById?.get(b.id)?.healthPriority ?? 0) - (accountViewStateById?.get(a.id)?.healthPriority ?? 0) ||
      b.createdAt - a.createdAt ||
      a.email.localeCompare(b.email)
  );
}

function mapAccount(
  account: CodexAccountRecord,
  viewState:
    | {
        tokens: Awaited<ReturnType<AccountsRepository["getTokens"]>>;
        health: ReturnType<typeof resolveAccountHealth>;
        dismissedHealth: boolean;
        automationState: ReturnType<typeof getAccountAutomationState>;
      }
    | undefined,
  extraSelectedCount: number,
  lang: DashboardState["lang"],
  copy: DashboardState["copy"],
  currentWindowAccountId?: string,
  autoSwitchRuntime?: ReturnType<typeof getAutoSwitchRuntimeSnapshot>,
  accountTokenUsage?: AccountTokenUsageSnapshot,
  providerCard?: DashboardAccountViewModel["providerCard"]
): DashboardAccountViewModel {
  const virtual = isSub2ApiAccount(account);
  const canToggleStatusBar = account.isActive || account.providerActive
    ? false
    : Boolean(account.showInStatusBar) || extraSelectedCount < 2;
  const health: ReturnType<typeof resolveAccountHealth> = virtual
    ? { kind: "healthy", issueKey: "virtual" }
    : viewState?.health ?? resolveAccountHealth(account, viewState?.tokens, getTokenAutomationSnapshot());
  const dismissedHealth = viewState?.dismissedHealth ?? isHealthDismissed(account, health);
  const automationState = viewState?.automationState;
  const subscription = virtual
    ? { text: "", title: "" }
    : resolveSubscriptionDisplay(account, viewState?.tokens, copy, lang);
  const resetCreditsAvailable = virtual ? undefined : account.quotaSummary?.resetCreditsAvailable;
  const resetCreditsNextExpiresAt = virtual ? undefined : account.quotaSummary?.resetCreditsNextExpiresAt;
  if ((resetCreditsAvailable ?? 0) > 0 && resetCreditsNextExpiresAt == null) {
    console.info("[codexAccounts] dashboard state missing reset credits expiry", {
      accountId: account.id,
      remoteAccountId: account.accountId,
      resetCreditsAvailable,
      lastQuotaAt: account.lastQuotaAt ?? null,
      updatedAt: account.updatedAt
    });
  }

  return {
    quotaIssueKind: virtual ? undefined : getQuotaIssueKind(account.quotaError),
    id: account.id,
    accountKind: account.accountKind,
    manualOnly: virtual || account.manualOnly,
    providerActive: account.providerActive,
    displayName: virtual ? "Sub2API Gateway" : account.accountName?.trim() ?? account.email,
    email: account.email,
    authMode: virtual ? undefined : account.authMode ?? "chatgpt",
    accountName: account.accountName,
    tags: [...(account.tags ?? [])],
    authProviderLabel: virtual ? "Gateway" : formatAuthProvider(account.authProvider, lang),
    accountStructureLabel: virtual ? "" : formatAccountStructure(account.accountStructure, lang),
    workspaceLabel: virtual ? "Sub2API Gateway" : resolveWorkspaceDisplay(account),
    isTeamWorkspace: virtual ? false : isTeamWorkspace(account),
    subscriptionText: subscription.text,
    subscriptionTitle: subscription.title,
    subscriptionColor: subscription.color,
    addMethodLabel: virtual ? "Gateway | 手动" : `${formatAddMethod(account.addedVia, lang)} | ${formatAuthProvider(account.authProvider, lang)}`,
    addedAtLabel: formatAddedAt(account.createdAt, copy.never),
    statusColor: virtual ? "var(--accent-blue)" : account.isActive ? "var(--accent-green)" : health.kind === "healthy" ? undefined : "#ef4444",
    planTypeLabel: virtual ? "Sub2API Gateway" : formatPlanTypeWithQuota(account, lang),
    planType: virtual ? undefined : account.planType,
    creditsText: virtual ? undefined : formatCreditsText(account.quotaSummary?.credits, lang),
    userId: virtual ? undefined : account.userId,
    accountId: virtual ? undefined : account.accountId,
    organizationId: virtual ? undefined : account.organizationId,
    isActive: account.isActive,
    isHidden: Boolean(account.isHidden),
    accountGroup: account.accountGroup,
    isCurrentWindowAccount: virtual ? Boolean(account.providerActive) : account.id === currentWindowAccountId,
    balancePoolEnabled: virtual ? false : Boolean(account.balancePoolEnabled),
    showInStatusBar: Boolean(account.showInStatusBar),
    canToggleStatusBar,
    statusToggleTitle: canToggleStatusBar
      ? account.showInStatusBar
        ? copy.statusToggleTipChecked
        : copy.statusToggleTip
      : copy.statusLimitTip,
    hasQuota402: virtual ? false : hasQuota402(account),
    healthKind: health.kind,
    healthLabel: formatHealthLabel(health.kind, copy),
    healthMessage: health.message,
    healthIssueKey: health.issueKey,
    dismissedHealth,
    lastTokenCheckAt: virtual ? undefined : automationState?.lastCheckAt,
    lastTokenRefreshAt: virtual ? undefined : automationState?.lastRefreshAt,
    lastTokenRefreshError: virtual ? undefined : automationState?.lastError,
    lastQuotaAt: virtual ? undefined : account.lastQuotaAt,
    resetCreditsAvailable,
    resetCreditsNextExpiresAt,
    quotaCountdownStartAvailable: virtual ? false : isQuotaCountdownStartAvailable(account),
    tokenUsage: virtual ? undefined : resolveAccountTokenUsage(account, accountTokenUsage),
    autoSwitchLockedUntil:
      autoSwitchRuntime?.lockedAccountId === account.id ? autoSwitchRuntime.lockedUntil : undefined,
    providerCard: virtual ? providerCard : undefined,
    metrics: virtual ? [] : buildMetrics(account, copy)
  };
}

function resolveAccountTokenUsage(
  account: CodexAccountRecord,
  snapshot: AccountTokenUsageSnapshot | undefined
): DashboardAccountViewModel["tokenUsage"] {
  if (!snapshot) {
    return undefined;
  }

  const quota = account.quotaSummary;
  const quotaWindow =
    quota?.hourlyWindowPresent && quota.hourlyResetTime != null
      ? { window: "hourly" as const, resetAt: quota.hourlyResetTime }
      : quota?.weeklyWindowPresent && quota.weeklyResetTime != null
        ? { window: "weekly" as const, resetAt: quota.weeklyResetTime }
        : undefined;
  if (!quotaWindow) {
    return undefined;
  }

  const observed = findAccountTokenUsageWindow(snapshot, account.id, quotaWindow.window, quotaWindow.resetAt);
  if (observed) {
    return {
      ...observed,
      calculatedAt: snapshot.calculatedAt,
      status: "tracking"
    };
  }

  return {
    window: quotaWindow.window,
    resetAt: quotaWindow.resetAt,
    calculatedAt: snapshot.calculatedAt,
    status: snapshot.status === "loading" ? "loading" : "waiting",
    byModel: [],
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function buildMetrics(account: CodexAccountRecord, copy: DashboardState["copy"]): DashboardMetricViewModel[] {
  const quota = account.quotaSummary;
  const metrics: DashboardMetricViewModel[] = [
    {
      key: "hourly",
      label: copy.hourlyLabel,
      percentage: quota?.hourlyPercentage,
      resetAt: quota?.hourlyResetTime,
      windowMinutes: quota?.hourlyWindowMinutes,
      requestsLeft: quota?.hourlyRequestsLeft,
      requestsLimit: quota?.hourlyRequestsLimit,
      visible: quota ? Boolean(quota.hourlyWindowPresent) : true
    }
  ];

  metrics.push({
    key: "weekly",
    label: copy.weeklyLabel,
    percentage: quota?.weeklyPercentage,
    resetAt: quota?.weeklyResetTime,
    windowMinutes: quota?.weeklyWindowMinutes,
    requestsLeft: quota?.weeklyRequestsLeft,
    requestsLimit: quota?.weeklyRequestsLimit,
    visible: quota ? Boolean(quota.weeklyWindowPresent) : true
  });

  for (const [index, limit] of quota?.additionalRateLimits?.entries() ?? []) {
    if (limit.hourlyWindowPresent) {
      metrics.push({
        key: `additional-${index}-hourly`,
        label: `${limit.limitName} ${copy.hourlyLabel}`,
        percentage: limit.hourlyPercentage,
        resetAt: limit.hourlyResetTime,
        windowMinutes: limit.hourlyWindowMinutes,
        requestsLeft: limit.hourlyRequestsLeft,
        requestsLimit: limit.hourlyRequestsLimit,
        visible: true
      });
    }
    if (limit.weeklyWindowPresent) {
      metrics.push({
        key: `additional-${index}-weekly`,
        label: `${limit.limitName} ${copy.weeklyLabel}`,
        percentage: limit.weeklyPercentage,
        resetAt: limit.weeklyResetTime,
        windowMinutes: limit.weeklyWindowMinutes,
        requestsLeft: limit.weeklyRequestsLeft,
        requestsLimit: limit.weeklyRequestsLimit,
        visible: true
      });
    }
  }

  return metrics;
}

function hasQuota402(account: CodexAccountRecord): boolean {
  return getQuotaIssueKind(account.quotaError) === "disabled";
}

function formatHealthLabel(kind: DashboardAccountViewModel["healthKind"], copy: DashboardState["copy"]): string {
  switch (kind) {
    case "expiring":
      return copy.tokenAutomationExpiring;
    case "refresh_failed":
      return copy.tokenAutomationRefreshFailed;
    case "reauthorize":
      return copy.tokenAutomationReauthorize;
    case "disabled":
      return copy.tokenAutomationDisabled;
    case "quota":
      return copy.tokenAutomationQuota;
    default:
      return copy.tokenAutomationHealthy;
  }
}

function resolveWorkspaceDisplay(account: CodexAccountRecord): string {
  if (!isTeamWorkspace(account)) {
    return "Personal";
  }

  const name = account.accountName?.trim();
  return name ? `Team | ${name}` : "Team";
}

function isTeamWorkspace(account: CodexAccountRecord): boolean {
  const structure = account.accountStructure?.trim().toLowerCase();
  return Boolean(structure && structure !== "personal");
}

export function resolveSubscriptionDisplay(
  account: CodexAccountRecord,
  tokens: CodexTokens | undefined,
  copy: DashboardState["copy"],
  lang: DashboardState["lang"]
): { text: string; title: string; color?: string } {
  const timestampMs = readSubscriptionTimestampMs(account, tokens);
  if (!timestampMs) {
    return {
      text: copy.unknown,
      title: copy.unknown
    };
  }

  const diffMs = timestampMs - Date.now();
  const dateText = formatSubscriptionDate(new Date(timestampMs));
  const days = Math.max(0, Math.ceil(diffMs / 86_400_000));
  const dayUnit = lang === "zh-hant" || lang === "zh" ? "天" : "d";
  const text =
    lang === "zh" || lang === "zh-hant" ? `${dateText}（${days} ${dayUnit}）` : `${dateText} (${days}${dayUnit})`;
  const color = diffMs <= 3 * 86_400_000 ? "#ef4444" : diffMs <= 10 * 86_400_000 ? "#f59e0b" : "var(--accent-green)";

  return {
    text,
    title: text,
    color
  };
}

function readSubscriptionTimestampMs(account: CodexAccountRecord, tokens: CodexTokens | undefined): number | undefined {
  const idAuth = getOpenAiAuthClaims(tokens?.idToken);
  const accessAuth = getOpenAiAuthClaims(tokens?.accessToken);
  const raw = normalizeSubscriptionValue(
    account.subscriptionActiveUntil ??
      idAuth?.["chatgpt_subscription_active_until"] ??
      accessAuth?.["chatgpt_subscription_active_until"]
  );
  if (!raw) {
    return undefined;
  }

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatPlanTypeWithQuota(account: CodexAccountRecord, lang: DashboardState["lang"]): string {
  const base = formatPlanType(account.planType, lang);
  const normalized = account.planType?.trim().toLowerCase();
  if (!normalized?.includes("pro")) {
    return base;
  }

  const multiplier = inferProQuotaMultiplier(account);
  return multiplier ? `Pro ${multiplier}` : base;
}

function formatCreditsText(credits: CodexCreditsSummary | undefined, lang: DashboardState["lang"]): string | undefined {
  if (!credits) {
    return undefined;
  }

  const zh = lang === "zh" || lang === "zh-hant";
  const value = credits.unlimited
    ? zh
      ? "无限"
      : "Unlimited"
    : credits.balance || (credits.hasCredits ? (zh ? "可用" : "Available") : "0");
  const label = zh ? "剩余额度" : "Credits left";
  return `${label}: ${value}`;
}

function inferProQuotaMultiplier(account: CodexAccountRecord): "5x" | "20x" | undefined {
  const signals = collectQuotaPlanSignals(account.quotaSummary?.rawData);
  if (account.planType) {
    signals.unshift(account.planType);
  }

  let saw5x = false;
  let saw20x = false;
  for (const signal of signals) {
    const normalized = signal.toLowerCase();
    if (/(^|[^a-z0-9])(?:pro[_\s-]*)?20\s*x([^a-z0-9]|$)/.test(normalized)) {
      saw20x = true;
    }
    if (/(^|[^a-z0-9])(?:pro[_\s-]*)?5\s*x([^a-z0-9]|$)/.test(normalized)) {
      saw5x = true;
    }
  }

  return saw20x ? "20x" : saw5x ? "5x" : undefined;
}

function collectQuotaPlanSignals(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) {
    return [];
  }

  if (typeof value === "string") {
    return [value];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectQuotaPlanSignals(item, depth + 1));
  }

  if (typeof value !== "object") {
    return [];
  }

  const signals: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      signals.push(`${key}:${entry}`);
    }
    signals.push(...collectQuotaPlanSignals(entry, depth + 1));
  }
  return signals;
}

function getOpenAiAuthClaims(token: string | undefined): Record<string, unknown> | undefined {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"];
  return auth && typeof auth === "object" && !Array.isArray(auth) ? (auth as Record<string, unknown>) : undefined;
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  const raw = token?.trim();
  if (!raw) {
    return undefined;
  }

  try {
    const payload = raw.split(".")[1];
    if (!payload) {
      return undefined;
    }
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normalizeSubscriptionValue(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of [
      "value",
      "timestamp",
      "ts",
      "seconds",
      "sec",
      "unix",
      "epoch",
      "epoch_seconds",
      "epochSeconds"
    ]) {
      const normalized = normalizeSubscriptionValue(record[key]);
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

function formatSubscriptionDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatAddedAt(epochMs: number | undefined, fallback: string): string {
  if (!epochMs) {
    return fallback;
  }

  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatAddMethod(value: string | undefined, lang: DashboardState["lang"]): string {
  const normalized = value?.trim().toLowerCase();
  const zh = lang === "zh" || lang === "zh-hant";
  switch (normalized) {
    case "local":
      return zh ? "本地导入" : "Local import";
    case "json":
      return zh ? "JSON导入" : "JSON import";
    case "oauth":
      return zh ? "OAuth授权" : "OAuth";
    case "token":
      return zh ? "Token导入" : "Token import";
    case "apikey":
      return zh ? "API Key导入" : "API key import";
    default:
      return zh ? "未知来源" : "Unknown source";
  }
}

function getHealthPriority(health: ReturnType<typeof resolveAccountHealth>): number {
  switch (health.kind) {
    case "reauthorize":
      return 5;
    case "disabled":
      return 4;
    case "refresh_failed":
      return 3;
    case "quota":
      return 2;
    case "expiring":
      return 1;
    default:
      return 0;
  }
}

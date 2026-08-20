import type { DashboardLanguage, DashboardLanguageOption } from "../../localization/languages";
import type {
  CodexAnnouncementState,
  CodexImportPreviewSummary,
  CodexImportResultSummary,
  CodexIndexHealthSummary,
  CodexAccountGroup,
  SeamlessQuotaBandSize,
  SeamlessSwitchThreshold
} from "../../core/types";

/** Default number of account cards shown on the Dashboard's first page. */
export const DASHBOARD_ACCOUNTS_PAGE_SIZE = 10;
/** Keep automatic quota refresh bounded independently of the UI page-size preference. */
export const DASHBOARD_AUTOMATIC_REFRESH_PAGE_SIZE = 50;
export const DASHBOARD_ACCOUNT_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
export type DashboardAccountPageSize = (typeof DASHBOARD_ACCOUNT_PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_WEEKLY_QUOTA_HIDE_THRESHOLD = 3;
export const DEFAULT_WEEKLY_QUOTA_UNHIDE_THRESHOLD = 90;

export type DashboardSettingKey =
  | "dashboardTheme"
  | "localUsageDefaultRange"
  | "localUsageEnabledRanges"
  | "localUsageShowEquivalentPrice"
  | "codexAppRestartEnabled"
  | "codexAppRestartMode"
  | "backgroundTokenRefreshEnabled"
  | "autoRefreshMinutes"
  | "autoSwitchEnabled"
  | "seamlessSwitchEnabled"
  | "seamlessSwitchQuotaBandsEnabled"
  | "seamlessSwitchLowQuotaEnabled"
  | "seamlessSwitchQuotaBandSize"
  | "seamlessSwitchThreshold"
  | "seamlessSwitchGroupAVisible"
  | "seamlessSwitchGroupBVisible"
  | "seamlessSwitchGroupCVisible"
  | "hotSwitchGraceSeconds"
  | "hotSwitchLongTurnPolicy"
  | "hourlyQuotaControlEnabled"
  | "autoSwitchReloadWindowEnabled"
  | "autoSwitchHourlyThreshold"
  | "autoSwitchWeeklyThreshold"
  | "hideWeeklyQuotaThreshold"
  | "unhideWeeklyQuotaThreshold"
  | "autoSwitchLockMinutes"
  | "quotaWarningEnabled"
  | "quotaWarningThreshold"
  | "quotaGreenThreshold"
  | "quotaYellowThreshold"
  | "debugNetwork"
  | "displayLanguage";

export interface DashboardSettings {
  dashboardTheme: DashboardThemeOption;
  localUsageDefaultRange: DashboardLocalUsageRange;
  localUsageEnabledRanges: DashboardLocalUsageRange[];
  localUsageShowEquivalentPrice: boolean;
  codexAppRestartEnabled: boolean;
  codexAppRestartMode: "auto" | "manual";
  backgroundTokenRefreshEnabled: boolean;
  autoRefreshMinutes: number;
  autoSwitchEnabled: boolean;
  hotSwitchEnabled: boolean;
  seamlessSwitchEnabled: boolean;
  seamlessSwitchQuotaBandsEnabled: boolean;
  seamlessSwitchLowQuotaEnabled: boolean;
  seamlessSwitchQuotaBandSize: SeamlessQuotaBandSize;
  seamlessSwitchThreshold: SeamlessSwitchThreshold;
  seamlessSwitchGroupAVisible: boolean;
  seamlessSwitchGroupBVisible: boolean;
  seamlessSwitchGroupCVisible: boolean;
  hotSwitchGraceSeconds: number;
  hotSwitchLongTurnPolicy: "defer" | "interrupt" | "interruptAndContinue";
  hourlyQuotaControlEnabled: boolean;
  autoSwitchReloadWindowEnabled: boolean;
  autoSwitchHourlyThreshold: number;
  autoSwitchWeeklyThreshold: number;
  hideWeeklyQuotaThreshold: number;
  unhideWeeklyQuotaThreshold: number;
  autoSwitchLockMinutes: number;
  codexAppPath: string;
  resolvedCodexAppPath: string;
  quotaWarningEnabled: boolean;
  quotaWarningThreshold: number;
  quotaGreenThreshold: number;
  quotaYellowThreshold: number;
  debugNetwork: boolean;
  displayLanguage: DashboardLanguageOption;
}

export type DashboardThemeOption = "auto" | "dark" | "light";

export type DashboardLocalUsageRange = "24h" | "3d" | "7d" | "14d" | "7w" | "7m";

export const DASHBOARD_LOCAL_USAGE_RANGE_OPTIONS: readonly DashboardLocalUsageRange[] = [
  "24h",
  "3d",
  "7d",
  "14d",
  "7w",
  "7m"
];

export type DashboardSettingValue = string | number | boolean | DashboardLocalUsageRange[];

export interface DashboardCopy {
  panelTitle: string;
  brandSub: string;
  refreshPage: string;
  githubProject: string;
  githubProjectTip: string;
  announcementsTitle: string;
  announcementsTooltip: string;
  announcementsEmpty: string;
  announcementsRefresh: string;
  announcementsRefreshing: string;
  announcementsMarkAllRead: string;
  announcementsGotIt: string;
  announcementsPinned: string;
  announcementsTypeInfo: string;
  announcementsTypeFeature: string;
  announcementsTypeWarning: string;
  announcementsTypeUrgent: string;
  announcementsJustNow: string;
  announcementsMinutesAgo: string;
  announcementsHoursAgo: string;
  announcementsDaysAgo: string;
  addAccount: string;
  importCurrent: string;
  refreshAll: string;
  shareToken: string;
  shareTokenDisabledTip: string;
  shareTokenModeHint: string;
  tokenAutomationTitle: string;
  tokenAutomationSub: string;
  tokenAutomationOn: string;
  tokenAutomationOnDesc: string;
  tokenAutomationOff: string;
  tokenAutomationOffDesc: string;
  tokenAutomationLastCheck: string;
  tokenAutomationLastRefresh: string;
  tokenAutomationNextCheck: string;
  tokenAutomationLastFailure: string;
  tokenAutomationHealthy: string;
  tokenAutomationExpiring: string;
  tokenAutomationRefreshFailed: string;
  tokenAutomationReauthorize: string;
  tokenAutomationDisabled: string;
  tokenAutomationQuota: string;
  resyncProfileBtn: string;
  syncProfileBtn: string;
  editTagsBtn: string;
  addTagsBtn: string;
  removeTagsBtn: string;
  batchActionsTitle: string;
  batchRefreshBtn: string;
  batchResyncBtn: string;
  batchRemoveBtn: string;
  batchExportBtn: string;
  batchSelectedCount: string;
  batchResultTitle: string;
  batchResultSuccess: string;
  batchResultFailed: string;
  batchResultOverwrite: string;
  batchResultFailures: string;
  tagsLabel: string;
  tagsPlaceholder: string;
  tagsHelp: string;
  tagsRequiredError: string;
  tagsTooManyError: string;
  tagsTooLongError: string;
  saveTagsBtn: string;
  clearTagsBtn: string;
  lockAutoSwitchBtn: string;
  unlockAutoSwitchBtn: string;
  autoSwitchLockedUntil: string;
  autoSwitchRuleQuota: string;
  recoveryTitle: string;
  recoveryRestored: string;
  recoveryCorrupted: string;
  recoveryBackups: string;
  recoveryLastError: string;
  recoveryRestoreBackupBtn: string;
  recoveryRestoreAuthBtn: string;
  recoveryImportJsonBtn: string;
  dashboardTitle: string;
  dashboardSub: string;
  empty: string;
  noActiveAccountTitle: string;
  noActiveAccountSub: string;
  primaryAccount: string;
  current: string;
  disabledTag: string;
  authErrorTag: string;
  quotaErrorTag: string;
  reauthorizeBtn: string;
  reloadBtn: string;
  hourlyLabel: string;
  weeklyLabel: string;
  reviewLabel: string;
  userId: string;
  lastRefresh: string;
  accountId: string;
  organization: string;
  savedAccounts: string;
  savedAccountsSub: string;
  localUsageTitle: string;
  localUsageSub: string;
  localUsageTotal: string;
  localUsagePrice: string;
  localUsagePriceSub: string;
  localUsagePriceUnpriced: string;
  localUsageInput: string;
  localUsageOutput: string;
  localUsageCached: string;
  localUsageByModel: string;
  localUsageDaily: string;
  localUsageUpdated: string;
  localUsageRefreshBtn: string;
  localUsageRefreshing: string;
  localUsageLoading: string;
  localUsageUnavailable: string;
  localUsageEvents: string;
  localUsageModelUnknown: string;
  localUsageNote: string;
  localUsagePriceNote: string;
  localUsageRange24Hours: string;
  localUsageRange3Days: string;
  localUsageRange7Days: string;
  localUsageRange14Days: string;
  localUsageRange7Weeks: string;
  localUsageRange7Months: string;
  localUsageSameRange: string;
  localUsageSettingsTitle: string;
  localUsageSettingsSub: string;
  localUsageEnabledRangesTitle: string;
  localUsageEnabledRangesSub: string;
  localUsageRange24HoursDesc: string;
  localUsageRange3DaysDesc: string;
  localUsageRange7DaysDesc: string;
  localUsageRange14DaysDesc: string;
  localUsageRange7WeeksDesc: string;
  localUsageRange7MonthsDesc: string;
  localUsagePriceSettingsTitle: string;
  localUsagePriceSettingsSub: string;
  localUsagePriceSettingsNote: string;
  teamName: string;
  login: string;
  switchBtn: string;
  refreshBtn: string;
  copyAccountImportJsonBtn: string;
  resetCreditsBtn: string;
  resetCreditsLabel: string;
  detailsBtn: string;
  removeBtn: string;
  settingsTitle: string;
  addAccountModalTitle: string;
  shareTokenModalTitle: string;
  oauthTab: string;
  importJsonTab: string;
  authorizationLink: string;
  copyLink: string;
  openInBrowser: string;
  manualCallbackLabel: string;
  manualCallbackPlaceholder: string;
  authorizedContinue: string;
  cancelOauthConfirm: string;
  continueOauthBtn: string;
  cancelOauthBtn: string;
  oauthReadyHint: string;
  jsonPreview: string;
  copyJson: string;
  copySuccess: string;
  downloadJson: string;
  importJson: string;
  importJsonPlaceholder: string;
  importJsonSessionHint: string;
  importJsonSubmit: string;
  importJsonHint: string;
  importJsonValidate: string;
  importJsonSummaryTitle: string;
  importJsonSummaryTotal: string;
  importJsonSummaryValid: string;
  importJsonSummaryOverwrite: string;
  importJsonSummaryInvalid: string;
  importJsonSummaryFailures: string;
  importJsonResultsTitle: string;
  importJsonResultsSuccess: string;
  importJsonResultsOverwrite: string;
  importJsonResultsFailed: string;
  importJsonExamplesSummary: string;
  importJsonExamplesHint: string;
  importJsonSingleExampleLabel: string;
  importJsonBatchExampleLabel: string;
  importJsonChooseFile: string;
  importJsonFileReadError: string;
  shareSelectedCount: string;
  closeModal: string;
  showSensitive: string;
  hideSensitive: string;
  codexAppRestartTitle: string;
  codexAppRestartSub: string;
  restartModeAuto: string;
  restartModeAutoDesc: string;
  restartModeManual: string;
  restartModeManualDesc: string;
  restartModeNote: string;
  autoRefreshTitle: string;
  autoRefreshSub: string;
  autoRefreshOn: string;
  autoRefreshOnDesc: string;
  autoRefreshOff: string;
  autoRefreshOffDesc: string;
  autoRefreshValueTemplate: string;
  autoRefreshValueDescTemplate: string;
  hourlyQuotaControlTitle: string;
  hourlyQuotaControlSub: string;
  hourlyQuotaControlOnDesc: string;
  hourlyQuotaControlOffDesc: string;
  autoSwitchTitle: string;
  autoSwitchSub: string;
  autoSwitchOn: string;
  autoSwitchOnDesc: string;
  autoSwitchOff: string;
  autoSwitchOffDesc: string;
  autoSwitchThresholdSuffix: string;
  autoSwitchThresholdDescTemplate: string;
  autoSwitchAnyNote: string;
  autoSwitchReloadTitle: string;
  autoSwitchReloadSub: string;
  autoSwitchLockMinutesTitle: string;
  autoSwitchLockMinutesSub: string;
  autoSwitchLockOff: string;
  autoSwitchLockValueTemplate: string;
  autoSwitchLockValueDescTemplate: string;
  autoSwitchToastSwitched: string;
  appPathTitle: string;
  appPathSub: string;
  appPathEmpty: string;
  pickPath: string;
  clearPath: string;
  dashboardSettingsTitle: string;
  dashboardSettingsSub: string;
  showReviewOn: string;
  showReviewOnDesc: string;
  showReviewOff: string;
  showReviewOffDesc: string;
  warningTitle: string;
  warningSub: string;
  warningOn: string;
  warningOnDesc: string;
  warningWeeklyOnlySub: string;
  warningOff: string;
  warningOffDesc: string;
  warningValueDescTemplate: string;
  colorThresholdTitle: string;
  colorThresholdSub: string;
  colorThresholdGreenTitle: string;
  colorThresholdYellowTitle: string;
  colorThresholdGreenDescTemplate: string;
  colorThresholdYellowDescTemplate: string;
  colorThresholdRedNoteTemplate: string;
  debugTitle: string;
  debugSub: string;
  debugOn: string;
  debugOnDesc: string;
  debugOff: string;
  debugOffDesc: string;
  debugNote: string;
  languageTitle: string;
  languageSub: string;
  languageAuto: string;
  languageZh: string;
  languageEn: string;
  languageNote: string;
  statusShort: string;
  selectAccount: string;
  deselectAccount: string;
  statusToggleTip: string;
  statusToggleTipChecked: string;
  statusLimitTip: string;
  unknown: string;
  never: string;
  resetUnknown: string;
}

type DashboardMetricKey = string;

/**
 * The local Dashboard-only filters supported for personal ChatGPT plans.
 * These do not change account scheduling or persisted pool membership.
 */
export type DashboardAccountPlanFilter = "free" | "plus" | "pro";

export interface DashboardMetricViewModel {
  key: DashboardMetricKey;
  label: string;
  percentage?: number;
  resetAt?: number;
  windowMinutes?: number;
  requestsLeft?: number;
  requestsLimit?: number;
  visible: boolean;
}

export interface DashboardAccountViewModel {
  id: string;
  accountKind?: "chatgpt" | "sub2api";
  manualOnly?: boolean;
  providerActive?: boolean;
  displayName: string;
  email: string;
  authMode?: "chatgpt" | "oauth";
  accountName?: string;
  tags: string[];
  authProviderLabel: string;
  accountStructureLabel: string;
  workspaceLabel: string;
  isTeamWorkspace: boolean;
  subscriptionText: string;
  subscriptionTitle: string;
  subscriptionColor?: string;
  addMethodLabel: string;
  addedAtLabel: string;
  statusColor?: string;
  planTypeLabel: string;
  planType?: string;
  userId?: string;
  accountId?: string;
  organizationId?: string;
  isActive: boolean;
  isHidden: boolean;
  accountGroup?: CodexAccountGroup;
  isCurrentWindowAccount: boolean;
  balancePoolEnabled: boolean;
  showInStatusBar: boolean;
  canToggleStatusBar: boolean;
  statusToggleTitle: string;
  hasQuota402: boolean;
  quotaIssueKind?: "disabled" | "auth" | "quota";
  healthKind: "healthy" | "expiring" | "refresh_failed" | "reauthorize" | "disabled" | "quota";
  healthLabel: string;
  healthMessage?: string;
  healthIssueKey?: string;
  dismissedHealth: boolean;
  lastTokenCheckAt?: number;
  lastTokenRefreshAt?: number;
  lastTokenRefreshError?: string;
  lastQuotaAt?: number;
  resetCreditsAvailable?: number;
  resetCreditsNextExpiresAt?: number;
  quotaCountdownStartAvailable: boolean;
  tokenUsage?: DashboardAccountTokenUsageViewModel;
  autoSwitchLockedUntil?: number;
  /** Optional provider-owned presentation data for virtual accounts. */
  providerCard?: DashboardProviderAccountCardViewModel;
  metrics: DashboardMetricViewModel[];
}

/**
 * Sanitized presentation data supplied by an optional provider integration.
 * It contains no credentials or upstream account inventory.
 */
export interface DashboardProviderAccountCardViewModel {
  integrationId: string;
  details?: DashboardIntegrationDetail[];
  metrics?: DashboardIntegrationMetric[];
  actions?: DashboardIntegrationAction[];
}

/**
 * Tokens observed for one Manager-attributed quota window. These are local
 * Codex token counters, not a conversion of the service's quota percentage.
 */
export interface DashboardAccountTokenUsageViewModel extends DashboardLocalUsageTokenTotals {
  byModel: DashboardLocalUsageModelViewModel[];
  window: "hourly" | "weekly";
  resetAt: number;
  calculatedAt?: number;
  status: "loading" | "tracking" | "waiting";
}

export interface DashboardTokenAutomationViewModel {
  enabled: boolean;
  lastCheckAt?: number;
  nextCheckAt?: number;
  lastRefreshAt?: number;
  lastFailureMessage?: string;
}

export interface DashboardLocalUsageTokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface DashboardLocalUsageDayViewModel extends DashboardLocalUsageTokenTotals {
  date: string;
  eventCount: number;
}

export interface DashboardLocalUsageBucketViewModel extends DashboardLocalUsageTokenTotals {
  startAt: number;
  endAt: number;
  eventCount: number;
}

export interface DashboardLocalUsageModelViewModel extends DashboardLocalUsageTokenTotals {
  model: string;
}

export interface DashboardLocalUsageDayModelViewModel extends DashboardLocalUsageTokenTotals {
  date: string;
  model: string;
}

export interface DashboardLocalUsageBucketModelViewModel extends DashboardLocalUsageTokenTotals {
  startAt: number;
  model: string;
}

/**
 * A sanitized, machine-local view of Codex session usage. It deliberately has
 * no account identifiers, credentials, paths, or conversation content.
 */
export interface DashboardLocalUsageViewModel {
  status: "loading" | "ready" | "unavailable";
  isRefreshing: boolean;
  periodDays: number;
  timeZone: string;
  calculatedAt?: number;
  nextRefreshAt?: number;
  sourceFileCount: number;
  eventCount: number;
  total: DashboardLocalUsageTokenTotals;
  by3Hour: DashboardLocalUsageBucketViewModel[];
  by3HourAndModel: DashboardLocalUsageBucketModelViewModel[];
  byDay: DashboardLocalUsageDayViewModel[];
  byModel: DashboardLocalUsageModelViewModel[];
  byDayAndModel: DashboardLocalUsageDayModelViewModel[];
}

/**
 * A provider-neutral card contributed by an explicitly installed Manager
 * integration. The core renders only this sanitized presentation model and
 * forwards declared actions back to the registered integration.
 */
export interface DashboardIntegrationViewModel {
  id: string;
  title: string;
  status: "inactive" | "ready" | "active" | "warning" | "error";
  statusMessage?: string;
  description?: string;
  details?: DashboardIntegrationDetail[];
  metrics?: DashboardIntegrationMetric[];
  actions: DashboardIntegrationAction[];
  /** Optional compact action rendered in the Dashboard hero toolbar. */
  topButton?: DashboardIntegrationTopButton;
}

export interface DashboardIntegrationTopButton {
  actionId: string;
  label: string;
  tooltip?: string;
  icon?: "mail" | "bugteam" | "default";
}

export interface DashboardIntegrationDetail {
  label: string;
  value: string;
  emphasis?: "normal" | "positive" | "warning" | "error";
}

export interface DashboardIntegrationMetric {
  label: string;
  value: string;
  description?: string;
}

export interface DashboardIntegrationAction {
  id: string;
  label: string;
  enabled?: boolean;
  tooltip?: string;
  tone?: "primary" | "default" | "danger";
}

export type DashboardBatchResultKind =
  | "tags_set"
  | "tags_add"
  | "tags_remove"
  | "batch_refresh"
  | "batch_resync"
  | "batch_remove";

export interface DashboardBatchResultFailure {
  accountId?: string;
  email?: string;
  message: string;
}

export interface DashboardBatchResult {
  kind: DashboardBatchResultKind;
  successCount: number;
  failedCount: number;
  overwriteCount?: number;
  failures: DashboardBatchResultFailure[];
}

export interface DashboardState {
  lang: DashboardLanguage;
  panelTitle: string;
  brandSub: string;
  logoUri: string;
  settings: DashboardSettings;
  copy: DashboardCopy;
  tokenAutomation: DashboardTokenAutomationViewModel;
  announcements: CodexAnnouncementState;
  indexHealth: CodexIndexHealthSummary;
  accounts: DashboardAccountViewModel[];
  localUsage?: DashboardLocalUsageViewModel;
  integrations?: DashboardIntegrationViewModel[];
  integrationSettings?: DashboardIntegrationSettingViewModel[];
}

export interface DashboardIntegrationSettingViewModel {
  id: string;
  title: string;
  description?: string;
  enabled: boolean;
}

export type DashboardActionName =
  | "addAccount"
  | "importCurrent"
  | "refreshAll"
  | "refreshAnnouncements"
  | "markAnnouncementRead"
  | "markAllAnnouncementsRead"
  | "shareTokens"
  | "copyAccountImportJson"
  | "restoreFromBackup"
  | "restoreFromAuthJson"
  | "copyText"
  | "openExternalUrl"
  | "downloadJsonFile"
  | "previewImportSharedJson"
  | "importSharedJson"
  | "prepareOAuthSession"
  | "cancelOAuthSession"
  | "startOAuthAutoFlow"
  | "completeOAuthSession"
  | "updateTags"
  | "setBalancePool"
  | "removeFromBalancePool"
  | "toggleBalancePool"
  | "hideAccounts"
  | "unhideAccounts"
  | "setAccountGroup"
  | "setAutoSwitchLock"
  | "batchRefresh"
  | "batchResyncProfile"
  | "batchRemove"
  | "refreshView"
  | "refreshLocalUsage"
  | "resetSeamlessSwitchRuntime"
  | "integrationAction"
  | "integrationSetting"
  | "reloadPrompt"
  | "reauthorize"
  | "resyncProfile"
  | "dismissHealthIssue"
  | "details"
  | "switch"
  | "refresh"
  | "startQuotaCountdown"
  | "remove"
  | "toggleStatusBar"
  | "getResetCredits"
  | "consumeResetCredit";

export interface DashboardOAuthSessionDescriptor {
  sessionId: string;
  authUrl: string;
  redirectUri: string;
}

export interface DashboardActionPayload {
  accountIds?: string[];
  jsonText?: string;
  text?: string;
  url?: string;
  filename?: string;
  oauthSessionId?: string;
  callbackUrl?: string;
  issueKey?: string;
  recoveryMode?: boolean;
  tags?: string[];
  accountGroup?: CodexAccountGroup;
  clearAccountGroup?: boolean;
  mode?: "set" | "add" | "remove";
  lockMinutes?: number;
  announcementId?: string;
  privacyMode?: boolean;
  integrationId?: string;
  integrationActionId?: string;
  integrationSettingId?: string;
  enabled?: boolean;
}

export interface DashboardActionResultPayload {
  affectedAccountIds?: string[];
  sharedJson?: string;
  oauthSession?: DashboardOAuthSessionDescriptor;
  importPreview?: CodexImportPreviewSummary;
  importResult?: CodexImportResultSummary;
  batchResult?: DashboardBatchResult;
  importedCount?: number;
  importedEmails?: string[];
  email?: string;
  restoredCount?: number;
  resetCredits?: import("../../core/types").CodexResetCreditsSnapshot;
}

export type DashboardHostMessage =
  | {
      type: "dashboard:snapshot";
      state: DashboardState;
    }
  | {
      type: "dashboard:action-result";
      requestId: string;
      action: DashboardActionName;
      accountId?: string;
      status: "completed" | "failed";
      payload?: DashboardActionResultPayload;
      error?: string;
    };

export type DashboardClientMessage =
  | { type: "dashboard:ready" }
  | {
      type: "dashboard:action";
      requestId: string;
      action: DashboardActionName;
      accountId?: string;
      payload?: DashboardActionPayload;
    }
  | {
      type: "dashboard:setting";
      key: DashboardSettingKey;
      value: DashboardSettingValue;
    }
  | { type: "dashboard:pickCodexAppPath" }
  | { type: "dashboard:clearCodexAppPath" };

import * as vscode from "vscode";
import {
  DASHBOARD_LOCAL_USAGE_RANGE_OPTIONS,
  DEFAULT_WEEKLY_QUOTA_HIDE_THRESHOLD,
  DEFAULT_WEEKLY_QUOTA_UNHIDE_THRESHOLD,
  type DashboardLocalUsageRange,
  type DashboardSettings,
  type DashboardThemeOption
} from "../../domain/dashboard/types";
import type { SeamlessQuotaBandSize, SeamlessSwitchThreshold } from "../../core/types";
import { DashboardLanguage, DashboardLanguageOption, resolveDashboardLanguage } from "../../localization/languages";
import { normalizeQuotaColorThresholds } from "../../utils";
import { isSupportedProxyUrl } from "./proxyEnvironment";

const CODEX_ACCOUNTS_SECTION = "codexAccounts";
const DEFAULT_PROXY_ADDRESSES = [""] as const;

export interface WeeklyQuotaThresholds {
  hide: number;
  unhide: number;
}

type ReadableCodexAccountsConfiguration = Pick<vscode.WorkspaceConfiguration, "get"> &
  Partial<Pick<vscode.WorkspaceConfiguration, "inspect">>;

export class ExtensionSettingsStore {
  getDashboardSettings(): DashboardSettings {
    const config = getCodexAccountsConfiguration();
    const proxyAddresses = normalizeProxyAddresses(config.get<unknown>("proxyAddresses", DEFAULT_PROXY_ADDRESSES));
    const thresholds = normalizeQuotaColorThresholds(
      config.get<number>("quotaGreenThreshold", 60),
      config.get<number>("quotaYellowThreshold", 20)
    );
    const weeklyQuotaThresholds = resolveWeeklyQuotaThresholds(config);

    return {
      dashboardTheme: normalizeDashboardTheme(config.get<string>("dashboardTheme", "auto")),
      ...resolveLocalUsageRanges(config),
      localUsageShowEquivalentPrice: config.get<boolean>("localUsageShowEquivalentPrice", true),
      codexAppRestartEnabled: config.get<boolean>("codexAppRestartEnabled", false),
      codexAppRestartMode: config.get<"auto" | "manual">("codexAppRestartMode") ?? "manual",
      backgroundTokenRefreshEnabled: config.get<boolean>("backgroundTokenRefreshEnabled", true),
      forceFastModeEnabled: config.get<boolean>("forceFastModeEnabled", false),
      autoRefreshMinutes: normalizeAutoRefreshMinutes(config.get<number>("autoRefreshMinutes", 0)),
      autoSwitchEnabled: config.get<boolean>("autoSwitchEnabled", false),
      hotSwitchEnabled: config.get<boolean>("hotSwitchEnabled", false),
      seamlessSwitchEnabled: isSeamlessSwitchEnabled(config),
      seamlessSwitchQuotaBandsEnabled: isSeamlessSwitchQuotaBandsEnabled(config),
      seamlessSwitchLowQuotaEnabled: isSeamlessSwitchLowQuotaEnabled(config),
      seamlessSwitchQuotaBandSize: normalizeSeamlessQuotaBandSize(
        config.get<number>("seamlessSwitchQuotaBandSize", 20)
      ),
      seamlessSwitchThreshold: getSeamlessSwitchThreshold(config),
      seamlessSwitchGroupAVisible: config.get<boolean>("seamlessSwitchGroupAVisible", true),
      seamlessSwitchGroupBVisible: config.get<boolean>("seamlessSwitchGroupBVisible", true),
      seamlessSwitchGroupCVisible: config.get<boolean>("seamlessSwitchGroupCVisible", true),
      hotSwitchGraceSeconds: normalizeHotSwitchGraceSeconds(config.get<number>("hotSwitchGraceSeconds", 60)),
      hotSwitchLongTurnPolicy: normalizeHotSwitchLongTurnPolicy(config.get<string>("hotSwitchLongTurnPolicy", "defer")),
      hourlyQuotaControlEnabled: config.get<boolean>("hourlyQuotaControlEnabled", false),
      autoSwitchReloadWindowEnabled: config.get<boolean>("autoSwitchReloadWindowEnabled", false),
      autoSwitchHourlyThreshold: normalizeAutoSwitchThreshold(config.get<number>("autoSwitchHourlyThreshold", 20)),
      autoSwitchWeeklyThreshold: normalizeAutoSwitchThreshold(config.get<number>("autoSwitchWeeklyThreshold", 20)),
      hideWeeklyQuotaThreshold: weeklyQuotaThresholds.hide,
      unhideWeeklyQuotaThreshold: weeklyQuotaThresholds.unhide,
      autoSwitchLockMinutes: normalizeAutoSwitchLockMinutes(config.get<number>("autoSwitchLockMinutes", 0)),
      codexAppPath: config.get<string>("codexAppPath", ""),
      resolvedCodexAppPath: "",
      quotaWarningEnabled: config.get<boolean>("quotaWarningEnabled", false),
      quotaWarningThreshold: normalizeQuotaWarningThreshold(config.get<number>("quotaWarningThreshold", 20)),
      quotaGreenThreshold: thresholds.green,
      quotaYellowThreshold: thresholds.yellow,
      debugNetwork: config.get<boolean>("debugNetwork", false),
      proxyAddress: resolveProxyAddress(config, proxyAddresses),
      proxyAddresses,
      displayLanguage: config.get<DashboardLanguageOption>("displayLanguage", "auto")
    };
  }

  resolveLanguage(): DashboardLanguage {
    const configured = getCodexAccountsConfiguration().get<string>("displayLanguage", "auto");
    return resolveDashboardLanguage(configured, vscode.env.language);
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CODEX_ACCOUNTS_SECTION)) {
        listener();
      }
    });
  }
}

export function getDashboardProxyAddresses(
  config: ReadableCodexAccountsConfiguration = getCodexAccountsConfiguration()
): string[] {
  return normalizeProxyAddresses(config.get<unknown>("proxyAddresses", DEFAULT_PROXY_ADDRESSES));
}

export function getDashboardProxyAddress(
  config: ReadableCodexAccountsConfiguration = getCodexAccountsConfiguration()
): string {
  return resolveProxyAddress(config, getDashboardProxyAddresses(config));
}

export function normalizeProxyAddress(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized === "" || isSupportedProxyUrl(normalized) ? normalized : "";
}

export function normalizeProxyAddresses(value: unknown): string[] {
  const configured = Array.isArray(value) ? value : [];
  const unique = new Set<string>([""]);

  for (const item of configured) {
    const normalized = normalizeProxyAddress(item);
    if (normalized) {
      unique.add(normalized);
    }
  }

  return [...unique];
}

function resolveProxyAddress(config: ReadableCodexAccountsConfiguration, proxyAddresses: readonly string[]): string {
  const selected = normalizeProxyAddress(config.get<unknown>("proxyAddress", ""));
  return proxyAddresses.includes(selected) ? selected : "";
}

export function normalizeDashboardTheme(value: string | undefined): DashboardThemeOption {
  return value === "dark" || value === "light" || value === "auto" ? value : "auto";
}

export function normalizeLocalUsageRange(value: unknown): DashboardLocalUsageRange {
  if (typeof value === "string" && DASHBOARD_LOCAL_USAGE_RANGE_OPTIONS.includes(value as DashboardLocalUsageRange)) {
    return value as DashboardLocalUsageRange;
  }

  return value === 14 ? "14d" : "7d";
}

export function normalizeLocalUsageRanges(value: unknown): DashboardLocalUsageRange[] {
  const configured = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const selected = new Set(
    configured.filter((item): item is DashboardLocalUsageRange =>
      DASHBOARD_LOCAL_USAGE_RANGE_OPTIONS.includes(item as DashboardLocalUsageRange)
    )
  );
  const normalized = DASHBOARD_LOCAL_USAGE_RANGE_OPTIONS.filter((range) => selected.has(range));
  return normalized.length > 0 ? normalized : ["24h"];
}

function resolveLocalUsageRanges(
  config: ReadableCodexAccountsConfiguration
): Pick<DashboardSettings, "localUsageDefaultRange" | "localUsageEnabledRanges"> {
  const explicitlyConfigured = explicitConfigurationValue(config, "localUsageEnabledRanges");
  const enabledRanges =
    explicitlyConfigured !== undefined
      ? normalizeLocalUsageRanges(explicitlyConfigured)
      : resolveLegacyLocalUsageRanges(config);
  return {
    localUsageDefaultRange: enabledRanges[0] ?? "24h",
    localUsageEnabledRanges: enabledRanges
  };
}

function resolveLegacyLocalUsageRanges(config: ReadableCodexAccountsConfiguration): DashboardLocalUsageRange[] {
  const legacyRange = explicitConfigurationValue(config, "localUsageDefaultRange");
  if (legacyRange !== undefined) {
    return [normalizeLocalUsageRange(legacyRange)];
  }

  const legacyDays =
    explicitConfigurationValue(config, "localUsageDefaultRangeDays") ??
    config.get<unknown>("localUsageDefaultRangeDays", undefined);
  if (legacyDays !== undefined) {
    return [normalizeLocalUsageRange(legacyDays)];
  }

  const configured = config.get<unknown>("localUsageEnabledRanges", ["24h"]);
  return normalizeLocalUsageRanges(configured);
}

function explicitConfigurationValue(config: ReadableCodexAccountsConfiguration, key: string): unknown {
  const inspected = config.inspect?.<unknown>(key);
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

export function isSeamlessSwitchQuotaBandsEnabled(
  config: ReadableCodexAccountsConfiguration = getCodexAccountsConfiguration()
): boolean {
  const configured = explicitConfigurationValue(config, "seamlessSwitchQuotaBandsEnabled");
  if (typeof configured === "boolean") {
    return configured;
  }
  return config.get<boolean>("balanceByQuotaBandsEnabled", false);
}

/** Keep pre-toggle behavior until a user explicitly chooses the new switch. */
export function isSeamlessSwitchLowQuotaEnabled(
  config: ReadableCodexAccountsConfiguration = getCodexAccountsConfiguration()
): boolean {
  const configured = explicitConfigurationValue(config, "seamlessSwitchLowQuotaEnabled");
  if (typeof configured === "boolean") {
    return configured;
  }
  if (!config.inspect) {
    const supplied = config.get<unknown>("seamlessSwitchLowQuotaEnabled", undefined);
    if (typeof supplied === "boolean") {
      return supplied;
    }
  }
  return isSeamlessSwitchQuotaBandsEnabled(config);
}

export function isSeamlessSwitchEnabled(
  config: vscode.WorkspaceConfiguration = getCodexAccountsConfiguration()
): boolean {
  const configured = explicitConfigurationValue(config, "seamlessSwitchEnabled");
  if (typeof configured === "boolean") {
    return configured;
  }
  return config.get<boolean>("hotSwitchEnabled", false);
}

export function normalizeAutoRefreshMinutes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(1, Math.min(60, Math.round(value)));
}

export function normalizeHotSwitchGraceSeconds(value: number): number {
  if (!Number.isFinite(value)) {
    return 60;
  }
  return Math.max(10, Math.min(300, Math.round(value)));
}

export function normalizeSeamlessQuotaBandSize(value: unknown): SeamlessQuotaBandSize {
  return value === 25 || value === 33 || value === 50 ? value : 20;
}

export function normalizeSeamlessSwitchThreshold(value: unknown): SeamlessSwitchThreshold {
  return value === 0 || value === 1 || value === 3 || value === 5 ? value : 3;
}

/**
 * The unified threshold replaces the separate reserve floor and opt-in 1%
 * protection. Preserve prior explicit choices until the user saves the new
 * setting: a former hard-stop opt-in maps to 1%, otherwise 2% maps upward to
 * the closest available safe threshold (3%).
 */
export function getSeamlessSwitchThreshold(
  config: ReadableCodexAccountsConfiguration = getCodexAccountsConfiguration()
): SeamlessSwitchThreshold {
  const configured = explicitConfigurationValue(config, "seamlessSwitchThreshold");
  if (configured !== undefined) {
    return normalizeSeamlessSwitchThreshold(configured);
  }

  // Small embedded callers (for example the Gateway selector) only provide
  // `get`; in that narrow case the supplied value is already the effective
  // value and there is no VS Code default to distinguish from an override.
  if (!config.inspect) {
    const supplied = config.get<unknown>("seamlessSwitchThreshold", undefined);
    if (supplied !== undefined) {
      return normalizeSeamlessSwitchThreshold(supplied);
    }
  }

  const legacyEmergencySwitchEnabled =
    explicitConfigurationValue(config, "seamlessSwitchEmergencySwitchEnabled") ??
    config.get<unknown>("seamlessSwitchEmergencySwitchEnabled", undefined);
  if (legacyEmergencySwitchEnabled === true) {
    return 1;
  }

  const legacyReserveThreshold =
    explicitConfigurationValue(config, "seamlessSwitchReserveThreshold") ??
    config.get<unknown>("seamlessSwitchReserveThreshold", undefined);
  if (legacyReserveThreshold === 1) {
    return 1;
  }
  return 3;
}

export function normalizeHotSwitchLongTurnPolicy(
  value: string | undefined
): "defer" | "interrupt" | "interruptAndContinue" {
  return value === "interrupt" || value === "interruptAndContinue" ? value : "defer";
}

export function getCodexAccountsConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CODEX_ACCOUNTS_SECTION);
}

export function getAutoRefreshMinutes(): number {
  return normalizeAutoRefreshMinutes(getCodexAccountsConfiguration().get<number>("autoRefreshMinutes", 0));
}

export function isBackgroundTokenRefreshEnabled(): boolean {
  return getCodexAccountsConfiguration().get<boolean>("backgroundTokenRefreshEnabled", true);
}

export function isForceFastModeEnabled(
  config: ReadableCodexAccountsConfiguration = getCodexAccountsConfiguration()
): boolean {
  return config.get<boolean>("forceFastModeEnabled", false);
}

export function isHourlyQuotaControlEnabled(): boolean {
  return getCodexAccountsConfiguration().get<boolean>("hourlyQuotaControlEnabled", false);
}

/**
 * The local Feishu-import inbox is intentionally opt-in.  A stock extension
 * installation must not create a watched directory or start importing files
 * merely because another machine happens to use the same build.
 */
export function isLocalImportInboxEnabled(): boolean {
  return getCodexAccountsConfiguration().get<boolean>("localImportInboxEnabled", false);
}

/** The Manager control surface is enabled by default. */
export function isExternalControlEnabled(): boolean {
  return getCodexAccountsConfiguration().get<boolean>("externalControlEnabled", true);
}

export function getExternalControlPort(): number {
  return normalizeExternalControlPort(getCodexAccountsConfiguration().get<number>("externalControlPort", 43117));
}

export function normalizeExternalControlPort(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 65535) {
    return 43117;
  }
  return value as number;
}

export function normalizeAutoSwitchThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return 20;
  }

  return Math.max(0, Math.min(20, Math.round(value)));
}

export function isValidWeeklyQuotaThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function normalizeWeeklyQuotaThreshold(value: unknown, fallback: number): number {
  return isValidWeeklyQuotaThreshold(value) ? value : fallback;
}

export function resolveWeeklyQuotaThresholds(
  config: ReadableCodexAccountsConfiguration = getCodexAccountsConfiguration()
): WeeklyQuotaThresholds {
  const hide = normalizeWeeklyQuotaThreshold(
    config.get<unknown>("hideWeeklyQuotaThreshold", DEFAULT_WEEKLY_QUOTA_HIDE_THRESHOLD),
    DEFAULT_WEEKLY_QUOTA_HIDE_THRESHOLD
  );
  const unhide = normalizeWeeklyQuotaThreshold(
    config.get<unknown>("unhideWeeklyQuotaThreshold", DEFAULT_WEEKLY_QUOTA_UNHIDE_THRESHOLD),
    DEFAULT_WEEKLY_QUOTA_UNHIDE_THRESHOLD
  );

  return hide <= unhide
    ? { hide, unhide }
    : { hide: DEFAULT_WEEKLY_QUOTA_HIDE_THRESHOLD, unhide: DEFAULT_WEEKLY_QUOTA_UNHIDE_THRESHOLD };
}

export function normalizeQuotaWarningThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return 20;
  }

  const snapped = Math.round(value / 5) * 5;
  return Math.max(5, Math.min(90, snapped));
}

function normalizeAutoSwitchLockMinutes(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(120, Math.round(value)));
}

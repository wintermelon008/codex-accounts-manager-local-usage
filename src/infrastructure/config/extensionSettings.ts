import * as vscode from "vscode";
import type { DashboardLocalUsageRange, DashboardSettings, DashboardThemeOption } from "../../domain/dashboard/types";
import type { SeamlessQuotaBandSize } from "../../core/types";
import { DashboardLanguage, DashboardLanguageOption, resolveDashboardLanguage } from "../../localization/languages";
import { normalizeQuotaColorThresholds } from "../../utils";

const CODEX_ACCOUNTS_SECTION = "codexAccounts";

export class ExtensionSettingsStore {
  getDashboardSettings(): DashboardSettings {
    const config = getCodexAccountsConfiguration();
    const thresholds = normalizeQuotaColorThresholds(
      config.get<number>("quotaGreenThreshold", 60),
      config.get<number>("quotaYellowThreshold", 20)
    );

    return {
      dashboardTheme: normalizeDashboardTheme(config.get<string>("dashboardTheme", "auto")),
      localUsageDefaultRange: normalizeLocalUsageRange(
        explicitConfigurationValue(config, "localUsageDefaultRange") ??
          config.get<number>("localUsageDefaultRangeDays", 7)
      ),
      localUsageShowEquivalentPrice: config.get<boolean>("localUsageShowEquivalentPrice", true),
      codexAppRestartEnabled: config.get<boolean>("codexAppRestartEnabled", false),
      codexAppRestartMode: config.get<"auto" | "manual">("codexAppRestartMode") ?? "manual",
      backgroundTokenRefreshEnabled: config.get<boolean>("backgroundTokenRefreshEnabled", true),
      autoRefreshMinutes: normalizeAutoRefreshMinutes(config.get<number>("autoRefreshMinutes", 0)),
      autoSwitchEnabled: config.get<boolean>("autoSwitchEnabled", false),
      hotSwitchEnabled: config.get<boolean>("hotSwitchEnabled", false),
      seamlessSwitchEnabled: isSeamlessSwitchEnabled(config),
      seamlessSwitchQuotaBandsEnabled: isSeamlessSwitchQuotaBandsEnabled(config),
      seamlessSwitchQuotaBandSize: normalizeSeamlessQuotaBandSize(
        config.get<number>("seamlessSwitchQuotaBandSize", 20)
      ),
      seamlessSwitchEmergencySwitchEnabled: config.get<boolean>("seamlessSwitchEmergencySwitchEnabled", false),
      hotSwitchGraceSeconds: normalizeHotSwitchGraceSeconds(config.get<number>("hotSwitchGraceSeconds", 60)),
      hotSwitchLongTurnPolicy: normalizeHotSwitchLongTurnPolicy(config.get<string>("hotSwitchLongTurnPolicy", "defer")),
      hourlyQuotaControlEnabled: config.get<boolean>("hourlyQuotaControlEnabled", false),
      autoSwitchReloadWindowEnabled: config.get<boolean>("autoSwitchReloadWindowEnabled", false),
      autoSwitchHourlyThreshold: normalizeAutoSwitchThreshold(config.get<number>("autoSwitchHourlyThreshold", 20)),
      autoSwitchWeeklyThreshold: normalizeAutoSwitchThreshold(config.get<number>("autoSwitchWeeklyThreshold", 20)),
      autoSwitchLockMinutes: normalizeAutoSwitchLockMinutes(config.get<number>("autoSwitchLockMinutes", 0)),
      codexAppPath: config.get<string>("codexAppPath", ""),
      resolvedCodexAppPath: "",
      quotaWarningEnabled: config.get<boolean>("quotaWarningEnabled", false),
      quotaWarningThreshold: normalizeQuotaWarningThreshold(config.get<number>("quotaWarningThreshold", 20)),
      quotaGreenThreshold: thresholds.green,
      quotaYellowThreshold: thresholds.yellow,
      debugNetwork: config.get<boolean>("debugNetwork", false),
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

export function normalizeDashboardTheme(value: string | undefined): DashboardThemeOption {
  return value === "dark" || value === "light" || value === "auto" ? value : "auto";
}

export function normalizeLocalUsageRange(value: unknown): DashboardLocalUsageRange {
  if (value === "24h" || value === "7d" || value === "14d") {
    return value;
  }

  // Preserve the dashboard selection for installations that used the
  // pre-24h numeric setting, without retaining the retired 30-day view.
  return value === 14 ? "14d" : "7d";
}

function explicitConfigurationValue(config: vscode.WorkspaceConfiguration, key: string): unknown {
  const inspected = config.inspect<unknown>(key);
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

export function isSeamlessSwitchQuotaBandsEnabled(
  config: vscode.WorkspaceConfiguration = getCodexAccountsConfiguration()
): boolean {
  const configured = explicitConfigurationValue(config, "seamlessSwitchQuotaBandsEnabled");
  if (typeof configured === "boolean") {
    return configured;
  }
  return config.get<boolean>("balanceByQuotaBandsEnabled", false);
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

export function normalizeAutoSwitchThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return 20;
  }

  return Math.max(0, Math.min(20, Math.round(value)));
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

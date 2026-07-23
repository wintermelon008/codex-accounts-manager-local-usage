import type { DashboardState } from "../../domain/dashboard/types";

export function buildDashboardStateSignature(state: DashboardState): string {
  const accountSignature = state.accounts
    .map((account) =>
      [
        account.id,
        account.email,
        account.displayName,
        account.accountName ?? "",
        account.planTypeLabel,
        account.planType ?? "",
        account.creditsText ?? "",
        account.accountId ?? "",
        account.organizationId ?? "",
        account.userId ?? "",
        account.tags.join(","),
        account.isActive ? "1" : "0",
        account.isHidden ? "1" : "0",
        account.accountGroup ?? "",
        account.balancePoolEnabled ? "1" : "0",
        account.showInStatusBar ? "1" : "0",
        account.lastQuotaAt ?? 0,
        account.resetCreditsAvailable ?? "",
        account.resetCreditsNextExpiresAt ?? "",
        account.tokenUsage
          ? [
              account.tokenUsage.status,
              account.tokenUsage.window,
              account.tokenUsage.resetAt,
              account.tokenUsage.calculatedAt ?? "",
              account.tokenUsage.inputTokens,
              account.tokenUsage.cachedInputTokens,
              account.tokenUsage.outputTokens,
              account.tokenUsage.reasoningOutputTokens,
              account.tokenUsage.totalTokens
            ].join(",")
          : "",
        account.healthKind,
        account.dismissedHealth ? "1" : "0",
        account.lastTokenCheckAt ?? "",
        account.lastTokenRefreshAt ?? "",
        account.lastTokenRefreshError ?? "",
        account.autoSwitchLockedUntil ?? "",
        account.metrics
          .filter((metric) => metric.visible)
          .map(
            (metric) =>
              `${metric.key}:${metric.percentage ?? ""}:${metric.requestsLeft ?? ""}:${metric.requestsLimit ?? ""}:${metric.resetAt ?? ""}`
          )
          .join(",")
      ].join(":")
    )
    .join("|");
  const announcementSignature = [
    state.announcements.unreadIds.join(","),
    state.announcements.popupAnnouncement?.id ?? "",
    state.announcements.announcements
      .map(
        (item) =>
          `${item.id}:${item.title}:${item.summary}:${item.createdAt}:${item.releaseVersion ?? ""}:${item.restartRequired ? "1" : "0"}:${item.restartHint ?? ""}:${item.pinned ? "1" : "0"}`
      )
      .join("|")
  ].join(":");
  const localUsageSignature = state.localUsage
    ? JSON.stringify({
        status: state.localUsage.status,
        isRefreshing: state.localUsage.isRefreshing,
        periodDays: state.localUsage.periodDays,
        calculatedAt: state.localUsage.calculatedAt,
        nextRefreshAt: state.localUsage.nextRefreshAt,
        sourceFileCount: state.localUsage.sourceFileCount,
        eventCount: state.localUsage.eventCount,
        total: state.localUsage.total,
        byDay: state.localUsage.byDay,
        byModel: state.localUsage.byModel,
        byDayAndModel: state.localUsage.byDayAndModel,
        byThreeHour: state.localUsage.byThreeHour,
        byThreeHourAndModel: state.localUsage.byThreeHourAndModel
      })
    : "";
  const sub2apiGatewaySignature = state.sub2apiGateway ? JSON.stringify(state.sub2apiGateway) : "";

  return [
    state.lang,
    state.panelTitle,
    state.brandSub,
    state.settings.dashboardTheme,
    state.settings.displayLanguage,
    state.settings.localUsageDefaultRange,
    state.settings.localUsageShowEquivalentPrice ? "1" : "0",
    state.settings.autoRefreshMinutes,
    state.settings.autoSwitchEnabled ? "1" : "0",
    state.settings.hotSwitchEnabled ? "1" : "0",
    state.settings.seamlessSwitchEnabled ? "1" : "0",
    state.settings.seamlessSwitchQuotaBandsEnabled ? "1" : "0",
    state.settings.seamlessSwitchQuotaBandSize,
    state.settings.seamlessSwitchThreshold,
    state.settings.seamlessSwitchGroupAVisible ? "1" : "0",
    state.settings.seamlessSwitchGroupBVisible ? "1" : "0",
    state.settings.seamlessSwitchGroupCVisible ? "1" : "0",
    state.settings.hotSwitchGraceSeconds,
    state.settings.hotSwitchLongTurnPolicy,
    state.settings.hourlyQuotaControlEnabled ? "1" : "0",
    state.settings.autoSwitchReloadWindowEnabled ? "1" : "0",
    state.settings.autoSwitchHourlyThreshold,
    state.settings.autoSwitchWeeklyThreshold,
    state.settings.autoSwitchLockMinutes,
    state.settings.quotaWarningEnabled ? "1" : "0",
    state.settings.quotaWarningThreshold,
    state.settings.quotaGreenThreshold,
    state.settings.quotaYellowThreshold,
    state.tokenAutomation.enabled ? "1" : "0",
    state.tokenAutomation.lastCheckAt ?? "",
    state.tokenAutomation.nextCheckAt ?? "",
    state.tokenAutomation.lastRefreshAt ?? "",
    state.tokenAutomation.lastFailureMessage ?? "",
    state.indexHealth.status,
    state.indexHealth.availableBackups,
    state.indexHealth.lastRestoreSource ?? "",
    state.indexHealth.lastErrorMessage ?? "",
    state.indexHealth.lastRecoveredAt ?? "",
    announcementSignature,
    accountSignature,
    localUsageSignature,
    sub2apiGatewaySignature
  ].join("||");
}

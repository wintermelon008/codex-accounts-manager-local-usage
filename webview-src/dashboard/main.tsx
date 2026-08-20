import { render } from "preact";
import { useEffect, useMemo, useReducer, useState } from "preact/hooks";
import packageJson from "../../package.json";
import type { CodexAccountGroup } from "../../src/core/types";
import {
  DASHBOARD_ACCOUNT_PAGE_SIZE_OPTIONS,
  DASHBOARD_ACCOUNTS_PAGE_SIZE,
  type DashboardAccountPageSize,
  type DashboardAccountViewModel,
  type DashboardAccountPlanFilter,
  type DashboardSettingKey
} from "../../src/domain/dashboard/types";
import { AnnouncementCenter } from "./announcementCenter";
import { ActionButton, BatchSelectionBar, OverviewSection, RecoveryPanel } from "./components";
import { postMessageToHost } from "./host";
import {
  formatSavedAccountsSummary,
  getDashboardAccountPage,
  getHighWeeklyQuotaHiddenAccountIds,
  getLowWeeklyQuotaAccountIds,
  getDashboardVisibleAccounts,
  normalizeThresholds,
  resolveLockMinutes,
  resolveOverviewAccount
} from "./helpers";
import { useDashboardActions, useDashboardHostSync, useDashboardModals } from "./hooks";
import { BellIcon, BugTeamIcon, EyeIcon, EyeOffIcon, GitHubIcon, GlobeIcon, InfoIcon, MailIcon } from "./icons";
import { AboutModal, AddAccountModal, ConfirmCancelOauthModal, SettingsOverlay, ShareTokenModal } from "./panels";
import { SavedAccountCard } from "./savedAccountCard";
import { LocalUsageSection } from "./localUsageSection";
import { IntegrationCards } from "./integrationCards";
import { createInitialState, reducer } from "./state";
import { resolveDashboardThemeFromMedia } from "./theme";

const GITHUB_PROJECT_URL = "https://github.com/wannanbigpig/codex-tools";
const ACCOUNT_GROUPS: readonly CodexAccountGroup[] = ["A", "B", "C"];
const ACCOUNT_PLAN_FILTERS: readonly DashboardAccountPlanFilter[] = ["free", "plus", "pro"];

type SeamlessSwitchGroupVisibilityKey = Extract<
  DashboardSettingKey,
  "seamlessSwitchGroupAVisible" | "seamlessSwitchGroupBVisible" | "seamlessSwitchGroupCVisible"
>;

function getAccountGroupVisibilityKey(group: CodexAccountGroup): SeamlessSwitchGroupVisibilityKey {
  switch (group) {
    case "A":
      return "seamlessSwitchGroupAVisible";
    case "B":
      return "seamlessSwitchGroupBVisible";
    case "C":
      return "seamlessSwitchGroupCVisible";
  }
}

function App() {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [announcementsOpen, setAnnouncementsOpen] = useState(false);
  const [showHiddenAccounts, setShowHiddenAccounts] = useState(false);
  const [selectedPlanFilters, setSelectedPlanFilters] = useState<DashboardAccountPlanFilter[]>([]);
  const [accountsPage, setAccountsPage] = useState(1);
  const [accountsPageSize, setAccountsPageSize] = useState<DashboardAccountPageSize>(DASHBOARD_ACCOUNTS_PAGE_SIZE);
  const [accountPageJumpInput, setAccountPageJumpInput] = useState("");
  const { patchSettings, sendAction, sendSetting, isActionPending, hasGlobalPendingAction } = useDashboardActions(
    state,
    dispatch
  );
  const snapshot = state.snapshot;
  const displayedAccounts = useMemo(
    () =>
      snapshot
        ? getDashboardVisibleAccounts(snapshot.accounts, snapshot.settings, showHiddenAccounts, selectedPlanFilters)
        : [],
    [selectedPlanFilters, showHiddenAccounts, snapshot]
  );
  const modals = useDashboardModals({
    dispatch,
    sendAction,
    importJsonFileReadError: snapshot?.copy.importJsonFileReadError ?? "Failed to read JSON file."
  });
  useDashboardHostSync({
    handleHostMessage: modals.handleHostMessage,
    handleEscape: () => modals.handleEscape(isActionPending("completeOAuthSession"))
  });
  useEffect(() => {
    const preference = snapshot?.settings.dashboardTheme ?? "auto";
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const applyResolvedTheme = () => {
      root.dataset["themePreference"] = preference;
      root.dataset["theme"] = resolveDashboardThemeFromMedia(preference, media);
    };

    applyResolvedTheme();
    media.addEventListener("change", applyResolvedTheme);
    const observer = new MutationObserver(applyResolvedTheme);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });

    return () => {
      media.removeEventListener("change", applyResolvedTheme);
      observer.disconnect();
    };
  }, [snapshot?.settings.dashboardTheme]);

  useEffect(() => {
    setAccountsPage(1);
  }, [
    selectedPlanFilters,
    showHiddenAccounts,
    snapshot?.settings.seamlessSwitchGroupAVisible,
    snapshot?.settings.seamlessSwitchGroupBVisible,
    snapshot?.settings.seamlessSwitchGroupCVisible
  ]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    const lastPage = Math.max(1, Math.ceil(displayedAccounts.length / accountsPageSize));
    setAccountsPage((page) => Math.min(page, lastPage));
  }, [accountsPageSize, displayedAccounts.length]);

  useEffect(() => {
    dispatch({
      type: "reconcile-selection-scope",
      visibleAccountIds: displayedAccounts.map((account) => account.id)
    });
  }, [dispatch, displayedAccounts]);

  if (!snapshot) {
    return (
      <div class="panel">
        <section class="section">
          <div class="identity">Loading...</div>
        </section>
      </div>
    );
  }

  const activeAccount = snapshot.accounts.find((account) => account.isActive);
  const overviewAccount = resolveOverviewAccount(snapshot.accounts);
  const hiddenAccountCount = snapshot.accounts.filter((account) => account.isHidden).length;
  const displayedAccountPage = getDashboardAccountPage(displayedAccounts, accountsPage, accountsPageSize);
  const pageAccounts = displayedAccountPage.accounts;
  const lowWeeklyQuotaAccountIds = getLowWeeklyQuotaAccountIds(
    pageAccounts,
    snapshot.settings.hideWeeklyQuotaThreshold
  );
  const highWeeklyQuotaHiddenAccountIds = getHighWeeklyQuotaHiddenAccountIds(
    snapshot.accounts,
    snapshot.settings.unhideWeeklyQuotaThreshold
  );
  const hiddenAccountsToggleLabel = resolveHiddenAccountsToggleLabel(
    snapshot.lang,
    showHiddenAccounts,
    hiddenAccountCount
  );

  const handleAccountPageSizeChange = (pageSize: number): void => {
    const nextPageSize = DASHBOARD_ACCOUNT_PAGE_SIZE_OPTIONS.find((option) => option === pageSize);
    if (nextPageSize === undefined) {
      return;
    }
    setAccountsPageSize(nextPageSize);
    setAccountsPage(1);
    setAccountPageJumpInput("");
  };

  const handleAccountPageJump = (): void => {
    const requestedPage = Number.parseInt(accountPageJumpInput.trim(), 10);
    if (!Number.isInteger(requestedPage)) {
      setAccountPageJumpInput("");
      return;
    }
    setAccountsPage(Math.min(displayedAccountPage.pageCount, Math.max(1, requestedPage)));
    setAccountPageJumpInput("");
  };

  const handleAutoRefreshToggle = (enabled: boolean): void => {
    const nextMinutes = enabled ? state.lastEnabledAutoRefreshMinutes || 15 : 0;
    patchSettings({ autoRefreshMinutes: nextMinutes });
    sendSetting("autoRefreshMinutes", nextMinutes);
  };

  const handleAutoRefreshValue = (minutes: number): void => {
    patchSettings({ autoRefreshMinutes: minutes });
    sendSetting("autoRefreshMinutes", minutes);
  };

  const handleThresholdPreview = (key: "yellow" | "green", value: number): void => {
    const thresholds =
      key === "yellow"
        ? normalizeThresholds(snapshot.settings.quotaGreenThreshold, value)
        : normalizeThresholds(value, snapshot.settings.quotaYellowThreshold);

    patchSettings({
      quotaGreenThreshold: thresholds.green,
      quotaYellowThreshold: thresholds.yellow
    });
  };

  const handleThresholdCommit = (key: "yellow" | "green", value: number): void => {
    const thresholds =
      key === "yellow"
        ? normalizeThresholds(snapshot.settings.quotaGreenThreshold, value)
        : normalizeThresholds(value, snapshot.settings.quotaYellowThreshold);

    patchSettings({
      quotaGreenThreshold: thresholds.green,
      quotaYellowThreshold: thresholds.yellow
    });
    sendSetting("quotaYellowThreshold", thresholds.yellow);
    sendSetting("quotaGreenThreshold", thresholds.green);
  };

  const handleAccountGroupVisibilityToggle = (group: CodexAccountGroup): void => {
    const key = getAccountGroupVisibilityKey(group);
    const nextVisible = !snapshot.settings[key];
    setAccountsPage(1);
    patchSettings({ [key]: nextVisible });
    sendSetting(key, nextVisible);
  };

  const handleAccountPlanFilterToggle = (plan: DashboardAccountPlanFilter): void => {
    setAccountsPage(1);
    setSelectedPlanFilters((filters) =>
      filters.includes(plan) ? filters.filter((selectedPlan) => selectedPlan !== plan) : [...filters, plan]
    );
  };

  const selectedAccountIds = new Set(state.selectedAccountIds);
  const selectedCount = state.selectedAccountIds.length;
  const isAccountBusy = (accountId: string): boolean =>
    hasGlobalPendingAction || state.pendingActions.some((request) => request.accountId === accountId);
  const privacyToggleLabel = state.privacyMode ? snapshot.copy.showSensitive : snapshot.copy.hideSensitive;
  const announcementUnreadCount = snapshot.announcements.unreadIds.length;
  const prepareOAuthPending = isActionPending("prepareOAuthSession");
  const startOAuthAutoPending = isActionPending("startOAuthAutoFlow");
  const completeOAuthPending = isActionPending("completeOAuthSession");
  const importSharedPending = isActionPending("importSharedJson");
  const previewImportPending = isActionPending("previewImportSharedJson");
  const restoreBackupPending = isActionPending("restoreFromBackup");
  const restoreAuthPending = isActionPending("restoreFromAuthJson");
  const sharePending = isActionPending("shareTokens");
  const downloadSharePending = isActionPending("downloadJsonFile");
  const batchRefreshPending = isActionPending("batchRefresh");
  const batchResyncPending = isActionPending("batchResyncProfile");
  const batchRemovePending = isActionPending("batchRemove");
  const hideAccountsPending = isActionPending("hideAccounts");
  const unhideAccountsPending = isActionPending("unhideAccounts");
  const setAccountGroupPending = isActionPending("setAccountGroup");
  const localUsageRefreshPending = isActionPending("refreshLocalUsage");
  const integrationActionPending = isActionPending("integrationAction");
  const topButtonIntegrations = (snapshot.integrations ?? []).flatMap((integration) => {
    const topButton =
      integration.topButton ??
      (integration.id === "mailbox"
        ? { actionId: "open", label: "Mailbox", tooltip: "打开独立 Mailbox 面板", icon: "mail" as const }
        : undefined);
    const action = topButton ? integration.actions.find((candidate) => candidate.id === topButton.actionId) : undefined;
    return action && topButton ? [{ integration, topButton, action }] : [];
  });
  const invalidAccountCount = snapshot.accounts.filter(
    (account) =>
      !account.dismissedHealth &&
      (account.healthKind === "reauthorize" ||
        account.healthKind === "refresh_failed" ||
        account.healthKind === "disabled" ||
        account.healthKind === "quota")
  ).length;
  const validAccountCount = snapshot.accounts.length - invalidAccountCount;

  const handleShareTokens = (): void => {
    if (!selectedCount) {
      return;
    }
    sendAction("shareTokens", undefined, { accountIds: state.selectedAccountIds });
  };

  const handleEditAccountTags = (account: DashboardAccountViewModel): void => {
    sendAction("updateTags", account.id, {
      mode: "set"
    });
  };

  const handleAutoSwitchLock = (): void => {
    if (!activeAccount) {
      return;
    }
    sendAction("setAutoSwitchLock", activeAccount.id, {
      lockMinutes: activeAccount.autoSwitchLockedUntil ? 0 : resolveLockMinutes(snapshot.settings.autoSwitchLockMinutes)
    });
  };

  return (
    <>
      <div class={`panel ${state.privacyMode ? "privacy-hidden" : ""}`}>
        {snapshot.indexHealth.status !== "healthy" ? (
          <section class="section">
            <RecoveryPanel
              copy={snapshot.copy}
              health={snapshot.indexHealth}
              restoreBackupPending={restoreBackupPending}
              restoreAuthPending={restoreAuthPending}
              restoreJsonPending={importSharedPending && modals.importRecoveryMode}
              onRestoreBackup={() => sendAction("restoreFromBackup")}
              onRestoreAuth={() => sendAction("restoreFromAuthJson")}
              onImportJson={modals.openRecoveryImportModal}
            />
          </section>
        ) : null}
        <section class="section">
          <div class="hero">
            <div class="brand">
              <img class="logo" src={snapshot.logoUri} alt="Codex Accounts Manager logo" />
              <div>
                <h1>Codex Accounts Manager</h1>
                <p>{snapshot.brandSub}</p>
              </div>
            </div>
            <div class="hero-settings">
              <button
                id="announcementsButton"
                class={`settings-btn action-btn icon-only announcement-btn ${announcementUnreadCount > 0 ? "has-unread" : ""}`}
                type="button"
                title={snapshot.copy.announcementsTooltip}
                aria-label={snapshot.copy.announcementsTooltip}
                onClick={() => setAnnouncementsOpen(true)}
              >
                <span class="button-face">
                  <span class="button-icon">
                    <BellIcon />
                  </span>
                </span>
                {announcementUnreadCount > 0 ? (
                  <span class="announcement-button-badge" aria-label={`${announcementUnreadCount} unread`}>
                    {announcementUnreadCount > 9 ? "9+" : announcementUnreadCount}
                  </span>
                ) : null}
                <span class="button-tip" aria-hidden="true">
                  {snapshot.copy.announcementsTooltip}
                </span>
              </button>
              <button
                id="githubProjectButton"
                class="settings-btn action-btn github-project-btn"
                type="button"
                title={snapshot.copy.githubProject}
                aria-label={snapshot.copy.githubProject}
                onClick={() => sendAction("openExternalUrl", undefined, { url: GITHUB_PROJECT_URL })}
              >
                <span class="button-face">
                  <span class="button-icon">
                    <GitHubIcon />
                  </span>
                </span>
                <span class="button-tip" aria-hidden="true">
                  {snapshot.copy.githubProjectTip}
                </span>
              </button>
              <button
                id="privacyToggleButton"
                class={`settings-btn action-btn icon-only ${state.privacyMode ? "is-active" : ""}`}
                type="button"
                title={privacyToggleLabel}
                aria-label={privacyToggleLabel}
                aria-pressed={state.privacyMode}
                onClick={() => dispatch({ type: "toggle-privacy" })}
              >
                <span class="button-face">
                  <span class="button-icon">{state.privacyMode ? <EyeOffIcon /> : <EyeIcon />}</span>
                </span>
                <span class="button-tip" aria-hidden="true">
                  {privacyToggleLabel}
                </span>
              </button>
              <button
                id="refreshViewButton"
                class="settings-btn refresh-view-btn action-btn icon-only"
                type="button"
                title={snapshot.copy.refreshPage}
                aria-label={snapshot.copy.refreshPage}
                disabled={hasGlobalPendingAction || isActionPending("refreshView")}
                aria-busy={isActionPending("refreshView")}
                onClick={() => sendAction("refreshView")}
              >
                <span class="button-face">
                  {isActionPending("refreshView") ? <span class="button-spinner" aria-hidden="true"></span> : null}
                  <span class="button-label">↻</span>
                </span>
                <span class="button-tip" aria-hidden="true">
                  {snapshot.copy.refreshPage}
                </span>
              </button>
              <button
                id="settingsOpenButton"
                class="settings-btn action-btn icon-only"
                type="button"
                title={snapshot.copy.settingsTitle}
                aria-label={snapshot.copy.settingsTitle}
                onClick={() => dispatch({ type: "open-settings" })}
              >
                <span class="button-face">
                  <span class="button-icon">⚙</span>
                </span>
                <span class="button-tip" aria-hidden="true">
                  {snapshot.copy.settingsTitle}
                </span>
              </button>
              <button
                id="aboutOpenButton"
                class="settings-btn action-btn about-btn"
                type="button"
                title={resolveAboutTitle(snapshot.lang)}
                aria-label={resolveAboutTitle(snapshot.lang)}
                onClick={() => setAboutOpen(true)}
              >
                <span class="button-face">
                  <span class="button-icon">
                    <InfoIcon />
                  </span>
                </span>
                <span class="button-tip" aria-hidden="true">
                  {resolveAboutTitle(snapshot.lang)}
                </span>
              </button>
              {topButtonIntegrations.map(({ integration, topButton, action }) => (
                <ActionButton
                  key={integration.id}
                  class="settings-btn integration-top-button"
                  icon={renderIntegrationTopButtonIcon(topButton.icon)}
                  iconOnly
                  label={topButton.label}
                  pending={integrationActionPending}
                  disabled={
                    hasGlobalPendingAction ||
                    action.enabled === false ||
                    snapshot.indexHealth.status === "corrupted_unrecoverable"
                  }
                  tooltip={topButton.tooltip ?? action.tooltip}
                  onClick={() =>
                    sendAction("integrationAction", undefined, {
                      integrationId: integration.id,
                      integrationActionId: action.id
                    })
                  }
                />
              ))}
            </div>
          </div>
          <OverviewSection
            account={overviewAccount}
            hasAccounts={snapshot.accounts.length > 0}
            lang={snapshot.lang}
            copy={snapshot.copy}
            settings={snapshot.settings}
            now={state.now}
            privacyMode={state.privacyMode}
            disabled={hasGlobalPendingAction || snapshot.indexHealth.status === "corrupted_unrecoverable"}
            addPending={prepareOAuthPending}
            importPending={isActionPending("importCurrent")}
            refreshAllPending={isActionPending("refreshAll")}
            refreshPageLabel={resolveRefreshCurrentPageLabel(snapshot.lang, pageAccounts.length)}
            onToggleAutoSwitchLock={handleAutoSwitchLock}
            onAddAccount={modals.openAddAccountModal}
            onImportCurrent={() => sendAction("importCurrent")}
            onRefreshAll={() =>
              sendAction("refreshAll", undefined, { accountIds: pageAccounts.map((account) => account.id) })
            }
          />
        </section>
        {snapshot.accounts.length > 0 ? (
          <section class="section">
            <div class="header" style={{ marginBottom: "12px" }}>
              <div>
                <div class="header-title header-title-with-meta" style={{ fontSize: "14px" }}>
                  {snapshot.copy.savedAccounts}
                  <span class="header-count-badge">
                    {formatSavedAccountsSummary(
                      snapshot.lang,
                      snapshot.accounts.length,
                      validAccountCount,
                      invalidAccountCount
                    )}
                  </span>
                </div>
                <div class="header-sub">{snapshot.copy.savedAccountsSub}</div>
              </div>
              <div class="saved-accounts-header-actions">
                <div class="account-group-filters" aria-label={resolveAccountGroupFiltersLabel(snapshot.lang)}>
                  {ACCOUNT_GROUPS.map((group) => {
                    const key = getAccountGroupVisibilityKey(group);
                    const visible = snapshot.settings[key];
                    const label = resolveAccountGroupVisibilityLabel(snapshot.lang, group, visible);
                    return (
                      <button
                        key={group}
                        class={`account-group-filter ${visible ? "is-active" : ""}`}
                        type="button"
                        title={label}
                        aria-label={label}
                        aria-pressed={visible}
                        onClick={() => handleAccountGroupVisibilityToggle(group)}
                      >
                        {group}
                      </button>
                    );
                  })}
                </div>
                <div class="account-plan-filters" aria-label={resolveAccountPlanFiltersLabel(snapshot.lang)}>
                  {ACCOUNT_PLAN_FILTERS.map((plan) => {
                    const selected = selectedPlanFilters.includes(plan);
                    const label = resolveAccountPlanFilterLabel(snapshot.lang, plan, selected);
                    return (
                      <button
                        key={plan}
                        class={`account-plan-filter ${selected ? "is-active" : ""}`}
                        type="button"
                        title={label}
                        aria-label={label}
                        aria-pressed={selected}
                        onClick={() => handleAccountPlanFilterToggle(plan)}
                      >
                        {resolveAccountPlanFilterName(plan)}
                      </button>
                    );
                  })}
                </div>
                <button
                  id="hiddenAccountsToggleButton"
                  class={`settings-btn action-btn icon-only ${showHiddenAccounts ? "is-active" : ""}`}
                  type="button"
                  title={hiddenAccountsToggleLabel}
                  aria-label={hiddenAccountsToggleLabel}
                  aria-pressed={showHiddenAccounts}
                  disabled={hiddenAccountCount === 0}
                  onClick={() => {
                    setAccountsPage(1);
                    setShowHiddenAccounts((visible) => !visible);
                  }}
                >
                  <span class="button-face">
                    <span class="button-icon">{showHiddenAccounts ? <EyeOffIcon /> : <EyeIcon />}</span>
                  </span>
                  <span class="button-tip" aria-hidden="true">
                    {hiddenAccountsToggleLabel}
                  </span>
                </button>
                <ActionButton
                  class="toolbar-btn"
                  pending={hideAccountsPending}
                  disabled={
                    lowWeeklyQuotaAccountIds.length === 0 ||
                    unhideAccountsPending ||
                    hasGlobalPendingAction ||
                    snapshot.indexHealth.status === "corrupted_unrecoverable"
                  }
                  onClick={() =>
                    sendAction("hideAccounts", undefined, {
                      accountIds: lowWeeklyQuotaAccountIds
                    })
                  }
                >
                  {resolveHideLowWeeklyQuotaLabel(
                    snapshot.lang,
                    lowWeeklyQuotaAccountIds.length,
                    snapshot.settings.hideWeeklyQuotaThreshold
                  )}
                </ActionButton>
                <ActionButton
                  class="toolbar-btn"
                  pending={unhideAccountsPending}
                  disabled={
                    highWeeklyQuotaHiddenAccountIds.length === 0 ||
                    hideAccountsPending ||
                    hasGlobalPendingAction ||
                    snapshot.indexHealth.status === "corrupted_unrecoverable"
                  }
                  onClick={() =>
                    sendAction("unhideAccounts", undefined, {
                      accountIds: highWeeklyQuotaHiddenAccountIds,
                      clearAccountGroup: true
                    })
                  }
                >
                  {resolveUnhideHighWeeklyQuotaLabel(
                    snapshot.lang,
                    highWeeklyQuotaHiddenAccountIds.length,
                    snapshot.settings.unhideWeeklyQuotaThreshold
                  )}
                </ActionButton>
                {selectedCount > 0 ? (
                  <BatchSelectionBar
                    copy={snapshot.copy}
                    lang={snapshot.lang}
                    selectedCount={selectedCount}
                    refreshPending={batchRefreshPending}
                    resyncPending={batchResyncPending}
                    removePending={batchRemovePending}
                    sharePending={sharePending}
                    hidePending={hideAccountsPending}
                    unhidePending={unhideAccountsPending}
                    groupPending={setAccountGroupPending}
                    onRefresh={() => sendAction("batchRefresh", undefined, { accountIds: state.selectedAccountIds })}
                    onResync={() =>
                      sendAction("batchResyncProfile", undefined, { accountIds: state.selectedAccountIds })
                    }
                    onRemove={() => sendAction("batchRemove", undefined, { accountIds: state.selectedAccountIds })}
                    onShare={handleShareTokens}
                    onSetBalancePool={() =>
                      sendAction("setBalancePool", undefined, { accountIds: state.selectedAccountIds })
                    }
                    onRemoveFromBalancePool={() =>
                      sendAction("removeFromBalancePool", undefined, { accountIds: state.selectedAccountIds })
                    }
                    onHide={() => sendAction("hideAccounts", undefined, { accountIds: state.selectedAccountIds })}
                    onUnhide={() => sendAction("unhideAccounts", undefined, { accountIds: state.selectedAccountIds })}
                    onSetAccountGroup={(accountGroup) =>
                      sendAction("setAccountGroup", undefined, { accountIds: state.selectedAccountIds, accountGroup })
                    }
                  />
                ) : null}
              </div>
            </div>
            <div class="accounts-grid">
              {pageAccounts.map((account) => (
                <SavedAccountCard
                  key={account.id}
                  account={account}
                  lang={snapshot.lang}
                  copy={snapshot.copy}
                  settings={snapshot.settings}
                  now={state.now}
                  privacyMode={state.privacyMode}
                  busy={isAccountBusy(account.id)}
                  reloadPromptPending={isActionPending("reloadPrompt", account.id)}
                  switchPending={isActionPending("switch", account.id)}
                  reauthorizePending={isActionPending("reauthorize", account.id)}
                  resyncProfilePending={isActionPending("resyncProfile", account.id)}
                  refreshPending={isActionPending("refresh", account.id)}
                  copyImportJsonPending={isActionPending("copyAccountImportJson", account.id)}
                  copyImportJsonSucceeded={modals.copyFeedbackKey === `account-import-json:${account.id}`}
                  quotaCountdownStartPending={isActionPending("startQuotaCountdown", account.id)}
                  detailsPending={isActionPending("details", account.id)}
                  removePending={isActionPending("remove", account.id)}
                  togglePending={isActionPending("toggleStatusBar", account.id)}
                  poolTogglePending={isActionPending("toggleBalancePool", account.id)}
                  updateTagsPending={isActionPending("updateTags", account.id)}
                  consumeResetCreditPending={isActionPending("consumeResetCredit", account.id)}
                  providerActionPending={state.pendingActions.some(
                    (request) => request.action === "integrationAction" && request.accountId === account.id
                  )}
                  selected={selectedAccountIds.has(account.id)}
                  onToggleSelected={() => dispatch({ type: "toggle-select", accountId: account.id })}
                  onEditTags={() => handleEditAccountTags(account)}
                  onAction={sendAction}
                />
              ))}
            </div>
            {displayedAccounts.length > 0 ? (
              <nav
                class="saved-accounts-pagination"
                aria-label={resolveAccountPaginationLabel(snapshot.lang, displayedAccountPage)}
              >
                <div class="account-page-control">
                  <label class="account-page-label" for="account-page-size">
                    {resolveAccountPageSizeLabel(snapshot.lang)}
                  </label>
                  <select
                    id="account-page-size"
                    class="account-page-select"
                    aria-label={resolveAccountPageSizeLabel(snapshot.lang)}
                    value={accountsPageSize}
                    onChange={(event) => handleAccountPageSizeChange(Number(event.currentTarget.value))}
                  >
                    {DASHBOARD_ACCOUNT_PAGE_SIZE_OPTIONS.map((pageSize) => (
                      <option key={pageSize} value={pageSize}>
                        {pageSize}
                      </option>
                    ))}
                  </select>
                </div>
                <div class="account-page-navigation">
                  <button
                    class="account-page-btn"
                    type="button"
                    disabled={displayedAccountPage.page <= 1}
                    onClick={() => {
                      setAccountsPage(displayedAccountPage.page - 1);
                      setAccountPageJumpInput("");
                    }}
                  >
                    {resolvePreviousPageLabel(snapshot.lang)}
                  </button>
                  <span class="account-page-status" aria-live="polite">
                    {resolveAccountPaginationLabel(snapshot.lang, displayedAccountPage)}
                  </span>
                  <button
                    class="account-page-btn"
                    type="button"
                    disabled={displayedAccountPage.page >= displayedAccountPage.pageCount}
                    onClick={() => {
                      setAccountsPage(displayedAccountPage.page + 1);
                      setAccountPageJumpInput("");
                    }}
                  >
                    {resolveNextPageLabel(snapshot.lang)}
                  </button>
                </div>
                <form
                  class="account-page-jump"
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleAccountPageJump();
                  }}
                >
                  <label class="account-page-label" for="account-page-jump-input">
                    {resolveAccountPageJumpLabel(snapshot.lang)}
                  </label>
                  <input
                    id="account-page-jump-input"
                    class="account-page-input"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max={displayedAccountPage.pageCount}
                    value={accountPageJumpInput}
                    placeholder={String(displayedAccountPage.page)}
                    aria-label={resolveAccountPageJumpLabel(snapshot.lang)}
                    onInput={(event) => setAccountPageJumpInput(event.currentTarget.value)}
                  />
                  <button class="account-page-btn" type="submit">
                    {resolveAccountPageJumpButtonLabel(snapshot.lang)}
                  </button>
                </form>
              </nav>
            ) : null}
            {displayedAccounts.length === 0 ? (
              <div class="saved-accounts-hidden-empty">
                {selectedPlanFilters.length > 0
                  ? resolveAccountPlanFilterEmptyLabel(snapshot.lang)
                  : hiddenAccountCount > 0 && !showHiddenAccounts
                    ? resolveHiddenAccountsEmptyLabel(snapshot.lang)
                    : resolveAccountGroupEmptyLabel(snapshot.lang)}
              </div>
            ) : null}
          </section>
        ) : null}
        <IntegrationCards
          integrations={(snapshot.integrations ?? []).filter(
            (integration) => !topButtonIntegrations.some((item) => item.integration.id === integration.id)
          )}
          busy={hasGlobalPendingAction || snapshot.indexHealth.status === "corrupted_unrecoverable"}
          actionPending={integrationActionPending}
          onAction={(integrationId, integrationActionId) =>
            sendAction("integrationAction", undefined, { integrationId, integrationActionId })
          }
        />
        <LocalUsageSection
          usage={snapshot.localUsage}
          copy={snapshot.copy}
          settings={snapshot.settings}
          refreshPending={localUsageRefreshPending}
          onRefresh={() => sendAction("refreshLocalUsage")}
        />
      </div>

      <SettingsOverlay
        open={state.settingsOpen}
        copy={snapshot.copy}
        lang={snapshot.lang}
        settings={snapshot.settings}
        tokenAutomation={snapshot.tokenAutomation}
        integrationSettings={snapshot.integrationSettings ?? []}
        onClose={() => dispatch({ type: "close-settings" })}
        onPatchSettings={patchSettings}
        onSendSetting={sendSetting}
        onAutoRefreshToggle={handleAutoRefreshToggle}
        onAutoRefreshValue={handleAutoRefreshValue}
        onThresholdPreview={handleThresholdPreview}
        onThresholdCommit={handleThresholdCommit}
        onPickCodexAppPath={() => postMessageToHost({ type: "dashboard:pickCodexAppPath" })}
        onClearCodexAppPath={() => postMessageToHost({ type: "dashboard:clearCodexAppPath" })}
        onIntegrationSettingToggle={(settingId, enabled) =>
          sendAction("integrationSetting", undefined, { integrationSettingId: settingId, enabled })
        }
        onResetSeamlessSwitchRuntime={() => sendAction("resetSeamlessSwitchRuntime")}
      />

      <AnnouncementCenter
        open={announcementsOpen}
        copy={snapshot.copy}
        state={snapshot.announcements}
        refreshPending={isActionPending("refreshAnnouncements")}
        markAllPending={isActionPending("markAllAnnouncementsRead")}
        onClose={() => setAnnouncementsOpen(false)}
        onAction={sendAction}
      />

      <AboutModal
        open={aboutOpen}
        lang={snapshot.lang}
        logoUri={snapshot.logoUri}
        version={packageJson.version}
        onClose={() => setAboutOpen(false)}
        onOpenExternal={(url) => sendAction("openExternalUrl", undefined, { url })}
      />

      <AddAccountModal
        open={modals.addAccountModalOpen}
        tab={modals.addAccountTab}
        copy={snapshot.copy}
        oauthSession={modals.oauthSession}
        oauthCallbackUrl={modals.oauthCallbackUrl}
        oauthError={modals.oauthError}
        importJsonText={modals.importJsonText}
        importJsonError={modals.importJsonError}
        importPreview={modals.importPreview}
        importResult={modals.importResult}
        copyFeedbackKey={modals.copyFeedbackKey}
        lang={snapshot.lang}
        startOAuthAutoPending={startOAuthAutoPending}
        completeOAuthPending={completeOAuthPending}
        previewImportPending={previewImportPending}
        importSharedPending={importSharedPending}
        onClose={() => modals.closeAddAccountModal(completeOAuthPending)}
        onSelectTab={modals.handleAddAccountTabChange}
        onCopyOauthLink={modals.handleCopyOauthLink}
        onOpenInBrowser={modals.handleStartOAuthAutoFlow}
        onOauthCallbackChange={modals.setOauthCallbackUrl}
        onCompleteOAuth={modals.handleCompleteOAuth}
        onImportFileSelected={modals.handleImportFileSelected}
        onImportTextChange={modals.handleImportTextChange}
        onPreviewImport={modals.handlePreviewImport}
        onSubmitImport={modals.handleSubmitImport}
      />

      <ConfirmCancelOauthModal
        open={modals.confirmCancelOauthOpen}
        copy={snapshot.copy}
        onClose={modals.closeConfirmCancelOauth}
        onConfirm={modals.confirmCancelOauth}
      />

      <ShareTokenModal
        open={modals.shareModalOpen}
        copy={snapshot.copy}
        selectedCount={selectedCount}
        shareModalJson={modals.shareModalJson}
        sharePreviewExpanded={modals.sharePreviewExpanded}
        copyFeedbackKey={modals.copyFeedbackKey}
        downloadSharePending={downloadSharePending}
        onClose={modals.closeShareModal}
        onTogglePreview={modals.toggleSharePreview}
        onCopyJson={modals.handleCopyShareJson}
        onDownloadJson={modals.handleDownloadShareJson}
      />
    </>
  );
}

function renderIntegrationTopButtonIcon(icon: "mail" | "bugteam" | "default" | undefined) {
  if (icon === "mail") {
    return <MailIcon />;
  }
  if (icon === "bugteam") {
    return <BugTeamIcon />;
  }
  return <GlobeIcon />;
}

function resolveAboutTitle(lang: string): string {
  if (lang === "zh") {
    return "关于";
  }
  if (lang === "zh-hant") {
    return "關於";
  }
  return "About";
}

function resolveHiddenAccountsToggleLabel(lang: string, visible: boolean, count: number): string {
  if (lang === "zh") {
    return visible ? `隐藏已隐藏账号（${count}）` : `显示隐藏账号（${count}）`;
  }
  if (lang === "zh-hant") {
    return visible ? `隱藏已隱藏帳號（${count}）` : `顯示隱藏帳號（${count}）`;
  }
  return visible ? `Hide hidden accounts (${count})` : `Show hidden accounts (${count})`;
}

function resolveHiddenAccountsEmptyLabel(lang: string): string {
  if (lang === "zh") {
    return "所有账号均已隐藏。使用右上角眼睛按钮显示它们。";
  }
  if (lang === "zh-hant") {
    return "所有帳號均已隱藏。使用右上角眼睛按鈕顯示它們。";
  }
  return "All accounts are hidden. Use the eye button above to show them.";
}

function resolveHideLowWeeklyQuotaLabel(lang: string, count: number, threshold: number): string {
  if (lang === "zh") {
    return `隐藏周额度 ≤${threshold}%（${count}）`;
  }
  if (lang === "zh-hant") {
    return `隱藏週額度 ≤${threshold}%（${count}）`;
  }
  return `Hide weekly ≤${threshold}% (${count})`;
}

function resolveUnhideHighWeeklyQuotaLabel(lang: string, count: number, threshold: number): string {
  if (lang === "zh") {
    return `解除隐藏周额度 ≥${threshold}%（${count}）`;
  }
  if (lang === "zh-hant") {
    return `解除隱藏週額度 ≥${threshold}%（${count}）`;
  }
  return `Show weekly ≥${threshold}% (${count})`;
}

function resolveAccountPaginationLabel(
  lang: string,
  page: { page: number; pageCount: number; startIndex: number; endIndex: number }
): string {
  if (lang === "zh") {
    return `第 ${page.page}/${page.pageCount} 页 · ${page.startIndex + 1}-${page.endIndex}`;
  }
  if (lang === "zh-hant") {
    return `第 ${page.page}/${page.pageCount} 頁 · ${page.startIndex + 1}-${page.endIndex}`;
  }
  return `Page ${page.page}/${page.pageCount} · ${page.startIndex + 1}-${page.endIndex}`;
}

function resolvePreviousPageLabel(lang: string): string {
  if (lang === "zh") {
    return "上一页";
  }
  if (lang === "zh-hant") {
    return "上一頁";
  }
  return "Previous";
}

function resolveNextPageLabel(lang: string): string {
  if (lang === "zh") {
    return "下一页";
  }
  if (lang === "zh-hant") {
    return "下一頁";
  }
  return "Next";
}

function resolveAccountPageSizeLabel(lang: string): string {
  if (lang === "zh") {
    return "每页账号";
  }
  if (lang === "zh-hant") {
    return "每頁帳號";
  }
  return "Per page";
}

function resolveAccountPageJumpLabel(lang: string): string {
  if (lang === "zh") {
    return "跳转页码";
  }
  if (lang === "zh-hant") {
    return "跳轉頁碼";
  }
  return "Jump to";
}

function resolveAccountPageJumpButtonLabel(lang: string): string {
  if (lang === "zh") {
    return "跳转";
  }
  if (lang === "zh-hant") {
    return "跳轉";
  }
  return "Go";
}

function resolveRefreshCurrentPageLabel(lang: string, count: number): string {
  if (lang === "zh") {
    return `刷新当前页配额（${count}）`;
  }
  if (lang === "zh-hant") {
    return `重新整理目前頁面配額（${count}）`;
  }
  return `Refresh current page (${count})`;
}

function resolveAccountGroupFiltersLabel(lang: string): string {
  if (lang === "zh") {
    return "账号分组筛选";
  }
  if (lang === "zh-hant") {
    return "帳號分組篩選";
  }
  return "Account group filters";
}

function resolveAccountPlanFiltersLabel(lang: string): string {
  if (lang === "zh") {
    return "账号套餐筛选";
  }
  if (lang === "zh-hant") {
    return "帳號方案篩選";
  }
  return "Account plan filters";
}

function resolveAccountPlanFilterName(plan: DashboardAccountPlanFilter): string {
  return plan === "free" ? "Free" : plan === "plus" ? "Plus" : "Pro";
}

function resolveAccountPlanFilterLabel(lang: string, plan: DashboardAccountPlanFilter, selected: boolean): string {
  const label = resolveAccountPlanFilterName(plan);
  if (lang === "zh") {
    return selected ? `取消筛选 ${label}` : `筛选 ${label}`;
  }
  if (lang === "zh-hant") {
    return selected ? `取消篩選 ${label}` : `篩選 ${label}`;
  }
  return selected ? `Remove ${label} filter` : `Filter ${label}`;
}

function resolveAccountGroupVisibilityLabel(lang: string, group: CodexAccountGroup, visible: boolean): string {
  if (lang === "zh") {
    return visible ? `隐藏分组 ${group}` : `显示分组 ${group}`;
  }
  if (lang === "zh-hant") {
    return visible ? `隱藏分組 ${group}` : `顯示分組 ${group}`;
  }
  return visible ? `Hide group ${group}` : `Show group ${group}`;
}

function resolveAccountGroupEmptyLabel(lang: string): string {
  if (lang === "zh") {
    return "当前筛选未显示任何账号。未分组的未隐藏账号始终显示。";
  }
  if (lang === "zh-hant") {
    return "目前篩選沒有顯示帳號。未分組且未隱藏的帳號會一律顯示。";
  }
  return "No accounts match the current group filters. Ungrouped, non-hidden accounts always remain visible.";
}

function resolveAccountPlanFilterEmptyLabel(lang: string): string {
  if (lang === "zh") {
    return "当前套餐、分组和隐藏筛选未显示任何账号。取消套餐筛选可显示所有套餐。";
  }
  if (lang === "zh-hant") {
    return "目前方案、分組與隱藏篩選沒有顯示帳號。取消方案篩選即可顯示所有方案。";
  }
  return "No accounts match the current plan, group, and hidden-account filters. Clear plan filters to show every plan.";
}

render(<App />, document.getElementById("app")!);

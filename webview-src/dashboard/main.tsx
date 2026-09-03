import { render } from "preact";
import { useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import packageJson from "../../package.json";
import type { CodexAccountGroup } from "../../src/core/types";
import {
  DASHBOARD_ACCOUNT_PAGE_SIZE_OPTIONS,
  DASHBOARD_ACCOUNTS_PAGE_SIZE,
  type DashboardAccountPageSize,
  type DashboardAccountPlanFilter,
  type DashboardSettingKey
} from "../../src/domain/dashboard/types";
import { AnnouncementCenter } from "./announcementCenter";
import { ActionButton, BatchSelectionBar, OverviewSection, RecoveryPanel } from "./components";
import { postMessageToHost } from "./host";
import {
  formatSavedAccountsSummary,
  formatTemplate,
  getDashboardAccountPage,
  getHighWeeklyQuotaHiddenAccountIds,
  getLowWeeklyQuotaAccountIds,
  getDashboardVisibleAccounts,
  getBlockedAccountIds,
  isMailboxIntegrationActive,
  normalizeThresholds,
  resolveLockMinutes,
  resolveOverviewAccount,
  sortDashboardAccountsForDisplay,
  type DashboardAccountSort,
  type DashboardAccountSortKey
} from "./helpers";
import { useDashboardActions, useDashboardHostSync, useDashboardModals } from "./hooks";
import {
  BellIcon,
  BugTeamIcon,
  EyeIcon,
  EyeOffIcon,
  GitHubIcon,
  GlobeIcon,
  InfoIcon,
  MailIcon,
  UnlockIcon
} from "./icons";
import { AboutModal, AddAccountModal, ConfirmCancelOauthModal, SettingsOverlay, ShareTokenModal } from "./panels";
import { SavedAccountCard } from "./savedAccountCard";
import { LocalUsageSection } from "./localUsageSection";
import { IntegrationCards } from "./integrationCards";
import { createInitialState, reducer } from "./state";
import { resolveDashboardThemeFromMedia } from "./theme";

const GITHUB_PROJECT_URL = "https://github.com/wannanbigpig/codex-tools";
const ACCOUNT_GROUPS: readonly CodexAccountGroup[] = ["A", "B", "C"];
const ACCOUNT_PLAN_FILTERS: readonly DashboardAccountPlanFilter[] = ["free", "plus", "pro"];
const ACCOUNT_SORT_KEYS: readonly DashboardAccountSortKey[] = ["name", "createdAt", "quota", "quotaUpdatedAt"];

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
  const lastDashboardAccountOrderRef = useRef("");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [announcementsOpen, setAnnouncementsOpen] = useState(false);
  const [showHiddenAccounts, setShowHiddenAccounts] = useState(false);
  const [selectedPlanFilters, setSelectedPlanFilters] = useState<DashboardAccountPlanFilter[]>([]);
  const [accountSort, setAccountSort] = useState<DashboardAccountSort>({
    key: "createdAt",
    direction: "desc"
  });
  const [accountsPage, setAccountsPage] = useState(1);
  const [accountsPageSize, setAccountsPageSize] = useState<DashboardAccountPageSize>(DASHBOARD_ACCOUNTS_PAGE_SIZE);
  const [accountPageJumpInput, setAccountPageJumpInput] = useState("");
  const { patchSettings, sendAction, sendSetting, isActionPending, hasGlobalPendingAction } = useDashboardActions(
    state,
    dispatch
  );
  const snapshot = state.snapshot;
  const displayedAccounts = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    const visibleAccounts = getDashboardVisibleAccounts(
      snapshot.accounts,
      snapshot.settings,
      showHiddenAccounts,
      selectedPlanFilters
    );
    return sortDashboardAccountsForDisplay(visibleAccounts, accountSort);
  }, [accountSort, selectedPlanFilters, showHiddenAccounts, snapshot]);
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
    accountSort,
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

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    const accountIds = sortDashboardAccountsForDisplay(snapshot.accounts, accountSort).map((account) => account.id);
    const orderSignature = accountIds.join("\u0000");
    if (lastDashboardAccountOrderRef.current === orderSignature) {
      return;
    }
    lastDashboardAccountOrderRef.current = orderSignature;
    postMessageToHost({
      type: "dashboard:account-order",
      accountIds
    });
  }, [accountSort, snapshot]);

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
  const blockedAccountIds = getBlockedAccountIds(snapshot.accounts);
  const blockedAccountCount = blockedAccountIds.length;
  const mailboxIntegrationActive = isMailboxIntegrationActive(snapshot.integrations);
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

  const handleAccountSort = (key: DashboardAccountSortKey): void => {
    setAccountsPage(1);
    setAccountSort((current) =>
      current.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" }
    );
  };

  const handleForceFastModeToggle = (enabled: boolean): void => {
    patchSettings({ forceFastModeEnabled: enabled });
    sendSetting("forceFastModeEnabled", enabled);
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
  const unlockCodexSessionLocksPending = isActionPending("unlockCodexSessionLocks");
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
                id="unlockCodexSessionLocksButton"
                class="settings-btn action-btn icon-only"
                type="button"
                title={resolveUnlockCodexSessionLocksLabel(snapshot.lang)}
                aria-label={resolveUnlockCodexSessionLocksLabel(snapshot.lang)}
                disabled={hasGlobalPendingAction || unlockCodexSessionLocksPending}
                aria-busy={unlockCodexSessionLocksPending}
                onClick={() => sendAction("unlockCodexSessionLocks")}
              >
                <span class="button-face">
                  {unlockCodexSessionLocksPending ? (
                    <span class="button-spinner" aria-hidden="true"></span>
                  ) : (
                    <span class="button-icon">
                      <UnlockIcon />
                    </span>
                  )}
                </span>
                <span class="button-tip" aria-hidden="true">
                  {resolveUnlockCodexSessionLocksLabel(snapshot.lang)}
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
                <div
                  class="account-sort-controls"
                  role="group"
                  aria-label={resolveAccountControlsLabel(snapshot.lang)}
                >
                  <button
                    id="forceFastModeToggle"
                    class={`account-fast-mode-toggle ${snapshot.settings.forceFastModeEnabled ? "is-active" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={snapshot.settings.forceFastModeEnabled}
                    aria-label={resolveForceFastModeToggleLabel(
                      snapshot.lang,
                      snapshot.settings.forceFastModeEnabled
                    )}
                    title={resolveForceFastModeToggleLabel(snapshot.lang, snapshot.settings.forceFastModeEnabled)}
                    onClick={() => handleForceFastModeToggle(!snapshot.settings.forceFastModeEnabled)}
                  >
                    <span class="account-fast-mode-label">Fast</span>
                    <span class="account-fast-mode-track" aria-hidden="true">
                      <span class="account-fast-mode-thumb" />
                    </span>
                  </button>
                  <select
                    id="account-sort-select"
                    class="account-sort-select"
                    value={accountSort.key}
                    aria-label={resolveAccountSortSelectLabel(snapshot.lang)}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      const nextKey = ACCOUNT_SORT_KEYS.find((candidate) => candidate === value);
                      if (nextKey) {
                        handleAccountSort(nextKey);
                      }
                    }}
                  >
                    {ACCOUNT_SORT_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {resolveAccountSortName(snapshot.lang, key)}
                      </option>
                    ))}
                  </select>
                  <button
                    class="account-sort-direction"
                    type="button"
                    title={resolveAccountSortDirectionLabel(snapshot.lang, accountSort)}
                    aria-label={resolveAccountSortDirectionLabel(snapshot.lang, accountSort)}
                    onClick={() => handleAccountSort(accountSort.key)}
                  >
                    <span class="account-sort-arrow" aria-hidden="true">
                      {accountSort.direction === "desc" ? "▼" : "▲"}
                    </span>
                  </button>
                </div>
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
                {mailboxIntegrationActive && blockedAccountCount > 0 ? (
                  <ActionButton
                    class="toolbar-btn danger"
                    pending={batchRemovePending}
                    disabled={
                      hasGlobalPendingAction ||
                      snapshot.indexHealth.status === "corrupted_unrecoverable"
                    }
                    onClick={() => sendAction("batchRemove", undefined, { accountIds: blockedAccountIds })}
                  >
                    {formatTemplate(snapshot.copy.removeBlockedAccountsBtn, { count: blockedAccountCount })}
                  </ActionButton>
                ) : null}
                {selectedCount > 0 ? (
                  <BatchSelectionBar
                    copy={snapshot.copy}
                    lang={snapshot.lang}
                    selectedCount={selectedCount}
                    onClearSelection={() => dispatch({ type: "clear-selection" })}
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
                  refreshPending={isActionPending("refresh", account.id)}
                  copyImportJsonPending={isActionPending("copyAccountImportJson", account.id)}
                  copyImportJsonSucceeded={modals.copyFeedbackKey === `account-import-json:${account.id}`}
                  quotaCountdownStartPending={isActionPending("startQuotaCountdown", account.id)}
                  removePending={isActionPending("remove", account.id)}
                  poolTogglePending={isActionPending("toggleBalancePool", account.id)}
                  consumeResetCreditPending={isActionPending("consumeResetCredit", account.id)}
                  providerActionPending={state.pendingActions.some(
                    (request) => request.action === "integrationAction" && request.accountId === account.id
                  )}
                  selected={selectedAccountIds.has(account.id)}
                  onToggleSelected={() => dispatch({ type: "toggle-select", accountId: account.id })}
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

function resolveAccountControlsLabel(lang: string): string {
  if (lang === "zh") {
    return "账号控制";
  }
  if (lang === "zh-hant") {
    return "帳號控制";
  }
  return "Account controls";
}

function resolveUnlockCodexSessionLocksLabel(lang: string): string {
  if (lang === "zh") {
    return "解锁失效 Codex 会话（不终止活跃会话）";
  }
  if (lang === "zh-hant") {
    return "解除失效 Codex 會話鎖（不終止活躍會話）";
  }
  return "Unlock stale Codex sessions (does not terminate active sessions)";
}

function resolveForceFastModeToggleLabel(lang: string, enabled: boolean): string {
  if (lang === "zh") {
    return enabled ? "关闭 Fast 模式（下一回合生效）" : "开启 Fast 模式（下一回合生效）";
  }
  if (lang === "zh-hant") {
    return enabled ? "關閉 Fast 模式（下一回合生效）" : "開啟 Fast 模式（下一回合生效）";
  }
  return enabled ? "Turn off Fast mode (applies next turn)" : "Turn on Fast mode (applies next turn)";
}

function resolveAccountSortSelectLabel(lang: string): string {
  if (lang === "zh") {
    return "选择排序字段";
  }
  if (lang === "zh-hant") {
    return "選擇排序欄位";
  }
  return "Choose sort field";
}

function resolveAccountSortName(lang: string, key: DashboardAccountSortKey): string {
  if (lang === "zh") {
    const labels: Record<DashboardAccountSortKey, string> = {
      name: "名称",
      createdAt: "导入时间",
      quota: "剩余额度",
      quotaUpdatedAt: "额度刷新时间"
    };
    return labels[key];
  }
  if (lang === "zh-hant") {
    const labels: Record<DashboardAccountSortKey, string> = {
      name: "名稱",
      createdAt: "匯入時間",
      quota: "剩餘配額",
      quotaUpdatedAt: "配額更新時間"
    };
    return labels[key];
  }
  const labels: Record<DashboardAccountSortKey, string> = {
    name: "Name",
    createdAt: "Imported",
    quota: "Remaining quota",
    quotaUpdatedAt: "Quota refreshed"
  };
  return labels[key];
}

function resolveAccountSortDirectionLabel(lang: string, sort: DashboardAccountSort): string {
  const name = resolveAccountSortName(lang, sort.key);
  const ascending = sort.direction === "asc";
  if (lang === "zh") {
    return name + (ascending ? "正序" : "倒序") + "，点击切换为" + (ascending ? "倒序" : "正序");
  }
  if (lang === "zh-hant") {
    return name + (ascending ? "正序" : "倒序") + "，點擊切換為" + (ascending ? "倒序" : "正序");
  }
  return name + " " + (ascending ? "ascending" : "descending") + "; click to switch";
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

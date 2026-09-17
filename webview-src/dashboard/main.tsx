import { render } from "preact";
import { useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import packageJson from "../../package.json";
import type { CodexAccountGroup } from "../../src/core/types";
import {
  DASHBOARD_ACCOUNT_PAGE_SIZE_OPTIONS,
  DASHBOARD_ACCOUNTS_PAGE_SIZE,
  type DashboardAccountPageSize,
  type DashboardAccountPlanFilter,
  type DashboardSharingFilter,
  type DashboardSettingKey
} from "../../src/domain/dashboard/types";
import { AnnouncementCenter } from "./announcementCenter";
import { ActionButton, BatchSelectionBar, OverviewSection, RecoveryPanel } from "./components";
import { postMessageToHost } from "./host";
import {
  formatSavedAccountsSummary,
  formatTemplate,
  DASHBOARD_SHARING_FILTERS,
  DASHBOARD_HEALTH_FILTERS,
  getAccountHealthCategory,
  getDashboardAccountPage,
  getDashboardHealthFilterCounts,
  getDashboardSharingFilterCounts,
  getHighWeeklyQuotaHiddenAccountIds,
  getLowWeeklyQuotaAccountIds,
  getDashboardVisibleAccounts,
  getBlockedAccountIds,
  isDashboardAccountInvalid,
  isMailboxIntegrationActive,
  normalizeThresholds,
  resolveLockMinutes,
  resolveOverviewAccount,
  sortDashboardAccountsForDisplay,
  type DashboardAccountSort,
  type DashboardAccountSortKey,
  type DashboardHealthFilter,
  type DashboardSharingFilterValue
} from "./helpers";
import { useDashboardActions, useDashboardHostSync, useDashboardModals } from "./hooks";
import {
  BellIcon,
  EyeIcon,
  EyeOffIcon,
  GitHubIcon,
  GlobeIcon,
  InfoIcon,
  AccountHealthFilterIcon,
  MailIcon,
  SharingIcon,
  UnlockIcon
} from "./icons";
import {
  AboutModal,
  AddAccountModal,
  ConfirmCancelOauthModal,
  SettingsOverlay,
  ShareTokenModal,
  SharingModal
} from "./panels";
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
  const [sharingOpen, setSharingOpen] = useState(false);
  const [sharingAccountIds, setSharingAccountIds] = useState<string[]>([]);
  const [showHiddenAccounts, setShowHiddenAccounts] = useState(false);
  const [selectedHealthFilters, setSelectedHealthFilters] = useState<DashboardHealthFilter[]>([]);
  const [selectedSharingFilters, setSelectedSharingFilters] = useState<DashboardSharingFilter[]>([]);
  const [healthFilterOpen, setHealthFilterOpen] = useState(false);
  const healthFilterRef = useRef<HTMLDivElement>(null);
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
      selectedPlanFilters,
      selectedHealthFilters,
      selectedSharingFilters
    );
    return sortDashboardAccountsForDisplay(visibleAccounts, accountSort);
  }, [accountSort, selectedHealthFilters, selectedPlanFilters, selectedSharingFilters, showHiddenAccounts, snapshot]);
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
    if (!healthFilterOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (!healthFilterRef.current?.contains(event.target as Node)) {
        setHealthFilterOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setHealthFilterOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [healthFilterOpen]);

  useEffect(() => {
    setAccountsPage(1);
  }, [
    selectedHealthFilters,
    selectedSharingFilters,
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
    snapshot.accounts,
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

  const handleHealthFilterToggle = (filter: DashboardHealthFilter): void => {
    setAccountsPage(1);
    setSelectedHealthFilters((filters) =>
      filters.includes(filter) ? filters.filter((selectedFilter) => selectedFilter !== filter) : [...filters, filter]
    );
  };

  const handleSharingFilterToggle = (filter: DashboardSharingFilterValue): void => {
    setAccountsPage(1);
    setSelectedSharingFilters((filters) =>
      filters.includes(filter) ? filters.filter((selectedFilter) => selectedFilter !== filter) : [...filters, filter]
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
  const shareAccountsPending = isActionPending("shareAccounts");
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
        ? { actionId: "open", label: "Mailbox", tooltip: "在当前主编辑器组打开 Mailbox", icon: "mail" as const }
        : undefined);
    const action = topButton ? integration.actions.find((candidate) => candidate.id === topButton.actionId) : undefined;
    return action && topButton ? [{ integration, topButton, action }] : [];
  });
  const invalidAccountCount = snapshot.accounts.filter(isDashboardAccountInvalid).length;
  const healthyAccountCount = snapshot.accounts.filter(
    (account) => getAccountHealthCategory(account.healthKind) === "healthy"
  ).length;
  const warningAccountCount = snapshot.accounts.filter(
    (account) => !isDashboardAccountInvalid(account) && getAccountHealthCategory(account.healthKind) !== "healthy"
  ).length;
  const healthFilterCounts = getDashboardHealthFilterCounts(snapshot.accounts);
  const sharingFilterCounts = getDashboardSharingFilterCounts(snapshot.accounts);
  const selectedFilterCount = selectedHealthFilters.length + selectedSharingFilters.length;
  const healthFilterTotalCount = DASHBOARD_HEALTH_FILTERS.reduce(
    (total, filter) => total + healthFilterCounts[filter],
    0
  );
  const healthFilterToggleLabel = resolveHealthFilterToggleLabel(
    snapshot.lang,
    selectedHealthFilters,
    healthFilterTotalCount,
    selectedSharingFilters.length
  );
  const healthFilterOptions = DASHBOARD_HEALTH_FILTERS.map((filter) => ({
    filter,
    count: healthFilterCounts[filter],
    ...resolveHealthFilterOptionCopy(snapshot.lang, filter)
  }));
  const sharingFilterOptions = DASHBOARD_SHARING_FILTERS.map((filter) => ({
    filter,
    count: sharingFilterCounts[filter],
    ...resolveSharingFilterOptionCopy(snapshot.lang, filter)
  }));

  const handleShareTokens = (): void => {
    if (!selectedCount) {
      return;
    }
    sendAction("shareTokens", undefined, { accountIds: state.selectedAccountIds });
  };

  const openSharingForAccounts = (accountIds: readonly string[]): void => {
    const normalized = [...new Set(accountIds)].filter(Boolean);
    if (normalized.length === 0) {
      return;
    }
    setSharingAccountIds(normalized);
    setSharingOpen(true);
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
              <button
                id="accountSharingButton"
                class="settings-btn action-btn icon-only"
                type="button"
                title={resolveAccountSharingLabel(snapshot.lang)}
                aria-label={resolveAccountSharingLabel(snapshot.lang)}
                disabled={hasGlobalPendingAction}
                onClick={() => {
                  setSharingAccountIds([]);
                  setSharingOpen(true);
                }}
              >
                <span class="button-face">
                  <span class="button-icon">
                    <SharingIcon />
                  </span>
                </span>
                <span class="button-tip" aria-hidden="true">
                  {resolveAccountSharingLabel(snapshot.lang)}
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
                      healthyAccountCount,
                      warningAccountCount,
                      invalidAccountCount
                    )}
                  </span>
                </div>
                <div class="header-sub">{snapshot.copy.savedAccountsSub}</div>
              </div>
              <div class="saved-accounts-header-actions">
                <button
                  id="forceFastModeToggle"
                  class={`account-fast-mode-toggle ${snapshot.settings.forceFastModeEnabled ? "is-active" : ""}`}
                  type="button"
                  role="switch"
                  aria-checked={snapshot.settings.forceFastModeEnabled}
                  aria-label={resolveForceFastModeToggleLabel(snapshot.lang, snapshot.settings.forceFastModeEnabled)}
                  title={resolveForceFastModeToggleLabel(snapshot.lang, snapshot.settings.forceFastModeEnabled)}
                  onClick={() => handleForceFastModeToggle(!snapshot.settings.forceFastModeEnabled)}
                >
                  <span class="account-fast-mode-label">Fast</span>
                  <span class="account-fast-mode-track" aria-hidden="true">
                    <span class="account-fast-mode-thumb" />
                  </span>
                </button>
                <div class="account-sort-controls" role="group" aria-label={resolveAccountControlsLabel(snapshot.lang)}>
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
                <div ref={healthFilterRef} class={`account-health-filter ${healthFilterOpen ? "is-open" : ""}`}>
                  <button
                    id="invalidAccountsToggleButton"
                    class={`settings-btn action-btn icon-only ${selectedFilterCount > 0 ? "is-active" : ""}`}
                    type="button"
                    title={healthFilterToggleLabel}
                    aria-label={healthFilterToggleLabel}
                    aria-pressed={selectedFilterCount > 0}
                    aria-expanded={healthFilterOpen}
                    aria-controls="accountHealthFilterMenu"
                    onClick={() => setHealthFilterOpen((open) => !open)}
                  >
                    <span class="button-face">
                      <span class="button-icon">
                        <AccountHealthFilterIcon />
                      </span>
                    </span>
                    <span class="button-tip" aria-hidden="true">
                      {healthFilterToggleLabel}
                    </span>
                  </button>
                  {healthFilterOpen ? (
                    <div
                      id="accountHealthFilterMenu"
                      class="account-health-filter-menu"
                      role="dialog"
                      aria-labelledby="accountHealthFilterTitle"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div class="account-health-filter-head">
                        <div id="accountHealthFilterTitle" class="account-health-filter-title">
                          {resolveHealthFilterPanelTitle(snapshot.lang)}
                        </div>
                        <button
                          class="account-health-filter-close"
                          type="button"
                          aria-label={resolveHealthFilterCloseLabel(snapshot.lang)}
                          onClick={() => setHealthFilterOpen(false)}
                        >
                          ×
                        </button>
                      </div>
                      <div class="account-health-filter-hint">{resolveHealthFilterPanelHint(snapshot.lang)}</div>
                      <div
                        class="account-health-filter-options"
                        role="group"
                        aria-label={resolveHealthFilterOptionsLabel(snapshot.lang)}
                      >
                        {healthFilterOptions.map((option) => {
                          const selected = selectedHealthFilters.includes(option.filter);
                          return (
                            <label
                              key={option.filter}
                              class={`account-health-filter-option health-filter-${option.filter} ${
                                selected ? "is-selected" : ""
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => handleHealthFilterToggle(option.filter)}
                              />
                              <span class="account-health-filter-dot" aria-hidden="true" />
                              <span class="account-health-filter-copy">
                                <span class="account-health-filter-label">
                                  {option.label}
                                  <span class="account-health-filter-count">{option.count}</span>
                                </span>
                                <span class="account-health-filter-description">{option.description}</span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      <div class="account-health-filter-divider" />
                      <div class="account-health-filter-subtitle">
                        {resolveSharingFilterPanelTitle(snapshot.lang)}
                      </div>
                      <div
                        class="account-health-filter-options"
                        role="group"
                        aria-label={resolveSharingFilterOptionsLabel(snapshot.lang)}
                      >
                        {sharingFilterOptions.map((option) => {
                          const selected = selectedSharingFilters.includes(option.filter);
                          return (
                            <label
                              key={option.filter}
                              class={`account-health-filter-option sharing-filter-${option.filter} ${
                                selected ? "is-selected" : ""
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => handleSharingFilterToggle(option.filter)}
                              />
                              <span class="account-health-filter-dot" aria-hidden="true" />
                              <span class="account-health-filter-copy">
                                <span class="account-health-filter-label">
                                  {option.label}
                                  <span class="account-health-filter-count">{option.count}</span>
                                </span>
                                <span class="account-health-filter-description">{option.description}</span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      <button
                        class="account-health-filter-clear"
                        type="button"
                        disabled={selectedFilterCount === 0}
                        onClick={() => {
                          setAccountsPage(1);
                          setSelectedHealthFilters([]);
                          setSelectedSharingFilters([]);
                        }}
                      >
                        {resolveHealthFilterClearLabel(snapshot.lang)}
                      </button>
                    </div>
                  ) : null}
                </div>
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
                    disabled={hasGlobalPendingAction || snapshot.indexHealth.status === "corrupted_unrecoverable"}
                    onClick={() =>
                      sendAction("batchRemove", undefined, {
                        accountIds: blockedAccountIds,
                        removeLinkedMailboxes: true
                      })
                    }
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
                    shareAccountsPending={shareAccountsPending}
                    hidePending={hideAccountsPending}
                    unhidePending={unhideAccountsPending}
                    groupPending={setAccountGroupPending}
                    onRefresh={() => sendAction("batchRefresh", undefined, { accountIds: state.selectedAccountIds })}
                    onResync={() =>
                      sendAction("batchResyncProfile", undefined, { accountIds: state.selectedAccountIds })
                    }
                    onRemove={() => sendAction("batchRemove", undefined, { accountIds: state.selectedAccountIds })}
                    onShare={handleShareTokens}
                    onShareAccounts={() => openSharingForAccounts(state.selectedAccountIds)}
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
                  shareAccountsPending={isActionPending("shareAccounts", account.id)}
                  returnSharedAccountPending={isActionPending("returnSharedAccount", account.id)}
                  accountNameCopyPending={isActionPending("copyText", account.id)}
                  accountNameCopySucceeded={modals.copyFeedbackKey === `account-name:${account.id}`}
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
                  onRequestShare={() => openSharingForAccounts([account.id])}
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
                {selectedSharingFilters.length > 0
                  ? resolveSharingFilterEmptyLabel(snapshot.lang, selectedSharingFilters)
                  : selectedHealthFilters.length > 0
                  ? resolveHealthFilterEmptyLabel(snapshot.lang, selectedHealthFilters)
                  : selectedPlanFilters.length > 0
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

      <SharingModal
        open={sharingOpen}
        lang={snapshot.lang}
        sharing={snapshot.sharing}
        accountIds={sharingAccountIds}
        pending={hasGlobalPendingAction || isActionPending("manageSharing") || isActionPending("shareAccounts")}
        onClose={() => {
          setSharingOpen(false);
          setSharingAccountIds([]);
        }}
        onAction={sendAction}
      />
    </>
  );
}

function renderIntegrationTopButtonIcon(icon: "mail" | "default" | undefined) {
  if (icon === "mail") {
    return <MailIcon />;
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

function resolveAccountSharingLabel(lang: string): string {
  if (lang === "zh") {
    return "账号共享";
  }
  if (lang === "zh-hant") {
    return "帳號共享";
  }
  return "Account sharing";
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

function resolveHealthFilterToggleLabel(
  lang: string,
  selectedFilters: readonly DashboardHealthFilter[],
  totalCount: number,
  selectedSharingCount = 0
): string {
  const selectedCount = selectedFilters.length + selectedSharingCount;
  if (lang === "zh") {
    return selectedCount > 0 ? `清除状态筛选（${selectedCount}）` : `按颜色筛选账号（${totalCount}）`;
  }
  if (lang === "zh-hant") {
    return selectedCount > 0 ? `清除狀態篩選（${selectedCount}）` : `按顏色篩選帳號（${totalCount}）`;
  }
  return selectedCount > 0
    ? `Clear status filters (${selectedCount})`
    : `Filter accounts by color (${totalCount})`;
}

function resolveHealthFilterPanelTitle(lang: string): string {
  if (lang === "zh") {
    return "账号状态筛选";
  }
  if (lang === "zh-hant") {
    return "帳號狀態篩選";
  }
  return "Account status filters";
}

function resolveHealthFilterPanelHint(lang: string): string {
  if (lang === "zh") {
    return "可多选颜色；未选择时显示所有账号。";
  }
  if (lang === "zh-hant") {
    return "可多選顏色；未選擇時顯示所有帳號。";
  }
  return "Select one or more colors. With none selected, all accounts are shown.";
}

function resolveHealthFilterOptionsLabel(lang: string): string {
  if (lang === "zh") {
    return "账号状态颜色";
  }
  if (lang === "zh-hant") {
    return "帳號狀態顏色";
  }
  return "Account status colors";
}

function resolveSharingFilterPanelTitle(lang: string): string {
  if (lang === "zh") {
    return "共享状态";
  }
  if (lang === "zh-hant") {
    return "共享狀態";
  }
  return "Sharing state";
}

function resolveSharingFilterOptionsLabel(lang: string): string {
  if (lang === "zh") {
    return "共享状态筛选";
  }
  if (lang === "zh-hant") {
    return "共享狀態篩選";
  }
  return "Sharing state filters";
}

function resolveSharingFilterOptionCopy(
  lang: string,
  filter: DashboardSharingFilterValue
): { label: string; description: string } {
  if (filter === "shared") {
    if (lang === "zh") {
      return { label: "靛青 · 已共享", description: "已主动共享给好友，账号暂时隐藏。" };
    }
    if (lang === "zh-hant") {
      return { label: "靛青 · 已共享", description: "已主動共享給好友，帳號暫時隱藏。" };
    }
    return { label: "Indigo · Shared", description: "Explicitly shared with a friend and temporarily hidden." };
  }
  if (lang === "zh") {
    return { label: "青绿 · 借入", description: "好友主动共享给本机的临时账号。" };
  }
  if (lang === "zh-hant") {
    return { label: "青綠 · 借入", description: "好友主動共享給本機的臨時帳號。" };
  }
  return { label: "Teal · Received", description: "A temporary account explicitly shared by a friend." };
}

function resolveSharingFilterEmptyLabel(
  lang: string,
  filters: readonly DashboardSharingFilter[]
): string {
  const includesShared = filters.includes("shared");
  const includesReceived = filters.includes("received");
  if (lang === "zh") {
    return includesShared && includesReceived
      ? "当前没有已共享或借入的账号。"
      : includesShared
        ? "当前没有已共享的账号。"
        : "当前没有借入的账号。";
  }
  if (lang === "zh-hant") {
    return includesShared && includesReceived
      ? "目前沒有已共享或借入的帳號。"
      : includesShared
        ? "目前沒有已共享的帳號。"
        : "目前沒有借入的帳號。";
  }
  return includesShared && includesReceived
    ? "There are no shared or received accounts."
    : includesShared
      ? "There are no shared accounts."
      : "There are no received accounts.";
}

function resolveHealthFilterCloseLabel(lang: string): string {
  if (lang === "zh") {
    return "关闭状态筛选";
  }
  if (lang === "zh-hant") {
    return "關閉狀態篩選";
  }
  return "Close status filters";
}

function resolveHealthFilterClearLabel(lang: string): string {
  if (lang === "zh") {
    return "清除颜色筛选";
  }
  if (lang === "zh-hant") {
    return "清除顏色篩選";
  }
  return "Clear color filters";
}

function resolveHealthFilterOptionCopy(
  lang: string,
  filter: DashboardHealthFilter
): {
  label: string;
  description: string;
} {
  if (lang === "zh") {
    switch (filter) {
      case "unknown":
        return {
          label: "黄色 · 会话状态未知",
          description: "续期验证尚未建立，当前会话是否可用还未确认。"
        };
      case "usable":
        return {
          label: "青色 · 仍可使用",
          description: "自动续期不可用，但当前访问令牌仍可能正常工作。"
        };
      case "warning":
        return {
          label: "橙色 · 需要留意",
          description: "令牌即将过期、续期暂时失败或配额状态异常。"
        };
      case "error":
        return {
          label: "红色 · 账号失效",
          description: "需要重新授权、访问令牌无效或工作区已停用。"
        };
    }
  }
  if (lang === "zh-hant") {
    switch (filter) {
      case "unknown":
        return {
          label: "黃色 · 會話狀態未知",
          description: "尚未建立續期驗證，目前會話是否可用仍未確認。"
        };
      case "usable":
        return {
          label: "青色 · 仍可使用",
          description: "自動續期不可用，但目前存取權杖仍可能正常工作。"
        };
      case "warning":
        return {
          label: "橙色 · 需要留意",
          description: "權杖即將過期、續期暫時失敗或配額狀態異常。"
        };
      case "error":
        return {
          label: "紅色 · 帳號失效",
          description: "需要重新授權、存取權杖無效或工作區已停用。"
        };
    }
  }

  switch (filter) {
    case "unknown":
      return {
        label: "Yellow · Session status unknown",
        description: "Renewal evidence is not established, so session usability is unconfirmed."
      };
    case "usable":
      return {
        label: "Cyan · Still usable",
        description: "Automatic renewal is unavailable, but the current access token may still work."
      };
    case "warning":
      return {
        label: "Orange · Needs attention",
        description: "The token may expire soon, renewal failed temporarily, or quota is abnormal."
      };
    case "error":
      return {
        label: "Red · Account invalid",
        description: "Reauthorization is required, the access token is invalid, or the workspace is disabled."
      };
  }
}

function resolveHealthFilterEmptyLabel(lang: string, selectedFilters: readonly DashboardHealthFilter[]): string {
  const selectedLabels = selectedFilters
    .map((filter) => resolveHealthFilterOptionCopy(lang, filter).label)
    .join(lang === "zh-hant" ? "、" : lang === "zh" ? "、" : ", ");
  if (lang === "zh") {
    return `没有符合当前分组、套餐和状态筛选（${selectedLabels}）的账号。`;
  }
  if (lang === "zh-hant") {
    return `沒有符合目前分組、方案與狀態篩選（${selectedLabels}）的帳號。`;
  }
  return `No accounts match the current group, plan, and status filters (${selectedLabels}).`;
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
    return `显示周额度 ≥${threshold}%（${count}）`;
  }
  if (lang === "zh-hant") {
    return `顯示週額度 ≥${threshold}%（${count}）`;
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
    return "强制解锁 Codex 会话（终止其他窗口运行时）";
  }
  if (lang === "zh-hant") {
    return "強制解除 Codex 會話鎖（終止其他視窗執行時）";
  }
  return "Force-unlock Codex sessions (terminate other-window runtimes)";
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

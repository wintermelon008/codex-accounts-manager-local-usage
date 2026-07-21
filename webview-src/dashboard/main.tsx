import { render } from "preact";
import { useEffect, useReducer, useState } from "preact/hooks";
import packageJson from "../../package.json";
import type { CodexAccountGroup } from "../../src/core/types";
import type {
  DashboardAccountViewModel,
  DashboardSettingKey,
  DashboardSettings
} from "../../src/domain/dashboard/types";
import { AnnouncementCenter } from "./announcementCenter";
import { ActionButton, BatchSelectionBar, OverviewSection, RecoveryPanel } from "./components";
import { postMessageToHost } from "./host";
import {
  formatSavedAccountsSummary,
  getLowWeeklyQuotaAccountIds,
  normalizeThresholds,
  resolveLockMinutes,
  resolveOverviewAccount
} from "./helpers";
import { useDashboardActions, useDashboardHostSync, useDashboardModals } from "./hooks";
import { BellIcon, EyeIcon, EyeOffIcon, GitHubIcon, InfoIcon } from "./icons";
import { AboutModal, AddAccountModal, ConfirmCancelOauthModal, SettingsOverlay, ShareTokenModal } from "./panels";
import { SavedAccountCard } from "./savedAccountCard";
import { LocalUsageSection } from "./localUsageSection";
import { createInitialState, reducer } from "./state";
import { resolveDashboardThemeFromMedia } from "./theme";

const GITHUB_PROJECT_URL = "https://github.com/wannanbigpig/codex-tools";
const ACCOUNT_GROUPS: readonly CodexAccountGroup[] = ["A", "B", "C"];

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

function isAccountInVisibleGroup(account: DashboardAccountViewModel, settings: DashboardSettings): boolean {
  return account.accountGroup == null || settings[getAccountGroupVisibilityKey(account.accountGroup)];
}

function App() {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [announcementsOpen, setAnnouncementsOpen] = useState(false);
  const [showHiddenAccounts, setShowHiddenAccounts] = useState(false);
  const { patchSettings, sendAction, sendSetting, isActionPending, hasGlobalPendingAction } = useDashboardActions(
    state,
    dispatch
  );
  const snapshot = state.snapshot;
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
  const displayedAccounts = snapshot.accounts.filter(
    (account) => isAccountInVisibleGroup(account, snapshot.settings) && (showHiddenAccounts || !account.isHidden)
  );
  const lowWeeklyQuotaAccountIds = getLowWeeklyQuotaAccountIds(displayedAccounts);
  const hiddenAccountsToggleLabel = resolveHiddenAccountsToggleLabel(
    snapshot.lang,
    showHiddenAccounts,
    hiddenAccountCount
  );

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
    patchSettings({ [key]: nextVisible });
    sendSetting(key, nextVisible);
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
  const batchTagsPending = state.pendingActions.some(
    (request) => request.action === "updateTags" && request.accountId == null
  );
  const hideAccountsPending = isActionPending("hideAccounts");
  const unhideAccountsPending = isActionPending("unhideAccounts");
  const setAccountGroupPending = isActionPending("setAccountGroup");
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

  const handleBatchTagMutation = (mode: "add" | "remove"): void => {
    if (!selectedCount) {
      return;
    }
    sendAction("updateTags", undefined, {
      accountIds: state.selectedAccountIds,
      mode
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
            onToggleAutoSwitchLock={handleAutoSwitchLock}
            onAddAccount={modals.openAddAccountModal}
            onImportCurrent={() => sendAction("importCurrent")}
            onRefreshAll={() =>
              sendAction("refreshAll", undefined, { accountIds: displayedAccounts.map((account) => account.id) })
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
                <button
                  id="hiddenAccountsToggleButton"
                  class={`settings-btn action-btn icon-only ${showHiddenAccounts ? "is-active" : ""}`}
                  type="button"
                  title={hiddenAccountsToggleLabel}
                  aria-label={hiddenAccountsToggleLabel}
                  aria-pressed={showHiddenAccounts}
                  disabled={hiddenAccountCount === 0}
                  onClick={() => setShowHiddenAccounts((visible) => !visible)}
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
                  {resolveHideLowWeeklyQuotaLabel(snapshot.lang, lowWeeklyQuotaAccountIds.length)}
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
                    tagsPending={batchTagsPending}
                    hidePending={hideAccountsPending}
                    unhidePending={unhideAccountsPending}
                    groupPending={setAccountGroupPending}
                    onRefresh={() => sendAction("batchRefresh", undefined, { accountIds: state.selectedAccountIds })}
                    onResync={() =>
                      sendAction("batchResyncProfile", undefined, { accountIds: state.selectedAccountIds })
                    }
                    onRemove={() => sendAction("batchRemove", undefined, { accountIds: state.selectedAccountIds })}
                    onShare={handleShareTokens}
                    onAddTags={() => handleBatchTagMutation("add")}
                    onRemoveTags={() => handleBatchTagMutation("remove")}
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
              {displayedAccounts.map((account) => (
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
                  detailsPending={isActionPending("details", account.id)}
                  removePending={isActionPending("remove", account.id)}
                  togglePending={isActionPending("toggleStatusBar", account.id)}
                  poolTogglePending={isActionPending("toggleBalancePool", account.id)}
                  updateTagsPending={isActionPending("updateTags", account.id)}
                  consumeResetCreditPending={isActionPending("consumeResetCredit", account.id)}
                  selected={selectedAccountIds.has(account.id)}
                  onToggleSelected={() => dispatch({ type: "toggle-select", accountId: account.id })}
                  onEditTags={() => handleEditAccountTags(account)}
                  onAction={sendAction}
                />
              ))}
            </div>
            {displayedAccounts.length === 0 ? (
              <div class="saved-accounts-hidden-empty">
                {hiddenAccountCount > 0 && !showHiddenAccounts
                  ? resolveHiddenAccountsEmptyLabel(snapshot.lang)
                  : resolveAccountGroupEmptyLabel(snapshot.lang)}
              </div>
            ) : null}
          </section>
        ) : null}
        <LocalUsageSection
          usage={snapshot.localUsage}
          copy={snapshot.copy}
          settings={snapshot.settings}
          onRangeChange={(range) => {
            sendSetting("localUsageDefaultRange", range);
          }}
        />
      </div>

      <SettingsOverlay
        open={state.settingsOpen}
        copy={snapshot.copy}
        lang={snapshot.lang}
        settings={snapshot.settings}
        tokenAutomation={snapshot.tokenAutomation}
        onClose={() => dispatch({ type: "close-settings" })}
        onPatchSettings={patchSettings}
        onSendSetting={sendSetting}
        onAutoRefreshToggle={handleAutoRefreshToggle}
        onAutoRefreshValue={handleAutoRefreshValue}
        onThresholdPreview={handleThresholdPreview}
        onThresholdCommit={handleThresholdCommit}
        onPickCodexAppPath={() => postMessageToHost({ type: "dashboard:pickCodexAppPath" })}
        onClearCodexAppPath={() => postMessageToHost({ type: "dashboard:clearCodexAppPath" })}
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

function resolveHideLowWeeklyQuotaLabel(lang: string, count: number): string {
  if (lang === "zh") {
    return `隐藏周额度 <3%（${count}）`;
  }
  if (lang === "zh-hant") {
    return `隱藏週額度 <3%（${count}）`;
  }
  return `Hide weekly <3% (${count})`;
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

render(<App />, document.getElementById("app")!);

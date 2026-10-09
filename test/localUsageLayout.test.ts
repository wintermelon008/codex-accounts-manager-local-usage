import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");

describe("local usage dashboard placement and responsive guards", () => {
  it("removes the overview panel and exposes the compact add-account entry point", () => {
    const main = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");

    expect(main).not.toContain("<OverviewSection");
    expect(main).not.toContain("overview-shell");
    expect(main).toContain('id="addAccountButton"');
    expect(main).toContain("icon={<PlusIcon />}");
    expect(main).toContain("label={snapshot.copy.addAccount}");
    expect(main).toContain("onClick={modals.openAddAccountModal}");
    expect(main).toContain('class="brand-version"');
    expect(main).toContain("v{packageJson.version}");
    expect(main).not.toContain('id="aboutOpenButton"');
    expect(main).not.toContain("<AboutModal");
  });

  it("keeps the local usage section after the saved-account grid in normal document flow", () => {
    const source = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");
    const savedAccountsGridIndex = source.indexOf('<div class="accounts-grid">');
    const savedAccountsSectionEndIndex = source.indexOf("</section>", savedAccountsGridIndex);
    const localUsageIndex = source.indexOf("<LocalUsageSection");

    expect(savedAccountsGridIndex).toBeGreaterThan(-1);
    expect(savedAccountsSectionEndIndex).toBeGreaterThan(savedAccountsGridIndex);
    expect(localUsageIndex).toBeGreaterThan(savedAccountsGridIndex);
    expect(localUsageIndex).toBeGreaterThan(savedAccountsSectionEndIndex);
    expect(source.slice(localUsageIndex, localUsageIndex + 100)).not.toContain("style=");
  });

  it("contains narrow-window layout guards without changing shared account or modal selectors", () => {
    const stylesheet = fs.readFileSync(path.join(projectRoot, "media/webview/quotaSummary.css"), "utf8");

    expect(stylesheet).toContain("@media (max-width: 1400px)");
    expect(stylesheet).toContain("@media (max-width: 1200px)");
    expect(stylesheet).toContain("@media (max-width: 920px)");
    expect(stylesheet).toContain("@media (max-width: 620px)");
    expect(stylesheet).toContain("@media (max-width: 520px)");
    expect(stylesheet).toContain("@media (max-width: 460px)");
    expect(stylesheet).toContain(".local-usage-cards");
    expect(stylesheet).toContain(".local-usage-layout");
    expect(stylesheet).toContain(".local-usage-bar-row");
    expect(stylesheet).toContain(".local-usage-chart-track");
    expect(stylesheet).toContain("align-self: stretch");
    expect(stylesheet).toContain(".local-usage-range-btn");
    expect(stylesheet).toContain("grid-template-columns: repeat(5, minmax(0, 1fr))");

    const localUsageStyles = stylesheet.slice(
      stylesheet.indexOf(".local-usage-section"),
      stylesheet.indexOf("@keyframes button-spin")
    );
    expect(localUsageStyles).toContain(".local-usage-chart-column::after");
    expect(localUsageStyles).toContain("position: relative");
    expect(localUsageStyles).toContain("position: absolute");
    expect(localUsageStyles).toContain("width: min(31px, 65%)");
    expect(localUsageStyles).toContain("transition-delay: 0s");
    expect(localUsageStyles).not.toMatch(/\.(?:overview|toolbar|accounts|modal)-/);
    expect(localUsageStyles).toContain("font-size: 16px");
    expect(localUsageStyles).toContain("font-size: 14px");
  });

  it("keeps price between total and input, and exposes range controls in the dashboard and settings", () => {
    const section = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/localUsageSection.tsx"), "utf8");
    const settings = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/settingsOverlay.tsx"), "utf8");
    const stylesheet = fs.readFileSync(path.join(projectRoot, "media/webview/quotaSummary.css"), "utf8");
    const cards = section.slice(
      section.indexOf('<div class="local-usage-cards">'),
      section.indexOf('<div class="local-usage-layout">')
    );

    expect(cards.indexOf("copy.localUsageTotal")).toBeLessThan(cards.indexOf("copy.localUsagePrice"));
    expect(cards.indexOf("copy.localUsagePrice")).toBeLessThan(cards.indexOf("copy.localUsageInput"));
    expect(section).toContain("<RangeSelector");
    expect(section).toContain("formatTokenAndPrice");
    expect(section).toContain("formatTokenMillions");
    expect(section).toContain("minimumFractionDigits: 2");
    expect(section).toContain("maximumFractionDigits: 2");
    expect(section).toContain("value / 1_000_000");
    expect(section).toContain("label: row.label");
    expect(section).toContain("local-usage-title-row");
    expect(section).toContain("copy.localUsageRefreshBtn");
    expect(section).toContain('const visibleModels = range.byModel.filter((row) => row.model !== "unknown")');
    expect(section).toContain("`${tokenText} (${formatCompactUsd(price.amountUsd)})`");
    expect(section).not.toContain('unpricedTokens > 0 ? "+"');
    expect(settings).toContain("localUsageEnabledRanges");
    expect(settings).not.toContain("localUsageDefaultRangeDays");
    expect(settings).toContain("localUsageShowEquivalentPrice");
    expect(stylesheet).toContain(".local-usage-refresh-btn");
    expect(stylesheet).toContain("grid-template-columns: repeat(5, minmax(0, 1fr));");
    expect(stylesheet).toContain("grid-template-columns: repeat(3, minmax(0, 1fr));");
    const mediumWindowStyles = stylesheet.slice(
      stylesheet.indexOf("@media (max-width: 1200px)"),
      stylesheet.indexOf("@media (max-width: 920px)")
    );
    expect(mediumWindowStyles).not.toContain(".local-usage-cards");
    expect(mediumWindowStyles).not.toContain(".local-usage-layout");
    const compactWindowStyles = stylesheet.slice(
      stylesheet.lastIndexOf("@media (max-width: 620px)"),
      stylesheet.indexOf("@media (max-width: 460px)")
    );
    expect(compactWindowStyles).toContain(".accounts-grid");
    expect(compactWindowStyles).toContain("repeat(2, minmax(0, 1fr))");
    const narrowUsageStyles = stylesheet.slice(stylesheet.indexOf("@media (max-width: 460px)"));
    expect(narrowUsageStyles).toContain(".accounts-grid");
    expect(narrowUsageStyles).toContain("grid-template-columns: 1fr");
    expect(narrowUsageStyles).toContain(".local-usage-layout");
    const main = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");
    expect(main).toContain('sendAction("refreshLocalUsage")');
    const sortControlsIndex = main.indexOf('class="account-sort-controls"');
    const groupFiltersIndex = main.indexOf('class="account-group-filters"', sortControlsIndex);
    expect(main).not.toContain('id="forceFastModeToggle"');
    expect(main).not.toContain('sendSetting("forceFastModeEnabled", enabled)');
    expect(sortControlsIndex).toBeGreaterThan(-1);
    expect(groupFiltersIndex).toBeGreaterThan(sortControlsIndex);
    expect(stylesheet).not.toContain("account-fast-mode-toggle");
    expect(main).not.toContain("账号排序");
  });

  it("places Manager runtime and feature selection under operations settings", () => {
    const settings = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/settingsOverlay.tsx"), "utf8");
    const baseBoundary = settings.indexOf('activeSection === "base"');
    const operationsBoundary = settings.indexOf('activeSection === "operations"');
    const switchingBoundary = settings.indexOf('activeSection === "switching"');
    const integrationSettings = settings.indexOf("props.integrationSettings.map");
    const runtimeStatus = settings.indexOf("<SeamlessRuntimeStatus");
    const seamlessBoundary = settings.indexOf('? "无感切号（实验性）"', switchingBoundary);
    const quotaBandWait = settings.indexOf('? "等待时间"');
    const lowQuotaSwitch = settings.indexOf('? "低额度切号"');
    const lowQuotaThreshold = settings.indexOf('? "低额度阈值"');
    const policy = settings.indexOf('key: "hot-switch-defer"');
    const waitBlock = settings.lastIndexOf('<div class="settings-block">', quotaBandWait);

    expect(operationsBoundary).toBeGreaterThan(baseBoundary);
    expect(operationsBoundary).toBeLessThan(switchingBoundary);
    expect(integrationSettings).toBeGreaterThan(operationsBoundary);
    expect(integrationSettings).toBeLessThan(switchingBoundary);
    expect(runtimeStatus).toBeGreaterThan(operationsBoundary);
    expect(runtimeStatus).toBeLessThan(switchingBoundary);
    expect(settings).not.toContain("IntegrationCards");
    expect(settings).not.toContain("已注册集成");
    expect(settings).not.toContain("Registered integrations");
    expect(settings).not.toContain("props.copy.autoSwitchTitle");
    expect(settings).not.toContain('patchAndSend("autoSwitchEnabled"');
    expect(settings).not.toContain("autoSwitchHourlyThreshold");
    expect(settings).not.toContain("autoSwitchReloadWindowEnabled");
    expect(settings).not.toContain("autoSwitchLockMinutes");
    expect(lowQuotaSwitch).toBeGreaterThan(seamlessBoundary);
    expect(lowQuotaThreshold).toBeGreaterThan(lowQuotaSwitch);
    expect(policy).toBeGreaterThan(lowQuotaThreshold);
    expect(quotaBandWait).toBeGreaterThan(policy);
    expect(waitBlock).toBeGreaterThan(policy);
    expect(settings).toContain("无感切号（实验性）");
    expect(settings).toContain("Seamless account switching (experimental)");
    expect(settings).toContain("关闭后恢复 Manager 原有的账号写入与 reload 流程");
    expect(settings).toContain("等待时间");
    expect(settings).not.toContain("分档切号");
    expect(settings).not.toContain("分档方式");
    expect(settings).toContain("低额度切号");
    expect(settings).toContain("低额度阈值");
    expect(settings).toContain("切换策略");
    expect(settings).toContain('patchAndSend("seamlessSwitchEnabled"');
    expect(settings).toContain('patchAndSend("seamlessSwitchLowQuotaEnabled"');
    expect(settings).toContain('patchAndSend("seamlessSwitchThreshold"');
    expect(settings).toContain('patchAndSend("hotSwitchGraceSeconds"');
    expect(settings).not.toContain("seamlessSwitchQuotaBandsEnabled");
    expect(settings).not.toContain("seamlessSwitchQuotaBandSize");
    expect(settings).toContain("下方开关只控制无感切号行为");
    expect(settings).not.toContain('patchAndSend("hotSwitchEnabled"');
  });

  it("keeps a standalone account-sharing entry point for the management modal", () => {
    const main = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");
    const modal = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/sharingModal.tsx"), "utf8");

    expect(main).toContain('id="accountSharingButton"');
    expect(main).toContain("setSharingAccountIds([])");
    expect(main).toContain("setSharingOpen(true)");
    expect(main).toContain("<SharingModal");
    expect(modal).toContain('sharingOperation: "refreshStatus"');
    expect(modal).toContain("刷新状态");
  });

  it("exposes a batch action for removing selected accounts from the seamless-switch pool", () => {
    const accountViews = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/accountViews.tsx"), "utf8");
    const main = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");

    expect(accountViews).toContain("移出无感池");
    expect(accountViews).toContain("onRemoveFromBalancePool");
    expect(main).toContain('sendAction("removeFromBalancePool"');
  });

  it("exposes A/B/C account grouping and account pagination", () => {
    const accountViews = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/accountViews.tsx"), "utf8");
    const main = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");

    expect(accountViews).toContain('onSetAccountGroup("A")');
    expect(accountViews).toContain('onSetAccountGroup("B")');
    expect(accountViews).toContain('onSetAccountGroup("C")');
    expect(accountViews).toContain("Remove Group");
    expect(main).toContain("ACCOUNT_GROUPS");
    expect(main).toContain("getDashboardVisibleAccounts");
    expect(main).not.toContain('sendAction("refreshAll"');
    expect(main).toContain("getDashboardAccountPage");
    expect(main).toContain("saved-accounts-pagination");
    expect(main).toContain("DASHBOARD_ACCOUNT_PAGE_SIZE_OPTIONS");
    expect(main).toContain("account-page-size");
    expect(main).toContain("account-page-jump-input");
  });

  it("renders account sorting as a field selector with a separate direction toggle", () => {
    const main = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");
    const helpers = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/helpers.tsx"), "utf8");
    const stylesheet = fs.readFileSync(path.join(projectRoot, "media/webview/quotaSummary.css"), "utf8");

    expect(main).toContain('class="account-sort-select"');
    expect(main).toContain('class="account-sort-direction"');
    expect(main).toContain("ACCOUNT_SORT_KEYS");
    expect(main).toContain("useState<DashboardAccountSort>({");
    expect(main).toContain('key: "createdAt",');
    expect(main).toContain('direction: "desc"');
    expect(main).not.toContain("默认顺序");
    expect(main).not.toContain("setAccountSort(undefined)");
    expect(helpers).toContain("getQuotaResetAt");
    expect(helpers).toContain("metric.resetAt");
    expect(helpers).toContain("getDashboardAccountActivityRank");
    const sortSelectStyles = stylesheet.slice(
      stylesheet.indexOf(".account-sort-select {"),
      stylesheet.indexOf(".account-sort-direction {", stylesheet.indexOf(".account-sort-select {"))
    );
    expect(sortSelectStyles).toContain("outline: none;");
    expect(sortSelectStyles).toContain(".account-sort-select option");
    expect(sortSelectStyles).toContain("background: var(--bg-surface);");
    expect(sortSelectStyles).toContain("color: var(--text-primary);");
  });

  it("exposes a per-account seamless-switch pool toggle at the left of the card action row", () => {
    const card = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/savedAccountCard.tsx"), "utf8");
    const stylesheet = fs.readFileSync(path.join(projectRoot, "media/webview/quotaSummary.css"), "utf8");
    const actions = card.slice(
      card.indexOf('<div class="saved-actions"'),
      card.indexOf("</div>", card.indexOf('<div class="saved-actions"'))
    );

    expect(actions).toContain("saved-pool-toggle");
    expect(actions).toContain('onAction("toggleBalancePool", account.id)');
    expect(stylesheet).toContain(".saved-pool-toggle");
    expect(stylesheet).toContain("margin-right: auto");
  });

  it("removes card-only tag, status-bar, sync, and details action buttons", () => {
    const card = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/savedAccountCard.tsx"), "utf8");
    const main = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");

    expect(card).not.toContain("saved-top-actions");
    expect(card).not.toContain("saved-edit-tags-btn");
    expect(card).not.toContain('onAction("toggleStatusBar", account.id)');
    expect(card).not.toContain('onAction("resyncProfile", account.id)');
    expect(card).not.toContain('onAction("details", account.id');
    expect(main).not.toContain("onEditTags={() => handleEditAccountTags(account)}");
    expect(main).toContain("isMailboxIntegrationActive(snapshot.integrations)");
    expect(main).toContain("mailboxIntegrationActive && blockedAccountCount > 0");
  });

  it("renders Gateway profile choices as a compact card dropdown", () => {
    const card = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/savedAccountCard.tsx"), "utf8");
    const stylesheet = fs.readFileSync(path.join(projectRoot, "media/webview/quotaSummary.css"), "utf8");

    expect(card).toContain("saved-provider-profile-select");
    expect(card).toContain('action.id.startsWith("selectProfile:")');
    expect(stylesheet).toContain(".saved-provider-profile-select");
    expect(stylesheet).toContain("max-width: 168px");
  });

  it("renders Sub2API card actions as icon buttons with hover descriptions", () => {
    const card = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/savedAccountCard.tsx"), "utf8");
    const primitives = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/primitives.tsx"), "utf8");

    expect(card).toContain('providerCard?.integrationId === "sub2api-gateway"');
    expect(card).toContain("renderProviderActionIcon(action.id)");
    expect(card).toContain("iconOnly={usesGatewayActionIcons}");
    expect(primitives).toContain("const tooltip = props.tooltip ?? accessibleLabel");
  });

  it("renders quota-window token totals and detailed input/output usage in the paginated account card", () => {
    const card = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/savedAccountCard.tsx"), "utf8");
    const stylesheet = fs.readFileSync(path.join(projectRoot, "media/webview/quotaSummary.css"), "utf8");

    expect(card).toContain("saved-token-usage-line");
    expect(card).toContain("saved-token-usage-details");
    expect(card).toContain("formatAccountTokenUsage");
    expect(card).toContain("formatAccountTokenUsageDetails");
    expect(card).toContain("formatAccountTokenUsagePrice");
    expect(card).toContain("usage.inputTokens");
    expect(card).toContain("usage.outputTokens");
    expect(card).toContain("usage.cachedInputTokens");
    expect(card).toContain("providerCard.metrics.map");
    expect(card).not.toContain("formatProviderTokenUsage");
    expect(card).not.toContain("formatProviderUsage");
    expect(card).toContain("本轮窗口 Token");
    expect(card).toContain("待启用账号");
    expect(card).not.toContain("本周窗口 Token");
    expect(card).not.toContain("本五小时窗口 Token");
    expect(card).not.toContain("creditsText");
    expect(stylesheet).toContain(".saved-token-usage-line");
    expect(stylesheet).toContain(".saved-token-usage-details");
    expect(stylesheet).toContain(".saved-provider-metric");
    expect(stylesheet).toContain("text-overflow: ellipsis");
  });

  it("lets saved cards grow when multiple quota windows are visible", () => {
    const stylesheet = fs.readFileSync(path.join(projectRoot, "media/webview/quotaSummary.css"), "utf8");
    const cardLayout = stylesheet.slice(
      stylesheet.indexOf(".saved-card-container"),
      stylesheet.indexOf(".saved-card-inner.flipped")
    );
    const savedCard = stylesheet.slice(stylesheet.indexOf(".saved-card {"), stylesheet.indexOf(".saved-card::before"));

    expect(cardLayout).toContain("--saved-card-min-height: 238px");
    expect(cardLayout).toContain("min-height: var(--saved-card-min-height)");
    expect(cardLayout).toContain("grid-template-rows: minmax(var(--saved-card-min-height), auto)");
    expect(cardLayout).not.toContain("height: var(--saved-card-height)");
    expect(savedCard).toContain("min-height: var(--saved-card-min-height)");
    expect(savedCard).not.toContain("height: 100%");
  });

  it("places a conditional quota countdown starter beside the manual refresh action", () => {
    const card = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/savedAccountCard.tsx"), "utf8");
    const refreshIndex = card.indexOf('onAction("refresh", account.id)');
    const starterIndex = card.indexOf('onAction("startQuotaCountdown", account.id)');

    expect(card).toContain("account.quotaCountdownStartAvailable");
    expect(card).toContain("isQuotaCountdownWindowFresh");
    expect(card).toContain("showQuotaCountdownStart");
    expect(card).not.toContain("account.metrics.every");
    expect(card).toContain("quotaCountdownStartPending");
    expect(refreshIndex).toBeGreaterThan(-1);
    expect(starterIndex).toBeGreaterThan(refreshIndex);
  });

  it("adds host-side Codex import JSON copy feedback to every real account card", () => {
    const card = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/savedAccountCard.tsx"), "utf8");
    const main = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");
    const modalHooks = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/modalHooks.ts"), "utf8");
    const copyActionIndex = card.indexOf('onAction("copyAccountImportJson", account.id)');
    const virtualGuardIndex = card.lastIndexOf("{!virtual ? (", copyActionIndex);

    expect(copyActionIndex).toBeGreaterThan(-1);
    expect(virtualGuardIndex).toBeGreaterThan(-1);
    expect(copyActionIndex - virtualGuardIndex).toBeLessThan(700);
    expect(card).toContain("copyImportJsonPending");
    expect(card).toContain("copyImportJsonSucceeded");
    expect(card).toContain("<CopyIcon />");
    expect(card).toContain("<SuccessIcon />");
    expect(card).toContain('class="saved-back-footer"');
    expect(card).toContain('class="saved-back-copy-action"');
    expect(card).toContain('onAction("copyText", account.id, { text: account.email })');
    expect(card).toContain("accountNameCopyPending");
    expect(card).toContain("accountNameCopySucceeded");
    expect(main).toContain('isActionPending("copyAccountImportJson", account.id)');
    expect(main).toContain('isActionPending("copyText", account.id)');
    expect(modalHooks).toContain("feedback.showCopyFeedback(`account-import-json:${message.accountId}`)");
    expect(modalHooks).toContain("feedback.showCopyFeedback(`account-name:${message.accountId}`)");
  });

  it("supports hiding selected accounts and filtering them from the saved-account grid", () => {
    const accountViews = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/accountViews.tsx"), "utf8");
    const main = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");
    const card = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/savedAccountCard.tsx"), "utf8");
    const stylesheet = fs.readFileSync(path.join(projectRoot, "media/webview/quotaSummary.css"), "utf8");

    expect(accountViews).toContain("隐藏账号");
    expect(accountViews).toContain("显示账号");
    expect(accountViews).toContain("onHide");
    expect(accountViews).toContain("onUnhide");
    expect(accountViews).not.toContain("addTagsBtn");
    expect(accountViews).not.toContain("removeTagsBtn");
    expect(main).toContain('sendAction("hideAccounts"');
    expect(main).toContain('sendAction("unhideAccounts"');
    expect(main).toContain("hiddenAccountsToggleButton");
    expect(main).toContain("invalidAccountsToggleButton");
    expect(main).toContain("<AccountHealthFilterIcon />");
    expect(main).toContain("accountHealthFilterMenu");
    expect(main).toContain("selectedHealthFilters");
    expect(stylesheet).toContain(
      ".saved-accounts-header-actions > .account-health-filter > .settings-btn.action-btn.icon-only"
    );
    expect(main.indexOf('id="invalidAccountsToggleButton"')).toBeGreaterThan(
      main.indexOf('id="hiddenAccountsToggleButton"')
    );
    expect(main).toContain("pageAccounts.map");
    expect(card).toContain("is-hidden-account");
    expect(card).toContain("已隐藏");
    expect(stylesheet).toContain(".saved-card.is-hidden-account");
    expect(stylesheet).toContain(".pill.hidden");
  });
});

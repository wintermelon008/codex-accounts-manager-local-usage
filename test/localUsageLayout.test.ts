import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");

describe("local usage dashboard placement and responsive guards", () => {
  it("keeps the dashboard overview compact around the current email and four actions", () => {
    const overview = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/overviewSection.tsx"), "utf8");

    expect(overview).toContain("overview-shell-compact");
    expect(overview).toContain("overview-account-email");
    expect(overview).toContain("copy.addAccount");
    expect(overview).toContain("copy.importCurrent");
    expect(overview).toContain("props.refreshPageLabel");
    expect(overview).toContain("copy.lockAutoSwitchBtn");
    expect(overview).not.toContain("MetricGauge");
    expect(overview).not.toContain("overview-meta");
    expect(overview).not.toContain("overview-metrics");
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
    expect(stylesheet).toContain(".local-usage-cards");
    expect(stylesheet).toContain(".local-usage-layout");
    expect(stylesheet).toContain(".local-usage-bar-row");
    expect(stylesheet).toContain(".local-usage-range-btn");
    expect(stylesheet).toContain("grid-template-columns: repeat(5, minmax(0, 1fr))");

    const localUsageStyles = stylesheet.slice(
      stylesheet.indexOf(".local-usage-section"),
      stylesheet.indexOf("@keyframes button-spin")
    );
    expect(localUsageStyles).not.toContain("position:");
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
    const main = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");
    expect(main).toContain('sendAction("refreshLocalUsage")');
  });

  it("presents seamless switching separately from the auto-switch trigger", () => {
    const settings = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/settingsOverlay.tsx"), "utf8");
    const autoSwitchHiddenStack = settings.indexOf(
      '<div class={`settings-stack ${props.settings.autoSwitchEnabled ? "" : "is-hidden"}`}>'
    );
    const seamlessBoundary = settings.indexOf('? "无感切号（实验性）"', autoSwitchHiddenStack);
    const quotaBandWait = settings.indexOf('? "等待时间"');
    const lowQuotaSwitch = settings.indexOf('? "低额度切号"');
    const lowQuotaThreshold = settings.indexOf('? "低额度阈值"');
    const policy = settings.indexOf('key: "hot-switch-defer"');
    const waitBlock = settings.lastIndexOf('<div class="settings-block">', quotaBandWait);

    expect(autoSwitchHiddenStack).toBeGreaterThan(-1);
    expect(seamlessBoundary).toBeGreaterThan(autoSwitchHiddenStack);
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
    expect(settings.slice(autoSwitchHiddenStack, seamlessBoundary)).not.toContain("seamlessSwitchQuotaBandsEnabled");
    expect(settings).not.toContain("seamlessSwitchQuotaBandsEnabled");
    expect(settings).not.toContain("seamlessSwitchQuotaBandSize");
    expect(settings).toContain("安装或移除请使用命令面板");
    expect(settings).not.toContain('patchAndSend("hotSwitchEnabled"');
  });

  it("exposes a batch action for removing selected accounts from the seamless-switch pool", () => {
    const accountViews = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/accountViews.tsx"), "utf8");
    const main = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");

    expect(accountViews).toContain("移出无感池");
    expect(accountViews).toContain("onRemoveFromBalancePool");
    expect(main).toContain('sendAction("removeFromBalancePool"');
  });

  it("exposes A/B/C account grouping and limits one-click refresh to the visible account ids", () => {
    const accountViews = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/accountViews.tsx"), "utf8");
    const main = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");

    expect(accountViews).toContain('onSetAccountGroup("A")');
    expect(accountViews).toContain('onSetAccountGroup("B")');
    expect(accountViews).toContain('onSetAccountGroup("C")');
    expect(accountViews).toContain("Remove Group");
    expect(main).toContain("ACCOUNT_GROUPS");
    expect(main).toContain("getDashboardVisibleAccounts");
    expect(main).toContain(
      'sendAction("refreshAll", undefined, { accountIds: pageAccounts.map((account) => account.id) })'
    );
    expect(main).toContain("getDashboardAccountPage");
    expect(main).toContain("saved-accounts-pagination");
    expect(main).toContain("DASHBOARD_ACCOUNT_PAGE_SIZE_OPTIONS");
    expect(main).toContain("account-page-size");
    expect(main).toContain("account-page-jump-input");
  });

  it("renders account sorting as a field selector with a separate direction toggle", () => {
    const main = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/main.tsx"), "utf8");
    const helpers = fs.readFileSync(path.join(projectRoot, "webview-src/dashboard/helpers.tsx"), "utf8");

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
    expect(main).toContain('isActionPending("copyAccountImportJson", account.id)');
    expect(modalHooks).toContain("feedback.showCopyFeedback(`account-import-json:${message.accountId}`)");
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
    expect(main).toContain("pageAccounts.map");
    expect(card).toContain("is-hidden-account");
    expect(card).toContain("已隐藏");
    expect(stylesheet).toContain(".saved-card.is-hidden-account");
    expect(stylesheet).toContain(".pill.hidden");
  });
});

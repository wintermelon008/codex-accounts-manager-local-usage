import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type {
  DashboardAccountViewModel,
  DashboardActionPayload,
  DashboardCopy,
  DashboardLocalUsageTokenTotals,
  DashboardSettings,
  DashboardState
} from "../../src/domain/dashboard/types";
import { isQuotaCountdownWindowFresh } from "../../src/domain/dashboard/quotaCountdown";
import { getSensitiveDisplayValue, renderTagList } from "./helpers";
import {
  CopyIcon,
  EditTagsIcon,
  SuccessIcon,
  renderDetailsIcon,
  renderQuotaCountdownStartIcon,
  renderRefreshIcon,
  renderReauthorizeIcon,
  renderReloadIcon,
  renderRemoveIcon,
  renderResetCreditsIcon,
  renderResyncProfileIcon,
  renderSwitchIcon
} from "./icons";
import { ActionButton } from "./primitives";
import { MetricRow, renderHealthPill } from "./accountMetricPrimitives";
import { estimateStandardApiCost } from "./localUsageInsights";

export function SavedAccountCard(props: {
  account: DashboardAccountViewModel;
  lang: DashboardState["lang"];
  copy: DashboardCopy;
  settings: DashboardSettings;
  now: number;
  privacyMode: boolean;
  busy: boolean;
  reloadPromptPending: boolean;
  switchPending: boolean;
  reauthorizePending: boolean;
  resyncProfilePending: boolean;
  refreshPending: boolean;
  copyImportJsonPending: boolean;
  copyImportJsonSucceeded: boolean;
  quotaCountdownStartPending: boolean;
  detailsPending: boolean;
  removePending: boolean;
  togglePending: boolean;
  poolTogglePending: boolean;
  updateTagsPending: boolean;
  consumeResetCreditPending: boolean;
  providerActionPending: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  onEditTags: () => void;
  onAction: (
    action:
      | "details"
      | "switch"
      | "reloadPrompt"
      | "reauthorize"
      | "resyncProfile"
      | "refresh"
      | "copyAccountImportJson"
      | "startQuotaCountdown"
      | "remove"
      | "toggleStatusBar"
      | "toggleBalancePool"
      | "consumeResetCredit"
      | "integrationAction"
      | "openExternalUrl",
    accountId?: string,
    payload?: DashboardActionPayload
  ) => void;
}) {
  const { account, copy, settings, now, onAction, privacyMode } = props;
  const virtual = account.accountKind === "sub2api" || account.manualOnly === true;
  const userIdDisplay = getSensitiveDisplayValue(account.userId, privacyMode, "id", "-");
  const emailDisplay = getSensitiveDisplayValue(account.email, privacyMode, "email");
  const backEmailDisplay = getSensitiveDisplayValue(account.email, privacyMode, "email");
  const selectionLabel = props.selected ? copy.deselectAccount : copy.selectAccount;
  const poolToggleLabel = account.isHidden
    ? props.lang === "zh"
      ? "隐藏账号不参与无感切号"
      : props.lang === "zh-hant"
        ? "隱藏帳號不參與無感切換"
        : "Hidden accounts do not participate in seamless switching"
    : account.balancePoolEnabled
      ? props.lang === "zh"
        ? "移出无感切号池"
        : props.lang === "zh-hant"
          ? "移出無感切換池"
          : "Remove from seamless-switch pool"
      : props.lang === "zh"
        ? "加入无感切号池"
        : props.lang === "zh-hant"
          ? "加入無感切換池"
          : "Add to seamless-switch pool";
  const showReauthorizeButton = !virtual && account.healthKind === "reauthorize" && !account.dismissedHealth;
  const [flipped, setFlipped] = useState(false);
  const showResyncButton = !virtual && account.healthKind !== "reauthorize";
  const resyncButtonLabel =
    (account.healthKind === "disabled" || account.healthKind === "quota") && !account.dismissedHealth
      ? copy.resyncProfileBtn
      : copy.syncProfileBtn;
  const hasErrorHealth =
    !account.dismissedHealth &&
    (account.healthKind === "reauthorize" ||
      account.healthKind === "disabled" ||
      account.healthKind === "refresh_failed" ||
      account.healthKind === "quota");
  const gatewayActive = virtual && account.providerActive;
  const providerCard = virtual ? account.providerCard : undefined;
  const profileSelectionActions =
    providerCard?.actions?.filter((action) => action.id.startsWith("selectProfile:")) ?? [];
  const providerActions = providerCard?.actions?.filter((action) => !action.id.startsWith("selectProfile:")) ?? [];
  const selectedProfileAction = profileSelectionActions.find((action) => action.enabled === false);
  const usesGatewayActionIcons = providerCard?.integrationId === "sub2api-gateway";
  const runProviderAction = (actionId: string): void => {
    if (!providerCard) {
      return;
    }
    onAction("integrationAction", account.id, {
      integrationId: providerCard.integrationId,
      integrationActionId: actionId
    });
  };
  const cardStateClass = [
    account.isActive || account.providerActive ? "active" : "",
    gatewayActive ? "gateway-active" : "",
    account.isHidden ? "is-hidden-account" : "",
    props.busy ? "is-busy" : "",
    props.selected ? "selected" : "",
    hasErrorHealth ? "health-error" : ""
  ]
    .filter(Boolean)
    .join(" ");
  const visibleMetrics = virtual ? [] : account.metrics.filter((metric) => metric.visible);
  const quotaCountdownStartLabel =
    props.lang === "zh" ? "启动额度倒计时" : props.lang === "zh-hant" ? "啟動額度倒數" : "Start quota countdown";
  const showQuotaCountdownStart =
    account.quotaCountdownStartAvailable &&
    account.metrics.some(
      (metric) =>
        metric.visible &&
        (metric.key === "hourly" || metric.key === "weekly") &&
        isQuotaCountdownWindowFresh(metric.key, metric.resetAt, now, metric.windowMinutes)
    ) &&
    account.metrics.every(
      (metric) =>
        !metric.visible ||
        (metric.key !== "hourly" && metric.key !== "weekly") ||
        isQuotaCountdownWindowFresh(metric.key, metric.resetAt, now, metric.windowMinutes)
    );
  const stopFlip = (event: Event): void => {
    event.stopPropagation();
  };
  const handleFlipKey = (event: KeyboardEvent, nextFlipped: boolean): void => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    setFlipped(nextFlipped);
  };

  return (
    <article class={`saved-card-container ${cardStateClass}`}>
      <div class={`saved-card-inner ${flipped ? "flipped" : ""}`}>
        <section
          class={`saved-card saved-card-front ${cardStateClass}`}
          role="button"
          tabIndex={0}
          aria-label={copy.detailsBtn}
          onClick={() => setFlipped(true)}
          onKeyDown={(event) => handleFlipKey(event, true)}
        >
          <div class="saved-head">
            <div class="saved-top-actions" onClick={stopFlip}>
              {!account.isActive && !account.providerActive ? (
                <button
                  class={`saved-control saved-status-toggle ${account.canToggleStatusBar ? "" : "disabled"} ${account.showInStatusBar ? "is-checked" : ""}`}
                  type="button"
                  aria-label={account.statusToggleTitle}
                  aria-pressed={account.showInStatusBar}
                  aria-disabled={!account.canToggleStatusBar || props.busy}
                  onClick={() => {
                    if (!account.canToggleStatusBar || props.busy) {
                      return;
                    }
                    onAction("toggleStatusBar", account.id);
                  }}
                >
                  <span class="saved-status-toggle-indicator" aria-hidden="true">
                    <span></span>
                  </span>
                  <span class="saved-control-tip align-right" aria-hidden="true">
                    {account.statusToggleTitle}
                  </span>
                </button>
              ) : null}
              <button
                class="saved-control saved-edit-tags-btn"
                type="button"
                aria-label={copy.editTagsBtn}
                disabled={props.busy}
                onClick={props.onEditTags}
              >
                {props.updateTagsPending ? (
                  <span class="saved-toggle-spinner" aria-hidden="true"></span>
                ) : (
                  <EditTagsIcon />
                )}
                <span class="saved-control-tip align-right" aria-hidden="true">
                  {copy.editTagsBtn}
                </span>
              </button>
            </div>
            <div class="saved-title">
              <h3>
                <button
                  class={`saved-select-toggle ${props.selected ? "selected" : ""}`}
                  type="button"
                  aria-pressed={props.selected}
                  aria-label={selectionLabel}
                  onClick={(event) => {
                    stopFlip(event);
                    props.onToggleSelected();
                  }}
                >
                  <span class="saved-select-toggle-mark" aria-hidden="true"></span>
                  <span class="saved-control-tip align-left below" aria-hidden="true">
                    {selectionLabel}
                  </span>
                </button>
                <span class="saved-title-text">{emailDisplay}</span>
              </h3>
              <div class="saved-meta">
                <span class="pill plan">{account.planTypeLabel}</span>
                {account.isHidden ? (
                  <span class="pill hidden">
                    {props.lang === "zh" ? "已隐藏" : props.lang === "zh-hant" ? "已隱藏" : "Hidden"}
                  </span>
                ) : null}
                {account.accountGroup ? (
                  <span class={`pill account-group group-${account.accountGroup.toLowerCase()}`}>
                    {resolveAccountGroupLabel(account.accountGroup, props.lang)}
                  </span>
                ) : null}
                {account.isActive ? <span class="pill active">{copy.primaryAccount}</span> : null}
                {virtual ? <span class="pill gateway-active">{gatewayActive ? "Gateway · 手动 · 当前" : "Gateway · 手动"}</span> : null}
                {account.isCurrentWindowAccount && !virtual ? <span class="pill active">{copy.current}</span> : null}
                {account.balancePoolEnabled && !virtual ? (
                  <span class="pill active">
                    {props.lang === "zh" ? "无感切号池" : props.lang === "zh-hant" ? "無感切換池" : "Seamless Pool"}
                  </span>
                ) : null}
                {!virtual ? renderHealthPill(account) : null}
              </div>
            </div>
          </div>

          <div class="saved-progress">
            {virtual && providerCard?.metrics?.length ? (
              <div class="saved-provider-usage">
                {providerCard.metrics.map((metric) => (
                  <div class="saved-provider-metric" key={`${metric.label}:${metric.value}`} title={metric.description}>
                    <span>{metric.label}</span>
                    <strong>{metric.value}</strong>
                  </div>
                ))}
              </div>
            ) : virtual ? (
              <div class="quota-empty-placeholder">{props.lang === "zh" ? "Gateway · 仅手动切换" : "Gateway · Manual only"}</div>
            ) : visibleMetrics.length > 0 ? (
              visibleMetrics.map((metric) => (
                <MetricRow
                  key={metric.key}
                  metric={metric}
                  lang={props.lang}
                  settings={settings}
                  copy={copy}
                  now={now}
                />
              ))
            ) : (
              <div class="quota-empty-placeholder">{copy.resetUnknown}</div>
            )}
          </div>
          {account.resetCreditsAvailable != null && account.resetCreditsAvailable > 0 ? (
            <div class="saved-credits-line saved-reset-credits-line">
              {copy.resetCreditsLabel ?? "重置次数"}: {account.resetCreditsAvailable}
              {account.resetCreditsNextExpiresAt != null && account.resetCreditsNextExpiresAt > 0
                ? ` (${formatResetCreditsExpiry(account.resetCreditsNextExpiresAt)})`
                : ""}
            </div>
          ) : null}
          {account.tokenUsage ? (
            <>
              <div class="saved-token-usage-line" title={formatAccountTokenUsageTitle(account, props.lang)}>
                {formatAccountTokenUsage(account, props.lang)}
              </div>
              {account.tokenUsage.status === "tracking" ? (
                <div class="saved-token-usage-details">{formatAccountTokenUsageDetails(account, props.lang)}</div>
              ) : null}
            </>
          ) : null}
          <div class="saved-card-divider"></div>
          <div class="saved-actions" onClick={stopFlip}>
            {!virtual ? <button
              class={`saved-control saved-status-toggle saved-pool-toggle ${account.balancePoolEnabled ? "is-checked" : ""} ${props.poolTogglePending ? "is-pending" : ""} ${account.isHidden ? "disabled" : ""}`}
              type="button"
              aria-label={poolToggleLabel}
              aria-pressed={account.balancePoolEnabled}
              disabled={props.busy || account.isHidden}
              onClick={() => onAction("toggleBalancePool", account.id)}
            >
              <span class="saved-status-toggle-indicator" aria-hidden="true">
                <span></span>
              </span>
              <span class="saved-control-tip align-left" aria-hidden="true">
                {poolToggleLabel}
              </span>
            </button> : null}
            {!virtual && account.isActive && !account.isCurrentWindowAccount ? (
              <ActionButton
                icon={renderReloadIcon()}
                iconOnly
                label={copy.reloadBtn}
                pending={props.reloadPromptPending}
                disabled={props.busy}
                onClick={() => onAction("reloadPrompt", account.id)}
              />
            ) : null}
            {showReauthorizeButton ? (
              <ActionButton
                icon={renderReauthorizeIcon()}
                iconOnly
                label={copy.reauthorizeBtn}
                pending={props.reauthorizePending}
                disabled={props.busy}
                onClick={() => onAction("reauthorize", account.id)}
              />
            ) : null}
            {showResyncButton ? (
              <ActionButton
                icon={renderResyncProfileIcon()}
                iconOnly
                label={resyncButtonLabel}
                pending={props.resyncProfilePending}
                disabled={props.busy}
                onClick={() => onAction("resyncProfile", account.id)}
              />
            ) : null}
            <ActionButton
              icon={renderSwitchIcon()}
              iconOnly
              label={copy.switchBtn}
              pending={props.switchPending}
              disabled={props.busy || account.isHidden}
              onClick={() => onAction("switch", account.id)}
            />
            {profileSelectionActions.length > 1 ? (
              <select
                class="saved-provider-profile-select"
                aria-label="选择 Gateway 配置"
                title={selectedProfileAction?.tooltip ?? "选择 Gateway 配置"}
                value={selectedProfileAction?.id ?? profileSelectionActions[0]?.id ?? ""}
                disabled={props.busy || props.providerActionPending}
                onChange={(event) => {
                  const action = profileSelectionActions.find(
                    (candidate) => candidate.id === event.currentTarget.value
                  );
                  if (!action || action.enabled === false) {
                    return;
                  }
                  runProviderAction(action.id);
                }}
              >
                {profileSelectionActions.map((action) => (
                  <option key={action.id} value={action.id} disabled={action.enabled === false} title={action.tooltip}>
                    {action.label}
                  </option>
                ))}
              </select>
            ) : null}
            {providerActions.map((action) => (
              <ActionButton
                key={action.id}
                icon={usesGatewayActionIcons ? renderProviderActionIcon(action.id) : undefined}
                iconOnly={usesGatewayActionIcons}
                label={action.label}
                tooltip={action.tooltip}
                pending={props.providerActionPending}
                disabled={props.busy || action.enabled === false}
                onClick={() => runProviderAction(action.id)}
              />
            ))}
            {!virtual ? (
              <ActionButton
                icon={renderRefreshIcon()}
                iconOnly
                label={copy.refreshBtn}
                pending={props.refreshPending}
                disabled={props.busy}
                onClick={() => onAction("refresh", account.id)}
              />
            ) : null}
            {!virtual ? (
              <ActionButton
                icon={props.copyImportJsonSucceeded ? <SuccessIcon /> : <CopyIcon />}
                iconOnly
                label={props.copyImportJsonSucceeded ? copy.copySuccess : copy.copyAccountImportJsonBtn}
                pending={props.copyImportJsonPending}
                disabled={props.busy}
                onClick={() => onAction("copyAccountImportJson", account.id)}
              />
            ) : null}
            {!virtual && showQuotaCountdownStart ? (
              <ActionButton
                icon={renderQuotaCountdownStartIcon()}
                iconOnly
                label={quotaCountdownStartLabel}
                pending={props.quotaCountdownStartPending}
                disabled={props.busy}
                onClick={() => onAction("startQuotaCountdown", account.id)}
              />
            ) : null}
            {!virtual && account.resetCreditsAvailable != null && account.resetCreditsAvailable > 0 ? (
              <ActionButton
                icon={renderResetCreditsIcon()}
                iconOnly
                label={`${copy.resetCreditsBtn ?? "重置配额"} (${account.resetCreditsAvailable})`}
                pending={props.consumeResetCreditPending}
                disabled={props.busy}
                onClick={() => onAction("consumeResetCredit", account.id)}
              />
            ) : null}
            <ActionButton
              icon={renderDetailsIcon()}
              iconOnly
              label={copy.detailsBtn}
              pending={props.detailsPending}
              disabled={props.busy}
              onClick={() => onAction("details", account.id, { privacyMode })}
            />
            <ActionButton
              icon={renderRemoveIcon()}
              iconOnly
              label={copy.removeBtn}
              pending={props.removePending}
              disabled={props.busy}
              onClick={() => onAction("remove", account.id)}
            />
          </div>
        </section>

        <section
          class={`saved-card saved-card-back ${cardStateClass}`}
          role="button"
          tabIndex={0}
          aria-label={copy.detailsBtn}
          onClick={() => setFlipped(false)}
          onKeyDown={(event) => handleFlipKey(event, false)}
        >
          <div class="saved-back-body">
            <div class="saved-back-header">
              <div class="saved-back-icon" aria-hidden="true"></div>
              <span class="saved-back-email">{backEmailDisplay}</span>
            </div>
            <div class="saved-detail-list">
              <CardDetailRow label={resolveBackLabel("workspace", props.lang)} value={account.workspaceLabel} />
              {providerCard?.details?.map((detail) => (
                <CardDetailRow
                  key={`${detail.label}:${detail.value}`}
                  label={detail.label}
                  value={detail.value}
                  color={detail.emphasis === "positive" ? "var(--accent-green)" : detail.emphasis === "warning" ? "#f59e0b" : undefined}
                />
              ))}
              {!virtual ? <CardDetailRow
                label={resolveBackLabel("subscription", props.lang)}
                value={account.subscriptionText}
                title={account.subscriptionTitle}
                color={account.subscriptionColor}
              /> : null}
              <CardDetailRow label={resolveBackLabel("addMethod", props.lang)} value={account.addMethodLabel} />
              <CardDetailRow label={resolveBackLabel("createdAt", props.lang)} value={account.addedAtLabel} />
              <CardDetailRow
                label={resolveBackLabel("status", props.lang)}
                value={resolveBackStatus(account, props.lang)}
                color={account.statusColor}
              />
              {!virtual ? <CardDetailRow label={copy.userId} value={userIdDisplay} /> : null}
            </div>
            <div class="saved-back-tags">
              <div class="account-tag-row">
                {renderTagList(account.tags) ?? <span class="tag-pill muted">{resolveNoTags(props.lang)}</span>}
              </div>
            </div>
            <div class="saved-back-hint">{resolveBackHint(props.lang)}</div>
          </div>
        </section>
      </div>
    </article>
  );
}

function renderProviderActionIcon(actionId: string): ComponentChildren {
  switch (actionId) {
    case "deactivate":
      return renderSwitchIcon();
    case "configureCredential":
      return renderReauthorizeIcon();
    case "refresh":
      return renderRefreshIcon();
    case "openConfig":
      return renderDetailsIcon();
    default:
      return renderDetailsIcon();
  }
}

function resolveBackLabel(
  key: "workspace" | "subscription" | "addMethod" | "createdAt" | "status",
  lang: DashboardState["lang"]
): string {
  const zh = lang === "zh" || lang === "zh-hant";
  const labels = {
    workspace: zh ? "工作空间" : "Workspace",
    subscription: zh ? "订阅到期" : "Subscription",
    addMethod: zh ? "添加方式" : "Added by",
    createdAt: zh ? "创建时间" : "Created at",
    status: zh ? "状态" : "Status"
  };
  return labels[key];
}

function resolveBackStatus(account: DashboardAccountViewModel, lang: DashboardState["lang"]): string {
  if (account.accountKind === "sub2api" || account.manualOnly) {
    return account.providerActive ? "Gateway · 手动" : "Gateway · 可手动切换";
  }
  if (account.isActive) {
    return lang === "zh" ? "当前激活" : lang === "zh-hant" ? "目前啟用" : "Current active";
  }
  return account.healthLabel;
}

function resolveNoTags(lang: DashboardState["lang"]): string {
  return lang === "zh" ? "暂无标签" : lang === "zh-hant" ? "暫無標籤" : "No tags";
}

function resolveAccountGroupLabel(group: "A" | "B" | "C", lang: DashboardState["lang"]): string {
  if (lang === "zh") {
    return `分组 ${group}`;
  }
  if (lang === "zh-hant") {
    return `分組 ${group}`;
  }
  return `Group ${group}`;
}

function resolveBackHint(lang: DashboardState["lang"]): string {
  switch (lang) {
    case "zh":
      return "点击卡片任意区域返回配额监控";
    case "zh-hant":
      return "點擊卡片任意區域返回配額監控";
    default:
      return "Click anywhere to return to quota monitor";
  }
}

function CardDetailRow(props: { label: string; value: string; title?: string; color?: string }) {
  return (
    <div class="saved-detail-row">
      <span class="saved-detail-label">{props.label}:</span>
      <span
        class="saved-detail-value"
        title={props.title ?? props.value}
        style={props.color ? { color: props.color } : undefined}
      >
        {props.value}
      </span>
    </div>
  );
}

function formatResetCreditsExpiry(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `最近到期: ${y}/${mo}/${day} ${h}:${mi}:${s}`;
}

function formatAccountTokenUsage(account: DashboardAccountViewModel, lang: DashboardState["lang"]): string {
  const usage = account.tokenUsage;
  if (!usage) {
    return "";
  }
  const label = resolveTokenUsageLabel(lang);
  if (usage.status === "loading") {
    return `${label}: ${lang === "zh" ? "统计中" : lang === "zh-hant" ? "統計中" : "Calculating"}`;
  }
  if (usage.status === "waiting") {
    return `${label}: ${lang === "zh" ? "待启用账号" : lang === "zh-hant" ? "待啟用帳號" : "Account pending activation"}`;
  }

  const price = formatAccountTokenUsagePrice(usage.byModel, lang);
  if (lang === "zh") {
    return `${label}: ${formatCompactTokenCount(usage.totalTokens)} · ${price}`;
  }
  if (lang === "zh-hant") {
    return `${label}: ${formatCompactTokenCount(usage.totalTokens)} · ${price}`;
  }
  return `${label}: ${formatCompactTokenCount(usage.totalTokens)} · ${price}`;
}

function formatAccountTokenUsageDetails(account: DashboardAccountViewModel, lang: DashboardState["lang"]): string {
  const usage = account.tokenUsage;
  if (usage?.status !== "tracking") {
    return "";
  }

  return formatTokenUsageDetails(usage, lang);
}

function formatTokenUsageDetails(
  usage: Pick<DashboardLocalUsageTokenTotals, "inputTokens" | "cachedInputTokens" | "outputTokens">,
  lang: DashboardState["lang"]
): string {
  const labels =
    lang === "zh"
      ? { input: "输入", cached: "缓存", output: "输出" }
      : lang === "zh-hant"
        ? { input: "輸入", cached: "快取", output: "輸出" }
        : { input: "Input", cached: "Cached", output: "Output" };
  return `${labels.input}: ${formatCompactTokenCount(usage.inputTokens)} (${labels.cached}: ${formatCompactTokenCount(usage.cachedInputTokens)}) · ${labels.output}: ${formatCompactTokenCount(usage.outputTokens)}`;
}

function formatAccountTokenUsageTitle(account: DashboardAccountViewModel, lang: DashboardState["lang"]): string {
  const usage = account.tokenUsage;
  if (usage?.status !== "tracking") {
    return formatAccountTokenUsage(account, lang);
  }
  const label = resolveTokenUsageLabel(lang);
  const price = formatAccountTokenUsagePrice(usage.byModel, lang);
  if (lang === "zh") {
    return `${label}: ${usage.totalTokens.toLocaleString()} Token · ${price}`;
  }
  if (lang === "zh-hant") {
    return `${label}: ${usage.totalTokens.toLocaleString()} Token · ${price}`;
  }
  return `${label}: ${usage.totalTokens.toLocaleString()} tokens · ${price}`;
}

function formatAccountTokenUsagePrice(
  byModel: NonNullable<DashboardAccountViewModel["tokenUsage"]>["byModel"],
  lang: DashboardState["lang"]
): string {
  const price = estimateStandardApiCost(byModel);
  const label = lang === "zh" ? "价格" : lang === "zh-hant" ? "價格" : "Price";
  const value =
    price.pricedTokens > 0
      ? `US$${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price.amountUsd)}`
      : "—";
  return `${label}: ${value}`;
}

function resolveTokenUsageLabel(lang: DashboardState["lang"]): string {
  if (lang === "zh") {
    return "本轮窗口 Token";
  }
  if (lang === "zh-hant") {
    return "本輪窗口 Token";
  }
  return "Current window tokens";
}

function formatCompactTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  }
  return String(value);
}

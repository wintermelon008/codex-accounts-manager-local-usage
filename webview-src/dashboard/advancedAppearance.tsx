import type {
  DashboardAccountViewModel,
  DashboardActionName,
  DashboardCopy,
  DashboardState
} from "../../src/domain/dashboard/types";
import { useEffect, useRef, useState } from "preact/hooks";
import { isQuotaCountdownWindowFresh } from "../../src/domain/dashboard/quotaCountdown";
import {
  getAccountHealthCategory,
  getDashboardHealthFilter,
  getDashboardSharingFilter,
  getSensitiveDisplayValue,
  isAccountReauthorizationRequired
} from "./helpers";
import type { SendAction } from "./hookTypes";
import {
  CopyIcon,
  renderDetailsIcon,
  renderQuotaCountdownStartIcon,
  renderRefreshIcon,
  renderReauthorizeIcon,
  renderReloadIcon,
  renderRemoveIcon,
  renderResetCreditsIcon,
  renderSwitchIcon,
  SuccessIcon
} from "./icons";
import { ActionButton } from "./primitives";

const ORBIT_ACCOUNT_LIMIT = 8;
const ORBIT_DIAMETERS = [230, 270, 310, 350, 390, 430, 470, 510] as const;

type AdvancedAppearanceLabels = {
  live: string;
  online: string;
  recovery: string;
  active: string;
  noActive: string;
  orbitHint: string;
  moreAccounts: string;
};

export function rotateAccountsAfterActive(
  accounts: readonly DashboardAccountViewModel[],
  activeAccountId?: string
): DashboardAccountViewModel[] {
  if (!activeAccountId) {
    return [...accounts];
  }

  const activeIndex = accounts.findIndex((account) => account.id === activeAccountId);
  if (activeIndex < 0) {
    return [...accounts];
  }

  return [...accounts.slice(activeIndex + 1), ...accounts.slice(0, activeIndex)];
}

function resolveAdvancedAppearanceLabels(lang: DashboardState["lang"]): AdvancedAppearanceLabels {
  if (lang === "zh") {
    return {
      live: "COMMAND CENTER / 实时",
      online: "系统在线",
      recovery: "需要恢复",
      active: "当前激活",
      noActive: "暂无激活账号",
      orbitHint: "行星按当前账号顺序绕恒星运行",
      moreAccounts: "更多账号未显示"
    };
  }
  if (lang === "zh-hant") {
    return {
      live: "COMMAND CENTER / 即時",
      online: "系統在線",
      recovery: "需要恢復",
      active: "目前啟用",
      noActive: "暫無啟用帳號",
      orbitHint: "行星依目前帳號順序繞恆星運行",
      moreAccounts: "更多帳號未顯示"
    };
  }
  return {
    live: "COMMAND CENTER / LIVE",
    online: "SYSTEM ONLINE",
    recovery: "RECOVERY NEEDED",
    active: "ACTIVE",
    noActive: "No active account",
    orbitHint: "Planets orbit in the current account order",
    moreAccounts: "More accounts are not shown"
  };
}

function getPrimaryQuotaPercentage(account: DashboardAccountViewModel): number | undefined {
  const metric = account.metrics.find(
    (candidate) => candidate.visible && (candidate.key === "hourly" || candidate.key === "weekly")
  );
  return metric?.percentage;
}

function hashOrbitValue(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function resolveOrbitAngle(accountId: string, ringIndex: number): number {
  return hashOrbitValue(`${accountId}:angle:${ringIndex}`) % 360;
}

function angularDistance(first: number, second: number): number {
  const distance = Math.abs(first - second) % 360;
  return Math.min(distance, 360 - distance);
}

function resolveOrbitAngles(accounts: readonly DashboardAccountViewModel[]): number[] {
  const resolvedAngles: number[] = [];
  const minimumSeparation = 26;

  accounts.forEach((account, ringIndex) => {
    let angle = resolveOrbitAngle(account.id, ringIndex);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (resolvedAngles.every((resolvedAngle) => angularDistance(angle, resolvedAngle) >= minimumSeparation)) {
        break;
      }
      angle = (angle + 37 + ringIndex * 3) % 360;
    }
    resolvedAngles.push(angle);
  });

  return resolvedAngles;
}

function resolveOrbitDuration(accountId: string, ringIndex: number): number {
  return 72 + (hashOrbitValue(`${accountId}:speed:${ringIndex}`) % 25);
}

function resolvePlanClass(account: DashboardAccountViewModel): "free" | "plus" | "pro" | "gateway" {
  if (account.accountKind === "sub2api" || account.manualOnly) {
    return "gateway";
  }

  const plan = `${account.planType ?? ""} ${account.planTypeLabel}`.toLowerCase();
  if (plan.includes("pro")) {
    return "pro";
  }
  if (plan.includes("plus")) {
    return "plus";
  }
  return "free";
}

function formatPlanetQuota(account: DashboardAccountViewModel): string {
  const percentage = getPrimaryQuotaPercentage(account);
  return percentage == null ? "—" : `${Math.round(Math.max(0, Math.min(100, percentage)))}%`;
}

function resolvePlanetLabel(
  account: DashboardAccountViewModel,
  privacyMode: boolean
): string {
  const name = getSensitiveDisplayValue(account.email || account.displayName, privacyMode, "email");
  const quota = formatPlanetQuota(account);
  return `${name} · ${quota}`;
}

function SolarPlanet(props: {
  account: DashboardAccountViewModel;
  angle: number;
  duration: number;
  ringIndex: number;
  orbitCount: number;
  isNext: boolean;
  labels: AdvancedAppearanceLabels;
  privacyMode: boolean;
  onSelectAccount?: (accountId: string) => void;
}) {
  const quota = getPrimaryQuotaPercentage(props.account);
  const quotaDegrees = `${Math.max(0, Math.min(100, quota ?? 0)) * 3.6}deg`;
  const label = resolvePlanetLabel(props.account, props.privacyMode);
  const scaleStep = props.orbitCount > 1 ? 0.2 / (props.orbitCount - 1) : 0;
  const scale = 1.2 - props.ringIndex * scaleStep;
  const brightnessStep = props.orbitCount > 1 ? 1 / (props.orbitCount - 1) : 0;
  const brightness = props.orbitCount > 1 ? 2 - props.ringIndex * brightnessStep : 1;
  const planetClass = [
    "advanced-solar-planet",
    `planet-plan-${resolvePlanClass(props.account)}`,
    props.account.isHidden ? "is-hidden" : "",
    props.isNext ? "is-next" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      class="advanced-solar-orbit-spin"
      style={{
        "--orbit-start-angle": `${props.angle}deg`,
        "--orbit-duration": `${props.duration}s`,
        "--orbit-counter-angle": `${-props.angle}deg`
      }}
    >
      <button
        class={planetClass}
        type="button"
        aria-label={label}
        data-label={label}
        style={{
          "--planet-progress": quotaDegrees,
          "--planet-scale": String(scale),
          "--planet-brightness": String(brightness)
        }}
        title={label}
        onClick={() => props.onSelectAccount?.(props.account.id)}
      >
        <span class="advanced-solar-planet-upright">
          <span class="advanced-solar-planet-text">
            <span class="advanced-solar-planet-label" aria-hidden="true">
              {label}
            </span>
          </span>
        </span>
      </button>
    </div>
  );
}

function SolarSystem(props: {
  accounts: readonly DashboardAccountViewModel[];
  activeAccount?: DashboardAccountViewModel;
  labels: AdvancedAppearanceLabels;
  privacyMode: boolean;
  onSelectAccount?: (accountId: string) => void;
}) {
  const activeAccountId = props.activeAccount?.id;
  const orbitAccounts = rotateAccountsAfterActive(props.accounts, activeAccountId).filter(
    (account) => account.id !== activeAccountId
  );
  const visibleOrbitAccounts = orbitAccounts.slice(0, ORBIT_ACCOUNT_LIMIT);
  const initialOrbitAngles = resolveOrbitAngles(visibleOrbitAccounts);
  const activeLabel = props.activeAccount
    ? getSensitiveDisplayValue(props.activeAccount.email || props.activeAccount.displayName, props.privacyMode, "email")
    : props.labels.noActive;
  const activeQuota = props.activeAccount ? formatPlanetQuota(props.activeAccount) : "—";

  return (
    <div class="advanced-solar-system" aria-label={props.labels.orbitHint}>
      <div class="advanced-solar-nebula" aria-hidden="true" />
      {visibleOrbitAccounts.map((account, ringIndex) => {
        const diameter = ORBIT_DIAMETERS[ringIndex] ?? 510;
        const duration = resolveOrbitDuration(account.id, ringIndex);
        return (
          <div
            key={`orbit-ring-${ringIndex}`}
            class="advanced-solar-orbit-ring"
            style={{ "--orbit-diameter": `${diameter}px`, "--orbit-ring-index": String(ringIndex) }}
          >
            <SolarPlanet
              account={account}
              angle={initialOrbitAngles[ringIndex] ?? 0}
              duration={duration}
              ringIndex={ringIndex}
              orbitCount={visibleOrbitAccounts.length}
              isNext={ringIndex === 0}
              labels={props.labels}
              privacyMode={props.privacyMode}
              onSelectAccount={props.onSelectAccount}
            />
          </div>
        );
      })}
      {props.activeAccount ? (
        <button
          class="advanced-solar-star"
          type="button"
          aria-label={`${props.labels.active}: ${activeLabel} · ${activeQuota}`}
          title={`${activeLabel} · ${activeQuota}`}
          onClick={() => props.onSelectAccount?.(props.activeAccount!.id)}
        >
          <span class="advanced-solar-star-quota">{activeQuota}</span>
          <span class="advanced-solar-star-hover-label" aria-hidden="true">
            {activeLabel} · {activeQuota}
          </span>
        </button>
      ) : (
        <div class="advanced-solar-star advanced-solar-star-empty">
          <strong>{activeLabel}</strong>
        </div>
      )}
      {orbitAccounts.length > visibleOrbitAccounts.length ? (
        <div class="advanced-solar-overflow" title={props.labels.moreAccounts}>
          +{orbitAccounts.length - visibleOrbitAccounts.length}
        </div>
      ) : null}
    </div>
  );
}

function formatAdvancedMetricValue(metric: DashboardAccountViewModel["metrics"][number]): string {
  if (metric.percentage != null) {
    return `${Math.round(Math.max(0, Math.min(100, metric.percentage)))}%`;
  }
  if (metric.requestsLeft != null && metric.requestsLimit != null) {
    return `${metric.requestsLeft}/${metric.requestsLimit}`;
  }
  return "—";
}

function renderAdvancedProviderActionIcon(actionId: string) {
  if (actionId === "refresh") {
    return renderRefreshIcon();
  }
  if (actionId === "configureCredential") {
    return renderReauthorizeIcon();
  }
  if (actionId === "openConfig") {
    return renderDetailsIcon();
  }
  return renderDetailsIcon();
}

function AdvancedAccountFocus(props: {
  account?: DashboardAccountViewModel;
  copy: DashboardCopy;
  lang: DashboardState["lang"];
  privacyMode: boolean;
  now: number;
  isAccountBusy: (accountId: string) => boolean;
  isActionPending: (action: DashboardActionName, accountId?: string) => boolean;
  onAction: SendAction;
  sharingEnabled?: boolean;
  onRequestShare?: (accountId: string) => void;
  copyFeedbackKey?: string | null;
}) {
  const account = props.account;
  if (!account) {
    return (
      <div class="advanced-account-focus advanced-account-focus-empty">
        <span class="advanced-command-label">ACCOUNT FOCUS</span>
        <strong>{props.copy.noActiveAccountTitle}</strong>
      </div>
    );
  }

  const virtual = account.accountKind === "sub2api" || account.manualOnly === true;
  const busy = props.isAccountBusy(account.id);
  const emailDisplay = getSensitiveDisplayValue(account.email || account.displayName, props.privacyMode, "email");
  const sharingFilter = getDashboardSharingFilter(account);
  const incomingSharedAccount = sharingFilter === "received";
  const outgoingSharedAccount = sharingFilter === "shared";
  const healthFilter = getDashboardHealthFilter(account);
  const hasUsableRenewalWarning = healthFilter === "usable_no_renewal";
  const hasUnknownHealth = healthFilter === "unknown";
  const hasRecoverableRenewalWarning =
    !account.dismissedHealth &&
    !hasUsableRenewalWarning &&
    getAccountHealthCategory(account.healthKind) === "temporary_error";
  const showReauthorizeButton =
    !virtual &&
    !account.dismissedHealth &&
    (isAccountReauthorizationRequired(account.healthKind) ||
      hasRecoverableRenewalWarning ||
      hasUsableRenewalWarning ||
      hasUnknownHealth);
  const showQuotaCountdownStart =
    account.quotaCountdownStartAvailable &&
    account.metrics.some(
      (metric) =>
        metric.visible &&
        (metric.key === "hourly" || metric.key === "weekly") &&
        isQuotaCountdownWindowFresh(metric.key, metric.resetAt, props.now, metric.windowMinutes)
    );
  const providerCard = virtual ? account.providerCard : undefined;
  const profileSelectionActions =
    providerCard?.actions?.filter((action) => action.id.startsWith("selectProfile:")) ?? [];
  const providerActions = providerCard?.actions?.filter((action) => !action.id.startsWith("selectProfile:")) ?? [];
  const selectedProfileAction = profileSelectionActions.find((action) => action.enabled === false);
  const providerActionPending = props.isActionPending("integrationAction", account.id);
  const quotaMetrics = account.metrics.filter((metric) => metric.visible).slice(0, 3);
  const poolLabel = account.balancePoolEnabled
    ? props.lang === "zh"
      ? "移出无感池"
      : props.lang === "zh-hant"
        ? "移出無感池"
        : "Remove from seamless pool"
    : props.lang === "zh"
      ? "加入无感池"
      : props.lang === "zh-hant"
        ? "加入無感池"
        : "Add to seamless pool";
  const shareLabel =
    props.lang === "zh" || props.lang === "zh-hant"
      ? incomingSharedAccount
        ? "归还账号"
        : "共享账号"
      : incomingSharedAccount
        ? "Return account"
        : "Share account";
  const copyEmailLabel =
    props.lang === "zh" ? "复制邮箱" : props.lang === "zh-hant" ? "複製郵箱" : "Copy email";
  const accountStatus = account.isCurrentWindowAccount
    ? props.copy.current
    : account.isActive || account.providerActive
      ? props.lang === "zh"
        ? "已激活"
        : props.lang === "zh-hant"
          ? "已啟用"
          : "Active"
      : account.healthLabel;

  return (
    <div class="advanced-account-focus">
      <div class="advanced-account-focus-heading">
        <span class="advanced-command-label">
          {props.lang === "zh" ? "选中账号" : props.lang === "zh-hant" ? "選取帳號" : "SELECTED ACCOUNT"}
        </span>
        <span class="advanced-account-focus-status">{accountStatus}</span>
      </div>
      <strong class="advanced-account-focus-email">{emailDisplay}</strong>
      <div class="advanced-account-focus-meta">
        <span>{account.planTypeLabel}</span>
        {account.accountGroup ? <span>Group {account.accountGroup}</span> : null}
        {account.isHidden ? <span>{props.lang === "zh" ? "已隐藏" : "Hidden"}</span> : null}
      </div>
      <div class="advanced-account-focus-metrics">
        {quotaMetrics.map((metric) => (
          <div class="advanced-account-focus-metric" key={metric.key}>
            <span>{metric.label}</span>
            <strong>{formatAdvancedMetricValue(metric)}</strong>
          </div>
        ))}
      </div>
      <div class="advanced-account-focus-details">
        <div>
          <span>{props.lang === "zh" ? "健康状态" : "Health"}</span>
          <strong>{account.healthLabel}</strong>
        </div>
        <div>
          <span>{props.lang === "zh" ? "订阅" : "Subscription"}</span>
          <strong title={account.subscriptionTitle}>{account.subscriptionText}</strong>
        </div>
        <div>
          <span>{props.lang === "zh" ? "工作区" : "Workspace"}</span>
          <strong>{account.workspaceLabel}</strong>
        </div>
      </div>
      <div class="advanced-account-actions" aria-label={props.copy.detailsBtn}>
        {!virtual ? (
          <ActionButton
            class="advanced-account-action advanced-account-action-wide"
            icon={renderSwitchIcon()}
            label={poolLabel}
            disabled={busy || account.isHidden}
            pending={props.isActionPending("toggleBalancePool", account.id)}
            onClick={() => props.onAction("toggleBalancePool", account.id)}
          >
            {poolLabel}
          </ActionButton>
        ) : null}
        {!virtual && account.isActive && !account.isCurrentWindowAccount ? (
          <ActionButton
            class="advanced-account-action"
            icon={renderReloadIcon()}
            iconOnly
            label={props.copy.reloadBtn}
            disabled={busy}
            pending={props.isActionPending("reloadPrompt", account.id)}
            onClick={() => props.onAction("reloadPrompt", account.id)}
          />
        ) : null}
        {showReauthorizeButton ? (
          <ActionButton
            class="advanced-account-action"
            icon={renderReauthorizeIcon()}
            iconOnly
            label={props.copy.reauthorizeBtn}
            disabled={busy}
            pending={props.isActionPending("reauthorize", account.id)}
            onClick={() => props.onAction("reauthorize", account.id)}
          />
        ) : null}
        <ActionButton
          class="advanced-account-action advanced-account-action-primary"
          icon={renderSwitchIcon()}
          label={props.copy.switchBtn}
          disabled={busy || account.isHidden}
          pending={props.isActionPending("switch", account.id)}
          onClick={() => props.onAction("switch", account.id)}
        >
          {props.copy.switchBtn}
        </ActionButton>
        {profileSelectionActions.length > 1 ? (
          <select
            class="advanced-account-profile-select"
            aria-label={props.lang === "zh" ? "选择 Gateway 配置" : "Choose Gateway profile"}
            value={selectedProfileAction?.id ?? profileSelectionActions[0]?.id ?? ""}
            disabled={busy || providerActionPending}
            onChange={(event) => {
              const action = profileSelectionActions.find((candidate) => candidate.id === event.currentTarget.value);
              if (action && action.enabled !== false) {
                props.onAction("integrationAction", account.id, {
                  integrationId: providerCard?.integrationId,
                  integrationActionId: action.id
                });
              }
            }}
          >
            {profileSelectionActions.map((action) => (
              <option key={action.id} value={action.id} disabled={action.enabled === false}>
                {action.label}
              </option>
            ))}
          </select>
        ) : null}
        {providerActions.map((action) => (
          <ActionButton
            key={action.id}
            class="advanced-account-action"
            icon={renderAdvancedProviderActionIcon(action.id)}
            iconOnly
            label={action.label}
            tooltip={action.tooltip}
            disabled={busy || action.enabled === false}
            pending={providerActionPending}
            onClick={() =>
              props.onAction("integrationAction", account.id, {
                integrationId: providerCard?.integrationId,
                integrationActionId: action.id
              })
            }
          />
        ))}
        {!virtual ? (
          <ActionButton
            class="advanced-account-action"
            icon={renderRefreshIcon()}
            iconOnly
            label={props.copy.refreshBtn}
            disabled={busy}
            pending={props.isActionPending("refresh", account.id)}
            onClick={() => props.onAction("refresh", account.id)}
          />
        ) : null}
        {!virtual ? (
          <ActionButton
            class="advanced-account-action"
            icon={props.copyFeedbackKey === `account-import-json:${account.id}` ? <SuccessIcon /> : <CopyIcon />}
            iconOnly
            label={
              props.copyFeedbackKey === `account-import-json:${account.id}`
                ? props.copy.copySuccess
                : props.copy.copyAccountImportJsonBtn
            }
            disabled={busy || Boolean(account.sharingState)}
            pending={props.isActionPending("copyAccountImportJson", account.id)}
            onClick={() => props.onAction("copyAccountImportJson", account.id)}
          />
        ) : null}
        {!virtual && showQuotaCountdownStart ? (
          <ActionButton
            class="advanced-account-action"
            icon={renderQuotaCountdownStartIcon()}
            iconOnly
            label={props.lang === "zh" ? "启动额度倒计时" : "Start quota countdown"}
            disabled={busy}
            pending={props.isActionPending("startQuotaCountdown", account.id)}
            onClick={() => props.onAction("startQuotaCountdown", account.id)}
          />
        ) : null}
        {!virtual && account.resetCreditsAvailable != null && account.resetCreditsAvailable > 0 ? (
          <ActionButton
            class="advanced-account-action"
            icon={renderResetCreditsIcon()}
            iconOnly
            label={`${props.copy.resetCreditsBtn ?? "重置配额"} (${account.resetCreditsAvailable})`}
            disabled={busy}
            pending={props.isActionPending("consumeResetCredit", account.id)}
            onClick={() => props.onAction("consumeResetCredit", account.id)}
          />
        ) : null}
        {props.sharingEnabled !== false && !virtual && incomingSharedAccount ? (
          <ActionButton
            class="advanced-account-action"
            label={shareLabel}
            disabled={busy}
            pending={props.isActionPending("returnSharedAccount", account.id)}
            onClick={() => props.onAction("returnSharedAccount", account.id)}
          >
            {shareLabel}
          </ActionButton>
        ) : props.sharingEnabled !== false && !virtual && !outgoingSharedAccount ? (
          <ActionButton
            class="advanced-account-action"
            label={shareLabel}
            disabled={busy}
            pending={props.isActionPending("shareAccounts", account.id)}
            onClick={() => {
              if (props.onRequestShare) {
                props.onRequestShare(account.id);
              } else {
                props.onAction("shareAccounts", account.id);
              }
            }}
          >
            {shareLabel}
          </ActionButton>
        ) : null}
        <ActionButton
          class="advanced-account-action"
          icon={props.copyFeedbackKey === `account-name:${account.id}` ? <SuccessIcon /> : <CopyIcon />}
          iconOnly
          label={props.copyFeedbackKey === `account-name:${account.id}` ? props.copy.copySuccess : copyEmailLabel}
          disabled={busy}
          pending={props.isActionPending("copyText", account.id)}
          onClick={() => props.onAction("copyText", account.id, { text: account.email })}
        />
        <ActionButton
          class="advanced-account-action advanced-account-action-danger"
          icon={renderRemoveIcon()}
          iconOnly
          label={props.copy.removeBtn}
          disabled={busy}
          pending={props.isActionPending("remove", account.id)}
          onClick={() => props.onAction("remove", account.id)}
        />
      </div>
    </div>
  );
}

export function AdvancedAppearanceSummary(props: {
  accounts: readonly DashboardAccountViewModel[];
  activeAccount?: DashboardAccountViewModel;
  copy: DashboardCopy;
  lang: DashboardState["lang"];
  indexHealthStatus: DashboardState["indexHealth"]["status"];
  privacyMode: boolean;
  now: number;
  isAccountBusy: (accountId: string) => boolean;
  isActionPending: (action: DashboardActionName, accountId?: string) => boolean;
  onAction: SendAction;
  sharingEnabled?: boolean;
  onRequestShare?: (accountId: string) => void;
  copyFeedbackKey?: string | null;
}) {
  const labels = resolveAdvancedAppearanceLabels(props.lang);
  const activeAccount = props.activeAccount;
  const isHealthy = props.indexHealthStatus === "healthy";
  const activeAccountId = activeAccount?.id;
  const [selectedAccountId, setSelectedAccountId] = useState(activeAccountId ?? props.accounts[0]?.id);
  const [focusRevision, setFocusRevision] = useState(0);
  const previousActiveAccountIdRef = useRef(activeAccountId);
  const selectedAccount = props.accounts.find((account) => account.id === selectedAccountId) ?? activeAccount;

  const selectAccount = (accountId: string): void => {
    if (accountId === selectedAccountId) {
      return;
    }
    if (!props.accounts.some((account) => account.id === accountId) && activeAccount?.id !== accountId) {
      return;
    }
    setSelectedAccountId(accountId);
    setFocusRevision((revision) => revision + 1);
  };

  useEffect(() => {
    if (previousActiveAccountIdRef.current === activeAccountId) {
      return;
    }
    previousActiveAccountIdRef.current = activeAccountId;
    if (activeAccountId && activeAccountId !== selectedAccountId) {
      setSelectedAccountId(activeAccountId);
      setFocusRevision((revision) => revision + 1);
    }
  }, [activeAccountId, selectedAccountId]);

  useEffect(() => {
    if (selectedAccountId && props.accounts.some((account) => account.id === selectedAccountId)) {
      return;
    }
    const fallbackAccountId = activeAccountId ?? props.accounts[0]?.id;
    if (fallbackAccountId && fallbackAccountId !== selectedAccountId) {
      setSelectedAccountId(fallbackAccountId);
      setFocusRevision((revision) => revision + 1);
    }
  }, [activeAccountId, props.accounts, selectedAccountId]);

  return (
    <div class="advanced-command-center" aria-label={labels.live}>
      <div class="advanced-command-grid" aria-hidden="true" />
      <div class="advanced-command-center-head">
        <div class="advanced-command-eyebrow">
          <span class="advanced-command-live-dot" />
          <span>{labels.live}</span>
        </div>
        <div class={`advanced-command-status ${isHealthy ? "is-online" : "is-recovery"}`}>
          <span class="advanced-command-status-dot" />
          <span>{isHealthy ? labels.online : labels.recovery}</span>
        </div>
      </div>
      <div class="advanced-command-center-body advanced-solar-layout">
        <SolarSystem
          accounts={props.accounts}
          activeAccount={activeAccount}
          labels={labels}
          privacyMode={props.privacyMode}
          onSelectAccount={selectAccount}
        />
        <div class="advanced-solar-telemetry">
          <div class="advanced-solar-focus-panel" aria-live="polite">
            <div
              key={`${selectedAccount?.id ?? "empty"}:${focusRevision}`}
              class="advanced-solar-focus-content"
            >
              <AdvancedAccountFocus
                account={selectedAccount}
                copy={props.copy}
                lang={props.lang}
                privacyMode={props.privacyMode}
                now={props.now}
                isAccountBusy={props.isAccountBusy}
                isActionPending={props.isActionPending}
                onAction={props.onAction}
                sharingEnabled={props.sharingEnabled}
                onRequestShare={props.onRequestShare}
                copyFeedbackKey={props.copyFeedbackKey}
              />
            </div>
          </div>
        </div>
      </div>
      <div class="advanced-solar-hint">{labels.orbitHint}</div>
      <div class="advanced-command-scanline" aria-hidden="true">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          <rect
            x="0.5"
            y="0.5"
            width="99"
            height="99"
            rx="1.25"
            ry="2.4"
            pathLength="100"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    </div>
  );
}

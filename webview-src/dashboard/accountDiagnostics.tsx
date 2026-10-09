import type { DashboardAccountViewModel, DashboardSettings, DashboardState } from "../../src/domain/dashboard/types";
import { getAccountHealthCategory, getManagedAccountState, isAccountInvalid } from "../../src/domain/accountHealth";
import { formatTimestamp } from "./helpers";

export type AccountDiagnosticTone = "positive" | "warning" | "error" | "neutral";

export type AccountDiagnosticSettings = Pick<
  DashboardSettings,
  | "seamlessSwitchEnabled"
  | "seamlessSwitchGroupAVisible"
  | "seamlessSwitchGroupBVisible"
  | "seamlessSwitchGroupCVisible"
>;

export interface AccountDiagnosticCheck {
  label: string;
  value: string;
  tone: AccountDiagnosticTone;
}

export interface AccountDiagnostic {
  tone: AccountDiagnosticTone;
  title: string;
  message: string;
  nextStep: string;
  checks: readonly AccountDiagnosticCheck[];
}

type PoolState = {
  label: string;
  tone: AccountDiagnosticTone;
};

export function resolveAccountDiagnostic(
  account: DashboardAccountViewModel,
  settings: AccountDiagnosticSettings,
  lang: DashboardState["lang"]
): AccountDiagnostic {
  const labels = resolveDiagnosticLabels(lang);
  const virtual = account.accountKind === "sub2api" || account.manualOnly === true;
  const pool = resolvePoolState(account, settings, labels);
  const health = resolveHealthDiagnostic(account, labels);
  const checks: AccountDiagnosticCheck[] = [
    { label: labels.health, value: account.healthLabel, tone: health.tone },
    { label: labels.pool, value: pool.label, tone: pool.tone },
    {
      label: labels.availability,
      value: resolveAvailabilityLabel(account, labels),
      tone: resolveAvailabilityTone(account)
    },
    {
      label: labels.renewal,
      value: resolveRenewalLabel(account, labels),
      tone: resolveRenewalTone(account)
    },
    {
      label: labels.lastQuota,
      value: formatTimestamp(account.lastQuotaAt, labels.notRecorded),
      tone: account.lastQuotaAt ? "positive" : "neutral"
    }
  ];

  if (account.lastTokenRefreshError) {
    checks.push({
      label: labels.lastFailure,
      value: account.lastTokenRefreshError,
      tone: "warning"
    });
  }

  if (virtual) {
    return {
      tone: "neutral",
      title: labels.virtualTitle,
      message: labels.virtualMessage,
      nextStep: labels.virtualNextStep,
      checks
    };
  }

  if (health.tone === "error" || health.tone === "warning" || health.tone === "neutral") {
    return {
      ...health,
      checks
    };
  }

  if (pool.label !== labels.poolReady) {
    return {
      tone: pool.tone,
      title: labels.poolTitle,
      message: labels.poolMessage,
      nextStep: resolvePoolNextStep(account, settings, labels),
      checks
    };
  }

  return {
    tone: "positive",
    title: labels.readyTitle,
    message: labels.readyMessage,
    nextStep: labels.readyNextStep,
    checks
  };
}

function resolveHealthDiagnostic(
  account: DashboardAccountViewModel,
  labels: ReturnType<typeof resolveDiagnosticLabels>
): Omit<AccountDiagnostic, "checks"> {
  const kind = account.healthKind;
  const managedState = getManagedAccountState({
    kind,
    availability: account.availability,
    renewal: account.renewal
  });

  if (isAccountInvalid(kind) || kind === "refresh_token_invalid" || kind === "reauthorize") {
    return {
      tone: "error",
      title: labels.authTitle,
      message: account.healthMessage ?? labels.authMessage,
      nextStep: labels.authNextStep
    };
  }

  if (kind === "quota" || getAccountHealthCategory(kind) === "quota_limited") {
    return {
      tone: "warning",
      title: labels.quotaTitle,
      message: labels.quotaMessage,
      nextStep: labels.quotaNextStep
    };
  }

  if (kind === "refresh_unavailable" || (account.availability === "usable" && account.renewal === "unavailable")) {
    return {
      tone: "warning",
      title: labels.renewalUnavailableTitle,
      message: labels.renewalUnavailableMessage,
      nextStep: labels.renewalUnavailableNextStep
    };
  }

  if (kind === "refresh_failed") {
    return {
      tone: "warning",
      title: labels.refreshFailedTitle,
      message: labels.refreshFailedMessage,
      nextStep: labels.refreshFailedNextStep
    };
  }

  if (kind === "refreshing") {
    return {
      tone: "neutral",
      title: labels.refreshingTitle,
      message: labels.refreshingMessage,
      nextStep: labels.refreshingNextStep
    };
  }

  if (kind === "expiring") {
    return {
      tone: "warning",
      title: labels.expiringTitle,
      message: labels.expiringMessage,
      nextStep: labels.expiringNextStep
    };
  }

  if (kind === "refresh_unavailable_unverified" || kind === "unverified" || managedState === "unknown") {
    return {
      tone: "neutral",
      title: labels.unverifiedTitle,
      message: labels.unverifiedMessage,
      nextStep: labels.unverifiedNextStep
    };
  }

  return {
    tone: "positive",
    title: labels.healthyTitle,
    message: labels.healthyMessage,
    nextStep: labels.healthyNextStep
  };
}

function resolvePoolState(
  account: DashboardAccountViewModel,
  settings: AccountDiagnosticSettings,
  labels: ReturnType<typeof resolveDiagnosticLabels>
): PoolState {
  if (account.accountKind === "sub2api" || account.manualOnly === true) {
    return { label: labels.poolManual, tone: "neutral" };
  }
  if (account.isHidden) {
    return { label: labels.poolHidden, tone: "warning" };
  }
  if (!settings.seamlessSwitchEnabled) {
    return { label: labels.poolFeatureOff, tone: "neutral" };
  }
  if (account.accountGroup && !isGroupVisible(account.accountGroup, settings)) {
    return { label: labels.poolGroupHidden, tone: "warning" };
  }
  if (!account.balancePoolEnabled) {
    return { label: labels.poolNotJoined, tone: "warning" };
  }
  return { label: labels.poolReady, tone: "positive" };
}

function resolvePoolNextStep(
  account: DashboardAccountViewModel,
  settings: AccountDiagnosticSettings,
  labels: ReturnType<typeof resolveDiagnosticLabels>
): string {
  if (account.isHidden) {
    return labels.poolHiddenNextStep;
  }
  if (!settings.seamlessSwitchEnabled) {
    return labels.poolFeatureOffNextStep;
  }
  if (account.accountGroup && !isGroupVisible(account.accountGroup, settings)) {
    return labels.poolGroupHiddenNextStep;
  }
  return labels.poolNotJoinedNextStep;
}

function isGroupVisible(
  group: NonNullable<DashboardAccountViewModel["accountGroup"]>,
  settings: AccountDiagnosticSettings
): boolean {
  switch (group) {
    case "A":
      return settings.seamlessSwitchGroupAVisible;
    case "B":
      return settings.seamlessSwitchGroupBVisible;
    case "C":
      return settings.seamlessSwitchGroupCVisible;
  }
}

function resolveAvailabilityLabel(
  account: DashboardAccountViewModel,
  labels: ReturnType<typeof resolveDiagnosticLabels>
): string {
  switch (account.availability) {
    case "usable":
      return labels.availabilityUsable;
    case "quota_limited":
      return labels.availabilityQuota;
    case "auth_unavailable":
      return labels.availabilityInvalid;
    default:
      return labels.availabilityUnknown;
  }
}

function resolveAvailabilityTone(account: DashboardAccountViewModel): AccountDiagnosticTone {
  switch (account.availability) {
    case "usable":
      return "positive";
    case "quota_limited":
      return "warning";
    case "auth_unavailable":
      return "error";
    default:
      return "neutral";
  }
}

function resolveRenewalLabel(
  account: DashboardAccountViewModel,
  labels: ReturnType<typeof resolveDiagnosticLabels>
): string {
  switch (account.renewal) {
    case "succeeded":
      return labels.renewalSucceeded;
    case "unavailable":
      return labels.renewalUnavailable;
    case "network_failed":
      return labels.renewalFailed;
    case "refreshing":
      return labels.renewalRefreshing;
    default:
      return labels.renewalUnknown;
  }
}

function resolveRenewalTone(account: DashboardAccountViewModel): AccountDiagnosticTone {
  switch (account.renewal) {
    case "succeeded":
      return "positive";
    case "unavailable":
    case "network_failed":
      return "warning";
    default:
      return "neutral";
  }
}

function resolveDiagnosticLabels(lang: DashboardState["lang"]) {
  if (lang === "zh") {
    return {
      diagnostic: "账号诊断",
      health: "健康状态",
      pool: "无感切号",
      availability: "可用性证据",
      availabilityUsable: "已确认可用",
      availabilityQuota: "受额度限制",
      availabilityInvalid: "认证不可用",
      availabilityUnknown: "尚未确认",
      renewal: "续期证据",
      renewalSucceeded: "最近续期成功",
      renewalUnavailable: "无法续期",
      renewalFailed: "网络续期失败",
      renewalRefreshing: "正在续期",
      renewalUnknown: "尚未确认",
      lastQuota: "最近配额",
      lastFailure: "最近失败",
      notRecorded: "暂无记录",
      poolReady: "已加入候选池",
      poolManual: "Gateway 手动模式",
      poolHidden: "已隐藏，不参与",
      poolFeatureOff: "功能未开启",
      poolGroupHidden: "分组未启用",
      poolNotJoined: "尚未加入候选池",
      virtualTitle: "手动 Gateway 账号",
      virtualMessage: "该账号由 Gateway 路由控制，不参与 Manager 的健康检查和无感切号。",
      virtualNextStep: "请在 Gateway 配置中管理此账号。",
      authTitle: "认证不可用",
      authMessage: "当前凭据不能被确认用于正常请求。",
      authNextStep: "重新授权后再刷新配额。",
      quotaTitle: "当前受额度限制",
      quotaMessage: "当前请求受到额度窗口限制，这不等同于凭据失效。",
      quotaNextStep: "等待额度窗口重置，或刷新配额确认状态。",
      renewalUnavailableTitle: "账号可用，但无法续期",
      renewalUnavailableMessage: "当前凭据仍有可用性证据，但刷新令牌无法续期，后续可能自然失效。",
      renewalUnavailableNextStep: "重新授权以恢复续期能力。",
      refreshFailedTitle: "续期检查失败",
      refreshFailedMessage: "最近一次后台续期没有完成，可能与网络、代理或服务暂时异常有关。",
      refreshFailedNextStep: "检查代理和网络后刷新配额。",
      refreshingTitle: "正在确认凭据",
      refreshingMessage: "后台正在尝试续期，当前健康状态还没有最终结论。",
      refreshingNextStep: "等待本轮续期完成。",
      expiringTitle: "访问令牌即将过期",
      expiringMessage: "当前访问令牌接近过期，续期证据尚未建立。",
      expiringNextStep: "保持后台续期开启，或手动重新授权。",
      unverifiedTitle: "状态尚未确认",
      unverifiedMessage: "Manager 还没有拿到足够的新证据确认当前凭据可用。",
      unverifiedNextStep: "刷新配额以重新确认账号。",
      healthyTitle: "账号状态正常",
      healthyMessage: "最近的认证观察表明当前凭据可以正常使用。",
      healthyNextStep: "可继续使用，或按需加入无感切号候选池。",
      readyTitle: "账号已准备好切换",
      readyMessage: "凭据状态正常，账号也已加入当前无感切号候选池。",
      readyNextStep: "当前可参与无感切号；实际选择仍会受额度和运行时状态影响。",
      poolTitle: "账号可用，但未参与无感切号",
      poolMessage: "凭据状态没有阻止使用，当前主要是无感切号范围设置将它排除。",
      poolHiddenNextStep: "取消隐藏后，账号才会重新进入可见范围。",
      poolFeatureOffNextStep: "在 Dashboard 设置中开启无感切号。",
      poolGroupHiddenNextStep: "在设置中打开该账号所属分组。",
      poolNotJoinedNextStep: "点击账号卡片左下角开关加入无感切号池。"
    };
  }
  if (lang === "zh-hant") {
    return {
      diagnostic: "帳號診斷",
      health: "健康狀態",
      pool: "無感切換",
      availability: "可用性證據",
      availabilityUsable: "已確認可用",
      availabilityQuota: "受配額限制",
      availabilityInvalid: "認證不可用",
      availabilityUnknown: "尚未確認",
      renewal: "續期證據",
      renewalSucceeded: "最近續期成功",
      renewalUnavailable: "無法續期",
      renewalFailed: "網路續期失敗",
      renewalRefreshing: "正在續期",
      renewalUnknown: "尚未確認",
      lastQuota: "最近配額",
      lastFailure: "最近失敗",
      notRecorded: "暫無記錄",
      poolReady: "已加入候選池",
      poolManual: "Gateway 手動模式",
      poolHidden: "已隱藏，不參與",
      poolFeatureOff: "功能未開啟",
      poolGroupHidden: "分組未啟用",
      poolNotJoined: "尚未加入候選池",
      virtualTitle: "手動 Gateway 帳號",
      virtualMessage: "此帳號由 Gateway 路由控制，不參與 Manager 的健康檢查和無感切換。",
      virtualNextStep: "請在 Gateway 設定中管理此帳號。",
      authTitle: "認證不可用",
      authMessage: "目前憑據不能被確認用於正常請求。",
      authNextStep: "重新授權後再刷新配額。",
      quotaTitle: "目前受配額限制",
      quotaMessage: "目前請求受到配額視窗限制，這不等同於憑據失效。",
      quotaNextStep: "等待配額視窗重置，或刷新配額確認狀態。",
      renewalUnavailableTitle: "帳號可用，但無法續期",
      renewalUnavailableMessage: "目前憑據仍有可用性證據，但刷新權杖無法續期，後續可能自然失效。",
      renewalUnavailableNextStep: "重新授權以恢復續期能力。",
      refreshFailedTitle: "續期檢查失敗",
      refreshFailedMessage: "最近一次背景續期沒有完成，可能與網路、代理或服務暫時異常有關。",
      refreshFailedNextStep: "檢查代理和網路後刷新配額。",
      refreshingTitle: "正在確認憑據",
      refreshingMessage: "背景正在嘗試續期，目前健康狀態還沒有最終結論。",
      refreshingNextStep: "等待本輪續期完成。",
      expiringTitle: "存取權杖即將過期",
      expiringMessage: "目前存取權杖接近過期，續期證據尚未建立。",
      expiringNextStep: "保持背景續期開啟，或手動重新授權。",
      unverifiedTitle: "狀態尚未確認",
      unverifiedMessage: "Manager 還沒有取得足夠的新證據確認目前憑據可用。",
      unverifiedNextStep: "刷新配額以重新確認帳號。",
      healthyTitle: "帳號狀態正常",
      healthyMessage: "最近的認證觀察表明目前憑據可以正常使用。",
      healthyNextStep: "可繼續使用，或按需加入無感切換候選池。",
      readyTitle: "帳號已準備好切換",
      readyMessage: "憑據狀態正常，帳號也已加入目前無感切換候選池。",
      readyNextStep: "目前可參與無感切換；實際選擇仍會受配額和執行時狀態影響。",
      poolTitle: "帳號可用，但未參與無感切換",
      poolMessage: "憑據狀態沒有阻止使用，目前主要是無感切換範圍設定將它排除。",
      poolHiddenNextStep: "取消隱藏後，帳號才會重新進入可見範圍。",
      poolFeatureOffNextStep: "在 Dashboard 設定中開啟無感切換。",
      poolGroupHiddenNextStep: "在設定中開啟該帳號所屬分組。",
      poolNotJoinedNextStep: "點擊帳號卡片左下角開關加入無感切換池。"
    };
  }
  return {
    diagnostic: "Account diagnostics",
    health: "Health",
    pool: "Seamless switching",
    availability: "Availability evidence",
    availabilityUsable: "Confirmed usable",
    availabilityQuota: "Quota limited",
    availabilityInvalid: "Authentication unavailable",
    availabilityUnknown: "Not verified",
    renewal: "Renewal evidence",
    renewalSucceeded: "Renewal succeeded",
    renewalUnavailable: "Renewal unavailable",
    renewalFailed: "Network renewal failed",
    renewalRefreshing: "Renewal in progress",
    renewalUnknown: "Not verified",
    lastQuota: "Last quota refresh",
    lastFailure: "Last failure",
    notRecorded: "No record",
    poolReady: "In candidate pool",
    poolManual: "Gateway manual mode",
    poolHidden: "Hidden, excluded",
    poolFeatureOff: "Feature disabled",
    poolGroupHidden: "Group disabled",
    poolNotJoined: "Not in candidate pool",
    virtualTitle: "Manual Gateway account",
    virtualMessage:
      "This account is controlled by the Gateway route and is not part of Manager health checks or seamless switching.",
    virtualNextStep: "Manage this account in the Gateway configuration.",
    authTitle: "Authentication unavailable",
    authMessage: "The current credentials could not be confirmed for normal requests.",
    authNextStep: "Reauthorize the account, then refresh quota.",
    quotaTitle: "Quota currently limited",
    quotaMessage:
      "Requests are currently limited by a quota window; this does not by itself mean the credentials are invalid.",
    quotaNextStep: "Wait for the quota window to reset, or refresh quota to confirm the state.",
    renewalUnavailableTitle: "Usable, but renewal unavailable",
    renewalUnavailableMessage:
      "The current credentials have usability evidence, but the refresh token cannot renew them and they may expire later.",
    renewalUnavailableNextStep: "Reauthorize the account to restore renewal.",
    refreshFailedTitle: "Refresh check failed",
    refreshFailedMessage:
      "The latest background renewal did not complete, possibly because of the network, proxy, or a temporary service failure.",
    refreshFailedNextStep: "Check the proxy and network, then refresh quota.",
    refreshingTitle: "Credentials being checked",
    refreshingMessage: "Background renewal is in progress, so the health result is not final yet.",
    refreshingNextStep: "Wait for the current renewal attempt to finish.",
    expiringTitle: "Access token expiring",
    expiringMessage: "The access token is close to expiry and fresh renewal evidence has not been established.",
    expiringNextStep: "Keep background renewal enabled or reauthorize manually.",
    unverifiedTitle: "State not verified",
    unverifiedMessage:
      "Manager does not yet have enough recent evidence to confirm that the current credentials are usable.",
    unverifiedNextStep: "Refresh quota to verify the account again.",
    healthyTitle: "Account healthy",
    healthyMessage: "Recent authentication observations show that the current credentials are usable.",
    healthyNextStep: "Continue using it, or add it to the seamless-switch candidate pool when needed.",
    readyTitle: "Ready for switching",
    readyMessage: "The credentials are healthy and this account is in the current seamless-switch candidate pool.",
    readyNextStep: "It can participate in seamless switching; quota and runtime state still affect actual selection.",
    poolTitle: "Usable, but excluded from seamless switching",
    poolMessage:
      "The credential state is not blocking use; the current seamless-switch scope is excluding this account.",
    poolHiddenNextStep: "Unhide the account to return it to the visible scope.",
    poolFeatureOffNextStep: "Enable seamless switching in Dashboard settings.",
    poolGroupHiddenNextStep: "Enable the account's group in settings.",
    poolNotJoinedNextStep: "Use the lower-left toggle on the account card to join the seamless-switch pool."
  };
}

export function AccountDiagnosticPanel(props: {
  account: DashboardAccountViewModel;
  settings: AccountDiagnosticSettings;
  lang: DashboardState["lang"];
}) {
  const diagnostic = resolveAccountDiagnostic(props.account, props.settings, props.lang);
  const labels = resolveDiagnosticLabels(props.lang);
  return (
    <section class={`account-diagnostic account-diagnostic-${diagnostic.tone}`} aria-label={labels.diagnostic}>
      <div class="account-diagnostic-heading">
        <span>{labels.diagnostic}</span>
        <strong>{diagnostic.title}</strong>
      </div>
      <p class="account-diagnostic-message">{diagnostic.message}</p>
      <div class="account-diagnostic-next">
        <span>{props.lang === "zh" ? "下一步" : props.lang === "zh-hant" ? "下一步" : "Next"}</span>
        <strong>{diagnostic.nextStep}</strong>
      </div>
      <div class="account-diagnostic-checks">
        {diagnostic.checks.map((check) => (
          <div class={`account-diagnostic-check account-diagnostic-check-${check.tone}`} key={check.label}>
            <span>{check.label}</span>
            <strong title={check.value}>{check.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

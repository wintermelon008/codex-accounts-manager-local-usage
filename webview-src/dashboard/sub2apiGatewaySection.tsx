import type {
  DashboardActionName,
  DashboardState,
  DashboardSub2ApiGatewayViewModel,
  DashboardSub2ApiGatewayQuotaPool,
  DashboardSub2ApiGatewayTokenTotals
} from "../../src/domain/dashboard/types";
import { ActionButton } from "./primitives";

type GatewayFailure = NonNullable<DashboardSub2ApiGatewayViewModel["usage"]["lastFailure"]>;

type GatewayAction = Extract<
  DashboardActionName,
  | "sub2apiGatewayActivate"
  | "sub2apiGatewayDeactivate"
  | "sub2apiGatewayRefresh"
  | "sub2apiGatewayConfigureCredential"
  | "sub2apiGatewayConfigureObserverCredential"
  | "sub2apiGatewayOpenConfig"
>;

export function Sub2ApiGatewaySection(props: {
  gateway: DashboardState["sub2apiGateway"];
  lang: DashboardState["lang"];
  busy: boolean;
  activatePending: boolean;
  deactivatePending: boolean;
  refreshPending: boolean;
  credentialPending: boolean;
  observerCredentialPending: boolean;
  openConfigPending: boolean;
  onAction: (action: GatewayAction) => void;
}) {
  const gateway = props.gateway;
  if (!gateway) {
    return null;
  }
  const copy = getGatewayCopy(props.lang);
  const statusLabel = copy.status[gateway.status];
  const healthLabel = gateway.health
    ? gateway.health.status === "healthy"
      ? copy.healthHealthy(gateway.health.exposedModelCount)
      : (gateway.health.message ?? copy.healthFailed)
    : copy.healthNotChecked;
  const observerLabel = resolveObserverLabel(gateway, copy);
  const failureLabel = gateway.usage.lastFailure
    ? copy.lastFailure(gateway.usage.lastFailure)
    : undefined;

  return (
    <section class="section sub2api-gateway-section">
      <div class="header" style={{ marginBottom: "12px" }}>
        <div>
          <div class="header-title" style={{ fontSize: "14px" }}>
            {copy.title}
          </div>
          <div class="header-sub">{copy.subtitle}</div>
        </div>
      </div>
      <article class={`sub2api-gateway-card status-${gateway.status}`}>
        <div class="sub2api-gateway-head">
          <div>
            <div class="sub2api-gateway-title-row">
              <h3>{gateway.displayName}</h3>
              <span class={`sub2api-gateway-status status-${gateway.status}`}>{statusLabel}</span>
            </div>
            <p>{gateway.statusMessage}</p>
          </div>
          {gateway.isActive ? <span class="pill active">{copy.active}</span> : null}
        </div>

        <div class="sub2api-gateway-details">
          <div>
            <span>{copy.config}</span>
            <code>{gateway.configFile}</code>
          </div>
          <div>
            <span>{copy.endpoint}</span>
            <code>{gateway.baseUrl ?? copy.notConfigured}</code>
          </div>
          <div>
            <span>{copy.model}</span>
            <code>{gateway.model ?? copy.notConfigured}</code>
          </div>
          <div>
            <span>{copy.credential}</span>
            <code>{gateway.credentialRef ?? copy.notConfigured}</code>
          </div>
        </div>

        <div class="sub2api-gateway-health">
          <span>{copy.health}</span>
          <span>{healthLabel}</span>
          {gateway.health?.checkedAt ? <time>{formatTimestamp(gateway.health.checkedAt)}</time> : null}
        </div>

        <div class="sub2api-gateway-usage sub2api-gateway-quota-grid">
          <GatewayQuotaMetric
            quotaLabel={copy.fiveHourPool}
            usageLabel={copy.fiveHourUsage}
            pool={gateway.inventory.fiveHour}
            usage={gateway.usage.windows.fiveHour}
            copy={copy}
          />
          <GatewayQuotaMetric
            quotaLabel={copy.weeklyPool}
            usageLabel={copy.sevenDayUsage}
            pool={gateway.inventory.weekly}
            usage={gateway.usage.windows.sevenDay}
            copy={copy}
          />
          <div class="sub2api-gateway-token-metric">
            <span>{copy.todayTokens}</span>
            <strong>{formatTokens(gateway.usage.today.totalTokens)}</strong>
            <small>
              {copy.tokenDetail(
                gateway.usage.today.inputTokens,
                gateway.usage.today.outputTokens,
                gateway.usage.today.cachedInputTokens
              )}
            </small>
          </div>
          <p>{copy.usageNote(gateway.usage.today.date, gateway.usage.today.observedSince)}</p>
        </div>

        <div class="sub2api-gateway-observer">
          <span>{copy.observer}</span>
          <span>{observerLabel}</span>
          {gateway.inventory.checkedAt ? <time>{formatTimestamp(gateway.inventory.checkedAt)}</time> : null}
        </div>
        {failureLabel ? <p class="sub2api-gateway-failure">{failureLabel}</p> : null}

        <div class="sub2api-gateway-actions">
          <ActionButton
            class="toolbar-btn"
            pending={props.openConfigPending}
            disabled={props.busy}
            onClick={() => props.onAction("sub2apiGatewayOpenConfig")}
          >
            {copy.openConfig}
          </ActionButton>
          <ActionButton
            class="toolbar-btn"
            pending={props.credentialPending}
            disabled={props.busy || !gateway.baseUrl}
            onClick={() => props.onAction("sub2apiGatewayConfigureCredential")}
          >
            {gateway.credentialPresent ? copy.replaceCredential : copy.setCredential}
          </ActionButton>
          {gateway.inventory.configured ? (
            <ActionButton
              class="toolbar-btn"
              pending={props.observerCredentialPending}
              disabled={props.busy}
              onClick={() => props.onAction("sub2apiGatewayConfigureObserverCredential")}
            >
              {gateway.inventory.credentialPresent ? copy.replaceObserverCredential : copy.setObserverCredential}
            </ActionButton>
          ) : null}
          <ActionButton
            class="toolbar-btn"
            pending={props.refreshPending}
            disabled={props.busy || (!gateway.credentialPresent && !gateway.inventory.credentialPresent)}
            onClick={() => props.onAction("sub2apiGatewayRefresh")}
          >
            {copy.refresh}
          </ActionButton>
          {gateway.isActive ? (
            <ActionButton
              class="toolbar-btn"
              pending={props.deactivatePending}
              disabled={props.busy}
              onClick={() => props.onAction("sub2apiGatewayDeactivate")}
            >
              {copy.useChatGptAuth}
            </ActionButton>
          ) : (
            <ActionButton
              class="toolbar-btn"
              pending={props.activatePending}
              disabled={props.busy || !gateway.credentialPresent || !gateway.baseUrl || !gateway.model}
              onClick={() => props.onAction("sub2apiGatewayActivate")}
            >
              {copy.activate}
            </ActionButton>
          )}
        </div>
      </article>
    </section>
  );
}

function GatewayQuotaMetric(props: {
  quotaLabel: string;
  usageLabel: string;
  pool: DashboardSub2ApiGatewayQuotaPool | undefined;
  usage: DashboardSub2ApiGatewayTokenTotals;
  copy: ReturnType<typeof getGatewayCopy>;
}) {
  return (
    <div class="sub2api-gateway-quota-metric">
      <span>{props.pool ? props.quotaLabel : props.usageLabel}</span>
      <strong>{props.pool ? `${formatPercent(props.pool.remainingPercent)}%` : formatTokens(props.usage.totalTokens)}</strong>
      <small>{props.pool ? props.copy.poolDetail(props.pool) : props.copy.usageWindowDetail(props.usage)}</small>
    </div>
  );
}

function resolveObserverLabel(gateway: NonNullable<DashboardState["sub2apiGateway"]>, copy: ReturnType<typeof getGatewayCopy>): string {
  const inventory = gateway.inventory;
  if (inventory.status === "not_configured") {
    return copy.observerNotConfigured;
  }
  if (inventory.status === "credential_required") {
    return copy.observerCredentialRequired(inventory.group);
  }
  if (inventory.status === "failed") {
    return inventory.message ?? copy.observerFailed;
  }
  if (inventory.status === "healthy") {
    return copy.observerHealthy(inventory.eligibleAccountCount ?? 0, inventory.observedAccountCount ?? 0, inventory.group);
  }
  return copy.observerReady(inventory.group);
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function formatUnits(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function formatGatewayFailureContext(failure: GatewayFailure): string {
  const details = [
    failure.transportCode,
    failure.requestMethod && failure.requestPath ? `${failure.requestMethod} ${failure.requestPath}` : undefined,
    failure.contentLength === undefined ? undefined : `${formatTokens(failure.contentLength)} B`,
    failure.transferEncoding,
    formatTimestamp(failure.at)
  ].filter((detail): detail is string => Boolean(detail));
  return details.length > 0 ? ` · ${details.join(" · ")}` : "";
}

function getGatewayCopy(lang: DashboardState["lang"]) {
  if (lang === "zh") {
    return {
      title: "Sub2API 网关",
      subtitle: "独立本地传输；上游池额度和今日 token 均与 ChatGPT Auth 账号统计隔离。",
      active: "当前传输",
      config: "配置",
      endpoint: "端点",
      model: "模型",
      credential: "下游密钥引用",
      notConfigured: "未配置",
      health: "连接测试",
      healthNotChecked: "尚未测试",
      healthFailed: "连接测试失败",
      healthHealthy: (count?: number) => (count === undefined ? "可连接" : `可连接，暴露 ${count} 个模型`),
      fiveHourPool: "5 小时上游池",
      weeklyPool: "每周上游池",
      fiveHourUsage: "近 5 小时 Gateway Token",
      sevenDayUsage: "近 7 天 Gateway Token",
      todayTokens: "今日 Gateway Token",
      poolDetail: (pool: DashboardSub2ApiGatewayQuotaPool) =>
        `${formatUnits(pool.remainingUnits)} / ${formatUnits(pool.capacityUnits)} 个账号窗口${
          pool.earliestResetAt ? ` · 最早重置 ${formatTimestamp(pool.earliestResetAt)}` : ""
        }`,
      usageWindowDetail: (usage: DashboardSub2ApiGatewayTokenTotals) =>
        usage.observedSince
          ? `Manager 观察自 ${formatTimestamp(usage.observedSince)}；不是上游额度百分比`
          : "Manager 尚未观察到该窗口内的完成 token",
      tokenDetail: (input: number, output: number, cached: number) =>
        `输入 ${formatTokens(input)} · 输出 ${formatTokens(output)} · 缓存 ${formatTokens(cached)}`,
      usageNote: (date: string, observedSince?: number) =>
        `只累计 ${date} 经本地 Gateway 返回 usage 的 Responses token${
          observedSince ? `（本轮观察始于 ${formatTimestamp(observedSince)}）` : ""
        }；不会混入普通 ChatGPT 账号。`,
      observer: "上游额度观察",
      observerNotConfigured: "未配置；不会访问 Sub2API 管理接口",
      observerCredentialRequired: (group?: string) => `分组 ${group ?? "—"} 已配置，等待独立管理观察密钥`,
      observerReady: (group?: string) => `分组 ${group ?? "—"} 等待首次读取`,
      observerHealthy: (eligible: number, observed: number, group?: string) =>
        `分组 ${group ?? "—"}：${observed}/${eligible} 个可调度上游账号有可读额度窗口`,
      observerFailed: "上游额度观察失败",
      lastFailure: (failure: GatewayFailure) =>
        `最近一次转发失败：${failure.origin === "sub2api" ? "Sub2API 上游" : "本地适配器"}${
          failure.statusCode ? ` HTTP ${failure.statusCode}` : ""
        }${formatGatewayFailureContext(failure)}`,
      openConfig: "打开配置",
      setCredential: "保存下游 API Key",
      replaceCredential: "更新下游 API Key",
      setObserverCredential: "保存观察密钥",
      replaceObserverCredential: "更新观察密钥",
      refresh: "测试并刷新",
      activate: "使用 Sub2API",
      useChatGptAuth: "切回 ChatGPT Auth",
      status: {
        configuration_required: "需要配置",
        configuration_error: "配置错误",
        credential_required: "需要 API Key",
        ready: "就绪",
        active: "活动中",
        degraded: "已降级"
      }
    };
  }
  if (lang === "zh-hant") {
    return {
      title: "Sub2API 閘道",
      subtitle: "獨立本機傳輸；上游池額度與今日 token 均與 ChatGPT Auth 帳號統計隔離。",
      active: "目前傳輸",
      config: "設定",
      endpoint: "端點",
      model: "模型",
      credential: "下游金鑰參照",
      notConfigured: "未設定",
      health: "連線測試",
      healthNotChecked: "尚未測試",
      healthFailed: "連線測試失敗",
      healthHealthy: (count?: number) => (count === undefined ? "可連線" : `可連線，暴露 ${count} 個模型`),
      fiveHourPool: "5 小時上游池",
      weeklyPool: "每週上游池",
      fiveHourUsage: "近 5 小時 Gateway Token",
      sevenDayUsage: "近 7 天 Gateway Token",
      todayTokens: "今日 Gateway Token",
      poolDetail: (pool: DashboardSub2ApiGatewayQuotaPool) =>
        `${formatUnits(pool.remainingUnits)} / ${formatUnits(pool.capacityUnits)} 個帳號視窗${
          pool.earliestResetAt ? ` · 最早重設 ${formatTimestamp(pool.earliestResetAt)}` : ""
        }`,
      usageWindowDetail: (usage: DashboardSub2ApiGatewayTokenTotals) =>
        usage.observedSince
          ? `Manager 觀察自 ${formatTimestamp(usage.observedSince)}；不是上游額度百分比`
          : "Manager 尚未觀察到該視窗內的完成 token",
      tokenDetail: (input: number, output: number, cached: number) =>
        `輸入 ${formatTokens(input)} · 輸出 ${formatTokens(output)} · 快取 ${formatTokens(cached)}`,
      usageNote: (date: string, observedSince?: number) =>
        `只累計 ${date} 經本機 Gateway 回傳 usage 的 Responses token${
          observedSince ? `（本輪觀察始於 ${formatTimestamp(observedSince)}）` : ""
        }；不會混入一般 ChatGPT 帳號。`,
      observer: "上游額度觀察",
      observerNotConfigured: "未設定；不會存取 Sub2API 管理介面",
      observerCredentialRequired: (group?: string) => `群組 ${group ?? "—"} 已設定，等待獨立管理觀察金鑰`,
      observerReady: (group?: string) => `群組 ${group ?? "—"} 等待首次讀取`,
      observerHealthy: (eligible: number, observed: number, group?: string) =>
        `群組 ${group ?? "—"}：${observed}/${eligible} 個可排程上游帳號有可讀額度視窗`,
      observerFailed: "上游額度觀察失敗",
      lastFailure: (failure: GatewayFailure) =>
        `最近一次轉送失敗：${failure.origin === "sub2api" ? "Sub2API 上游" : "本機適配器"}${
          failure.statusCode ? ` HTTP ${failure.statusCode}` : ""
        }${formatGatewayFailureContext(failure)}`,
      openConfig: "開啟設定",
      setCredential: "儲存下游 API Key",
      replaceCredential: "更新下游 API Key",
      setObserverCredential: "儲存觀察金鑰",
      replaceObserverCredential: "更新觀察金鑰",
      refresh: "測試並重新整理",
      activate: "使用 Sub2API",
      useChatGptAuth: "切回 ChatGPT Auth",
      status: {
        configuration_required: "需要設定",
        configuration_error: "設定錯誤",
        credential_required: "需要 API Key",
        ready: "就緒",
        active: "使用中",
        degraded: "已降級"
      }
    };
  }
  return {
    title: "Sub2API Gateway",
    subtitle: "A separate local transport. Upstream-pool quota and today's tokens stay isolated from ChatGPT Auth account statistics.",
    active: "Current transport",
    config: "Config",
    endpoint: "Endpoint",
    model: "Model",
    credential: "Downstream credential ref",
    notConfigured: "Not configured",
    health: "Connection test",
    healthNotChecked: "Not checked yet",
    healthFailed: "Connection test failed",
    healthHealthy: (count?: number) => (count === undefined ? "Reachable" : `Reachable, ${count} exposed models`),
    fiveHourPool: "5-hour upstream pool",
    weeklyPool: "Weekly upstream pool",
    fiveHourUsage: "Gateway tokens in 5h",
    sevenDayUsage: "Gateway tokens in 7d",
    todayTokens: "Gateway tokens today",
    poolDetail: (pool: DashboardSub2ApiGatewayQuotaPool) =>
      `${formatUnits(pool.remainingUnits)} / ${formatUnits(pool.capacityUnits)} account windows${
        pool.earliestResetAt ? ` · earliest reset ${formatTimestamp(pool.earliestResetAt)}` : ""
      }`,
    usageWindowDetail: (usage: DashboardSub2ApiGatewayTokenTotals) =>
      usage.observedSince
        ? `Observed by Manager since ${formatTimestamp(usage.observedSince)}; not an upstream quota percentage`
        : "No completed token has been observed in this window",
    tokenDetail: (input: number, output: number, cached: number) =>
      `Input ${formatTokens(input)} · output ${formatTokens(output)} · cached ${formatTokens(cached)}`,
    usageNote: (date: string, observedSince?: number) =>
      `Counts only ${date} Responses usage returned through the local Gateway${
        observedSince ? ` (this observation began ${formatTimestamp(observedSince)})` : ""
      }; ordinary ChatGPT account usage is excluded.`,
    observer: "Upstream quota observer",
    observerNotConfigured: "Not configured; no Sub2API admin endpoint is contacted",
    observerCredentialRequired: (group?: string) => `Group ${group ?? "—"} is configured; a separate observer admin key is required`,
    observerReady: (group?: string) => `Group ${group ?? "—"} is awaiting its first read`,
    observerHealthy: (eligible: number, observed: number, group?: string) =>
      `Group ${group ?? "—"}: readable windows for ${observed}/${eligible} schedulable upstream accounts`,
    observerFailed: "Upstream quota observation failed",
    lastFailure: (failure: GatewayFailure) =>
      `Latest forwarding failure: ${failure.origin === "sub2api" ? "Sub2API upstream" : "local adapter"}${
        failure.statusCode ? ` HTTP ${failure.statusCode}` : ""
      }${formatGatewayFailureContext(failure)}`,
    openConfig: "Open config",
    setCredential: "Store downstream API key",
    replaceCredential: "Update downstream API key",
    setObserverCredential: "Store observer key",
    replaceObserverCredential: "Update observer key",
    refresh: "Test & refresh",
    activate: "Use Sub2API",
    useChatGptAuth: "Use ChatGPT Auth",
    status: {
      configuration_required: "Configuration required",
      configuration_error: "Configuration error",
      credential_required: "API key required",
      ready: "Ready",
      active: "Active",
      degraded: "Degraded"
    }
  };
}

"use strict";

const {
  resolveSub2ApiGatewayConfigPath,
  ensureSub2ApiGatewayConfigFile,
  readSub2ApiGatewayConfigWithDiagnostics
} = require("./config.cjs");
const { Sub2ApiGatewaySecretStore } = require("./secretStore.cjs");
const { fetchSub2ApiGatewayInventory } = require("./observer.cjs");
const { GatewayUsageTracker } = require("./usageTracker.cjs");

const INTEGRATION_ID = "sub2api-gateway";
const SELECTION_STATE_KEY = "sub2apiGateway.selection.v1";
const PROFILE_ID_STATE_KEY = "sub2apiGateway.profile.v1";
const CARD_VISIBILITY_STATE_KEY = "sub2apiGateway.cardVisibility.v1";
const RUNTIME_POLL_MS = 15_000;
const FALLBACK_POLL_MS = 2_000;
const INITIAL_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

class Sub2ApiGatewayIntegration {
  constructor(vscode, context, api) {
    this.vscode = vscode;
    this.context = context;
    this.api = api;
    this.secretStore = new Sub2ApiGatewaySecretStore(context.secrets);
    this.usageTrackers = new Map();
    this.events = new vscode.EventEmitter();
    this.gateway = undefined;
    this.virtualRegistration = undefined;
    this.virtualDescriptorKey = undefined;
    this.profiles = [];
    this.profileId = undefined;
    this.config = undefined;
    this.configError = undefined;
    this.inventoryObserverError = undefined;
    this.health = undefined;
    this.inventory = emptyInventory();
    this.runtimeStatus = undefined;
    this.runtimeError = undefined;
    this.credentialPresent = false;
    this.observerCredentialPresent = false;
    this.selection = "inactive";
    this.cardVisible = false;
    this.runtimeTimer = undefined;
    this.inventoryTimer = undefined;
    this.refreshingInventory = undefined;
    this.fallbackMarker = undefined;
    this.fallbackAttempt = 0;
    this.nextFallbackAt = 0;
    this.disposed = false;
  }

  async initialize() {
    this.gateway = this.api.registerGateway(INTEGRATION_ID);
    this.selection = readSelection(this.context.globalState.get(SELECTION_STATE_KEY));
    this.profileId = readProfileId(this.context.globalState.get(PROFILE_ID_STATE_KEY));
    this.cardVisible = readBoolean(this.context.globalState.get(CARD_VISIBILITY_STATE_KEY), false);
    await this.reloadConfiguration(true);
    await this.syncVirtualAccountRegistration();
    if (this.selection === "active" && this.config) {
      const runtimeStatus = await this.gateway.getStatus().catch(() => undefined);
      if (runtimeStatus && runtimeStatus.active === false && runtimeStatus.route !== "gateway") {
        this.selection = "inactive";
        await this.context.globalState.update(SELECTION_STATE_KEY, this.selection);
      } else {
        await this.resumeSelectedGateway();
      }
    } else if (this.selection === "fallback") {
      await this.refreshRuntimeStatus();
    }
    if (this.config?.inventoryObserver && this.observerCredentialPresent) {
      void this.refreshInventory();
    }
    this.resetTimers();
    this.publish();
  }

  getCardViewModel() {
    const config = this.config;
    const usage = this.getUsageTracker().snapshot();
    const profileActions =
      this.profiles.length > 1
        ? this.profiles.map((profile) => ({
            id: `selectProfile:${profile.id}`,
            label: profile.displayName,
            enabled: profile.id !== this.profileId,
            tooltip: profile.sub2api.baseUrl
          }))
        : [];
    return {
      integrationId: INTEGRATION_ID,
      details: [
        { label: "配置", value: config?.displayName ?? "未配置", emphasis: config ? "normal" : "warning" },
        { label: "下游", value: config?.sub2api.baseUrl ?? "未配置", emphasis: config ? "normal" : "warning" },
        { label: "模型", value: config?.sub2api.model ?? "未配置" },
        {
          label: "下游密钥",
          value: this.credentialPresent ? "已保存（扩展 SecretStorage）" : "需要保存",
          emphasis: this.credentialPresent ? "positive" : "warning"
        }
      ],
      metrics: [
        {
          label: "今日 Token",
          value: formatTokens(usage.today.totalTokens),
          description: usage.today.observedSince ? "仅统计本扩展观察到的完成 token。" : "尚未观察到完成 token。"
        },
        {
          label: "7 天 Token",
          value: formatTokens(usage.sevenDay.totalTokens),
          description: usage.sevenDay.observedSince ? "仅统计本扩展观察到的完成 token。" : "尚未观察到完成 token。"
        }
      ],
      actions: [
        ...profileActions,
        ...(this.selection === "active"
          ? [
              {
                id: "deactivate",
                label: "使用 ChatGPT Auth",
                tooltip: "在安全的 turn/stream 边界切回 ChatGPT Auth"
              }
            ]
          : []),
        {
          id: "configureCredential",
          label: "保存下游密钥",
          enabled: Boolean(config),
          tooltip: "只存入本扩展的 VS Code SecretStorage"
        },
        { id: "refresh", label: "刷新", enabled: true },
        { id: "openConfig", label: "打开配置", enabled: true }
      ]
    };
  }

  async runAction(actionId) {
    if (actionId.startsWith("selectProfile:")) {
      await this.selectProfile(actionId.slice("selectProfile:".length));
      return;
    }
    switch (actionId) {
      case "activate":
        await this.activate();
        return;
      case "deactivate":
        await this.deactivate();
        return;
      case "refresh":
        await this.refresh();
        return;
      case "configureCredential":
        await this.configureCredential();
        return;
      case "configureObserverCredential":
        await this.configureObserverCredential();
        return;
      case "openConfig":
        await this.openConfiguration();
        return;
      default:
        throw new Error("Unsupported Sub2API Gateway action.");
    }
  }

  async activate() {
    await this.reloadConfiguration(true);
    await this.syncVirtualAccountRegistration();
    const config = this.requireConfig();
    const credential = await this.requireCredential(config);
    const result = await this.gateway.activate(toRuntimeConfig(config), credential);
    if (result.error) {
      this.runtimeError = result.error;
      this.publish();
      throw new Error(result.error);
    }
    if (!result.requiresReload) {
      await this.ensureActiveGatewayRoute();
    }
    this.selection = "active";
    await this.context.globalState.update(SELECTION_STATE_KEY, this.selection);
    this.runtimeError = undefined;
    await this.refreshRuntimeStatus();
    this.resetTimers();
    this.publish();
    await promptReloadIfNeeded(this.vscode, result, "Sub2API Gateway 已选择。请重新加载窗口一次以启动本地回环适配器。");
    if (!result.requiresReload) {
      void this.vscode.window.showInformationMessage("Sub2API Gateway 已选择，无需重新加载窗口。");
    }
  }

  async selectProfile(profileId) {
    await this.reloadConfiguration(true);
    const profile = this.profiles.find((candidate) => candidate.id === profileId);
    if (!profile || profile.id === this.profileId) {
      this.publish();
      return;
    }
    this.profileId = profile.id;
    await this.context.globalState.update(PROFILE_ID_STATE_KEY, this.profileId);
    this.health = undefined;
    this.inventory = emptyInventory();
    await this.reloadConfiguration(false);
    await this.syncVirtualAccountRegistration();
    if (this.selection === "active") {
      await this.activate();
    } else {
      this.publish();
    }
  }

  async deactivate(options) {
    const result = await this.gateway.deactivate(options);
    if (result.error) {
      this.runtimeError = result.error;
      this.publish();
      throw new Error(result.error);
    }
    this.selection = "inactive";
    await this.context.globalState.update(SELECTION_STATE_KEY, this.selection);
    this.runtimeStatus = undefined;
    this.runtimeError = undefined;
    this.resetTimers();
    this.publish();
    await promptReloadIfNeeded(this.vscode, result, "已切换回 ChatGPT Auth。请重新加载窗口一次以应用新的传输。");
    if (!result.requiresReload) {
      void this.vscode.window.showInformationMessage("已切换回 ChatGPT Auth，无需重新加载窗口。");
    }
    return result;
  }

  async refresh() {
    await this.reloadConfiguration(true);
    await this.syncVirtualAccountRegistration();
    const config = this.config;
    if (!config) {
      this.publish();
      return;
    }
    const credential = normalizeDownstreamCredential(await this.secretStore.get(config.sub2api.credentialRef));
    this.credentialPresent = Boolean(credential);
    this.health = credential
      ? await checkGatewayHealth(config, credential)
      : { kind: "credential_required", message: "需要保存下游密钥。" };
    await this.refreshRuntimeStatus();
    await this.refreshInventory();
    this.resetTimers();
    this.publish();
  }

  async configureCredential() {
    await this.reloadConfiguration(true);
    const config = this.requireConfig();
    const credential = await this.vscode.window.showInputBox({
      title: "Sub2API Gateway API Key",
      prompt: `保存 '${config.sub2api.credentialRef}' 到本扩展 SecretStorage；请输入可调用 /v1 的 API Key，不要使用管理端登录令牌。`,
      password: true,
      ignoreFocusOut: true,
      validateInput: validateCredential
    });
    if (credential === undefined) {
      return;
    }
    const normalizedCredential = normalizeDownstreamCredential(credential);
    await this.secretStore.store(config.sub2api.credentialRef, normalizedCredential);
    this.credentialPresent = true;
    if (this.selection === "active" && this.gateway.isConfigured()) {
      await this.gateway.configureCredential(normalizedCredential);
    }
    this.publish();
  }

  async configureObserverCredential() {
    await this.reloadConfiguration(true);
    const observer = this.requireConfig().inventoryObserver;
    if (!observer) {
      throw new Error("Add inventoryObserver to the Sub2API Gateway configuration first.");
    }
    const credential = await this.vscode.window.showInputBox({
      title: "Sub2API read-only inventory key",
      prompt: `保存 '${observer.credentialRef}' 到本扩展 SecretStorage；它只用于 GET 请求。`,
      password: true,
      ignoreFocusOut: true,
      validateInput: validateCredential
    });
    if (credential === undefined) {
      return;
    }
    await this.secretStore.store(observer.credentialRef, credential.trim());
    this.observerCredentialPresent = true;
    this.inventory = emptyInventory(observer, true);
    await this.refreshInventory();
    this.resetTimers();
    this.publish();
  }

  async openConfiguration() {
    const configPath = resolveSub2ApiGatewayConfigPath(this.context.globalStorageUri.fsPath);
    await ensureSub2ApiGatewayConfigFile(configPath);
    const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(configPath));
    await this.vscode.window.showTextDocument(document, { preview: false });
  }

  async reloadConfiguration(createTemplateIfMissing) {
    this.config = undefined;
    this.profiles = [];
    this.configError = undefined;
    this.inventoryObserverError = undefined;
    try {
      const configPath = resolveSub2ApiGatewayConfigPath(this.context.globalStorageUri.fsPath);
      if (createTemplateIfMissing) {
        await ensureSub2ApiGatewayConfigFile(configPath);
      }
      const result = await readSub2ApiGatewayConfigWithDiagnostics(configPath);
      this.profiles = result.profiles ?? [result.config];
      const selected = this.profiles.find((profile) => profile.id === this.profileId) ?? this.profiles[0];
      this.profileId = selected.id;
      this.config = selected;
      this.inventoryObserverError = selected.inventoryObserverError ?? result.inventoryObserverError;
      await this.context.globalState.update(PROFILE_ID_STATE_KEY, this.profileId);
      this.credentialPresent = Boolean(await this.secretStore.get(this.config.sub2api.credentialRef));
      this.observerCredentialPresent = Boolean(
        this.config.inventoryObserver && (await this.secretStore.get(this.config.inventoryObserver.credentialRef))
      );
      this.inventory = normalizeInventory(
        this.inventory,
        this.config.inventoryObserver,
        this.observerCredentialPresent
      );
    } catch (error) {
      this.configError = safeError(error, "Gateway 配置不可用。");
      this.profileId = undefined;
      this.credentialPresent = false;
      this.observerCredentialPresent = false;
      this.inventory = emptyInventory();
    }
  }

  async syncVirtualAccountRegistration() {
    if (typeof this.api.registerVirtualAccount !== "function" || !this.config) {
      return;
    }
    const descriptor = {
      integrationId: INTEGRATION_ID,
      baseUrl: this.config.sub2api.baseUrl,
      model: this.config.sub2api.model,
      credentialRef: this.config.sub2api.credentialRef
    };
    const key = JSON.stringify({ profileId: this.profileId, displayName: this.config.displayName, descriptor });
    if (key === this.virtualDescriptorKey && this.virtualRegistration) {
      return;
    }
    this.virtualRegistration?.dispose();
    this.virtualRegistration = await this.api.registerVirtualAccount({
      id: INTEGRATION_ID,
      displayName: this.config.displayName || "Sub2API Gateway",
      descriptor,
      getCardView: () => this.getCardViewModel(),
      runCardAction: (actionId) => this.runAction(actionId),
      onDidChange: this.events.event,
      deactivate: (options) => this.deactivate(options),
      setting: {
        id: "sub2api-gateway-card-visible",
        title: "显示 Sub2API 账号卡片",
        description: "仅控制已保存账号列表中的虚拟账号卡片是否显示，不会切换当前路由。",
        getEnabled: () => this.cardVisible,
        setEnabled: async (enabled) => {
          if (this.cardVisible === enabled) {
            return;
          }
          this.cardVisible = enabled;
          await this.context.globalState.update(CARD_VISIBILITY_STATE_KEY, enabled);
          this.publish();
        }
      },
      activate: async (options) => {
        await this.reloadConfiguration(true);
        const config = this.requireConfig();
        const credential = await this.requireCredential(config);
        const result = await this.gateway.activate(toRuntimeConfig(config), credential, options);
        if (!result.error) {
          if (!result.requiresReload) {
            await this.ensureActiveGatewayRoute();
          }
          this.selection = "active";
          await this.context.globalState.update(SELECTION_STATE_KEY, this.selection);
          this.runtimeError = undefined;
          await this.refreshRuntimeStatus();
          this.resetTimers();
          this.publish();
        }
        return result;
      }
    });
    this.virtualDescriptorKey = key;
    this.publish();
  }

  async resumeSelectedGateway() {
    const config = this.config;
    if (!config) {
      return;
    }
    const credential = normalizeDownstreamCredential(await this.secretStore.get(config.sub2api.credentialRef));
    this.credentialPresent = Boolean(credential);
    try {
      const result = await this.gateway.activate(toRuntimeConfig(config), credential);
      this.runtimeError = result.error;
      if (result.error) {
        this.selection = "inactive";
        await this.context.globalState.update(SELECTION_STATE_KEY, this.selection);
      } else if (!result.requiresReload) {
        try {
          await this.ensureActiveGatewayRoute();
        } catch (error) {
          this.selection = "inactive";
          await this.context.globalState.update(SELECTION_STATE_KEY, this.selection);
          this.runtimeError = safeError(error, "Gateway runtime 未就绪。");
        }
      }
    } catch (error) {
      this.runtimeError = safeError(error, "Gateway runtime 未就绪。");
    }
    await this.refreshRuntimeStatus();
  }

  async refreshRuntimeStatus() {
    if (!this.gateway || this.selection === "inactive") {
      this.runtimeStatus = undefined;
      return;
    }
    try {
      const status = await this.gateway.getStatus();
      this.runtimeStatus = status;
      await this.getUsageTracker().observe(status);
      this.runtimeError =
        this.selection === "active" && (status.active !== true || status.route !== "gateway")
          ? "Gateway 实际路由未激活；请重新选择 Gateway。"
          : status.ready || status.route === "chatgpt"
            ? undefined
            : "Gateway 正在等待下游密钥。";
      await this.observeQuotaExhaustion(status);
    } catch (error) {
      this.runtimeError = safeError(error, "Gateway runtime 未就绪。");
    }
    this.publish();
  }

  getUsageTracker() {
    const sourceKey = this.profileId ?? "default";
    let tracker = this.usageTrackers.get(sourceKey);
    if (!tracker) {
      tracker = new GatewayUsageTracker(this.context.globalState, undefined, sourceKey);
      tracker.load();
      this.usageTrackers.set(sourceKey, tracker);
    }
    return tracker;
  }

  async observeQuotaExhaustion(status) {
    const config = this.config;
    const count = Number.isSafeInteger(status?.quotaExhaustionCount) ? status.quotaExhaustionCount : 0;
    if (!config?.autoFallbackToChatGpt || status?.route !== "gateway" || count <= 0 || !status.instanceId) {
      return;
    }
    const marker = `${status.instanceId}:${count}`;
    if (this.fallbackMarker !== marker) {
      this.fallbackMarker = marker;
      this.fallbackAttempt = 0;
      this.nextFallbackAt = 0;
    }
    if (Date.now() < this.nextFallbackAt) {
      return;
    }
    try {
      const result = await this.gateway.fallbackToChatGpt();
      if (result.status === "switched") {
        this.selection = "fallback";
        await this.context.globalState.update(SELECTION_STATE_KEY, this.selection);
        this.nextFallbackAt = Number.POSITIVE_INFINITY;
        this.runtimeError = undefined;
        return;
      }
      this.scheduleFallbackRetry();
    } catch {
      this.scheduleFallbackRetry();
    }
  }

  scheduleFallbackRetry() {
    const delay = Math.min(INITIAL_RETRY_MS * 2 ** this.fallbackAttempt, MAX_RETRY_MS);
    this.fallbackAttempt += 1;
    this.nextFallbackAt = Date.now() + delay;
    this.runtimeError = `已确认 Gateway 额度耗尽；ChatGPT Auth 回退尚未完成，将在 ${Math.ceil(delay / 1000)} 秒后安全重试。`;
  }

  async refreshInventory() {
    if (this.refreshingInventory) {
      return this.refreshingInventory;
    }
    const observer = this.config?.inventoryObserver;
    if (!observer) {
      this.inventory = emptyInventory();
      return;
    }
    const credential = await this.secretStore.get(observer.credentialRef);
    this.observerCredentialPresent = Boolean(credential);
    if (!credential) {
      this.inventory = emptyInventory(observer, false);
      return;
    }
    const task = fetchSub2ApiGatewayInventory(observer, credential)
      .then((inventory) => {
        this.inventory = inventory;
      })
      .catch(() => {
        this.inventory = { ...emptyInventory(observer, true), status: "error" };
      })
      .finally(() => {
        if (this.refreshingInventory === task) {
          this.refreshingInventory = undefined;
        }
        this.publish();
      });
    this.refreshingInventory = task;
    return task;
  }

  async ensureActiveGatewayRoute() {
    const status = await this.gateway.getStatus();
    if (status.active !== true || status.route !== "gateway") {
      this.runtimeError = "Gateway 实际路由未激活；请重新选择 Gateway。";
      this.publish();
      throw new Error(this.runtimeError);
    }
    return status;
  }

  resetTimers() {
    clearInterval(this.runtimeTimer);
    clearInterval(this.inventoryTimer);
    this.runtimeTimer = undefined;
    this.inventoryTimer = undefined;
    if (this.selection !== "inactive") {
      const interval = this.config?.autoFallbackToChatGpt ? FALLBACK_POLL_MS : RUNTIME_POLL_MS;
      this.runtimeTimer = setInterval(() => void this.refreshRuntimeStatus(), interval);
    }
    if (this.config?.inventoryObserver && this.observerCredentialPresent) {
      this.inventoryTimer = setInterval(
        () => void this.refreshInventory(),
        this.config.inventoryObserver.refreshSeconds * 1000
      );
    }
  }

  requireConfig() {
    if (!this.config) {
      throw new Error(this.configError ?? "Gateway configuration is unavailable.");
    }
    return this.config;
  }

  async requireCredential(config) {
    const credential = normalizeDownstreamCredential(await this.secretStore.get(config.sub2api.credentialRef));
    this.credentialPresent = Boolean(credential);
    if (!credential) {
      throw new Error("Save the Sub2API downstream key before activating this Gateway.");
    }
    return credential;
  }

  resolveStatus() {
    if (this.configError) {
      return { kind: "error", message: this.configError };
    }
    if (!this.config) {
      return { kind: "inactive", message: "尚未配置" };
    }
    if (this.selection === "fallback") {
      return { kind: "ready", message: "ChatGPT Auth 回退已激活；可手动重新选择 Gateway。" };
    }
    if (this.runtimeError) {
      return { kind: "warning", message: this.runtimeError };
    }
    if (this.gateway?.isActive?.() === true) {
      if (this.inventoryObserverError) {
        return {
          kind: "warning",
          message: `本地回环 Gateway 已激活；只读库存观察配置有误：${this.inventoryObserverError}`
        };
      }
      return { kind: "active", message: this.health?.message ?? "本地回环 Gateway 已激活。" };
    }
    if (!this.credentialPresent) {
      return { kind: "warning", message: "需要保存下游密钥。" };
    }
    if (this.inventoryObserverError) {
      return { kind: "warning", message: `Gateway 可用；只读库存观察配置有误：${this.inventoryObserverError}` };
    }
    return { kind: "ready", message: this.health?.message ?? "可选择 Gateway。" };
  }

  publish() {
    if (!this.disposed) {
      this.events.fire();
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearInterval(this.runtimeTimer);
    clearInterval(this.inventoryTimer);
    this.virtualRegistration?.dispose();
    this.gateway?.dispose();
    this.events.dispose();
  }
}

function toRuntimeConfig(config) {
  return {
    displayName: config.displayName,
    baseUrl: config.sub2api.baseUrl,
    model: config.sub2api.model,
    autoFallbackToChatGpt: config.autoFallbackToChatGpt
  };
}

async function checkGatewayHealth(config, credential, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(`${config.sub2api.baseUrl}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${credential}` },
      signal: controller.signal
    });
    if (response.ok) {
      return { kind: "healthy", message: "下游健康检查成功。" };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        kind: "warning",
        message: `下游拒绝 API Key（HTTP ${response.status}）。请保存可调用 /v1 的普通 API Key；管理端登录令牌不能用于此处。`
      };
    }
    return { kind: "warning", message: `下游健康检查返回 HTTP ${response.status}。` };
  } catch {
    return { kind: "error", message: "下游健康检查无法连接。" };
  } finally {
    clearTimeout(timer);
  }
}

function validateCredential(value) {
  const credential = normalizeDownstreamCredential(value);
  if (!credential) {
    return "密钥不能为空。";
  }
  return credential.length > 4096 ? "密钥长度超过允许范围。" : undefined;
}

function normalizeDownstreamCredential(value) {
  const credential = typeof value === "string" ? value.trim() : "";
  return credential.replace(/^Bearer\s+/iu, "").trim();
}

async function promptReloadIfNeeded(vscode, result, message) {
  if (!result?.requiresReload) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(message, "重新加载窗口", "稍后");
  if (choice === "重新加载窗口") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

function readSelection(value) {
  return value === "active" || value === "fallback" ? value : "inactive";
}

function readProfileId(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function readBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function emptyInventory(observer, credentialPresent = false) {
  return {
    status: observer ? (credentialPresent ? "pending" : "credential_required") : "not_configured",
    group: observer?.group,
    credentialPresent,
    eligibleAccountCount: 0,
    observedAccountCount: 0,
    fiveHour: undefined,
    weekly: undefined
  };
}

function normalizeInventory(inventory, observer, credentialPresent) {
  if (!observer) {
    return emptyInventory();
  }
  if (!credentialPresent) {
    return emptyInventory(observer, false);
  }
  return inventory?.group === observer.group ? inventory : emptyInventory(observer, true);
}

function formatTokens(value) {
  const tokens = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}K`;
  }
  return new Intl.NumberFormat().format(tokens);
}

function safeError(error, fallback) {
  if (error instanceof Error && error.message && error.message.length <= 240) {
    return error.message;
  }
  return fallback;
}

module.exports = {
  INTEGRATION_ID,
  Sub2ApiGatewayIntegration,
  checkGatewayHealth,
  emptyInventory,
  normalizeDownstreamCredential
};

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { DashboardSub2ApiGatewayViewModel } from "../../domain/dashboard/types";
import {
  type Sub2ApiGatewayRuntimeConfig,
  type HotSwitchSetupResult,
  type CodexHotSwitchRuntime
} from "../../codex/hotSwitchRuntime";
import { getSub2ApiGatewayConfigFile } from "../../infrastructure/config/extensionSettings";
import {
  ensureSub2ApiGatewayConfigFile,
  readSub2ApiGatewayConfig,
  resolveSub2ApiGatewayConfigPath,
  type ResolvedSub2ApiGatewayConfig
} from "./config";
import { fetchSub2ApiGatewayInventory } from "./observer";
import { Sub2ApiGatewaySecretStore } from "./secretStore";

const HEALTH_CHECK_TIMEOUT_MS = 8_000;
const MAX_API_KEY_LENGTH = 4_096;
const USAGE_STATE_KEY = "sub2apiGateway.usage.v3";
const PREVIOUS_USAGE_STATE_KEY = "sub2apiGateway.usage.v2";
const LEGACY_USAGE_STATE_KEY = "sub2apiGateway.usage.v1";
const MAX_REMEMBERED_RUNTIME_INSTANCES = 8;
const RUNTIME_USAGE_POLL_MS = 15_000;
const TOKEN_BUCKET_MS = 5 * 60 * 1_000;
const FIVE_HOUR_USAGE_WINDOW_MS = 5 * 60 * 60 * 1_000;
const SEVEN_DAY_USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_TOKEN_BUCKETS = Math.ceil(SEVEN_DAY_USAGE_WINDOW_MS / TOKEN_BUCKET_MS) + 2;
const RUNTIME_DIRECTORY = "hot-switch-runtime";
const GATEWAY_DIAGNOSTIC_FILE = "sub2api-gateway-last-failure.json";
const GATEWAY_DIAGNOSTIC_SCHEMA = "codex-accounts-sub2api-gateway-diagnostic/v1";
const MAX_GATEWAY_DIAGNOSTIC_CONTENT_LENGTH = 512 * 1024 * 1024;

type GatewayHealth = DashboardSub2ApiGatewayViewModel["health"];
type GatewayUsageTotals = DashboardSub2ApiGatewayViewModel["usage"];
type GatewayTodayUsage = GatewayUsageTotals["today"];
type GatewayWindowUsage = GatewayUsageTotals["windows"]["fiveHour"];
type GatewayInventory = DashboardSub2ApiGatewayViewModel["inventory"];

type GatewayUsageRuntimeCheckpoint = {
  requestCount: number;
  successfulRequestCount: number;
  failedRequestCount: number;
  usageDay: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

type PersistedGatewayUsage = {
  version: 3;
  totals: GatewayUsageTotals;
  checkpoints: Record<string, GatewayUsageRuntimeCheckpoint>;
  tokenBuckets: GatewayTokenBucket[];
};

type GatewayTokenBucket = {
  startAt: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

export class Sub2ApiGatewayController implements vscode.Disposable {
  private readonly secretStore: Sub2ApiGatewaySecretStore;
  private config: ResolvedSub2ApiGatewayConfig | undefined;
  private configError: string | undefined;
  private configFile = getSub2ApiGatewayConfigFile();
  private credentialPresent = false;
  private observerCredentialPresent = false;
  private health: GatewayHealth | undefined;
  private runtimeError: string | undefined;
  private usage: GatewayUsageTotals = emptyUsageTotals();
  private tokenBuckets: GatewayTokenBucket[] = [];
  private persistedDiagnosticFailure: GatewayUsageTotals["lastFailure"] | undefined;
  private inventory: GatewayInventory = emptyInventory();
  private runtimeUsageTimer: ReturnType<typeof setInterval> | undefined;
  private inventoryRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private inventoryRefreshPromise: Promise<void> | undefined;
  private initialized = false;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: CodexHotSwitchRuntime,
    private readonly onDidChange: () => void = () => undefined
  ) {
    this.secretStore = new Sub2ApiGatewaySecretStore(context.secrets);
  }

  async initialize(): Promise<void> {
    if (this.disposed || this.initialized) {
      return;
    }
    this.initialized = true;
    const persistedUsage = this.loadPersistedUsage();
    this.usage = persistedUsage.totals;
    this.tokenBuckets = persistedUsage.tokenBuckets;
    await this.refreshPersistedFailure();
    await this.reloadConfiguration(true);
    if (this.runtime.isSub2ApiGatewayActive()) {
      await this.applyCredentialToActiveRuntime();
      await this.refreshRuntimeUsage();
      this.resetRuntimeUsagePolling();
    }
    if (this.config?.inventoryObserver && this.observerCredentialPresent) {
      void this.refreshInventory();
    }
    this.publishChange();
  }

  getViewModel(): DashboardSub2ApiGatewayViewModel {
    const isActive = this.runtime.isSub2ApiGatewayActive();
    const status = this.resolveStatus(isActive);
    const lastFailure = latestGatewayFailure(this.usage.lastFailure, this.persistedDiagnosticFailure);
    const usage = withCurrentWindowUsage(lastFailure ? { ...this.usage, lastFailure } : this.usage, this.tokenBuckets);
    return {
      displayName: this.config?.displayName ?? "Sub2API Gateway",
      configFile: this.configFile,
      baseUrl: this.config?.sub2api.baseUrl,
      model: this.config?.sub2api.model,
      credentialRef: this.config?.sub2api.credentialRef,
      credentialPresent: this.credentialPresent,
      isActive,
      status: status.kind,
      statusMessage: status.message,
      health: this.health,
      usage,
      inventory: this.inventory
    };
  }

  async activate(): Promise<HotSwitchSetupResult> {
    await this.reloadConfiguration(true);
    const config = this.requireConfig();
    const apiKey = await this.requireCredential(config);
    const result = await this.runtime.activateSub2ApiGateway(toRuntimeConfig(config));
    if (result.error) {
      this.runtimeError = result.error;
      this.publishChange();
      throw new Error(result.error);
    }
    this.runtimeError = undefined;
    if (!result.requiresReload) {
      await this.runtime.configureSub2ApiGatewayCredential(apiKey);
      await this.refreshRuntimeUsage();
      this.resetRuntimeUsagePolling();
    }
    this.publishChange();
    await promptWindowReloadIfNeeded(
      result,
      "The Sub2API Gateway is selected. Reload this VS Code window once to start its local loopback adapter."
    );
    return result;
  }

  async deactivate(): Promise<HotSwitchSetupResult> {
    // The outgoing adapter exits during this operation. Read its synchronous,
    // credential-free failure record first so the Dashboard remains useful
    // after the user returns to ChatGPT Auth.
    await this.refreshPersistedFailure();
    const result = await this.runtime.deactivateSub2ApiGateway();
    if (result.error) {
      this.runtimeError = result.error;
      this.publishChange();
      throw new Error(result.error);
    }
    this.runtimeError = undefined;
    this.stopRuntimeUsagePolling();
    this.publishChange();
    await promptWindowReloadIfNeeded(
      result,
      "Switched the next Codex runtime back to ChatGPT Auth. Reload this VS Code window once to apply it."
    );
    return result;
  }

  async refresh(): Promise<void> {
    await this.refreshPersistedFailure();
    await this.reloadConfiguration(true);
    const config = this.config;
    if (!config) {
      this.publishChange();
      return;
    }
    const apiKey = await this.secretStore.get(config.sub2api.credentialRef);
    this.credentialPresent = Boolean(apiKey);
    if (apiKey) {
      this.health = await checkGatewayHealth(config, apiKey);
      if (this.runtime.isSub2ApiGatewayActive()) {
        await this.applyCredentialToActiveRuntime();
        await this.refreshRuntimeUsage();
        this.resetRuntimeUsagePolling();
      }
    }
    await this.refreshInventory();
    this.publishChange();
  }

  async configureCredential(): Promise<boolean> {
    await this.reloadConfiguration(true);
    const config = this.requireConfig();
    const apiKey = await vscode.window.showInputBox({
      title: "Sub2API Gateway API Key",
      prompt: `Store the downstream key for credential reference '${config.sub2api.credentialRef}' in VS Code SecretStorage.`,
      password: true,
      ignoreFocusOut: true,
      validateInput: validateApiKeyInput
    });
    if (apiKey === undefined) {
      return false;
    }
    await this.secretStore.set(config.sub2api.credentialRef, apiKey.trim());
    this.credentialPresent = true;
    if (this.runtime.isSub2ApiGatewayActive()) {
      await this.applyCredentialToActiveRuntime();
      await this.refreshRuntimeUsage();
      this.resetRuntimeUsagePolling();
    }
    this.publishChange();
    return true;
  }

  async configureObserverCredential(): Promise<boolean> {
    await this.reloadConfiguration(true);
    const config = this.requireConfig();
    const observer = config.inventoryObserver;
    if (!observer) {
      throw new Error("Add inventoryObserver to the Sub2API Gateway config before storing an observer credential");
    }
    const adminApiKey = await vscode.window.showInputBox({
      title: "Sub2API Inventory Observer Admin Key",
      prompt:
        `Store the separate admin observer key '${observer.credentialRef}' in VS Code SecretStorage. ` +
        "The extension will use it only for read-only GET inventory and quota requests.",
      password: true,
      ignoreFocusOut: true,
      validateInput: validateApiKeyInput
    });
    if (adminApiKey === undefined) {
      return false;
    }
    await this.secretStore.set(observer.credentialRef, adminApiKey.trim());
    this.observerCredentialPresent = true;
    this.inventory = emptyInventory(observer, true);
    this.resetInventoryRefreshTimer();
    await this.refreshInventory();
    this.publishChange();
    return true;
  }

  async openConfiguration(): Promise<void> {
    await this.reloadConfiguration(true);
    const configPath = resolveSub2ApiGatewayConfigPath(
      this.context.globalStorageUri.fsPath,
      getSub2ApiGatewayConfigFile()
    );
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  /**
   * Disabling the feature must not leave a Gateway provider selected for the
   * next app-server process. This does not destroy the saved SecretStorage key.
   */
  async disableFeature(): Promise<void> {
    if (this.runtime.isSub2ApiGatewayActive()) {
      const result = await this.runtime.deactivateSub2ApiGateway();
      if (!result.error) {
        await promptWindowReloadIfNeeded(
          result,
          "Sub2API Gateway was disabled. Reload this VS Code window once to restore ChatGPT Auth transport."
        );
      }
    }
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopRuntimeUsagePolling();
    this.stopInventoryRefreshTimer();
  }

  private async reloadConfiguration(createTemplateIfMissing: boolean): Promise<void> {
    const previousObserver = observerSignature(this.config?.inventoryObserver);
    this.configFile = getSub2ApiGatewayConfigFile();
    this.config = undefined;
    this.configError = undefined;
    this.health = undefined;
    try {
      const configPath = resolveSub2ApiGatewayConfigPath(this.context.globalStorageUri.fsPath, this.configFile);
      if (createTemplateIfMissing) {
        await ensureSub2ApiGatewayConfigFile(configPath);
      }
      this.config = await readSub2ApiGatewayConfig(configPath);
      this.credentialPresent = Boolean(await this.secretStore.get(this.config.sub2api.credentialRef));
      const observer = this.config.inventoryObserver;
      this.observerCredentialPresent = Boolean(observer && (await this.secretStore.get(observer.credentialRef)));
      if (previousObserver !== observerSignature(observer)) {
        this.inventory = emptyInventory(observer, this.observerCredentialPresent);
      } else {
        this.inventory = normalizeInventoryForConfig(this.inventory, observer, this.observerCredentialPresent);
      }
      this.runtimeError = undefined;
    } catch (error) {
      this.configError = describeGatewayError(error);
      this.credentialPresent = false;
      this.observerCredentialPresent = false;
      this.inventory = emptyInventory();
      this.runtimeError = undefined;
    }
    this.resetInventoryRefreshTimer();
  }

  private requireConfig(): ResolvedSub2ApiGatewayConfig {
    if (!this.config) {
      throw new Error(this.configError ?? "The Sub2API Gateway configuration is unavailable");
    }
    return this.config;
  }

  private async requireCredential(config: ResolvedSub2ApiGatewayConfig): Promise<string> {
    const apiKey = await this.secretStore.get(config.sub2api.credentialRef);
    this.credentialPresent = Boolean(apiKey);
    if (!apiKey) {
      throw new Error("Set the Sub2API Gateway API key before activating this transport");
    }
    return apiKey;
  }

  private async applyCredentialToActiveRuntime(): Promise<void> {
    const config = this.config;
    if (!config || !this.runtime.isSub2ApiGatewayActive()) {
      return;
    }
    const apiKey = await this.secretStore.get(config.sub2api.credentialRef);
    this.credentialPresent = Boolean(apiKey);
    if (!apiKey) {
      this.runtimeError = "The Gateway runtime is waiting for its API key";
      return;
    }
    try {
      await this.runtime.configureSub2ApiGatewayCredential(apiKey);
      this.runtimeError = undefined;
    } catch (error) {
      this.runtimeError = describeGatewayError(error);
    }
  }

  private async refreshRuntimeUsage(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.refreshPersistedFailure();
    if (!this.runtime.isSub2ApiGatewayActive()) {
      return;
    }
    try {
      const status = await this.runtime.getSub2ApiGatewayStatus();
      if (status.instanceId) {
        await this.mergeRuntimeUsage(status);
      }
      this.runtimeError = status.ready ? undefined : "The Gateway adapter is waiting for its API key";
    } catch (error) {
      this.runtimeError = describeGatewayError(error);
    }
  }

  private async refreshInventory(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.inventoryRefreshPromise) {
      await this.inventoryRefreshPromise;
      return;
    }
    this.inventoryRefreshPromise = this.refreshInventoryInternal();
    try {
      await this.inventoryRefreshPromise;
    } finally {
      this.inventoryRefreshPromise = undefined;
    }
  }

  private async refreshInventoryInternal(): Promise<void> {
    const observer = this.config?.inventoryObserver;
    if (!observer) {
      this.inventory = emptyInventory();
      this.publishChange();
      return;
    }
    const adminApiKey = await this.secretStore.get(observer.credentialRef);
    this.observerCredentialPresent = Boolean(adminApiKey);
    if (!adminApiKey) {
      this.inventory = emptyInventory(observer, false);
      this.publishChange();
      return;
    }
    try {
      const snapshot = await fetchSub2ApiGatewayInventory(observer, adminApiKey);
      this.inventory = {
        configured: true,
        credentialPresent: true,
        status: "healthy",
        ...snapshot
      };
    } catch (error) {
      this.inventory = {
        configured: true,
        credentialPresent: true,
        status: "failed",
        group: observer.group,
        checkedAt: Date.now(),
        message: describeGatewayError(error)
      };
    }
    this.publishChange();
  }

  private async mergeRuntimeUsage(
    status: Awaited<ReturnType<CodexHotSwitchRuntime["getSub2ApiGatewayStatus"]>>
  ): Promise<void> {
    if (!status.instanceId) {
      return;
    }
    const persisted = this.loadPersistedUsage();
    const nextCheckpoint = toRuntimeCheckpoint(status);
    const previous = persisted.checkpoints[status.instanceId];
    const sameUsageDay = previous?.usageDay === nextCheckpoint.usageDay;
    const countDelta = {
      requestCount: Math.max(0, nextCheckpoint.requestCount - (previous?.requestCount ?? 0)),
      successfulRequestCount: Math.max(
        0,
        nextCheckpoint.successfulRequestCount - (previous?.successfulRequestCount ?? 0)
      ),
      failedRequestCount: Math.max(0, nextCheckpoint.failedRequestCount - (previous?.failedRequestCount ?? 0))
    };
    const tokenDelta = {
      inputTokens: sameUsageDay ? Math.max(0, nextCheckpoint.inputTokens - (previous?.inputTokens ?? 0)) : nextCheckpoint.inputTokens,
      outputTokens: sameUsageDay
        ? Math.max(0, nextCheckpoint.outputTokens - (previous?.outputTokens ?? 0))
        : nextCheckpoint.outputTokens,
      cachedInputTokens: sameUsageDay
        ? Math.max(0, nextCheckpoint.cachedInputTokens - (previous?.cachedInputTokens ?? 0))
        : nextCheckpoint.cachedInputTokens,
      reasoningTokens: sameUsageDay
        ? Math.max(0, nextCheckpoint.reasoningTokens - (previous?.reasoningTokens ?? 0))
        : nextCheckpoint.reasoningTokens,
      totalTokens: sameUsageDay ? Math.max(0, nextCheckpoint.totalTokens - (previous?.totalTokens ?? 0)) : nextCheckpoint.totalTokens
    };
    const currentToday =
      persisted.totals.today.date === nextCheckpoint.usageDay
        ? persisted.totals.today
        : emptyTodayUsage(nextCheckpoint.usageDay);
    const runtimeFailure = readRuntimeFailure(status);
    persisted.tokenBuckets = appendTokenDelta(persisted.tokenBuckets, tokenDelta);
    persisted.totals = withCurrentWindowUsage({
      requestCount: persisted.totals.requestCount + countDelta.requestCount,
      successfulRequestCount: persisted.totals.successfulRequestCount + countDelta.successfulRequestCount,
      failedRequestCount: persisted.totals.failedRequestCount + countDelta.failedRequestCount,
      lastRequestAt: maximumTimestamp(persisted.totals.lastRequestAt, status.lastRequestAt),
      observedAt: Date.now(),
      today: {
        date: nextCheckpoint.usageDay,
        inputTokens: currentToday.inputTokens + tokenDelta.inputTokens,
        outputTokens: currentToday.outputTokens + tokenDelta.outputTokens,
        cachedInputTokens: currentToday.cachedInputTokens + tokenDelta.cachedInputTokens,
        reasoningTokens: currentToday.reasoningTokens + tokenDelta.reasoningTokens,
        totalTokens: currentToday.totalTokens + tokenDelta.totalTokens,
        observedSince: minimumTimestamp(currentToday.observedSince, status.startedAt)
      },
      windows: persisted.totals.windows,
      ...(shouldReplaceRuntimeFailure(persisted.totals.lastFailure, runtimeFailure) ? { lastFailure: runtimeFailure } : {})
    }, persisted.tokenBuckets);
    persisted.checkpoints[status.instanceId] = nextCheckpoint;
    const instanceIds = Object.keys(persisted.checkpoints);
    while (instanceIds.length > MAX_REMEMBERED_RUNTIME_INSTANCES) {
      const oldest = instanceIds.shift();
      if (oldest) {
        delete persisted.checkpoints[oldest];
      }
    }
    await this.context.globalState.update(USAGE_STATE_KEY, persisted);
    this.usage = persisted.totals;
    this.tokenBuckets = persisted.tokenBuckets;
  }

  private loadPersistedUsage(): PersistedGatewayUsage {
    return normalizePersistedUsage(
      this.context.globalState.get<unknown>(USAGE_STATE_KEY),
      this.context.globalState.get<unknown>(PREVIOUS_USAGE_STATE_KEY),
      this.context.globalState.get<unknown>(LEGACY_USAGE_STATE_KEY)
    );
  }

  private async refreshPersistedFailure(): Promise<void> {
    const failure = await readPersistedGatewayFailure(this.context.globalStorageUri.fsPath);
    if (shouldReplaceRuntimeFailure(this.persistedDiagnosticFailure, failure)) {
      this.persistedDiagnosticFailure = failure;
    }
  }

  private resetRuntimeUsagePolling(): void {
    this.stopRuntimeUsagePolling();
    if (this.disposed || !this.runtime.isSub2ApiGatewayActive() || this.runtimeError) {
      return;
    }
    this.runtimeUsageTimer = setInterval(() => {
      void this.refreshRuntimeUsage().then(() => this.publishChange());
    }, RUNTIME_USAGE_POLL_MS);
  }

  private stopRuntimeUsagePolling(): void {
    if (this.runtimeUsageTimer) {
      clearInterval(this.runtimeUsageTimer);
      this.runtimeUsageTimer = undefined;
    }
  }

  private resetInventoryRefreshTimer(): void {
    this.stopInventoryRefreshTimer();
    const observer = this.config?.inventoryObserver;
    if (this.disposed || !observer || !this.observerCredentialPresent) {
      return;
    }
    this.inventoryRefreshTimer = setInterval(() => {
      void this.refreshInventory();
    }, observer.refreshSeconds * 1_000);
  }

  private stopInventoryRefreshTimer(): void {
    if (this.inventoryRefreshTimer) {
      clearInterval(this.inventoryRefreshTimer);
      this.inventoryRefreshTimer = undefined;
    }
  }

  private resolveStatus(isActive: boolean): {
    kind: DashboardSub2ApiGatewayViewModel["status"];
    message: string;
  } {
    if (!this.config) {
      return {
        kind: this.configError ? "configuration_error" : "configuration_required",
        message: this.configError ?? "Gateway configuration is required"
      };
    }
    if (!this.credentialPresent) {
      return { kind: "credential_required", message: "Store the downstream API key in VS Code SecretStorage" };
    }
    if (this.runtimeError) {
      return { kind: "degraded", message: this.runtimeError };
    }
    if (this.health?.status === "failed") {
      return { kind: "degraded", message: this.health.message ?? "Sub2API health check failed" };
    }
    if (isActive) {
      return { kind: "active", message: "Active local transport; OAuth quota scheduling remains separate" };
    }
    return { kind: "ready", message: "Ready for manual activation" };
  }

  private publishChange(): void {
    if (!this.disposed) {
      this.onDidChange();
    }
  }
}

function toRuntimeConfig(config: ResolvedSub2ApiGatewayConfig): Sub2ApiGatewayRuntimeConfig {
  return {
    displayName: config.displayName,
    baseUrl: config.sub2api.baseUrl,
    model: config.sub2api.model
  };
}

async function checkGatewayHealth(config: ResolvedSub2ApiGatewayConfig, apiKey: string): Promise<GatewayHealth> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.sub2api.baseUrl}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!response.ok) {
      return {
        checkedAt: Date.now(),
        status: "failed",
        message: `Sub2API returned HTTP ${response.status}`
      };
    }
    const payload: unknown = await response.json().catch(() => undefined);
    const exposedModelCount = countExposedModels(payload);
    return {
      checkedAt: Date.now(),
      status: "healthy",
      exposedModelCount
    };
  } catch {
    return {
      checkedAt: Date.now(),
      status: "failed",
      message: "Unable to reach the configured Sub2API endpoint"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function countExposedModels(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = (value as Record<string, unknown>)["data"];
  return Array.isArray(data) ? data.length : undefined;
}

function normalizePersistedUsage(
  value: unknown,
  previousValue?: unknown,
  legacyValue?: unknown
): PersistedGatewayUsage {
  const record = asRecord(value);
  if (record?.["version"] === 3) {
    const tokenBuckets = normalizeTokenBuckets(record["tokenBuckets"]);
    return {
      version: 3,
      totals: withCurrentWindowUsage(normalizeUsageTotals(record["totals"]), tokenBuckets),
      checkpoints: normalizeCheckpoints(record["checkpoints"]),
      tokenBuckets
    };
  }
  const previous = asRecord(value) ?? asRecord(previousValue) ?? asRecord(legacyValue);
  if (previous?.["version"] === 2 || previous?.["version"] === 1) {
    return {
      version: 3,
      totals: normalizeUsageTotals(previous["totals"]),
      checkpoints: normalizeCheckpoints(previous["checkpoints"]),
      tokenBuckets: []
    };
  }
  return { version: 3, totals: emptyUsageTotals(), checkpoints: {}, tokenBuckets: [] };
}

function normalizeUsageTotals(value: unknown): GatewayUsageTotals {
  const record = asRecord(value) ?? {};
  return {
    requestCount: nonNegativeInteger(record["requestCount"]),
    successfulRequestCount: nonNegativeInteger(record["successfulRequestCount"]),
    failedRequestCount: nonNegativeInteger(record["failedRequestCount"]),
    lastRequestAt: positiveTimestamp(record["lastRequestAt"]),
    observedAt: positiveTimestamp(record["observedAt"]),
    today: normalizeTodayUsage(record["today"]),
    windows: emptyWindowsUsage(),
    ...(normalizeUsageFailure(record["lastFailure"]) ? { lastFailure: normalizeUsageFailure(record["lastFailure"]) } : {})
  };
}

function normalizeTodayUsage(value: unknown): GatewayTodayUsage {
  const record = asRecord(value) ?? {};
  const date = isUsageDay(record["date"]) ? record["date"] : currentGatewayDay();
  return {
    date,
    inputTokens: nonNegativeInteger(record["inputTokens"]),
    outputTokens: nonNegativeInteger(record["outputTokens"]),
    cachedInputTokens: nonNegativeInteger(record["cachedInputTokens"]),
    reasoningTokens: nonNegativeInteger(record["reasoningTokens"]),
    totalTokens: nonNegativeInteger(record["totalTokens"]),
    observedSince: positiveTimestamp(record["observedSince"])
  };
}

function normalizeUsageFailure(value: unknown): GatewayUsageTotals["lastFailure"] | undefined {
  const record = asRecord(value);
  const at = record ? positiveTimestamp(record["at"]) : undefined;
  if (!record || !at) {
    return undefined;
  }
  const transportCode = normalizeGatewayTransportCode(record["transportCode"]);
  const requestMethod = normalizeGatewayRequestMethod(record["requestMethod"]);
  const requestPath = normalizeGatewayRequestPath(record["requestPath"]);
  const contentLength = normalizeGatewayDiagnosticContentLength(record["contentLength"]);
  const transferEncoding = record["transferEncoding"] === "chunked" ? "chunked" : undefined;
  return {
    at,
    origin: record["origin"] === "sub2api" ? "sub2api" : "adapter",
    ...(nonNegativeHttpStatus(record["statusCode"]) ? { statusCode: nonNegativeHttpStatus(record["statusCode"]) } : {}),
    ...(transportCode ? { transportCode } : {}),
    ...(requestMethod ? { requestMethod } : {}),
    ...(requestPath ? { requestPath } : {}),
    ...(contentLength !== undefined ? { contentLength } : {}),
    ...(transferEncoding ? { transferEncoding } : {})
  };
}

function normalizeCheckpoints(value: unknown): Record<string, GatewayUsageRuntimeCheckpoint> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const checkpoints: Record<string, GatewayUsageRuntimeCheckpoint> = {};
  for (const [instanceId, checkpoint] of Object.entries(record)) {
    if (instanceId.length === 0 || instanceId.length > 128) {
      continue;
    }
    const source = asRecord(checkpoint);
    if (!source) {
      continue;
    }
    checkpoints[instanceId] = {
      requestCount: nonNegativeInteger(source["requestCount"]),
      successfulRequestCount: nonNegativeInteger(source["successfulRequestCount"]),
      failedRequestCount: nonNegativeInteger(source["failedRequestCount"]),
      usageDay: isUsageDay(source["usageDay"]) ? source["usageDay"] : currentGatewayDay(),
      inputTokens: nonNegativeInteger(source["inputTokens"]),
      outputTokens: nonNegativeInteger(source["outputTokens"]),
      cachedInputTokens: nonNegativeInteger(source["cachedInputTokens"]),
      reasoningTokens: nonNegativeInteger(source["reasoningTokens"]),
      totalTokens: nonNegativeInteger(source["totalTokens"])
    };
  }
  return checkpoints;
}

function normalizeTokenBuckets(value: unknown): GatewayTokenBucket[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const cutoff = Date.now() - SEVEN_DAY_USAGE_WINDOW_MS - TOKEN_BUCKET_MS;
  const byStartAt = new Map<number, GatewayTokenBucket>();
  for (const entry of value) {
    const record = asRecord(entry);
    const startAt = record ? positiveTimestamp(record["startAt"]) : undefined;
    if (!record || !startAt || startAt < cutoff) {
      continue;
    }
    const existing = byStartAt.get(startAt) ?? emptyTokenBucket(startAt);
    byStartAt.set(startAt, {
      startAt,
      inputTokens: existing.inputTokens + nonNegativeInteger(record["inputTokens"]),
      outputTokens: existing.outputTokens + nonNegativeInteger(record["outputTokens"]),
      cachedInputTokens: existing.cachedInputTokens + nonNegativeInteger(record["cachedInputTokens"]),
      reasoningTokens: existing.reasoningTokens + nonNegativeInteger(record["reasoningTokens"]),
      totalTokens: existing.totalTokens + nonNegativeInteger(record["totalTokens"])
    });
  }
  return [...byStartAt.values()].sort((left, right) => left.startAt - right.startAt).slice(-MAX_TOKEN_BUCKETS);
}

function appendTokenDelta(
  buckets: GatewayTokenBucket[],
  delta: Omit<GatewayTokenBucket, "startAt">
): GatewayTokenBucket[] {
  if (!hasTokenDelta(delta)) {
    return pruneTokenBuckets(buckets);
  }
  const startAt = Math.floor(Date.now() / TOKEN_BUCKET_MS) * TOKEN_BUCKET_MS;
  const next = buckets.map((bucket) => ({ ...bucket }));
  const existing = next.find((bucket) => bucket.startAt === startAt);
  if (existing) {
    existing.inputTokens += delta.inputTokens;
    existing.outputTokens += delta.outputTokens;
    existing.cachedInputTokens += delta.cachedInputTokens;
    existing.reasoningTokens += delta.reasoningTokens;
    existing.totalTokens += delta.totalTokens;
  } else {
    next.push({ startAt, ...delta });
  }
  return pruneTokenBuckets(next);
}

function withCurrentWindowUsage(totals: GatewayUsageTotals, buckets: GatewayTokenBucket[]): GatewayUsageTotals {
  const normalizedBuckets = pruneTokenBuckets(buckets);
  return {
    ...totals,
    today: totals.today.date === currentGatewayDay() ? totals.today : emptyTodayUsage(),
    windows: {
      fiveHour: sumTokenBuckets(normalizedBuckets, Date.now() - FIVE_HOUR_USAGE_WINDOW_MS),
      sevenDay: sumTokenBuckets(normalizedBuckets, Date.now() - SEVEN_DAY_USAGE_WINDOW_MS)
    }
  };
}

function sumTokenBuckets(buckets: GatewayTokenBucket[], cutoff: number): GatewayWindowUsage {
  const matching = buckets.filter((bucket) => bucket.startAt >= cutoff);
  if (matching.length === 0) {
    return emptyWindowUsage();
  }
  return matching.reduce<GatewayWindowUsage>(
    (total, bucket) => ({
      inputTokens: total.inputTokens + bucket.inputTokens,
      outputTokens: total.outputTokens + bucket.outputTokens,
      cachedInputTokens: total.cachedInputTokens + bucket.cachedInputTokens,
      reasoningTokens: total.reasoningTokens + bucket.reasoningTokens,
      totalTokens: total.totalTokens + bucket.totalTokens,
      observedSince: minimumTimestamp(total.observedSince, bucket.startAt)
    }),
    emptyWindowUsage()
  );
}

function pruneTokenBuckets(buckets: GatewayTokenBucket[]): GatewayTokenBucket[] {
  const cutoff = Date.now() - SEVEN_DAY_USAGE_WINDOW_MS - TOKEN_BUCKET_MS;
  return buckets.filter((bucket) => bucket.startAt >= cutoff).sort((left, right) => left.startAt - right.startAt).slice(-MAX_TOKEN_BUCKETS);
}

function emptyTokenBucket(startAt: number): GatewayTokenBucket {
  return { startAt, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

function hasTokenDelta(delta: Omit<GatewayTokenBucket, "startAt">): boolean {
  return (
    delta.inputTokens > 0 ||
    delta.outputTokens > 0 ||
    delta.cachedInputTokens > 0 ||
    delta.reasoningTokens > 0 ||
    delta.totalTokens > 0
  );
}

function toRuntimeCheckpoint(
  status: Awaited<ReturnType<CodexHotSwitchRuntime["getSub2ApiGatewayStatus"]>>
): GatewayUsageRuntimeCheckpoint {
  return {
    requestCount: nonNegativeInteger(status.requestCount),
    successfulRequestCount: nonNegativeInteger(status.successfulRequestCount),
    failedRequestCount: nonNegativeInteger(status.failedRequestCount),
    usageDay: isUsageDay(status.usageDay) ? status.usageDay : currentGatewayDay(),
    inputTokens: nonNegativeInteger(status.inputTokens),
    outputTokens: nonNegativeInteger(status.outputTokens),
    cachedInputTokens: nonNegativeInteger(status.cachedInputTokens),
    reasoningTokens: nonNegativeInteger(status.reasoningTokens),
    totalTokens: nonNegativeInteger(status.totalTokens)
  };
}

function readRuntimeFailure(
  status: Awaited<ReturnType<CodexHotSwitchRuntime["getSub2ApiGatewayStatus"]>>
): GatewayUsageTotals["lastFailure"] | undefined {
  const at = positiveTimestamp(status.lastFailureAt);
  if (!at) {
    return undefined;
  }
  const transportCode = normalizeGatewayTransportCode(status.lastFailureTransportCode);
  const requestMethod = normalizeGatewayRequestMethod(status.lastFailureRequestMethod);
  const requestPath = normalizeGatewayRequestPath(status.lastFailureRequestPath);
  const contentLength = normalizeGatewayDiagnosticContentLength(status.lastFailureContentLength);
  const transferEncoding = status.lastFailureTransferEncoding === "chunked" ? "chunked" : undefined;
  return {
    at,
    origin: status.lastFailureOrigin === "sub2api" ? "sub2api" : "adapter",
    ...(nonNegativeHttpStatus(status.lastFailureStatusCode)
      ? { statusCode: nonNegativeHttpStatus(status.lastFailureStatusCode) }
      : {}),
    ...(transportCode ? { transportCode } : {}),
    ...(requestMethod ? { requestMethod } : {}),
    ...(requestPath ? { requestPath } : {}),
    ...(contentLength !== undefined ? { contentLength } : {}),
    ...(transferEncoding ? { transferEncoding } : {})
  };
}

function shouldReplaceRuntimeFailure(
  previous: GatewayUsageTotals["lastFailure"] | undefined,
  next: GatewayUsageTotals["lastFailure"] | undefined
): next is NonNullable<GatewayUsageTotals["lastFailure"]> {
  return Boolean(next && (!previous || next.at >= previous.at));
}

function latestGatewayFailure(
  previous: GatewayUsageTotals["lastFailure"] | undefined,
  next: GatewayUsageTotals["lastFailure"] | undefined
): GatewayUsageTotals["lastFailure"] | undefined {
  return shouldReplaceRuntimeFailure(previous, next) ? next : previous;
}

async function readPersistedGatewayFailure(storagePath: string): Promise<GatewayUsageTotals["lastFailure"] | undefined> {
  try {
    const diagnosticPath = path.join(storagePath, RUNTIME_DIRECTORY, GATEWAY_DIAGNOSTIC_FILE);
    const parsed: unknown = JSON.parse(await fs.readFile(diagnosticPath, "utf8"));
    return normalizeGatewayDiagnosticFailure(parsed);
  } catch {
    // This file is optional and only exists after a forwarding failure. A
    // missing, stale, or malformed diagnostic must never affect switching.
    return undefined;
  }
}

function normalizeGatewayDiagnosticFailure(value: unknown): GatewayUsageTotals["lastFailure"] | undefined {
  const record = asRecord(value);
  if (record?.["schema"] !== GATEWAY_DIAGNOSTIC_SCHEMA) {
    return undefined;
  }
  const at = positiveTimestamp(record["recordedAt"]);
  if (!at) {
    return undefined;
  }
  const request = asRecord(record["request"]);
  const transportCode = normalizeGatewayTransportCode(record["transportCode"]);
  const requestMethod = normalizeGatewayRequestMethod(request?.["method"]);
  const requestPath = normalizeGatewayRequestPath(request?.["path"]);
  const contentLength = normalizeGatewayDiagnosticContentLength(request?.["contentLength"]);
  const transferEncoding = request?.["transferEncoding"] === "chunked" ? "chunked" : undefined;
  return {
    at,
    origin: record["origin"] === "sub2api" ? "sub2api" : "adapter",
    ...(nonNegativeHttpStatus(record["statusCode"]) ? { statusCode: nonNegativeHttpStatus(record["statusCode"]) } : {}),
    ...(transportCode ? { transportCode } : {}),
    ...(requestMethod ? { requestMethod } : {}),
    ...(requestPath ? { requestPath } : {}),
    ...(contentLength !== undefined ? { contentLength } : {}),
    ...(transferEncoding ? { transferEncoding } : {})
  };
}

function normalizeGatewayTransportCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(value) ? value : undefined;
}

function normalizeGatewayRequestMethod(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z]{1,16}$/u.test(value) ? value : undefined;
}

function normalizeGatewayRequestPath(value: unknown): string | undefined {
  if (value === "/v1/models" || value === "/v1/responses" || value === "/v1/responses/compact") {
    return value;
  }
  return typeof value === "string" && value.startsWith("/v1/responses/") ? "/v1/responses/*" : undefined;
}

function normalizeGatewayDiagnosticContentLength(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_GATEWAY_DIAGNOSTIC_CONTENT_LENGTH
    ? value
    : undefined;
}

function emptyUsageTotals(): GatewayUsageTotals {
  return {
    requestCount: 0,
    successfulRequestCount: 0,
    failedRequestCount: 0,
    today: emptyTodayUsage(),
    windows: emptyWindowsUsage()
  };
}

function emptyTodayUsage(date = currentGatewayDay()): GatewayTodayUsage {
  return {
    date,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
}

function emptyWindowUsage(): GatewayWindowUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
}

function emptyWindowsUsage(): GatewayUsageTotals["windows"] {
  return { fiveHour: emptyWindowUsage(), sevenDay: emptyWindowUsage() };
}

function emptyInventory(
  observer?: ResolvedSub2ApiGatewayConfig["inventoryObserver"],
  credentialPresent = false
): GatewayInventory {
  if (!observer) {
    return { configured: false, credentialPresent: false, status: "not_configured" };
  }
  return {
    configured: true,
    credentialPresent,
    status: credentialPresent ? "ready" : "credential_required",
    group: observer.group
  };
}

function normalizeInventoryForConfig(
  current: GatewayInventory,
  observer: ResolvedSub2ApiGatewayConfig["inventoryObserver"] | undefined,
  credentialPresent: boolean
): GatewayInventory {
  if (!observer) {
    return emptyInventory();
  }
  if (!credentialPresent) {
    return emptyInventory(observer, false);
  }
  return {
    ...current,
    configured: true,
    credentialPresent: true,
    group: observer.group,
    status: current.status === "not_configured" || current.status === "credential_required" ? "ready" : current.status
  };
}

function observerSignature(observer: ResolvedSub2ApiGatewayConfig["inventoryObserver"] | undefined): string | undefined {
  return observer
    ? `${observer.adminBaseUrl}\u0000${observer.group}\u0000${observer.credentialRef}\u0000${observer.refreshSeconds}`
    : undefined;
}

function validateApiKeyInput(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return "An API key is required.";
  }
  if (normalized.length > MAX_API_KEY_LENGTH) {
    return "The API key is too long.";
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function nonNegativeHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function positiveTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function maximumTimestamp(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.max(left, right);
}

function minimumTimestamp(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.min(left, right);
}

function isUsageDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function currentGatewayDay(timestamp = Date.now()): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function describeGatewayError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The Sub2API Gateway is unavailable";
}

async function promptWindowReloadIfNeeded(result: HotSwitchSetupResult, message: string): Promise<void> {
  if (!result.requiresReload) {
    return;
  }
  const reload = "Reload once";
  const choice = await vscode.window.showInformationMessage(message, reload, "Later");
  if (choice === reload) {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

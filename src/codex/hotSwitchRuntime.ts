import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { needsRefresh, refreshTokens } from "../auth/oauth";
import { isSub2ApiAccount, type CodexAccountRecord, type CodexTokens } from "../core/types";
import { decodeJwtPayload, extractClaims } from "../utils/jwt";
import {
  getCodexAccountsConfiguration,
  normalizeHotSwitchGraceSeconds,
  normalizeHotSwitchLongTurnPolicy,
  isForceFastModeEnabled
} from "../infrastructure/config/extensionSettings";
import type { AccountsRepository } from "../storage";
import {
  getCurrentWindowRuntimeAccountId,
  setCurrentWindowRuntimeAccountId
} from "../presentation/workbench/windowRuntimeAccount";
import {
  CodexHotSwitchBridge,
  CodexExecProviderConfig,
  HotSwitchAccountResult,
  HotSwitchIdentity,
  HotSwitchLongTurnPolicy,
  HotSwitchOperationStatus,
  HotSwitchRefreshRequest,
  HotSwitchRefreshResult,
  HotSwitchStatus,
  isHotSwitchOperationUncertainError,
  GatewayRuntimeStatus
} from "./hotSwitchBridge";
import { readAuthFile, writeAuthFile } from "./authFile";
import { installRemoteCliOverlay, restoreRemoteCliOverlay } from "./remoteCliOverlay";

const HOT_SWITCH_ENABLED = "hotSwitchEnabled";
const HOT_SWITCH_GRACE_SECONDS = "hotSwitchGraceSeconds";
const HOT_SWITCH_LONG_TURN_POLICY = "hotSwitchLongTurnPolicy";
const OPENAI_EXTENSION_ID = "openai.chatgpt";
const PREVIOUS_CLI_SETTING_KEY = "hotSwitch.previousCliExecutable";
const TOKEN_REFRESH_SKEW_SECONDS = 5 * 60;
const RUNTIME_DIRECTORY = "hot-switch-runtime";
const SHIM_LAUNCHER_FILE = "codex-app-server-shim";
const SHIM_FILE = "codex-app-server-shim.cjs";
const SHIM_CONFIG_FILE = "codex-app-server-shim.json";
const USAGE_ATTRIBUTION_DIRECTORY = "account-usage-attribution";
const RUNTIME_PROTOCOL_VERSION = 13;
const GATEWAY_RUNTIME_CONFIG_KEY = "gateway.runtimeConfig";
const UNMANAGED_ROLLBACK_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const USAGE_ATTRIBUTION_RETRY_DELAY_MS = 5_000;

/**
 * Provider-neutral runtime configuration. A registered integration supplies
 * these values only when it is explicitly activated; no credential is ever
 * persisted in this structure.
 */
export type GatewayRuntimeConfig = {
  displayName: string;
  baseUrl: string;
  model: string;
  autoFallbackToChatGpt?: boolean;
};

type GatewayRuntimeState = {
  config: GatewayRuntimeConfig;
  active: boolean;
};

export type HotSwitchSetupResult = {
  enabled: boolean;
  configured: boolean;
  requiresReload: boolean;
  shimPath?: string;
  error?: string;
};

export type RuntimeAccessTokenIdentity = {
  email: string;
  userId?: string;
};

export type RuntimeAccountSwitchOptions = {
  gracePeriodMs?: number;
  longTurnPolicy?: HotSwitchLongTurnPolicy;
  recoverRecentUsageLimitedTurns?: boolean;
  /** Reserved for RuntimeSwitchCoordinator's timeout reconciliation. */
  operationId?: string;
  /** Allows a manual OAuth handoff immediately after returning from Gateway. */
  allowManualWhenSeamlessDisabled?: boolean;
};

type CapturedUnmanagedRollbackSnapshot = {
  tokens: CodexTokens;
  accountId: string;
  email: string;
  planType: string | null;
};

type RetainedUnmanagedRollbackSnapshot = {
  tokens: CodexTokens;
  cleanupTimer?: NodeJS.Timeout;
};

export class CodexHotSwitchRuntime implements vscode.Disposable {
  private bridge: CodexHotSwitchBridge | undefined;
  private readonly unmanagedRollbackSnapshots = new Map<string, RetainedUnmanagedRollbackSnapshot>();
  private usageAttributionRetryTimer: NodeJS.Timeout | undefined;
  private usageAttributionSyncInFlight: Promise<void> | undefined;
  private usageAttributionSyncGeneration = 0;
  private usageAttributionFailureReason: string | null = "not_activated";
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repo: AccountsRepository
  ) {}

  async initialize(): Promise<HotSwitchSetupResult> {
    if (!isHotSwitchEnabled()) {
      return {
        enabled: false,
        configured: false,
        requiresReload: false
      };
    }
    return this.configureRuntime();
  }

  isEnabled(): boolean {
    return isHotSwitchEnabled();
  }

  async enable(): Promise<HotSwitchSetupResult> {
    await getCodexAccountsConfiguration().update(HOT_SWITCH_ENABLED, true, vscode.ConfigurationTarget.Global);
    return this.configureRuntime();
  }

  isGatewayActive(): boolean {
    return this.getGatewayRuntimeState()?.active === true;
  }

  isGatewayConfigured(): boolean {
    return this.getGatewayRuntimeState() !== undefined;
  }

  async activateGateway(
    config: GatewayRuntimeConfig,
    apiKey?: string,
    options: RuntimeAccountSwitchOptions = {}
  ): Promise<HotSwitchSetupResult> {
    const normalized = normalizeGatewayRuntimeConfig(config);
    await this.ensureGatewayDoesNotEnableSeamlessScheduling();
    if (!isHotSwitchEnabled()) {
      await getCodexAccountsConfiguration().update(HOT_SWITCH_ENABLED, true, vscode.ConfigurationTarget.Global);
    }
    const current = this.getGatewayRuntimeState();
    if (this.bridge && current && sameGatewayRuntimeConfig(current.config, normalized)) {
      if (apiKey) {
        await this.bridge.configureGatewayCredential(apiKey);
      }
      const result = await this.switchGatewayRoute("gateway", undefined, options);
      if (result.status !== "switched") {
        throw new Error(`The Gateway relay could not activate its route (${result.activeTurns} active turn(s))`);
      }
      await this.setGatewayRuntimeState({ config: normalized, active: true });
      return { enabled: true, configured: true, requiresReload: false };
    }
    if (this.bridge && current) {
      await this.setGatewayRuntimeState({ config: normalized, active: true });
      return { enabled: true, configured: false, requiresReload: true };
    }
    await this.setGatewayRuntimeState({ config: normalized, active: true });
    return this.configureRuntime();
  }

  async deactivateGateway(options: RuntimeAccountSwitchOptions = {}): Promise<HotSwitchSetupResult> {
    const current = this.getGatewayRuntimeState();
    if (this.bridge && current) {
      const result = await this.switchGatewayRoute("chatgpt", undefined, options);
      if (result.status !== "switched") {
        return {
          enabled: true,
          configured: true,
          requiresReload: false,
          error: `Gateway route switch was deferred with ${result.activeTurns} active turn(s)`
        };
      }
      await this.setGatewayRuntimeState({ config: current.config, active: false });
      return { enabled: true, configured: true, requiresReload: false };
    }
    await this.setGatewayRuntimeState(undefined);
    if (!isHotSwitchEnabled()) {
      return {
        enabled: false,
        configured: false,
        requiresReload: false
      };
    }
    return this.configureRuntime();
  }

  async configureGatewayCredential(apiKey: string): Promise<GatewayRuntimeStatus> {
    if (!this.isGatewayConfigured()) {
      throw new Error("The Gateway relay is not configured for this Codex runtime");
    }
    if (!this.bridge) {
      throw new Error("Codex hot switch is not configured");
    }
    return this.bridge.configureGatewayCredential(apiKey);
  }

  async getGatewayStatus(): Promise<GatewayRuntimeStatus> {
    if (!this.isGatewayConfigured()) {
      return {
        active: false,
        ready: false,
        requestCount: 0,
        successfulRequestCount: 0,
        failedRequestCount: 0
      };
    }
    if (!this.bridge) {
      return {
        active: this.isGatewayActive(),
        ready: false,
        requestCount: 0,
        successfulRequestCount: 0,
        failedRequestCount: 0
      };
    }
    return this.bridge.getGatewayStatus();
  }

  /**
   * Return the resident Manager/Codex adapter route for a same-host client.
   * The port and bearer are intentionally ephemeral and are never persisted.
   */
  async getCodexExecProviderConfig(): Promise<CodexExecProviderConfig> {
    if (!this.bridge) {
      throw new Error("Codex hot-switch runtime is not ready");
    }
    let provider = await this.bridge.getCodexExecProviderConfig();
    if (!provider.ready && provider.route === "chatgpt") {
      const result = await this.switchGatewayRoute("chatgpt", undefined, {
        gracePeriodMs: 0,
        longTurnPolicy: "defer"
      });
      if (result.status !== "switched") {
        throw new Error("Manager Codex ChatGPT route is not ready");
      }
      provider = await this.bridge.getCodexExecProviderConfig();
    }
    if (!provider.ready) {
      throw new Error("Manager Codex provider route is not ready");
    }
    return provider;
  }

  async disable(): Promise<HotSwitchSetupResult> {
    try {
      await getCodexAccountsConfiguration().update(HOT_SWITCH_ENABLED, false, vscode.ConfigurationTarget.Global);
      await this.setGatewayRuntimeState(undefined);
      this.bridge?.dispose();
      this.bridge = undefined;
      const runtimeLauncherPath = path.join(
        this.context.globalStorageUri.fsPath,
        RUNTIME_DIRECTORY,
        SHIM_LAUNCHER_FILE
      );
      let requiresReload = false;
      if (isRemoteExtensionHost()) {
        const cliPath = await resolveOpenAiCodexCliPath();
        requiresReload = await restoreRemoteCliOverlay(cliPath, runtimeLauncherPath);
      } else {
        const chatgptConfig = vscode.workspace.getConfiguration("chatgpt");
        const runtimeShimPath = path.join(this.context.globalStorageUri.fsPath, RUNTIME_DIRECTORY, SHIM_FILE);
        const currentCliPath = chatgptConfig.get<string | null>("cliExecutable", null);
        const previousCliPath = this.context.globalState.get<string | null>(PREVIOUS_CLI_SETTING_KEY);
        const currentlyUsesRuntime = currentCliPath === runtimeLauncherPath || currentCliPath === runtimeShimPath;
        if (currentlyUsesRuntime) {
          const restoredCliPath = previousCliPath === undefined ? null : previousCliPath;
          await chatgptConfig.update("cliExecutable", restoredCliPath, vscode.ConfigurationTarget.Global);
          requiresReload = true;
        }
      }
      await this.context.globalState.update(PREVIOUS_CLI_SETTING_KEY, undefined);
      return {
        enabled: false,
        configured: false,
        requiresReload
      };
    } catch (error) {
      return {
        enabled: false,
        configured: false,
        requiresReload: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getStatus(): Promise<HotSwitchStatus> {
    if (!this.bridge) {
      throw new Error("Codex hot switch is not configured");
    }
    const status = await this.bridge.getStatus();
    return {
      ...status,
      attributionFailureReason: status.attributionActive
        ? null
        : (this.usageAttributionFailureReason ?? status.attributionFailureReason)
    };
  }

  async getOperationStatus(operationId: string): Promise<HotSwitchOperationStatus> {
    if (!this.bridge) {
      throw new Error("Codex hot switch is not configured");
    }
    return this.bridge.getOperationStatus(operationId);
  }

  async getIdentity(): Promise<HotSwitchIdentity> {
    if (!this.bridge) {
      throw new Error("Codex hot switch is not configured");
    }
    return this.bridge.getIdentity();
  }

  async configureUsageLimitObservation(enabled: boolean): Promise<void> {
    if (!this.bridge) {
      throw new Error("Codex hot switch is not configured");
    }
    await this.bridge.configureUsageLimitObservation(enabled);
  }

  async setForceFastMode(enabled: boolean): Promise<boolean> {
    if (!this.bridge) {
      return false;
    }
    const result = await this.bridge.configureFastMode(enabled);
    return result.enabled === enabled;
  }

  async resetUsageLimitObservation(): Promise<boolean> {
    if (!this.bridge) {
      return false;
    }
    await this.bridge.resetUsageLimitObservation();
    return true;
  }

  async switchAccount(accountId: string, options: RuntimeAccountSwitchOptions = {}): Promise<HotSwitchAccountResult> {
    if (!isHotSwitchEnabled()) {
      throw new Error("Codex hot switch is not enabled");
    }
    if (!this.bridge) {
      throw new Error("Codex hot switch is enabled, but its runtime is not ready; restart the extension host");
    }
    const bridge = this.bridge;
    const account = await this.repo.getAccount(accountId);
    if (account && isSub2ApiAccount(account)) {
      if (!this.getGatewayRuntimeState()) {
        throw new Error("The Gateway runtime is not configured");
      }
      const result = await this.switchGatewayRoute("gateway", accountId, options);
      if (result.status === "switched") {
        await this.repo.switchProviderRoute(accountId);
      }
      return result;
    }
    if (this.isGatewayActive()) {
      throw new Error("Switch back from the Gateway before selecting a ChatGPT Auth account");
    }
    let tokens = await this.repo.getTokens(accountId);
    if (!account || !tokens?.accessToken) {
      throw new Error("The selected account has no usable Codex credentials");
    }
    if (account.isHidden) {
      throw new Error("The selected account is hidden. Unhide it before switching to it.");
    }
    if (needsRefresh(tokens.accessToken, TOKEN_REFRESH_SKEW_SECONDS)) {
      tokens = await this.refreshAccountTokens(account, tokens);
    }
    const runtimeIdentity = resolveRuntimeAccessTokenIdentity(account, tokens.accessToken);
    const remoteAccountId = account.accountId ?? tokens.accountId;
    if (!remoteAccountId) {
      throw new Error("The selected account has no ChatGPT workspace identifier");
    }
    const previousLocalAccountId = getCurrentWindowRuntimeAccountId();
    const previousAccount = previousLocalAccountId ? await this.repo.getAccount(previousLocalAccountId) : undefined;
    let previousTokens = previousLocalAccountId ? await this.repo.getTokens(previousLocalAccountId) : undefined;
    if (
      previousAccount &&
      previousTokens?.accessToken &&
      needsRefresh(previousTokens.accessToken, TOKEN_REFRESH_SKEW_SECONDS)
    ) {
      previousTokens = await this.refreshAccountTokens(previousAccount, previousTokens);
    }
    const baseParams = {
      operationId: options.operationId,
      accessToken: tokens.accessToken,
      accountId: remoteAccountId,
      localAccountId: account.id,
      expectedEmail: runtimeIdentity.email,
      planType: account.planType,
      gracePeriodMs: options.gracePeriodMs ?? getHotSwitchGraceSeconds() * 1_000,
      longTurnPolicy: options.longTurnPolicy ?? getHotSwitchLongTurnPolicy(),
      recoverRecentUsageLimitedTurns: options.recoverRecentUsageLimitedTurns
    };
    const previousRemoteAccountId = previousAccount?.accountId ?? previousTokens?.accountId;
    if (previousLocalAccountId && previousRemoteAccountId && previousAccount && previousTokens?.accessToken) {
      const previousRuntimeIdentity = resolveRuntimeAccessTokenIdentity(previousAccount, previousTokens.accessToken);
      const result = await bridge.switchAccount({
        ...baseParams,
        previousAccountId: previousRemoteAccountId,
        previousLocalAccountId,
        previousExpectedEmail: previousRuntimeIdentity.email
      });
      if (result.status === "switched") {
        void this.synchronizeUsageAttribution(bridge);
      }
      return result;
    }

    const result = await this.withUnmanagedRollbackSnapshot((snapshot, rollbackContextId) =>
      bridge.switchAccount({
        ...baseParams,
        previousAccountId: snapshot.accountId,
        previousExpectedEmail: snapshot.email,
        previousAccessToken: snapshot.tokens.accessToken,
        previousPlanType: snapshot.planType,
        rollbackContextId
      })
    );
    if (result.status === "switched") {
      void this.synchronizeUsageAttribution(bridge);
    }
    return result;
  }

  /**
   * A Gateway fallback changes the app-server OAuth identity in place.  Carry
   * the same managed-or-snapshot rollback material as an ordinary hot switch
   * so a failed local account commit cannot strand the live runtime on the
   * target account while the Gateway remains selected.
   */
  async fallbackGatewayToChatGpt(
    accountId: string,
    options: RuntimeAccountSwitchOptions = {}
  ): Promise<HotSwitchAccountResult> {
    if (!isHotSwitchEnabled()) {
      throw new Error("Codex hot switch is not enabled");
    }
    if (!this.bridge) {
      throw new Error("Codex hot switch is enabled, but its runtime is not ready; restart the extension host");
    }
    const bridge = this.bridge;
    const gateway = this.getGatewayRuntimeState();
    if (!gateway?.active || gateway.config.autoFallbackToChatGpt !== true) {
      throw new Error("The Gateway automatic fallback is not active");
    }

    const account = await this.repo.getAccount(accountId);
    let tokens = await this.repo.getTokens(accountId);
    if (!account || !tokens?.accessToken) {
      throw new Error("The selected fallback account has no usable Codex credentials");
    }
    if (account.isHidden) {
      throw new Error("The selected fallback account is hidden. Unhide it before using it.");
    }
    if (needsRefresh(tokens.accessToken, TOKEN_REFRESH_SKEW_SECONDS)) {
      tokens = await this.refreshAccountTokens(account, tokens);
    }
    const runtimeIdentity = resolveRuntimeAccessTokenIdentity(account, tokens.accessToken);
    const remoteAccountId = account.accountId ?? tokens.accountId;
    if (!remoteAccountId) {
      throw new Error("The selected fallback account has no ChatGPT workspace identifier");
    }

    const baseParams = {
      operationId: options.operationId,
      accessToken: tokens.accessToken,
      accountId: remoteAccountId,
      localAccountId: account.id,
      expectedEmail: runtimeIdentity.email,
      planType: account.planType,
      gracePeriodMs: options.gracePeriodMs ?? getHotSwitchGraceSeconds() * 1_000,
      longTurnPolicy: options.longTurnPolicy ?? getHotSwitchLongTurnPolicy()
    };
    const previousLocalAccountId = getCurrentWindowRuntimeAccountId();
    const previousAccount = previousLocalAccountId ? await this.repo.getAccount(previousLocalAccountId) : undefined;
    let previousTokens = previousLocalAccountId ? await this.repo.getTokens(previousLocalAccountId) : undefined;
    if (
      previousAccount &&
      previousTokens?.accessToken &&
      needsRefresh(previousTokens.accessToken, TOKEN_REFRESH_SKEW_SECONDS)
    ) {
      previousTokens = await this.refreshAccountTokens(previousAccount, previousTokens);
    }
    const previousRemoteAccountId = previousAccount?.accountId ?? previousTokens?.accountId;
    let result: HotSwitchAccountResult;
    if (previousLocalAccountId && previousRemoteAccountId && previousAccount && previousTokens?.accessToken) {
      const previousRuntimeIdentity = resolveRuntimeAccessTokenIdentity(previousAccount, previousTokens.accessToken);
      result = await bridge.fallbackToChatGpt({
        ...baseParams,
        previousAccountId: previousRemoteAccountId,
        previousLocalAccountId,
        previousExpectedEmail: previousRuntimeIdentity.email
      });
    } else {
      result = await this.withUnmanagedRollbackSnapshot((snapshot, rollbackContextId) =>
        bridge.fallbackToChatGpt({
          ...baseParams,
          previousAccountId: snapshot.accountId,
          previousExpectedEmail: snapshot.email,
          previousAccessToken: snapshot.tokens.accessToken,
          previousPlanType: snapshot.planType,
          rollbackContextId
        })
      );
    }
    if (result.status === "switched") {
      await this.setGatewayRuntimeState({ config: gateway.config, active: false });
      this.usageAttributionFailureReason = "not_activated";
      void this.synchronizeUsageAttribution(bridge);
    }
    return result;
  }

  /** Performs a provider-only route transaction; it never reads or writes auth.json. */
  async switchGatewayRoute(
    route: "gateway" | "chatgpt",
    accountId?: string,
    options: RuntimeAccountSwitchOptions = {}
  ): Promise<HotSwitchAccountResult> {
    if (!isHotSwitchEnabled()) {
      throw new Error("Codex hot switch is not enabled");
    }
    if (!this.bridge) {
      throw new Error(
        "Codex hot switch is enabled, but its runtime is not ready; reload once before switching providers"
      );
    }
    let chatgptAccessToken: string | undefined;
    let chatgptAccountId: string | undefined;
    let chatgptLocalAccountId: string | undefined;
    let chatgptExpectedEmail: string | undefined;
    let chatgptPlanType: string | null | undefined;
    const state = this.getGatewayRuntimeState();
    if (route === "chatgpt" && state?.config.autoFallbackToChatGpt !== true) {
      // The non-fallback provider uses a private adapter bearer for Gateway
      // requests. When returning to ChatGPT, hand the already-preserved OAuth
      // bearer to the resident shim transiently; it is never persisted there.
      const accounts = await this.repo.listAccounts();
      const oauthAccount = accounts.find((account) => account.isActive && !isSub2ApiAccount(account));
      if (oauthAccount) {
        const tokens = await this.repo.getTokens(oauthAccount.id, { syncExternal: false });
        chatgptAccessToken = tokens?.accessToken;
        chatgptLocalAccountId = oauthAccount.id;
        chatgptAccountId = oauthAccount.accountId ?? tokens?.accountId;
        chatgptExpectedEmail = oauthAccount.email;
        chatgptPlanType = oauthAccount.planType ?? null;
      } else {
        // An unmanaged auth.json session may still be the preserved OAuth
        // route when the user has not imported it into the saved account list.
        // Carry that bearer only for the return transaction; never persist it
        // as a virtual account token.
        const auth = await readAuthFile();
        chatgptAccessToken = auth?.tokens?.access_token;
        if (auth?.tokens) {
          const claims = extractClaims(auth.tokens.id_token, auth.tokens.access_token);
          chatgptAccountId = auth.tokens.account_id ?? claims?.accountId;
          chatgptExpectedEmail = claims?.email;
          chatgptPlanType = claims?.planType ?? null;
        }
      }
      if (!chatgptAccessToken) {
        throw new Error("The preserved ChatGPT Auth account has no usable access token for the return route");
      }
    }
    const result = await this.bridge.switchGatewayRoute({
      operationId: options.operationId,
      route,
      accountId,
      chatgptAccessToken,
      chatgptAccountId,
      chatgptLocalAccountId,
      chatgptExpectedEmail,
      chatgptPlanType,
      gracePeriodMs: options.gracePeriodMs ?? getHotSwitchGraceSeconds() * 1_000,
      longTurnPolicy: options.longTurnPolicy ?? getHotSwitchLongTurnPolicy()
    });
    if (result.status === "switched") {
      if (route === "gateway") {
        this.cancelUsageAttributionRetry();
        this.usageAttributionFailureReason = "gateway_route_active";
      } else {
        this.usageAttributionFailureReason = "not_activated";
        void this.synchronizeUsageAttribution(this.bridge);
      }
      const state = this.getGatewayRuntimeState();
      if (state) {
        await this.setGatewayRuntimeState({ config: state.config, active: route === "gateway" });
      }
      if (route === "chatgpt") {
        await this.repo.switchProviderRoute();
      }
    }
    return result;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.invalidateUsageAttributionSynchronization();
    this.cancelUsageAttributionRetry();
    this.bridge?.dispose();
    this.bridge = undefined;
    for (const rollbackContextId of this.unmanagedRollbackSnapshots.keys()) {
      this.releaseUnmanagedRollbackSnapshot(rollbackContextId);
    }
  }

  private async configureRuntime(): Promise<HotSwitchSetupResult> {
    let installedRemoteOverlay: { cliPath: string; launcherPath: string } | undefined;
    try {
      if (process.platform === "win32") {
        throw new Error("Experimental Codex account hot switch is not yet supported on Windows");
      }
      const cliPath = await resolveOpenAiCodexCliPath();
      const runtimeDirectory = path.join(this.context.globalStorageUri.fsPath, RUNTIME_DIRECTORY);
      const shimSource = this.context.asAbsolutePath(path.join("runtime", SHIM_FILE));
      const shimDestination = path.join(runtimeDirectory, SHIM_FILE);
      const launcherDestination = path.join(runtimeDirectory, SHIM_LAUNCHER_FILE);
      const shimConfigDestination = path.join(runtimeDirectory, SHIM_CONFIG_FILE);
      const usageAttributionDirectory = path.join(runtimeDirectory, USAGE_ATTRIBUTION_DIRECTORY);
      const gatewayState = this.getGatewayRuntimeState();
      const gateway = gatewayState ? { ...gatewayState.config, active: gatewayState.active } : undefined;

      await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
      await fs.mkdir(usageAttributionDirectory, { recursive: true, mode: 0o700 });
      await fs.copyFile(shimSource, shimDestination);
      await fs.chmod(shimDestination, 0o700);
      await writePosixLauncher(launcherDestination, process.execPath, shimDestination);
      const configuredCliPath = vscode.workspace.getConfiguration("chatgpt").get<string | null>("cliExecutable", null);
      if (isRemoteExtensionHost() && configuredCliPath?.trim()) {
        throw new Error(
          "Remove chatgpt.cliExecutable from every local VS Code User Settings JSON before enabling seamless switching on a remote host"
        );
      }
      const remoteOverlay = isRemoteExtensionHost()
        ? await installRemoteCliOverlay(cliPath, launcherDestination)
        : undefined;
      if (remoteOverlay?.installed) {
        installedRemoteOverlay = remoteOverlay;
      }
      const realCliPath = remoteOverlay?.realCliPath ?? cliPath;
      await writeJsonAtomically(
        shimConfigDestination,
        {
          realCliPath,
          forceHttpTransport: true,
          forceFastMode: isForceFastModeEnabled(),
          usageAttributionDirectory,
          gateway
        },
        0o600
      );

      let requiresReload = false;
      if (isRemoteExtensionHost()) {
        requiresReload = remoteOverlay?.installed === true;
      } else {
        const chatgptConfig = vscode.workspace.getConfiguration("chatgpt");
        const currentCliPath = chatgptConfig.get<string | null>("cliExecutable", null);
        if (currentCliPath !== launcherDestination) {
          if (this.context.globalState.get<string | null>(PREVIOUS_CLI_SETTING_KEY) === undefined) {
            await this.context.globalState.update(PREVIOUS_CLI_SETTING_KEY, currentCliPath);
          }
          await chatgptConfig.update("cliExecutable", launcherDestination, vscode.ConfigurationTarget.Global);
          requiresReload = true;
        }
      }

      this.invalidateUsageAttributionSynchronization();
      this.cancelUsageAttributionRetry();
      this.usageAttributionFailureReason = "not_activated";
      this.bridge?.dispose();
      this.bridge = undefined;
      if (!requiresReload) {
        const candidateBridge = new CodexHotSwitchBridge(
          (request) => this.refreshRuntimeAuth(request),
          (localAccountId) => this.activateLocalAccount(localAccountId),
          (rollbackContextId) => this.restoreUnmanagedAccount(rollbackContextId)
        );
        let runtimeStatusChecked = false;
        if (isOpenAiCodexExtensionActive()) {
          try {
            const status = await candidateBridge.getStatus();
            runtimeStatusChecked = true;
            requiresReload =
              status.runtimeProtocolVersion !== RUNTIME_PROTOCOL_VERSION ||
              status.httpTransportForced !== true ||
              status.gatewayConfigured !== Boolean(gatewayState) ||
              status.gatewayActive !== Boolean(gatewayState?.active) ||
              status.gatewayAutoFallbackEnabled !== Boolean(gatewayState?.config.autoFallbackToChatGpt) ||
              status.gatewayBaseUrl !== gateway?.baseUrl ||
              status.gatewayModel !== gateway?.model;
          } catch {
            // The official extension may be active before its app-server is
            // started. Keep the bridge lazy so the first later request can
            // connect to the shim; the remote overlay itself already tells us
            // whether a reload is needed.
          }
        }
        if (requiresReload) {
          candidateBridge.dispose();
        } else {
          this.bridge = candidateBridge;
          if (runtimeStatusChecked) {
            await candidateBridge.configureFastMode(isForceFastModeEnabled());
          }
          if (!gatewayState || gatewayState.active === false) {
            if (gatewayState?.config.autoFallbackToChatGpt !== true && gatewayState?.active === false) {
              await this.synchronizeChatGptRoute();
            }
            void this.synchronizeUsageAttribution(candidateBridge);
          }
        }
      }
      return {
        enabled: true,
        configured: !requiresReload,
        requiresReload,
        shimPath: launcherDestination
      };
    } catch (error) {
      if (installedRemoteOverlay) {
        await restoreRemoteCliOverlay(installedRemoteOverlay.cliPath, installedRemoteOverlay.launcherPath).catch(
          () => undefined
        );
      }
      return {
        enabled: true,
        configured: false,
        requiresReload: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Rehydrates the transient OAuth handoff after the app-server is restarted.
   * The non-fallback Gateway adapter uses its own bearer, so leaving the
   * adapter on the ChatGPT route would forward that bearer to chatgpt.com.
   */
  private async synchronizeChatGptRoute(): Promise<void> {
    try {
      const result = await this.switchGatewayRoute("chatgpt", undefined, {
        gracePeriodMs: 0,
        longTurnPolicy: "defer"
      });
      if (result.status !== "switched") {
        console.warn(`[codexAccounts] ChatGPT route initialization deferred with ${result.activeTurns} active turn(s)`);
      }
    } catch (error) {
      console.warn("[codexAccounts] ChatGPT route initialization skipped", error);
    }
  }

  private async synchronizeUsageAttribution(bridge: CodexHotSwitchBridge): Promise<void> {
    if (this.disposed || this.bridge !== bridge) {
      return;
    }
    if (this.usageAttributionSyncInFlight) {
      return this.usageAttributionSyncInFlight;
    }
    const generation = this.usageAttributionSyncGeneration;

    const attempt = (async () => {
      try {
        const identity = await bridge.getIdentity();
        if (identity.accountType !== "chatgpt" || !identity.email) {
          throw new Error("The runtime ChatGPT identity is not ready for usage attribution");
        }

        const accounts = await this.repo.listAccounts();
        const account = selectManagedAccountForUsageAttribution(accounts, identity);
        if (!account) {
          throw new Error("No managed account matches the runtime identity for usage attribution");
        }

        const tokens = await this.repo.getTokens(account.id, { syncExternal: false });
        const remoteAccountId = account.accountId ?? tokens?.accountId;
        if (!remoteAccountId) {
          throw new Error("The managed account has no workspace identifier for usage attribution");
        }
        if (identity.managedAccountId && identity.managedAccountId !== remoteAccountId) {
          throw new Error("The runtime identity does not match the managed account for usage attribution");
        }

        await bridge.activateUsageAttribution({
          localAccountId: account.id,
          accountId: remoteAccountId,
          expectedEmail: account.email
        });
        this.usageAttributionFailureReason = null;
        this.cancelUsageAttributionRetry();
      } catch (error) {
        if (this.disposed || this.bridge !== bridge) {
          return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        this.usageAttributionFailureReason = reason.slice(0, 512) || "Usage attribution activation failed";
        // Attribution is observational. Keep retrying after the runtime has
        // settled, without reconstructing historical un-attributed events.
        console.warn(`[codexAccounts] token usage attribution inactive: ${this.usageAttributionFailureReason}`);
        this.scheduleUsageAttributionRetry(bridge);
      } finally {
        if (this.usageAttributionSyncGeneration === generation) {
          this.usageAttributionSyncInFlight = undefined;
        }
      }
    })();
    this.usageAttributionSyncInFlight = attempt;
    return attempt;
  }

  private scheduleUsageAttributionRetry(bridge: CodexHotSwitchBridge): void {
    if (this.disposed || this.bridge !== bridge || this.usageAttributionRetryTimer) {
      return;
    }
    const timer = setTimeout(() => {
      if (this.usageAttributionRetryTimer === timer) {
        this.usageAttributionRetryTimer = undefined;
      }
      void this.synchronizeUsageAttribution(bridge);
    }, USAGE_ATTRIBUTION_RETRY_DELAY_MS);
    timer.unref?.();
    this.usageAttributionRetryTimer = timer;
  }

  private cancelUsageAttributionRetry(): void {
    if (!this.usageAttributionRetryTimer) {
      return;
    }
    clearTimeout(this.usageAttributionRetryTimer);
    this.usageAttributionRetryTimer = undefined;
  }

  private invalidateUsageAttributionSynchronization(): void {
    this.usageAttributionSyncGeneration += 1;
    this.usageAttributionSyncInFlight = undefined;
  }

  private async refreshRuntimeAuth(request: HotSwitchRefreshRequest): Promise<HotSwitchRefreshResult> {
    const accounts = await this.repo.listAccounts();
    const account = selectManagedAccountForRefresh(accounts, request, getCurrentWindowRuntimeAccountId());

    let tokens = await this.repo.getTokens(account.id);
    if (!tokens?.accessToken) {
      throw new Error("The managed account has no access token");
    }
    if (needsRefresh(tokens.accessToken, TOKEN_REFRESH_SKEW_SECONDS)) {
      tokens = await this.refreshAccountTokens(account, tokens);
    }
    resolveRuntimeAccessTokenIdentity(account, tokens.accessToken);

    const remoteAccountId = account.accountId ?? tokens.accountId;
    if (!remoteAccountId) {
      throw new Error("The managed account has no ChatGPT workspace identifier");
    }
    if (request.previousAccountId && remoteAccountId !== request.previousAccountId) {
      throw new Error("The managed account does not match the Codex workspace refresh request");
    }
    return {
      accessToken: tokens.accessToken,
      chatgptAccountId: remoteAccountId,
      chatgptPlanType: account.planType ?? null
    };
  }

  private async activateLocalAccount(localAccountId: string): Promise<void> {
    // RuntimeSwitchCoordinator already owns the shared runtime-switch lease
    // for the bridge transaction; do not try to acquire the same lease again.
    await this.repo.switchAccount(localAccountId, { runtimeLeaseHeld: true });
    setCurrentWindowRuntimeAccountId(localAccountId);
  }

  private async withUnmanagedRollbackSnapshot<T>(
    execute: (snapshot: CapturedUnmanagedRollbackSnapshot, rollbackContextId: string) => Promise<T>
  ): Promise<T> {
    const snapshot = await this.captureUnmanagedRollbackSnapshot();
    const rollbackContextId = randomUUID();
    this.unmanagedRollbackSnapshots.set(rollbackContextId, { tokens: snapshot.tokens });
    try {
      const result = await execute(snapshot, rollbackContextId);
      this.releaseUnmanagedRollbackSnapshot(rollbackContextId);
      return result;
    } catch (error) {
      if (isHotSwitchOperationUncertainError(error)) {
        this.retainUnmanagedRollbackSnapshot(rollbackContextId);
      } else {
        this.releaseUnmanagedRollbackSnapshot(rollbackContextId);
      }
      throw error;
    }
  }

  private retainUnmanagedRollbackSnapshot(rollbackContextId: string): void {
    const snapshot = this.unmanagedRollbackSnapshots.get(rollbackContextId);
    if (!snapshot || snapshot.cleanupTimer) {
      return;
    }
    snapshot.cleanupTimer = setTimeout(() => {
      this.releaseUnmanagedRollbackSnapshot(rollbackContextId);
    }, UNMANAGED_ROLLBACK_SNAPSHOT_TTL_MS);
    snapshot.cleanupTimer.unref?.();
  }

  private releaseUnmanagedRollbackSnapshot(rollbackContextId: string): void {
    const snapshot = this.unmanagedRollbackSnapshots.get(rollbackContextId);
    if (!snapshot) {
      return;
    }
    if (snapshot.cleanupTimer) {
      clearTimeout(snapshot.cleanupTimer);
    }
    this.unmanagedRollbackSnapshots.delete(rollbackContextId);
  }

  private async captureUnmanagedRollbackSnapshot(): Promise<CapturedUnmanagedRollbackSnapshot> {
    const auth = await readAuthFile();
    if (!auth?.tokens?.id_token || !auth.tokens.access_token) {
      throw new Error("The current Codex auth.json has no usable OAuth credentials for safe rollback");
    }

    let tokens: CodexTokens = {
      idToken: auth.tokens.id_token,
      accessToken: auth.tokens.access_token,
      refreshToken: auth.tokens.refresh_token,
      accountId: auth.tokens.account_id
    };
    if (needsRefresh(tokens.accessToken, TOKEN_REFRESH_SKEW_SECONDS)) {
      if (!tokens.refreshToken) {
        throw new Error("The current Codex auth.json token expires too soon and has no refresh token for rollback");
      }
      const refreshed = await refreshTokens(tokens.refreshToken, tokens.idToken);
      tokens = {
        ...refreshed,
        accountId: refreshed.accountId ?? tokens.accountId
      };
      await writeAuthFile(tokens);
    }

    const claims = extractClaims(tokens.idToken, tokens.accessToken);
    const email = claims.email?.trim();
    const accountId = tokens.accountId ?? claims.accountId;
    if (!email || !accountId) {
      throw new Error("The current Codex auth.json identity cannot be identified for safe rollback");
    }

    const liveIdentity = await this.getIdentity();
    if (liveIdentity.accountType !== "chatgpt" || !liveIdentity.email) {
      throw new Error("The current Codex runtime has no ChatGPT identity for safe rollback");
    }
    if (normalizeEmail(liveIdentity.email) !== normalizeEmail(email)) {
      throw new Error("The current Codex runtime identity differs from auth.json; refusing an unsafe switch");
    }
    if (liveIdentity.managedAccountId && liveIdentity.managedAccountId !== accountId) {
      throw new Error("The current Codex runtime workspace differs from auth.json; refusing an unsafe switch");
    }

    return {
      tokens,
      accountId,
      email,
      planType: liveIdentity.planType ?? claims.planType ?? null
    };
  }

  private async restoreUnmanagedAccount(rollbackContextId: string): Promise<void> {
    const snapshot = this.unmanagedRollbackSnapshots.get(rollbackContextId);
    if (!snapshot) {
      throw new Error("The unmanaged Codex rollback snapshot is no longer available");
    }
    await writeAuthFile(snapshot.tokens);
    await this.repo.syncActiveAccountFromAuthFile();
    setCurrentWindowRuntimeAccountId(undefined);
    this.releaseUnmanagedRollbackSnapshot(rollbackContextId);
  }

  private async refreshAccountTokens(account: CodexAccountRecord, tokens: CodexTokens): Promise<CodexTokens> {
    if (!tokens.refreshToken) {
      throw new Error("The managed account token expired and has no refresh token");
    }
    const refreshed = await refreshTokens(tokens.refreshToken, tokens.idToken);
    const effectiveTokens = {
      ...refreshed,
      accountId: refreshed.accountId ?? account.accountId ?? tokens.accountId
    };
    await this.repo.updateTokens(account.id, effectiveTokens);
    return effectiveTokens;
  }

  private getGatewayRuntimeState(): GatewayRuntimeState | undefined {
    // Some narrow test/embedding hosts only provide the parts of
    // ExtensionContext needed for OAuth switching. Gateway state is optional,
    // so absence of globalState must remain equivalent to Gateway being off.
    const globalState = this.context.globalState;
    if (!globalState || typeof globalState.get !== "function") {
      return undefined;
    }
    const stored = globalState.get<unknown>(GATEWAY_RUNTIME_CONFIG_KEY);
    try {
      return stored === undefined ? undefined : normalizeGatewayRuntimeState(stored);
    } catch {
      return undefined;
    }
  }

  private async setGatewayRuntimeState(state: GatewayRuntimeState | undefined): Promise<void> {
    const globalState = this.context.globalState;
    if (!globalState || typeof globalState.update !== "function") {
      throw new Error("The VS Code global state is unavailable for the Gateway runtime");
    }
    await globalState.update(
      GATEWAY_RUNTIME_CONFIG_KEY,
      state === undefined ? undefined : normalizeGatewayRuntimeState(state)
    );
  }

  private async ensureGatewayDoesNotEnableSeamlessScheduling(): Promise<void> {
    const config = getCodexAccountsConfiguration();
    const inspected = config.inspect<boolean>("seamlessSwitchEnabled");
    const explicitlyConfigured =
      inspected?.workspaceFolderValue !== undefined ||
      inspected?.workspaceValue !== undefined ||
      inspected?.globalValue !== undefined;
    if (!explicitlyConfigured) {
      await config.update("seamlessSwitchEnabled", false, vscode.ConfigurationTarget.Global);
    }
  }
}

export function selectManagedAccountForRefresh(
  accounts: readonly CodexAccountRecord[],
  request: HotSwitchRefreshRequest,
  currentLocalAccountId?: string
): CodexAccountRecord {
  let account: CodexAccountRecord | undefined;

  if (request.localAccountId) {
    account = accounts.find((candidate) => candidate.id === request.localAccountId);
    if (!account) {
      throw new Error("No managed account matches the local Codex refresh identity");
    }
  } else if (currentLocalAccountId) {
    const current = accounts.find((candidate) => candidate.id === currentLocalAccountId);
    if (!request.previousAccountId || current?.accountId === request.previousAccountId) {
      account = current;
    }
  }

  if (!account && request.previousAccountId) {
    const matches = accounts.filter((candidate) => candidate.accountId === request.previousAccountId);
    if (matches.length > 1) {
      throw new Error("The Codex workspace refresh request matches multiple managed accounts");
    }
    account = matches[0];
  }

  if (!account && !request.previousAccountId) {
    const activeAccounts = accounts.filter((candidate) => candidate.isActive);
    if (activeAccounts.length === 1) {
      account = activeAccounts[0];
    }
  }

  if (!account) {
    throw new Error("No managed account matches the Codex refresh request");
  }
  if (request.previousAccountId && account.accountId && account.accountId !== request.previousAccountId) {
    throw new Error("The managed account does not match the Codex workspace refresh request");
  }
  return account;
}

/**
 * Choose an unambiguous local record for a running app-server identity. The
 * runtime's managed local ID wins; before the first hot switch we require a
 * unique active record (or a unique email match) so duplicate imports cannot
 * silently receive each other's token usage.
 */
export function selectManagedAccountForUsageAttribution(
  accounts: readonly CodexAccountRecord[],
  identity: Pick<HotSwitchIdentity, "email" | "managedLocalAccountId">
): CodexAccountRecord | undefined {
  const runtimeEmail = identity.email ? normalizeEmail(identity.email) : undefined;
  if (!runtimeEmail) {
    return undefined;
  }

  if (identity.managedLocalAccountId) {
    const managed = accounts.find((account) => account.id === identity.managedLocalAccountId);
    return managed && normalizeEmail(managed.email) === runtimeEmail ? managed : undefined;
  }

  const matchingEmail = accounts.filter((account) => normalizeEmail(account.email) === runtimeEmail);
  const activeMatchingEmail = matchingEmail.filter((account) => account.isActive);
  if (activeMatchingEmail.length === 1) {
    return activeMatchingEmail[0];
  }
  return matchingEmail.length === 1 ? matchingEmail[0] : undefined;
}

export function resolveRuntimeAccessTokenIdentity(
  account: Pick<CodexAccountRecord, "email" | "userId">,
  accessToken: string
): RuntimeAccessTokenIdentity {
  const payload = decodeJwtPayload(accessToken);
  const auth = readObject(payload["https://api.openai.com/auth"]);
  const profile = readObject(payload["https://api.openai.com/profile"]);
  const email =
    readIdentityString(payload, "email") ??
    readIdentityString(payload, "preferred_username") ??
    readIdentityString(payload, "upn") ??
    readIdentityString(profile, "email");
  if (!email) {
    throw new Error("The managed account access token has no runtime email identity");
  }

  const userId =
    readIdentityString(auth, "chatgpt_user_id") ??
    readIdentityString(auth, "user_id") ??
    readIdentityString(payload, "sub");
  const expectedUserId = account.userId?.trim();
  if (expectedUserId) {
    if (!userId || userId !== expectedUserId) {
      throw new Error("The managed account access token belongs to a different user");
    }
  } else if (normalizeEmail(email) !== normalizeEmail(account.email)) {
    throw new Error("The managed account access token email differs and no stable user identity is available");
  }

  return { email, userId };
}

export function isHotSwitchEnabled(): boolean {
  return getCodexAccountsConfiguration().get<boolean>(HOT_SWITCH_ENABLED, false);
}

export function getHotSwitchGraceSeconds(): number {
  return normalizeHotSwitchGraceSeconds(getCodexAccountsConfiguration().get<number>(HOT_SWITCH_GRACE_SECONDS, 60));
}

export function getHotSwitchLongTurnPolicy(): HotSwitchLongTurnPolicy {
  return normalizeHotSwitchLongTurnPolicy(
    getCodexAccountsConfiguration().get<string>(HOT_SWITCH_LONG_TURN_POLICY, "defer")
  );
}

function normalizeGatewayRuntimeConfig(value: unknown): GatewayRuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Gateway runtime configuration");
  }
  const record = value as Record<string, unknown>;
  const displayName = readRuntimeString(record["displayName"], 128);
  const baseUrl = readRuntimeString(record["baseUrl"], 2_048);
  const model = readRuntimeString(record["model"], 160);
  if (!displayName || !baseUrl || !model) {
    throw new Error("Invalid Gateway runtime configuration");
  }
  const autoFallbackToChatGpt = record["autoFallbackToChatGpt"];
  if (autoFallbackToChatGpt !== undefined && typeof autoFallbackToChatGpt !== "boolean") {
    throw new Error("Invalid Gateway runtime configuration");
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Invalid Gateway runtime configuration");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.replace(/\/+$/u, "") !== "/v1"
  ) {
    throw new Error("Invalid Gateway runtime configuration");
  }

  return {
    displayName,
    baseUrl: parsed.toString().replace(/\/$/u, ""),
    model,
    ...(autoFallbackToChatGpt === true ? { autoFallbackToChatGpt: true } : {})
  };
}

/** Safe persisted state for an explicitly activated generic Gateway. */
function normalizeGatewayRuntimeState(value: unknown): GatewayRuntimeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Gateway runtime state");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["active"] !== "boolean" || !Object.prototype.hasOwnProperty.call(record, "config")) {
    throw new Error("Invalid Gateway runtime state");
  }
  return {
    config: normalizeGatewayRuntimeConfig(record["config"]),
    active: record["active"]
  };
}

function sameGatewayRuntimeConfig(left: GatewayRuntimeConfig, right: GatewayRuntimeConfig): boolean {
  return (
    left.displayName === right.displayName &&
    left.baseUrl === right.baseUrl &&
    left.model === right.model &&
    Boolean(left.autoFallbackToChatGpt) === Boolean(right.autoFallbackToChatGpt)
  );
}

function readRuntimeString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim() && value.trim().length <= maxLength ? value.trim() : undefined;
}

function isRemoteExtensionHost(): boolean {
  return typeof vscode.env.remoteName === "string" && vscode.env.remoteName.length > 0;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readIdentityString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isOpenAiCodexExtensionActive(): boolean {
  return vscode.extensions.getExtension(OPENAI_EXTENSION_ID)?.isActive === true;
}

async function resolveOpenAiCodexCliPath(): Promise<string> {
  const extension = vscode.extensions.getExtension(OPENAI_EXTENSION_ID);
  if (!extension) {
    throw new Error("The official OpenAI Codex extension is not installed");
  }

  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const architecture = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
  if (!architecture) {
    throw new Error(`Unsupported Codex architecture: ${process.arch}`);
  }
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const cliPath = path.join(extension.extensionPath, "bin", `${platform}-${architecture}`, executableName);
  await fs.access(cliPath);
  return cliPath;
}

async function writeJsonAtomically(filePath: string, value: unknown, mode: number): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, mode);
}

async function writePosixLauncher(filePath: string, nodePath: string, shimPath: string): Promise<void> {
  const contents = [
    "#!/bin/sh",
    `ELECTRON_RUN_AS_NODE=1 exec ${quotePosixArgument(nodePath)} ${quotePosixArgument(shimPath)} "$@"`,
    ""
  ].join("\n");
  await fs.writeFile(filePath, contents, { encoding: "utf8", mode: 0o700 });
  await fs.chmod(filePath, 0o700);
}

function quotePosixArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

import * as vscode from "vscode";
import { loginWithOAuth } from "../../auth";
import {
  maybeSeamlessBalanceSwitchForActiveQuota,
  refreshImportedAccountQuota,
  refreshSingleQuota
} from "../../application/accounts/quota";
import { RuntimeSwitchCoordinator, RuntimeSwitchSource } from "../../application/accounts/runtimeSwitchCoordinator";
import { registerCommands } from "../../commands";
import {
  getCodexAccountsConfiguration,
  getExternalControlPort,
  isExternalControlEnabled,
  isForceFastModeEnabled,
  isLocalImportInboxEnabled,
  isSeamlessSwitchEnabled
} from "../../infrastructure/config/extensionSettings";
import { AccountsRepository } from "../../storage";
import { AccountsStatusBarProvider } from "../../ui";
import { registerDebugOutput, runWithConcurrencyLimit, t } from "../../utils";
import { CodexHotSwitchRuntime, RuntimeAccountSwitchOptions, RuntimeAccountSwitchOutcome } from "../../codex";
import { isSub2ApiAccount, type SharedCodexAccountJson } from "../../core/types";
import { resolveAccountHealth } from "../../application/accounts/health";
import { getErrorMessage } from "../../core/errors";
import {
  importSharedAccountsIntoBalancePool,
  type BalancePoolImportSummary
} from "../../application/accounts/importIntoBalancePool";
import { initAutoSwitchRuntimeState } from "./autoSwitchState";
import { initSeamlessSwitchRuntimeState, resetSeamlessSwitchRuntimeState } from "./seamlessSwitchState";
import { enqueueLocalImportJob, LocalImportInbox, readLocalImportStatus } from "./localImportInbox";
import { LocalUsageAnalyticsService } from "../../services/localUsageAnalytics";
import { selectFreshGatewayFallbackCandidate } from "../../application/accounts/gatewayFallbackSelection";
import {
  ManagerControlServer,
  ManagerIntegrationHost,
  setActiveManagerIntegrationHost,
  type CodexAccountsIntegrationApi,
  type ManagerControlRefreshSummary,
  type OAuthAccountImportOptions,
  type OAuthAccountImportResult,
  type RegistrationBrowserOptions,
  type RegistrationBrowserResult
} from "../../integrations";
import { extractClaims } from "../../utils/jwt";
import { refreshQuotaSummaryPanel } from "../dashboard/panel";
import { WorkbenchRefreshCoordinator } from "./refreshCoordinator";
import { getTokenAutomationSnapshot } from "./tokenAutomationState";
import {
  registerAutoRefreshScheduler,
  registerSeamlessUsageLimitMonitor,
  registerTokenRefreshScheduler,
  type SeamlessUsageLimitMonitor
} from "./schedulerRegistration";
import { SessionHub, resolveSessionRegistryPath } from "../../sessions";

const TOKEN_REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_SKEW_SECONDS = 5 * 60;
const MANAGER_CONTROL_RETRY_INITIAL_DELAY_MS = 1_000;
const MANAGER_CONTROL_RETRY_MAX_DELAY_MS = 10_000;
const OPENAI_REGISTRATION_URL = "https://auth.openai.com/create-account";

export class AccountsWorkbench {
  private readonly repo: AccountsRepository;
  private readonly statusBar: AccountsStatusBarProvider;
  private readonly refreshCoordinator: WorkbenchRefreshCoordinator;
  private readonly hotSwitchRuntime: CodexHotSwitchRuntime;
  private readonly runtimeSwitchCoordinator: RuntimeSwitchCoordinator;
  private readonly localImportInbox: LocalImportInbox | undefined;
  private readonly managerControlServer: ManagerControlServer;
  private readonly sessionHub: SessionHub | undefined;
  private readonly integrationHost: ManagerIntegrationHost;
  private managerControlRetryTimer: NodeJS.Timeout | undefined;
  private managerControlRetryAttempt = 0;
  private readonly oauthImportCancellationSources = new Map<string, vscode.CancellationTokenSource>();
  private seamlessUsageLimitMonitor: SeamlessUsageLimitMonitor | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.repo = new AccountsRepository(context);
    this.statusBar = new AccountsStatusBarProvider(context, this.repo);
    this.refreshCoordinator = new WorkbenchRefreshCoordinator(context, this.repo, this.statusBar);
    this.hotSwitchRuntime = new CodexHotSwitchRuntime(context, this.repo);
    this.runtimeSwitchCoordinator = new RuntimeSwitchCoordinator(this.repo, this.hotSwitchRuntime, () =>
      isSeamlessSwitchEnabled()
    );
    this.integrationHost = new ManagerIntegrationHost(
      {
        isActive: () => this.hotSwitchRuntime.isGatewayActive(),
        isConfigured: () => this.hotSwitchRuntime.isGatewayConfigured(),
        activate: (config, credential, options) => this.hotSwitchRuntime.activateGateway(config, credential, options),
        deactivate: (options) => this.hotSwitchRuntime.deactivateGateway(options),
        configureCredential: (credential) => this.hotSwitchRuntime.configureGatewayCredential(credential),
        getStatus: () => this.hotSwitchRuntime.getGatewayStatus(),
        fallbackToChatGpt: () => this.fallbackGatewayToChatGpt()
      },
      {
        upsert: async (descriptor, displayName) => {
          await this.repo.upsertVirtualAccount(descriptor, displayName);
        },
        activate: async (accountId) => {
          await this.repo.switchProviderRoute(accountId);
        },
        deactivate: async () => {
          await this.repo.switchProviderRoute();
        }
      },
      {
        getManagedAccountEmails: async () => {
          const accounts = await this.repo.listAccounts();
          return [
            ...new Set(
              accounts
                .filter((account) => !isSub2ApiAccount(account))
                .map((account) => normalizeEmail(account.email))
                .filter((email): email is string => Boolean(email))
            )
          ];
        },
        getManagedAccountDirectory: async () => {
          const automation = getTokenAutomationSnapshot();
          const accounts = await this.repo.listAccounts();
          const managedAccounts = accounts.filter((account) => !isSub2ApiAccount(account));
          const directory: Array<{
            accountId: string;
            email: string;
            requiresReauthorization: boolean;
          } | undefined> = managedAccounts.map(() => undefined);
          await runWithConcurrencyLimit(managedAccounts, 3, async (account, index) => {
            const tokens = await this.repo.getTokens(account.id);
            directory[index] = {
              accountId: account.id,
              email: account.email,
              requiresReauthorization: resolveAccountHealth(account, tokens, automation).kind === "reauthorize"
            };
          });
          return directory.filter((entry): entry is {
            accountId: string;
            email: string;
            requiresReauthorization: boolean;
          } => entry !== undefined);
        },
        removeManagedAccount: async (accountId) => {
          const account = await this.repo.getAccount(accountId);
          if (!account) {
            throw new Error(`Codex account '${accountId}' was not found`);
          }
          if (isSub2ApiAccount(account)) {
            throw new Error("Gateway virtual accounts cannot be removed through the Mailbox integration");
          }
          await this.repo.removeAccount(accountId);
          void this.statusBar.refresh();
          void refreshQuotaSummaryPanel();
        },
        startOAuthAccountImport: (options) => this.startOAuthAccountImport(options),
        cancelOAuthAccountImport: (operationId) => this.cancelOAuthAccountImport(operationId),
        openRegistrationBrowser: (options) => this.openRegistrationBrowser(options),
        importSharedAccountsToBalancePool: (input) => this.importSharedAccountsToBalancePool(input)
      }
    );
    this.localImportInbox = isLocalImportInboxEnabled() || isExternalControlEnabled()
      ? new LocalImportInbox(this.repo, () => {
          void this.statusBar.refresh();
        })
      : undefined;
    this.sessionHub = isExternalControlEnabled()
      ? new SessionHub(resolveSessionRegistryPath())
      : undefined;
    this.managerControlServer = new ManagerControlServer({
      repo: this.repo,
      usage: new LocalUsageAnalyticsService({
        globalStoragePath: context.globalStorageUri.fsPath,
        backgroundRefreshEnabled: true
      }),
      sessionHub: this.sessionHub,
      refreshQuotas: (accountIds) => this.refreshQuotasForControl(accountIds),
      enqueueImport: (accounts) => enqueueLocalImportJob(accounts),
      getImportStatus: (jobId) => readLocalImportStatus(jobId),
      getCodexExecProviderConfig: () => this.hotSwitchRuntime.getCodexExecProviderConfig(),
      switchAccount: (accountId, options) => this.switchAccountForControl(accountId, options)
    });
  }

  async activate(): Promise<void> {
    const activationStartedAt = Date.now();
    const activationSteps: Array<{ name: string; durationMs: number }> = [];
    const measureStep = async <T>(name: string, task: () => T | Promise<T>): Promise<T> => {
      const startedAt = Date.now();
      try {
        return await task();
      } finally {
        activationSteps.push({ name, durationMs: Date.now() - startedAt });
      }
    };

    registerDebugOutput(this.context);
    initSeamlessSwitchRuntimeState(this.context);
    initAutoSwitchRuntimeState(this.context);
    await measureStep("repo.init", async () => {
      await this.repo.init();
    });
    const sessionHub = this.sessionHub;
    if (sessionHub) {
      await measureStep("sessionHub.init", () => sessionHub.init());
    }
    this.context.subscriptions.push(this.managerControlServer);
    await measureStep("managerControlServer.start", () => this.startManagerControlServer());
    await measureStep("notifyIndexHealth", async () => {
      await this.notifyIndexHealth();
    });
    await measureStep("refreshCoordinator.initObservedAuthIdentity", async () => {
      await this.refreshCoordinator.initializeObservedAuthIdentity();
    });
    const hotSwitchSetup = await measureStep("hotSwitchRuntime.initialize", () => this.hotSwitchRuntime.initialize());
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("codexAccounts.forceFastModeEnabled")) {
          return;
        }
        void this.hotSwitchRuntime.setForceFastMode(isForceFastModeEnabled()).catch((error) => {
          console.warn(`[codexAccounts] failed to update Fast mode in the active runtime: ${getErrorMessage(error)}`);
        });
      })
    );
    this.context.subscriptions.push({ dispose: () => this.repo.dispose() });
    this.context.subscriptions.push({ dispose: () => this.refreshCoordinator.dispose() });
    this.context.subscriptions.push(this.hotSwitchRuntime);
    setActiveManagerIntegrationHost(this.integrationHost);
    this.context.subscriptions.push(this.integrationHost);
    this.context.subscriptions.push(
      this.repo.onDidChangeAccounts(() => {
        this.integrationHost.notifyAccountDirectoryChanged();
      })
    );
    this.context.subscriptions.push(
      this.integrationHost.onDidChange(() => {
        void refreshQuotaSummaryPanel();
      })
    );
    if (this.localImportInbox) {
      this.context.subscriptions.push(this.localImportInbox);
    }

    const refreshers = {
      ...this.refreshCoordinator.createRefreshView(),
      switchRuntimeAccount: (
        accountId: string,
        options?: RuntimeAccountSwitchOptions,
        source: RuntimeSwitchSource = "automatic"
      ): Promise<RuntimeAccountSwitchOutcome> => this.switchRuntimeAccount(accountId, options, source)
    };
    await measureStep("registerCommands", () => {
      registerCommands(this.context, this.repo, refreshers, this.hotSwitchRuntime, {
        resetSeamlessSwitchRuntime: () => this.resetSeamlessSwitchRuntime()
      });
    });
    await measureStep("registerAuthFileWatcher", () => {
      this.context.subscriptions.push(this.refreshCoordinator.registerAuthFileWatcher(refreshers));
    });
    await measureStep("registerAutoRefreshScheduler", () => {
      this.context.subscriptions.push(
        registerAutoRefreshScheduler({
          context: this.context,
          repo: this.repo,
          onRefresh: refreshers.refresh
        })
      );
    });
    await measureStep("registerSeamlessUsageLimitMonitor", () => {
      this.seamlessUsageLimitMonitor = registerSeamlessUsageLimitMonitor({
        context: this.context,
        runtime: this.hotSwitchRuntime,
        onUsageLimitExceeded: (activeAccountId, trigger) =>
          maybeSeamlessBalanceSwitchForActiveQuota(this.repo, refreshers, {
            trigger,
            activeAccountId
          })
      });
      this.context.subscriptions.push(this.seamlessUsageLimitMonitor);
    });
    await measureStep("registerTokenRefreshScheduler", () => {
      this.context.subscriptions.push(
        registerTokenRefreshScheduler({
          context: this.context,
          repo: this.repo,
          view: refreshers,
          checkIntervalMs: TOKEN_REFRESH_CHECK_INTERVAL_MS,
          skewSeconds: TOKEN_REFRESH_SKEW_SECONDS
        })
      );
    });
    const localImportInbox = this.localImportInbox;
    if (localImportInbox) {
      await measureStep("localImportInbox.start", () => localImportInbox.start());
    }
    await measureStep("promptImportCurrentAccountIfNeeded", async () => {
      await this.refreshCoordinator.promptImportCurrentAccountIfNeeded(refreshers);
    });
    await measureStep("statusBar.refresh", async () => {
      await this.statusBar.refresh();
    });
    if (hotSwitchSetup.error) {
      void vscode.window.showWarningMessage(
        `Codex seamless-switch runtime could not be configured: ${hotSwitchSetup.error}`
      );
    } else if (hotSwitchSetup.requiresReload) {
      const reload = "Reload once";
      const later = "Later";
      void vscode.window
        .showInformationMessage(
          "The Codex seamless-switch runtime is installed. Reload this window once to activate the runtime bridge.",
          reload,
          later
        )
        .then((choice) => {
          if (choice === reload) {
            void vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        });
    }
    console.info(
      `[codexAccounts] activation completed in ${Date.now() - activationStartedAt}ms`,
      activationSteps.map((step) => `${step.name}=${step.durationMs}ms`).join(", ")
    );
  }

  dispose(): void {
    if (this.managerControlRetryTimer) {
      clearTimeout(this.managerControlRetryTimer);
      this.managerControlRetryTimer = undefined;
    }
    this.oauthImportCancellationSources.forEach((source) => {
      source.cancel();
      source.dispose();
    });
    this.oauthImportCancellationSources.clear();
    this.refreshCoordinator.dispose();
    this.hotSwitchRuntime.dispose();
    this.localImportInbox?.dispose();
    this.managerControlServer.dispose();
    setActiveManagerIntegrationHost(undefined);
    this.integrationHost.dispose();
    this.repo.dispose();
  }

  getIntegrationApi(): CodexAccountsIntegrationApi {
    return this.integrationHost.api;
  }

  private async startManagerControlServer(): Promise<void> {
    if (!isExternalControlEnabled()) {
      return;
    }
    const token = process.env["CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN"]?.trim();
    if (!token) {
      console.warn(
        "[codexAccounts] external control is enabled but CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN is not set; the local API remains disabled"
      );
      void vscode.window.showWarningMessage(
        "Manager 外部控制接口未启动：请设置 CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN 后重新加载窗口。"
      );
      return;
    }

    this.managerControlRetryAttempt = 0;
    await this.tryStartManagerControlServer(getExternalControlPort(), token);
  }

  private async tryStartManagerControlServer(port: number, token: string): Promise<void> {
    try {
      const address = await this.managerControlServer.start(port, token);
      this.managerControlRetryAttempt = 0;
      console.info(`[codexAccounts] manager control API listening on ${address.host}:${address.port}`);
    } catch (error) {
      if (isAddressInUseError(error)) {
        if (this.managerControlRetryAttempt === 0) {
          console.warn(
            `[codexAccounts] manager control port ${port} is already in use; waiting for the previous Manager host to exit before retrying`
          );
        }
        this.scheduleManagerControlRetry(port, token);
        return;
      }
      console.warn(`[codexAccounts] manager control API could not start: ${getErrorMessage(error)}`);
      void vscode.window.showWarningMessage(`Manager 外部控制接口启动失败：${describeControlError(error)}`);
    }
  }

  private scheduleManagerControlRetry(port: number, token: string): void {
    if (this.managerControlRetryTimer) {
      return;
    }
    const delay = Math.min(
      MANAGER_CONTROL_RETRY_INITIAL_DELAY_MS * 2 ** Math.min(this.managerControlRetryAttempt, 4),
      MANAGER_CONTROL_RETRY_MAX_DELAY_MS
    );
    this.managerControlRetryAttempt += 1;
    this.managerControlRetryTimer = setTimeout(() => {
      this.managerControlRetryTimer = undefined;
      void this.tryStartManagerControlServer(port, token);
    }, delay);
  }

  private async refreshQuotasForControl(accountIds?: readonly string[]): Promise<ManagerControlRefreshSummary> {
    const allAccounts = await this.repo.listAccounts();
    const requestedIds = accountIds === undefined ? undefined : new Set(accountIds);
    const unknownAccountIds =
      requestedIds === undefined
        ? []
        : [...requestedIds].filter((accountId) => !allAccounts.some((account) => account.id === accountId));
    const requestedAccounts =
      requestedIds === undefined ? allAccounts : allAccounts.filter((account) => requestedIds.has(account.id));
    const refreshableAccounts = requestedAccounts.filter((account) => !isSub2ApiAccount(account));
    const failedAccountIds = requestedAccounts
      .filter((account) => isSub2ApiAccount(account))
      .map((account) => account.id);
    let succeeded = 0;

    await runWithConcurrencyLimit(refreshableAccounts, 3, async (account) => {
      try {
        await refreshSingleQuota(this.repo, { refresh: () => undefined }, account.id, {
          announce: false,
          forceRefresh: true,
          refreshView: false,
          warnQuota: false
        });
        succeeded += 1;
      } catch {
        failedAccountIds.push(account.id);
      }
    });

    void this.statusBar.refresh();
    void refreshQuotaSummaryPanel();
    return {
      total: requestedAccounts.length + unknownAccountIds.length,
      succeeded,
      failed: failedAccountIds.length,
      unknownAccountIds,
      failedAccountIds
    };
  }

  private async switchAccountForControl(
    accountId: string,
    options: { force?: boolean; gracePeriodMs?: number; longTurnPolicy?: "defer" | "interrupt" | "interruptAndContinue" } = {}
  ): Promise<RuntimeAccountSwitchOutcome> {
    const account = await this.repo.getAccount(accountId);
    if (!account) {
      return { status: "failed", message: "The requested Manager account was not found" };
    }
    if (isSub2ApiAccount(account)) {
      return { status: "failed", message: "Gateway session switching only supports ChatGPT accounts" };
    }

    const runtimeOutcome = await this.switchRuntimeAccount(
      accountId,
      options.force
        ? {
            gracePeriodMs: 0,
            longTurnPolicy: "interruptAndContinue"
          }
        : {
            gracePeriodMs: options.gracePeriodMs,
            longTurnPolicy: options.longTurnPolicy
          },
      "external"
    );
    if (runtimeOutcome.status !== "unavailable") {
      if (options.force && runtimeOutcome.status === "switched") {
        await this.resetControlSwitchRecoveryState();
      }
      return runtimeOutcome;
    }

    const switched = await this.repo.switchAccount(accountId);
    if (options.force) {
      await this.resetControlSwitchRecoveryState();
    }
    return {
      status: "switched",
      accountId: switched.id,
      email: switched.email,
      activeTurns: 0,
      interruptedTurns: 0,
      continuedThreads: 0
    };
  }

  private async resetControlSwitchRecoveryState(): Promise<void> {
    try {
      await this.resetSeamlessSwitchRuntime();
    } catch (error) {
      console.warn(`[codexAccounts] manual Gateway switch completed but recovery cache reset failed: ${getErrorMessage(error)}`);
    }
  }

  private async startOAuthAccountImport(options: OAuthAccountImportOptions = {}): Promise<OAuthAccountImportResult> {
    const operationId = options.operationId?.trim();
    const cancellationSource = operationId ? new vscode.CancellationTokenSource() : undefined;
    if (operationId && cancellationSource) {
      this.oauthImportCancellationSources.get(operationId)?.cancel();
      this.oauthImportCancellationSources.get(operationId)?.dispose();
      this.oauthImportCancellationSources.set(operationId, cancellationSource);
    }
    const expectedEmail = normalizeEmail(options.expectedEmail);
    const clipboardText = options.clipboardText?.trim() || expectedEmail;
    if (clipboardText) {
      try {
        await vscode.env.clipboard.writeText(clipboardText);
      } catch {
        // Clipboard convenience must not block OAuth account import.
      }
    }

    try {
      throwIfOAuthImportCancelled(cancellationSource);
      const tokens = await loginWithOAuth(cancellationSource?.token);
      throwIfOAuthImportCancelled(cancellationSource);
      const claims = extractClaims(tokens.idToken, tokens.accessToken);
      const authorizedEmail = normalizeEmail(claims.email);
      if (expectedEmail && authorizedEmail !== expectedEmail) {
        throw new Error(`OAuth account does not match mailbox ${expectedEmail}. No changes were applied.`);
      }

      throwIfOAuthImportCancelled(cancellationSource);
      const account = await this.repo.upsertFromTokens(tokens, false);
      throwIfOAuthImportCancelled(cancellationSource);
      const quota = await refreshImportedAccountQuota(this.repo, account.id);
      void refreshQuotaSummaryPanel();
      return {
        accountId: account.id,
        email: account.email,
        quotaRefreshed: !quota.error,
        quotaError: quota.error?.message
      };
    } finally {
      if (operationId && this.oauthImportCancellationSources.get(operationId) === cancellationSource) {
        this.oauthImportCancellationSources.delete(operationId);
        cancellationSource?.dispose();
      }
    }
  }

  private async openRegistrationBrowser(
    options: RegistrationBrowserOptions = {}
  ): Promise<RegistrationBrowserResult> {
    const clipboardText = options.clipboardText?.trim();
    if (clipboardText) {
      try {
        await vscode.env.clipboard.writeText(clipboardText);
      } catch {
        // Copying the mailbox is a convenience and must not block opening the page.
      }
    }

    const opened = await vscode.env.openExternal(vscode.Uri.parse(OPENAI_REGISTRATION_URL));
    if (!opened) {
      throw new Error(
        "Unable to open the GPT registration page automatically. The registration page was not opened."
      );
    }
    return { opened: true };
  }

  private cancelOAuthAccountImport(operationId: string): void {
    const normalizedId = typeof operationId === "string" ? operationId.trim() : "";
    if (!normalizedId) {
      return;
    }
    const source = this.oauthImportCancellationSources.get(normalizedId);
    if (!source) {
      return;
    }
    source.cancel();
    source.dispose();
    this.oauthImportCancellationSources.delete(normalizedId);
  }

  private async importSharedAccountsToBalancePool(
    input: SharedCodexAccountJson | SharedCodexAccountJson[]
  ): Promise<BalancePoolImportSummary> {
    const result = await importSharedAccountsIntoBalancePool(this.repo, input);
    void this.statusBar.refresh();
    void refreshQuotaSummaryPanel();
    return result;
  }

  private async fallbackGatewayToChatGpt(): Promise<RuntimeAccountSwitchOutcome> {
    const excludedAccountIds = new Set<string>();
    const refreshedAccountIds = new Set<string>();
    let lastCandidateFailure: string | undefined;
    try {
      const maximumCandidateAttempts = (await this.repo.listAccounts()).length;
      for (let candidateAttempt = 0; candidateAttempt < maximumCandidateAttempts; candidateAttempt += 1) {
        const candidate = await selectFreshGatewayFallbackCandidate(
          {
            listAccounts: () => this.repo.listAccounts(),
            refreshQuota: (accountId) =>
              refreshSingleQuota(this.repo, { refresh: () => undefined }, accountId, {
                announce: false,
                forceRefresh: true,
                refreshView: false,
                warnQuota: false
              })
          },
          getCodexAccountsConfiguration(),
          { excludedAccountIds, refreshedAccountIds }
        );
        if (!candidate) {
          break;
        }
        excludedAccountIds.add(candidate.id);
        try {
          const tokens = await this.repo.getTokens(candidate.id);
          if (!tokens?.accessToken) {
            lastCandidateFailure = "The selected fallback account has no usable Codex credentials";
            continue;
          }
          return await this.runtimeSwitchCoordinator.fallbackGatewayToChatGpt(candidate.id);
        } catch (error) {
          lastCandidateFailure = error instanceof Error ? error.message : String(error);
        }
      }
    } finally {
      void this.statusBar.refresh();
      void refreshQuotaSummaryPanel();
    }
    return {
      status: "failed",
      message:
        lastCandidateFailure === undefined
          ? "No eligible ChatGPT Auth account completed the mandatory quota refresh for Gateway fallback"
          : `No eligible ChatGPT Auth fallback completed safely: ${lastCandidateFailure}`
    };
  }

  private async resetSeamlessSwitchRuntime(): Promise<void> {
    resetSeamlessSwitchRuntimeState();
    if (this.seamlessUsageLimitMonitor) {
      await this.seamlessUsageLimitMonitor.reset();
      return;
    }
    await this.hotSwitchRuntime.resetUsageLimitObservation();
  }

  private async switchRuntimeAccount(
    accountId: string,
    options: RuntimeAccountSwitchOptions | undefined,
    source: RuntimeSwitchSource
  ): Promise<RuntimeAccountSwitchOutcome> {
    const account = await this.repo.getAccount(accountId);
    if (account && isSub2ApiAccount(account)) {
      if (source !== "manual") {
        return { status: "suppressed", reason: "gatewayActive" };
      }
      return this.runtimeSwitchCoordinator.runProviderSwitch(options, (transactionOptions) =>
        this.integrationHost.switchVirtualAccount(accountId, transactionOptions)
      );
    }
    if (source === "manual" && this.hotSwitchRuntime.isGatewayActive()) {
      const gatewayAccount = (await this.repo.listAccounts()).find(
        (candidate) => isSub2ApiAccount(candidate) && candidate.providerActive
      );
      if (!gatewayAccount) {
        return {
          status: "failed",
          message: "The Gateway route is active, but its selected virtual account is unavailable"
        };
      }
      return this.runtimeSwitchCoordinator.returnFromGatewayAndSwitchAccount(accountId, options, (transactionOptions) =>
        this.integrationHost.deactivateVirtualAccount(gatewayAccount.id, transactionOptions)
      );
    }
    return this.runtimeSwitchCoordinator.switchAccount(accountId, options, source);
  }

  private async notifyIndexHealth(): Promise<void> {
    const summary = await this.repo.getIndexHealthSummary();
    const translate = t();
    if (summary.status === "restored_from_backup") {
      void vscode.window.showInformationMessage(translate("message.indexAutoRestored"));
      return;
    }

    if (summary.status === "corrupted_unrecoverable") {
      void vscode.window.showWarningMessage(translate("message.indexRecoveryFailed"));
    }
  }
}

function throwIfOAuthImportCancelled(source: vscode.CancellationTokenSource | undefined): void {
  if (source?.token.isCancellationRequested) {
    throw new Error("OAuth login cancelled by user.");
  }
}

function normalizeEmail(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function describeControlError(error: unknown): string {
  return getErrorMessage(error);
}

function isAddressInUseError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE");
}

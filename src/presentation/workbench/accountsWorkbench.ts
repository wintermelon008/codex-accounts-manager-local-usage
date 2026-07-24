import * as vscode from "vscode";
import { maybeSeamlessBalanceSwitchForActiveQuota, refreshSingleQuota } from "../../application/accounts/quota";
import { registerCommands } from "../../commands";
import {
  getCodexAccountsConfiguration,
  isLocalImportInboxEnabled,
  isSeamlessSwitchEnabled,
  isSub2ApiGatewayEnabled
} from "../../infrastructure/config/extensionSettings";
import { AccountsRepository } from "../../storage";
import { AccountsStatusBarProvider } from "../../ui";
import { registerDebugOutput, t } from "../../utils";
import { CodexHotSwitchRuntime, RuntimeAccountSwitchOptions, RuntimeAccountSwitchOutcome } from "../../codex";
import { initAutoSwitchRuntimeState } from "./autoSwitchState";
import { initSeamlessSwitchRuntimeState } from "./seamlessSwitchState";
import { LocalImportInbox } from "./localImportInbox";
import { Sub2ApiGatewayController } from "../../local/sub2apiGateway/controller";
import { selectFreshSub2ApiGatewayFallbackCandidate } from "../../local/sub2apiGateway/fallbackSelection";
import { setSub2ApiGatewayController } from "../../local/sub2apiGateway/registry";
import { refreshQuotaSummaryPanel } from "../dashboard/panel";
import { WorkbenchRefreshCoordinator } from "./refreshCoordinator";
import {
  registerAutoRefreshScheduler,
  registerSeamlessUsageLimitMonitor,
  registerTokenRefreshScheduler
} from "./schedulerRegistration";

const TOKEN_REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_SKEW_SECONDS = 5 * 60;

export class AccountsWorkbench {
  private readonly repo: AccountsRepository;
  private readonly statusBar: AccountsStatusBarProvider;
  private readonly refreshCoordinator: WorkbenchRefreshCoordinator;
  private readonly hotSwitchRuntime: CodexHotSwitchRuntime;
  private readonly localImportInbox: LocalImportInbox | undefined;
  private sub2apiGateway: Sub2ApiGatewayController | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.repo = new AccountsRepository(context);
    this.statusBar = new AccountsStatusBarProvider(context, this.repo);
    this.refreshCoordinator = new WorkbenchRefreshCoordinator(context, this.repo, this.statusBar);
    this.hotSwitchRuntime = new CodexHotSwitchRuntime(context, this.repo);
    this.localImportInbox = isLocalImportInboxEnabled()
      ? new LocalImportInbox(this.repo, () => {
          void this.statusBar.refresh();
        })
      : undefined;
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
    await measureStep("notifyIndexHealth", async () => {
      await this.notifyIndexHealth();
    });
    await measureStep("refreshCoordinator.initObservedAuthIdentity", async () => {
      await this.refreshCoordinator.initializeObservedAuthIdentity();
    });
    const hotSwitchSetup = await measureStep("hotSwitchRuntime.initialize", () => this.hotSwitchRuntime.initialize());
    this.context.subscriptions.push({ dispose: () => this.repo.dispose() });
    this.context.subscriptions.push({ dispose: () => this.refreshCoordinator.dispose() });
    this.context.subscriptions.push(this.hotSwitchRuntime);
    if (this.localImportInbox) {
      this.context.subscriptions.push(this.localImportInbox);
    }
    await measureStep("sub2apiGateway.initialize", () => this.updateSub2ApiGatewayFeature());
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("codexAccounts.sub2apiGatewayEnabled") ||
          event.affectsConfiguration("codexAccounts.sub2apiGatewayConfigFile")
        ) {
          void this.updateSub2ApiGatewayFeature();
        }
      })
    );

    const refreshers = {
      ...this.refreshCoordinator.createRefreshView(),
      switchRuntimeAccount: (
        accountId: string,
        options?: RuntimeAccountSwitchOptions
      ): Promise<RuntimeAccountSwitchOutcome> =>
        routeRuntimeAccountSwitch(accountId, this.hotSwitchRuntime, isSeamlessSwitchEnabled(), options)
    };
    await measureStep("registerCommands", () => {
      registerCommands(this.context, this.repo, refreshers, this.hotSwitchRuntime);
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
      this.context.subscriptions.push(
        registerSeamlessUsageLimitMonitor({
          context: this.context,
          runtime: this.hotSwitchRuntime,
          onUsageLimitExceeded: (activeAccountId, trigger) =>
            maybeSeamlessBalanceSwitchForActiveQuota(this.repo, refreshers, {
              trigger,
              activeAccountId
            })
        })
      );
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
    this.refreshCoordinator.dispose();
    this.hotSwitchRuntime.dispose();
    this.localImportInbox?.dispose();
    this.sub2apiGateway?.dispose();
    this.sub2apiGateway = undefined;
    setSub2ApiGatewayController(undefined);
    this.repo.dispose();
  }

  private async updateSub2ApiGatewayFeature(): Promise<void> {
    if (!isSub2ApiGatewayEnabled()) {
      const previous = this.sub2apiGateway;
      this.sub2apiGateway = undefined;
      setSub2ApiGatewayController(undefined);
      if (previous) {
        await previous.disableFeature();
      }
      await refreshQuotaSummaryPanel();
      return;
    }

    const previous = this.sub2apiGateway;
    if (previous) {
      previous.dispose();
    }
    const gateway = new Sub2ApiGatewayController(
      this.context,
      this.hotSwitchRuntime,
      () => {
        void refreshQuotaSummaryPanel();
      },
      () => this.fallbackSub2ApiGatewayToChatGpt()
    );
    this.sub2apiGateway = gateway;
    setSub2ApiGatewayController(gateway);
    await gateway.initialize();
    await refreshQuotaSummaryPanel();
  }

  private async fallbackSub2ApiGatewayToChatGpt(): Promise<RuntimeAccountSwitchOutcome> {
    const excludedAccountIds = new Set<string>();
    const refreshedAccountIds = new Set<string>();
    let lastCandidateFailure: string | undefined;
    try {
      const maximumCandidateAttempts = (await this.repo.listAccounts()).length;
      for (let candidateAttempt = 0; candidateAttempt < maximumCandidateAttempts; candidateAttempt += 1) {
        const candidate = await selectFreshSub2ApiGatewayFallbackCandidate(
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
          return await this.hotSwitchRuntime.fallbackSub2ApiGatewayToChatGpt(candidate.id);
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
          ? "No eligible ChatGPT Auth account completed the mandatory quota refresh for Sub2API fallback"
          : `No eligible ChatGPT Auth fallback completed safely: ${lastCandidateFailure}`
    };
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

export async function routeRuntimeAccountSwitch(
  accountId: string,
  runtime: Pick<CodexHotSwitchRuntime, "isEnabled" | "switchAccount">,
  seamlessSwitchEnabled: boolean,
  options?: RuntimeAccountSwitchOptions
): Promise<RuntimeAccountSwitchOutcome> {
  if (!seamlessSwitchEnabled) {
    return { status: "unavailable" };
  }
  if (!runtime.isEnabled()) {
    return {
      status: "failed",
      message: "Seamless Switching is enabled, but its runtime is not installed"
    };
  }
  try {
    return options ? await runtime.switchAccount(accountId, options) : await runtime.switchAccount(accountId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[codexAccounts] hot switch failed without changing the persisted active account:", message);
    return { status: "failed", message };
  }
}

import * as vscode from "vscode";
import { registerCommands } from "../../commands";
import { isSeamlessSwitchEnabled } from "../../infrastructure/config/extensionSettings";
import { AccountsRepository } from "../../storage";
import { AccountsStatusBarProvider } from "../../ui";
import { registerDebugOutput, t } from "../../utils";
import { CodexHotSwitchRuntime, RuntimeAccountSwitchOutcome } from "../../codex";
import { initAutoSwitchRuntimeState } from "./autoSwitchState";
import { initSeamlessSwitchRuntimeState } from "./seamlessSwitchState";
import { WorkbenchRefreshCoordinator } from "./refreshCoordinator";
import { promptForManualHotSwitchConfiguration } from "./hotSwitchSetup";
import { registerAutoRefreshScheduler, registerTokenRefreshScheduler } from "./schedulerRegistration";

const TOKEN_REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_SKEW_SECONDS = 5 * 60;

export class AccountsWorkbench {
  private readonly repo: AccountsRepository;
  private readonly statusBar: AccountsStatusBarProvider;
  private readonly refreshCoordinator: WorkbenchRefreshCoordinator;
  private readonly hotSwitchRuntime: CodexHotSwitchRuntime;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.repo = new AccountsRepository(context);
    this.statusBar = new AccountsStatusBarProvider(context, this.repo);
    this.refreshCoordinator = new WorkbenchRefreshCoordinator(context, this.repo, this.statusBar);
    this.hotSwitchRuntime = new CodexHotSwitchRuntime(context, this.repo);
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

    const refreshers = {
      ...this.refreshCoordinator.createRefreshView(),
      switchRuntimeAccount: (accountId: string): Promise<RuntimeAccountSwitchOutcome> =>
        routeRuntimeAccountSwitch(accountId, this.hotSwitchRuntime, isSeamlessSwitchEnabled())
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
    } else if (hotSwitchSetup.requiresUserConfiguration) {
      void promptForManualHotSwitchConfiguration(hotSwitchSetup, "enable");
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
    this.repo.dispose();
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
  seamlessSwitchEnabled: boolean
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
    return await runtime.switchAccount(accountId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[codexAccounts] hot switch failed without changing the persisted active account:", message);
    return { status: "failed", message };
  }
}

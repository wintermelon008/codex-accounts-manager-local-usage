import * as vscode from "vscode";
import { AccountsCommandService } from "../application/accounts/commandService";
export { refreshImportedAccountQuota } from "../application/accounts/quota";
import { CodexAccountRecord } from "../core/types";
import { AccountsRepository } from "../storage";
import { CodexHotSwitchRuntime, RuntimeAccountSwitchOptions, RuntimeAccountSwitchOutcome } from "../codex";
import type { RuntimeSwitchSource } from "../application/accounts/runtimeSwitchCoordinator";

/**
 * 注册所有命令
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  repo: AccountsRepository,
  view: {
    refresh(): void;
    markObservedAuthIdentity?: (accountId?: string) => void;
    switchRuntimeAccount?: (
      accountId: string,
      options?: RuntimeAccountSwitchOptions,
      source?: RuntimeSwitchSource
    ) => Promise<RuntimeAccountSwitchOutcome>;
  },
  hotSwitchRuntime: CodexHotSwitchRuntime,
  options: { resetSeamlessSwitchRuntime?: () => void | Promise<void> } = {}
): void {
  const service = new AccountsCommandService(context, repo, view, hotSwitchRuntime);

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAccounts.addAccount", () => service.addAccount()),
    vscode.commands.registerCommand("codexAccounts.enableHotSwitch", () => service.enableHotSwitch()),
    vscode.commands.registerCommand("codexAccounts.importCurrentAuth", () => service.importCurrentAuth()),
    vscode.commands.registerCommand("codexAccounts.reauthorizeAccount", (item?: CodexAccountRecord) =>
      service.reauthorizeAccount(item)
    ),
    vscode.commands.registerCommand("codexAccounts.switchAccount", (item?: CodexAccountRecord) =>
      service.switchAccount(item)
    ),
    vscode.commands.registerCommand("codexAccounts.refreshQuota", (item?: CodexAccountRecord) =>
      service.refreshQuota(item)
    ),
    vscode.commands.registerCommand(
      "codexAccounts.refreshAllQuotas",
      (options?: { silent?: boolean; forceRefresh?: boolean; accountIds?: string[] }) =>
        service.refreshAllQuotas(options)
    ),
    vscode.commands.registerCommand("codexAccounts.restoreAccountsFromBackup", () =>
      service.restoreAccountsFromBackup()
    ),
    vscode.commands.registerCommand("codexAccounts.restoreAccountsFromAuthJson", () =>
      service.restoreAccountsFromAuthJson()
    ),
    vscode.commands.registerCommand("codexAccounts.restoreAccountsFromSharedJson", () =>
      service.restoreAccountsFromSharedJson()
    ),
    vscode.commands.registerCommand("codexAccounts.removeAccount", (item?: CodexAccountRecord) =>
      service.removeAccount(item)
    ),
    vscode.commands.registerCommand("codexAccounts.toggleStatusBarAccount", (item?: CodexAccountRecord) =>
      service.toggleStatusBarAccount(item)
    ),
    vscode.commands.registerCommand(
      "codexAccounts.openDetails",
      (item?: CodexAccountRecord, options?: { privacyMode?: boolean }) => service.openDetails(item, options)
    ),
    vscode.commands.registerCommand("codexAccounts.openCodexHome", () => service.openCodexHome()),
    vscode.commands.registerCommand("codexAccounts.showQuotaSummary", () => service.showQuotaSummary()),
    vscode.commands.registerCommand("codexAccounts.resetSeamlessSwitchRuntime", () =>
      options.resetSeamlessSwitchRuntime?.()
    )
  );
}

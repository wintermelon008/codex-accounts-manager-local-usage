import * as vscode from "vscode";
import type { CodexAccountsIntegrationApi } from "./integrations";
import {
  disposeCodexProxyEnvironment,
  getCodexProxyConfigurationError,
  initializeCodexProxyEnvironment
} from "./infrastructure/config/proxyEnvironment";
import { getDashboardProxyAddress } from "./infrastructure/config/extensionSettings";
import { loadManagerControlEnvironment } from "./infrastructure/config/managerControlEnvironment";
import { AccountsWorkbench } from "./presentation/workbench/accountsWorkbench";

let workbench: AccountsWorkbench | undefined;

/**
 * 激活扩展
 *
 * @param context - 扩展上下文
 */
export async function activate(context: vscode.ExtensionContext): Promise<CodexAccountsIntegrationApi> {
  await loadManagerControlEnvironment();
  await initializeConfiguredProxyEnvironment();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration("codexAccounts.proxyAddress") &&
        !event.affectsConfiguration("codexAccounts.proxyAddresses")
      ) {
        return;
      }
      void initializeConfiguredProxyEnvironment();
    })
  );
  workbench = new AccountsWorkbench(context);
  await workbench.activate();
  return workbench.getIntegrationApi();
}

async function initializeConfiguredProxyEnvironment(): Promise<void> {
  await initializeCodexProxyEnvironment(getDashboardProxyAddress() || undefined);
  const proxyError = getCodexProxyConfigurationError();
  if (proxyError) {
    void vscode.window.showErrorMessage(`[Codex Accounts Manager] ${proxyError.message}`);
  }
}

/**
 * 停用扩展
 */
export function deactivate(): void {
  workbench?.dispose();
  workbench = undefined;
  disposeCodexProxyEnvironment();
}

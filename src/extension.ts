import * as vscode from "vscode";
import type { CodexAccountsIntegrationApi } from "./integrations";
import {
  disposeCodexProxyEnvironment,
  getCodexProxyConfigurationError,
  initializeCodexProxyEnvironment
} from "./infrastructure/config/proxyEnvironment";
import { writeManagerAutomationSettings } from "./infrastructure/config/managerAutomationSettings";
import { writeManagerProxySelection } from "./infrastructure/config/managerProxySelection";
import { getDashboardProxyAddress, isAutoStartQuotaCountdownEnabled } from "./infrastructure/config/extensionSettings";
import { loadManagerControlEnvironment } from "./infrastructure/config/managerControlEnvironment";
import { AccountsWorkbench } from "./presentation/workbench/accountsWorkbench";
import { flushAccountStates } from "./application/accounts/accountState";
import { getPrivateStatePaths, migrateLegacyGlobalStorage } from "./storage";

let workbench: AccountsWorkbench | undefined;

/**
 * 激活扩展
 *
 * @param context - 扩展上下文
 */
export async function activate(context: vscode.ExtensionContext): Promise<CodexAccountsIntegrationApi> {
  await migrateLegacyGlobalStorage(context);
  const privateRoot = getPrivateStatePaths(context).root;
  await loadManagerControlEnvironment({ privateRoot });
  await initializeConfiguredProxyEnvironment(privateRoot);
  await publishManagerAutomationSettings(privateRoot);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("codexAccounts.proxyAddress") ||
        event.affectsConfiguration("codexAccounts.proxyAddresses")
      ) {
        void initializeConfiguredProxyEnvironment(privateRoot);
      }
      if (event.affectsConfiguration("codexAccounts.autoStartQuotaCountdownEnabled")) {
        void publishManagerAutomationSettings(privateRoot);
      }
    })
  );
  workbench = new AccountsWorkbench(context);
  await workbench.activate();
  return workbench.getIntegrationApi();
}

async function publishManagerAutomationSettings(privateRoot: string): Promise<void> {
  try {
    await writeManagerAutomationSettings(privateRoot, isAutoStartQuotaCountdownEnabled());
  } catch (error) {
    console.warn("[codexAccounts] could not publish Dashboard automation settings to the headless runtime:", error);
  }
}

async function initializeConfiguredProxyEnvironment(privateRoot: string): Promise<void> {
  const selectedProxy = getDashboardProxyAddress();
  try {
    await writeManagerProxySelection(privateRoot, selectedProxy);
  } catch (error) {
    console.warn("[codexAccounts] could not publish Dashboard proxy selection to the headless runtime:", error);
  }
  await initializeCodexProxyEnvironment(selectedProxy || undefined);
  const proxyError = getCodexProxyConfigurationError();
  if (proxyError) {
    void vscode.window.showErrorMessage(`[Codex Accounts Manager] ${proxyError.message}`);
  }
}

/**
 * 停用扩展
 */
export async function deactivate(): Promise<void> {
  workbench?.dispose();
  workbench = undefined;
  disposeCodexProxyEnvironment();
  await flushAccountStates();
}

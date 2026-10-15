import * as path from "node:path";
import * as vscode from "vscode";
import type { AccountsRepository } from "../../storage";
import { getPrivateStatePaths } from "../../storage";
import { WakeupStore } from "../../storage/wakeupStore";
import { WakeupService } from "../../application/wakeup/service";
import { runAuthenticatedAccountRequest } from "../../application/accounts/authenticatedAccountRequest";
import { sendWakeupRequest } from "../../services/wakeupClient";
import { refreshQuota } from "../../services/quota";
import { isAutoStartQuotaCountdownEnabled } from "../../infrastructure/config/extensionSettings";

let service: WakeupService | undefined;

export function getWakeupService(): WakeupService | undefined {
  return service;
}

export async function registerWakeupScheduler(
  context: vscode.ExtensionContext,
  repo: AccountsRepository,
  onChange: () => void
): Promise<void> {
  service = new WakeupService(
    new WakeupStore(path.join(getPrivateStatePaths(context).root, "wakeup")),
    repo,
    async (accountId, task, signal) => {
      const selectedAccount = await repo.getAccount(accountId);
      const diagnostic = await runAuthenticatedAccountRequest(repo, accountId, (tokens) =>
        sendWakeupRequest(
          { ...tokens, accountId: tokens.accountId ?? selectedAccount?.accountId },
          task,
          signal
        )
      );

      let quotaWarning: string | undefined;
      try {
        const account = await repo.getAccount(accountId);
        const tokens = await repo.getTokens(accountId);
        if (account && tokens && !signal.aborted) {
          const result = await refreshQuota(account, tokens, true, repo);
          quotaWarning = result.error?.message;
          if (!signal.aborted) {
            await repo.updateQuota(
              accountId,
              result.quota,
              result.error,
              result.updatedTokens,
              result.updatedPlanType,
              result.updatedSubscriptionActiveUntil
            );
          }
        }
      } catch {
        quotaWarning = "Post-wakeup quota refresh failed";
        console.warn("[codexAccounts] post-wakeup quota refresh failed");
      }
      return { ...diagnostic, quotaWarning };
    },
    onChange
  );

  const instance = service;
  instance.setExecutionEnabled(!isAutoStartQuotaCountdownEnabled());
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexAccounts.autoStartQuotaCountdownEnabled")) {
        instance.setExecutionEnabled(!isAutoStartQuotaCountdownEnabled());
      }
    })
  );
  context.subscriptions.push({
    dispose: () => {
      instance.dispose();
      if (service === instance) {
        service = undefined;
      }
    }
  });
  await instance.start();
}

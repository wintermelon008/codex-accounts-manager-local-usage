import type { DashboardActionName, DashboardClientMessage } from "../../src/domain/dashboard/types";

declare function acquireVsCodeApi(): {
  postMessage(message: DashboardClientMessage): void;
};

const vscodeApi =
  typeof acquireVsCodeApi === "function"
    ? acquireVsCodeApi()
    : {
        postMessage(message: DashboardClientMessage): void {
          console.debug("[codex-accounts-manager] dashboard message", message);
        }
      };

export const BLOCKING_GLOBAL_ACTIONS = new Set<DashboardActionName>([
  "addAccount",
  "importCurrent",
  "refreshAll",
  "batchRefresh",
  "batchResyncProfile",
  "batchRemove",
  "setBalancePool",
  "removeFromBalancePool",
  "hideAccounts",
  "unhideAccounts",
  "setAccountGroup",
  "restoreFromBackup",
  "restoreFromAuthJson",
  "importSharedJson",
  "downloadJsonFile",
  "integrationAction",
  "integrationSetting"
]);

let actionRequestSequence = 0;

export function getActionTimeoutMs(action: DashboardActionName): number {
  switch (action) {
    case "refreshView":
      return 8_000;
    case "refreshLocalUsage":
      return 120_000;
    case "startQuotaCountdown":
      return 90_000;
    case "details":
    case "reloadPrompt":
    case "reauthorize":
    case "resyncProfile":
    case "dismissHealthIssue":
    case "switch":
    case "refresh":
    case "remove":
    case "toggleStatusBar":
    case "toggleBalancePool":
    case "setBalancePool":
    case "removeFromBalancePool":
    case "hideAccounts":
    case "unhideAccounts":
    case "setAccountGroup":
    case "integrationAction":
    case "integrationSetting":
      return 30_000;
    case "refreshAnnouncements":
    case "markAnnouncementRead":
    case "markAllAnnouncementsRead":
      return 30_000;
    case "refreshAll":
      return 120_000;
    case "restoreFromBackup":
    case "restoreFromAuthJson":
      return 60_000;
    case "shareTokens":
    case "prepareOAuthSession":
    case "cancelOAuthSession":
      return 30_000;
    case "importSharedJson":
    case "completeOAuthSession":
      return 120_000;
    case "addAccount":
    case "importCurrent":
    case "startOAuthAutoFlow":
      return 300_000;
    default:
      return 30_000;
  }
}

export function createActionRequestId(): string {
  actionRequestSequence += 1;
  return `dashboard-action-${actionRequestSequence}`;
}

export function postMessageToHost(message: DashboardClientMessage): void {
  vscodeApi.postMessage(message);
}

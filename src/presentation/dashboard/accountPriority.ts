import * as vscode from "vscode";
import { isAutomaticAccount, isCurrentProviderAccount, type CodexAccountRecord } from "../../core/types";
import { normalizeDashboardAccountPriority } from "../../domain/dashboard/accountPriority";

const GLOBAL_STATE_KEY = "codexAccounts.seamlessSwitchPriority";

let priorityAccountIds: string[] = [];
let globalState: vscode.Memento | undefined;
let persistChain = Promise.resolve();

export function initSeamlessSwitchPriorityState(context: vscode.ExtensionContext): void {
  globalState = context.globalState;
  priorityAccountIds = normalizeDashboardAccountPriority(
    globalState.get<unknown>(GLOBAL_STATE_KEY) as readonly unknown[]
  );
}

export function getSeamlessSwitchPriority(): readonly string[] {
  return [...priorityAccountIds];
}

export function setSeamlessSwitchPriority(accountIds: readonly string[]): void {
  const next = normalizeDashboardAccountPriority(accountIds);
  if (
    next.length === priorityAccountIds.length &&
    next.every((accountId, index) => accountId === priorityAccountIds[index])
  ) {
    return;
  }
  priorityAccountIds = next;
  persist();
}

export function removeSeamlessSwitchPriorityAccount(accountId: string): void {
  if (!priorityAccountIds.includes(accountId)) {
    return;
  }
  setSeamlessSwitchPriority(priorityAccountIds.filter((candidate) => candidate !== accountId));
}

export function clearSeamlessSwitchPriority(): void {
  setSeamlessSwitchPriority([]);
}

export function reconcileSeamlessSwitchPriority(accounts: readonly CodexAccountRecord[]): void {
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const next = priorityAccountIds.filter((accountId) => {
    const account = accountsById.get(accountId);
    return Boolean(
      account &&
      !account.isHidden &&
      !isCurrentProviderAccount(account) &&
      account.balancePoolEnabled === true &&
      isAutomaticAccount(account)
    );
  });
  setSeamlessSwitchPriority(next);
}

function persist(): void {
  if (!globalState) {
    return;
  }
  const snapshot = [...priorityAccountIds];
  persistChain = persistChain.then(() => globalState?.update(GLOBAL_STATE_KEY, snapshot)).catch(() => undefined);
}

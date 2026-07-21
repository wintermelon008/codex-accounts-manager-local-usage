let currentWindowRuntimeAccountId: string | undefined;

export function getCurrentWindowRuntimeAccountId(): string | undefined {
  return currentWindowRuntimeAccountId;
}

export function setCurrentWindowRuntimeAccountId(accountId?: string): void {
  currentWindowRuntimeAccountId = accountId;
}

export function clearCurrentWindowRuntimeAccountIfMatches(accountId: string): boolean {
  if (currentWindowRuntimeAccountId !== accountId) {
    return false;
  }
  currentWindowRuntimeAccountId = undefined;
  return true;
}

export function needsWindowReloadForAccount(accountId?: string): boolean {
  return Boolean(accountId) && currentWindowRuntimeAccountId !== accountId;
}

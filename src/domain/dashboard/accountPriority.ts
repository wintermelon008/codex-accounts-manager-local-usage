export const DASHBOARD_ACCOUNT_PRIORITY_LIMIT = 5;

export function normalizeDashboardAccountPriority(accountIds: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(accountIds)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const accountId of accountIds) {
    if (typeof accountId !== "string") {
      continue;
    }
    const trimmed = accountId.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= DASHBOARD_ACCOUNT_PRIORITY_LIMIT) {
      break;
    }
  }
  return normalized;
}

export function orderAccountsByPriority<T extends { id: string }>(
  accounts: readonly T[],
  priorityAccountIds: readonly string[],
  currentAccountId?: string
): T[] {
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const currentAccount = currentAccountId ? accountsById.get(currentAccountId) : undefined;
  const priorityIds = normalizeDashboardAccountPriority(priorityAccountIds);
  const prioritySet = new Set(priorityIds);
  const prioritized = priorityIds
    .map((accountId) => accountsById.get(accountId))
    .filter((account): account is T => account !== undefined && account.id !== currentAccountId);
  const rest = accounts.filter((account) => account.id !== currentAccountId && !prioritySet.has(account.id));

  return currentAccount ? [currentAccount, ...prioritized, ...rest] : [...prioritized, ...rest];
}

export function toggleDashboardAccountPriority(priorityAccountIds: readonly string[], accountId: string): string[] {
  const normalized = normalizeDashboardAccountPriority(priorityAccountIds);
  const index = normalized.indexOf(accountId);
  if (index >= 0) {
    return normalized.filter((candidate) => candidate !== accountId);
  }
  if (normalized.length >= DASHBOARD_ACCOUNT_PRIORITY_LIMIT) {
    return normalized;
  }
  return [...normalized, accountId];
}

export function moveDashboardAccountPriority(
  priorityAccountIds: readonly string[],
  draggedAccountId: string,
  targetAccountId: string
): string[] {
  const normalized = normalizeDashboardAccountPriority(priorityAccountIds);
  const draggedIndex = normalized.indexOf(draggedAccountId);
  const targetIndex = normalized.indexOf(targetAccountId);
  if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
    return normalized;
  }

  const next = [...normalized];
  next.splice(draggedIndex, 1);
  next.splice(targetIndex, 0, draggedAccountId);
  return next;
}

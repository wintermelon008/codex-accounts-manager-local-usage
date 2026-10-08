let dashboardAccountScope: Set<string> | undefined;

/**
 * Keeps the account IDs currently exposed by the Dashboard's filters
 * available to background seamless-switch scheduling. An empty set is a
 * meaningful scope: the active account may remain loaded, but no target is
 * eligible until the filter produces a result.
 */
export function setDashboardAccountScope(accountIds: readonly string[]): void {
  const nextScope = new Set<string>();
  for (const accountId of accountIds) {
    const normalizedId = accountId.trim();
    if (normalizedId) {
      nextScope.add(normalizedId);
    }
  }
  dashboardAccountScope = nextScope;
}

/** Returns undefined when the Dashboard is not currently publishing a scope. */
export function getDashboardAccountScope(): ReadonlySet<string> | undefined {
  return dashboardAccountScope ? new Set(dashboardAccountScope) : undefined;
}

export function clearDashboardAccountScope(): void {
  dashboardAccountScope = undefined;
}

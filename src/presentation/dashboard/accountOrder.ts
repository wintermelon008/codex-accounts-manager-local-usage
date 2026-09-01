let dashboardAccountOrder: string[] | undefined;

/**
 * Keeps the order currently shown by the Dashboard available to background
 * account scheduling. The scheduler falls back to repository order when the
 * panel is not open.
 */
export function setDashboardAccountOrder(accountIds: readonly string[]): void {
  const nextOrder: string[] = [];
  const seen = new Set<string>();
  for (const accountId of accountIds) {
    const normalizedId = accountId.trim();
    if (!normalizedId || seen.has(normalizedId)) {
      continue;
    }
    seen.add(normalizedId);
    nextOrder.push(normalizedId);
  }

  dashboardAccountOrder = nextOrder.length > 0 ? nextOrder : undefined;
}

export function getDashboardAccountOrder(): readonly string[] | undefined {
  return dashboardAccountOrder ? [...dashboardAccountOrder] : undefined;
}

export function clearDashboardAccountOrder(): void {
  dashboardAccountOrder = undefined;
}

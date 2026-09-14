import type { CodexAccountConcurrencyWindowStats, CodexAccountRecord } from "../../core/types";

export type AccountSessionActivity = {
  sessionId: string;
  accountId: string;
  active: boolean;
  tokens?: number;
  durationMs?: number;
};

export type AccountConcurrencySnapshot = {
  current: number;
  max: number;
  totalTokens: number;
  totalDurationMs: number;
  averageTokenRate?: number;
};

export type AccountConcurrencyWindowDescriptor = Pick<
  CodexAccountConcurrencyWindowStats,
  "window" | "resetAt" | "windowMinutes"
>;

export function resolveAccountConcurrencyWindows(account: CodexAccountRecord): AccountConcurrencyWindowDescriptor[] {
  const quota = account.quotaSummary;
  const windows: AccountConcurrencyWindowDescriptor[] = [];
  if (quota?.hourlyResetTime != null && Number.isFinite(quota.hourlyResetTime) && quota.hourlyResetTime > 0) {
    windows.push({
      window: "hourly",
      resetAt: quota.hourlyResetTime,
      windowMinutes: quota.hourlyWindowMinutes
    });
  }
  if (quota?.weeklyResetTime != null && Number.isFinite(quota.weeklyResetTime) && quota.weeklyResetTime > 0) {
    windows.push({
      window: "weekly",
      resetAt: quota.weeklyResetTime,
      windowMinutes: quota.weeklyWindowMinutes
    });
  }
  return windows;
}

export function getAccountConcurrencyWindowKey(window: AccountConcurrencyWindowDescriptor): string {
  return `${window.window}:${window.resetAt}:${window.windowMinutes ?? ""}`;
}

export function getPersistedAccountConcurrencySnapshot(
  account: CodexAccountRecord
): AccountConcurrencySnapshot | undefined {
  const stored = account.concurrencyWindows;
  if (!stored || stored.length === 0) {
    return undefined;
  }
  for (const window of resolveAccountConcurrencyWindows(account)) {
    const key = getAccountConcurrencyWindowKey(window);
    const stats = stored.find((candidate) => getAccountConcurrencyWindowKey(candidate) === key);
    if (stats && (stats.maxConcurrency > 0 || stats.totalDurationMs > 0)) {
      return toAccountConcurrencySnapshot(stats);
    }
  }
  return undefined;
}

export function prunePersistedAccountConcurrencyWindows(
  account: CodexAccountRecord
): CodexAccountConcurrencyWindowStats[] | undefined {
  const currentWindows = resolveAccountConcurrencyWindows(account);
  if (currentWindows.length === 0) {
    return undefined;
  }
  if (!account.concurrencyWindows) {
    return undefined;
  }
  const currentKeys = new Set(currentWindows.map((window) => getAccountConcurrencyWindowKey(window)));
  return account.concurrencyWindows.filter((window) => currentKeys.has(getAccountConcurrencyWindowKey(window)));
}

export function updatePersistedAccountConcurrencyWindows(
  account: CodexAccountRecord,
  activity: AccountSessionActivity,
  snapshot: AccountConcurrencySnapshot | undefined
): CodexAccountConcurrencyWindowStats[] | undefined {
  const currentWindows = resolveAccountConcurrencyWindows(account);
  if (currentWindows.length === 0) {
    return undefined;
  }

  const previousByKey = new Map(
    (account.concurrencyWindows ?? []).map((window) => [getAccountConcurrencyWindowKey(window), window] as const)
  );
  const tokens = normalizeNonNegativeNumber(activity.tokens);
  const durationMs = normalizeNonNegativeNumber(activity.durationMs);
  return currentWindows.map((window) => {
    const previous = previousByKey.get(getAccountConcurrencyWindowKey(window));
    return {
      ...window,
      maxConcurrency: Math.max(previous?.maxConcurrency ?? 0, snapshot?.max ?? 0),
      totalTokens: (previous?.totalTokens ?? 0) + (activity.active ? 0 : tokens),
      totalDurationMs: (previous?.totalDurationMs ?? 0) + (activity.active ? 0 : durationMs)
    };
  });
}

/** Tracks live session activity; quota-window aggregates are persisted on the account record. */
export class AccountConcurrencyTracker {
  private readonly activeSessions = new Map<string, string>();
  private readonly currentByAccount = new Map<string, number>();
  private readonly maxByAccount = new Map<string, number>();
  private readonly totalsByAccount = new Map<string, { tokens: number; durationMs: number }>();

  record(activity: AccountSessionActivity): { changed: boolean; snapshot?: AccountConcurrencySnapshot } {
    const sessionId = activity.sessionId.trim();
    const accountId = activity.accountId.trim();
    if (!sessionId || !accountId) {
      return { changed: false };
    }

    if (activity.active) {
      const previousAccountId = this.activeSessions.get(sessionId);
      if (previousAccountId === accountId) {
        return { changed: false, snapshot: this.snapshot(accountId) };
      }
      if (previousAccountId) {
        this.decrement(previousAccountId);
      }
      this.activeSessions.set(sessionId, accountId);
      const current = (this.currentByAccount.get(accountId) ?? 0) + 1;
      this.currentByAccount.set(accountId, current);
      const previousMax = this.maxByAccount.get(accountId) ?? 0;
      const max = Math.max(previousMax, current);
      this.maxByAccount.set(accountId, max);
      return { changed: max !== previousMax, snapshot: this.snapshot(accountId) };
    }

    const previousAccountId = this.activeSessions.get(sessionId);
    if (!previousAccountId) {
      return { changed: false, snapshot: this.snapshot(accountId) };
    }
    this.activeSessions.delete(sessionId);
    this.decrement(previousAccountId);
    const previousTotals = this.totalsByAccount.get(previousAccountId) ?? { tokens: 0, durationMs: 0 };
    const tokens = normalizeNonNegativeNumber(activity.tokens);
    const durationMs = normalizeNonNegativeNumber(activity.durationMs);
    if (tokens > 0 || durationMs > 0) {
      this.totalsByAccount.set(previousAccountId, {
        tokens: previousTotals.tokens + tokens,
        durationMs: previousTotals.durationMs + durationMs
      });
    }
    return { changed: tokens > 0 || durationMs > 0, snapshot: this.snapshot(previousAccountId) };
  }

  get(accountId: string): AccountConcurrencySnapshot | undefined {
    const normalized = accountId.trim();
    if (!normalized || !this.maxByAccount.has(normalized)) {
      return undefined;
    }
    return this.snapshot(normalized);
  }

  reset(): void {
    this.activeSessions.clear();
    this.currentByAccount.clear();
    this.maxByAccount.clear();
    this.totalsByAccount.clear();
  }

  private snapshot(accountId: string): AccountConcurrencySnapshot {
    const totals = this.totalsByAccount.get(accountId) ?? { tokens: 0, durationMs: 0 };
    return {
      current: this.currentByAccount.get(accountId) ?? 0,
      max: this.maxByAccount.get(accountId) ?? 0,
      totalTokens: totals.tokens,
      totalDurationMs: totals.durationMs,
      ...(totals.durationMs > 0
        ? { averageTokenRate: totals.tokens / (totals.durationMs / 1_000) }
        : {})
    };
  }

  private decrement(accountId: string): void {
    const next = Math.max(0, (this.currentByAccount.get(accountId) ?? 0) - 1);
    if (next === 0) {
      this.currentByAccount.delete(accountId);
      return;
    }
    this.currentByAccount.set(accountId, next);
  }
}

function toAccountConcurrencySnapshot(stats: CodexAccountConcurrencyWindowStats): AccountConcurrencySnapshot {
  return {
    current: 0,
    max: stats.maxConcurrency,
    totalTokens: stats.totalTokens,
    totalDurationMs: stats.totalDurationMs,
    ...(stats.totalDurationMs > 0
      ? { averageTokenRate: stats.totalTokens / (stats.totalDurationMs / 1_000) }
      : {})
  };
}

function normalizeNonNegativeNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export const accountConcurrencyTracker = new AccountConcurrencyTracker();

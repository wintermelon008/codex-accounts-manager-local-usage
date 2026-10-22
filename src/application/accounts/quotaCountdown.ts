import { isSub2ApiAccount, type CodexAccountRecord } from "../../core/types";
import { isQuotaCountdownStartEligible } from "../../domain/dashboard/quotaCountdown";
import type { AccountsRepository } from "../../storage";
import { refreshSingleQuota } from "./quota";
import {
  startQuotaCountdownWithLease,
  type QuotaCountdownStartResult
} from "./quotaCountdownCore";

export type { QuotaCountdownStartResult } from "./quotaCountdownCore";

const RECENT_START_SUPPRESSION_MS = 10 * 60 * 1000;
const recentStarts = new Map<string, number>();
const inflightStarts = new Map<string, Promise<QuotaCountdownStartResult>>();

export function isQuotaCountdownStartAvailable(account: CodexAccountRecord, nowMs: number = Date.now()): boolean {
  if (isSub2ApiAccount(account) || account.quotaMode === "none") {
    return false;
  }
  pruneRecentStarts(nowMs);
  return !recentStarts.has(account.id) && isQuotaCountdownStartEligible(account.quotaSummary, nowMs);
}

export function startQuotaCountdownForAccount(
  repo: AccountsRepository,
  accountId: string
): Promise<QuotaCountdownStartResult> {
  return startQuotaCountdownTask(repo, accountId, true);
}

/**
 * Start the countdown after the caller has already persisted a successful
 * quota refresh. This avoids querying the same account twice when the quota
 * refresh pipeline itself detects an expired reset window.
 */
export function startQuotaCountdownAfterRefreshForAccount(
  repo: AccountsRepository,
  accountId: string
): Promise<QuotaCountdownStartResult> {
  return startQuotaCountdownTask(repo, accountId, false);
}

function startQuotaCountdownTask(
  repo: AccountsRepository,
  accountId: string,
  refreshBeforeStart: boolean
): Promise<QuotaCountdownStartResult> {
  const inflight = inflightStarts.get(accountId);
  if (inflight) {
    return inflight;
  }

  const task = runQuotaCountdownStart(repo, accountId, refreshBeforeStart);
  inflightStarts.set(accountId, task);
  const clearInflight = (): void => {
    if (inflightStarts.get(accountId) === task) {
      inflightStarts.delete(accountId);
    }
  };
  void task.then(clearInflight, clearInflight);
  return task;
}

async function runQuotaCountdownStart(
  repo: AccountsRepository,
  accountId: string,
  refreshBeforeStart: boolean
): Promise<QuotaCountdownStartResult> {
  const now = Date.now();
  pruneRecentStarts(now);
  if (recentStarts.has(accountId)) {
    return "already-started";
  }

  const result = await startQuotaCountdownWithLease(repo, accountId, {
    refreshBeforeStart: refreshBeforeStart
      ? () => refreshQuotaWithoutUi(repo, accountId)
      : undefined,
    refreshAfterStart: () => refreshQuotaWithoutUi(repo, accountId)
  });
  if (result === "started") {
    recentStarts.set(accountId, Date.now());
  }
  return result;
}

function refreshQuotaWithoutUi(repo: AccountsRepository, accountId: string): Promise<void> {
  return refreshSingleQuota(repo, { refresh: () => undefined }, accountId, {
    announce: false,
    forceRefresh: true,
    refreshView: false,
    warnQuota: false
  });
}

function pruneRecentStarts(nowMs: number): void {
  recentStarts.forEach((startedAt, accountId) => {
    if (nowMs - startedAt >= RECENT_START_SUPPRESSION_MS) {
      recentStarts.delete(accountId);
    }
  });
}

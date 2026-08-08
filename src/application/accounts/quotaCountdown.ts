import { isSub2ApiAccount, type CodexAccountRecord } from "../../core/types";
import { isQuotaCountdownStartEligible } from "../../domain/dashboard/quotaCountdown";
import { sendQuotaCountdownStartMessage } from "../../services/quotaCountdown";
import type { AccountsRepository } from "../../storage";
import { refreshSingleQuota } from "./quota";

const RECENT_START_SUPPRESSION_MS = 10 * 60 * 1000;
const recentStarts = new Map<string, number>();
const inflightStarts = new Map<string, Promise<QuotaCountdownStartResult>>();

export type QuotaCountdownStartResult = "started" | "already-started";

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
  const inflight = inflightStarts.get(accountId);
  if (inflight) {
    return inflight;
  }

  const task = runQuotaCountdownStart(repo, accountId);
  inflightStarts.set(accountId, task);
  const clearInflight = (): void => {
    if (inflightStarts.get(accountId) === task) {
      inflightStarts.delete(accountId);
    }
  };
  void task.then(clearInflight, clearInflight);
  return task;
}

async function runQuotaCountdownStart(repo: AccountsRepository, accountId: string): Promise<QuotaCountdownStartResult> {
  const now = Date.now();
  pruneRecentStarts(now);
  if (recentStarts.has(accountId)) {
    return "already-started";
  }

  const selected = await repo.getAccount(accountId);
  if (selected && isSub2ApiAccount(selected)) {
    throw new Error("Gateway accounts do not expose quota countdowns");
  }

  await refreshSingleQuota(repo, { refresh: () => undefined }, accountId, {
    announce: false,
    forceRefresh: true,
    refreshView: false,
    warnQuota: false
  });
  const account = await repo.getAccount(accountId);
  if (!account) {
    throw new Error("The selected account no longer exists");
  }
  if (!isQuotaCountdownStartEligible(account.quotaSummary)) {
    return "already-started";
  }

  const tokens = await repo.getTokens(accountId);
  const remoteAccountId = account.accountId ?? tokens?.accountId;
  if (!tokens?.accessToken || !remoteAccountId) {
    throw new Error("The selected account has no usable Codex credentials");
  }

  await sendQuotaCountdownStartMessage({ accessToken: tokens.accessToken, accountId: remoteAccountId });
  recentStarts.set(accountId, Date.now());
  await refreshSingleQuota(repo, { refresh: () => undefined }, accountId, {
    announce: false,
    forceRefresh: true,
    refreshView: false,
    warnQuota: false
  });
  return "started";
}

function pruneRecentStarts(nowMs: number): void {
  recentStarts.forEach((startedAt, accountId) => {
    if (nowMs - startedAt >= RECENT_START_SUPPRESSION_MS) {
      recentStarts.delete(accountId);
    }
  });
}

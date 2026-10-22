import type { AccountsRepository } from "../../storage";
import { isAutomaticAccount, isSub2ApiAccount } from "../../core/types";
import { getErrorMessage } from "../../core/errors";
import { refreshQuota, type QuotaRefreshResult } from "../../services/quota";
import { runWithConcurrencyLimit } from "../../utils/concurrency";
import { withRenewingSchedulerLease } from "../../runtime/schedulerLease";

export type HeadlessQuotaRefreshSummary = {
  total: number;
  succeeded: number;
  failed: number;
  /** The shared scheduler lease was occupied; callers should retry later. */
  busy?: boolean;
  unknownAccountIds: string[];
  failedAccountIds: string[];
};

export type HeadlessQuotaRefreshOutcome = {
  accountId: string;
  status: "refreshed" | "failed" | "skipped";
  message?: string;
};

const QUOTA_REFRESH_LEASE_MS = 2 * 60 * 1000;
// A foreground batch can legitimately take longer than a single request. The
// daemon waits for a useful hand-off window, while the explicit busy result
// below prevents a remaining contention from being reported as account
// failures.
const QUOTA_REFRESH_LEASE_WAIT_MS = 30_000;

export async function refreshImportedAccountQuotaHeadlessly(
  repo: AccountsRepository,
  accountId: string,
  leaseIsActive: () => boolean = () => true
): Promise<QuotaRefreshResult> {
  const account = await repo.getAccount(accountId);
  if (!account) {
    throw new Error("account not found");
  }
  if (isSub2ApiAccount(account) || !isAutomaticAccount(account)) {
    return {};
  }
  const tokens = await repo.getTokens(accountId);
  if (!tokens?.accessToken) {
    throw new Error("account has no usable access token");
  }
  const result = await refreshQuota(account, tokens, true, repo);
  if (result.stale) {
    return result;
  }
  if (!leaseIsActive()) {
    return { stale: true };
  }
  await repo.updateQuota(
    accountId,
    result.quota,
    result.error,
    result.updatedTokens,
    result.updatedPlanType,
    result.updatedSubscriptionActiveUntil
  );
  await repo.refreshSubscriptionState(accountId, true).catch(() => undefined);
  return result;
}

export async function refreshAccountQuotaHeadlessly(
  repo: AccountsRepository,
  accountId: string,
  leaseIsActive: () => boolean = () => true
): Promise<HeadlessQuotaRefreshOutcome> {
  const account = await repo.getAccount(accountId);
  if (!account) {
    return { accountId, status: "failed", message: "account not found" };
  }
  if (isSub2ApiAccount(account) || !isAutomaticAccount(account)) {
    return { accountId, status: "skipped", message: "account does not expose ChatGPT quota" };
  }
  if (account.sharing?.direction === "outgoing") {
    return { accountId, status: "skipped", message: "account credential is leased to another host" };
  }

  try {
    if (!leaseIsActive()) {
      return { accountId, status: "skipped", message: "quota refresh lease was lost" };
    }
    const result = await refreshImportedAccountQuotaHeadlessly(repo, accountId, leaseIsActive);
    if (!leaseIsActive()) {
      return { accountId, status: "skipped", message: "quota refresh lease was lost" };
    }
    return result.stale
      ? { accountId, status: "skipped", message: "quota refresh result became stale" }
      : result.error
      ? { accountId, status: "failed", message: result.error.message }
      : { accountId, status: "refreshed" };
  } catch (error) {
    return { accountId, status: "failed", message: getErrorMessage(error) };
  }
}

export async function refreshAllQuotasHeadlessly(
  repo: AccountsRepository,
  accountIds?: readonly string[]
): Promise<HeadlessQuotaRefreshSummary> {
  const allAccounts = await repo.listAccounts();
  const requestedIds = accountIds === undefined ? undefined : new Set(accountIds);
  const unknownAccountIds = requestedIds === undefined
    ? []
    : [...requestedIds].filter((accountId) => !allAccounts.some((account) => account.id === accountId));
  const requestedAccounts = requestedIds === undefined
    ? allAccounts
    : allAccounts.filter((account) => requestedIds.has(account.id));
  const refreshable = requestedAccounts.filter(isAutomaticAccount);
  const failedAccountIds = requestedAccounts.filter(isSub2ApiAccount).map((account) => account.id);
  let succeeded = 0;

  const result = await withRenewingSchedulerLease(
    repo,
    "quota-refresh",
    QUOTA_REFRESH_LEASE_MS,
    QUOTA_REFRESH_LEASE_WAIT_MS,
    async (leaseIsActive) => {
      await runWithConcurrencyLimit(refreshable, 3, async (account) => {
        if (!leaseIsActive()) {
          return;
        }
        const outcome = await refreshAccountQuotaHeadlessly(repo, account.id, leaseIsActive);
        if (outcome.status === "refreshed") {
          succeeded += 1;
        } else if (outcome.status === "failed") {
          failedAccountIds.push(account.id);
        }
      });
      return true;
    }
  );
  if (result === undefined) {
    return {
      total: requestedAccounts.length + unknownAccountIds.length,
      succeeded: 0,
      failed: failedAccountIds.length,
      busy: true,
      unknownAccountIds,
      failedAccountIds
    };
  }

  return {
    total: requestedAccounts.length + unknownAccountIds.length,
    succeeded,
    failed: failedAccountIds.length,
    unknownAccountIds,
    failedAccountIds
  };
}

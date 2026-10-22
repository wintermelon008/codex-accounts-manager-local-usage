import { isSub2ApiAccount, type CodexTokens } from "../../core/types";
import { isQuotaCountdownStartEligible } from "../../domain/dashboard/quotaCountdown";
import { QuotaCountdownStartError, sendQuotaCountdownStartMessage } from "../../services/quotaCountdown";
import type { AccountsRepository } from "../../storage";
import {
  clearQuotaCountdownStartRecord,
  getQuotaCountdownCycleKey,
  readQuotaCountdownStartRecord,
  writeQuotaCountdownStartRecord
} from "../../storage/quotaCountdownStartState";
import { withRenewingSchedulerLease } from "../../runtime/schedulerLease";

const COUNTDOWN_START_LEASE_NAME = "quota-countdown-start";
const COUNTDOWN_START_LEASE_MS = 2 * 60 * 1000;
const COUNTDOWN_START_LEASE_WAIT_MS = 250;

export type QuotaCountdownStartResult = "started" | "already-started";

type CountdownRepository = Pick<
  AccountsRepository,
  "getAccount" | "getTokens" | "getPrivateStateRoot" | "tryAcquireSchedulerLease"
>;

export type QuotaCountdownStartOptions = {
  refreshBeforeStart?: () => Promise<void>;
  refreshAfterStart?: () => Promise<void>;
  sendStartMessage?: (tokens: Pick<CodexTokens, "accessToken" | "accountId">) => Promise<void>;
  leaseIsActive?: () => boolean;
};

/**
 * Host-neutral countdown starter. VS Code and the headless daemon both use
 * this transaction so a shared private state file and lease suppress a second
 * send for the same account/window.
 */
export async function startQuotaCountdownWithLease(
  repo: CountdownRepository,
  accountId: string,
  options: QuotaCountdownStartOptions = {}
): Promise<QuotaCountdownStartResult> {
  const result = await withRenewingSchedulerLease(
    repo,
    COUNTDOWN_START_LEASE_NAME,
    COUNTDOWN_START_LEASE_MS,
    COUNTDOWN_START_LEASE_WAIT_MS,
    (leaseIsActive) =>
      runQuotaCountdownStart(repo, accountId, {
        ...options,
        leaseIsActive: () => leaseIsActive() && (options.leaseIsActive?.() ?? true)
      })
  );
  if (result === undefined) {
    throw new Error("Quota countdown start is busy on another Manager host");
  }
  return result;
}

export async function runQuotaCountdownStart(
  repo: Pick<AccountsRepository, "getAccount" | "getTokens" | "getPrivateStateRoot">,
  accountId: string,
  options: QuotaCountdownStartOptions = {}
): Promise<QuotaCountdownStartResult> {
  const initial = await repo.getAccount(accountId);
  if (initial && isSub2ApiAccount(initial)) {
    throw new Error("Gateway accounts do not expose quota countdowns");
  }

  const privateRoot = repo.getPrivateStateRoot();
  const initialCycleKey = initial ? getQuotaCountdownCycleKey(initial) : undefined;
  if (
    initial &&
    initialCycleKey &&
    isQuotaCountdownStartEligible(initial.quotaSummary) &&
    (await isRecordHandled(privateRoot, accountId, initialCycleKey))
  ) {
    return "already-started";
  }

  if (options.refreshBeforeStart) {
    await options.refreshBeforeStart();
  }
  assertLeaseActive(options.leaseIsActive);

  const account = await repo.getAccount(accountId);
  if (!account) {
    throw new Error("The selected account no longer exists");
  }
  if (isSub2ApiAccount(account)) {
    throw new Error("Gateway accounts do not expose quota countdowns");
  }
  if (!isQuotaCountdownStartEligible(account.quotaSummary)) {
    return "already-started";
  }

  const cycleKey = getQuotaCountdownCycleKey(account);
  if (!cycleKey) {
    return "already-started";
  }
  if (await isRecordHandled(privateRoot, accountId, cycleKey)) {
    return "already-started";
  }

  const tokens = await repo.getTokens(accountId);
  const remoteAccountId = account.accountId ?? tokens?.accountId;
  if (!tokens?.accessToken || !remoteAccountId) {
    throw new Error("The selected account has no usable Codex credentials");
  }

  assertLeaseActive(options.leaseIsActive);
  await writeQuotaCountdownStartRecord(privateRoot, accountId, {
    cycleKey,
    status: "attempting",
    updatedAt: Date.now()
  });

  try {
    await (options.sendStartMessage ?? ((nextTokens) => sendQuotaCountdownStartMessage(nextTokens)))({
      accessToken: tokens.accessToken,
      accountId: remoteAccountId
    });
  } catch (error) {
    if (error instanceof QuotaCountdownStartError && !error.ambiguous) {
      await clearQuotaCountdownStartRecord(privateRoot, accountId);
    } else {
      await writeQuotaCountdownStartRecord(privateRoot, accountId, {
        cycleKey,
        status: "uncertain",
        updatedAt: Date.now()
      });
    }
    throw error;
  }

  await writeQuotaCountdownStartRecord(privateRoot, accountId, {
    cycleKey,
    status: "accepted",
    updatedAt: Date.now()
  });

  if (options.refreshAfterStart) {
    try {
      await options.refreshAfterStart();
    } catch (error) {
      // The accepted marker is intentionally kept. A failed follow-up quota
      // read must never cause the same short conversation to be sent again.
      console.warn(
        `[codexAccounts] quota countdown follow-up refresh failed for ${accountId}: ${getErrorMessage(error)}`
      );
    }
  }
  return "started";
}

async function isRecordHandled(privateRoot: string, accountId: string, cycleKey: string): Promise<boolean> {
  const record = await readQuotaCountdownStartRecord(privateRoot, accountId);
  return record?.cycleKey === cycleKey && ["attempting", "accepted", "uncertain"].includes(record.status);
}

function assertLeaseActive(leaseIsActive: (() => boolean) | undefined): void {
  if (leaseIsActive && !leaseIsActive()) {
    throw new Error("Quota countdown start lease was lost");
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

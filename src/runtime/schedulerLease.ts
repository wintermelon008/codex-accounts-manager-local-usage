import type { SharedFileLease } from "../storage/accountsWriteCoordinator";

export type SchedulerLeaseRepository = {
  tryAcquireSchedulerLease(
    name: string,
    leaseMs: number,
    waitTimeoutMs?: number
  ): Promise<SharedFileLease | undefined>;
};

/** Run one cross-process scheduler task while renewing its ownership lease. */
export async function withRenewingSchedulerLease<T>(
  repo: SchedulerLeaseRepository,
  name: string,
  leaseMs: number,
  waitTimeoutMs: number,
  task: (leaseIsActive: () => boolean) => Promise<T>
): Promise<T | undefined> {
  const lease = await repo.tryAcquireSchedulerLease(name, leaseMs, waitTimeoutMs);
  if (!lease) {
    return undefined;
  }

  let leaseLost = false;
  let renewalInFlight = false;
  const renewalTimer = setInterval(() => {
    if (renewalInFlight || leaseLost) {
      return;
    }
    renewalInFlight = true;
    void lease
      .renew(leaseMs)
      .then((renewed) => {
        leaseLost = !renewed;
        if (!renewed) {
          console.warn(`[codexAccounts] ${name} scheduler lease renewal was rejected`);
        }
      })
      .catch((error: unknown) => {
        leaseLost = true;
        console.warn(`[codexAccounts] ${name} scheduler lease renewal failed: ${getErrorMessage(error)}`);
      })
      .finally(() => {
        renewalInFlight = false;
      });
  }, Math.max(1_000, Math.floor(leaseMs / 2)));
  renewalTimer.unref?.();

  try {
    return await task(() => !leaseLost);
  } finally {
    clearInterval(renewalTimer);
    await lease.release();
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

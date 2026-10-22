import { isAutomaticAccount, isSub2ApiAccount, type CodexAccountRecord } from "../core/types";
import { isQuotaCountdownStartEligible } from "../domain/dashboard/quotaCountdown";
import {
  startQuotaCountdownWithLease,
  type QuotaCountdownStartOptions,
  type QuotaCountdownStartResult
} from "../application/accounts/quotaCountdownCore";
import { refreshImportedAccountQuotaHeadlessly } from "../application/accounts/headlessQuota";
import type { AccountsRepository } from "../storage";
import { withRenewingSchedulerLease } from "./schedulerLease";

const QUOTA_REFRESH_LEASE_MS = 2 * 60 * 1000;
const QUOTA_REFRESH_LEASE_WAIT_MS = 250;

export type HeadlessQuotaCountdownSchedulerDependencies = {
  refreshAccount?: (accountId: string, leaseIsActive: () => boolean) => Promise<void>;
  startCountdown?: (accountId: string, options: QuotaCountdownStartOptions) => Promise<QuotaCountdownStartResult>;
};

/**
 * Node-only owner for automatic countdown starts. It intentionally checks
 * only accounts whose stored quota is already fresh or whose reset boundary
 * has passed; ordinary quota polling remains the daemon's separate job.
 */
export class HeadlessQuotaCountdownScheduler {
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private disposed = false;
  private readonly refreshAccountTask: (accountId: string, leaseIsActive: () => boolean) => Promise<void>;
  private readonly startCountdownTask: (
    accountId: string,
    options: QuotaCountdownStartOptions
  ) => Promise<QuotaCountdownStartResult>;

  constructor(
    private readonly repo: AccountsRepository,
    private readonly intervalMs: number,
    dependencies: HeadlessQuotaCountdownSchedulerDependencies = {}
  ) {
    this.refreshAccountTask =
      dependencies.refreshAccount ?? ((accountId, leaseIsActive) => this.refreshAccount(accountId, leaseIsActive));
    this.startCountdownTask =
      dependencies.startCountdown ??
      ((accountId, options) => startQuotaCountdownWithLease(this.repo, accountId, options));
  }

  start(): void {
    if (this.disposed || this.timer) {
      return;
    }
    void this.runNow();
    this.timer = setInterval(() => {
      void this.runNow();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async runNow(): Promise<void> {
    if (this.disposed || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      this.repo.invalidateExternalStateCaches({ invalidateTokens: false });
      const accounts = await this.repo.listAccounts();
      const candidates = accounts.filter((account) => needsCountdownCheck(account));
      if (candidates.length === 0) {
        return;
      }

      await withRenewingSchedulerLease(
        this.repo,
        "quota-refresh",
        QUOTA_REFRESH_LEASE_MS,
        QUOTA_REFRESH_LEASE_WAIT_MS,
        async (leaseIsActive) => {
          for (const account of candidates) {
            if (!leaseIsActive() || this.disposed) {
              break;
            }
            try {
              const result = await this.startCountdownTask(account.id, {
                refreshBeforeStart: () => this.refreshAccountTask(account.id, leaseIsActive),
                refreshAfterStart: () => this.refreshAccountTask(account.id, leaseIsActive),
                leaseIsActive
              });
              if (result === "started") {
                console.info(`[codexAccounts] daemon started quota countdown for ${account.email}`);
              }
            } catch (error) {
              console.warn(
                `[codexAccounts] daemon quota countdown start failed for ${account.email}: ${getErrorMessage(error)}`
              );
            }
          }
        }
      );
    } catch (error) {
      console.warn(`[codexAccounts] daemon quota countdown sweep failed: ${getErrorMessage(error)}`);
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async refreshAccount(accountId: string, leaseIsActive: () => boolean): Promise<void> {
    if (!leaseIsActive()) {
      throw new Error("Quota refresh lease was lost");
    }
    await refreshImportedAccountQuotaHeadlessly(this.repo, accountId, leaseIsActive);
    if (!leaseIsActive()) {
      throw new Error("Quota refresh lease was lost");
    }
  }
}

function needsCountdownCheck(account: CodexAccountRecord, nowMs = Date.now()): boolean {
  if (isSub2ApiAccount(account) || !isAutomaticAccount(account) || account.sharing?.direction === "outgoing") {
    return false;
  }
  if (isQuotaCountdownStartEligible(account.quotaSummary, nowMs)) {
    return true;
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  return (
    isExpired(account.quotaSummary?.hourlyWindowPresent, account.quotaSummary?.hourlyResetTime, nowSeconds) ||
    isExpired(account.quotaSummary?.weeklyWindowPresent, account.quotaSummary?.weeklyResetTime, nowSeconds)
  );
}

function isExpired(present: boolean | undefined, resetAt: number | undefined, nowSeconds: number): boolean {
  return present === true && typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt <= nowSeconds;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

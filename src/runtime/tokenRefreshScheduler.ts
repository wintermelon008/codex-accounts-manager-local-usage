import { needsTokenRefresh } from "../auth/oauth";
import { ensureFreshAccountTokens } from "../auth/tokenRefreshCoordinator";
import { isAutomaticAccount, type CodexAccountRecord } from "../core/types";
import { getErrorMessage, sanitizeApiErrorText } from "../core/errors";
import type { AccountsRepository } from "../storage";
import { runWithConcurrencyLimit } from "../utils/concurrency";
import { withRenewingSchedulerLease } from "./schedulerLease";

const TOKEN_REFRESH_LEASE_MS = 2 * 60 * 1000;
const TOKEN_REFRESH_LEASE_WAIT_MS = 250;
const TOKEN_REFRESH_SKEW_SECONDS = 5 * 60;

export class HeadlessTokenRefreshScheduler {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly repo: AccountsRepository,
    private readonly intervalMs: number
  ) {}

  start(): void {
    if (this.disposed || this.timer) {
      return;
    }
    void this.runNow().catch((error: unknown) => {
      console.warn(`[codexAccounts] daemon token refresh sweep failed: ${getErrorMessage(error)}`);
    });
    this.timer = setInterval(() => {
      void this.runNow().catch((error: unknown) => {
        console.warn(`[codexAccounts] daemon token refresh sweep failed: ${getErrorMessage(error)}`);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async runNow(): Promise<void> {
    if (this.disposed || this.inFlight) {
      return this.inFlight;
    }
    const task = this.runSweep();
    this.inFlight = task;
    try {
      await task;
    } finally {
      if (this.inFlight === task) {
        this.inFlight = undefined;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async runSweep(): Promise<void> {
    await withRenewingSchedulerLease(
      this.repo,
      "token-refresh",
      TOKEN_REFRESH_LEASE_MS,
      TOKEN_REFRESH_LEASE_WAIT_MS,
      async (leaseIsActive) => {
        const accounts = (await this.repo.listAccounts()).filter(isAutomaticAccount);
        await runWithConcurrencyLimit(accounts, 3, async (account) => {
          if (!leaseIsActive()) {
            return;
          }
          await this.refreshIfDue(account, leaseIsActive);
        });
      }
    );
  }

  private async refreshIfDue(account: CodexAccountRecord, leaseIsActive: () => boolean): Promise<void> {
    if (account.sharing?.direction === "outgoing") {
      return;
    }

    const tokens = await this.repo.getTokens(account.id, { forceReload: true });
    if (!tokens?.accessToken || !needsTokenRefresh(tokens, TOKEN_REFRESH_SKEW_SECONDS)) {
      return;
    }
    if (!leaseIsActive()) {
      return;
    }

    const attemptAt = Date.now();
    await this.repo.updateTokenRefreshStatus(account.id, {
      tokenRefreshLastAttemptAt: attemptAt,
      tokenRefreshLastError: undefined,
      tokenRefreshLastErrorAt: undefined,
      tokenRefreshLastErrorKind: undefined,
      tokenRefreshNextRetryAt: undefined
    });

    try {
      const refreshed = await ensureFreshAccountTokens(this.repo, account.id, {
        fallbackTokens: tokens,
        notifyTokenChange: false,
        providerAccountId: account.accountId
      });
      if (!refreshed?.accessToken) {
        throw new Error("Token refresh returned no access token");
      }
      if (!leaseIsActive()) {
        return;
      }
      await this.repo.updateTokenRefreshStatus(account.id, {
        tokenRefreshLastAttemptAt: attemptAt,
        tokenRefreshLastSuccessAt: Date.now(),
        tokenRefreshLastError: undefined,
        tokenRefreshLastErrorAt: undefined,
        tokenRefreshLastErrorKind: undefined,
        tokenRefreshNextRetryAt: undefined
      });
    } catch (error) {
      if (!leaseIsActive()) {
        return;
      }
      const message = sanitizeApiErrorText(getErrorMessage(error)) || "Token refresh failed";
      await this.repo.updateTokenRefreshStatus(account.id, {
        tokenRefreshLastAttemptAt: attemptAt,
        tokenRefreshLastError: message,
        tokenRefreshLastErrorAt: Date.now(),
        tokenRefreshLastErrorKind: classifyTokenRefreshError(error),
        tokenRefreshNextRetryAt: Date.now() + this.intervalMs
      });
      console.warn(`[codexAccounts] daemon token refresh failed for ${account.email}: ${message}`);
    }
  }
}

function classifyTokenRefreshError(error: unknown): "network" | "reauthorize" | "provider_response" | "storage" | "unknown" {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("invalid_grant") || message.includes("refresh_token_reused") || message.includes("revoked")) {
    return "reauthorize";
  }
  if (message.includes("network") || message.includes("timeout") || message.includes("fetch failed")) {
    return "network";
  }
  if (message.includes("storage") || message.includes("credential store")) {
    return "storage";
  }
  return "unknown";
}

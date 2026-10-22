import { describe, expect, it } from "vitest";
import type { CodexAccountRecord } from "../src/core/types";
import { HeadlessQuotaCountdownScheduler } from "../src/runtime/quotaCountdownScheduler";

describe("headless quota countdown scheduler", () => {
  it("refreshes and starts only eligible automatic accounts", async () => {
    const eligible = createAccount("eligible@example.com");
    const outgoing = {
      ...createAccount("outgoing@example.com"),
      sharing: {
        direction: "outgoing" as const,
        leaseId: "lease",
        state: "shared" as const,
        peerUserId: "peer",
        expiresAt: 1,
        sharedAt: 1
      }
    };
    const accounts = [eligible, outgoing];
    let refreshes = 0;
    let starts = 0;
    const repo = createRepo(accounts);
    const scheduler = new HeadlessQuotaCountdownScheduler(repo, 60_000, {
      refreshAccount: async () => {
        refreshes += 1;
      },
      startCountdown: async (_accountId, options) => {
        await options.refreshBeforeStart?.();
        starts += 1;
        await options.refreshAfterStart?.();
        return "started";
      }
    });

    await scheduler.runNow();
    scheduler.dispose();

    expect(refreshes).toBe(2);
    expect(starts).toBe(1);
  });

  it("does not keep overlapping sweeps in flight", async () => {
    const account = createAccount("one@example.com");
    const repo = createRepo([account]);
    let releaseRefresh!: () => void;
    const refreshFinished = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let starts = 0;
    const scheduler = new HeadlessQuotaCountdownScheduler(repo, 60_000, {
      refreshAccount: async () => refreshFinished,
      startCountdown: async (_accountId, options) => {
        await options.refreshBeforeStart?.();
        starts += 1;
        return "started";
      }
    });

    const first = scheduler.runNow();
    const second = scheduler.runNow();
    releaseRefresh();
    await Promise.all([first, second]);
    scheduler.dispose();

    expect(starts).toBe(1);
  });
});

function createAccount(email: string): CodexAccountRecord {
  return {
    id: email,
    email,
    accountKind: "chatgpt",
    quotaMode: "chatgpt",
    createdAt: 1,
    updatedAt: 1,
    quotaSummary: {
      hourlyPercentage: 100,
      hourlyWindowPresent: true,
      hourlyResetTime: Math.floor(Date.now() / 1000) + 5 * 60 * 60,
      hourlyWindowMinutes: 5 * 60,
      weeklyPercentage: 100,
      weeklyWindowPresent: true,
      weeklyResetTime: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      weeklyWindowMinutes: 7 * 24 * 60,
      codeReviewPercentage: 0
    }
  };
}

function createRepo(accounts: readonly CodexAccountRecord[]) {
  let locked = false;
  return {
    listAccounts: async () => [...accounts],
    invalidateExternalStateCaches: () => undefined,
    tryAcquireSchedulerLease: async () => {
      if (locked) {
        return undefined;
      }
      locked = true;
      return {
        renew: async () => true,
        release: async () => {
          locked = false;
        }
      };
    }
  } as never;
}

import { beforeEach, describe, expect, it } from "vitest";
import type { CodexAccountRecord } from "../src/core/types";
import {
  AccountConcurrencyTracker,
  getPersistedAccountConcurrencySnapshot,
  prunePersistedAccountConcurrencyWindows,
  updatePersistedAccountConcurrencyWindows
} from "../src/application/accounts/accountConcurrency";

describe("AccountConcurrencyTracker", () => {
  let tracker: AccountConcurrencyTracker;

  beforeEach(() => {
    tracker = new AccountConcurrencyTracker();
  });

  it("keeps the window high-water mark and aggregates token rate by total time", () => {
    tracker.record({ sessionId: "session-1", accountId: "account-a", active: true });
    tracker.record({ sessionId: "session-2", accountId: "account-a", active: true });
    tracker.record({
      sessionId: "session-1",
      accountId: "account-a",
      active: false,
      tokens: 100,
      durationMs: 10_000
    });
    tracker.record({
      sessionId: "session-2",
      accountId: "account-a",
      active: false,
      tokens: 300,
      durationMs: 30_000
    });

    expect(tracker.get("account-a")).toEqual({
      current: 0,
      max: 2,
      totalTokens: 400,
      totalDurationMs: 40_000,
      averageTokenRate: 10
    });
  });

  it("does not count duplicate activity reports twice", () => {
    tracker.record({ sessionId: "session-1", accountId: "account-a", active: true });
    tracker.record({ sessionId: "session-1", accountId: "account-a", active: true });
    tracker.record({
      sessionId: "session-1",
      accountId: "account-a",
      active: false,
      tokens: 50,
      durationMs: 5_000
    });

    expect(tracker.get("account-a")).toMatchObject({ current: 0, max: 1, totalTokens: 50, totalDurationMs: 5_000 });
  });

  it("persists quota-window aggregates as sum(tokens) divided by sum(time)", () => {
    const account = {
      id: "account-a",
      email: "a@example.com",
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
      quotaSummary: {
        hourlyPercentage: 80,
        hourlyWindowPresent: true,
        hourlyResetTime: 1_000,
        hourlyWindowMinutes: 300,
        weeklyPercentage: 90,
        weeklyWindowPresent: true,
        weeklyResetTime: 2_000,
        weeklyWindowMinutes: 10_080,
        codeReviewPercentage: 100
      }
    } as CodexAccountRecord;

    let windows = updatePersistedAccountConcurrencyWindows(account, {
      sessionId: "session-1",
      accountId: "account-a",
      active: true
    }, { current: 2, max: 2, totalTokens: 0, totalDurationMs: 0 });
    account.concurrencyWindows = windows;
    windows = updatePersistedAccountConcurrencyWindows(account, {
      sessionId: "session-1",
      accountId: "account-a",
      active: false,
      tokens: 100,
      durationMs: 10_000
    }, { current: 0, max: 2, totalTokens: 100, totalDurationMs: 10_000 });
    account.concurrencyWindows = windows;
    windows = updatePersistedAccountConcurrencyWindows(account, {
      sessionId: "session-2",
      accountId: "account-a",
      active: false,
      tokens: 300,
      durationMs: 30_000
    }, { current: 0, max: 2, totalTokens: 400, totalDurationMs: 40_000 });
    account.concurrencyWindows = windows;

    expect(getPersistedAccountConcurrencySnapshot(account)).toMatchObject({
      max: 2,
      totalTokens: 400,
      totalDurationMs: 40_000,
      averageTokenRate: 10
    });
  });

  it("prunes stale quota buckets when the reported reset window changes", () => {
    const account = {
      id: "account-a",
      email: "a@example.com",
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
      quotaSummary: {
        hourlyPercentage: 80,
        hourlyWindowPresent: true,
        hourlyResetTime: 2_000,
        hourlyWindowMinutes: 300,
        weeklyPercentage: 90,
        weeklyWindowPresent: true,
        weeklyResetTime: 3_000,
        weeklyWindowMinutes: 10_080,
        codeReviewPercentage: 100
      },
      concurrencyWindows: [
        { window: "hourly" as const, resetAt: 1_000, windowMinutes: 300, maxConcurrency: 4, totalTokens: 100, totalDurationMs: 10_000 },
        { window: "hourly" as const, resetAt: 2_000, windowMinutes: 300, maxConcurrency: 1, totalTokens: 0, totalDurationMs: 0 },
        { window: "weekly" as const, resetAt: 3_000, windowMinutes: 10_080, maxConcurrency: 2, totalTokens: 200, totalDurationMs: 20_000 }
      ]
    } as CodexAccountRecord;

    expect(prunePersistedAccountConcurrencyWindows(account)).toEqual([
      account.concurrencyWindows[1],
      account.concurrencyWindows[2]
    ]);
  });
});

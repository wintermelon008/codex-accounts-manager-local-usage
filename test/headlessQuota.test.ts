import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAccountRecord } from "../src/core/types";
import { clearAccountStates } from "../src/application/accounts/accountState";
import { resolveAccountHealth } from "../src/application/accounts/health";

const { refreshQuotaMock } = vi.hoisted(() => ({ refreshQuotaMock: vi.fn() }));

vi.mock("../src/services/quota", () => ({ refreshQuota: refreshQuotaMock }));

import {
  refreshAllQuotasHeadlessly,
  refreshImportedAccountQuotaHeadlessly
} from "../src/application/accounts/headlessQuota";

describe("headless quota refresh", () => {
  afterEach(() => {
    clearAccountStates();
    refreshQuotaMock.mockReset();
  });

  it("records successful quota authentication for the daemon-owned state", async () => {
    clearAccountStates();
    const account = {
      id: "account-a",
      accountId: "workspace-a",
      email: "account-a@example.invalid",
      accountKind: "chatgpt",
      quotaMode: "chatgpt",
      createdAt: 1,
      updatedAt: 1
    } satisfies Partial<CodexAccountRecord>;
    const tokens = {
      accountId: "workspace-a",
      accessToken: "access-token",
      refreshToken: "refresh-token"
    };
    const repo = {
      getAccount: vi.fn().mockResolvedValue(account),
      getTokens: vi.fn().mockResolvedValue(tokens),
      updateQuota: vi.fn().mockResolvedValue(account),
      refreshSubscriptionState: vi.fn().mockResolvedValue(undefined)
    };
    refreshQuotaMock.mockResolvedValue({
      quota: { hourlyPercentage: 0, hourlyWindowPresent: true },
      accessTokenAccepted: true
    });

    await refreshImportedAccountQuotaHeadlessly(repo as never, account.id);

    expect(
      resolveAccountHealth(account, tokens, { enabled: false, intervalMs: 0, skewSeconds: 300, accounts: {} })
    ).toMatchObject({ kind: "healthy", availability: "usable" });
  });

  it("reports a shared lease collision as busy instead of account failures", async () => {
    const account = {
      id: "account-a",
      email: "account-a@example.invalid",
      accountKind: "chatgpt",
      quotaMode: "chatgpt",
      createdAt: 1,
      updatedAt: 1
    } satisfies Partial<CodexAccountRecord>;
    const tryAcquireSchedulerLease = vi.fn().mockResolvedValue(undefined);
    const repo = {
      listAccounts: vi.fn().mockResolvedValue([account]),
      tryAcquireSchedulerLease
    };

    const result = await refreshAllQuotasHeadlessly(repo as never);

    expect(result).toMatchObject({
      total: 1,
      succeeded: 0,
      failed: 0,
      busy: true,
      unknownAccountIds: [],
      failedAccountIds: []
    });
    expect(tryAcquireSchedulerLease).toHaveBeenCalledWith("quota-refresh", 120_000, 30_000);
  });
});

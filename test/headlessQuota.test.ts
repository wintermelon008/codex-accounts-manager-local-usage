import { describe, expect, it, vi } from "vitest";
import type { CodexAccountRecord } from "../src/core/types";
import { refreshAllQuotasHeadlessly } from "../src/application/accounts/headlessQuota";

describe("headless quota refresh", () => {
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

import { describe, expect, it } from "vitest";
import type { CodexAccountRecord } from "../src/core/types";
import { resolveAccountHealth } from "../src/application/accounts/health";

describe("account health", () => {
  it("uses persisted OAuth refresh failures after a reload", () => {
    const account: CodexAccountRecord = {
      id: "account-1",
      email: "dev@example.com",
      isActive: false,
      tokenRefreshLastAttemptAt: 100,
      tokenRefreshLastError: "Token refresh failed (401)",
      tokenRefreshLastErrorAt: 100,
      tokenRefreshLastErrorKind: "reauthorize",
      createdAt: 1,
      updatedAt: 100
    };

    const health = resolveAccountHealth(account, undefined, {
      enabled: true,
      intervalMs: 300_000,
      skewSeconds: 300,
      accounts: {}
    });

    expect(health).toMatchObject({
      kind: "reauthorize",
      message: "Token refresh failed (401)"
    });
  });

  it("marks accounts without usable OAuth credentials for reauthorization", () => {
    const account: CodexAccountRecord = {
      id: "account-2",
      email: "missing@example.com",
      isActive: false,
      createdAt: 1,
      updatedAt: 100
    };

    const health = resolveAccountHealth(account, undefined, {
      enabled: true,
      intervalMs: 300_000,
      skewSeconds: 300,
      accounts: {}
    });

    expect(health).toEqual({
      kind: "reauthorize",
      issueKey: "reauthorize:credentials_missing",
      message: "Codex OAuth credentials are missing"
    });
  });
});

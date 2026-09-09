import { describe, expect, it } from "vitest";
import type { CodexAccountRecord } from "../src/core/types";
import { isAccountReauthorizationRequired } from "../src/domain/accountHealth";
import { resolveAccountHealth } from "../src/application/accounts/health";

describe("account health", () => {
  it("does not require reauthorization while the current access token is usable", () => {
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

    const health = resolveAccountHealth(account, {
      idToken: "id-token",
      accessToken: "access-token",
      refreshToken: "refresh-token"
    }, {
      enabled: true,
      intervalMs: 300_000,
      skewSeconds: 300,
      accounts: {}
    });

    expect(health).toMatchObject({
      kind: "refresh_unavailable",
      message: "Token refresh failed (401)"
    });
  });

  it("keeps network failures in the existing refresh-failed state", () => {
    const health = resolveAccountHealth(
      {
        id: "account-network",
        email: "network@example.com",
        isActive: false,
        tokenRefreshLastError: "Token refresh failed (503)",
        tokenRefreshLastErrorKind: "network",
        createdAt: 1,
        updatedAt: 100
      },
      { idToken: "id-token", accessToken: "access-token", refreshToken: "refresh-token" },
      { enabled: true, intervalMs: 300_000, skewSeconds: 300, accounts: {} }
    );

    expect(health).toMatchObject({ kind: "refresh_failed" });
  });

  it("requires reauthorization after the access token has actually expired", () => {
    const expiredAccessToken = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
    const health = resolveAccountHealth(
      {
        id: "account-expired",
        email: "expired@example.com",
        isActive: false,
        tokenRefreshLastError: "Token refresh failed (401)",
        tokenRefreshLastErrorKind: "reauthorize",
        createdAt: 1,
        updatedAt: 100
      },
      { idToken: "id-token", accessToken: expiredAccessToken, refreshToken: "refresh-token" },
      { enabled: true, intervalMs: 300_000, skewSeconds: 300, accounts: {} }
    );

    expect(health).toMatchObject({ kind: "access_token_invalid" });
  });

  it("distinguishes an access-token rejection from a refresh-token failure", () => {
    const health = resolveAccountHealth(
      {
        id: "account-access-token",
        email: "access@example.com",
        isActive: false,
        quotaError: { code: "unauthorized", message: "API returned 401", timestamp: 100 },
        createdAt: 1,
        updatedAt: 100
      },
      { idToken: "id-token", accessToken: "access-token", refreshToken: "refresh-token" },
      { enabled: true, intervalMs: 300_000, skewSeconds: 300, accounts: {} }
    );

    expect(health).toMatchObject({ kind: "access_token_invalid", message: "API returned 401" });
  });

  it("keeps all credential failures visible to reauthorization-dependent integrations", () => {
    expect(isAccountReauthorizationRequired("reauthorize")).toBe(true);
    expect(isAccountReauthorizationRequired("refresh_token_invalid")).toBe(false);
    expect(isAccountReauthorizationRequired("access_token_invalid")).toBe(true);
    expect(isAccountReauthorizationRequired("refresh_failed")).toBe(false);
    expect(isAccountReauthorizationRequired("refresh_unavailable")).toBe(false);
  });

  it("marks accounts without an access token as access-token invalid", () => {
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
      kind: "access_token_invalid",
      issueKey: "access_token_invalid:credentials_missing",
      message: "Codex access token is missing"
    });
  });

  it("does not require reauthorization for a usable access token without an id token", () => {
    const health = resolveAccountHealth(
      {
        id: "account-no-id-token",
        email: "no-id@example.com",
        isActive: false,
        createdAt: 1,
        updatedAt: 100
      },
      { accessToken: "access-token", refreshToken: "refresh-token" },
      { enabled: true, intervalMs: 300_000, skewSeconds: 300, accounts: {} }
    );

    expect(health).toMatchObject({ kind: "refresh_unavailable" });
  });
});

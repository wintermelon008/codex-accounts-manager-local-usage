import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAccountRecord } from "../src/core/types";
import { resolveAccountHealth } from "../src/application/accounts/health";
import { isAccountInvalid } from "../src/domain/accountHealth";
import {
  accessCredentialFingerprint,
  AVAILABILITY_TTL_MS,
  clearAccountStates,
  recordAvailability,
  recordRenewal,
  setAvailabilityRuntime,
  type RenewalKind
} from "../src/application/accounts/accountState";

const tokens = { accountId: "workspace", accessToken: "access-token", refreshToken: "refresh-token" };
const base: CodexAccountRecord = {
  id: "account",
  accountId: "workspace",
  email: "test@example.invalid",
  isActive: true,
  createdAt: 1,
  updatedAt: 1
};
const automation = { enabled: true, intervalMs: 300_000, skewSeconds: 300, accounts: {} };
const health = (account = base, credentials = tokens) => resolveAccountHealth(account, credentials, automation);
const observation = (kind: "usable" | "auth_unavailable" | "quota_limited", sequence = 1) => ({
  kind,
  sequence,
  localAccountId: base.id,
  accountId: "workspace",
  runtimeId: "runtime",
  observedAt: Date.now(),
  credentialFingerprint: accessCredentialFingerprint("workspace", tokens.accessToken)
});

beforeEach(() => {
  clearAccountStates();
  setAvailabilityRuntime("runtime");
  recordRenewal(base.id, tokens, "unknown");
});

afterEach(() => vi.useRealTimers());

describe("independent account availability and renewal", () => {
  it("keeps the local Mailbox deactivation signal as an explicit disabled state", () => {
    const health = resolveAccountHealth(
      {
        ...base,
        email: "blocked@example.invalid"
      },
      tokens,
      automation,
      { mailboxDeactivated: true }
    );
    expect(health).toMatchObject({
      kind: "disabled",
      issueKey: "disabled:mailbox_deactivated"
    });
  });
  it.each([
    { code: "unauthorized", message: "401 token expired" },
    { code: "deactivated_workspace", message: "API returned 402" },
    { code: "provider_response", message: "refresh token invalid_grant" }
  ])("does not turn historical quota error $code into account invalidity", (error) => {
    const account = {
      ...base,
      quotaError: { ...error, timestamp: Date.now() },
      lastQuotaAt: Date.now(),
      tokenRefreshLastError: "invalid_grant",
      tokenRefreshLastErrorKind: "reauthorize" as const
    };
    expect(health(account)).toMatchObject({ kind: "unverified", availability: "unknown", renewal: "unknown" });
    recordAvailability(observation("usable"));
    expect(health(account).kind).toBe("healthy");
  });

  it("does not claim missing or locally expired credentials prove account failure", () => {
    expect(resolveAccountHealth(base, undefined, automation).kind).toBe("unverified");
    expect(
      health(base, { ...tokens, accessToken: `header.${Buffer.from('{"exp":1}').toString("base64url")}.signature` })
        .kind
    ).toBe("unverified");
  });

  it.each<[RenewalKind, string, string]>([
    ["unknown", "unverified", "healthy"],
    ["refreshing", "refreshing", "refreshing"],
    ["succeeded", "healthy", "healthy"],
    ["unavailable", "refresh_unavailable_unverified", "refresh_unavailable"],
    ["network_failed", "refresh_failed", "refresh_failed"]
  ])("maps renewal %s separately from availability", (renewal, unknownKind, usableKind) => {
    recordRenewal(base.id, tokens, renewal);
    expect(health().kind).toBe(unknownKind);
    recordAvailability(observation("usable"));
    expect(health()).toMatchObject({ kind: usableKind, availability: "usable", renewal });
    expect(isAccountInvalid(health().kind)).toBe(false);
  });

  it("a newer real success clears red without erasing renewal failure", () => {
    recordRenewal(base.id, tokens, "unavailable");
    recordAvailability(observation("auth_unavailable"));
    expect(health().kind).toBe("access_token_invalid");
    recordAvailability(observation("usable", 2));
    expect(health().kind).toBe("refresh_unavailable");
    expect(recordAvailability(observation("auth_unavailable", 1))).toBe(false);
    expect(health().kind).toBe("refresh_unavailable");
  });

  it("successful renewal confirms the new credentials without a model request", () => {
    recordAvailability(observation("auth_unavailable"));
    const updated = { ...tokens, accessToken: "new-token", refreshToken: "new-refresh" };
    recordRenewal(base.id, updated, "succeeded");
    expect(health(base, updated)).toMatchObject({ kind: "healthy", availability: "usable", renewal: "succeeded" });
  });

  it("renewal success confirms inactive accounts without a resident model runtime", () => {
    setAvailabilityRuntime(undefined);
    recordRenewal(base.id, tokens, "succeeded");
    expect(health({ ...base, isActive: false })).toMatchObject({ kind: "healthy", availability: "usable" });
    expect(health({ ...base, id: "other" }).kind).toBe("unverified");
    expect(health({ ...base, accountId: "other" }).kind).toBe("unverified");
    expect(health(base, { ...tokens, accessToken: "unconfirmed" }).kind).toBe("unverified");
  });

  it.each(["unavailable", "network_failed"] as const)(
    "a subsequent renewal %s does not erase positive evidence",
    (failure) => {
      recordRenewal(base.id, tokens, "succeeded");
      recordRenewal(base.id, tokens, failure);
      expect(health()).toMatchObject({
        kind: failure === "unavailable" ? "refresh_unavailable" : "refresh_failed",
        availability: "usable",
        renewal: failure
      });
    }
  );

  it("renewal confirmation lasts until the issued access credential expires, not just fifteen minutes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const exp = Math.floor(Date.now() / 1000) + 3_600;
    const issued = {
      ...tokens,
      accessToken: `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`
    };
    recordRenewal(base.id, issued, "succeeded");
    vi.advanceTimersByTime(AVAILABILITY_TTL_MS + 1);
    expect(health(base, issued)).toMatchObject({ kind: "healthy", availability: "usable" });
    vi.setSystemTime(exp * 1000);
    expect(health(base, issued)).toMatchObject({ kind: "unverified", availability: "unknown" });
  });

  it("an old delayed rejection cannot undo renewal success, but a newer real rejection can", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const old = observation("auth_unavailable");
    recordAvailability(old);
    vi.advanceTimersByTime(1);
    recordRenewal(base.id, tokens, "succeeded");
    expect(health().kind).toBe("healthy");
    expect(recordAvailability({ ...old, sequence: 2 })).toBe(false);
    expect(health().kind).toBe("healthy");
    vi.advanceTimersByTime(1);
    recordAvailability(observation("auth_unavailable", 3));
    expect(health().kind).toBe("access_token_invalid");
  });

  it("successful renewal does not clear a known quota limit on the same account", () => {
    recordAvailability(observation("quota_limited"));
    const issued = { ...tokens, accessToken: "issued", refreshToken: "rotated" };
    recordRenewal(base.id, issued, "succeeded");
    expect(health(base, issued)).toMatchObject({ kind: "quota", availability: "quota_limited", renewal: "succeeded" });
  });

  it("a newer unresolved authentication rejection invalidates the older renewal confirmation", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const exp = Math.floor(Date.now() / 1000) + 3_600;
    const issued = {
      ...tokens,
      accessToken: `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`
    };
    recordRenewal(base.id, issued, "succeeded");
    vi.advanceTimersByTime(1);
    recordAvailability({
      ...observation("auth_unavailable"),
      kind: "unknown",
      credentialFingerprint: accessCredentialFingerprint("workspace", issued.accessToken)
    });
    expect(health(base, issued).kind).toBe("unverified");
    vi.advanceTimersByTime(AVAILABILITY_TTL_MS + 1);
    expect(health(base, issued).kind).toBe("unverified");
  });

  it("uses still-valid renewal evidence after a known quota window resets", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    recordAvailability(observation("quota_limited"));
    vi.advanceTimersByTime(2_000);
    recordRenewal(base.id, tokens, "succeeded");
    const quotaSummary = { hourlyResetTime: Math.floor(Date.now() / 1000) - 1 };
    expect(health({ ...base, quotaSummary })).toMatchObject({ kind: "healthy", availability: "usable" });
  });

  it("retains accepted local evidence after runtime restart but rejects foreign or late events", () => {
    recordAvailability(observation("auth_unavailable"));
    expect(health({ ...base, id: "other" }).kind).toBe("unverified");
    expect(health({ ...base, accountId: "other" }).kind).toBe("unverified");
    setAvailabilityRuntime("other-runtime");
    expect(health().kind).toBe("access_token_invalid");
    expect(recordAvailability(observation("auth_unavailable", 2))).toBe(false);
    setAvailabilityRuntime("runtime");
    expect(
      recordAvailability({ ...observation("auth_unavailable"), observedAt: Date.now() - AVAILABILITY_TTL_MS })
    ).toBe(false);
  });

  it("quota exhaustion is not an authentication failure and success clears it", () => {
    recordAvailability(observation("quota_limited"));
    expect(health().kind).toBe("quota");
    expect(isAccountInvalid(health().kind)).toBe(false);
    recordAvailability(observation("usable", 2));
    expect(health().kind).toBe("healthy");
  });

  it("a known quota reset in seconds clears only an older quota verdict, not into usable", () => {
    const now = Date.now();
    recordAvailability({ ...observation("quota_limited"), observedAt: now - 10_000 });
    const quotaSummary = { hourlyResetTime: Math.floor(now / 1000) - 1 };
    expect(health({ ...base, quotaSummary })).toMatchObject({ kind: "unverified", availability: "unknown" });
    expect(health({ ...base, quotaSummary: { hourlyResetTime: Math.floor(now / 1000) + 30 } }).kind).toBe("quota");
    expect(health({ ...base, quotaSummary: { hourlyResetTime: Math.floor(now / 1000) - 30 } }).kind).toBe("quota");
    recordAvailability({ ...observation("auth_unavailable", 2), observedAt: now - 10_000 });
    expect(health({ ...base, quotaSummary }).kind).toBe("access_token_invalid");
  });
});

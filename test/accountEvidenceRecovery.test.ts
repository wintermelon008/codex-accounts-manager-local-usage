import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as state from "../src/application/accounts/accountState";
import { resolveAccountHealth } from "../src/application/accounts/health";

const now = Date.UTC(2026, 8, 14, 9);
const started = now - 600_000;
const account = {
  id: "saved",
  accountId: "workspace",
  email: "example@invalid.test",
  isActive: false,
  isHidden: true,
  createdAt: 1,
  updatedAt: now,
  tokenRefreshLastAttemptAt: started + 5,
  tokenRefreshLastSuccessAt: started + 626
};
const token = (iat = started / 1000, workspace = "workspace") =>
  `header.${Buffer.from(
    JSON.stringify({
      iat,
      exp: iat + 864_000,
      "https://api.openai.com/auth": { chatgpt_account_id: workspace }
    })
  ).toString("base64url")}.signature`;
const credentials = () => ({ accountId: "workspace", accessToken: token(), refreshToken: "refresh" });
const idTokenWithEmail = (email: string, iat = started / 1000) =>
  `header.${Buffer.from(
    JSON.stringify({
      email,
      iat,
      exp: iat + 864_000,
      "https://api.openai.com/auth": { user_id: "auth0|provider-user" }
    })
  ).toString("base64url")}.signature`;
const automation = { enabled: false, intervalMs: 0, skewSeconds: 300, accounts: {} };
const values = new Map<string, unknown>();
const store = {
  keys: () => [...values.keys()],
  get: <T>(key: string) => structuredClone(values.get(key)) as T,
  update: async (key: string, value: unknown) => {
    values.set(key, structuredClone(value));
  }
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  values.clear();
  state.initAccountStatePersistence(store);
});
afterEach(() => {
  state.clearAccountStates();
  vi.useRealTimers();
});

describe("existing local renewal evidence", () => {
  it("recovers an inactive hidden account whose current credential was issued during its recorded successful renewal", async () => {
    const tokens = credentials();
    expect(resolveAccountHealth(account, tokens, automation)).toMatchObject({
      kind: "healthy",
      renewal: "succeeded",
      availability: "usable"
    });
    await state.flushAccountStates();
    for (let restart = 0; restart < 2; restart++) {
      state.initAccountStatePersistence(store);
      vi.advanceTimersByTime(16 * 60_000);
      expect(resolveAccountHealth(account, tokens, automation).kind).toBe("healthy");
    }
    const serialized = JSON.stringify([...values]);
    expect(serialized).not.toContain(tokens.accessToken);
    expect(serialized).not.toContain(tokens.refreshToken);
  });

  it.each([
    "issued-before",
    "issued-after",
    "other-workspace",
    "missing-attempt",
    "later-error",
    "expired",
    "only-success"
  ])("does not manufacture proof from an unrelated legacy record: %s", (scenario) => {
    let tokens = credentials();
    let record = { ...account } as typeof account & { tokenRefreshLastErrorAt?: number };
    if (scenario === "issued-before") tokens.accessToken = token(started / 1000 - 60);
    if (scenario === "issued-after") tokens.accessToken = token(started / 1000 + 60);
    if (scenario === "other-workspace") tokens.accessToken = token(started / 1000, "other");
    if (scenario === "missing-attempt") record.tokenRefreshLastAttemptAt = 0;
    if (scenario === "later-error") record.tokenRefreshLastErrorAt = now - 1;
    if (scenario === "expired") vi.setSystemTime(now + 11 * 86400_000);
    if (scenario === "only-success") tokens.accessToken = "opaque-token";
    expect(resolveAccountHealth(record, tokens, automation).availability).toBe("unknown");
  });

  it("pins a recovered success and never reapplies its timestamp to replacement credentials", async () => {
    expect(resolveAccountHealth(account, credentials(), automation).kind).toBe("healthy");
    await state.flushAccountStates();
    state.initAccountStatePersistence(store);
    const replacement = { ...credentials(), accessToken: token() + "different-signature" };
    expect(resolveAccountHealth(account, replacement, automation).availability).toBe("unknown");
  });

  it("rechecks legacy evidence after another host replaces a stale credential", () => {
    expect(resolveAccountHealth(account, { ...credentials(), accessToken: "opaque-old-token" }, automation).kind).toBe(
      "unverified"
    );
    state.resetAccountHealthEvidenceForCredentialChange(account.id);
    expect(resolveAccountHealth(account, credentials(), automation)).toMatchObject({
      kind: "healthy",
      availability: "usable",
      renewal: "succeeded"
    });
  });

  it("rechecks the pre-recovery boolean marker after a host restart", () => {
    values.set(`accountHealthEvidence.v1.${encodeURIComponent(account.id)}`, {
      version: 1,
      legacySuccessChecked: true
    });
    state.initAccountStatePersistence(store);
    expect(resolveAccountHealth(account, credentials(), automation)).toMatchObject({
      kind: "healthy",
      availability: "usable",
      renewal: "succeeded"
    });
  });

  it("rechecks the persisted object marker left by an earlier failed migration", () => {
    values.set(`accountHealthEvidence.v1.${encodeURIComponent(account.id)}`, {
      version: 1,
      legacySuccessChecked: {
        accountId: account.accountId,
        attemptAt: account.tokenRefreshLastAttemptAt,
        successAt: account.tokenRefreshLastSuccessAt,
        errorAt: undefined
      }
    });
    state.initAccountStatePersistence(store);
    expect(resolveAccountHealth(account, credentials(), automation)).toMatchObject({
      kind: "healthy",
      availability: "usable",
      renewal: "succeeded"
    });
  });

  it("rechecks when the persisted refresh result appears after the first health read", () => {
    const incomplete = {
      ...account,
      tokenRefreshLastAttemptAt: undefined,
      tokenRefreshLastSuccessAt: undefined
    };
    expect(resolveAccountHealth(incomplete, credentials(), automation).availability).toBe("unknown");
    expect(resolveAccountHealth(account, credentials(), automation)).toMatchObject({
      kind: "healthy",
      availability: "usable",
      renewal: "succeeded"
    });
  });

  it("records successful runtime switches as usable authentication evidence", async () => {
    const tokens = { ...credentials(), idToken: token() };
    state.recordRenewal(account.id, tokens, "unknown");
    state.recordRuntimeAuthenticationSuccess(account.id, tokens);
    expect(resolveAccountHealth(account, tokens, automation)).toMatchObject({
      kind: "healthy",
      availability: "usable",
      renewal: "unknown"
    });
    await state.flushAccountStates();
    state.initAccountStatePersistence(store);
    expect(resolveAccountHealth(account, tokens, automation).kind).toBe("healthy");
  });

  it("supports a provider credential without a workspace claim only when its user identity matches the local record", () => {
    const tokens = {
      ...credentials(),
      accessToken: `header.${Buffer.from(
        JSON.stringify({
          iat: started / 1000,
          exp: started / 1000 + 864_000,
          "https://api.openai.com/auth": { user_id: "provider-user" }
        })
      ).toString("base64url")}.signature`
    };
    expect(resolveAccountHealth({ ...account, userId: "provider-user" }, tokens, automation).kind).toBe("healthy");
    expect(
      resolveAccountHealth({ ...account, id: "other", userId: "wrong-user" }, tokens, automation).availability
    ).toBe("unknown");
  });

  it("recovers legacy evidence when the signed email matches but the imported user id uses another namespace", () => {
    const tokens = {
      ...credentials(),
      idToken: idTokenWithEmail(account.email),
      accessToken: `header.${Buffer.from(
        JSON.stringify({
          iat: started / 1000,
          exp: started / 1000 + 864_000,
          "https://api.openai.com/auth": { user_id: "auth0|provider-user" }
        })
      ).toString("base64url")}.signature`
    };
    expect(resolveAccountHealth({ ...account, userId: "user-legacy-namespace" }, tokens, automation)).toMatchObject({
      kind: "healthy",
      availability: "usable",
      renewal: "succeeded"
    });
  });

  it("does not turn a cached exhausted quota into a session warning", () => {
    const quotaAccount = {
      ...account,
      lastQuotaAt: now - 1_000,
      quotaSummary: {
        hourlyPercentage: 100,
        weeklyPercentage: 0,
        weeklyWindowPresent: true,
        weeklyWindowMinutes: 43_200,
        codeReviewPercentage: 0,
        rawData: { rate_limit: { allowed: false, limit_reached: true } }
      }
    };
    const tokens = {
      ...credentials(),
      idToken: idTokenWithEmail(account.email),
      accessToken: `header.${Buffer.from(
        JSON.stringify({
          iat: started / 1000,
          exp: started / 1000 + 864_000,
          "https://api.openai.com/auth": { user_id: "auth0|provider-user" }
        })
      ).toString("base64url")}.signature`
    };
    expect(
      resolveAccountHealth({ ...quotaAccount, userId: "user-legacy-namespace" }, tokens, automation)
    ).toMatchObject({
      kind: "healthy",
      availability: "usable",
      renewal: "succeeded"
    });
  });

  it("drops a stale quota-limited observation when a newer snapshot explicitly allows the account", () => {
    const tokens = credentials();
    state.setAvailabilityRuntime("runtime");
    state.recordAvailability(
      {
        localAccountId: account.id,
        accountId: "workspace",
        runtimeId: "runtime",
        credentialFingerprint: state.accessCredentialFingerprint("workspace", tokens.accessToken),
        kind: "quota_limited",
        observedAt: now - 5_000,
        sequence: 1
      },
      now,
      tokens
    );
    state.recordRenewal(account.id, tokens, "succeeded");
    const quotaAccount = {
      ...account,
      lastQuotaAt: now,
      quotaSummary: {
        hourlyPercentage: 100,
        weeklyPercentage: 0,
        weeklyWindowPresent: true,
        weeklyWindowMinutes: 43_200,
        codeReviewPercentage: 0,
        rawData: { rate_limit: { allowed: true, limit_reached: false } }
      }
    };
    expect(resolveAccountHealth(quotaAccount, tokens, automation)).toMatchObject({
      kind: "healthy",
      availability: "usable",
      renewal: "succeeded"
    });
  });

  it("keeps newer actual authentication rejection instead of resurrecting an older legacy success", () => {
    const tokens = credentials();
    state.setAvailabilityRuntime("runtime");
    state.recordAvailability({
      localAccountId: account.id,
      accountId: account.accountId,
      runtimeId: "runtime",
      credentialFingerprint: state.accessCredentialFingerprint(account.accountId, tokens.accessToken),
      kind: "auth_unavailable",
      observedAt: now,
      sequence: 1
    });
    expect(resolveAccountHealth(account, tokens, automation).kind).toBe("access_token_invalid");
  });

  it("retries legacy evidence after a failed migration check when the current credential changes", async () => {
    expect(resolveAccountHealth(account, { ...credentials(), accessToken: "different" }, automation).availability).toBe(
      "unknown"
    );
    await state.flushAccountStates();
    state.initAccountStatePersistence(store);
    expect(resolveAccountHealth(account, credentials(), automation)).toMatchObject({
      kind: "healthy",
      availability: "usable",
      renewal: "succeeded"
    });
  });

  it("recognizes the actual invalid_refresh_token response without interpreting arbitrary 401 as renewal rejection", () => {
    expect(state.classifyRenewalFailure({ context: { errorCode: "invalid_refresh_token" }, statusCode: 401 })).toBe(
      "unavailable"
    );
    expect(
      state.classifyRenewalFailure(
        new Error("Token refresh failed (401): Invalid refresh token. [error_code:invalid_refresh_token]")
      )
    ).toBe("unavailable");
    expect(state.classifyRenewalFailure({ statusCode: 401, message: "Authentication proxy denied request" })).toBe(
      "unknown"
    );
  });

  it("reclassifies a previously missed rejection only when its saved credential fingerprint and error time match", () => {
    const tokens = credentials();
    state.recordRenewal(account.id, tokens, "unknown");
    const rejected = {
      ...account,
      tokenRefreshLastErrorAt: now + 1,
      tokenRefreshLastError: "Token refresh failed (401): Invalid refresh token. [error_code:invalid_refresh_token]"
    };
    expect(resolveAccountHealth(rejected, tokens, automation)).toMatchObject({
      kind: "refresh_unavailable_unverified",
      renewal: "unavailable",
      availability: "unknown"
    });
    expect(resolveAccountHealth(rejected, { ...tokens, accessToken: "replacement" }, automation).renewal).toBe(
      "unknown"
    );
  });

  it("does not reclassify an unrelated historical error on the same credentials", () => {
    const tokens = credentials();
    state.recordRenewal(account.id, tokens, "unknown");
    expect(
      resolveAccountHealth(
        { ...account, tokenRefreshLastErrorAt: started, tokenRefreshLastError: "[error_code:invalid_refresh_token]" },
        tokens,
        automation
      ).renewal
    ).toBe("unknown");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as state from "../src/application/accounts/accountState";
import { resolveAccountHealth } from "../src/application/accounts/health";

const now = Date.UTC(2026, 8, 14, 9);
const started = now - 600_000;
const account = { id: "saved", accountId: "workspace", email: "example@invalid.test", isActive: false,
  isHidden: true, createdAt: 1, updatedAt: now,
  tokenRefreshLastAttemptAt: started + 5, tokenRefreshLastSuccessAt: started + 626 };
const token = (iat = started / 1000, workspace = "workspace") => `header.${Buffer.from(JSON.stringify({
  iat, exp: iat + 864_000, "https://api.openai.com/auth": { chatgpt_account_id: workspace }
})).toString("base64url")}.signature`;
const credentials = () => ({ accountId: "workspace", accessToken: token(), refreshToken: "refresh" });
const automation = { enabled: false, intervalMs: 0, skewSeconds: 300, accounts: {} };
const values = new Map<string, unknown>();
const store = { keys: () => [...values.keys()], get: <T>(key: string) => structuredClone(values.get(key)) as T,
  update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); } };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); values.clear(); state.initAccountStatePersistence(store); });
afterEach(() => { state.clearAccountStates(); vi.useRealTimers(); });

describe("existing local renewal evidence", () => {
  it("recovers an inactive hidden account whose current credential was issued during its recorded successful renewal", async () => {
    const tokens = credentials();
    expect(resolveAccountHealth(account, tokens, automation)).toMatchObject({ kind: "healthy", renewal: "succeeded", availability: "usable" });
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

  it.each(["issued-before", "issued-after", "other-workspace", "missing-attempt", "later-error", "expired", "only-success"])(
    "does not manufacture proof from an unrelated legacy record: %s", (scenario) => {
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
    await state.flushAccountStates(); state.initAccountStatePersistence(store);
    const replacement = { ...credentials(), accessToken: token() + "different-signature" };
    expect(resolveAccountHealth(account, replacement, automation).availability).toBe("unknown");
  });

  it("supports a provider credential without a workspace claim only when its user identity matches the local record", () => {
    const tokens = { ...credentials(), accessToken: `header.${Buffer.from(JSON.stringify({
      iat: started / 1000, exp: started / 1000 + 864_000,
      "https://api.openai.com/auth": { user_id: "provider-user" }
    })).toString("base64url")}.signature` };
    expect(resolveAccountHealth({ ...account, userId: "provider-user" }, tokens, automation).kind).toBe("healthy");
    expect(resolveAccountHealth({ ...account, id: "other", userId: "wrong-user" }, tokens, automation).availability).toBe("unknown");
  });

  it("keeps newer actual authentication rejection instead of resurrecting an older legacy success", () => {
    const tokens = credentials();
    state.setAvailabilityRuntime("runtime");
    state.recordAvailability({ localAccountId: account.id, accountId: account.accountId, runtimeId: "runtime",
      credentialFingerprint: state.accessCredentialFingerprint(account.accountId, tokens.accessToken),
      kind: "auth_unavailable", observedAt: now, sequence: 1 });
    expect(resolveAccountHealth(account, tokens, automation).kind).toBe("access_token_invalid");
  });

  it("does not adopt a historical success after the first migration check saw another credential, including after reboot", async () => {
    expect(resolveAccountHealth(account, { ...credentials(), accessToken: "different" }, automation).availability).toBe("unknown");
    await state.flushAccountStates(); state.initAccountStatePersistence(store);
    expect(resolveAccountHealth(account, credentials(), automation).availability).toBe("unknown");
  });

  it("recognizes the actual invalid_refresh_token response without interpreting arbitrary 401 as renewal rejection", () => {
    expect(state.classifyRenewalFailure({ context: { errorCode: "invalid_refresh_token" }, statusCode: 401 })).toBe("unavailable");
    expect(state.classifyRenewalFailure(new Error("Token refresh failed (401): Invalid refresh token. [error_code:invalid_refresh_token]"))).toBe("unavailable");
    expect(state.classifyRenewalFailure({ statusCode: 401, message: "Authentication proxy denied request" })).toBe("unknown");
  });

  it("reclassifies a previously missed rejection only when its saved credential fingerprint and error time match", () => {
    const tokens = credentials();
    state.recordRenewal(account.id, tokens, "unknown");
    const rejected = { ...account, tokenRefreshLastErrorAt: now + 1,
      tokenRefreshLastError: "Token refresh failed (401): Invalid refresh token. [error_code:invalid_refresh_token]" };
    expect(resolveAccountHealth(rejected, tokens, automation)).toMatchObject({ kind: "refresh_unavailable_unverified", renewal: "unavailable", availability: "unknown" });
    expect(resolveAccountHealth(rejected, { ...tokens, accessToken: "replacement" }, automation).renewal).toBe("unknown");
  });

  it("does not reclassify an unrelated historical error on the same credentials", () => {
    const tokens = credentials(); state.recordRenewal(account.id, tokens, "unknown");
    expect(resolveAccountHealth({ ...account, tokenRefreshLastErrorAt: started,
      tokenRefreshLastError: "[error_code:invalid_refresh_token]" }, tokens, automation).renewal).toBe("unknown");
  });
});

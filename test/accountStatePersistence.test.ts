import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as state from "../src/application/accounts/accountState";
import { resolveAccountHealth } from "../src/application/accounts/health";

const account = { id: "saved-inactive", accountId: "workspace", email: "test@example.invalid", isActive: false,
  createdAt: 1, updatedAt: 1 };
const automation = { enabled: false, intervalMs: 0, skewSeconds: 300, accounts: {} };
const values = new Map<string, unknown>();
const store = {
  keys: () => [...values.keys()],
  get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
  update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }
};
const credentials = () => ({ accountId: "workspace", idToken: "id-secret", refreshToken: "refresh-secret",
  accessToken: `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 864_000 })).toString("base64url")}.signature` });
const observation = (tokens: ReturnType<typeof credentials>, kind: state.AvailabilityKind, sequence = 1) => ({
  localAccountId: account.id, accountId: "workspace", credentialFingerprint: state.accessCredentialFingerprint("workspace", tokens.accessToken),
  runtimeId: "runtime-a", observedAt: Date.now(), sequence, kind
});

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); values.clear(); state.clearAccountStates(); });
afterEach(() => { state.clearAccountStates(); vi.useRealTimers(); });

describe("durable local account evidence (no provider requests)", () => {
  it.each(["renewal", "conversation"] as const)("keeps %s proof through two restarts and beyond fifteen minutes", async (source) => {
    state.initAccountStatePersistence(store);
    const tokens = credentials();
    state.setAvailabilityRuntime("runtime-a");
    if (source === "renewal") state.recordRenewal(account.id, tokens, "succeeded");
    else state.recordAvailability(observation(tokens, "usable"), Date.now(), tokens);
    state.recordRenewal(account.id, tokens, "unavailable");
    await state.flushAccountStates();
    for (let restart = 0; restart < 2; restart++) {
      state.clearAccountStates();
      state.initAccountStatePersistence(store);
      state.setAvailabilityRuntime(`restarted-${restart}`);
      vi.advanceTimersByTime(16 * 60_000);
      expect(resolveAccountHealth(account, tokens, automation).kind).toBe("refresh_unavailable");
    }
    const serialized = JSON.stringify([...values]);
    for (const secret of [tokens.accessToken, tokens.refreshToken, tokens.idToken, account.email]) expect(serialized).not.toContain(secret);
    vi.advanceTimersByTime(10 * 86400_000);
    expect(resolveAccountHealth(account, tokens, automation).kind).toBe("refresh_unavailable_unverified");
  });

  it("keeps unconfirmed renewal failure as unconfirmed across restart, never inventing success", async () => {
    state.initAccountStatePersistence(store);
    const tokens = credentials();
    state.recordRenewal(account.id, tokens, "unavailable");
    await state.flushAccountStates();
    state.clearAccountStates(); state.initAccountStatePersistence(store);
    expect(resolveAccountHealth(account, tokens, automation).kind).toBe("refresh_unavailable_unverified");
    expect(resolveAccountHealth({ ...account, tokenRefreshLastSuccessAt: Date.now() }, tokens, automation).kind)
      .toBe("refresh_unavailable_unverified");
  });

  it("does not apply saved errors to replacement credentials or another workspace", async () => {
    state.initAccountStatePersistence(store);
    const tokens = credentials();
    state.setAvailabilityRuntime("runtime-a");
    state.recordRenewal(account.id, tokens, "unavailable");
    state.recordAvailability(observation(tokens, "auth_unavailable"), Date.now(), tokens);
    await state.flushAccountStates(); state.clearAccountStates(); state.initAccountStatePersistence(store);
    expect(resolveAccountHealth(account, tokens, automation).kind).toBe("access_token_invalid");
    expect(resolveAccountHealth(account, { ...tokens, accessToken: "new-credential" }, automation).kind).toBe("unverified");
    expect(state.readAvailability(account.id, "other-workspace", tokens).kind).toBe("unknown");
    expect(state.readAvailability("another-account", "workspace", tokens).kind).toBe("unknown");
    state.recordRenewal(account.id, { ...tokens, accessToken: "new-credential" }, "unavailable");
    expect(resolveAccountHealth(account, { ...tokens, accessToken: "new-credential" }, automation).kind)
      .toBe("refresh_unavailable_unverified");
  });

  it("new runtime success clears old red, but late messages from an old runtime cannot restore it", async () => {
    state.initAccountStatePersistence(store);
    const tokens = credentials();
    state.setAvailabilityRuntime("runtime-a");
    state.recordRenewal(account.id, tokens, "unavailable");
    state.recordAvailability(observation(tokens, "auth_unavailable", 20), Date.now(), tokens);
    await state.flushAccountStates(); state.clearAccountStates(); state.initAccountStatePersistence(store);
    vi.advanceTimersByTime(1000);
    state.setAvailabilityRuntime("runtime-b");
    expect(state.recordAvailability({ ...observation(tokens, "usable"), runtimeId: "runtime-b" }, Date.now(), tokens)).toBe(true);
    expect(state.recordAvailability(observation(tokens, "auth_unavailable", 21), Date.now(), tokens)).toBe(false);
    expect(resolveAccountHealth(account, tokens, automation).kind).toBe("refresh_unavailable");
  });

  it("fresh same-account authorization removes renewal failure without inventing a renewal attempt", async () => {
    state.initAccountStatePersistence(store);
    const tokens = credentials();
    state.recordRenewal(account.id, tokens, "unavailable");
    state.recordAuthorization(account.id, tokens);
    await state.flushAccountStates(); state.clearAccountStates(); state.initAccountStatePersistence(store);
    expect(resolveAccountHealth(account, tokens, automation)).toMatchObject({ kind: "healthy", renewal: "unknown" });
  });

  it("new renewal success permanently supersedes older rejection of the same access credential", async () => {
    state.initAccountStatePersistence(store);
    const tokens = credentials();
    state.setAvailabilityRuntime("runtime-a");
    state.recordAvailability(observation(tokens, "auth_unavailable"), Date.now(), tokens);
    vi.advanceTimersByTime(1);
    state.recordRenewal(account.id, tokens, "succeeded");
    state.recordRenewal(account.id, tokens, "unavailable");
    await state.flushAccountStates(); state.clearAccountStates(); state.initAccountStatePersistence(store);
    vi.advanceTimersByTime(10 * 86400_000);
    expect(resolveAccountHealth(account, tokens, automation).kind).toBe("refresh_unavailable_unverified");
  });

  it("a fresh store on another host cannot import local health verdicts", () => {
    const tokens = credentials();
    state.initAccountStatePersistence(store);
    state.recordRenewal(account.id, tokens, "succeeded");
    state.initAccountStatePersistence({ keys: () => [], get: () => undefined, update: async () => {} });
    expect(resolveAccountHealth(account, tokens, automation).kind).toBe("unverified");
  });
});

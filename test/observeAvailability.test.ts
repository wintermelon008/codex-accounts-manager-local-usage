import { beforeEach, describe, expect, it, vi } from "vitest";
import { observeAccountAvailability } from "../src/application/accounts/observeAvailability";
import {
  accessCredentialFingerprint,
  clearAccountStates,
  readAvailability,
  recordRenewal,
  setAvailabilityRuntime
} from "../src/application/accounts/accountState";
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../src/auth/tokenRefreshCoordinator", () => ({ ensureFreshAccountTokens: refresh }));

const tokens = { accessToken: "access", refreshToken: "refresh", accountId: "workspace" };
const event = {
  localAccountId: "account",
  accountId: "workspace",
  credentialFingerprint: accessCredentialFingerprint("workspace", "access"),
  runtimeId: "runtime",
  sequence: 1,
  observedAt: Date.now(),
  kind: "auth_rejected" as const
};
const repo = {
  getAccount: vi.fn(async () => ({ id: "account", accountId: "workspace" })),
  getTokens: vi.fn(async () => tokens),
  updateTokens: vi.fn(),
  tryAcquireSchedulerLease: vi.fn()
};
const state = () => readAvailability("account", "workspace", tokens).kind;

beforeEach(() => {
  refresh.mockReset();
  repo.getTokens.mockReset().mockResolvedValue(tokens);
  clearAccountStates();
  setAvailabilityRuntime("runtime");
  recordRenewal("account", tokens, "unknown");
});
describe("terminal real request authentication failures", () => {
  it("does not renew credentials in response to a stale failure after a newer success", async () => {
    await observeAccountAvailability(repo as never, { ...event, sequence: 2, kind: "usable" });
    await observeAccountAvailability(repo as never, event);
    expect(refresh).not.toHaveBeenCalled();
    expect(state()).toBe("usable");
  });
  it("confirms the new credentials when same-account renewal succeeds", async () => {
    const renewed = { ...tokens, accessToken: "new" };
    refresh.mockImplementation(async () => {
      repo.getTokens.mockResolvedValue(renewed);
      recordRenewal("account", renewed, "succeeded");
      return renewed;
    });
    await observeAccountAvailability(repo as never, event);
    expect(refresh).toHaveBeenCalledOnce();
    expect(readAvailability("account", "workspace", renewed).kind).toBe("usable");
  });
  it("remains unknown if recovery cannot be determined due to network failure", async () => {
    refresh.mockRejectedValue(new Error("fetch failed"));
    await observeAccountAvailability(repo as never, event);
    expect(state()).toBe("unknown");
  });
  it("only records red after real rejection and confirmed unavailable renewal", async () => {
    refresh.mockRejectedValue(
      Object.assign(new Error("revoked"), { context: { errorCode: "refresh_token_invalidated" } })
    );
    await observeAccountAvailability(repo as never, event);
    expect(state()).toBe("auth_unavailable");
    await observeAccountAvailability(repo as never, { ...event, sequence: 2, kind: "usable" });
    expect(state()).toBe("usable");
  });
  it("cannot attach an old credential rejection to newly stored credentials", async () => {
    repo.getTokens.mockResolvedValue({ ...tokens, accessToken: "new" });
    await observeAccountAvailability(repo as never, event);
    expect(refresh).not.toHaveBeenCalled();
    expect(state()).toBe("unknown");
  });
  it("an asynchronous old failure cannot overwrite a newer success", async () => {
    let reject!: (reason: unknown) => void;
    refresh.mockImplementation(
      () =>
        new Promise((_, r) => {
          reject = r;
        })
    );
    const old = observeAccountAvailability(repo as never, event);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    await observeAccountAvailability(repo as never, { ...event, sequence: 2, kind: "usable" });
    reject(Object.assign(new Error("invalid grant"), { context: { errorCode: "invalid_grant" } }));
    await old;
    expect(state()).toBe("usable");
  });
});

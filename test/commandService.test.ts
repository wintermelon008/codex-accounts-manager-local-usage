import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { CodexAccountRecord } from "../src/core/types";
import { AccountsCommandService } from "../src/application/accounts/commandService";
import { loginWithOAuth } from "../src/auth";
import { clearAccountStates, recordRenewal } from "../src/application/accounts/accountState";
import { resolveAccountHealth } from "../src/application/accounts/health";
import { buildAccountStorageId } from "../src/utils/accountIdentity";

vi.mock("../src/auth", () => ({ loginWithOAuth: vi.fn() }));
vi.mock("../src/application/accounts/quota", async (original) => ({
  ...await original<typeof import("../src/application/accounts/quota")>(),
  refreshImportedAccountQuota: vi.fn(async () => ({}))
}));

beforeEach(() => { clearAccountStates(); vi.clearAllMocks(); });

describe("account-bound reauthorization (simulated OAuth, no network)", () => {
  const token = (email: string) => `header.${Buffer.from(JSON.stringify({ email,
    exp: Math.floor(Date.now() / 1000) + 86400,
    "https://api.openai.com/auth": { chatgpt_account_id: "workspace" }
  })).toString("base64url")}.signature`;
  const account = { id: buildAccountStorageId("target@example.invalid", "workspace"),
    accountId: "workspace", email: "target@example.invalid", isActive: false, createdAt: 1, updatedAt: 1 };
  const old = { accountId: "workspace", idToken: token(account.email), accessToken: "old-access", refreshToken: "old-refresh" };
  const automation = { enabled: false, intervalMs: 0, skewSeconds: 300, accounts: {} };
  function setup() {
    let stored = old;
    recordRenewal(account.id, old, "unavailable");
    const repo = { upsertFromTokens: vi.fn(async (tokens: typeof old) => { stored = tokens; return account; }),
      switchAccount: vi.fn() };
    const service = new AccountsCommandService({} as vscode.ExtensionContext, repo as never, { refresh: vi.fn() }, {} as never);
    Object.assign(service, { withProgress: (_title: unknown, callback: (progress: unknown, cancellation: unknown) => Promise<unknown>) => callback({}, {}) });
    return { repo, service, health: () => resolveAccountHealth(account, stored, automation) };
  }

  it("clears cyan only after the matching account is successfully saved, without switching inactive accounts", async () => {
    const { repo, service, health } = setup();
    vi.mocked(loginWithOAuth).mockResolvedValue({ ...old, accessToken: token(account.email), refreshToken: "new-refresh" });
    await service.reauthorizeAccount(account);
    expect(health().kind).toBe("healthy");
    expect(repo.upsertFromTokens).toHaveBeenCalledOnce();
    expect(repo.switchAccount).not.toHaveBeenCalled();
  });

  it("commits the freshly authorized tokens when reauthorizing the active account", async () => {
    const activeAccount = { ...account, isActive: true };
    const replacement = { ...old, accessToken: token(account.email), refreshToken: "oauth-refresh" };
    const repo = {
      upsertFromTokens: vi.fn(async () => activeAccount),
      switchAccount: vi.fn(async () => activeAccount)
    };
    const service = new AccountsCommandService(
      {} as vscode.ExtensionContext,
      repo as never,
      { refresh: vi.fn() },
      {} as never
    );
    Object.assign(service, {
      withProgress: (_title: unknown, callback: (progress: unknown, cancellation: unknown) => Promise<unknown>) =>
        callback({}, {})
    });
    vi.mocked(loginWithOAuth).mockResolvedValue(replacement);

    await service.reauthorizeAccount(activeAccount);

    expect(repo.switchAccount).toHaveBeenCalledWith(activeAccount.id, { tokens: replacement });
  });

  it("does not clear cyan or write credentials when another account signs in", async () => {
    const { repo, service, health } = setup();
    vi.mocked(loginWithOAuth).mockResolvedValue({ ...old, idToken: token("other@example.invalid"), accessToken: token("other@example.invalid") });
    await service.reauthorizeAccount(account);
    expect(health().kind).toBe("refresh_unavailable_unverified");
    expect(repo.upsertFromTokens).not.toHaveBeenCalled();
    expect(repo.switchAccount).not.toHaveBeenCalled();
  });

  it.each(["OAuth login cancelled by user.", "Network timeout"])("preserves cyan on %s", async (message) => {
    const { repo, service, health } = setup();
    vi.mocked(loginWithOAuth).mockRejectedValue(new Error(message));
    await expect(service.reauthorizeAccount(account)).rejects.toThrow(message);
    expect(health().kind).toBe("refresh_unavailable_unverified");
    expect(repo.upsertFromTokens).not.toHaveBeenCalled();
    expect(repo.switchAccount).not.toHaveBeenCalled();
  });
});

describe("AccountsCommandService account switching", () => {
  it("routes a manual OAuth selection through the atomic Gateway handoff", async () => {
    const gatewayAccount = {
      id: "virtual:gateway",
      email: "gateway@example.invalid",
      accountKind: "sub2api",
      providerActive: true,
      isActive: false,
      createdAt: 1,
      updatedAt: 1
    } as CodexAccountRecord;
    const targetAccount = {
      id: "oauth-target",
      email: "target@example.invalid",
      accountId: "acct-target",
      providerActive: false,
      isActive: false,
      createdAt: 1,
      updatedAt: 1
    } as CodexAccountRecord;
    const repo = {
      listAccounts: vi.fn(async () => [gatewayAccount, targetAccount]),
      switchAccount: vi.fn()
    };
    const switchRuntimeAccount = vi.fn(async () => ({
      status: "switched" as const,
      accountId: targetAccount.id,
      email: targetAccount.email,
      activeTurns: 0,
      interruptedTurns: 0,
      continuedThreads: 0
    }));
    const view = {
      refresh: vi.fn(),
      markObservedAuthIdentity: vi.fn(),
      switchRuntimeAccount
    };
    const hotSwitchRuntime = {
      isGatewayActive: vi.fn(() => true),
      deactivateGateway: vi.fn()
    };
    const service = new AccountsCommandService(
      {} as vscode.ExtensionContext,
      repo as never,
      view,
      hotSwitchRuntime as never
    );

    (service as unknown as {
      withProgress: (
        title: string,
        callback: (progress: unknown, token: unknown) => Promise<unknown>
      ) => Promise<unknown>;
    }).withProgress = (_title, callback) => callback({}, {});

    await service.switchAccount(targetAccount);

    expect(hotSwitchRuntime.deactivateGateway).not.toHaveBeenCalled();
    expect(switchRuntimeAccount).toHaveBeenCalledWith(
      targetAccount.id,
      { allowManualWhenSeamlessDisabled: true },
      "manual"
    );
    expect(repo.switchAccount).not.toHaveBeenCalled();
    expect(view.refresh).toHaveBeenCalledOnce();
  });
});

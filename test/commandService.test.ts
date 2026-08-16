import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { CodexAccountRecord } from "../src/core/types";
import { AccountsCommandService } from "../src/application/accounts/commandService";

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

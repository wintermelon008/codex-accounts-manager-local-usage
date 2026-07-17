import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchRefreshCoordinator } from "../src/presentation/workbench/refreshCoordinator";
import { setCurrentWindowRuntimeAccountId } from "../src/presentation/workbench/windowRuntimeAccount";

type TestableCoordinator = {
  lastObservedAuthIdentity?: string;
  readObservedAuthIdentity: () => Promise<string | undefined>;
  syncActiveAccountFromExternalChange: (
    view: { refresh: () => void; switchRuntimeAccount: (accountId: string) => Promise<unknown> },
    markVisible: () => void,
    markHidden: () => void,
    isVisible: () => boolean
  ) => Promise<boolean>;
};

describe("WorkbenchRefreshCoordinator external auth convergence", () => {
  afterEach(() => {
    vi.clearAllMocks();
    setCurrentWindowRuntimeAccountId(undefined);
  });

  it("retries the same observed identity when its runtime switch was deferred", async () => {
    const account = {
      id: "account-b",
      email: "b@example.invalid",
      isActive: true,
      createdAt: 1,
      updatedAt: 1
    };
    const repo = {
      syncActiveAccountFromAuthFile: vi.fn().mockResolvedValue(undefined),
      listAccounts: vi.fn().mockResolvedValue([account])
    };
    const coordinator = new WorkbenchRefreshCoordinator(
      { subscriptions: [] } as never,
      repo as never,
      { refresh: vi.fn() } as never
    ) as unknown as TestableCoordinator;
    coordinator.lastObservedAuthIdentity = account.id;
    coordinator.readObservedAuthIdentity = vi.fn().mockResolvedValue(account.id);
    setCurrentWindowRuntimeAccountId("account-a");

    const switchRuntimeAccount = vi.fn().mockResolvedValue({
      status: "deferred",
      reason: "activeOrdinaryTurns",
      activeTurns: 1
    });
    const shouldRetry = await coordinator.syncActiveAccountFromExternalChange(
      { refresh: vi.fn(), switchRuntimeAccount },
      vi.fn(),
      vi.fn(),
      () => false
    );

    expect(switchRuntimeAccount).toHaveBeenCalledWith(account.id);
    expect(shouldRetry).toBe(true);
  });

  it("schedules another convergence attempt after a deferred result", async () => {
    vi.useFakeTimers();
    let onDidChange: (() => void) | undefined;
    const watcher = {
      onDidChange: vi.fn((callback: () => void) => {
        onDidChange = callback;
      }),
      onDidCreate: vi.fn(),
      onDidDelete: vi.fn(),
      dispose: vi.fn()
    };
    vi.mocked(vscode.workspace.createFileSystemWatcher).mockReturnValue(watcher as never);

    const context = { subscriptions: [] };
    const coordinator = new WorkbenchRefreshCoordinator(context as never, {} as never, { refresh: vi.fn() } as never);
    const testableCoordinator = coordinator as unknown as TestableCoordinator;
    const sync = vi
      .spyOn(testableCoordinator, "syncActiveAccountFromExternalChange")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const disposable = coordinator.registerAuthFileWatcher({ refresh: vi.fn(), markObservedAuthIdentity: vi.fn() });

    try {
      onDidChange?.();
      await vi.advanceTimersByTimeAsync(300);
      expect(sync).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(sync).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sync).toHaveBeenCalledTimes(2);
    } finally {
      disposable.dispose();
      vi.useRealTimers();
    }
    expect(watcher.dispose).toHaveBeenCalledOnce();
  });
});

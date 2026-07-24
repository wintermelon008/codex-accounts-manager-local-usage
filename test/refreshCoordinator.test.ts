import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_STATE_POLL_INTERVAL_MS,
  WorkbenchRefreshCoordinator
} from "../src/presentation/workbench/refreshCoordinator";
import type { HotSwitchStatus } from "../src/codex";
import {
  getAutomaticQuotaRefreshAccountIds,
  registerAutoRefreshScheduler,
  registerSeamlessUsageLimitMonitor,
  SEAMLESS_USAGE_LIMIT_POLL_INTERVAL_MS,
  SEAMLESS_USAGE_LIMIT_RETRY_MS
} from "../src/presentation/workbench/schedulerRegistration";
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
    vi.useRealTimers();
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
      syncFromAideckMirror: vi.fn().mockResolvedValue([]),
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
    const repo = {
      getExternalStateRevision: vi.fn().mockResolvedValue("revision-a"),
      invalidateExternalStateCaches: vi.fn()
    };
    const coordinator = new WorkbenchRefreshCoordinator(context as never, repo as never, { refresh: vi.fn() } as never);
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

  it("polls shared storage so external changes converge without file watcher events", async () => {
    vi.useFakeTimers();
    const watcher = {
      onDidChange: vi.fn(),
      onDidCreate: vi.fn(),
      onDidDelete: vi.fn(),
      dispose: vi.fn()
    };
    vi.mocked(vscode.workspace.createFileSystemWatcher).mockReturnValue(watcher as never);
    const repo = {
      getExternalStateRevision: vi.fn().mockResolvedValueOnce("revision-a").mockResolvedValueOnce("revision-b"),
      invalidateExternalStateCaches: vi.fn()
    };
    const coordinator = new WorkbenchRefreshCoordinator(
      { subscriptions: [] } as never,
      repo as never,
      { refresh: vi.fn() } as never
    );
    const testableCoordinator = coordinator as unknown as TestableCoordinator;
    const sync = vi.spyOn(testableCoordinator, "syncActiveAccountFromExternalChange").mockResolvedValue(false);
    const disposable = coordinator.registerAuthFileWatcher({ refresh: vi.fn(), markObservedAuthIdentity: vi.fn() });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(repo.getExternalStateRevision).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(EXTERNAL_STATE_POLL_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(1);

      expect(repo.invalidateExternalStateCaches).toHaveBeenCalledOnce();
      expect(sync).toHaveBeenCalledOnce();
      expect(watcher.onDidChange).toHaveBeenCalledOnce();
    } finally {
      disposable.dispose();
      vi.useRealTimers();
    }
  });

  it("runs scheduled quota refresh only while holding the shared host lease", async () => {
    vi.useFakeTimers();
    const configurationDisposable = { dispose: vi.fn() };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, defaultValue?: unknown) => (key === "autoRefreshMinutes" ? 1 : defaultValue),
      update: vi.fn(),
      inspect: vi.fn()
    } as never);
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReturnValue(configurationDisposable as never);
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const repo = {
      listAccounts: vi
        .fn()
        .mockResolvedValue([{ id: "a", email: "a@example.invalid", isActive: true, createdAt: 1, updatedAt: 1 }]),
      tryAcquireSchedulerLease: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ release })
    };
    const registration = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo: repo as never,
      onRefresh: vi.fn()
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith("codexAccounts.refreshAllQuotas", {
        silent: true,
        forceRefresh: true,
        accountIds: ["a"]
      });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      registration.dispose();
      vi.useRealTimers();
    }
  });

  it("limits automatic quota refresh to the first visible Dashboard page", () => {
    const accounts = [
      { id: "active", email: "active@example.invalid", isActive: true, createdAt: 1, updatedAt: 1 },
      { id: "hidden", email: "hidden@example.invalid", isActive: false, isHidden: true, createdAt: 200, updatedAt: 1 },
      {
        id: "group-a",
        email: "group-a@example.invalid",
        isActive: false,
        accountGroup: "A" as const,
        createdAt: 199,
        updatedAt: 1
      },
      ...Array.from({ length: 51 }, (_, index) => ({
        id: `visible-${index + 1}`,
        email: `visible-${index + 1}@example.invalid`,
        isActive: false,
        createdAt: index + 2,
        updatedAt: 1
      }))
    ];

    const accountIds = getAutomaticQuotaRefreshAccountIds(
      accounts,
      configuration({
        seamlessSwitchGroupAVisible: false,
        seamlessSwitchGroupBVisible: true,
        seamlessSwitchGroupCVisible: true
      })
    );

    expect(accountIds).toHaveLength(50);
    expect(accountIds[0]).toBe("active");
    expect(accountIds).not.toContain("hidden");
    expect(accountIds).not.toContain("group-a");
    expect(accountIds).toContain("visible-51");
    expect(accountIds).not.toContain("visible-1");
  });

  it("reacts to a new runtime usage-limit failure with only bounded scalar polling", async () => {
    vi.useFakeTimers();
    const configurationDisposable = { dispose: vi.fn() };
    const values: Record<string, unknown> = {
      hotSwitchEnabled: true,
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchThreshold: 1
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(configuration(values));
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReturnValue(configurationDisposable as never);
    const runtime = {
      isEnabled: vi.fn(() => true),
      getStatus: vi
        .fn()
        .mockResolvedValueOnce(runtimeStatus())
        .mockResolvedValue(runtimeStatus({ observedUsageLimitFailures: 1, recentUsageLimitedThreads: 1 })),
      getIdentity: vi.fn().mockResolvedValue({ managedLocalAccountId: "free-active" })
    };
    const onUsageLimitExceeded = vi.fn().mockResolvedValue(true);
    const registration = registerSeamlessUsageLimitMonitor({
      context: { subscriptions: [] } as never,
      runtime: runtime as never,
      onUsageLimitExceeded
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(onUsageLimitExceeded).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SEAMLESS_USAGE_LIMIT_POLL_INTERVAL_MS);
      expect(onUsageLimitExceeded).toHaveBeenCalledWith("free-active", "runtimeUsageLimit");

      await vi.advanceTimersByTimeAsync(SEAMLESS_USAGE_LIMIT_POLL_INTERVAL_MS * 5);
      expect(onUsageLimitExceeded).toHaveBeenCalledOnce();
      expect(runtime.getStatus.mock.calls.length).toBeLessThanOrEqual(7);
    } finally {
      registration.dispose();
      vi.useRealTimers();
    }
  });

  it("backs off a deferred usage-limit selection instead of retrying every poll", async () => {
    vi.useFakeTimers();
    const configurationDisposable = { dispose: vi.fn() };
    const values: Record<string, unknown> = {
      hotSwitchEnabled: true,
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchThreshold: 1
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(configuration(values));
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReturnValue(configurationDisposable as never);
    const runtime = {
      isEnabled: vi.fn(() => true),
      getStatus: vi
        .fn()
        .mockResolvedValueOnce(runtimeStatus())
        .mockResolvedValue(runtimeStatus({ observedUsageLimitFailures: 1, recentUsageLimitedThreads: 1 })),
      getIdentity: vi.fn().mockResolvedValue({ managedLocalAccountId: "free-active" })
    };
    const onUsageLimitExceeded = vi.fn().mockResolvedValue(false);
    const registration = registerSeamlessUsageLimitMonitor({
      context: { subscriptions: [] } as never,
      runtime: runtime as never,
      onUsageLimitExceeded
    });

    try {
      await vi.advanceTimersByTimeAsync(SEAMLESS_USAGE_LIMIT_POLL_INTERVAL_MS);
      expect(onUsageLimitExceeded).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(SEAMLESS_USAGE_LIMIT_RETRY_MS - 1);
      expect(onUsageLimitExceeded).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(onUsageLimitExceeded).toHaveBeenCalledTimes(2);
    } finally {
      registration.dispose();
      vi.useRealTimers();
    }
  });

  it("does not poll runtime usage limits when low-quota switching is off", async () => {
    vi.useFakeTimers();
    const configurationDisposable = { dispose: vi.fn() };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      configuration({
        hotSwitchEnabled: true,
        seamlessSwitchEnabled: true,
        seamlessSwitchQuotaBandsEnabled: true,
        seamlessSwitchLowQuotaEnabled: false,
        seamlessSwitchThreshold: 1
      })
    );
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReturnValue(configurationDisposable as never);
    const runtime = {
      isEnabled: vi.fn(() => true),
      getStatus: vi.fn().mockResolvedValue(runtimeStatus()),
      getIdentity: vi.fn(),
      configureUsageLimitObservation: vi.fn().mockResolvedValue({ enabled: false })
    };
    const onUsageLimitExceeded = vi.fn().mockResolvedValue(true);
    const registration = registerSeamlessUsageLimitMonitor({
      context: { subscriptions: [] } as never,
      runtime: runtime as never,
      onUsageLimitExceeded
    });

    try {
      await vi.advanceTimersByTimeAsync(SEAMLESS_USAGE_LIMIT_POLL_INTERVAL_MS * 2);
      expect(runtime.configureUsageLimitObservation).toHaveBeenCalledWith(false);
      expect(runtime.getStatus).not.toHaveBeenCalled();
      expect(onUsageLimitExceeded).not.toHaveBeenCalled();
    } finally {
      registration.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps polling in after-exhaustion mode but ignores a single stopped conversation", async () => {
    vi.useFakeTimers();
    const configurationDisposable = { dispose: vi.fn() };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      configuration({
        hotSwitchEnabled: true,
        seamlessSwitchEnabled: true,
        seamlessSwitchQuotaBandsEnabled: true,
        seamlessSwitchThreshold: 0
      })
    );
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReturnValue(configurationDisposable as never);
    const runtime = {
      isEnabled: vi.fn(() => true),
      getStatus: vi
        .fn()
        .mockResolvedValueOnce(runtimeStatus())
        .mockResolvedValue(runtimeStatus({ observedUsageLimitFailures: 1, recentUsageLimitedThreads: 1 })),
      getIdentity: vi.fn().mockResolvedValue({ managedLocalAccountId: "free-active" })
    };
    const onUsageLimitExceeded = vi.fn().mockResolvedValue(false);
    const registration = registerSeamlessUsageLimitMonitor({
      context: { subscriptions: [] } as never,
      runtime: runtime as never,
      onUsageLimitExceeded
    });

    try {
      await vi.advanceTimersByTimeAsync(SEAMLESS_USAGE_LIMIT_POLL_INTERVAL_MS * 3);
      expect(runtime.getStatus).toHaveBeenCalled();
      expect(onUsageLimitExceeded).not.toHaveBeenCalled();
    } finally {
      registration.dispose();
      vi.useRealTimers();
    }
  });

  it("uses the all-conversations exhaustion signal when the threshold is after exhaustion", async () => {
    vi.useFakeTimers();
    const configurationDisposable = { dispose: vi.fn() };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      configuration({
        hotSwitchEnabled: true,
        seamlessSwitchEnabled: true,
        seamlessSwitchQuotaBandsEnabled: true,
        seamlessSwitchThreshold: 0
      })
    );
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReturnValue(configurationDisposable as never);
    const runtime = {
      isEnabled: vi.fn(() => true),
      getStatus: vi
        .fn()
        .mockResolvedValueOnce(runtimeStatus())
        .mockResolvedValue(
          runtimeStatus({
            observedUsageLimitFailures: 2,
            recentUsageLimitedThreads: 2,
            usageLimitExhaustionReady: true,
            usageLimitExhaustionBatchId: 1
          })
        ),
      getIdentity: vi.fn().mockResolvedValue({ managedLocalAccountId: "free-active" })
    };
    const onUsageLimitExceeded = vi.fn().mockResolvedValue(true);
    const registration = registerSeamlessUsageLimitMonitor({
      context: { subscriptions: [] } as never,
      runtime: runtime as never,
      onUsageLimitExceeded
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(onUsageLimitExceeded).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SEAMLESS_USAGE_LIMIT_POLL_INTERVAL_MS);
      expect(onUsageLimitExceeded).toHaveBeenCalledWith("free-active", "runtimeUsageLimitExhaustion");
    } finally {
      registration.dispose();
      vi.useRealTimers();
    }
  });
});

function configuration(values: Record<string, unknown>): vscode.WorkspaceConfiguration {
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
    update: vi.fn(),
    inspect: (key: string) => ({
      key: `codexAccounts.${key}`,
      defaultValue: false,
      globalValue: values[key]
    })
  } as never;
}

function runtimeStatus(overrides: Partial<HotSwitchStatus> = {}): HotSwitchStatus {
  return {
    runtimeProtocolVersion: 1,
    ready: true,
    initializeResponseReceived: true,
    initializedNotificationReceived: true,
    activeTurns: 0,
    pendingSwitch: false,
    switching: false,
    httpTransportForced: false,
    transportMode: "http",
    usageLimitObservationEnabled: true,
    recentUsageLimitedThreads: 0,
    usageLimitExhaustionReady: false,
    usageLimitExhaustionBatchId: 0,
    observedUsageLimitFailures: 0,
    recoveredUsageLimitedThreads: 0,
    resumedUsageLimitedGoals: 0,
    shimPid: 123,
    appServerPid: 456,
    ...overrides
  };
}

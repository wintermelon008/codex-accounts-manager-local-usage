import { describe, expect, it, vi } from "vitest";
import { HotSwitchOperationUncertainError } from "../src/codex/hotSwitchBridge";
import { RuntimeSwitchCoordinator } from "../src/application/accounts/runtimeSwitchCoordinator";

describe("RuntimeSwitchCoordinator", () => {
  it("serializes an ordinary runtime switch behind a renewable shared lease", async () => {
    const lease = { renew: vi.fn(async () => true), release: vi.fn(async () => undefined) };
    const runtime = createRuntime();
    const repo = { tryAcquireSchedulerLease: vi.fn(async () => lease) };
    const coordinator = new RuntimeSwitchCoordinator(repo as never, runtime as never, () => true);

    await expect(coordinator.switchAccount("account-b", { gracePeriodMs: 0 }, "automatic")).resolves.toMatchObject({
      status: "switched",
      accountId: "account-b"
    });

    expect(repo.tryAcquireSchedulerLease).toHaveBeenCalledWith("runtime-switch", 60_000);
    expect(runtime.switchAccount).toHaveBeenCalledWith(
      "account-b",
      expect.objectContaining({ gracePeriodMs: 0, operationId: expect.any(String) })
    );
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it("suppresses automatic OAuth work while the Gateway route owns the runtime", async () => {
    const runtime = createRuntime({ gatewayActive: true });
    const repo = { tryAcquireSchedulerLease: vi.fn() };
    const coordinator = new RuntimeSwitchCoordinator(repo as never, runtime as never, () => true);

    await expect(coordinator.switchAccount("account-b", undefined, "automatic")).resolves.toEqual({
      status: "suppressed",
      reason: "gatewayActive"
    });
    expect(repo.tryAcquireSchedulerLease).not.toHaveBeenCalled();
    expect(runtime.switchAccount).not.toHaveBeenCalled();
  });

  it("preserves the explicit manual error while the Gateway route is active", async () => {
    const runtime = createRuntime({ gatewayActive: true });
    const repo = { tryAcquireSchedulerLease: vi.fn() };
    const coordinator = new RuntimeSwitchCoordinator(repo as never, runtime as never, () => true);

    await expect(coordinator.switchAccount("account-b", undefined, "manual")).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("Switch back from the active Gateway")
    });
  });

  it("allows the one-way Gateway fallback through the same shared transaction boundary", async () => {
    const lease = { renew: vi.fn(async () => true), release: vi.fn(async () => undefined) };
    const runtime = createRuntime({ gatewayActive: true });
    const repo = { tryAcquireSchedulerLease: vi.fn(async () => lease) };
    const coordinator = new RuntimeSwitchCoordinator(repo as never, runtime as never, () => false);

    await expect(coordinator.fallbackGatewayToChatGpt("account-b")).resolves.toMatchObject({
      status: "switched",
      accountId: "account-b"
    });
    expect(runtime.fallbackGatewayToChatGpt).toHaveBeenCalledWith(
      "account-b",
      expect.objectContaining({ operationId: expect.any(String) })
    );
    expect(runtime.switchAccount).not.toHaveBeenCalled();
  });

  it("runs a manual provider handoff behind the same renewable lease", async () => {
    const lease = { renew: vi.fn(async () => true), release: vi.fn(async () => undefined) };
    const runtime = createRuntime({ gatewayActive: false });
    const repo = { tryAcquireSchedulerLease: vi.fn(async () => lease) };
    const coordinator = new RuntimeSwitchCoordinator(repo as never, runtime as never, () => false);
    const execute = vi.fn(async (options: { operationId?: string }) => switched("virtual:sub2api-gateway"));

    await expect(coordinator.runProviderSwitch(undefined, execute)).resolves.toMatchObject({
      status: "switched",
      accountId: "virtual:sub2api-gateway"
    });
    expect(execute).toHaveBeenCalledWith({ operationId: expect.any(String) });
    expect(repo.tryAcquireSchedulerLease).toHaveBeenCalledWith("runtime-switch", 60_000);
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it("permits the manual OAuth handoff immediately after Gateway deactivation", async () => {
    const lease = { renew: vi.fn(async () => true), release: vi.fn(async () => undefined) };
    const runtime = createRuntime({ gatewayActive: false });
    const repo = { tryAcquireSchedulerLease: vi.fn(async () => lease) };
    const coordinator = new RuntimeSwitchCoordinator(repo as never, runtime as never, () => false);

    await expect(
      coordinator.switchAccount("account-b", { allowManualWhenSeamlessDisabled: true }, "manual")
    ).resolves.toMatchObject({ status: "switched", accountId: "account-b" });
    expect(runtime.switchAccount).toHaveBeenCalledWith(
      "account-b",
      expect.objectContaining({ allowManualWhenSeamlessDisabled: true, operationId: expect.any(String) })
    );
  });

  it("does not start a second local transaction while one is still active", async () => {
    const lease = { renew: vi.fn(async () => true), release: vi.fn(async () => undefined) };
    let complete: ((value: ReturnType<typeof switched>) => void) | undefined;
    const runtime = createRuntime({
      switchAccount: vi.fn(
        () =>
          new Promise<ReturnType<typeof switched>>((resolve) => {
            complete = resolve;
          })
      )
    });
    const repo = { tryAcquireSchedulerLease: vi.fn(async () => lease) };
    const coordinator = new RuntimeSwitchCoordinator(repo as never, runtime as never, () => true);

    const first = coordinator.switchAccount("account-b", undefined, "automatic");
    await vi.waitFor(() => expect(runtime.switchAccount).toHaveBeenCalledOnce());
    await expect(coordinator.switchAccount("account-c", undefined, "automatic")).resolves.toEqual({
      status: "suppressed",
      reason: "operationInProgress"
    });

    complete?.(switched("account-b"));
    await expect(first).resolves.toMatchObject({ status: "switched", accountId: "account-b" });
  });

  it("holds the shared transaction until a disconnected runtime operation is reconciled", async () => {
    const lease = { renew: vi.fn(async () => true), release: vi.fn(async () => undefined) };
    const operationStatus = vi.fn(async (operationId: string) => ({
      operationId,
      state: "succeeded" as const,
      result: switched("account-b")
    }));
    const runtime = createRuntime({
      operationStatus,
      switchAccount: vi.fn(async (_accountId: string, options?: { operationId?: string }) => {
        throw new HotSwitchOperationUncertainError(
          "runtime/switch",
          "the control request timed out",
          options?.operationId
        );
      })
    });
    const repo = { tryAcquireSchedulerLease: vi.fn(async () => lease) };
    const coordinator = new RuntimeSwitchCoordinator(repo as never, runtime as never, () => true);

    await expect(coordinator.switchAccount("account-b", undefined, "automatic")).resolves.toMatchObject({
      status: "switched",
      accountId: "account-b"
    });
    expect(operationStatus).toHaveBeenCalledWith(expect.any(String));
    expect(lease.release).toHaveBeenCalledOnce();
  });
});

function createRuntime(
  options: {
    gatewayActive?: boolean;
    switchAccount?: ReturnType<typeof vi.fn>;
    operationStatus?: ReturnType<typeof vi.fn>;
  } = {}
) {
  return {
    isEnabled: vi.fn(() => true),
    isGatewayActive: vi.fn(() => options.gatewayActive ?? false),
    switchAccount: options.switchAccount ?? vi.fn(async (accountId: string) => switched(accountId)),
    fallbackGatewayToChatGpt: vi.fn(async (accountId: string) => switched(accountId)),
    getOperationStatus: options.operationStatus ?? vi.fn()
  };
}

function switched(accountId: string) {
  return {
    status: "switched" as const,
    accountId,
    email: `${accountId}@example.invalid`,
    activeTurns: 0,
    interruptedTurns: 0,
    continuedThreads: 0
  };
}

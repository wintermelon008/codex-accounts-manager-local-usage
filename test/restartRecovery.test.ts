import { describe, expect, it, vi } from "vitest";
import {
  LAST_RESTART_RECOVERY_KEY,
  PENDING_RESTART_RECOVERY_KEY,
  RESTART_RECOVERY_MAX_AGE_MS,
  formatRestartRecoveryReport,
  markRestartRecoveryRequested,
  readPendingRestartRecovery,
  runRestartRecoveryCheck,
  saveRestartRecoveryReport
} from "../src/presentation/workbench/restartRecovery";

function createContext() {
  const state = new Map<string, unknown>();
  const context = {
    globalState: {
      get: vi.fn((key: string) => state.get(key)),
      update: vi.fn(async (key: string, value: unknown) => {
        if (value === undefined) {
          state.delete(key);
        } else {
          state.set(key, value);
        }
      })
    }
  };
  return { context, state };
}

describe("restart recovery", () => {
  it("persists a pending marker and removes an expired marker", async () => {
    const { context, state } = createContext();

    await markRestartRecoveryRequested(context as never, 1_000);
    await expect(readPendingRestartRecovery(context as never, 1_000)).resolves.toEqual({
      version: 1,
      requestedAt: 1_000
    });

    await expect(
      readPendingRestartRecovery(context as never, 1_000 + RESTART_RECOVERY_MAX_AGE_MS + 1)
    ).resolves.toBeUndefined();
    expect(state.has(PENDING_RESTART_RECOVERY_KEY)).toBe(false);
  });

  it("clears the marker only after saving the post-restart report", async () => {
    const { context, state } = createContext();
    await markRestartRecoveryRequested(context as never, 1_000);
    const report = await runRestartRecoveryCheck(1_000, {
      readIndexHealth: async () => ({ status: "healthy" }),
      managerControlEnabled: false,
      managerControlReady: () => false,
      runtimeEnabled: false,
      readRuntimeStatus: async () => ({ ready: false }),
      now: () => 1_100,
      retryDelaysMs: [0]
    });

    await saveRestartRecoveryReport(context as never, report);

    expect(state.has(PENDING_RESTART_RECOVERY_KEY)).toBe(false);
    expect(state.get(LAST_RESTART_RECOVERY_KEY)).toEqual(report);
  });

  it("tolerates startup races and reports a degraded restore", async () => {
    let managerAttempts = 0;
    let runtimeAttempts = 0;
    const sleep = vi.fn(async () => undefined);

    const report = await runRestartRecoveryCheck(1_000, {
      readIndexHealth: async () => ({ status: "restored_from_backup" }),
      managerControlEnabled: true,
      managerControlReady: () => {
        managerAttempts += 1;
        return managerAttempts >= 2;
      },
      runtimeEnabled: true,
      readRuntimeStatus: async () => {
        runtimeAttempts += 1;
        if (runtimeAttempts === 1) {
          throw new Error("runtime socket is still starting");
        }
        return { ready: runtimeAttempts >= 3 };
      },
      sleep,
      retryDelaysMs: [0, 0, 0]
    });

    expect(report.status).toBe("degraded");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "accountsIndex", status: "warning" }),
        expect.objectContaining({ name: "managerControl", status: "passed", attempts: 2 }),
        expect.objectContaining({ name: "codexRuntime", status: "passed", attempts: 3 })
      ])
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails when the runtime never becomes ready while allowing disabled APIs to be skipped", async () => {
    const report = await runRestartRecoveryCheck(1_000, {
      readIndexHealth: async () => ({ status: "corrupted_unrecoverable" }),
      managerControlEnabled: false,
      managerControlReady: () => false,
      runtimeEnabled: true,
      readRuntimeStatus: async () => ({ ready: false }),
      retryDelaysMs: [0, 0]
    });

    expect(report.status).toBe("failed");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "accountsIndex", status: "failed" }),
        expect.objectContaining({ name: "managerControl", status: "skipped" }),
        expect.objectContaining({ name: "codexRuntime", status: "failed", attempts: 2 })
      ])
    );
  });

  it("bounds a hung runtime probe instead of blocking activation indefinitely", async () => {
    const report = await runRestartRecoveryCheck(1_000, {
      readIndexHealth: async () => ({ status: "healthy" }),
      managerControlEnabled: false,
      managerControlReady: () => false,
      runtimeEnabled: true,
      readRuntimeStatus: () => new Promise<{ ready: boolean }>(() => undefined),
      retryDelaysMs: [0],
      probeTimeoutMs: 5
    });

    expect(report.status).toBe("failed");
    expect(report.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "codexRuntime", status: "failed", attempts: 1 })])
    );
  });

  it("formats a short localized recovery result", () => {
    const report = {
      status: "passed" as const,
      requestedAt: 1_000,
      checkedAt: 1_100,
      durationMs: 100,
      checks: [
        { name: "accountsIndex" as const, status: "passed" as const, detail: "healthy" },
        { name: "managerControl" as const, status: "skipped" as const, detail: "disabled" }
      ]
    };

    expect(formatRestartRecoveryReport(report, "zh")).toContain("Manager 重启完成");
    expect(formatRestartRecoveryReport(report, "en")).toContain("Manager restart completed");
  });
});

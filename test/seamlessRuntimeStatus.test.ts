import { describe, expect, it } from "vitest";
import type { HotSwitchStatus } from "../src/codex/hotSwitchBridge";
import { HOT_SWITCH_RUNTIME_PROTOCOL_VERSION } from "../src/codex/hotSwitchRuntime";
import { readDashboardSeamlessRuntime } from "../src/presentation/dashboard/seamlessRuntimeStatus";

const baseStatus: HotSwitchStatus = {
  runtimeProtocolVersion: HOT_SWITCH_RUNTIME_PROTOCOL_VERSION,
  ready: true,
  initializeResponseReceived: true,
  initializedNotificationReceived: true,
  activeTurns: 0,
  pendingSwitch: false,
  switching: false,
  forceFastMode: false,
  httpTransportForced: true,
  transportMode: "http",
  providerKind: "chatgpt",
  gatewayActive: false,
  gatewayConfigured: false,
  gatewayAutoFallbackEnabled: false,
  usageLimitObservationEnabled: false,
  capacityRecoveryThreads: 0,
  capacityRecoveryWaitingThreads: 0,
  recentUsageLimitedThreads: 0,
  usageLimitExhaustionReady: false,
  usageLimitExhaustionBatchId: 0,
  observedUsageLimitFailures: 0,
  recoveredUsageLimitedThreads: 0,
  resumedUsageLimitedGoals: 0,
  attributionActive: true,
  attributionFailureReason: null,
  runtimeOwner: "owner",
  shimPid: 100,
  appServerPid: 200
};

function runtime(overrides: {
  enabled?: boolean;
  setup?: Partial<ReturnType<typeof setup>>;
  status?: Partial<HotSwitchStatus>;
  error?: string;
}) {
  const setupResult = setup(overrides.setup);
  return {
    isEnabled: () => overrides.enabled ?? true,
    getSetupStatus: () => setupResult,
    getStatus: overrides.error
      ? async () => {
          throw new Error(overrides.error);
        }
      : async () => ({ ...baseStatus, ...overrides.status })
  };
}

function setup(
  overrides: Partial<{ enabled: boolean; configured: boolean; requiresReload: boolean; error?: string }> = {}
) {
  return {
    enabled: true,
    configured: true,
    requiresReload: false,
    ...overrides
  };
}

describe("readDashboardSeamlessRuntime", () => {
  it("reports a disabled runtime without probing the app-server", async () => {
    const status = await readDashboardSeamlessRuntime(runtime({ enabled: false }), 1000);

    expect(status).toMatchObject({ state: "disabled", checkedAt: 1000 });
  });

  it("reports when the runtime needs one reload", async () => {
    const status = await readDashboardSeamlessRuntime(
      runtime({ setup: { configured: false, requiresReload: true } }),
      1000
    );

    expect(status).toMatchObject({ state: "needs_reload" });
  });

  it("maps a ready runtime and keeps only bounded status fields", async () => {
    const status = await readDashboardSeamlessRuntime(
      runtime({ status: { activeTurns: 2, pendingSwitch: true, switching: true } }),
      1000
    );

    expect(status).toMatchObject({
      state: "ready",
      runtimeProtocolVersion: HOT_SWITCH_RUNTIME_PROTOCOL_VERSION,
      activeTurns: 2,
      pendingSwitch: true,
      switching: true,
      attributionActive: true
    });
    expect(status).not.toHaveProperty("shimPid");
  });

  it("marks missing usage attribution as degraded and preserves a short reason", async () => {
    const status = await readDashboardSeamlessRuntime(
      runtime({
        status: {
          attributionActive: false,
          attributionFailureReason: "refresh token=super-secret failed"
        }
      }),
      1000
    );

    expect(status).toMatchObject({ state: "degraded", attributionActive: false });
    expect(status.attributionFailureReason).toBe("refresh token=[redacted] failed");
  });

  it("does not expose credential text when a status probe fails", async () => {
    const status = await readDashboardSeamlessRuntime(
      runtime({ error: "token=super-secret authentication rejected" }),
      1000
    );

    expect(status.state).toBe("unavailable");
    expect(status.failureReason).toBe("token=[redacted] authentication rejected");
  });
});

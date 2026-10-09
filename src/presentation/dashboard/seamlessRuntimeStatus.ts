import type { DashboardSeamlessRuntimeViewModel } from "../../domain/dashboard/types";
import type { HotSwitchStatus } from "../../codex/hotSwitchBridge";
import { HOT_SWITCH_RUNTIME_PROTOCOL_VERSION, type HotSwitchSetupResult } from "../../codex/hotSwitchRuntime";

const STATUS_TIMEOUT_MS = 2_500;

export type HotSwitchRuntimeStatusSource = {
  isEnabled(): boolean;
  getSetupStatus(): HotSwitchSetupResult;
  getStatus(): Promise<HotSwitchStatus>;
};

export async function readDashboardSeamlessRuntime(
  runtime: HotSwitchRuntimeStatusSource,
  checkedAt = Date.now()
): Promise<DashboardSeamlessRuntimeViewModel> {
  const setup = runtime.getSetupStatus();
  const base = createBaseStatus(checkedAt);

  if (!runtime.isEnabled() || !setup.enabled) {
    return { ...base, state: "disabled" };
  }

  if (setup.requiresReload) {
    return {
      ...base,
      state: "needs_reload",
      failureReason: sanitizeRuntimeReason(setup.error) ?? "The runtime changed and needs one window reload."
    };
  }

  if (!setup.configured) {
    return {
      ...base,
      state: setup.error ? "unavailable" : "starting",
      failureReason: sanitizeRuntimeReason(setup.error)
    };
  }

  try {
    const status = await withTimeout(runtime.getStatus(), STATUS_TIMEOUT_MS);
    return mapRuntimeStatus(status, checkedAt);
  } catch (error) {
    const reason = sanitizeRuntimeReason(error instanceof Error ? error.message : String(error));
    return {
      ...base,
      state: isTransientRuntimeStatusError(reason) ? "starting" : "unavailable",
      failureReason: reason
    };
  }
}

function mapRuntimeStatus(status: HotSwitchStatus, checkedAt: number): DashboardSeamlessRuntimeViewModel {
  const attributionExpected = status.providerKind !== "gateway" && !status.gatewayActive;
  const attributionActive = status.attributionActive || !attributionExpected;
  const state = !status.ready ? "starting" : attributionActive ? "ready" : "degraded";
  return {
    state,
    checkedAt,
    runtimeProtocolVersion: status.runtimeProtocolVersion,
    expectedRuntimeProtocolVersion: HOT_SWITCH_RUNTIME_PROTOCOL_VERSION,
    runtimeOwner: status.runtimeOwner,
    providerKind: status.providerKind,
    ...(status.appServerPid == null ? {} : { appServerPid: status.appServerPid }),
    activeTurns: status.activeTurns,
    pendingSwitch: status.pendingSwitch,
    switching: status.switching,
    attributionActive,
    ...(status.attributionFailureReason
      ? { attributionFailureReason: sanitizeRuntimeReason(status.attributionFailureReason) }
      : {})
  };
}

function createBaseStatus(checkedAt: number): DashboardSeamlessRuntimeViewModel {
  return {
    state: "starting",
    checkedAt,
    activeTurns: 0,
    pendingSwitch: false,
    switching: false,
    attributionActive: false
  };
}

function sanitizeRuntimeReason(reason: string | undefined): string | undefined {
  if (!reason) {
    return undefined;
  }
  return reason
    .replace(/((?:bearer|access_token|refresh_token|token|secret|password)\s*[=:]\s*)[^\s,;]+/giu, "$1[redacted]")
    .trim()
    .slice(0, 240);
}

function isTransientRuntimeStatusError(reason: string | undefined): boolean {
  return /not configured|not ready|not available|timed out|timeout|connect/iu.test(reason ?? "");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Runtime status check timed out")), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

import { randomUUID } from "node:crypto";
import {
  isHotSwitchOperationUncertainError,
  type CodexHotSwitchRuntime,
  type RuntimeAccountSwitchOptions,
  type RuntimeAccountSwitchOutcome
} from "../../codex";
import type { AccountsRepository } from "../../storage";

const RUNTIME_SWITCH_LEASE_MS = 60_000;
const RUNTIME_SWITCH_LEASE_RENEW_INTERVAL_MS = 20_000;
const OPERATION_RECONCILIATION_TIMEOUT_MS = 2 * 60 * 1000;
const OPERATION_RECONCILIATION_INTERVAL_MS = 1_000;

export type RuntimeSwitchSource = "automatic" | "manual" | "external";

type RuntimeSwitchRepository = Pick<AccountsRepository, "tryAcquireSchedulerLease">;

type RuntimeSwitchRuntime = Pick<
  CodexHotSwitchRuntime,
  "isEnabled" | "isGatewayActive" | "switchAccount" | "fallbackGatewayToChatGpt" | "getOperationStatus"
>;

/**
 * Serializes the small set of operations that can change a live app-server
 * identity. It deliberately does not select quota candidates, refresh quota,
 * parse import jobs, or observe the Gateway: those concerns retain their own
 * domain-specific rules and submit a final runtime handoff here.
 */
export class RuntimeSwitchCoordinator {
  private inFlight: Promise<RuntimeAccountSwitchOutcome> | undefined;

  constructor(
    private readonly repo: RuntimeSwitchRepository,
    private readonly runtime: RuntimeSwitchRuntime,
    private readonly isSeamlessSwitchEnabled: () => boolean
  ) {}

  async switchAccount(
    accountId: string,
    options: RuntimeAccountSwitchOptions | undefined,
    source: RuntimeSwitchSource
  ): Promise<RuntimeAccountSwitchOutcome> {
    if (!this.isSeamlessSwitchEnabled() && options?.allowManualWhenSeamlessDisabled !== true) {
      return { status: "unavailable" };
    }
    if (!this.runtime.isEnabled()) {
      return {
        status: "failed",
        message: "Seamless Switching is enabled, but its runtime is not installed"
      };
    }
    if (this.runtime.isGatewayActive()) {
      if (source === "manual") {
        return {
          status: "failed",
          message: "Switch back from the active Gateway before selecting a ChatGPT Auth account"
        };
      }
      return { status: "suppressed", reason: "gatewayActive" };
    }

    const operationId = randomUUID();
    return this.runSharedRuntimeTransaction(operationId, () =>
      this.runtime.switchAccount(accountId, { ...(options ?? {}), operationId })
    );
  }

  /**
   * Runs an integration-owned provider handoff behind the same cross-window
   * runtime lease used by OAuth switches. The integration callback owns its
   * credential lookup; the coordinator only serializes the transaction.
   */
  async runProviderSwitch(
    options: RuntimeAccountSwitchOptions | undefined,
    execute: (options: RuntimeAccountSwitchOptions) => Promise<RuntimeAccountSwitchOutcome>
  ): Promise<RuntimeAccountSwitchOutcome> {
    const operationId = randomUUID();
    return this.runSharedRuntimeTransaction(operationId, () => execute({ ...(options ?? {}), operationId }));
  }

  /**
   * A manual OAuth selection may intentionally leave an active Gateway route.
   * Return the route first, then switch the requested ChatGPT Auth account
   * without releasing the shared runtime transaction between those steps.
   */
  async returnFromGatewayAndSwitchAccount(
    accountId: string,
    options: RuntimeAccountSwitchOptions | undefined,
    deactivateGateway: (options: RuntimeAccountSwitchOptions) => Promise<RuntimeAccountSwitchOutcome>
  ): Promise<RuntimeAccountSwitchOutcome> {
    if (!this.isSeamlessSwitchEnabled() && options?.allowManualWhenSeamlessDisabled !== true) {
      return { status: "unavailable" };
    }
    if (!this.runtime.isEnabled()) {
      return {
        status: "failed",
        message: "Seamless Switching is enabled, but its runtime is not installed"
      };
    }

    const switchOperationId = randomUUID();
    return this.runSharedRuntimeTransaction(switchOperationId, async () => {
      const gatewayResult = await deactivateGateway({ ...(options ?? {}), operationId: randomUUID() });
      if (gatewayResult.status !== "switched") {
        return gatewayResult;
      }
      if (this.runtime.isGatewayActive()) {
        return {
          status: "failed",
          message: "The Gateway route remains active after the return to ChatGPT Auth"
        };
      }
      return this.runtime.switchAccount(accountId, { ...(options ?? {}), operationId: switchOperationId });
    });
  }

  async fallbackGatewayToChatGpt(
    accountId: string,
    options?: RuntimeAccountSwitchOptions
  ): Promise<RuntimeAccountSwitchOutcome> {
    if (!this.runtime.isEnabled()) {
      return {
        status: "unavailable"
      };
    }
    const operationId = randomUUID();
    return this.runSharedRuntimeTransaction(operationId, () =>
      this.runtime.fallbackGatewayToChatGpt(accountId, { ...(options ?? {}), operationId })
    );
  }

  private async runSharedRuntimeTransaction(
    operationId: string,
    execute: () => Promise<RuntimeAccountSwitchOutcome>
  ): Promise<RuntimeAccountSwitchOutcome> {
    if (this.inFlight) {
      return { status: "suppressed", reason: "operationInProgress" };
    }

    const attempt = this.runWithSharedLease(operationId, execute);
    this.inFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (this.inFlight === attempt) {
        this.inFlight = undefined;
      }
    }
  }

  private async runWithSharedLease(
    operationId: string,
    execute: () => Promise<RuntimeAccountSwitchOutcome>
  ): Promise<RuntimeAccountSwitchOutcome> {
    const lease = await this.repo.tryAcquireSchedulerLease("runtime-switch", RUNTIME_SWITCH_LEASE_MS);
    if (!lease) {
      return { status: "suppressed", reason: "operationInProgress" };
    }

    let renewalInFlight = false;
    let leaseLost = false;
    const renewalTimer = setInterval(() => {
      if (renewalInFlight || leaseLost) {
        return;
      }
      renewalInFlight = true;
      void lease
        .renew(RUNTIME_SWITCH_LEASE_MS)
        .then((renewed) => {
          leaseLost = !renewed;
        })
        .catch((error: unknown) => {
          leaseLost = true;
          console.warn("[codexAccounts] runtime switch lease renewal failed:", describeSwitchError(error));
        })
        .finally(() => {
          renewalInFlight = false;
        });
    }, RUNTIME_SWITCH_LEASE_RENEW_INTERVAL_MS);

    try {
      const result = await execute();
      if (leaseLost) {
        // The runtime result remains authoritative for this window. Do not
        // report a synthetic failure after a successful local commit, but make
        // the cross-host uncertainty visible for diagnosis.
        console.warn("[codexAccounts] runtime switch completed after losing its shared lease");
      }
      return result;
    } catch (error) {
      if (isHotSwitchOperationUncertainError(error)) {
        return this.reconcileUncertainOperation(error.operationId ?? operationId, error);
      }
      return { status: "failed", message: describeSwitchError(error) };
    } finally {
      clearInterval(renewalTimer);
      await lease.release();
    }
  }

  private async reconcileUncertainOperation(
    operationId: string,
    originalError: Error
  ): Promise<RuntimeAccountSwitchOutcome> {
    const deadline = Date.now() + OPERATION_RECONCILIATION_TIMEOUT_MS;
    let lastProbeError: string | undefined;

    while (Date.now() < deadline) {
      try {
        const status = await this.runtime.getOperationStatus(operationId);
        if (status.state === "succeeded") {
          return status.result;
        }
        if (status.state === "failed") {
          return { status: "failed", message: status.message };
        }
        if (status.state === "unknown") {
          return {
            status: "failed",
            message:
              "The runtime restarted before the account-switch outcome could be reconciled. Reload this window before retrying."
          };
        }
      } catch (error) {
        lastProbeError = describeSwitchError(error);
      }
      await delay(OPERATION_RECONCILIATION_INTERVAL_MS);
    }

    return {
      status: "failed",
      message:
        lastProbeError === undefined
          ? `${originalError.message}; the runtime did not settle before the reconciliation deadline`
          : `${originalError.message}; the runtime could not be reconciled: ${lastProbeError}`
    };
  }
}

function describeSwitchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

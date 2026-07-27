import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const CONNECT_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SWITCH_COMPLETION_BUFFER_MS = 2 * 60 * 1000;

export type HotSwitchLongTurnPolicy = "defer" | "interrupt" | "interruptAndContinue";

export type HotSwitchStatus = {
  runtimeProtocolVersion: number;
  ready: boolean;
  initializeResponseReceived: boolean;
  initializedNotificationReceived: boolean;
  activeTurns: number;
  pendingSwitch: boolean;
  switching: boolean;
  httpTransportForced: boolean;
  transportMode: "http" | "default";
  providerKind: "chatgpt" | "gateway" | "default";
  gatewayActive: boolean;
  gatewayConfigured: boolean;
  gatewayAutoFallbackEnabled: boolean;
  /** Whether the shim records low-quota signals for automatic switching/recovery. */
  usageLimitObservationEnabled: boolean;
  recentUsageLimitedThreads: number;
  /** A bounded batch of active conversations has reached actual quota exhaustion. */
  usageLimitExhaustionReady: boolean;
  /** Monotonic scalar used to distinguish one exhaustion batch from the next. */
  usageLimitExhaustionBatchId: number;
  observedUsageLimitFailures: number;
  recoveredUsageLimitedThreads: number;
  resumedUsageLimitedGoals: number;
  shimPid: number;
  appServerPid: number | null;
};

/**
 * Public, provider-neutral view of the one local OpenAI-compatible Gateway
 * route supported by the seamless runtime. Provider integrations own their
 * endpoint configuration and credentials; the runtime only owns the local
 * route and its safe ChatGPT fallback transaction.
 */
export type GatewayRuntimeStatus = {
  active: boolean;
  ready: boolean;
  route?: "gateway" | "chatgpt";
  autoFallbackToChatGpt?: boolean;
  quotaExhaustionCount?: number;
  lastQuotaExhaustionAt?: number;
  instanceId?: string;
  startedAt?: number;
  requestCount: number;
  successfulRequestCount: number;
  failedRequestCount: number;
  lastRequestAt?: number;
  lastFailureAt?: number;
  lastFailureOrigin?: "adapter" | "upstream";
  lastFailureStatusCode?: number;
  lastFailureTransportCode?: string;
  lastFailureRequestMethod?: string;
  lastFailureRequestPath?: string;
  lastFailureContentLength?: number;
  lastFailureTransferEncoding?: "chunked";
  lastUpstreamStatusCode?: number;
  usageDay?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

export type HotSwitchIdentity = {
  accountType: string | null;
  email: string | null;
  planType: string | null;
  externalAuthActive: boolean;
  managedAccountId: string | null;
  managedLocalAccountId: string | null;
  httpTransportForced: boolean;
};

type HotSwitchManagedRollbackParams = {
  previousAccountId: string;
  previousLocalAccountId: string;
  previousExpectedEmail: string;
  previousAccessToken?: never;
  previousPlanType?: never;
  rollbackContextId?: never;
};

type HotSwitchSnapshotRollbackParams = {
  previousAccountId: string;
  previousLocalAccountId?: never;
  previousExpectedEmail: string;
  previousAccessToken: string;
  previousPlanType?: string | null;
  rollbackContextId: string;
};

export type HotSwitchAccountParams = {
  /** Coordinator-owned opaque ID used only to reconcile a disconnected transaction. */
  operationId?: string;
  accessToken: string;
  accountId: string;
  localAccountId: string;
  expectedEmail: string;
  planType?: string;
  gracePeriodMs: number;
  longTurnPolicy: HotSwitchLongTurnPolicy;
  recoverRecentUsageLimitedTurns?: boolean;
} & (HotSwitchManagedRollbackParams | HotSwitchSnapshotRollbackParams);

/**
 * Gateway fallback is also a transactional auth switch.  The adapter keeps
 * serving Gateway until the target identity and local active-account commit
 * both succeed; if either fails, the previous ChatGPT credentials are restored
 * before the relay is left on its original route.
 */
export type HotSwitchGatewayFallbackParams = {
  /** Coordinator-owned opaque ID used only to reconcile a disconnected transaction. */
  operationId?: string;
  accessToken: string;
  accountId: string;
  localAccountId: string;
  expectedEmail: string;
  planType?: string;
  gracePeriodMs: number;
  longTurnPolicy: HotSwitchLongTurnPolicy;
} & (HotSwitchManagedRollbackParams | HotSwitchSnapshotRollbackParams);

export type HotSwitchAccountResult =
  | {
      status: "switched";
      accountId: string;
      email: string | null;
      activeTurns: number;
      interruptedTurns: number;
      continuedThreads: number;
    }
  | {
      status: "deferred";
      reason: "activeOrdinaryTurns" | "uninterruptibleTurns" | "interruptFailed";
      activeTurns: number;
    };

export type HotSwitchOperationStatus =
  | { operationId: string; state: "unknown" | "pending" | "switching" }
  | { operationId: string; state: "succeeded"; result: HotSwitchAccountResult }
  | { operationId: string; state: "failed"; message: string };

export type RuntimeAccountSwitchOutcome =
  | HotSwitchAccountResult
  | { status: "unavailable" }
  | { status: "failed"; message: string }
  /**
   * The request was intentionally not sent to the runtime. This is used for
   * stale automatic work while another host owns a switch, or while the
   * Gateway route deliberately owns the provider.
   */
  | { status: "suppressed"; reason: "gatewayActive" | "operationInProgress" };

export type HotSwitchRefreshResult = {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
};

export type HotSwitchRefreshRequest = {
  previousAccountId?: string;
  localAccountId?: string;
  expectedEmail?: string;
};

export type HotSwitchUsageAttributionParams = {
  localAccountId: string;
  accountId: string;
  expectedEmail: string;
};

export type HotSwitchUsageAttributionResult = {
  active: boolean;
  localAccountId: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
  operationId?: string;
};

type RpcMessage = {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
};

/**
 * The manager no longer knows whether the shim committed after a control
 * socket timeout or disconnect. Callers with an operation ID can reconcile
 * through the shim before releasing their shared runtime lease.
 */
export class HotSwitchOperationUncertainError extends Error {
  constructor(
    readonly method: "runtime/switch" | "runtime/gateway/fallback",
    reason: string,
    readonly operationId?: string
  ) {
    super(`${method} outcome is uncertain: ${reason}`);
    this.name = "HotSwitchOperationUncertainError";
  }
}

export function isHotSwitchOperationUncertainError(error: unknown): error is HotSwitchOperationUncertainError {
  return error instanceof HotSwitchOperationUncertainError;
}

export class CodexHotSwitchBridge {
  private socket: net.Socket | undefined;
  private connectPromise: Promise<net.Socket> | undefined;
  private inputBuffer = "";
  private requestSequence = 0;
  private disposed = false;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly refreshAuth: (request: HotSwitchRefreshRequest) => Promise<HotSwitchRefreshResult>,
    private readonly activateLocalAccount: (localAccountId: string) => Promise<void> = () => Promise.resolve(),
    private readonly restoreUnmanagedAccount: (rollbackContextId: string) => Promise<void> = () =>
      Promise.reject(new Error("Unmanaged Codex account rollback is not configured")),
    private readonly extensionHostPid = process.pid
  ) {}

  async getStatus(): Promise<HotSwitchStatus> {
    return this.request<HotSwitchStatus>("runtime/status", {}, REQUEST_TIMEOUT_MS);
  }

  async getIdentity(): Promise<HotSwitchIdentity> {
    return this.request<HotSwitchIdentity>("runtime/identity", {}, REQUEST_TIMEOUT_MS);
  }

  async configureUsageLimitObservation(enabled: boolean): Promise<{ enabled: boolean }> {
    return this.request<{ enabled: boolean }>("runtime/usage/configure", { enabled }, REQUEST_TIMEOUT_MS);
  }

  async activateUsageAttribution(params: HotSwitchUsageAttributionParams): Promise<HotSwitchUsageAttributionResult> {
    return this.request<HotSwitchUsageAttributionResult>("runtime/usage/activate", params, REQUEST_TIMEOUT_MS);
  }

  async configureGatewayCredential(apiKey: string): Promise<GatewayRuntimeStatus> {
    return this.request<GatewayRuntimeStatus>("gateway/configure", { apiKey }, REQUEST_TIMEOUT_MS);
  }

  async activateGateway(): Promise<GatewayRuntimeStatus> {
    return this.request<GatewayRuntimeStatus>("gateway/activate", {}, REQUEST_TIMEOUT_MS);
  }

  async getGatewayStatus(): Promise<GatewayRuntimeStatus> {
    return this.request<GatewayRuntimeStatus>("gateway/status", {}, REQUEST_TIMEOUT_MS);
  }

  async switchAccount(params: HotSwitchAccountParams): Promise<HotSwitchAccountResult> {
    const timeoutMs = Math.max(REQUEST_TIMEOUT_MS, params.gracePeriodMs + SWITCH_COMPLETION_BUFFER_MS);
    return this.request<HotSwitchAccountResult>("runtime/switch", params, timeoutMs);
  }

  async fallbackToChatGpt(params: HotSwitchGatewayFallbackParams): Promise<HotSwitchAccountResult> {
    const timeoutMs = Math.max(REQUEST_TIMEOUT_MS, params.gracePeriodMs + SWITCH_COMPLETION_BUFFER_MS);
    return this.request<HotSwitchAccountResult>("runtime/gateway/fallback", params, timeoutMs);
  }

  async getOperationStatus(operationId: string): Promise<HotSwitchOperationStatus> {
    return this.request<HotSwitchOperationStatus>("runtime/operation/status", { operationId }, REQUEST_TIMEOUT_MS);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.socket?.destroy();
    this.socket = undefined;
    this.connectPromise = undefined;
    this.rejectPending(new Error("Codex hot-switch bridge disposed"));
  }

  private async request<T>(method: string, params: object, timeoutMs: number): Promise<T> {
    if (this.disposed) {
      throw new Error("Codex hot-switch bridge is disposed");
    }

    const socket = await this.connect();
    const id = `manager:${++this.requestSequence}`;
    const operationId = readOperationId(params);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (!socket.destroyed && isRuntimeMutationMethod(method)) {
          socket.write(
            `${JSON.stringify({
              id: `cancel:${id}`,
              method: "runtime/cancel",
              params: { requestId: id }
            })}\n`
          );
        }
        reject(
          isRuntimeMutationMethod(method)
            ? new HotSwitchOperationUncertainError(method, "the control request timed out", operationId)
            : new Error(`${method} timed out`)
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
        operationId
      });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) {
      return Promise.resolve(this.socket);
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(getHotSwitchSocketPath(this.extensionHostPid));
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("Codex hot-switch runtime is not available"));
      }, CONNECT_TIMEOUT_MS);

      const failConnect = (error: Error): void => {
        clearTimeout(timeout);
        reject(new Error(`Codex hot-switch runtime is not available: ${error.message}`));
      };

      socket.once("error", failConnect);
      socket.once("connect", () => {
        clearTimeout(timeout);
        socket.off("error", failConnect);
        this.socket = socket;
        this.attachSocket(socket);
        resolve(socket);
      });
    }).finally(() => {
      this.connectPromise = undefined;
    });

    return this.connectPromise;
  }

  private attachSocket(socket: net.Socket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.inputBuffer += chunk;
      let newlineIndex = this.inputBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.inputBuffer.slice(0, newlineIndex).replace(/\r$/u, "");
        this.inputBuffer = this.inputBuffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          this.handleLine(socket, line);
        }
        newlineIndex = this.inputBuffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      this.inputBuffer = "";
      this.rejectPending(new Error("Codex hot-switch runtime disconnected"));
    });
    socket.on("error", () => {
      // The close handler rejects all outstanding requests with a sanitized error.
    });
  }

  private handleLine(socket: net.Socket, line: string): void {
    const message = parseRpcMessage(line);
    if (!message || message.id === undefined || message.id === null) {
      return;
    }

    const id = String(message.id);
    const pending = this.pending.get(id);
    if (pending && !message.method) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex hot-switch request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "auth/refresh") {
      const request: HotSwitchRefreshRequest = {
        previousAccountId:
          typeof message.params?.["previousAccountId"] === "string" ? message.params["previousAccountId"] : undefined,
        localAccountId:
          typeof message.params?.["localAccountId"] === "string" ? message.params["localAccountId"] : undefined,
        expectedEmail:
          typeof message.params?.["expectedEmail"] === "string" ? message.params["expectedEmail"] : undefined
      };
      void this.refreshAuth(request).then(
        (result) => this.writeResponse(socket, message.id!, { result }),
        (error: unknown) =>
          this.writeResponse(socket, message.id!, {
            error: {
              code: -32001,
              message: error instanceof Error ? error.message : "Unable to refresh Codex credentials"
            }
          })
      );
      return;
    }

    if (message.method === "account/activate") {
      const localAccountId =
        typeof message.params?.["localAccountId"] === "string" ? message.params["localAccountId"] : undefined;
      if (!localAccountId) {
        this.writeResponse(socket, message.id, {
          error: { code: -32602, message: "Missing local account identifier" }
        });
        return;
      }
      void this.activateLocalAccount(localAccountId).then(
        () => this.writeResponse(socket, message.id!, { result: {} }),
        (error: unknown) =>
          this.writeResponse(socket, message.id!, {
            error: {
              code: -32002,
              message: error instanceof Error ? error.message : "Unable to activate the managed account"
            }
          })
      );
      return;
    }

    if (message.method === "account/restore-unmanaged") {
      const rollbackContextId =
        typeof message.params?.["rollbackContextId"] === "string" ? message.params["rollbackContextId"] : undefined;
      if (!rollbackContextId) {
        this.writeResponse(socket, message.id, {
          error: { code: -32602, message: "Missing rollback context identifier" }
        });
        return;
      }
      void this.restoreUnmanagedAccount(rollbackContextId).then(
        () => this.writeResponse(socket, message.id!, { result: {} }),
        (error: unknown) =>
          this.writeResponse(socket, message.id!, {
            error: {
              code: -32003,
              message: error instanceof Error ? error.message : "Unable to restore the unmanaged Codex account"
            }
          })
      );
    }
  }

  private writeResponse(
    socket: net.Socket,
    id: string | number,
    payload: { result?: unknown; error?: { code: number; message: string } }
  ): void {
    if (!socket.destroyed) {
      socket.write(`${JSON.stringify({ id, ...payload })}\n`);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        isRuntimeMutationMethod(pending.method)
          ? new HotSwitchOperationUncertainError(pending.method, error.message, pending.operationId)
          : error
      );
    }
    this.pending.clear();
  }
}

function isRuntimeMutationMethod(method: string): method is "runtime/switch" | "runtime/gateway/fallback" {
  return method === "runtime/switch" || method === "runtime/gateway/fallback";
}

function readOperationId(params: object): string | undefined {
  const operationId = (params as Record<string, unknown>)["operationId"];
  return typeof operationId === "string" && operationId.length > 0 ? operationId : undefined;
}

export function getHotSwitchSocketPath(extensionHostPid: number): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\codex-accounts-manager-${extensionHostPid}`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `codex-accounts-manager-${uid}`, `${extensionHostPid}.sock`);
}

function parseRpcMessage(line: string): RpcMessage | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as RpcMessage) : undefined;
  } catch {
    return undefined;
  }
}

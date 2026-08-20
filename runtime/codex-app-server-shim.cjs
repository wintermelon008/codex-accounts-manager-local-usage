#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { spawn } = require("node:child_process");

const INTERNAL_ID_PREFIX = "__codex_accounts_manager__";
const INTERNAL_REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_REQUEST_TIMEOUT_MS = 30_000;
const ACCOUNT_IDENTITY_SETTLE_TIMEOUT_MS = 5_000;
const ACCOUNT_IDENTITY_POLL_INTERVAL_MS = 100;
const ACCOUNT_LOGIN_COMPLETION_TIMEOUT_MS = 30_000;
const RECOVERY_CONTEXT_KEY = "codex-account-manager/recovery";
const CONFIG_PATH = path.join(__dirname, "codex-app-server-shim.json");
const MAX_TERMINAL_TURN_IDS = 2_048;
const MAX_CAPACITY_RECOVERY_THREADS = 2_048;
const CAPACITY_RECOVERY_MIN_DELAY_MS = 5_000;
const CAPACITY_RECOVERY_MAX_DELAY_MS = 8_000;
const MAX_RECENT_USAGE_LIMITED_THREADS = 2_048;
const USAGE_LIMIT_EXHAUSTION_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
// A quota-exhaustion batch may wait for other active conversations to reach a
// safe boundary. Keep the stopped threads available for the same bounded
// six-hour window so the eventual switch can continue them together.
const RECENT_USAGE_LIMITED_THREAD_TTL_MS = USAGE_LIMIT_EXHAUSTION_MAX_WAIT_MS;
const MAX_USAGE_ATTRIBUTION_THREADS = 2_048;
const MAX_USAGE_ATTRIBUTION_BATCH_SIZE = 32;
const USAGE_ATTRIBUTION_FLUSH_DELAY_MS = 2_000;
const RUNTIME_PROTOCOL_VERSION = 12;
const MAX_RECENT_SWITCH_OPERATIONS = 64;
const SWITCH_OPERATION_TTL_MS = 10 * 60 * 1000;
const SEAMLESS_HTTP_PROVIDER_ID = "codex-accounts-seamless-http";
const SEAMLESS_HTTP_PROVIDER_CONFIG =
  `model_providers.${SEAMLESS_HTTP_PROVIDER_ID}={ name="OpenAI", wire_api="responses", ` +
  "requires_openai_auth=true, supports_websockets=false }";
// Local .37 Gateway threads were created under this provider ID. Keep it as
// an internal alias so those threads resume through the currently selected
// transport, without making it the provider for new threads.
const LEGACY_GATEWAY_PROVIDER_ID = "codex-accounts-gateway";
const LEGACY_GATEWAY_PROVIDER_CONFIG =
  `model_providers.${LEGACY_GATEWAY_PROVIDER_ID}={ name="OpenAI", wire_api="responses", ` +
  "requires_openai_auth=true, supports_websockets=false }";
const GATEWAY_ADAPTER_ENV_KEY = "CODEX_ACCOUNTS_GATEWAY_ADAPTER_TOKEN";
const MAX_GATEWAY_API_KEY_LENGTH = 4_096;
// The adapter starts before the VS Code extension host reconnects and passes
// the SecretStorage key over its local control socket. Hold a valid early
// request briefly instead of making the automatic thread resume fail first.
const GATEWAY_CREDENTIAL_WAIT_TIMEOUT_MS = 15_000;
const MAX_GATEWAY_USAGE_LINE_BYTES = 256 * 1024;
const MAX_GATEWAY_JSON_USAGE_BYTES = 1024 * 1024;
const MAX_GATEWAY_MODELS = 256;
const GATEWAY_DIAGNOSTIC_SCHEMA = "codex-accounts-gateway-diagnostic/v1";
const GATEWAY_DIAGNOSTIC_PATH = path.join(path.dirname(CONFIG_PATH), "gateway-last-failure.json");
const MAX_GATEWAY_DIAGNOSTIC_CONTENT_LENGTH = 512 * 1024 * 1024;
const MAX_GATEWAY_QUOTA_ERROR_BODY_BYTES = 64 * 1024;
const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

const runtimeConfig = process.env.CODEX_ACCOUNTS_REAL_CLI ? {} : readRuntimeConfig();
const realCliPath = process.env.CODEX_ACCOUNTS_REAL_CLI || runtimeConfig.realCliPath;
const forceHttpTransport = runtimeConfig.forceHttpTransport !== false;
const usageAttributionDirectory = resolveUsageAttributionDirectory(runtimeConfig);
const gatewayConfig = resolveGatewayConfig(runtimeConfig);

if (!realCliPath || !path.isAbsolute(realCliPath)) {
  failStartup("The real Codex CLI path is missing from the hot-switch runtime configuration");
}
if (path.resolve(realCliPath) === path.resolve(process.argv[1])) {
  failStartup("The hot-switch shim cannot launch itself as the real Codex CLI");
}

let childReady = false;
let initializeResponseReceived = false;
let initializedNotificationReceived = false;
let childExited = false;
let anonymousActiveTurnCount = 0;
let switching = false;
let goalPreparationCount = 0;
let goalRecoveryCount = 0;
let observedUsageLimitFailures = 0;
let recoveredUsageLimitedThreads = 0;
let resumedUsageLimitedGoals = 0;
let usageLimitExhaustionBatch;
let readyUsageLimitExhaustionBatchId = 0;
let usageLimitExhaustionObservationSuppressed = false;
let usageLimitObservationEnabled = true;
let externalAuthActive = false;
let activeManagedAccount;
let runtimeOAuthIdentity;
let usageAttributionAccount;
let usageAttributionFailureReason = "not_activated";
let pendingSwitch;
let activeSwitchRequest;
let internalSequence = 0;
let controlSequence = 0;
let latestControlSocket;
let controlServer;
let socketPath;
const deferredOfficialLines = [];
const pendingInternalRequests = new Map();
const pendingChildModelListRequests = new Map();
const startupAccountReadRequests = new Set();
let pendingLoginCompletion;
const pendingControlRequests = new Map();
const recentSwitchOperations = new Map();
const submittedTurnStarts = new Map();
const activeTurns = new Map();
const terminalTurnIds = new Set();
const turnWorkGenerations = new Map();
const latestWorkGenerations = new Map();
const submittedTurnStartGenerations = new Map();
const capacityRecoveryThreads = new Map();
const recentUsageLimitedThreads = new Map();
const initializeRequests = new Set();
const controlSockets = new Set();
const lastUsageAttributionByThread = new Map();
let pendingUsageAttributionRecords = [];
let usageAttributionFlushTimer;
let usageAttributionWriteFailureReported = false;
let child;
let gatewayAdapter;
let startupModelRefreshNotificationSent = false;

void startRuntime();

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!childExited && child) {
      child.kill(signal);
    }
  });
}

process.on("exit", () => {
  flushUsageAttributionRecords();
  closeGatewayAdapter();
});

async function startRuntime() {
  try {
    if (gatewayConfig && process.argv.includes("app-server")) {
      gatewayAdapter = await startGatewayAdapter(gatewayConfig);
    }
    const childEnv = { ...process.env };
    if (gatewayAdapter) {
      if (!gatewayConfig.autoFallbackToChatGpt) {
        childEnv[GATEWAY_ADAPTER_ENV_KEY] = gatewayAdapter.token;
      }
      configureGatewayLoopbackProxyBypass(childEnv);
      safeLog("Gateway loopback proxy bypass configured");
    }
    child = spawn(realCliPath, buildRealCliArgs(process.argv.slice(2)), {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.on("error", (error) => {
      safeLog(`failed to start the real Codex CLI: ${safeErrorMessage(error)}`);
    });

    child.stderr.pipe(process.stderr);

    consumeLines(process.stdin, handleOfficialLine, () => {
      child.stdin.end();
    });
    consumeLines(child.stdout, handleCodexLine, () => {
      process.stdout.end();
    });

    if (process.argv.includes("app-server")) {
      startControlServer();
    }

    child.on("exit", (code, signal) => {
      childExited = true;
      clearAllCapacityRecoveryThreads();
      flushUsageAttributionRecords();
      rejectPendingRequests(new Error("Codex app-server exited"));
      closeControlServer();
      closeGatewayAdapter();
      process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
    });
  } catch (error) {
    closeGatewayAdapter();
    failStartup(`Unable to start the Codex runtime: ${safeErrorMessage(error)}`);
  }
}

function handleOfficialLine(line) {
  const message = parseJson(line);
  if (!message) {
    writeChildLine(line);
    return;
  }

  if (isGatewayModelListRequest(message)) {
    handleGatewayModelListRequest(message, line);
    return;
  }

  if (message.method === "account/read" && Object.prototype.hasOwnProperty.call(message, "id")) {
    startupAccountReadRequests.add(requestIdKey(message.id));
  }

  if (rewriteThreadListProviderFilter(message)) {
    line = JSON.stringify(message);
  }

  if (isWorkStartMethod(message.method)) {
    const threadId = readThreadId(message.params);
    // New work demonstrates that the current runtime is still usable (or that
    // the user intentionally moved on), so it must not inherit an older
    // all-conversations-exhausted decision.
    resetUsageLimitExhaustionObservation();
    clearRecentUsageLimitedThread(threadId);
    clearCapacityRecoveryThread(threadId, { force: true });
    const workGeneration = advanceWorkGeneration(threadId);
    if (workGeneration !== undefined && Object.prototype.hasOwnProperty.call(message, "id")) {
      submittedTurnStartGenerations.set(requestIdKey(message.id), workGeneration);
    }
  }

  if ((isWorkStartMethod(message.method) || isGoalMutationMethod(message.method)) && isSwitchBarrierActive()) {
    deferredOfficialLines.push(line);
    return;
  }

  if (isWorkStartMethod(message.method) && Object.prototype.hasOwnProperty.call(message, "id")) {
    const requestKey = requestIdKey(message.id);
    submittedTurnStarts.set(requestKey, readThreadId(message.params));
  }

  if (message.method === "initialize" && Object.prototype.hasOwnProperty.call(message, "id")) {
    initializeRequests.add(requestIdKey(message.id));
  }

  if (message.method === "initialized") {
    initializedNotificationReceived = true;
    updateChildReady();
  }

  writeChildLine(line);
}

function isGatewayModelListRequest(message) {
  return Boolean(
    gatewayConfig &&
      gatewayAdapter &&
      message.method === "model/list" &&
      Object.prototype.hasOwnProperty.call(message, "id")
  );
}

function handleGatewayModelListRequest(message, line) {
  const adapter = gatewayAdapter;
  if (!adapter) {
    writeChildLine(line);
    return;
  }
  const routeVersion = adapter.modelListRouteVersion;
  if (adapter.route !== "gateway") {
    forwardModelListRequestToChild(adapter, routeVersion, message, line);
    return;
  }
  void requestGatewayModelList(adapter).then(
    (models) => {
      if (!isCurrentGatewayModelListRoute(adapter, routeVersion)) {
        handleGatewayModelListRequest(message, line);
        return;
      }
      if (models.length === 0) {
        forwardModelListRequestToChild(adapter, routeVersion, message, line);
        return;
      }
      writeOfficialLine(
        JSON.stringify({
          id: message.id,
          result: paginateGatewayModels(models, message.params)
        })
      );
    },
    () => {
      if (!isCurrentGatewayModelListRoute(adapter, routeVersion)) {
        handleGatewayModelListRequest(message, line);
        return;
      }
      forwardModelListRequestToChild(adapter, routeVersion, message, line);
    }
  );
}

function isCurrentGatewayModelListRoute(adapter, routeVersion) {
  return gatewayAdapter === adapter && adapter.route === "gateway" && adapter.modelListRouteVersion === routeVersion;
}

function forwardModelListRequestToChild(adapter, routeVersion, message, line) {
  pendingChildModelListRequests.set(requestIdKey(message.id), { adapter, routeVersion, message, line });
  writeChildLine(line);
}

function retryStaleChildModelListResponse(message) {
  const key = requestIdKey(message.id);
  const pending = pendingChildModelListRequests.get(key);
  if (!pending) {
    return false;
  }
  pendingChildModelListRequests.delete(key);
  if (gatewayAdapter === pending.adapter && gatewayAdapter.modelListRouteVersion !== pending.routeVersion) {
    handleGatewayModelListRequest(pending.message, pending.line);
    return true;
  }
  return false;
}

function handleCodexLine(line) {
  const message = parseJson(line);
  if (!message) {
    writeOfficialLine(line);
    return;
  }

  if (message.method === "account/login/completed") {
    settleLoginCompletion(message.params);
  }

  if (message.method === "account/chatgptAuthTokens/refresh" && externalAuthActive) {
    void handleAuthRefreshRequest(message);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
    const key = requestIdKey(message.id);
    const startupAccountRead = startupAccountReadRequests.delete(key);
    if (startupAccountRead && !startupModelRefreshNotificationSent) {
      startupModelRefreshNotificationSent = true;
      setImmediate(() => {
        if (gatewayAdapter && !childExited) {
          writeOfficialLine(JSON.stringify({ method: "account/updated", params: {} }));
        }
      });
    }
    if (retryStaleChildModelListResponse(message)) {
      return;
    }
    const pendingInternal = pendingInternalRequests.get(key);
    if (pendingInternal) {
      pendingInternalRequests.delete(key);
      clearTimeout(pendingInternal.timer);
      if (message.error) {
        if (pendingInternal.recoveryTurn) {
          observeRecoveryTurnFailure(pendingInternal, message.error);
        }
        pendingInternal.reject(new Error(safeRpcError(message.error)));
      } else {
        pendingInternal.resolve(message.result);
      }
      return;
    }

    if (initializeRequests.delete(key) && !message.error) {
      initializeResponseReceived = true;
      updateChildReady();
    }

    if (submittedTurnStarts.has(key)) {
      const submittedThreadId = submittedTurnStarts.get(key);
      const submittedWorkGeneration = submittedTurnStartGenerations.get(key);
      submittedTurnStarts.delete(key);
      submittedTurnStartGenerations.delete(key);
      if (!message.error) {
        const turnId = readTurnId(message.result);
        if (turnId) {
          if (!terminalTurnIds.has(turnId)) {
            rememberActiveTurn(turnId, submittedThreadId, submittedWorkGeneration);
          }
        } else {
          anonymousActiveTurnCount += 1;
        }
      } else if (isUsageLimitExceededError(message.error)) {
        // A rejected turn/start has no following turn/completed event. It is
        // therefore already terminal when it becomes part of an exhaustion
        // batch.
        clearCapacityRecoveryThread(submittedThreadId, { force: true });
        captureUsageLimitedThread(submittedThreadId, { terminal: true });
      } else if (isModelCapacityError(message.error)) {
        scheduleCapacityRecovery(submittedThreadId, {
          workGeneration: submittedWorkGeneration
        });
      } else {
        observeUsageLimitExhaustionTerminal(submittedThreadId, "rejected", false);
      }
      void drainPendingSwitch();
    }
  }

  if (message.method === "turn/started") {
    const turnId = readTurnId(message.params);
    if (turnId && !terminalTurnIds.has(turnId)) {
      if (!activeTurns.has(turnId) && anonymousActiveTurnCount > 0) {
        anonymousActiveTurnCount -= 1;
      }
      rememberActiveTurn(turnId, readThreadId(message.params));
    }
  }

  if (message.method === "error" && message.params?.willRetry === false) {
    const threadId = readThreadId(message.params);
    const turnId = readNotificationTurnId(message.params);
    const workGeneration = readWorkGeneration(threadId, turnId);
    if (isUsageLimitExceededError(message.params.error)) {
      clearCapacityRecoveryThread(threadId, { force: true });
      captureUsageLimitedThread(threadId);
    } else if (isModelCapacityError(message.params.error)) {
      scheduleCapacityRecovery(threadId, { sourceTurnId: turnId, workGeneration });
    } else {
      clearCapacityRecoveryThread(threadId, { turnId, workGeneration });
    }
  }

  if (message.method === "turn/completed") {
    const turnId = readTurnId(message.params);
    const threadId = readThreadId(message.params) || (turnId ? activeTurns.get(turnId) : undefined);
    if (turnId) {
      rememberTerminalTurnId(turnId);
    }
    const request = pendingSwitch;
    const usageLimitExceeded = Boolean(threadId && isUsageLimitExceededTurn(message.params));
    const modelCapacity = Boolean(threadId && isModelCapacityTurn(message.params));
    const workGeneration = readWorkGeneration(threadId, turnId);
    if (usageLimitExceeded) {
      // Remember the recovery candidate while the completed turn is still in
      // the active snapshot. Terminal classification happens after removing
      // it below, so a contradictory normal completion cancels only the batch.
      clearCapacityRecoveryThread(threadId, { force: true });
      captureUsageLimitedThread(threadId);
    } else if (modelCapacity) {
      scheduleCapacityRecovery(threadId, { sourceTurnId: turnId, workGeneration });
    }
    if (turnId && request && request.interruptedTurnIds.delete(turnId)) {
      request.interruptedTurnCount += 1;
      if (
        readTurnStatus(message.params) === "interrupted" &&
        request.params.longTurnPolicy === "interruptAndContinue" &&
        threadId &&
        !request.pausedGoalThreadIds.has(threadId)
      ) {
        request.recoveryThreadIds.add(threadId);
      }
    }
    if (turnId) {
      if (!activeTurns.delete(turnId) && anonymousActiveTurnCount > 0) {
        anonymousActiveTurnCount -= 1;
      }
    } else {
      anonymousActiveTurnCount = Math.max(0, anonymousActiveTurnCount - 1);
    }
    observeUsageLimitExhaustionTerminal(threadId, readTurnStatus(message.params), usageLimitExceeded);
    if (!usageLimitExceeded && !modelCapacity) {
      clearCapacityRecoveryThread(threadId, { turnId, workGeneration });
    }
    void drainPendingSwitch();
  }

  writeOfficialLine(line);
}

function rewriteThreadListProviderFilter(message) {
  const params = message.params;
  if (
    !forceHttpTransport ||
    message.method !== "thread/list" ||
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    params.modelProviders !== null
  ) {
    return false;
  }
  params.modelProviders = [];
  return true;
}

function startControlServer() {
  socketPath = getControlSocketPath(process.ppid);
  if (process.platform !== "win32") {
    const runtimeDirectory = path.dirname(socketPath);
    fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(runtimeDirectory, 0o700);
    } catch {
      // Best effort on filesystems that do not expose POSIX modes.
    }
    try {
      fs.unlinkSync(socketPath);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  controlServer = net.createServer((socket) => {
    controlSockets.add(socket);
    latestControlSocket = socket;
    socket.setEncoding("utf8");
    consumeLines(socket, (line) => handleControlLine(socket, line));
    socket.on("close", () => {
      controlSockets.delete(socket);
      if (pendingSwitch && pendingSwitch.socket === socket) {
        const request = pendingSwitch;
        pendingSwitch = undefined;
        request.canceled = true;
        clearSwitchGraceTimer(request);
        restoreClaimedCapacityRecoveryEntries(request);
        recordSwitchOperationFailure(request.operationId, "Manager disconnected before account switch login");
        void recoverPausedGoals(request).catch((error) => {
          safeLog(`failed to resume paused goals after manager disconnect: ${safeErrorMessage(error)}`);
        });
      }
      if (latestControlSocket === socket) {
        latestControlSocket = [...controlSockets].at(-1);
      }
    });
    socket.on("error", () => {
      // Connection failures are reported to the caller through request timeouts.
    });
  });

  controlServer.on("error", (error) => {
    safeLog(`hot-switch control socket failed: ${safeErrorMessage(error)}`);
  });
  controlServer.listen(socketPath, () => {
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        // Best effort on filesystems that do not expose POSIX modes.
      }
    }
  });
}

function updateChildReady() {
  // A successful initialize response is sufficient to use app-server RPC. Some
  // official extension builds do not emit an observable `initialized`
  // notification, while receiving that notification also means the client has
  // completed its side of the handshake.
  if (!childReady && (initializeResponseReceived || initializedNotificationReceived)) {
    childReady = true;
    void drainPendingSwitch();
  }
}

function handleControlLine(socket, line) {
  const message = parseJson(line);
  if (!message || !Object.prototype.hasOwnProperty.call(message, "id")) {
    sendControlError(socket, null, "Malformed control message");
    return;
  }

  const pendingControl = pendingControlRequests.get(requestIdKey(message.id));
  if (pendingControl && !message.method) {
    pendingControlRequests.delete(requestIdKey(message.id));
    clearTimeout(pendingControl.timer);
    if (message.error) {
      pendingControl.reject(new Error(safeRpcError(message.error)));
    } else {
      pendingControl.resolve(message.result);
    }
    return;
  }

  if (message.method === "runtime/status") {
    sendControlResult(socket, message.id, runtimeStatus());
    return;
  }

  if (message.method === "runtime/operation/status") {
    const operationId = message.params && message.params.operationId;
    if (!isValidSwitchOperationId(operationId)) {
      sendControlError(socket, message.id, "Invalid account switch operation identifier");
      return;
    }
    sendControlResult(socket, message.id, getSwitchOperationStatus(operationId));
    return;
  }

  if (message.method === "runtime/identity") {
    void readRuntimeIdentity().then(
      (identity) => sendControlResult(socket, message.id, identity),
      (error) => sendControlError(socket, message.id, safeErrorMessage(error))
    );
    return;
  }

  if (message.method === "runtime/usage/configure") {
    try {
      sendControlResult(socket, message.id, configureUsageLimitObservation(message.params));
    } catch (error) {
      sendControlError(socket, message.id, safeErrorMessage(error));
    }
    return;
  }

  if (message.method === "runtime/usage/reset") {
    sendControlResult(socket, message.id, resetUsageLimitObservation());
    return;
  }

  if (message.method === "runtime/usage/activate") {
    void activateUsageAttribution(message.params).then(
      (result) => sendControlResult(socket, message.id, result),
      (error) => sendControlError(socket, message.id, safeErrorMessage(error))
    );
    return;
  }

  if (message.method === "gateway/configure") {
    try {
      sendControlResult(socket, message.id, configureGatewayAdapter(message.params));
    } catch (error) {
      sendControlError(socket, message.id, safeErrorMessage(error));
    }
    return;
  }

  if (message.method === "gateway/activate") {
    try {
      sendControlResult(socket, message.id, activateGatewayAdapter());
    } catch (error) {
      sendControlError(socket, message.id, safeErrorMessage(error));
    }
    return;
  }

  if (message.method === "gateway/status") {
    sendControlResult(socket, message.id, getGatewayAdapterStatus());
    return;
  }

  if (message.method === "runtime/switch") {
    queueRuntimeSwitch(socket, message.id, message.params);
    return;
  }

  if (message.method === "runtime/gateway/fallback") {
    queueGatewayFallback(socket, message.id, message.params);
    return;
  }

  if (message.method === "runtime/gateway/switch") {
    queueGatewayRouteSwitch(socket, message.id, message.params);
    return;
  }

  if (message.method === "runtime/cancel") {
    const requestId = message.params && message.params.requestId;
    const canceled = Boolean(
      pendingSwitch && pendingSwitch.socket === socket && requestIdKey(pendingSwitch.id) === requestIdKey(requestId)
    );
    if (canceled) {
      const request = pendingSwitch;
      pendingSwitch = undefined;
      request.canceled = true;
      clearSwitchGraceTimer(request);
      restoreClaimedCapacityRecoveryEntries(request);
      recordSwitchOperationFailure(request.operationId, "Account switch canceled before login");
      void recoverPausedGoals(request).catch((error) => {
        safeLog(`failed to resume paused goals after switch cancellation: ${safeErrorMessage(error)}`);
      });
    }
    sendControlResult(socket, message.id, { canceled });
    return;
  }

  sendControlError(socket, message.id, "Unsupported control method");
}

function queueRuntimeSwitch(socket, id, params) {
  if (!isValidSwitchParams(params)) {
    sendControlError(socket, id, "Invalid account switch parameters");
    return;
  }
  queueRuntimeSwitchRequest(socket, id, params, false);
}

function queueGatewayFallback(socket, id, params) {
  if (!gatewayConfig?.autoFallbackToChatGpt || !gatewayAdapter || gatewayAdapter.route !== "gateway") {
    sendControlError(socket, id, "The Gateway fallback route is not active");
    return;
  }
  if (!isValidGatewayFallbackParams(params)) {
    sendControlError(socket, id, "Invalid Gateway fallback parameters");
    return;
  }
  queueRuntimeSwitchRequest(socket, id, params, true);
}

function queueGatewayRouteSwitch(socket, id, params) {
  if (!gatewayConfig || !gatewayAdapter) {
    sendControlError(socket, id, "The Gateway runtime is not configured");
    return;
  }
  if (!isValidGatewayRouteParams(params)) {
    sendControlError(socket, id, "Invalid Gateway route parameters");
    return;
  }
  if (params.route === "gateway" && !gatewayAdapter.apiKey) {
    sendControlError(socket, id, "The Gateway downstream credential is not configured");
    return;
  }
  queueRuntimeSwitchRequest(socket, id, params, false, true);
}

function queueRuntimeSwitchRequest(socket, id, params, gatewayFallback, routeSwitch = false) {
  const operationId = readSwitchOperationId(params) || `request:${requestIdKey(id)}`;
  const existingOperation = recentSwitchOperations.get(operationId);
  if (existingOperation) {
    if (existingOperation.state === "succeeded") {
      sendControlResult(socket, id, existingOperation.result);
    } else if (existingOperation.state === "failed") {
      sendControlError(socket, id, existingOperation.message);
    } else {
      sendControlError(socket, id, "This account switch operation is already in progress");
    }
    return;
  }
  if (pendingSwitch || switching || goalPreparationCount > 0 || goalRecoveryCount > 0) {
    sendControlError(socket, id, "Another account switch is already pending");
    return;
  }

  const request = {
    socket,
    id,
    operationId,
    params,
    gatewayFallback,
    routeSwitch,
    previousGatewayRoute: gatewayAdapter?.route,
    previousGatewayAccessToken: gatewayAdapter?.chatgptAccessToken,
    canceled: false,
    goalsPrepared: false,
    graceExpired: false,
    interrupting: false,
    graceTimer: undefined,
    pausedGoalThreadIds: new Set(),
    interruptedTurnIds: new Set(),
    interruptedTurnCount: 0,
    recentUsageLimitedThreadIds:
      params.recoverRecentUsageLimitedTurns === true ? getRecentUsageLimitedThreadIds() : new Set(),
    recentUsageLimitedGoalThreadIds: new Set(),
    recoveryThreadIds: new Set(),
    capacityRecoveryEntries: new Map(),
    capacityRecoveryGoalThreadIds: new Set(),
    capacityAddedRecoveryThreadIds: new Set(),
    recoveryPromise: undefined
  };
  recordSwitchOperationPending(operationId);
  pendingSwitch = request;
  claimCapacityRecoveryThreads(request);
  goalPreparationCount += 1;
  void prepareGoalsForSwitch(request).finally(() => {
    goalPreparationCount = Math.max(0, goalPreparationCount - 1);
    void drainPendingSwitch();
    flushDeferredOfficialLines();
  });
}

async function drainPendingSwitch() {
  if (
    !pendingSwitch ||
    !pendingSwitch.goalsPrepared ||
    switching ||
    !childReady ||
    getActiveTurnCount() > 0 ||
    childExited
  ) {
    return;
  }

  const request = pendingSwitch;
  pendingSwitch = undefined;
  activeSwitchRequest = request;
  clearSwitchGraceTimer(request);
  recordSwitchOperationSwitching(request.operationId);
  switching = true;
  let loginApplied = false;
  let localAccountActivationAttempted = false;
  let gatewayRouteActivated = false;
  let routeChanged = false;
  try {
    let actualEmail = null;
    if (request.routeSwitch) {
      if (request.params.route === "gateway") {
        activateGatewayAdapter();
      } else {
        activateChatGptGatewayRoute(request.params.chatgptAccessToken);
        if (request.params.chatgptAccountId && request.params.chatgptExpectedEmail) {
          activeManagedAccount = request.params.chatgptLocalAccountId
            ? {
                accountId: request.params.chatgptAccountId,
                localAccountId: request.params.chatgptLocalAccountId,
                expectedEmail: request.params.chatgptExpectedEmail
              }
            : undefined;
          runtimeOAuthIdentity = {
            accountId: request.params.chatgptAccountId,
            localAccountId: request.params.chatgptLocalAccountId,
            expectedEmail: request.params.chatgptExpectedEmail,
            planType: request.params.chatgptPlanType || null
          };
        } else {
          activeManagedAccount = undefined;
          runtimeOAuthIdentity = undefined;
        }
      }
      routeChanged = request.previousGatewayRoute !== gatewayAdapter?.route;
    } else {
      await sendChatGptLogin({
        type: "chatgptAuthTokens",
        accessToken: request.params.accessToken,
        chatgptAccountId: request.params.accountId,
        chatgptPlanType: request.params.planType || null
      });
      loginApplied = true;
      externalAuthActive = true;

      actualEmail = await waitForChatGptAccountIdentity(
        request.params.expectedEmail,
        "The app-server reported a different account after hot switch"
      );

      if (
        !request.gatewayFallback &&
        request.previousGatewayRoute === "chatgpt" &&
        gatewayConfig &&
        gatewayConfig.autoFallbackToChatGpt !== true
      ) {
        // The non-fallback relay owns its upstream bearer because the child
        // provider deliberately disables OpenAI auth. Update it only after the
        // app-server has committed the same OAuth login.
        activateChatGptGatewayRoute(request.params.accessToken);
      }

      if (request.gatewayFallback) {
        activateChatGptGatewayRoute();
        gatewayRouteActivated = true;
      }

      localAccountActivationAttempted = true;
      await sendControlRequest("account/activate", { localAccountId: request.params.localAccountId });
      activeManagedAccount = {
        accountId: request.params.accountId,
        localAccountId: request.params.localAccountId,
        expectedEmail: request.params.expectedEmail
      };
      usageAttributionAccount = activeManagedAccount;
      usageAttributionFailureReason = undefined;
      runtimeOAuthIdentity = {
        accountId: request.params.accountId,
        localAccountId: request.params.localAccountId,
        expectedEmail: request.params.expectedEmail,
        planType: request.params.planType || null
      };
    }
    const resumedPausedGoalThreadIds = await resumePausedGoals(request);
    await resumeRecentUsageLimitedGoals(request, resumedPausedGoalThreadIds);
    const continuedThreads = await startRecoveryTurns(request);
    settleClaimedCapacityRecoveryEntries(request);
    // The recovery request above owns its captured recent threads. Once the
    // transactional switch commits, a previous exhaustion batch must not
    // prompt the scheduler to repeat the same switch.
    resetUsageLimitExhaustionObservation();
    if (request.routeSwitch && routeChanged) {
      // Codex clients refresh their model picker after account/updated. A
      // provider-only route switch does not make the real app-server emit
      // that notification, so publish the protocol notification at the same
      // commit point as the route change.
      writeOfficialLine(JSON.stringify({ method: "account/updated", params: {} }));
    }

    const result = {
      status: "switched",
      accountId: request.params.accountId,
      email: actualEmail,
      activeTurns: getActiveTurnCount(),
      interruptedTurns: request.interruptedTurnCount,
      continuedThreads
    };
    recordSwitchOperationSuccess(request.operationId, result);
    sendControlResult(request.socket, request.id, result);
  } catch (error) {
    let message = safeErrorMessage(error);
    if (request.routeSwitch && routeChanged) {
      try {
        if (request.previousGatewayRoute === "gateway") {
          activateGatewayAdapter();
        } else {
          activateChatGptGatewayRoute(request.previousGatewayAccessToken);
        }
      } catch (routeError) {
        message = `${message}; Gateway route restore failed: ${safeErrorMessage(routeError)}`;
      }
    } else if (request.gatewayFallback) {
      if (gatewayRouteActivated) {
        try {
          restoreGatewayRoute();
        } catch (routeError) {
          message = `${message}; Gateway route restore failed: ${safeErrorMessage(routeError)}`;
        }
      }
    }
    if (loginApplied) {
      try {
        await restorePreviousAccount(request);
      } catch (rollbackError) {
        message = `${message}; rollback failed: ${safeErrorMessage(rollbackError)}`;
      }
    }
    if (localAccountActivationAttempted) {
      try {
        if (request.params.previousLocalAccountId) {
          await sendControlRequest("account/activate", {
            localAccountId: request.params.previousLocalAccountId
          });
        } else {
          await sendControlRequest("account/restore-unmanaged", {
            rollbackContextId: request.params.rollbackContextId
          });
        }
      } catch (rollbackError) {
        message = `${message}; local account rollback failed: ${safeErrorMessage(rollbackError)}`;
      }
    }
    try {
      await resumePausedGoals(request);
    } catch (resumeError) {
      message = `${message}; goal resume failed: ${safeErrorMessage(resumeError)}`;
    }
    restoreClaimedCapacityRecoveryEntries(request);
    recordSwitchOperationFailure(request.operationId, message);
    sendControlError(request.socket, request.id, message);
  } finally {
    if (activeSwitchRequest === request) {
      activeSwitchRequest = undefined;
    }
    switching = false;
    flushDeferredOfficialLines();
  }
}

async function prepareGoalsForSwitch(request) {
  try {
    const threadIds = new Set([
      ...getActiveThreadIds(),
      ...request.recentUsageLimitedThreadIds,
      ...request.capacityRecoveryEntries.keys()
    ]);
    for (const threadId of threadIds) {
      if (request.canceled) {
        return;
      }
      const goalResult = await sendInternalRequest("thread/goal/get", { threadId });
      if (request.canceled) {
        return;
      }
      const goal = readGoal(goalResult);
      if (!goal || goal.status !== "active") {
        if (request.capacityRecoveryEntries.has(threadId)) {
          if (goal?.status === "usageLimited") {
            request.capacityRecoveryGoalThreadIds.add(threadId);
            request.capacityAddedRecoveryThreadIds.delete(threadId);
            request.recoveryThreadIds.delete(threadId);
          } else {
            addCapacityRecoveryToRequest(request, threadId);
          }
        }
        if (request.recentUsageLimitedThreadIds.has(threadId)) {
          if (goal?.status === "usageLimited") {
            request.recentUsageLimitedGoalThreadIds.add(threadId);
            request.recoveryThreadIds.delete(threadId);
          } else {
            request.recoveryThreadIds.add(threadId);
          }
        }
        continue;
      }
      const pauseResult = await sendInternalRequest("thread/goal/set", { threadId, status: "paused" });
      const pausedGoal = readGoal(pauseResult);
      if (!pausedGoal || pausedGoal.status !== "paused") {
        throw new Error("Codex did not pause an active goal before account switch");
      }
      request.pausedGoalThreadIds.add(threadId);
      if (request.capacityRecoveryEntries.has(threadId)) {
        request.capacityRecoveryGoalThreadIds.add(threadId);
        request.recoveryThreadIds.delete(threadId);
        request.capacityAddedRecoveryThreadIds.delete(threadId);
      }
      if (request.recentUsageLimitedThreadIds.has(threadId)) {
        request.recentUsageLimitedGoalThreadIds.add(threadId);
        request.recoveryThreadIds.delete(threadId);
      }
      if (request.canceled) {
        await recoverPausedGoals(request);
        return;
      }
    }
    if (!request.canceled && pendingSwitch === request) {
      request.goalsPrepared = true;
      armSwitchGraceTimer(request);
    }
  } catch (error) {
    request.canceled = true;
    if (pendingSwitch === request) {
      pendingSwitch = undefined;
    }
    let message = `Unable to pause active Codex goals: ${safeErrorMessage(error)}`;
    try {
      await recoverPausedGoals(request);
    } catch (resumeError) {
      message = `${message}; goal resume failed: ${safeErrorMessage(resumeError)}`;
    }
    restoreClaimedCapacityRecoveryEntries(request);
    recordSwitchOperationFailure(request.operationId, message);
    sendControlError(request.socket, request.id, message);
  }
}

function armSwitchGraceTimer(request) {
  if (request.graceTimer || getActiveTurnCount() === 0) {
    return;
  }
  request.graceTimer = setTimeout(() => {
    request.graceTimer = undefined;
    void handleSwitchGraceExpired(request);
  }, request.params.gracePeriodMs);
}

function clearSwitchGraceTimer(request) {
  if (request.graceTimer) {
    clearTimeout(request.graceTimer);
    request.graceTimer = undefined;
  }
}

async function handleSwitchGraceExpired(request) {
  if (pendingSwitch !== request || request.canceled || request.interrupting) {
    return;
  }
  request.graceExpired = true;
  if (getActiveTurnCount() === 0) {
    await drainPendingSwitch();
    return;
  }

  if (submittedTurnStarts.size > 0 || anonymousActiveTurnCount > 0) {
    await deferPendingSwitch(request, "uninterruptibleTurns");
    return;
  }

  const activeEntries = [...activeTurns.entries()];
  if (activeEntries.some(([, threadId]) => typeof threadId !== "string" || threadId.length === 0)) {
    await deferPendingSwitch(request, "uninterruptibleTurns");
    return;
  }
  const ordinaryEntries = activeEntries.filter(([, threadId]) => !request.pausedGoalThreadIds.has(threadId));
  if (ordinaryEntries.length > 0 && request.params.longTurnPolicy === "defer") {
    await deferPendingSwitch(request, "activeOrdinaryTurns");
    return;
  }

  request.interrupting = true;
  let interruptFailed = false;
  await Promise.all(
    activeEntries.map(async ([turnId, threadId]) => {
      if (await interruptActiveTurn(request, turnId, threadId)) {
        interruptFailed = true;
      }
    })
  );
  request.interrupting = false;

  if (interruptFailed) {
    await deferPendingSwitch(request, "interruptFailed");
    return;
  }
  await drainPendingSwitch();
}

async function interruptActiveTurn(request, initialTurnId, threadId) {
  let turnId = initialTurnId;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    request.interruptedTurnIds.add(turnId);
    try {
      await sendInternalRequest("turn/interrupt", { threadId, turnId });
      return false;
    } catch (error) {
      request.interruptedTurnIds.delete(turnId);
      const replacementTurnId = attempt === 0 ? readReplacementActiveTurnId(error) : undefined;
      if (replacementTurnId && replacementTurnId !== turnId) {
        activeTurns.delete(turnId);
        rememberActiveTurn(replacementTurnId, threadId);
        turnId = replacementTurnId;
        continue;
      }
      if (isAlreadyInactiveTurnError(error)) {
        activeTurns.delete(turnId);
        rememberTerminalTurnId(turnId);
        return false;
      }
      safeLog(`failed to interrupt turn before account switch: ${safeErrorMessage(error)}`);
      return true;
    }
  }
  return false;
}

async function deferPendingSwitch(request, reason) {
  if (pendingSwitch !== request) {
    return;
  }
  pendingSwitch = undefined;
  request.canceled = true;
  clearSwitchGraceTimer(request);
  try {
    await recoverPausedGoals(request);
    restoreClaimedCapacityRecoveryEntries(request);
    const result = {
      status: "deferred",
      reason,
      activeTurns: getActiveTurnCount()
    };
    recordSwitchOperationSuccess(request.operationId, result);
    sendControlResult(request.socket, request.id, result);
  } catch (error) {
    restoreClaimedCapacityRecoveryEntries(request);
    const message = `Account switch was deferred and a paused goal could not be resumed: ${safeErrorMessage(error)}`;
    recordSwitchOperationFailure(request.operationId, message);
    sendControlError(request.socket, request.id, message);
  }
}

async function startRecoveryTurns(request) {
  let continuedThreads = 0;
  for (const threadId of request.recoveryThreadIds) {
    const capacityEntry = request.capacityRecoveryEntries.get(threadId);
    try {
      if (await isSubagentThread(threadId)) {
        if (capacityEntry) {
          settleClaimedCapacityRecoveryEntry(request, threadId, capacityEntry);
        }
        continue;
      }
      const result = await startRecoveryTurn(threadId, {
        workGeneration: capacityEntry?.workGeneration,
        capacityEntry
      });
      if (request.recentUsageLimitedThreadIds.has(threadId)) {
        recoveredUsageLimitedThreads += 1;
      }
      clearRecentUsageLimitedThread(threadId);
      if (capacityEntry) {
        settleClaimedCapacityRecoveryEntry(request, threadId, capacityEntry);
      }
      continuedThreads += 1;
    } catch (error) {
      if (capacityEntry && request.capacityRecoveryEntries.get(threadId) === capacityEntry) {
        // A capacity rejection is re-queued by observeRecoveryTurnFailure.
        // Other failures must not leave a claimed entry without a timer.
        clearCapacityRecoveryThread(threadId, { generation: capacityEntry.generation, force: true });
        removeCapacityRecoveryFromRequest(request, threadId);
      }
      safeLog(`failed to start a switched thread continuation: ${safeErrorMessage(error)}`);
    }
  }
  return continuedThreads;
}

async function startRecoveryTurn(threadId, options = {}) {
  const result = await sendInternalRequest(
    "turn/start",
    {
      threadId,
      input: [{ type: "text", text: "Continue.", text_elements: [] }],
      responsesapiClientMetadata: {
        codex_account_manager_recovery: "true"
      },
      additionalContext: {
        [RECOVERY_CONTEXT_KEY]: {
          kind: "application",
          value:
            "This is a one-shot continuation after the previous turn was interrupted for an account switch or stopped by quota exhaustion immediately before an emergency switch. First inspect the thread history, current workspace state, and completed tool results. Continue only unfinished work and do not repeat non-idempotent actions that already succeeded."
        }
      }
    },
    {
      recoveryTurn: true,
      threadId,
      workGeneration: options.workGeneration
    }
  );
  const turnId = readTurnId(result);
  if (turnId) {
    rememberActiveTurn(turnId, threadId, options.workGeneration);
  }
  return result;
}

async function isSubagentThread(threadId) {
  try {
    const result = await sendInternalRequest("thread/read", { threadId, includeTurns: false });
    const thread = readThread(result);
    if (!thread) {
      return false;
    }
    return (
      (typeof thread.parentThreadId === "string" && thread.parentThreadId.length > 0) ||
      isSubagentThreadSource(thread.source)
    );
  } catch {
    return false;
  }
}

async function resumePausedGoals(request) {
  const resumedThreadIds = new Set();
  for (const threadId of [...request.pausedGoalThreadIds]) {
    const resumeResult = await sendInternalRequest("thread/goal/set", { threadId, status: "active" });
    const resumedGoal = readGoal(resumeResult);
    if (!resumedGoal || resumedGoal.status !== "active") {
      throw new Error("Codex did not resume a goal after account switch");
    }
    request.pausedGoalThreadIds.delete(threadId);
    if (request.capacityRecoveryGoalThreadIds.has(threadId)) {
      settleClaimedCapacityRecoveryEntry(request, threadId, request.capacityRecoveryEntries.get(threadId));
      request.capacityRecoveryGoalThreadIds.delete(threadId);
    }
    resumedThreadIds.add(threadId);
  }
  return resumedThreadIds;
}

async function resumeRecentUsageLimitedGoals(request, resumedPausedGoalThreadIds) {
  for (const threadId of request.recentUsageLimitedGoalThreadIds) {
    if (!resumedPausedGoalThreadIds.has(threadId)) {
      const resumeResult = await sendInternalRequest("thread/goal/set", { threadId, status: "active" });
      const resumedGoal = readGoal(resumeResult);
      if (!resumedGoal || resumedGoal.status !== "active") {
        throw new Error("Codex did not reactivate a usage-limited goal after account switch");
      }
    }
    resumedUsageLimitedGoals += 1;
    if (request.capacityRecoveryGoalThreadIds.has(threadId)) {
      settleClaimedCapacityRecoveryEntry(request, threadId, request.capacityRecoveryEntries.get(threadId));
      request.capacityRecoveryGoalThreadIds.delete(threadId);
    }
    clearRecentUsageLimitedThread(threadId);
  }
}

function recoverPausedGoals(request) {
  goalRecoveryCount += 1;
  const previousRecovery = request.recoveryPromise || Promise.resolve();
  const recovery = previousRecovery
    .catch(() => undefined)
    .then(() => resumePausedGoals(request))
    .finally(() => {
      goalRecoveryCount = Math.max(0, goalRecoveryCount - 1);
      flushDeferredOfficialLines();
    });
  request.recoveryPromise = recovery;
  return recovery;
}

async function restorePreviousAccount(request) {
  const snapshotRollback = typeof request.params.previousAccessToken === "string";
  const credentials = snapshotRollback
    ? {
        accessToken: request.params.previousAccessToken,
        chatgptAccountId: request.params.previousAccountId,
        chatgptPlanType: request.params.previousPlanType || null
      }
    : await sendControlRequest("auth/refresh", {
        previousAccountId: request.params.previousAccountId,
        localAccountId: request.params.previousLocalAccountId,
        expectedEmail: request.params.previousExpectedEmail
      });
  if (!isValidRefreshResult(credentials) || credentials.chatgptAccountId !== request.params.previousAccountId) {
    throw new Error("The account manager returned invalid rollback credentials");
  }
  await sendChatGptLogin({
    type: "chatgptAuthTokens",
    accessToken: credentials.accessToken,
    chatgptAccountId: credentials.chatgptAccountId,
    chatgptPlanType: credentials.chatgptPlanType
  });
  await waitForChatGptAccountIdentity(
    request.params.previousExpectedEmail,
    "The app-server reported a different account after hot-switch rollback"
  );
  if (
    request.previousGatewayRoute === "chatgpt" &&
    gatewayConfig &&
    gatewayConfig.autoFallbackToChatGpt !== true
  ) {
    activateChatGptGatewayRoute(credentials.accessToken);
  }
  externalAuthActive = true;
  activeManagedAccount = snapshotRollback
    ? undefined
    : {
        accountId: request.params.previousAccountId,
        localAccountId: request.params.previousLocalAccountId,
        expectedEmail: request.params.previousExpectedEmail
      };
  usageAttributionAccount = activeManagedAccount;
  usageAttributionFailureReason = activeManagedAccount ? undefined : "not_activated";
  runtimeOAuthIdentity = {
    accountId: request.params.previousAccountId,
    localAccountId: request.params.previousLocalAccountId,
    expectedEmail: request.params.previousExpectedEmail,
    planType: request.params.previousPlanType || null
  };
}

async function waitForChatGptAccountIdentity(expectedEmail, mismatchMessage) {
  const normalizedExpectedEmail = normalizeEmail(expectedEmail);
  const deadline = Date.now() + ACCOUNT_IDENTITY_SETTLE_TIMEOUT_MS;
  let lastReadError;
  let lastActualEmail;

  while (Date.now() <= deadline) {
    try {
      const accountResult = await sendInternalRequest("account/read", { refreshToken: false });
      const account = accountResult && typeof accountResult.account === "object" ? accountResult.account : null;
      if (accountResult && accountResult.requiresOpenaiAuth === false) {
        // Manual Gateway mode intentionally disables OpenAI auth on the child
        // provider, so account/read has no account object. The login completion
        // event awaited by sendChatGptLogin is the authoritative commit signal.
        return expectedEmail;
      }
      const actualEmail = account && account.type === "chatgpt" && typeof account.email === "string" ? account.email : null;
      lastActualEmail = actualEmail;
      if (actualEmail && normalizeEmail(actualEmail) === normalizedExpectedEmail) {
        return actualEmail;
      }
    } catch (error) {
      lastReadError = safeErrorMessage(error);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(ACCOUNT_IDENTITY_POLL_INTERVAL_MS, remaining)));
  }

  if (lastReadError && !lastActualEmail) {
    throw new Error(`${mismatchMessage}: ${lastReadError}`);
  }
  throw new Error(mismatchMessage);
}

async function handleAuthRefreshRequest(message) {
  try {
    const previousAccountId = message.params && message.params.previousAccountId;
    const activeIdentity =
      activeManagedAccount && (!previousAccountId || activeManagedAccount.accountId === previousAccountId)
        ? activeManagedAccount
        : undefined;
    const result = await sendControlRequest("auth/refresh", {
      previousAccountId,
      localAccountId: activeIdentity && activeIdentity.localAccountId,
      expectedEmail: activeIdentity && activeIdentity.expectedEmail
    });
    if (!isValidRefreshResult(result)) {
      throw new Error("The account manager returned invalid refreshed credentials");
    }
    if (previousAccountId && result.chatgptAccountId !== previousAccountId) {
      throw new Error("The account manager refreshed a different ChatGPT workspace");
    }
    writeChildMessage({ id: message.id, result });
  } catch (error) {
    writeChildMessage({
      id: message.id,
      error: {
        code: -32001,
        message: safeErrorMessage(error)
      }
    });
  }
}

function sendInternalRequest(method, params, options = {}) {
  const id = `${INTERNAL_ID_PREFIX}:${++internalSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingInternalRequests.delete(requestIdKey(id));
      reject(new Error(`${method} timed out`));
    }, INTERNAL_REQUEST_TIMEOUT_MS);
    pendingInternalRequests.set(requestIdKey(id), { resolve, reject, timer, ...options });
    writeChildMessage({ id, method, params });
  });
}

function sendChatGptLogin(params) {
  const completion = waitForLoginCompletion();
  const response = sendInternalRequest("account/login/start", params);
  return Promise.all([response, completion]).then(
    ([result]) => result,
    (error) => {
      cancelLoginCompletion(error);
      throw error;
    }
  );
}

function waitForLoginCompletion() {
  if (pendingLoginCompletion) {
    return Promise.reject(new Error("Another ChatGPT login is already pending"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingLoginCompletion = undefined;
      reject(new Error("account/login/completed timed out"));
    }, ACCOUNT_LOGIN_COMPLETION_TIMEOUT_MS);
    pendingLoginCompletion = { resolve, reject, timer };
  });
}

function settleLoginCompletion(params) {
  const pending = pendingLoginCompletion;
  if (!pending) {
    return;
  }
  pendingLoginCompletion = undefined;
  clearTimeout(pending.timer);
  if (params && params.success === false) {
    const error = params.error;
    const message = error && typeof error.message === "string" ? error.message : "ChatGPT login failed";
    pending.reject(new Error(message));
    return;
  }
  pending.resolve();
}

function cancelLoginCompletion(cause) {
  const pending = pendingLoginCompletion;
  if (!pending) {
    return;
  }
  pendingLoginCompletion = undefined;
  clearTimeout(pending.timer);
  pending.reject(cause instanceof Error ? cause : new Error(String(cause || "ChatGPT login failed")));
}

function sendControlRequest(method, params) {
  const socket = latestControlSocket;
  if (!socket || socket.destroyed) {
    return Promise.reject(new Error("The account manager is not connected"));
  }

  const id = `${INTERNAL_ID_PREFIX}:control:${++controlSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingControlRequests.delete(requestIdKey(id));
      reject(new Error(`${method} timed out`));
    }, REFRESH_REQUEST_TIMEOUT_MS);
    pendingControlRequests.set(requestIdKey(id), { resolve, reject, timer });
    writeSocketMessage(socket, { id, method, params });
  });
}

function isSwitchBarrierActive() {
  return Boolean(pendingSwitch) || switching || goalPreparationCount > 0 || goalRecoveryCount > 0;
}

function flushDeferredOfficialLines() {
  if (isSwitchBarrierActive()) {
    return;
  }
  while (deferredOfficialLines.length > 0) {
    const line = deferredOfficialLines.shift();
    if (line !== undefined) {
      handleOfficialLine(line);
    }
  }
}

function runtimeStatus() {
  maybeFinalizeUsageLimitExhaustionBatch();
  const gatewayRoute = gatewayAdapter?.route;
  return {
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    ready: childReady && !childExited,
    initializeResponseReceived,
    initializedNotificationReceived,
    activeTurns: getActiveTurnCount(),
    pendingSwitch: Boolean(pendingSwitch),
    switching: switching || goalRecoveryCount > 0,
    httpTransportForced: forceHttpTransport,
    transportMode: forceHttpTransport ? "http" : "default",
    providerKind:
      gatewayConfig && gatewayRoute === "gateway" ? "gateway" : forceHttpTransport ? "chatgpt" : "default",
    gatewayActive: gatewayRoute === "gateway",
    gatewayConfigured: Boolean(gatewayConfig),
    gatewayAutoFallbackEnabled: Boolean(gatewayConfig?.autoFallbackToChatGpt),
    gatewayBaseUrl: gatewayConfig?.baseUrl,
    gatewayModel: gatewayConfig?.model,
    usageLimitObservationEnabled,
    capacityRecoveryThreads: capacityRecoveryThreads.size,
    capacityRecoveryWaitingThreads: countCapacityRecoveryWaitingThreads(),
    recentUsageLimitedThreads: getRecentUsageLimitedThreadIds().size,
    usageLimitExhaustionReady: usageLimitExhaustionBatch?.ready === true,
    usageLimitExhaustionBatchId: usageLimitExhaustionBatch?.ready === true ? usageLimitExhaustionBatch.id : 0,
    observedUsageLimitFailures,
    recoveredUsageLimitedThreads,
    resumedUsageLimitedGoals,
    attributionActive: Boolean(usageAttributionAccount?.localAccountId),
    attributionFailureReason: usageAttributionFailureReason || null,
    shimPid: process.pid,
    appServerPid: child?.pid || null
  };
}

function getSwitchOperationStatus(operationId) {
  pruneSwitchOperations();
  const operation = recentSwitchOperations.get(operationId);
  if (!operation) {
    return { operationId, state: "unknown" };
  }
  if (operation.state === "succeeded") {
    return { operationId, state: "succeeded", result: operation.result };
  }
  if (operation.state === "failed") {
    return { operationId, state: "failed", message: operation.message };
  }
  return { operationId, state: operation.state };
}

function recordSwitchOperationPending(operationId) {
  recordSwitchOperation(operationId, { state: "pending" });
}

function recordSwitchOperationSwitching(operationId) {
  recordSwitchOperation(operationId, { state: "switching" });
}

function recordSwitchOperationSuccess(operationId, result) {
  recordSwitchOperation(operationId, { state: "succeeded", result });
}

function recordSwitchOperationFailure(operationId, message) {
  recordSwitchOperation(operationId, { state: "failed", message });
}

function recordSwitchOperation(operationId, record) {
  if (!isValidSwitchOperationId(operationId)) {
    return;
  }
  pruneSwitchOperations();
  recentSwitchOperations.delete(operationId);
  recentSwitchOperations.set(operationId, { ...record, updatedAt: Date.now() });
  while (recentSwitchOperations.size > MAX_RECENT_SWITCH_OPERATIONS) {
    const oldestOperationId = recentSwitchOperations.keys().next().value;
    if (oldestOperationId === undefined) {
      return;
    }
    recentSwitchOperations.delete(oldestOperationId);
  }
}

function pruneSwitchOperations() {
  const cutoff = Date.now() - SWITCH_OPERATION_TTL_MS;
  for (const [operationId, operation] of recentSwitchOperations) {
    if (operation.updatedAt < cutoff) {
      recentSwitchOperations.delete(operationId);
    }
  }
}

async function readRuntimeIdentity() {
  const accountResult = await sendInternalRequest("account/read", { refreshToken: false });
  const account = accountResult && typeof accountResult.account === "object" ? accountResult.account : null;
  const hiddenAuthIdentity =
    !account &&
    accountResult &&
    accountResult.requiresOpenaiAuth === false &&
    gatewayAdapter?.route === "chatgpt" &&
    runtimeOAuthIdentity;
  return {
    accountType:
      account && typeof account.type === "string" ? account.type : hiddenAuthIdentity ? "chatgpt" : null,
    email:
      account && typeof account.email === "string"
        ? account.email
        : hiddenAuthIdentity
          ? hiddenAuthIdentity.expectedEmail
          : null,
    planType:
      account && typeof account.planType === "string"
        ? account.planType
        : hiddenAuthIdentity && typeof hiddenAuthIdentity.planType === "string"
          ? hiddenAuthIdentity.planType
          : null,
    externalAuthActive,
    managedAccountId: activeManagedAccount?.accountId || hiddenAuthIdentity?.accountId || null,
    managedLocalAccountId: activeManagedAccount?.localAccountId || hiddenAuthIdentity?.localAccountId || null,
    httpTransportForced: forceHttpTransport
  };
}

async function activateUsageAttribution(params) {
  try {
    if (!isValidUsageAttributionParams(params)) {
      throw new Error("Invalid usage attribution parameters");
    }

    if (activeManagedAccount && activeManagedAccount.accountId !== params.accountId) {
      throw new Error("The requested usage attribution account differs from the active managed account");
    }

    const accountResult = await sendInternalRequest("account/read", { refreshToken: false });
    const account = accountResult && typeof accountResult.account === "object" ? accountResult.account : null;
    const actualEmail =
      account && account.type === "chatgpt" && typeof account.email === "string" ? account.email : null;
    if (
      !actualEmail &&
      accountResult?.requiresOpenaiAuth === false &&
      activeManagedAccount &&
      activeManagedAccount.accountId === params.accountId &&
      normalizeEmail(activeManagedAccount.expectedEmail) === normalizeEmail(params.expectedEmail)
    ) {
      usageAttributionAccount = {
        accountId: params.accountId,
        localAccountId: params.localAccountId,
        expectedEmail: params.expectedEmail
      };
      usageAttributionFailureReason = undefined;
      recordActiveUsageAttribution();
      return { active: true, localAccountId: usageAttributionAccount.localAccountId };
    }
    if (!actualEmail || normalizeEmail(actualEmail) !== normalizeEmail(params.expectedEmail)) {
      throw new Error("The app-server reported a different account for usage attribution");
    }

    usageAttributionAccount = {
      accountId: params.accountId,
      localAccountId: params.localAccountId,
      expectedEmail: params.expectedEmail
    };
    usageAttributionFailureReason = undefined;
    recordActiveUsageAttribution();
    return { active: true, localAccountId: usageAttributionAccount.localAccountId };
  } catch (error) {
    usageAttributionAccount = undefined;
    usageAttributionFailureReason = safeErrorMessage(error).slice(0, 512) || "Usage attribution activation failed";
    throw error;
  }
}

function sendControlResult(socket, id, result) {
  writeSocketMessage(socket, { id, result });
}

function sendControlError(socket, id, message) {
  writeSocketMessage(socket, {
    id,
    error: {
      code: -32000,
      message
    }
  });
}

function writeSocketMessage(socket, message) {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify(message)}\n`);
  }
}

function writeChildMessage(message) {
  writeChildLine(JSON.stringify(message));
}

function writeChildLine(line) {
  if (!child.stdin.destroyed) {
    child.stdin.write(`${line}\n`);
  }
}

function writeOfficialLine(line) {
  process.stdout.write(`${line}\n`);
}

function consumeLines(stream, onLine, onEnd) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        onLine(line);
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    const finalLine = buffer.replace(/\r$/u, "");
    if (finalLine.length > 0) {
      onLine(finalLine);
    }
    onEnd && onEnd();
  });
}

function closeControlServer() {
  for (const socket of controlSockets) {
    socket.destroy();
  }
  controlSockets.clear();
  if (controlServer) {
    controlServer.close();
  }
  if (socketPath && process.platform !== "win32") {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // The socket may already have been removed by the host.
    }
  }
}

function rejectPendingRequests(error) {
  cancelLoginCompletion(error);
  for (const pending of pendingInternalRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  pendingInternalRequests.clear();
  for (const pending of pendingControlRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  pendingControlRequests.clear();
  if (pendingSwitch) {
    clearSwitchGraceTimer(pendingSwitch);
    const message = safeErrorMessage(error);
    recordSwitchOperationFailure(pendingSwitch.operationId, message);
    sendControlError(pendingSwitch.socket, pendingSwitch.id, message);
    pendingSwitch = undefined;
  }
}

function getControlSocketPath(extensionHostPid) {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\codex-accounts-manager-${extensionHostPid}`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `codex-accounts-manager-${uid}`, `${extensionHostPid}.sock`);
}

function isValidSwitchParams(params) {
  const managedRollback =
    typeof params?.previousLocalAccountId === "string" &&
    params.previousLocalAccountId.length > 0 &&
    params.previousAccessToken === undefined &&
    params.rollbackContextId === undefined;
  const snapshotRollback =
    (params?.previousLocalAccountId === undefined || params.previousLocalAccountId === null) &&
    typeof params?.previousAccessToken === "string" &&
    params.previousAccessToken.length > 0 &&
    typeof params.rollbackContextId === "string" &&
    params.rollbackContextId.length > 0;
  return Boolean(
    params &&
    typeof params.accessToken === "string" &&
    params.accessToken.length > 0 &&
    typeof params.accountId === "string" &&
    params.accountId.length > 0 &&
    typeof params.localAccountId === "string" &&
    params.localAccountId.length > 0 &&
    typeof params.previousAccountId === "string" &&
    params.previousAccountId.length > 0 &&
    (managedRollback || snapshotRollback) &&
    typeof params.previousExpectedEmail === "string" &&
    params.previousExpectedEmail.length > 0 &&
    (params.previousPlanType === undefined ||
      params.previousPlanType === null ||
      typeof params.previousPlanType === "string") &&
    typeof params.expectedEmail === "string" &&
    params.expectedEmail.length > 0 &&
    (params.planType === undefined || params.planType === null || typeof params.planType === "string") &&
    Number.isInteger(params.gracePeriodMs) &&
    params.gracePeriodMs >= 0 &&
    params.gracePeriodMs <= 300_000 &&
    (params.recoverRecentUsageLimitedTurns === undefined ||
      typeof params.recoverRecentUsageLimitedTurns === "boolean") &&
    (params.operationId === undefined || isValidSwitchOperationId(params.operationId)) &&
    (params.longTurnPolicy === "defer" ||
      params.longTurnPolicy === "interrupt" ||
      params.longTurnPolicy === "interruptAndContinue")
  );
}

function isValidGatewayFallbackParams(params) {
  const managedRollback =
    typeof params?.previousLocalAccountId === "string" &&
    params.previousLocalAccountId.length > 0 &&
    params.previousAccessToken === undefined &&
    params.rollbackContextId === undefined;
  const snapshotRollback =
    (params?.previousLocalAccountId === undefined || params.previousLocalAccountId === null) &&
    typeof params?.previousAccessToken === "string" &&
    params.previousAccessToken.length > 0 &&
    typeof params.rollbackContextId === "string" &&
    params.rollbackContextId.length > 0;
  return Boolean(
    params &&
    typeof params.accessToken === "string" &&
    params.accessToken.length > 0 &&
    typeof params.accountId === "string" &&
    params.accountId.length > 0 &&
    typeof params.localAccountId === "string" &&
    params.localAccountId.length > 0 &&
    typeof params.previousAccountId === "string" &&
    params.previousAccountId.length > 0 &&
    (managedRollback || snapshotRollback) &&
    typeof params.previousExpectedEmail === "string" &&
    params.previousExpectedEmail.length > 0 &&
    typeof params.expectedEmail === "string" &&
    params.expectedEmail.length > 0 &&
    (params.planType === undefined || params.planType === null || typeof params.planType === "string") &&
    Number.isInteger(params.gracePeriodMs) &&
    params.gracePeriodMs >= 0 &&
    params.gracePeriodMs <= 300_000 &&
    (params.operationId === undefined || isValidSwitchOperationId(params.operationId)) &&
    (params.longTurnPolicy === "defer" ||
      params.longTurnPolicy === "interrupt" ||
      params.longTurnPolicy === "interruptAndContinue")
  );
}

function isValidGatewayRouteParams(params) {
  return Boolean(
    params &&
    (params.route === "gateway" || params.route === "chatgpt") &&
    (params.accountId === undefined ||
      (typeof params.accountId === "string" && params.accountId.length > 0 && params.accountId.length <= 256)) &&
    (params.chatgptAccessToken === undefined ||
      (typeof params.chatgptAccessToken === "string" &&
        params.chatgptAccessToken.length > 0 &&
        params.chatgptAccessToken.length <= 16_384)) &&
    (params.chatgptAccountId === undefined ||
      (typeof params.chatgptAccountId === "string" &&
        params.chatgptAccountId.length > 0 &&
        params.chatgptAccountId.length <= 256)) &&
    (params.chatgptLocalAccountId === undefined ||
      (typeof params.chatgptLocalAccountId === "string" &&
        params.chatgptLocalAccountId.length > 0 &&
        params.chatgptLocalAccountId.length <= 256)) &&
    (params.chatgptExpectedEmail === undefined ||
      (typeof params.chatgptExpectedEmail === "string" &&
        params.chatgptExpectedEmail.length > 0 &&
        params.chatgptExpectedEmail.length <= 320)) &&
    (params.chatgptPlanType === undefined ||
      params.chatgptPlanType === null ||
      (typeof params.chatgptPlanType === "string" && params.chatgptPlanType.length <= 128)) &&
    Number.isInteger(params.gracePeriodMs) &&
    params.gracePeriodMs >= 0 &&
    params.gracePeriodMs <= 300_000 &&
    (params.operationId === undefined || isValidSwitchOperationId(params.operationId)) &&
    (params.longTurnPolicy === "defer" ||
      params.longTurnPolicy === "interrupt" ||
      params.longTurnPolicy === "interruptAndContinue")
  );
}

function readSwitchOperationId(params) {
  return isValidSwitchOperationId(params?.operationId) ? params.operationId : undefined;
}

function isValidSwitchOperationId(operationId) {
  return (
    typeof operationId === "string" &&
    operationId.length > 0 &&
    operationId.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(operationId)
  );
}

function isValidRefreshResult(result) {
  return Boolean(
    result &&
    typeof result.accessToken === "string" &&
    result.accessToken.length > 0 &&
    typeof result.chatgptAccountId === "string" &&
    result.chatgptAccountId.length > 0 &&
    (result.chatgptPlanType === null || typeof result.chatgptPlanType === "string")
  );
}

function isValidUsageAttributionParams(params) {
  return Boolean(
    params &&
    typeof params === "object" &&
    typeof params.localAccountId === "string" &&
    params.localAccountId.length > 0 &&
    params.localAccountId.length <= 256 &&
    typeof params.accountId === "string" &&
    params.accountId.length > 0 &&
    params.accountId.length <= 256 &&
    typeof params.expectedEmail === "string" &&
    params.expectedEmail.length > 0 &&
    params.expectedEmail.length <= 320
  );
}

function requestIdKey(id) {
  return `${typeof id}:${String(id)}`;
}

function isWorkStartMethod(method) {
  return method === "turn/start" || method === "review/start" || method === "thread/compact/start";
}

function isGoalMutationMethod(method) {
  return method === "thread/goal/set" || method === "thread/goal/clear";
}

function getActiveTurnCount() {
  return submittedTurnStarts.size + activeTurns.size + anonymousActiveTurnCount;
}

function getActiveThreadIds() {
  const threadIds = new Set();
  for (const threadId of [...submittedTurnStarts.values(), ...activeTurns.values()]) {
    if (typeof threadId === "string" && threadId.length > 0) {
      threadIds.add(threadId);
    }
  }
  return threadIds;
}

function recordActiveUsageAttribution() {
  for (const threadId of getActiveThreadIds()) {
    recordUsageAttribution(threadId);
  }
}

function rememberActiveTurn(turnId, threadId, workGeneration) {
  if (typeof threadId === "string" && threadId.length > 0) {
    for (const [knownTurnId, knownThreadId] of activeTurns) {
      if (knownTurnId !== turnId && knownThreadId === threadId) {
        activeTurns.delete(knownTurnId);
      }
    }
  }
  rememberTurnWorkGeneration(turnId, threadId, workGeneration);
  activeTurns.set(turnId, threadId);
  recordUsageAttribution(threadId);
}

function recordUsageAttribution(threadId) {
  if (!usageAttributionDirectory || typeof threadId !== "string" || threadId.length === 0 || threadId.length > 256) {
    return;
  }
  const localAccountId = usageAttributionAccount?.localAccountId;
  if (typeof localAccountId !== "string" || localAccountId.length === 0 || localAccountId.length > 256) {
    return;
  }
  if (lastUsageAttributionByThread.get(threadId) === localAccountId) {
    return;
  }

  lastUsageAttributionByThread.delete(threadId);
  lastUsageAttributionByThread.set(threadId, localAccountId);
  while (lastUsageAttributionByThread.size > MAX_USAGE_ATTRIBUTION_THREADS) {
    const oldestThreadId = lastUsageAttributionByThread.keys().next().value;
    if (oldestThreadId === undefined) {
      break;
    }
    lastUsageAttributionByThread.delete(oldestThreadId);
  }

  pendingUsageAttributionRecords.push({ v: 1, t: Date.now(), th: threadId, a: localAccountId });
  if (pendingUsageAttributionRecords.length >= MAX_USAGE_ATTRIBUTION_BATCH_SIZE) {
    flushUsageAttributionRecords();
    return;
  }
  if (!usageAttributionFlushTimer) {
    usageAttributionFlushTimer = setTimeout(() => {
      usageAttributionFlushTimer = undefined;
      flushUsageAttributionRecords();
    }, USAGE_ATTRIBUTION_FLUSH_DELAY_MS);
    usageAttributionFlushTimer.unref?.();
  }
}

function flushUsageAttributionRecords() {
  if (usageAttributionFlushTimer) {
    clearTimeout(usageAttributionFlushTimer);
    usageAttributionFlushTimer = undefined;
  }
  if (!usageAttributionDirectory || pendingUsageAttributionRecords.length === 0) {
    return;
  }

  const records = pendingUsageAttributionRecords;
  pendingUsageAttributionRecords = [];
  try {
    fs.mkdirSync(usageAttributionDirectory, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(usageAttributionDirectory, 0o700);
    } catch {
      // Best effort on filesystems that do not expose POSIX modes.
    }
    const journalPath = path.join(usageAttributionDirectory, `${process.pid}.jsonl`);
    fs.appendFileSync(journalPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    try {
      fs.chmodSync(journalPath, 0o600);
    } catch {
      // Best effort on filesystems that do not expose POSIX modes.
    }
    usageAttributionWriteFailureReported = false;
  } catch (error) {
    if (!usageAttributionWriteFailureReported) {
      usageAttributionWriteFailureReported = true;
      safeLog(`unable to persist usage attribution: ${safeErrorMessage(error)}`);
    }
  }
}

function readCapacityRecoveryDelayMs() {
  const configured = Number(process.env.CODEX_ACCOUNTS_CAPACITY_RECOVERY_DELAY_MS);
  if (Number.isInteger(configured) && configured > 0 && configured <= 6 * 60 * 60 * 1000) {
    return configured;
  }
  return CAPACITY_RECOVERY_MIN_DELAY_MS + Math.floor(Math.random() * (CAPACITY_RECOVERY_MAX_DELAY_MS - CAPACITY_RECOVERY_MIN_DELAY_MS + 1));
}

function advanceWorkGeneration(threadId) {
  if (typeof threadId !== "string" || threadId.length === 0) {
    return undefined;
  }
  const generation = (latestWorkGenerations.get(threadId) || 0) + 1;
  latestWorkGenerations.delete(threadId);
  latestWorkGenerations.set(threadId, generation);
  while (latestWorkGenerations.size > MAX_CAPACITY_RECOVERY_THREADS) {
    const oldestThreadId = latestWorkGenerations.keys().next().value;
    if (oldestThreadId === undefined) {
      break;
    }
    latestWorkGenerations.delete(oldestThreadId);
  }
  return generation;
}

function ensureWorkGeneration(threadId) {
  if (typeof threadId !== "string" || threadId.length === 0) {
    return undefined;
  }
  return latestWorkGenerations.get(threadId) ?? advanceWorkGeneration(threadId);
}

function readWorkGeneration(threadId, turnId) {
  if (typeof turnId === "string" && turnWorkGenerations.has(turnId)) {
    return turnWorkGenerations.get(turnId);
  }
  if (typeof threadId !== "string" || threadId.length === 0) {
    return undefined;
  }
  return latestWorkGenerations.get(threadId);
}

function rememberTurnWorkGeneration(turnId, threadId, workGeneration) {
  const generation = workGeneration ?? latestWorkGenerations.get(threadId);
  if (typeof turnId !== "string" || typeof generation !== "number") {
    return;
  }
  turnWorkGenerations.delete(turnId);
  turnWorkGenerations.set(turnId, generation);
  while (turnWorkGenerations.size > MAX_TERMINAL_TURN_IDS) {
    const oldestTurnId = turnWorkGenerations.keys().next().value;
    if (oldestTurnId === undefined) {
      break;
    }
    turnWorkGenerations.delete(oldestTurnId);
  }
}

function readNotificationTurnId(value) {
  return value && typeof value === "object" && typeof value.turnId === "string" ? value.turnId : undefined;
}

function countCapacityRecoveryWaitingThreads() {
  let count = 0;
  for (const entry of capacityRecoveryThreads.values()) {
    if (entry.state === "waiting") {
      count += 1;
    }
  }
  return count;
}

function claimCapacityRecoveryThreads(request) {
  // Gateway route changes deliberately do not consume ChatGPT recovery work.
  if (request.routeSwitch || request.gatewayFallback) {
    return;
  }
  for (const [threadId, entry] of capacityRecoveryThreads) {
    if (entry.state !== "waiting") {
      continue;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.state = "claimedBySwitch";
    request.capacityRecoveryEntries.set(threadId, entry);
    addCapacityRecoveryToRequest(request, threadId);
  }
}

function addCapacityRecoveryToRequest(request, threadId) {
  if (!request.capacityRecoveryEntries.has(threadId)) {
    return;
  }
  if (!request.recoveryThreadIds.has(threadId)) {
    request.capacityAddedRecoveryThreadIds.add(threadId);
  }
  request.recoveryThreadIds.add(threadId);
}

function removeCapacityRecoveryFromRequest(request, threadId, options = {}) {
  const entry = request.capacityRecoveryEntries.get(threadId);
  if (!options.keepEntry) {
    request.capacityRecoveryEntries.delete(threadId);
  }
  request.capacityRecoveryGoalThreadIds.delete(threadId);
  if (request.capacityAddedRecoveryThreadIds.delete(threadId)) {
    request.recoveryThreadIds.delete(threadId);
  }
  return entry;
}

function settleClaimedCapacityRecoveryEntry(request, threadId, entry) {
  if (!entry) {
    return;
  }
  if (capacityRecoveryThreads.get(threadId) === entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    capacityRecoveryThreads.delete(threadId);
  }
  removeCapacityRecoveryFromRequest(request, threadId);
}

function settleClaimedCapacityRecoveryEntries(request) {
  for (const [threadId, entry] of [...request.capacityRecoveryEntries]) {
    settleClaimedCapacityRecoveryEntry(request, threadId, entry);
  }
}

function restoreClaimedCapacityRecoveryEntries(request) {
  for (const [threadId, entry] of [...request.capacityRecoveryEntries]) {
    if (capacityRecoveryThreads.get(threadId) === entry && entry.state === "claimedBySwitch") {
      entry.state = "waiting";
      entry.retryAt = Math.max(entry.retryAt, Date.now());
      armCapacityRecoveryTimer(threadId, entry);
    }
    removeCapacityRecoveryFromRequest(request, threadId);
  }
}

function clearCapacityRecoveryThread(threadId, options = {}) {
  if (typeof threadId !== "string" || threadId.length === 0) {
    return;
  }
  const entry = capacityRecoveryThreads.get(threadId);
  if (!entry) {
    return;
  }
  if (!options.force) {
    if (options.workGeneration !== undefined && entry.workGeneration !== options.workGeneration) {
      return;
    }
    if (options.turnId) {
      if (!entry.sourceTurnId || entry.sourceTurnId !== options.turnId) {
        return;
      }
      // A terminal notification may follow the capacity error notification for
      // the same turn. Keep the original randomized deadline in that case.
      if (entry.state === "waiting") {
        return;
      }
    }
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  capacityRecoveryThreads.delete(threadId);
  for (const request of [pendingSwitch, activeSwitchRequest]) {
    if (request?.capacityRecoveryEntries.get(threadId) === entry) {
      removeCapacityRecoveryFromRequest(request, threadId);
    }
  }
}

function scheduleCapacityRecovery(threadId, options = {}) {
  if (typeof threadId !== "string" || threadId.length === 0 || childExited) {
    return;
  }
  const workGeneration = options.workGeneration ?? ensureWorkGeneration(threadId);
  if (workGeneration === undefined || latestWorkGenerations.get(threadId) !== workGeneration) {
    return;
  }
  const sourceTurnId = typeof options.sourceTurnId === "string" ? options.sourceTurnId : undefined;
  const existing = capacityRecoveryThreads.get(threadId);
  const sameWaitingFailure =
    existing &&
    existing.state === "waiting" &&
    existing.workGeneration === workGeneration &&
    (existing.sourceTurnId === sourceTurnId || !existing.sourceTurnId || !sourceTurnId);
  if (sameWaitingFailure) {
    if (!existing.sourceTurnId && sourceTurnId) {
      existing.sourceTurnId = sourceTurnId;
    }
    return;
  }

  if (existing) {
    if (existing.timer) {
      clearTimeout(existing.timer);
    }
    capacityRecoveryThreads.delete(threadId);
    for (const request of [pendingSwitch, activeSwitchRequest]) {
      if (request?.capacityRecoveryEntries.get(threadId) === existing) {
        removeCapacityRecoveryFromRequest(request, threadId);
      }
    }
  }

  const entry = {
    timer: undefined,
    retryAt: Date.now() + readCapacityRecoveryDelayMs(),
    generation: `${process.pid}:${++internalSequence}`,
    workGeneration,
    sourceTurnId,
    state: "waiting"
  };
  capacityRecoveryThreads.set(threadId, entry);
  while (capacityRecoveryThreads.size > MAX_CAPACITY_RECOVERY_THREADS) {
    const oldestThreadId = capacityRecoveryThreads.keys().next().value;
    if (oldestThreadId === undefined) {
      break;
    }
    clearCapacityRecoveryThread(oldestThreadId, { force: true });
  }
  armCapacityRecoveryTimer(threadId, entry);
}

function armCapacityRecoveryTimer(threadId, entry) {
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    if (capacityRecoveryThreads.get(threadId) !== entry || entry.state !== "waiting") {
      return;
    }
    entry.state = "running";
    void runCapacityRecoveryTurn(threadId, entry);
  }, Math.max(0, entry.retryAt - Date.now()));
}

async function runCapacityRecoveryTurn(threadId, entry) {
  if (capacityRecoveryThreads.get(threadId) !== entry || entry.state !== "running") {
    return;
  }
  try {
    if (await isSubagentThread(threadId)) {
      clearCapacityRecoveryThread(threadId, { force: true });
      return;
    }
    await startRecoveryTurn(threadId, { workGeneration: entry.workGeneration });
    if (capacityRecoveryThreads.get(threadId) === entry) {
      clearCapacityRecoveryThread(threadId, { force: true });
    }
  } catch (error) {
    if (capacityRecoveryThreads.get(threadId) === entry) {
      clearCapacityRecoveryThread(threadId, { force: true });
    }
    safeLog(`failed to continue a model-capacity thread: ${safeErrorMessage(error)}`);
  }
}

function observeRecoveryTurnFailure(pending, error) {
  const threadId = pending.threadId;
  if (typeof threadId !== "string" || threadId.length === 0) {
    return;
  }
  if (isUsageLimitExceededError(error)) {
    clearCapacityRecoveryThread(threadId, { force: true });
    captureUsageLimitedThread(threadId, { terminal: true });
    return;
  }
  if (isModelCapacityError(error)) {
    scheduleCapacityRecovery(threadId, {
      workGeneration: pending.workGeneration
    });
    return;
  }
  clearCapacityRecoveryThread(threadId, {
    workGeneration: pending.workGeneration,
    force: true
  });
}

function clearAllCapacityRecoveryThreads() {
  for (const entry of capacityRecoveryThreads.values()) {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
  }
  capacityRecoveryThreads.clear();
}

function rememberTerminalTurnId(turnId) {
  terminalTurnIds.delete(turnId);
  terminalTurnIds.add(turnId);
  while (terminalTurnIds.size > MAX_TERMINAL_TURN_IDS) {
    const oldestTurnId = terminalTurnIds.values().next().value;
    if (oldestTurnId === undefined) {
      break;
    }
    terminalTurnIds.delete(oldestTurnId);
  }
}

function rememberRecentUsageLimitedThread(threadId) {
  if (!recentUsageLimitedThreads.has(threadId)) {
    observedUsageLimitFailures += 1;
  }
  recentUsageLimitedThreads.delete(threadId);
  recentUsageLimitedThreads.set(threadId, Date.now());
  pruneRecentUsageLimitedThreads();
}

function captureUsageLimitedThread(threadId, options = {}) {
  if (!usageLimitObservationEnabled || typeof threadId !== "string" || threadId.length === 0) {
    return;
  }
  rememberRecentUsageLimitedThread(threadId);
  observeUsageLimitExhaustionUsageLimited(threadId, options.terminal === true);
  const request = pendingSwitch;
  if (request?.params.recoverRecentUsageLimitedTurns !== true) {
    return;
  }
  request.recentUsageLimitedThreadIds.add(threadId);
  if (request.pausedGoalThreadIds.has(threadId)) {
    request.recentUsageLimitedGoalThreadIds.add(threadId);
    request.recoveryThreadIds.delete(threadId);
  } else if (request.goalsPrepared) {
    request.recoveryThreadIds.add(threadId);
  }
}

function configureUsageLimitObservation(params) {
  if (!params || typeof params.enabled !== "boolean") {
    throw new Error("Invalid usage-limit observation configuration");
  }
  usageLimitObservationEnabled = params.enabled;
  // Existing transactions already own their recovery snapshot and are allowed
  // to finish. Clearing only global observation state prevents a later toggle
  // from replaying an old exhaustion batch or journal.
  recentUsageLimitedThreads.clear();
  observedUsageLimitFailures = 0;
  resetUsageLimitExhaustionObservation();
  return { enabled: usageLimitObservationEnabled };
}

function resetUsageLimitObservation() {
  recentUsageLimitedThreads.clear();
  observedUsageLimitFailures = 0;
  resetUsageLimitExhaustionObservation();
  return { reset: true };
}

/**
 * Start or advance the bounded "all active conversations exhausted" batch.
 *
 * This state is intentionally separate from recentUsageLimitedThreads. The
 * latter is the recovery journal used by every account switch; this batch only
 * answers whether the threshold=0 scheduler may request one. Keeping them
 * separate means a normal quota-band switch can still recover a turn whose
 * quota refresh arrived slightly after the turn stopped.
 */
function observeUsageLimitExhaustionUsageLimited(threadId, terminal) {
  if (typeof threadId !== "string" || threadId.length === 0) {
    return;
  }

  let batch = usageLimitExhaustionBatch;
  if (!batch) {
    if (usageLimitExhaustionObservationSuppressed) {
      return;
    }
    // We deliberately fail closed if the runtime cannot identify every active
    // conversation. An anonymous turn must never be treated as exhausted by
    // inference, because it could still be productive work on the old account.
    if (!canTrackUsageLimitExhaustionBatch()) {
      suppressUsageLimitExhaustionObservation();
      return;
    }
    const threadIds = getActiveThreadIds();
    threadIds.add(threadId);
    const observedAt = Date.now();
    batch = {
      threadIds,
      usageLimitedThreadIds: new Set(),
      terminalThreadIds: new Set(),
      deadlineAt: observedAt + USAGE_LIMIT_EXHAUSTION_MAX_WAIT_MS,
      ready: false,
      id: 0
    };
    usageLimitExhaustionBatch = batch;
  }

  // A thread outside the original snapshot can only mean that newer work
  // raced with the observation. Do not merge it into an old decision.
  if (!batch.threadIds.has(threadId)) {
    suppressUsageLimitExhaustionObservation();
    return;
  }

  batch.usageLimitedThreadIds.add(threadId);
  if (terminal) {
    batch.terminalThreadIds.add(threadId);
  }
  maybeFinalizeUsageLimitExhaustionBatch();
}

function observeUsageLimitExhaustionTerminal(threadId, status, reportedUsageLimit) {
  const batch = usageLimitExhaustionBatch;
  if (!batch || typeof threadId !== "string" || threadId.length === 0 || !batch.threadIds.has(threadId)) {
    return;
  }

  // A normally completed or manually interrupted peer proves that this was not
  // an all-conversations quota exhaustion. Keep the recovery journal intact,
  // but cancel only this scheduling decision.
  if (status === "completed" || status === "interrupted") {
    suppressUsageLimitExhaustionObservation();
    return;
  }

  const usageLimited = reportedUsageLimit || batch.usageLimitedThreadIds.has(threadId);
  if (!usageLimited) {
    suppressUsageLimitExhaustionObservation();
    return;
  }

  batch.usageLimitedThreadIds.add(threadId);
  batch.terminalThreadIds.add(threadId);
  maybeFinalizeUsageLimitExhaustionBatch();
}

function canTrackUsageLimitExhaustionBatch() {
  if (anonymousActiveTurnCount > 0) {
    return false;
  }
  return [...submittedTurnStarts.values(), ...activeTurns.values()].every(
    (threadId) => typeof threadId === "string" && threadId.length > 0
  );
}

function maybeFinalizeUsageLimitExhaustionBatch() {
  const batch = usageLimitExhaustionBatch;
  if (!batch || batch.ready) {
    return;
  }

  // This is intentionally checked before active-turn completion. At six hours
  // the quota exhaustion has waited long enough; the configured ordinary-turn
  // policy now decides whether to defer, interrupt, or continue remaining work.
  if (Date.now() >= batch.deadlineAt) {
    markUsageLimitExhaustionBatchReady(batch);
    return;
  }

  if (getActiveTurnCount() > 0) {
    return;
  }

  if (
    batch.terminalThreadIds.size === batch.threadIds.size &&
    batch.usageLimitedThreadIds.size === batch.threadIds.size
  ) {
    markUsageLimitExhaustionBatchReady(batch);
    return;
  }

  // Turn tracking reached an idle state without a terminal quota-exhaustion
  // result for every originally active conversation. Treat that ambiguity as a
  // safe cancellation instead of switching on an incomplete observation.
  suppressUsageLimitExhaustionObservation();
}

function markUsageLimitExhaustionBatchReady(batch) {
  if (usageLimitExhaustionBatch !== batch || batch.ready) {
    return;
  }
  batch.ready = true;
  readyUsageLimitExhaustionBatchId += 1;
  batch.id = readyUsageLimitExhaustionBatchId;
}

function clearUsageLimitExhaustionBatch() {
  usageLimitExhaustionBatch = undefined;
}

function suppressUsageLimitExhaustionObservation() {
  clearUsageLimitExhaustionBatch();
  // Do not let a delayed terminal notification from the just-canceled batch
  // recreate a smaller one. The next user work start establishes a fresh
  // observation scope, while the independent recovery journal stays intact.
  usageLimitExhaustionObservationSuppressed = true;
}

function resetUsageLimitExhaustionObservation() {
  clearUsageLimitExhaustionBatch();
  usageLimitExhaustionObservationSuppressed = false;
}

function getRecentUsageLimitedThreadIds() {
  pruneRecentUsageLimitedThreads();
  return new Set(recentUsageLimitedThreads.keys());
}

function clearRecentUsageLimitedThread(threadId) {
  if (typeof threadId !== "string" || threadId.length === 0) {
    return;
  }
  recentUsageLimitedThreads.delete(threadId);
  if (pendingSwitch) {
    pendingSwitch.recentUsageLimitedThreadIds.delete(threadId);
    pendingSwitch.recentUsageLimitedGoalThreadIds.delete(threadId);
    pendingSwitch.recoveryThreadIds.delete(threadId);
  }
}

function pruneRecentUsageLimitedThreads() {
  const cutoff = Date.now() - RECENT_USAGE_LIMITED_THREAD_TTL_MS;
  const protectedThreadIds = usageLimitExhaustionBatch?.usageLimitedThreadIds;
  for (const [threadId, recordedAt] of recentUsageLimitedThreads) {
    if (recordedAt >= cutoff && recentUsageLimitedThreads.size <= MAX_RECENT_USAGE_LIMITED_THREADS) {
      break;
    }
    // A ready six-hour batch may be selected just as the journal reaches its
    // normal TTL. Preserve its known exhausted threads until that one switch
    // either commits, is canceled by new work, or the runtime exits.
    if (protectedThreadIds?.has(threadId)) {
      continue;
    }
    recentUsageLimitedThreads.delete(threadId);
  }
}

function isAlreadyInactiveTurnError(error) {
  const message = safeErrorMessage(error).trim().toLowerCase();
  return message.includes("no active turn to interrupt") || message.includes("turn is not active");
}

function readReplacementActiveTurnId(error) {
  const message = safeErrorMessage(error).trim();
  const match = /expected active turn id\s+[^\s,]+\s+but found\s+([^\s,]+)/i.exec(message);
  return match?.[1];
}

function readTurnId(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const turn = value.turn;
  return turn && typeof turn === "object" && typeof turn.id === "string" ? turn.id : undefined;
}

function readThread(value) {
  return value && typeof value === "object" && value.thread && typeof value.thread === "object"
    ? value.thread
    : undefined;
}

function isSubagentThreadSource(value) {
  return (
    value === "subagent" ||
    (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "subagent"))
  );
}

function readThreadId(value) {
  return value && typeof value === "object" && typeof value.threadId === "string" ? value.threadId : undefined;
}

function readTurnStatus(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const turn = value.turn;
  return turn && typeof turn === "object" && typeof turn.status === "string" ? turn.status : undefined;
}

function isUsageLimitExceededTurn(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const turn = value.turn;
  if (!turn || typeof turn !== "object") {
    return false;
  }
  if (isUsageLimitExceededError(turn.error)) {
    return true;
  }
  return Array.isArray(turn.items) && turn.items.some((item) => isUsageLimitExceededError(item));
}

function isModelCapacityTurn(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const turn = value.turn;
  if (!turn || typeof turn !== "object") {
    return false;
  }
  if (isModelCapacityError(turn.error)) {
    return true;
  }
  return Array.isArray(turn.items) && turn.items.some((item) => isModelCapacityError(item));
}

function isUsageLimitExceededError(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return (
    value.codexErrorInfo === "usageLimitExceeded" ||
    value.codex_error_info === "usageLimitExceeded" ||
    value.errorInfo === "usageLimitExceeded" ||
    value.error_info === "usageLimitExceeded" ||
    isUsageLimitExceededError(value.data) ||
    isUsageLimitExceededError(value.error)
  );
}

function isModelCapacityError(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (isUsageLimitExceededError(value)) {
    return false;
  }
  const message = typeof value.message === "string" ? value.message.trim() : "";
  return (
    value.codexErrorInfo === "server_overloaded" ||
    value.codex_error_info === "server_overloaded" ||
    value.errorInfo === "server_overloaded" ||
    value.error_info === "server_overloaded" ||
    message === "Selected model is at capacity. Please try a different model." ||
    isModelCapacityError(value.data) ||
    isModelCapacityError(value.error)
  );
}

function readGoal(value) {
  return value && typeof value === "object" && value.goal && typeof value.goal === "object" ? value.goal : undefined;
}

function parseJson(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function safeRpcError(error) {
  if (error && typeof error.message === "string") {
    return error.message;
  }
  return "Codex app-server request failed";
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function normalizeEmail(value) {
  return String(value).trim().toLowerCase();
}

function buildRealCliArgs(args) {
  if (!forceHttpTransport) {
    return args;
  }
  const appServerIndex = args.indexOf("app-server");
  if (appServerIndex < 0) {
    return args;
  }
  if (gatewayConfig) {
    if (!gatewayAdapter) {
      failStartup("The Gateway adapter was not initialized");
    }
    const providerConfig = buildGatewayProviderConfig(SEAMLESS_HTTP_PROVIDER_ID);
    const legacyProviderConfig = buildGatewayProviderConfig(LEGACY_GATEWAY_PROVIDER_ID);
    return [
      ...args.slice(0, appServerIndex + 1),
      "-c",
      // Keep the same local provider identity used by the ChatGPT HTTP
      // transport.  Threads are local app-server records keyed by provider;
      // changing only the transport endpoint must not split their history.
      `model_provider="${SEAMLESS_HTTP_PROVIDER_ID}"`,
      "-c",
      `model=${tomlString(gatewayConfig.model)}`,
      "-c",
      providerConfig,
      "-c",
      legacyProviderConfig,
      ...args.slice(appServerIndex + 1)
    ];
  }
  return [
    ...args.slice(0, appServerIndex + 1),
    "-c",
    `model_provider="${SEAMLESS_HTTP_PROVIDER_ID}"`,
    "-c",
    SEAMLESS_HTTP_PROVIDER_CONFIG,
    "-c",
    LEGACY_GATEWAY_PROVIDER_CONFIG,
    ...args.slice(appServerIndex + 1)
  ];
}

function buildGatewayProviderConfig(providerId) {
  if (gatewayConfig.autoFallbackToChatGpt) {
    return (
      `model_providers.${providerId}={ name="OpenAI", ` +
      `base_url=${tomlString(gatewayAdapter.baseUrl)}, wire_api="responses", ` +
      "requires_openai_auth=true, supports_websockets=false }"
    );
  }
  return (
    `model_providers.${providerId}={ name=${tomlString(gatewayConfig.displayName)}, ` +
    `base_url=${tomlString(gatewayAdapter.baseUrl)}, env_key="${GATEWAY_ADAPTER_ENV_KEY}", ` +
    'wire_api="responses", requires_openai_auth=false, supports_websockets=false }'
  );
}

/**
 * The child Codex app-server may inherit an outbound HTTP proxy. Its per-run
 * Gateway adapter is always a local `127.0.0.1` service, so sending that
 * random loopback port through the proxy makes the adapter unreachable before
 * it can record a diagnostic. Preserve all user proxy routing and add only
 * the standard loopback hosts to both spellings of NO_PROXY for this child.
 */
function configureGatewayLoopbackProxyBypass(environment) {
  const entries = [environment.NO_PROXY, environment.no_proxy]
    .filter((value) => typeof value === "string")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const known = new Set(entries.map((value) => value.toLowerCase()));
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    if (!known.has(host)) {
      entries.push(host);
      known.add(host);
    }
  }
  const value = entries.join(",");
  environment.NO_PROXY = value;
  environment.no_proxy = value;
}

function resolveGatewayConfig(config) {
  const gateway = config && config.gateway;
  if (gateway === undefined || gateway === null) {
    return undefined;
  }
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) {
    failStartup("The Gateway runtime configuration is invalid");
  }
  const displayName = readBoundedString(gateway.displayName, 128);
  const baseUrl = readBoundedString(gateway.baseUrl, 2_048);
  const model = readBoundedString(gateway.model, 160);
  if (!displayName || !baseUrl || !model) {
    failStartup("The Gateway runtime configuration is invalid");
  }
  if (gateway.autoFallbackToChatGpt !== undefined && typeof gateway.autoFallbackToChatGpt !== "boolean") {
    failStartup("The Gateway automatic fallback setting is invalid");
  }
  if (gateway.active !== undefined && typeof gateway.active !== "boolean") {
    failStartup("The Gateway active route setting is invalid");
  }

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    failStartup("The Gateway base URL is invalid");
  }
  if (
    !parsed ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.replace(/\/+$/u, "") !== "/v1"
  ) {
    failStartup("The Gateway base URL must end with /v1");
  }
  parsed.pathname = "/v1";
  return {
    displayName,
    baseUrl: parsed.toString().replace(/\/$/u, ""),
    model,
    autoFallbackToChatGpt: gateway.autoFallbackToChatGpt === true,
    active: gateway.active !== false
  };
}

function startGatewayAdapter(config) {
  return new Promise((resolve, reject) => {
    const token = randomBytes(32).toString("base64url");
    const adapter = {
      token,
      config,
      apiKey: undefined,
      chatgptAccessToken: undefined,
      route: config.active === false ? "chatgpt" : "gateway",
      modelListRouteVersion: 0,
      quotaExhausted: false,
      quotaExhaustionCount: 0,
      lastQuotaExhaustionAt: undefined,
      instanceId: randomUUID(),
      startedAt: Date.now(),
      requestCount: 0,
      successfulRequestCount: 0,
      failedRequestCount: 0,
      lastRequestAt: undefined,
      lastFailureAt: undefined,
      lastFailureOrigin: undefined,
      lastFailureStatusCode: undefined,
      lastFailureTransportCode: undefined,
      lastFailureRequestMethod: undefined,
      lastFailureRequestPath: undefined,
      lastFailureContentLength: undefined,
      lastFailureTransferEncoding: undefined,
      lastUpstreamStatusCode: undefined,
      usageDay: localGatewayUsageDay(),
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      credentialWaiters: new Set(),
      server: undefined,
      baseUrl: undefined
    };
    const server = http.createServer((request, response) => {
      void handleGatewayRequest(adapter, request, response).catch(() => {
        // The adapter only exposes a fixed request shape. Do not surface an
        // arbitrary Node error here because it could contain request details.
        safeLog("Gateway request handler failed");
        if (!response.headersSent && !response.destroyed) {
          writeGatewayError(response, 502, "The local Gateway request failed");
        } else if (!response.destroyed) {
          response.destroy();
        }
      });
    });
    adapter.server = server;
    const failStart = (error) => {
      server.close();
      reject(error);
    };
    server.once("error", failStart);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", failStart);
      server.on("error", (error) => {
        safeLog(`Gateway adapter failed: ${safeErrorMessage(error)}`);
      });
      const address = server.address();
      if (!address || typeof address === "string" || !Number.isInteger(address.port) || address.port <= 0) {
        failStart(new Error("The Gateway adapter did not receive a loopback port"));
        return;
      }
      adapter.baseUrl = `http://127.0.0.1:${address.port}/v1`;
      safeLog("Gateway adapter ready");
      resolve(adapter);
    });
  });
}

function configureGatewayAdapter(params) {
  if (!gatewayAdapter || !gatewayConfig) {
    throw new Error("The Gateway adapter is not active");
  }
  const apiKey = params && typeof params.apiKey === "string" ? params.apiKey.trim() : "";
  if (!apiKey || apiKey.length > MAX_GATEWAY_API_KEY_LENGTH) {
    throw new Error("The Gateway credential is invalid");
  }
  const becameReady = !gatewayAdapter.apiKey;
  const modelListCredentialChanged = gatewayAdapter.apiKey !== apiKey;
  gatewayAdapter.apiKey = apiKey;
  if (modelListCredentialChanged) {
    gatewayAdapter.modelListRouteVersion += 1;
  }
  releaseGatewayCredentialWaiters(gatewayAdapter);
  if (becameReady) {
    safeLog("Gateway credential configured");
  }
  return getGatewayAdapterStatus();
}

function activateGatewayAdapter() {
  if (!gatewayAdapter || !gatewayConfig) {
    throw new Error("The Gateway relay is unavailable");
  }
  if (!gatewayAdapter.apiKey) {
    throw new Error("The Gateway credential is not ready");
  }
  usageAttributionAccount = undefined;
  usageAttributionFailureReason = "gateway_route_active";
  if (gatewayAdapter.route !== "gateway") {
    gatewayAdapter.route = "gateway";
    gatewayAdapter.modelListRouteVersion += 1;
  }
  gatewayAdapter.quotaExhausted = false;
  return getGatewayAdapterStatus();
}

function activateChatGptGatewayRoute(accessToken) {
  if (!gatewayAdapter || !gatewayConfig) {
    throw new Error("The Gateway relay is unavailable");
  }
  let modelListRouteChanged = false;
  if (accessToken !== undefined) {
    if (typeof accessToken !== "string" || !accessToken.trim() || accessToken.length > 16_384) {
      throw new Error("The ChatGPT route credential is invalid");
    }
    modelListRouteChanged = gatewayAdapter.chatgptAccessToken !== accessToken;
    gatewayAdapter.chatgptAccessToken = accessToken;
  }
  if (gatewayAdapter.route !== "chatgpt") {
    gatewayAdapter.route = "chatgpt";
    modelListRouteChanged = true;
  }
  if (modelListRouteChanged) {
    gatewayAdapter.modelListRouteVersion += 1;
  }
  usageAttributionAccount = undefined;
  usageAttributionFailureReason = "not_activated";
}

function restoreGatewayRoute() {
  if (!gatewayAdapter || !gatewayConfig) {
    throw new Error("The Gateway relay is unavailable");
  }
  usageAttributionAccount = undefined;
  usageAttributionFailureReason = "gateway_route_active";
  if (gatewayAdapter.route !== "gateway") {
    gatewayAdapter.route = "gateway";
    gatewayAdapter.modelListRouteVersion += 1;
  }
}

function getGatewayAdapterStatus() {
  if (!gatewayAdapter || !gatewayConfig) {
    return {
      active: false,
      ready: false,
      requestCount: 0,
      successfulRequestCount: 0,
      failedRequestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0
    };
  }
  ensureGatewayUsageDay(gatewayAdapter);
  return {
    active: gatewayAdapter.route === "gateway",
    ready:
      gatewayAdapter.route === "chatgpt" ||
      (typeof gatewayAdapter.apiKey === "string" && gatewayAdapter.apiKey.length > 0),
    route: gatewayAdapter.route,
    autoFallbackToChatGpt: gatewayConfig.autoFallbackToChatGpt,
    quotaExhaustionCount: gatewayAdapter.quotaExhaustionCount,
    lastQuotaExhaustionAt: gatewayAdapter.lastQuotaExhaustionAt,
    instanceId: gatewayAdapter.instanceId,
    startedAt: gatewayAdapter.startedAt,
    requestCount: gatewayAdapter.requestCount,
    successfulRequestCount: gatewayAdapter.successfulRequestCount,
    failedRequestCount: gatewayAdapter.failedRequestCount,
    lastRequestAt: gatewayAdapter.lastRequestAt,
    lastFailureAt: gatewayAdapter.lastFailureAt,
    lastFailureOrigin: gatewayAdapter.lastFailureOrigin,
    lastFailureStatusCode: gatewayAdapter.lastFailureStatusCode,
    lastFailureTransportCode: gatewayAdapter.lastFailureTransportCode,
    lastFailureRequestMethod: gatewayAdapter.lastFailureRequestMethod,
    lastFailureRequestPath: gatewayAdapter.lastFailureRequestPath,
    lastFailureContentLength: gatewayAdapter.lastFailureContentLength,
    lastFailureTransferEncoding: gatewayAdapter.lastFailureTransferEncoding,
    lastUpstreamStatusCode: gatewayAdapter.lastUpstreamStatusCode,
    usageDay: gatewayAdapter.usageDay,
    inputTokens: gatewayAdapter.inputTokens,
    outputTokens: gatewayAdapter.outputTokens,
    cachedInputTokens: gatewayAdapter.cachedInputTokens,
    reasoningTokens: gatewayAdapter.reasoningTokens,
    totalTokens: gatewayAdapter.totalTokens
  };
}

function closeGatewayAdapter() {
  if (!gatewayAdapter) {
    return;
  }
  gatewayAdapter.apiKey = undefined;
  releaseGatewayCredentialWaiters(gatewayAdapter);
  gatewayAdapter.server?.close();
  gatewayAdapter = undefined;
}

function requestGatewayModelList(adapter) {
  let target;
  try {
    target = new URL("models", `${adapter.baseUrl.replace(/\/+$/u, "")}/`);
  } catch (error) {
    return Promise.reject(error);
  }
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };
    const request = client.request(
      target,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${adapter.token}`
        }
      },
      (response) => {
        const statusCode = response.statusCode ?? 502;
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          finish(reject, new Error("The Gateway model list request failed"));
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          if (settled) {
            return;
          }
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_GATEWAY_JSON_USAGE_BYTES) {
            response.destroy();
            finish(reject, new Error("The Gateway model list is too large"));
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", (error) => finish(reject, error));
        response.once("end", () => {
          if (settled) {
            return;
          }
          try {
            finish(resolve, readGatewayModels(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
          } catch (error) {
            finish(reject, error);
          }
        });
      }
    );
    request.setTimeout(INTERNAL_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("The Gateway model list request timed out"));
    });
    request.once("error", (error) => finish(reject, error));
    request.end();
  });
}

function readGatewayModels(payload) {
  const entries = Array.isArray(payload)
    ? payload
    : isPlainObject(payload) && Array.isArray(payload.data)
      ? payload.data
      : isPlainObject(payload) && Array.isArray(payload.models)
        ? payload.models
        : [];
  const seen = new Set();
  const models = [];
  for (const entry of entries) {
    if (models.length >= MAX_GATEWAY_MODELS) {
      break;
    }
    const id =
      typeof entry === "string"
        ? readBoundedString(entry, 160)
        : isPlainObject(entry)
          ? readBoundedString(entry.id, 160) || readBoundedString(entry.model, 160)
          : undefined;
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const displayName =
      isPlainObject(entry) &&
      (readBoundedString(entry.displayName, 160) ||
        readBoundedString(entry.display_name, 160) ||
        readBoundedString(entry.name, 160));
    models.push({
      id,
      model: id,
      displayName: displayName || id,
      description: "Third-party Gateway model.",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        {
          reasoningEffort: "medium",
          description: "Provider default"
        }
      ],
      inputModalities: ["text"],
      supportsPersonality: false
    });
  }
  const defaultModelId = models.some((model) => model.id === gatewayConfig?.model)
    ? gatewayConfig.model
    : models[0]?.id;
  for (const model of models) {
    model.isDefault = model.id === defaultModelId;
  }
  return models;
}

function paginateGatewayModels(models, params) {
  const offset = readGatewayModelListOffset(params?.cursor);
  const limit = readGatewayModelListLimit(params?.limit);
  if (limit === 0) {
    return { data: [], nextCursor: null };
  }
  const start = Math.min(offset, models.length);
  const end = limit === undefined ? models.length : Math.min(start + limit, models.length);
  return {
    data: models.slice(start, end),
    nextCursor: end < models.length ? String(end) : null
  };
}

function readGatewayModelListOffset(value) {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    return 0;
  }
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

function readGatewayModelListLimit(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function handleGatewayRequest(adapter, request, response) {
  if (!hasAuthorizedGatewayRequest(adapter, request.headers.authorization)) {
    safeLog("Gateway request rejected: local authorization mismatch");
    writeGatewayError(response, 401, "Invalid local Gateway authorization");
    return;
  }

  if (adapter.route === "chatgpt") {
    await handleChatGptGatewayRequest(adapter, request, response);
    return;
  }

  let target;
  try {
    target = resolveGatewayTargetUrl(adapter.config.baseUrl, request.url);
  } catch (error) {
    writeGatewayError(response, 400, safeErrorMessage(error));
    return;
  }
  if (!isAllowedGatewayRequest(target.pathname, request.method)) {
    writeGatewayError(response, 404, "The local Gateway only permits Responses and model requests");
    return;
  }

  adapter.requestCount += 1;
  adapter.lastRequestAt = Date.now();
  const requestDiagnostic = summarizeGatewayRequest(request, target);
  if (adapter.quotaExhausted) {
    writeGatewayError(response, 503, "The Gateway is waiting for ChatGPT fallback");
    return;
  }
  let recorded = false;
  let incomingRequestAborted = false;
  let cancellationLogged = false;
  let upstream;
  const logCancellation = () => {
    if (cancellationLogged) {
      return;
    }
    cancellationLogged = true;
    logGatewayRequestLifecycle("request canceled by local client", requestDiagnostic);
  };
  request.on("aborted", () => {
    incomingRequestAborted = true;
    logCancellation();
    upstream?.destroy();
  });
  const recordResult = (successful, details = {}) => {
    if (recorded) {
      return;
    }
    recorded = true;
    if (successful) {
      adapter.successfulRequestCount += 1;
    } else {
      adapter.failedRequestCount += 1;
      adapter.lastFailureAt = Date.now();
      adapter.lastFailureOrigin = details.origin === "upstream" ? "upstream" : "adapter";
      adapter.lastFailureStatusCode = Number.isInteger(details.statusCode) ? details.statusCode : undefined;
      adapter.lastFailureTransportCode = normalizeGatewayTransportCode(details.transportCode);
      adapter.lastFailureRequestMethod = requestDiagnostic.method;
      adapter.lastFailureRequestPath = requestDiagnostic.path;
      adapter.lastFailureContentLength = requestDiagnostic.contentLength;
      adapter.lastFailureTransferEncoding = requestDiagnostic.transferEncoding;
      const failure = {
        at: adapter.lastFailureAt,
        origin: adapter.lastFailureOrigin,
        statusCode: adapter.lastFailureStatusCode,
        upstreamStatusCode: details.upstreamStatusCode,
        transportCode: adapter.lastFailureTransportCode,
        request: requestDiagnostic
      };
      persistGatewayFailureDiagnostic(adapter, failure);
      logGatewayForwardingFailure(failure);
    }
  };

  if (!adapter.apiKey) {
    logGatewayRequestLifecycle("request is waiting for credential", requestDiagnostic);
    const credentialReady = await waitForGatewayCredential(adapter);
    if (incomingRequestAborted) {
      return;
    }
    if (!credentialReady || !adapter.apiKey) {
      logGatewayRequestLifecycle("credential wait timed out", requestDiagnostic);
      recordResult(false, {
        origin: "adapter",
        statusCode: 503,
        transportCode: "CREDENTIAL_TIMEOUT"
      });
      if (!response.headersSent && !response.destroyed) {
        writeGatewayError(response, 503, "The local Gateway credential is not ready");
      }
      return;
    }
  }

  logGatewayRequestLifecycle("forwarding started", requestDiagnostic);

  const headers = { ...request.headers };
  delete headers.authorization;
  delete headers["x-api-key"];
  delete headers.host;
  headers.authorization = `Bearer ${adapter.apiKey}`;
  headers.host = target.host;
  const client = target.protocol === "https:" ? https : http;
  try {
    upstream = client.request(
      target,
      {
        method: request.method,
        headers
      },
      (upstreamResponse) => {
        const statusCode = upstreamResponse.statusCode ?? 502;
        adapter.lastUpstreamStatusCode = statusCode;
        recordResult(statusCode >= 200 && statusCode < 300, {
          origin: "upstream",
          statusCode,
          upstreamStatusCode: statusCode
        });
        observeGatewayQuotaExhaustion(adapter, statusCode, upstreamResponse);
        observeGatewayResponseUsage(adapter, upstreamResponse);
        response.writeHead(statusCode, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      }
    );
  } catch (error) {
    recordResult(false, {
      origin: "adapter",
      statusCode: 502,
      transportCode: readGatewayTransportCode(error)
    });
    writeGatewayError(response, 502, "The configured Gateway endpoint is unavailable");
    return;
  }
  upstream.on("error", (error) => {
    if (incomingRequestAborted) {
      return;
    }
    recordResult(false, {
      origin: "adapter",
      statusCode: 502,
      transportCode: readGatewayTransportCode(error)
    });
    if (!response.headersSent) {
      writeGatewayError(response, 502, "The configured Gateway endpoint is unavailable");
    } else {
      response.destroy();
    }
  });
  request.pipe(upstream);
}

/**
 * The dual-route relay receives the OAuth bearer generated by Codex. It only
 * checks that a bearer exists locally, then either preserves it for ChatGPT or
 * replaces it with the SecretStorage Key for Gateway. The relay is loopback
 * only, so it never needs to persist or log the bearer.
 */
function hasAuthorizedGatewayRequest(adapter, authorization) {
  if (adapter.config.autoFallbackToChatGpt) {
    const received = Array.isArray(authorization) ? authorization[0] : authorization;
    return typeof received === "string" && /^Bearer\s+\S+$/iu.test(received);
  }
  return hasExpectedGatewayAdapterToken(adapter, authorization);
}

async function handleChatGptGatewayRequest(adapter, request, response) {
  let target;
  try {
    const incoming = new URL(request.url || "/", "http://127.0.0.1");
    if (!isAllowedGatewayRequest(incoming.pathname, request.method)) {
      writeGatewayError(response, 404, "The local Gateway only permits Responses and model requests");
      return;
    }
    target = resolveChatGptGatewayTargetUrl(request.url);
  } catch {
    writeGatewayError(response, 400, "The local Gateway request URL is invalid");
    return;
  }

  const headers = { ...request.headers };
  delete headers["x-api-key"];
  delete headers.host;
  if (adapter.config.autoFallbackToChatGpt !== true && adapter.chatgptAccessToken) {
    headers.authorization = `Bearer ${adapter.chatgptAccessToken}`;
  }
  headers.host = target.host;
  let upstream;
  let proxyAgent;
  try {
    const proxy = resolveChatGptGatewayProxy(target);
    proxyAgent = proxy ? createHttpsConnectProxyAgent(target, proxy) : undefined;
    upstream = https.request(
      target,
      {
        method: request.method,
        headers,
        ...(proxyAgent ? { agent: proxyAgent } : {})
      },
      (upstreamResponse) => {
        upstreamResponse.once("end", () => proxyAgent?.destroy());
        upstreamResponse.once("error", () => proxyAgent?.destroy());
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      }
    );
  } catch {
    proxyAgent?.destroy();
    writeGatewayError(response, 502, "The ChatGPT fallback relay could not start the upstream request");
    return;
  }
  upstream.on("error", () => {
    proxyAgent?.destroy();
    if (!response.headersSent) {
      writeGatewayError(response, 502, "The ChatGPT fallback relay could not reach the upstream");
    } else {
      response.destroy();
    }
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

function resolveChatGptGatewayTargetUrl(requestUrl) {
  const incoming = new URL(requestUrl || "/", "http://127.0.0.1");
  const pathWithoutVersion = incoming.pathname === "/v1" ? "/" : incoming.pathname.replace(/^\/v1(?=\/|$)/u, "");
  const relative = `${pathWithoutVersion.replace(/^\/+/, "")}${incoming.search}`;
  return new URL(relative, `${CHATGPT_CODEX_BASE_URL}/`);
}

function resolveChatGptGatewayProxy(target) {
  if (shouldBypassGatewayProxy(target.hostname)) {
    return undefined;
  }
  const raw =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  try {
    const proxy = new URL(raw.trim());
    return (proxy.protocol === "http:" || proxy.protocol === "https:") && proxy.hostname ? proxy : undefined;
  } catch {
    return undefined;
  }
}

function shouldBypassGatewayProxy(hostname) {
  const normalizedHost = String(hostname || "")
    .trim()
    .toLowerCase();
  if (!normalizedHost) {
    return false;
  }
  const entries = [process.env.NO_PROXY, process.env.no_proxy]
    .filter((value) => typeof value === "string")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return entries.some((entry) => {
    if (entry === "*") {
      return true;
    }
    const host = entry
      .replace(/^\*\.?/u, "")
      .replace(/^\./u, "")
      .split(":")[0];
    return Boolean(host) && (normalizedHost === host || normalizedHost.endsWith(`.${host}`));
  });
}

function createHttpsConnectProxyAgent(target, proxy) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (_options, callback) => {
    let settled = false;
    const finish = (error, socket) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(error, socket);
    };
    const port = target.port || "443";
    const headers = { host: `${target.hostname}:${port}` };
    const proxyAuthorization = readProxyAuthorization(proxy);
    if (proxyAuthorization) {
      headers["proxy-authorization"] = proxyAuthorization;
    }
    const proxyClient = proxy.protocol === "https:" ? https : http;
    const connectRequest = proxyClient.request({
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      headers
    });
    connectRequest.setTimeout(INTERNAL_REQUEST_TIMEOUT_MS, () => {
      connectRequest.destroy(new Error("The configured HTTP proxy tunnel timed out"));
    });
    connectRequest.once("connect", (proxyResponse, socket, head) => {
      if (proxyResponse.statusCode !== 200) {
        socket.destroy();
        finish(new Error("The configured HTTP proxy rejected the ChatGPT tunnel"));
        return;
      }
      if (head?.length) {
        socket.unshift(head);
      }
      const secureSocket = tls.connect({ socket, servername: target.hostname });
      secureSocket.once("secureConnect", () => finish(null, secureSocket));
      secureSocket.once("error", (error) => finish(error));
    });
    connectRequest.once("response", (proxyResponse) => {
      proxyResponse.resume();
      finish(new Error("The configured HTTP proxy rejected the ChatGPT tunnel"));
    });
    connectRequest.once("error", (error) => finish(error));
    connectRequest.end();
  };
  return agent;
}

function readProxyAuthorization(proxy) {
  if (!proxy.username && !proxy.password) {
    return undefined;
  }
  try {
    const username = decodeURIComponent(proxy.username);
    const password = decodeURIComponent(proxy.password);
    return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  } catch {
    return undefined;
  }
}

function observeGatewayQuotaExhaustion(adapter, statusCode, upstreamResponse) {
  if (
    !adapter.config.autoFallbackToChatGpt ||
    adapter.route !== "gateway" ||
    adapter.quotaExhausted ||
    !isPotentialGatewayQuotaStatus(statusCode)
  ) {
    return;
  }
  const chunks = [];
  let bytes = 0;
  let exceeded = false;
  upstreamResponse.on("data", (chunk) => {
    if (exceeded) {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_GATEWAY_QUOTA_ERROR_BODY_BYTES) {
      exceeded = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buffer);
  });
  upstreamResponse.once("end", () => {
    if (exceeded || !isGatewayQuotaExhaustionBody(statusCode, Buffer.concat(chunks))) {
      return;
    }
    adapter.quotaExhausted = true;
    adapter.quotaExhaustionCount += 1;
    adapter.lastQuotaExhaustionAt = Date.now();
    safeLog("Gateway quota exhaustion confirmed; waiting for ChatGPT fallback");
  });
}

function isPotentialGatewayQuotaStatus(statusCode) {
  return statusCode === 429 || statusCode === 502 || statusCode === 503;
}

function isGatewayQuotaExhaustionBody(statusCode, body) {
  if (!isPotentialGatewayQuotaStatus(statusCode) || !body?.length) {
    return false;
  }
  try {
    return containsGatewayQuotaExhaustionMarker(JSON.parse(body.toString("utf8")));
  } catch {
    return false;
  }
}

function containsGatewayQuotaExhaustionMarker(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return [
      "quota_exhausted",
      "api_key_quota_exhausted",
      "usage_limit_reached",
      "usage_limit_exceeded",
      "no_available_account",
      "no_available_accounts",
      "insufficient_balance"
    ].some((marker) => normalized.includes(marker));
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).some((entry) => containsGatewayQuotaExhaustionMarker(entry, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return ["code", "type", "message", "detail", "error"].some((key) =>
    containsGatewayQuotaExhaustionMarker(value[key], depth + 1)
  );
}

function waitForGatewayCredential(adapter) {
  if (adapter.apiKey) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const waiter = () => {
      clearTimeout(timeout);
      resolve(Boolean(adapter.apiKey));
    };
    const timeout = setTimeout(() => {
      adapter.credentialWaiters.delete(waiter);
      resolve(Boolean(adapter.apiKey));
    }, GATEWAY_CREDENTIAL_WAIT_TIMEOUT_MS);
    adapter.credentialWaiters.add(waiter);
    // The credential may have arrived between the initial check and adding
    // this waiter through the control socket's event loop turn.
    if (adapter.apiKey) {
      adapter.credentialWaiters.delete(waiter);
      clearTimeout(timeout);
      resolve(true);
    }
  });
}

function releaseGatewayCredentialWaiters(adapter) {
  for (const waiter of adapter.credentialWaiters) {
    waiter();
  }
  adapter.credentialWaiters.clear();
}

/**
 * Persist one bounded, credential-free failure record before the user switches
 * the active transport back to ChatGPT Auth.  The shim's in-memory status is
 * otherwise lost at that switch, while this file remains inside the Manager
 * runtime directory with owner-only permissions.
 */
function persistGatewayFailureDiagnostic(adapter, details) {
  const request = normalizeGatewayDiagnosticRequest(details.request);
  const diagnostic = {
    schema: GATEWAY_DIAGNOSTIC_SCHEMA,
    recordedAt: Number.isSafeInteger(details.at) && details.at > 0 ? details.at : Date.now(),
    origin: details.origin === "upstream" ? "upstream" : "adapter",
    ...(normalizeGatewayHttpStatus(details.statusCode)
      ? { statusCode: normalizeGatewayHttpStatus(details.statusCode) }
      : {}),
    ...(normalizeGatewayHttpStatus(details.upstreamStatusCode)
      ? { upstreamStatusCode: normalizeGatewayHttpStatus(details.upstreamStatusCode) }
      : {}),
    ...(normalizeGatewayTransportCode(details.transportCode)
      ? { transportCode: normalizeGatewayTransportCode(details.transportCode) }
      : {}),
    ...(request ? { request } : {})
  };
  const temporaryPath = `${GATEWAY_DIAGNOSTIC_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(diagnostic)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, GATEWAY_DIAGNOSTIC_PATH);
    fs.chmodSync(GATEWAY_DIAGNOSTIC_PATH, 0o600);
  } catch {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created; failure diagnostics must
      // never disrupt the active forwarding request.
    }
    safeLog("Gateway diagnostic write failed");
  }
}

function logGatewayForwardingFailure(details) {
  const request = normalizeGatewayDiagnosticRequest(details.request);
  const fields = [
    `origin=${details.origin === "upstream" ? "upstream" : "adapter"}`,
    ...(normalizeGatewayHttpStatus(details.statusCode)
      ? [`status=${normalizeGatewayHttpStatus(details.statusCode)}`]
      : []),
    ...(normalizeGatewayHttpStatus(details.upstreamStatusCode)
      ? [`upstreamStatus=${normalizeGatewayHttpStatus(details.upstreamStatusCode)}`]
      : []),
    ...(normalizeGatewayTransportCode(details.transportCode)
      ? [`transport=${normalizeGatewayTransportCode(details.transportCode)}`]
      : []),
    ...formatGatewayRequestDiagnosticFields(request)
  ];
  safeLog(`Gateway forwarding failed: ${fields.join(" ")}`);
}

function logGatewayRequestLifecycle(event, request) {
  const fields = formatGatewayRequestDiagnosticFields(request);
  safeLog(`Gateway ${event}${fields.length > 0 ? `: ${fields.join(" ")}` : ""}`);
}

function formatGatewayRequestDiagnosticFields(value) {
  const request = normalizeGatewayDiagnosticRequest(value);
  return [
    ...(request?.method ? [`method=${request.method}`] : []),
    ...(request?.path ? [`path=${request.path}`] : []),
    ...(request?.contentLength !== undefined ? [`contentLength=${request.contentLength}`] : []),
    ...(request?.transferEncoding ? [`transferEncoding=${request.transferEncoding}`] : [])
  ];
}

function summarizeGatewayRequest(request, target) {
  const method = normalizeGatewayRequestMethod(request.method);
  const path = normalizeGatewayRequestPath(target.pathname);
  const contentLength = readGatewayContentLength(request.headers["content-length"]);
  const transferEncoding = readGatewayTransferEncoding(request.headers["transfer-encoding"]);
  return {
    ...(method ? { method } : {}),
    ...(path ? { path } : {}),
    ...(contentLength !== undefined ? { contentLength } : {}),
    ...(transferEncoding ? { transferEncoding } : {})
  };
}

function normalizeGatewayDiagnosticRequest(value) {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const method = normalizeGatewayRequestMethod(value.method);
  const path = normalizeGatewayRequestPath(value.path);
  const contentLength = normalizeGatewayContentLength(value.contentLength);
  const transferEncoding = value.transferEncoding === "chunked" ? "chunked" : undefined;
  if (!method && !path && contentLength === undefined && !transferEncoding) {
    return undefined;
  }
  return {
    ...(method ? { method } : {}),
    ...(path ? { path } : {}),
    ...(contentLength !== undefined ? { contentLength } : {}),
    ...(transferEncoding ? { transferEncoding } : {})
  };
}

function normalizeGatewayRequestMethod(value) {
  return typeof value === "string" && /^[A-Z]{1,16}$/u.test(value) ? value : undefined;
}

function normalizeGatewayRequestPath(value) {
  if (value === "/v1/models" || value === "/v1/responses" || value === "/v1/responses/compact") {
    return value;
  }
  return typeof value === "string" && value.startsWith("/v1/responses/") ? "/v1/responses/*" : undefined;
}

function readGatewayContentLength(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^\d{1,10}$/u.test(raw)) {
    return undefined;
  }
  return normalizeGatewayContentLength(Number(raw));
}

function normalizeGatewayContentLength(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_GATEWAY_DIAGNOSTIC_CONTENT_LENGTH
    ? value
    : undefined;
}

function readGatewayTransferEncoding(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.toLowerCase() === "chunked" ? "chunked" : undefined;
}

function readGatewayTransportCode(error) {
  return error && typeof error === "object" ? normalizeGatewayTransportCode(error.code) : undefined;
}

function normalizeGatewayTransportCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(value) ? value : undefined;
}

function normalizeGatewayHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/**
 * Observe only the final Responses usage envelope while preserving the
 * upstream stream byte-for-byte.  No prompt, output text, response IDs, or
 * raw payload is retained after a line has been inspected.
 */
function observeGatewayResponseUsage(adapter, upstreamResponse) {
  const contentType = String(upstreamResponse.headers["content-type"] || "").toLowerCase();
  let recorded = false;
  const record = (payload) => {
    if (recorded) {
      return;
    }
    const usage = extractGatewayResponseUsage(payload);
    if (!usage) {
      return;
    }
    recorded = true;
    recordGatewayUsage(adapter, usage);
  };

  if (contentType.includes("text/event-stream")) {
    let remainder = "";
    let eventName = "";
    upstreamResponse.on("data", (chunk) => {
      if (recorded) {
        return;
      }
      remainder += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (Buffer.byteLength(remainder, "utf8") > MAX_GATEWAY_USAGE_LINE_BYTES) {
        // A completion envelope is compact.  Discard an unexpectedly huge
        // unfinished line rather than retaining streamed model output.
        remainder = "";
        eventName = "";
        return;
      }
      const lines = remainder.split(/\r?\n/u);
      remainder = lines.pop() || "";
      for (const line of lines) {
        if (line.length === 0) {
          eventName = "";
          continue;
        }
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
          continue;
        }
        if (!line.startsWith("data:")) {
          continue;
        }
        const data = line.slice("data:".length).trim();
        if (data === "[DONE]" || (eventName !== "response.completed" && !data.includes("response.completed"))) {
          continue;
        }
        try {
          record(JSON.parse(data));
        } catch {
          // The upstream data stream remains untouched.  A malformed event
          // simply contributes no token observation.
        }
      }
    });
    return;
  }

  if (!contentType.includes("json")) {
    return;
  }
  const chunks = [];
  let bytes = 0;
  let exceeded = false;
  upstreamResponse.on("data", (chunk) => {
    if (exceeded || recorded) {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_GATEWAY_JSON_USAGE_BYTES) {
      exceeded = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buffer);
  });
  upstreamResponse.on("end", () => {
    if (exceeded || recorded || chunks.length === 0) {
      return;
    }
    try {
      record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      // See stream case above: this observer is deliberately best-effort.
    }
  });
}

function extractGatewayResponseUsage(payload) {
  const response = isPlainObject(payload) && isPlainObject(payload.response) ? payload.response : payload;
  const usage = isPlainObject(response) && isPlainObject(response.usage) ? response.usage : undefined;
  if (!usage) {
    return undefined;
  }
  const inputTokens = nonNegativeSafeInteger(usage.input_tokens);
  const outputTokens = nonNegativeSafeInteger(usage.output_tokens);
  const totalTokens = nonNegativeSafeInteger(usage.total_tokens);
  const inputDetails = isPlainObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const outputDetails = isPlainObject(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  const cachedInputTokens = inputDetails ? nonNegativeSafeInteger(inputDetails.cached_tokens) : 0;
  const reasoningTokens = outputDetails ? nonNegativeSafeInteger(outputDetails.reasoning_tokens) : 0;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    cachedInputTokens,
    reasoningTokens,
    totalTokens: totalTokens === undefined ? (inputTokens || 0) + (outputTokens || 0) : totalTokens
  };
}

function recordGatewayUsage(adapter, usage) {
  ensureGatewayUsageDay(adapter);
  adapter.inputTokens += usage.inputTokens;
  adapter.outputTokens += usage.outputTokens;
  adapter.cachedInputTokens += usage.cachedInputTokens;
  adapter.reasoningTokens += usage.reasoningTokens;
  adapter.totalTokens += usage.totalTokens;
}

function ensureGatewayUsageDay(adapter) {
  const today = localGatewayUsageDay();
  if (adapter.usageDay === today) {
    return;
  }
  adapter.usageDay = today;
  adapter.inputTokens = 0;
  adapter.outputTokens = 0;
  adapter.cachedInputTokens = 0;
  adapter.reasoningTokens = 0;
  adapter.totalTokens = 0;
}

function localGatewayUsageDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function nonNegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExpectedGatewayAdapterToken(adapter, authorization) {
  const received = Array.isArray(authorization) ? authorization[0] : authorization;
  const expected = `Bearer ${adapter.token}`;
  if (typeof received !== "string" || received.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function resolveGatewayTargetUrl(baseUrl, requestUrl) {
  const incoming = new URL(requestUrl || "/", "http://127.0.0.1");
  const pathWithoutVersion = incoming.pathname === "/v1" ? "/" : incoming.pathname.replace(/^\/v1(?=\/|$)/u, "");
  const relative = `${pathWithoutVersion.replace(/^\/+/, "")}${incoming.search}`;
  return new URL(relative, `${baseUrl.replace(/\/+$/u, "")}/`);
}

function isAllowedGatewayRequest(pathname, method) {
  if (pathname === "/v1/models") {
    return method === "GET";
  }
  return pathname === "/v1/responses" || pathname === "/v1/responses/compact" || pathname.startsWith("/v1/responses/");
}

function writeGatewayError(response, statusCode, message) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: { message } }));
}

function tomlString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function readBoundedString(value, maximumLength) {
  return typeof value === "string" && value.trim() && value.trim().length <= maximumLength ? value.trim() : undefined;
}

function readRuntimeConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    failStartup(`Unable to read hot-switch runtime configuration: ${safeErrorMessage(error)}`);
  }
}

function resolveUsageAttributionDirectory(config) {
  const configured =
    config && typeof config.usageAttributionDirectory === "string" ? config.usageAttributionDirectory.trim() : "";
  return configured && path.isAbsolute(configured) ? configured : undefined;
}

function safeLog(message) {
  process.stderr.write(`[codex-accounts-shim] ${message}\n`);
}

function failStartup(message) {
  safeLog(message);
  process.exit(1);
}

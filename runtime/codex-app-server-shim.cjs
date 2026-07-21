#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const INTERNAL_ID_PREFIX = "__codex_accounts_manager__";
const INTERNAL_REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_REQUEST_TIMEOUT_MS = 30_000;
const RECOVERY_CONTEXT_KEY = "codex-account-manager/recovery";
const CONFIG_PATH = path.join(__dirname, "codex-app-server-shim.json");
const MAX_TERMINAL_TURN_IDS = 2_048;
const MAX_RECENT_USAGE_LIMITED_THREADS = 2_048;
const RECENT_USAGE_LIMITED_THREAD_TTL_MS = 2 * 60 * 1000;
const RUNTIME_PROTOCOL_VERSION = 3;
const SEAMLESS_HTTP_PROVIDER_ID = "codex-accounts-seamless-http";
const SEAMLESS_HTTP_PROVIDER_CONFIG =
  `model_providers.${SEAMLESS_HTTP_PROVIDER_ID}={ name="OpenAI", wire_api="responses", ` +
  "requires_openai_auth=true, supports_websockets=false }";

const runtimeConfig = process.env.CODEX_ACCOUNTS_REAL_CLI ? {} : readRuntimeConfig();
const realCliPath = process.env.CODEX_ACCOUNTS_REAL_CLI || runtimeConfig.realCliPath;
const forceHttpTransport = runtimeConfig.forceHttpTransport !== false;

if (!realCliPath || !path.isAbsolute(realCliPath)) {
  failStartup("The real Codex CLI path is missing from the hot-switch runtime configuration");
}
if (path.resolve(realCliPath) === path.resolve(process.argv[1])) {
  failStartup("The hot-switch shim cannot launch itself as the real Codex CLI");
}

const child = spawn(realCliPath, buildRealCliArgs(process.argv.slice(2)), {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"]
});

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
let externalAuthActive = false;
let activeManagedAccount;
let pendingSwitch;
let internalSequence = 0;
let controlSequence = 0;
let latestControlSocket;
let controlServer;
let socketPath;
const deferredOfficialLines = [];
const pendingInternalRequests = new Map();
const pendingControlRequests = new Map();
const submittedTurnStarts = new Map();
const activeTurns = new Map();
const terminalTurnIds = new Set();
const recentUsageLimitedThreads = new Map();
const initializeRequests = new Set();
const controlSockets = new Set();

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
  rejectPendingRequests(new Error("Codex app-server exited"));
  closeControlServer();
  process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!childExited) {
      child.kill(signal);
    }
  });
}

function handleOfficialLine(line) {
  const message = parseJson(line);
  if (!message) {
    writeChildLine(line);
    return;
  }

  if (rewriteThreadListProviderFilter(message)) {
    line = JSON.stringify(message);
  }

  if (isWorkStartMethod(message.method)) {
    clearRecentUsageLimitedThread(readThreadId(message.params));
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

function handleCodexLine(line) {
  const message = parseJson(line);
  if (!message) {
    writeOfficialLine(line);
    return;
  }

  if (message.method === "account/chatgptAuthTokens/refresh" && externalAuthActive) {
    void handleAuthRefreshRequest(message);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
    const key = requestIdKey(message.id);
    const pendingInternal = pendingInternalRequests.get(key);
    if (pendingInternal) {
      pendingInternalRequests.delete(key);
      clearTimeout(pendingInternal.timer);
      if (message.error) {
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
      submittedTurnStarts.delete(key);
      if (!message.error) {
        const turnId = readTurnId(message.result);
        if (turnId) {
          if (!terminalTurnIds.has(turnId)) {
            rememberActiveTurn(turnId, submittedThreadId);
          }
        } else {
          anonymousActiveTurnCount += 1;
        }
      } else if (isUsageLimitExceededError(message.error)) {
        captureUsageLimitedThread(submittedThreadId);
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

  if (
    message.method === "error" &&
    message.params?.willRetry === false &&
    isUsageLimitExceededError(message.params.error)
  ) {
    captureUsageLimitedThread(readThreadId(message.params));
  }

  if (message.method === "turn/completed") {
    const turnId = readTurnId(message.params);
    const threadId = readThreadId(message.params) || (turnId ? activeTurns.get(turnId) : undefined);
    if (turnId) {
      rememberTerminalTurnId(turnId);
    }
    const request = pendingSwitch;
    if (threadId && isUsageLimitExceededTurn(message.params)) {
      captureUsageLimitedThread(threadId);
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

  if (message.method === "runtime/identity") {
    void readRuntimeIdentity().then(
      (identity) => sendControlResult(socket, message.id, identity),
      (error) => sendControlError(socket, message.id, safeErrorMessage(error))
    );
    return;
  }

  if (message.method === "runtime/switch") {
    queueRuntimeSwitch(socket, message.id, message.params);
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
  if (pendingSwitch || switching || goalPreparationCount > 0 || goalRecoveryCount > 0) {
    sendControlError(socket, id, "Another account switch is already pending");
    return;
  }

  const request = {
    socket,
    id,
    params,
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
    recoveryPromise: undefined
  };
  pendingSwitch = request;
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
  clearSwitchGraceTimer(request);
  switching = true;
  let loginApplied = false;
  let localAccountActivationAttempted = false;
  try {
    await sendInternalRequest("account/login/start", {
      type: "chatgptAuthTokens",
      accessToken: request.params.accessToken,
      chatgptAccountId: request.params.accountId,
      chatgptPlanType: request.params.planType || null
    });
    loginApplied = true;
    externalAuthActive = true;

    const accountResult = await sendInternalRequest("account/read", { refreshToken: false });
    const actualEmail =
      accountResult && accountResult.account && accountResult.account.type === "chatgpt"
        ? accountResult.account.email
        : null;
    if (request.params.expectedEmail && normalizeEmail(actualEmail) !== normalizeEmail(request.params.expectedEmail)) {
      throw new Error("The app-server reported a different account after hot switch");
    }

    localAccountActivationAttempted = true;
    await sendControlRequest("account/activate", { localAccountId: request.params.localAccountId });
    activeManagedAccount = {
      accountId: request.params.accountId,
      localAccountId: request.params.localAccountId,
      expectedEmail: request.params.expectedEmail
    };
    const resumedPausedGoalThreadIds = await resumePausedGoals(request);
    await resumeRecentUsageLimitedGoals(request, resumedPausedGoalThreadIds);
    const continuedThreads = await startRecoveryTurns(request);

    sendControlResult(request.socket, request.id, {
      status: "switched",
      accountId: request.params.accountId,
      email: actualEmail,
      activeTurns: getActiveTurnCount(),
      interruptedTurns: request.interruptedTurnCount,
      continuedThreads
    });
  } catch (error) {
    let message = safeErrorMessage(error);
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
    sendControlError(request.socket, request.id, message);
  } finally {
    switching = false;
    flushDeferredOfficialLines();
  }
}

async function prepareGoalsForSwitch(request) {
  try {
    const threadIds = new Set([...getActiveThreadIds(), ...request.recentUsageLimitedThreadIds]);
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
    sendControlResult(request.socket, request.id, {
      status: "deferred",
      reason,
      activeTurns: getActiveTurnCount()
    });
  } catch (error) {
    sendControlError(
      request.socket,
      request.id,
      `Account switch was deferred and a paused goal could not be resumed: ${safeErrorMessage(error)}`
    );
  }
}

async function startRecoveryTurns(request) {
  let continuedThreads = 0;
  for (const threadId of request.recoveryThreadIds) {
    try {
      if (await isSubagentThread(threadId)) {
        continue;
      }
      const result = await sendInternalRequest("turn/start", {
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
      });
      const turnId = readTurnId(result);
      if (turnId) {
        rememberActiveTurn(turnId, threadId);
      }
      if (request.recentUsageLimitedThreadIds.has(threadId)) {
        recoveredUsageLimitedThreads += 1;
      }
      clearRecentUsageLimitedThread(threadId);
      continuedThreads += 1;
    } catch (error) {
      safeLog(`failed to start a switched thread continuation: ${safeErrorMessage(error)}`);
    }
  }
  return continuedThreads;
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
  await sendInternalRequest("account/login/start", {
    type: "chatgptAuthTokens",
    accessToken: credentials.accessToken,
    chatgptAccountId: credentials.chatgptAccountId,
    chatgptPlanType: credentials.chatgptPlanType
  });
  const accountResult = await sendInternalRequest("account/read", { refreshToken: false });
  const actualEmail =
    accountResult && accountResult.account && accountResult.account.type === "chatgpt"
      ? accountResult.account.email
      : null;
  if (normalizeEmail(actualEmail) !== normalizeEmail(request.params.previousExpectedEmail)) {
    throw new Error("The app-server reported a different account after hot-switch rollback");
  }
  externalAuthActive = true;
  activeManagedAccount = snapshotRollback
    ? undefined
    : {
        accountId: request.params.previousAccountId,
        localAccountId: request.params.previousLocalAccountId,
        expectedEmail: request.params.previousExpectedEmail
      };
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

function sendInternalRequest(method, params) {
  const id = `${INTERNAL_ID_PREFIX}:${++internalSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingInternalRequests.delete(requestIdKey(id));
      reject(new Error(`${method} timed out`));
    }, INTERNAL_REQUEST_TIMEOUT_MS);
    pendingInternalRequests.set(requestIdKey(id), { resolve, reject, timer });
    writeChildMessage({ id, method, params });
  });
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
    recentUsageLimitedThreads: getRecentUsageLimitedThreadIds().size,
    observedUsageLimitFailures,
    recoveredUsageLimitedThreads,
    resumedUsageLimitedGoals,
    shimPid: process.pid,
    appServerPid: child.pid || null
  };
}

async function readRuntimeIdentity() {
  const accountResult = await sendInternalRequest("account/read", { refreshToken: false });
  const account = accountResult && typeof accountResult.account === "object" ? accountResult.account : null;
  return {
    accountType: account && typeof account.type === "string" ? account.type : null,
    email: account && typeof account.email === "string" ? account.email : null,
    planType: account && typeof account.planType === "string" ? account.planType : null,
    externalAuthActive,
    managedAccountId: activeManagedAccount ? activeManagedAccount.accountId : null,
    managedLocalAccountId: activeManagedAccount ? activeManagedAccount.localAccountId : null,
    httpTransportForced: forceHttpTransport
  };
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
    sendControlError(pendingSwitch.socket, pendingSwitch.id, safeErrorMessage(error));
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
    (params.longTurnPolicy === "defer" ||
      params.longTurnPolicy === "interrupt" ||
      params.longTurnPolicy === "interruptAndContinue")
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

function rememberActiveTurn(turnId, threadId) {
  if (typeof threadId === "string" && threadId.length > 0) {
    for (const [knownTurnId, knownThreadId] of activeTurns) {
      if (knownTurnId !== turnId && knownThreadId === threadId) {
        activeTurns.delete(knownTurnId);
      }
    }
  }
  activeTurns.set(turnId, threadId);
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

function captureUsageLimitedThread(threadId) {
  if (typeof threadId !== "string" || threadId.length === 0) {
    return;
  }
  rememberRecentUsageLimitedThread(threadId);
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
  for (const [threadId, recordedAt] of recentUsageLimitedThreads) {
    if (recordedAt >= cutoff && recentUsageLimitedThreads.size <= MAX_RECENT_USAGE_LIMITED_THREADS) {
      break;
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

function isUsageLimitExceededError(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return (
    value.codexErrorInfo === "usageLimitExceeded" ||
    value.errorInfo === "usageLimitExceeded" ||
    isUsageLimitExceededError(value.data) ||
    isUsageLimitExceededError(value.error)
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
  return [
    ...args.slice(0, appServerIndex + 1),
    "-c",
    `model_provider="${SEAMLESS_HTTP_PROVIDER_ID}"`,
    "-c",
    SEAMLESS_HTTP_PROVIDER_CONFIG,
    ...args.slice(appServerIndex + 1)
  ];
}

function readRuntimeConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    failStartup(`Unable to read hot-switch runtime configuration: ${safeErrorMessage(error)}`);
  }
}

function safeLog(message) {
  process.stderr.write(`[codex-accounts-shim] ${message}\n`);
}

function failStartup(message) {
  safeLog(message);
  process.exit(1);
}

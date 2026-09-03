#!/usr/bin/env node

"use strict";

const http = require("node:http");

let buffer = "";
let currentEmail = "a@example.invalid";
let currentAccountId = "account-a";
const activeTurns = [];
const goals = new Map();
const threadSettings = new Map();
const subagentThreadIds = new Set();
let turnSequence = 0;
let goalSequence = 0;
let reorderNextTurnStartResponse = false;
let failNextTurnStartWithUsageLimit = false;
let failNextTurnStartWithCapacity = false;
let loginSettleTimer;
let delayNextModelListResponse = false;

emit({
  method: "test/runtimeArgs",
  params: {
    args: process.argv.slice(2),
    hasLoopbackNoProxyBypass: hasLoopbackNoProxyBypass()
  }
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).replace(/\r$/u, "");
    buffer = buffer.slice(newlineIndex + 1);
    if (line.length > 0) {
      handleLine(line);
    }
    newlineIndex = buffer.indexOf("\n");
  }
});

function handleLine(line) {
  const message = JSON.parse(line);
  emit({
    method: "test/received",
    params: {
      method: message.method,
      id: message.id,
      accountId: message.params && message.params.chatgptAccountId,
      runtimeAccountId: currentAccountId,
      threadId: message.params && message.params.threadId,
      serviceTier: message.params && message.params.serviceTier,
      modelProviders: message.params && message.params.modelProviders,
      goalStatus: message.params && message.params.status,
      turnId: message.params && message.params.turnId,
      inputText:
        message.params &&
        Array.isArray(message.params.input) &&
        message.params.input[0] &&
        message.params.input[0].text,
      recoveryMetadata:
        message.params &&
        message.params.responsesapiClientMetadata &&
        message.params.responsesapiClientMetadata.codex_account_manager_recovery,
      recoveryContext:
        message.params &&
        message.params.additionalContext &&
        message.params.additionalContext["codex-account-manager/recovery"] &&
        message.params.additionalContext["codex-account-manager/recovery"].value
    }
  });

  if (!message.method && message.id === "refresh-1") {
    emit({
      method: "test/refreshResult",
      params: {
        accountId: message.result && message.result.chatgptAccountId,
        hasAccessToken: Boolean(message.result && message.result.accessToken)
      }
    });
    return;
  }

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex/1" });
      break;
    case "model/list":
      replyWithModelList(message.id, delayNextModelListResponse);
      delayNextModelListResponse = false;
      break;
    case "test/delayNextModelList":
      delayNextModelListResponse = true;
      respond(message.id, {});
      break;
    case "initialized":
      break;
    case "turn/start": {
      if (failNextTurnStartWithUsageLimit) {
        failNextTurnStartWithUsageLimit = false;
        emit({
          id: message.id,
          error: {
            code: -32000,
            message: "Usage limit exceeded",
            data: { codexErrorInfo: "usageLimitExceeded" }
          }
        });
        break;
      }
      if (failNextTurnStartWithCapacity) {
        failNextTurnStartWithCapacity = false;
        emit({
          id: message.id,
          error: createCapacityError(message.params && message.params.capacityErrorField)
        });
        break;
      }
      const currentSettings = threadSettings.get(message.params.threadId) || {};
      for (const key of ["cwd", "runtimeWorkspaceRoots", "approvalPolicy", "permissions", "sandboxPolicy"]) {
        if (Object.prototype.hasOwnProperty.call(message.params, key)) {
          currentSettings[key] = message.params[key];
        }
      }
      threadSettings.set(message.params.threadId, currentSettings);
      emit({
        method: "test/effectiveTurnSettings",
        params: {
          id: message.id,
          threadId: message.params.threadId,
          ...currentSettings
        }
      });
      turnSequence += 1;
      const activeTurn = { id: `turn-${turnSequence}`, threadId: message.params.threadId };
      activeTurns.push(activeTurn);
      const turn = { id: activeTurn.id, items: [], itemsView: { type: "all" }, status: "inProgress" };
      if (reorderNextTurnStartResponse) {
        reorderNextTurnStartResponse = false;
        emit({ method: "turn/started", params: { threadId: message.params.threadId, turn } });
        activeTurns.pop();
        emit({
          method: "turn/completed",
          params: { threadId: message.params.threadId, turn: { ...turn, status: "completed" } }
        });
        respond(message.id, { turn });
        break;
      }
      respond(message.id, { turn });
      emit({ method: "turn/started", params: { threadId: message.params.threadId, turn } });
      break;
    }
    case "thread/goal/get":
      respond(message.id, { goal: goals.get(message.params.threadId) || null });
      break;
    case "thread/read": {
      const isSubagent = subagentThreadIds.has(message.params.threadId);
      respond(message.id, {
        thread: {
          id: message.params.threadId,
          parentThreadId: isSubagent ? "parent-thread" : null,
          source: isSubagent ? { subagent: "test" } : "vscode"
        }
      });
      break;
    }
    case "thread/goal/set": {
      const previousGoal = goals.get(message.params.threadId);
      goalSequence += 1;
      const goal = {
        threadId: message.params.threadId,
        objective: message.params.objective || (previousGoal && previousGoal.objective) || "Keep working",
        status: message.params.status || (previousGoal && previousGoal.status) || "active",
        tokenBudget: message.params.tokenBudget ?? (previousGoal && previousGoal.tokenBudget) ?? null,
        tokensUsed: (previousGoal && previousGoal.tokensUsed) || 0,
        timeUsedSeconds: (previousGoal && previousGoal.timeUsedSeconds) || 0,
        createdAt: (previousGoal && previousGoal.createdAt) || 1,
        updatedAt: goalSequence
      };
      goals.set(message.params.threadId, goal);
      respond(message.id, { goal });
      emit({ method: "thread/goal/updated", params: { threadId: message.params.threadId, turnId: null, goal } });
      break;
    }
    case "thread/goal/clear": {
      const cleared = goals.delete(message.params.threadId);
      respond(message.id, { cleared });
      emit({ method: "thread/goal/cleared", params: { threadId: message.params.threadId } });
      break;
    }
    case "test/setGoalUsageLimited": {
      const previousGoal = goals.get(message.params.threadId);
      if (previousGoal) {
        const goal = { ...previousGoal, status: "usageLimited", updatedAt: previousGoal.updatedAt + 1 };
        goals.set(message.params.threadId, goal);
        emit({ method: "thread/goal/updated", params: { threadId: message.params.threadId, turnId: null, goal } });
      }
      respond(message.id, {});
      break;
    }
    case "test/complete": {
      const activeTurn = activeTurns.shift();
      if (activeTurn) {
        const turn = { id: activeTurn.id, items: [], itemsView: { type: "all" }, status: "completed" };
        emit({ method: "turn/completed", params: { threadId: activeTurn.threadId, turn } });
      }
      respond(message.id, {});
      break;
    }
    case "test/failUsageLimit": {
      const activeTurn = activeTurns.shift();
      if (activeTurn) {
        const turn = {
          id: activeTurn.id,
          items: [],
          itemsView: { type: "all" },
          status: "errored",
          error: {
            message: "Usage limit exceeded",
            codexErrorInfo: "usageLimitExceeded"
          }
        };
        emit({ method: "turn/completed", params: { threadId: activeTurn.threadId, turn } });
      }
      respond(message.id, {});
      break;
    }
    case "test/failUsageLimitNotification": {
      const activeTurn = activeTurns.shift();
      if (activeTurn) {
        emit({
          method: "error",
          params: {
            threadId: activeTurn.threadId,
            turnId: activeTurn.id,
            willRetry: false,
            error: {
              message: "Usage limit exceeded",
              codexErrorInfo: "usageLimitExceeded"
            }
          }
        });
        const turn = { id: activeTurn.id, items: [], itemsView: { type: "all" }, status: "failed" };
        emit({ method: "turn/completed", params: { threadId: activeTurn.threadId, turn } });
      }
      respond(message.id, {});
      break;
    }
    case "test/failUsageLimitMessageNotification": {
      const activeTurn = activeTurns.shift();
      if (activeTurn) {
        const error = {
          message: "You've hit your usage limit. Try again later."
        };
        emit({
          method: "error",
          params: {
            threadId: activeTurn.threadId,
            turnId: activeTurn.id,
            willRetry: false,
            error
          }
        });
        const turn = { id: activeTurn.id, items: [], itemsView: { type: "all" }, status: "failed", error };
        emit({ method: "turn/completed", params: { threadId: activeTurn.threadId, turn } });
      }
      respond(message.id, {});
      break;
    }
    case "test/failCapacity": {
      const activeTurn = activeTurns.shift();
      if (activeTurn) {
        const turn = {
          id: activeTurn.id,
          items: [],
          itemsView: { type: "all" },
          status: "errored",
          error: createCapacityError(message.params && message.params.errorField)
        };
        emit({ method: "turn/completed", params: { threadId: activeTurn.threadId, turn } });
      }
      respond(message.id, {});
      break;
    }
    case "test/failCapacityNotification": {
      const activeTurn = activeTurns.shift();
      if (activeTurn) {
        emit({
          method: "error",
          params: {
            threadId: activeTurn.threadId,
            turnId: activeTurn.id,
            willRetry: false,
            error: createCapacityError(message.params && message.params.errorField)
          }
        });
        const turn = { id: activeTurn.id, items: [], itemsView: { type: "all" }, status: "failed" };
        emit({ method: "turn/completed", params: { threadId: activeTurn.threadId, turn } });
      }
      respond(message.id, {});
      break;
    }
    case "test/notifyUsageLimit": {
      const requestedThreadId = message.params && message.params.threadId;
      const activeTurn =
        typeof requestedThreadId === "string"
          ? activeTurns.find((candidate) => candidate.threadId === requestedThreadId)
          : activeTurns[0];
      if (activeTurn) {
        emit({
          method: "error",
          params: {
            threadId: activeTurn.threadId,
            turnId: activeTurn.id,
            willRetry: false,
            error: {
              message: "Usage limit exceeded",
              codexErrorInfo: "usageLimitExceeded"
            }
          }
        });
      }
      respond(message.id, {});
      break;
    }
    case "test/forget-active":
      activeTurns.shift();
      respond(message.id, {});
      break;
    case "test/markSubagent":
      if (typeof message.params.threadId === "string") {
        subagentThreadIds.add(message.params.threadId);
      }
      respond(message.id, {});
      break;
    case "test/replaceActiveTurn": {
      const activeTurn = activeTurns[0];
      if (activeTurn) {
        turnSequence += 1;
        activeTurn.id = `turn-${turnSequence}`;
      }
      respond(message.id, {});
      break;
    }
    case "test/reorderNextTurnStartResponse":
      reorderNextTurnStartResponse = true;
      respond(message.id, {});
      break;
    case "test/failNextTurnStartWithUsageLimit":
      failNextTurnStartWithUsageLimit = true;
      respond(message.id, {});
      break;
    case "test/failNextTurnStartWithCapacity":
      failNextTurnStartWithCapacity = true;
      respond(message.id, {});
      break;
    case "test/probeGateway":
      void probeGateway(message);
      break;
    case "test/probeGatewayResponse":
      void probeGatewayResponse(message);
      break;
    case "turn/interrupt": {
      const turnIndex = activeTurns.findIndex(
        (turn) => turn.id === message.params.turnId && turn.threadId === message.params.threadId
      );
      if (turnIndex < 0) {
        const activeTurn = activeTurns.find((turn) => turn.threadId === message.params.threadId);
        if (activeTurn) {
          emit({
            id: message.id,
            error: {
              code: -32000,
              message: `expected active turn id ${message.params.turnId} but found ${activeTurn.id}`
            }
          });
          break;
        }
        emit({ id: message.id, error: { code: -32000, message: "no active turn to interrupt" } });
        break;
      }
      const [activeTurn] = activeTurns.splice(turnIndex, 1);
      respond(message.id, {});
      const turn = {
        id: activeTurn.id,
        items: [],
        itemsView: { type: "all" },
        status: "interrupted"
      };
      emit({ method: "turn/completed", params: { threadId: activeTurn.threadId, turn } });
      break;
    }
    case "test/requestRefresh":
      emit({
        id: "refresh-1",
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized", previousAccountId: currentAccountId }
      });
      respond(message.id, {});
      break;
    case "account/login/start":
      {
        const nextAccountId = message.params.chatgptAccountId;
        const nextEmail = nextAccountId === "account-b" ? "b@example.invalid" : "a@example.invalid";
        const settleMs = Number(process.env.FAKE_CODEX_LOGIN_SETTLE_MS ?? 0);
        if (loginSettleTimer) {
          clearTimeout(loginSettleTimer);
          loginSettleTimer = undefined;
        }
        const applyLogin = () => {
          currentAccountId = nextAccountId;
          currentEmail = nextEmail;
          emit({
            method: "account/login/completed",
            params: { loginId: null, success: true, error: null }
          });
          emit({
            method: "account/updated",
            params: { authMode: "chatgpt", planType: "plus" }
          });
        };
        if (Number.isFinite(settleMs) && settleMs > 0) {
          loginSettleTimer = setTimeout(applyLogin, settleMs);
        } else {
          applyLogin();
        }
      }
      respond(message.id, { type: "chatgptAuthTokens" });
      break;
    case "account/read":
      if (process.env.FAKE_CODEX_ACCOUNT_READ_REQUIRES_OPENAI_AUTH === "false") {
        respond(message.id, { account: null, requiresOpenaiAuth: false });
      } else {
        respond(message.id, {
          account: { type: "chatgpt", email: currentEmail, planType: "plus" },
          requiresOpenaiAuth: true
        });
      }
      break;
    default:
      respond(message.id, {});
      break;
  }
}

function replyWithModelList(id, delayed) {
  const reply = () => {
    respond(id, {
      data: [
        {
          id: "gpt-5.6-terra",
          model: "gpt-5.6-terra",
          displayName: "GPT-5.6-Terra",
          description: "Fake Codex model.",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Default" }]
        }
      ],
      nextCursor: null
    });
  };
  if (delayed) {
    setTimeout(reply, 250);
  } else {
    reply();
  }
}

function createCapacityError(errorField) {
  const info = errorField === "camel" ? { codexErrorInfo: "server_overloaded" } : { codex_error_info: "server_overloaded" };
  return {
    message: "Selected model is at capacity. Please try a different model.",
    ...info
  };
}

function hasLoopbackNoProxyBypass() {
  const entries = [process.env.NO_PROXY, process.env.no_proxy]
    .filter((value) => typeof value === "string")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase());
  return ["127.0.0.1", "localhost", "::1"].every((host) => entries.includes(host));
}

function probeGateway(message) {
  const providerConfig = process.argv.find((arg) => typeof arg === "string" && arg.includes("base_url="));
  const baseUrl = providerConfig && /base_url="([^"\\]+)"/u.exec(providerConfig)?.[1];
  const envKey = providerConfig && /env_key="([^"\\]+)"/u.exec(providerConfig)?.[1];
  const adapterToken = envKey ? process.env[envKey] : undefined;
  if (!baseUrl || !adapterToken) {
    emit({ method: "test/gatewayProbe", params: { statusCode: 0, hasAdapterToken: false } });
    respond(message.id, {});
    return;
  }
  const target = new URL("models", `${baseUrl.replace(/\/+$/u, "")}/`);
  const client = target.protocol === "https:" ? require("node:https") : http;
  const request = client.request(
    target,
    { method: "GET", headers: { authorization: `Bearer ${adapterToken}` } },
    (response) => {
      response.resume();
      response.on("end", () => {
        emit({
          method: "test/gatewayProbe",
          params: { statusCode: response.statusCode || 0, hasAdapterToken: true }
        });
        respond(message.id, {});
      });
    }
  );
  request.on("error", () => {
    emit({ method: "test/gatewayProbe", params: { statusCode: 0, hasAdapterToken: true } });
    respond(message.id, {});
  });
  request.end();
}

function probeGatewayResponse(message) {
  const providerConfig = process.argv.find((arg) => typeof arg === "string" && arg.includes("base_url="));
  const baseUrl = providerConfig && /base_url="([^"\\]+)"/u.exec(providerConfig)?.[1];
  const envKey = providerConfig && /env_key="([^"\\]+)"/u.exec(providerConfig)?.[1];
  const adapterToken = envKey ? process.env[envKey] : undefined;
  if (!baseUrl || !adapterToken) {
    emit({ method: "test/gatewayResponseProbe", params: { statusCode: 0, hasAdapterToken: false } });
    respond(message.id, {});
    return;
  }
  const target = new URL("responses", `${baseUrl.replace(/\/+$/u, "")}/`);
  const client = target.protocol === "https:" ? require("node:https") : http;
  const body = JSON.stringify({ model: "gateway-test-model", input: "test", stream: true });
  const request = client.request(
    target,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${adapterToken}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      }
    },
    (response) => {
      response.resume();
      response.on("end", () => {
        emit({
          method: "test/gatewayResponseProbe",
          params: { statusCode: response.statusCode || 0, hasAdapterToken: true }
        });
        respond(message.id, {});
      });
    }
  );
  request.on("error", () => {
    emit({ method: "test/gatewayResponseProbe", params: { statusCode: 0, hasAdapterToken: true } });
    respond(message.id, {});
  });
  request.end(body);
}

function respond(id, result) {
  emit({ id, result });
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

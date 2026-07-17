#!/usr/bin/env node

"use strict";

let buffer = "";
let currentEmail = "a@example.invalid";
let currentAccountId = "account-a";
const activeTurns = [];
const goals = new Map();
const threadSettings = new Map();
let turnSequence = 0;
let goalSequence = 0;
let reorderNextTurnStartResponse = false;

emit({ method: "test/runtimeArgs", params: { args: process.argv.slice(2) } });

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
    case "initialized":
      break;
    case "turn/start": {
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
    case "test/complete": {
      const activeTurn = activeTurns.shift();
      if (activeTurn) {
        const turn = { id: activeTurn.id, items: [], itemsView: { type: "all" }, status: "completed" };
        emit({ method: "turn/completed", params: { threadId: activeTurn.threadId, turn } });
      }
      respond(message.id, {});
      break;
    }
    case "test/forget-active":
      activeTurns.shift();
      respond(message.id, {});
      break;
    case "test/reorderNextTurnStartResponse":
      reorderNextTurnStartResponse = true;
      respond(message.id, {});
      break;
    case "turn/interrupt": {
      const turnIndex = activeTurns.findIndex(
        (turn) => turn.id === message.params.turnId && turn.threadId === message.params.threadId
      );
      if (turnIndex < 0) {
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
      currentAccountId = message.params.chatgptAccountId;
      currentEmail = currentAccountId === "account-b" ? "b@example.invalid" : "a@example.invalid";
      respond(message.id, { type: "chatgptAuthTokens" });
      emit({
        method: "account/login/completed",
        params: { loginId: null, success: true, error: null }
      });
      emit({
        method: "account/updated",
        params: { authMode: "chatgpt", planType: "plus" }
      });
      break;
    case "account/read":
      respond(message.id, {
        account: { type: "chatgpt", email: currentEmail, planType: "plus" },
        requiresOpenaiAuth: true
      });
      break;
    default:
      respond(message.id, {});
      break;
  }
}

function respond(id, result) {
  emit({ id, result });
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

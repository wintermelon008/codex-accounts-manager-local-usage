"use strict";

const INTERNAL_ID_PREFIX = "__codex_accounts_manager__";
const MAX_QUEUE_PER_THREAD = 16;
const MAX_TOTAL_QUEUE = 64;

const START_PARAMETER_KEYS = [
  "threadId",
  "thread_id",
  "input",
  "model",
  "serviceTier",
  "service_tier",
  "cwd",
  "approvalPolicy",
  "approval_policy",
  "approvalsReviewer",
  "approvals_reviewer",
  "sandboxPolicy",
  "sandbox_policy",
  "permissions",
  "runtimeWorkspaceRoots",
  "runtime_workspace_roots",
  "additionalContext",
  "additional_context",
  "responsesapiClientMetadata",
  "responses_api_client_metadata",
  "outputSchema",
  "output_schema",
  "effort",
  "reasoningEffort",
  "reasoning_effort",
  "summary",
  "personality",
  "ephemeral"
];

/**
 * Owns only the request-level queue at the Manager/Codex protocol boundary.
 * It never persists prompt content and never knows about the OpenAI extension.
 */
class SessionQueueCoordinator {
  constructor(options = {}) {
    this.isThreadBusy = typeof options.isThreadBusy === "function" ? options.isThreadBusy : () => false;
    this.states = new Map();
    this.pending = new Map();
    this.fallbacks = new Map();
    this.sequence = 0;
  }

  prepareOfficialRequest(message) {
    if (!hasRequestId(message) || !isPlainObject(message.params) || isManagerInternalId(message.id)) {
      return { kind: "forward" };
    }

    if (message.method === "turn/steer") {
      const threadId = readThreadId(message.params);
      if (threadId) {
        this.pending.set(requestIdKey(message.id), {
          method: message.method,
          message,
          threadId,
          fallbackAttempted: false
        });
      }
      return { kind: "forward" };
    }

    if (!isManagedTurnStart(message)) {
      return { kind: "forward" };
    }

    const threadId = readThreadId(message.params);
    const state = this.getState(threadId);
    if (this.isBusy(threadId, state)) {
      if (state.queue.length >= MAX_QUEUE_PER_THREAD || this.totalQueued() >= MAX_TOTAL_QUEUE) {
        return {
          kind: "reject",
          response: {
            id: message.id,
            error: {
              code: -32000,
              message: "Manager session queue is full; the turn was not submitted"
            }
          }
        };
      }
      state.queue.push(message);
      return { kind: "queued", threadId, depth: state.queue.length };
    }

    this.markStartForwarded(message, state);
    return { kind: "forward" };
  }

  /**
   * Reconciles a child response. A no-active-turn steer may be retried once
   * as a fresh start; all other responses retain their original semantics.
   */
  handleChildResponse(message) {
    if (!hasRequestId(message) || message.method) {
      return { message, childMessages: [] };
    }

    const key = requestIdKey(message.id);
    const fallback = this.fallbacks.get(key);
    if (fallback) {
      this.fallbacks.delete(key);
      const state = this.getState(fallback.threadId);
      state.pendingStartId = undefined;
      if (message.error) {
        state.busy = false;
        state.activeTurnId = undefined;
        return {
          message: withId(message, fallback.originalId),
          childMessages: this.drain(fallback.threadId, true)
        };
      }
      state.busy = true;
      state.activeTurnId = readTurnId(message.result);
      if (this.isAlreadyTerminal(state, state.activeTurnId)) {
        state.busy = false;
        state.activeTurnId = undefined;
        return {
          message: withId(message, fallback.originalId),
          childMessages: this.drain(fallback.threadId, true)
        };
      }
      return { message: withId(message, fallback.originalId), childMessages: [] };
    }

    const pending = this.pending.get(key);
    if (!pending) {
      return { message, childMessages: [] };
    }

    if (
      pending.method === "turn/steer" &&
      message.error &&
      !pending.fallbackAttempted &&
      isNoActiveTurnError(message.error) &&
      this.canFallback(pending)
    ) {
      pending.fallbackAttempted = true;
      this.pending.delete(key);
      const internalId = this.nextInternalId();
      const startParams = toStartParams(pending.message.params);
      if (!startParams) {
        return { message, childMessages: [] };
      }
      this.fallbacks.set(requestIdKey(internalId), {
        originalId: pending.message.id,
        threadId: pending.threadId,
        internalId
      });
      const state = this.getState(pending.threadId);
      state.busy = true;
      state.pendingStartId = internalId;
      return {
        suppress: true,
        childMessages: [{ id: internalId, method: "turn/start", params: startParams }]
      };
    }

    this.pending.delete(key);
    if (pending.method === "turn/start") {
      const state = this.getState(pending.threadId);
      if (state.pendingStartId !== undefined && requestIdKey(state.pendingStartId) !== key) {
        return { message, childMessages: [] };
      }
      state.pendingStartId = undefined;
      if (message.error) {
        state.busy = false;
        state.activeTurnId = undefined;
        return { message, childMessages: this.drain(pending.threadId, true) };
      }
      state.busy = true;
      state.activeTurnId = readTurnId(message.result);
      if (this.isAlreadyTerminal(state, state.activeTurnId)) {
        state.busy = false;
        state.activeTurnId = undefined;
        return { message, childMessages: this.drain(pending.threadId, true) };
      }
    }
    return { message, childMessages: [] };
  }

  /** Reconciles turn lifecycle notifications and returns requests to submit. */
  handleNotification(message) {
    if (!message || typeof message.method !== "string") {
      return [];
    }

    const threadId = readThreadId(message.params);
    if (!threadId) {
      return [];
    }

    const state = this.getState(threadId);
    if (message.method === "turn/started") {
      const turnId = readTurnId(message.params);
      if (this.isAlreadyTerminal(state, turnId)) {
        return [];
      }
      state.busy = true;
      state.activeTurnId = turnId || state.activeTurnId;
      return [];
    }

    if (message.method !== "turn/completed") {
      return [];
    }

    const completedTurnId = readTurnId(message.params);
    if (completedTurnId) {
      state.terminalTurnIds.add(completedTurnId);
      while (state.terminalTurnIds.size > 32) {
        const oldestTurnId = state.terminalTurnIds.values().next().value;
        if (oldestTurnId === undefined) {
          break;
        }
        state.terminalTurnIds.delete(oldestTurnId);
      }
    }
    if (state.activeTurnId && completedTurnId && state.activeTurnId !== completedTurnId) {
      return [];
    }
    state.busy = false;
    state.activeTurnId = undefined;
    state.pendingStartId = undefined;
    return this.drain(threadId, true);
  }

  getStatus() {
    let queued = 0;
    let busyThreads = 0;
    for (const state of this.states.values()) {
      queued += state.queue.length;
      if (state.busy || state.pendingStartId) {
        busyThreads += 1;
      }
    }
    return {
      queued,
      busyThreads,
      pendingRequests: this.pending.size,
      fallbackRequests: this.fallbacks.size
    };
  }

  clear() {
    this.states.clear();
    this.pending.clear();
    this.fallbacks.clear();
  }

  getState(threadId) {
    let state = this.states.get(threadId);
    if (!state) {
      state = {
        busy: false,
        activeTurnId: undefined,
        pendingStartId: undefined,
        terminalTurnIds: new Set(),
        queue: []
      };
      this.states.set(threadId, state);
    }
    return state;
  }

  isBusy(threadId, state) {
    return Boolean(state.busy || state.pendingStartId || this.isThreadBusy(threadId));
  }

  canFallback(pending) {
    const state = this.getState(pending.threadId);
    return Boolean(
      toStartParams(pending.message.params) &&
        !state.busy &&
        !state.pendingStartId &&
        state.queue.length === 0 &&
        !this.isThreadBusy(pending.threadId)
    );
  }

  isAlreadyTerminal(state, turnId) {
    return typeof turnId === "string" && state.terminalTurnIds.has(turnId);
  }

  markStartForwarded(message, state) {
    state.busy = true;
    state.pendingStartId = message.id;
    this.pending.set(requestIdKey(message.id), {
      method: message.method,
      message,
      threadId: readThreadId(message.params),
      fallbackAttempted: false
    });
  }

  drain(threadId, force = false) {
    const state = this.getState(threadId);
    if ((!force && this.isBusy(threadId, state)) || state.queue.length === 0) {
      return [];
    }
    return [state.queue.shift()];
  }

  totalQueued() {
    let total = 0;
    for (const state of this.states.values()) {
      total += state.queue.length;
    }
    return total;
  }

  nextInternalId() {
    this.sequence += 1;
    return `${INTERNAL_ID_PREFIX}:session-queue:${this.sequence}`;
  }
}

function isManagedTurnStart(message) {
  return (
    message.method === "turn/start" &&
    message.params.ephemeral !== true &&
    message.params.responsesapiClientMetadata?.codex_account_manager_recovery !== "true" &&
    message.params.responses_api_client_metadata?.codex_account_manager_recovery !== "true"
  );
}

function toStartParams(params) {
  if (!isPlainObject(params) || !Array.isArray(params.input) || params.input.length === 0) {
    return undefined;
  }
  const result = {};
  for (const key of START_PARAMETER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      result[key] = params[key];
    }
  }
  const threadId = readThreadId(params);
  if (!threadId) {
    return undefined;
  }
  result.threadId = threadId;
  return result;
}

function isNoActiveTurnError(error) {
  const text = errorText(error).toLowerCase();
  return (
    text.includes("no active turn") ||
    text.includes("turn is not active") ||
    text.includes("active turn not found") ||
    text.includes("active turn does not exist")
  );
}

function errorText(error) {
  if (!isPlainObject(error)) {
    return String(error || "");
  }
  const parts = [error.message, error.data?.message, error.data?.error?.message];
  return parts.filter((part) => typeof part === "string").join(" ");
}

function readThreadId(value) {
  return typeof value?.threadId === "string" && value.threadId.length > 0
    ? value.threadId
    : typeof value?.thread_id === "string" && value.thread_id.length > 0
      ? value.thread_id
      : undefined;
}

function readTurnId(value) {
  if (!isPlainObject(value)) {
    return undefined;
  }
  if (typeof value.turnId === "string" && value.turnId.length > 0) {
    return value.turnId;
  }
  return isPlainObject(value.turn) && typeof value.turn.id === "string" ? value.turn.id : undefined;
}

function hasRequestId(message) {
  return isPlainObject(message) && Object.prototype.hasOwnProperty.call(message, "id");
}

function isManagerInternalId(id) {
  return typeof id === "string" && id.startsWith(`${INTERNAL_ID_PREFIX}:`);
}

function requestIdKey(id) {
  return `${typeof id}:${String(id)}`;
}

function withId(message, id) {
  return { ...message, id };
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

module.exports = {
  SessionQueueCoordinator,
  isNoActiveTurnError,
  toStartParams
};
